"""Server-authoritative ride lifecycle operations."""
from __future__ import annotations

import math
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends
from firebase_admin import firestore as fb_firestore
from pydantic import BaseModel, ConfigDict, Field

from ..core.auth import current_user
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

router = APIRouter(prefix="/rides", tags=["rides"])

ACTIVE_PASSENGER_STATUSES = {"pending", "accepted", "arrived", "started", "en_route"}
DISPATCH_BATCH_SIZE = 10
DISPATCH_TIMEOUT_MS = 45000
DRIVER_LOCATION_VISIBLE_SECONDS = 15 * 60


class RideCreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pickupName: str = Field(min_length=1, max_length=200)
    dropName: str = Field(min_length=1, max_length=200)
    pickupLat: float
    pickupLng: float
    dropLat: float
    dropLng: float
    vehicleType: str = Field(min_length=1, max_length=20)
    dropFullAddress: str = Field(default="", max_length=500)
    dropSource: str = Field(default="", max_length=40)
    dropProvider: str = Field(default="", max_length=40)
    dropPlaceId: str = Field(default="", max_length=200)
    dropEloc: str = Field(default="", max_length=100)
    dropTypeHint: str = Field(default="", max_length=100)


class DriverTransitionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str = Field(min_length=1, max_length=30)
    pin: str = Field(default="", max_length=4)


class DriverAvailabilityBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = Field(min_length=1, max_length=20)
    lat: Optional[float] = None
    lng: Optional[float] = None


class DriverLocationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float
    lng: float
    rideId: Optional[str] = Field(default=None, max_length=160)
    driverHeading: Optional[float] = None
    driverSpeed: Optional[float] = None
    driverAccuracy: Optional[float] = None


class DriverPushTokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=20, max_length=4096)
    userAgent: str = Field(default="", max_length=500)
    permission: str = Field(default="granted", max_length=30)


RIDE_SERVICES = {
    "bike": {"name": "Bike / Scooty", "capacity": 1, "base": 15, "per_km": 7, "min_fare": 15},
    "auto": {"name": "Auto", "capacity": 3, "base": 25, "per_km": 12.5, "min_fare": 25},
}

# Keep in sync with js/fare-policy.js: distance beyond LONG_TRIP_THRESHOLD_KM is
# billed at a reduced rate, and anything beyond MAX_SERVICEABLE_DISTANCE_KM is
# outside the current service area.
MAX_SERVICEABLE_DISTANCE_KM = 120
LONG_TRIP_THRESHOLD_KM = 20
LONG_TRIP_RATE_MULTIPLIER = 0.85
FULL_FARE_PROGRESS_RATIO = 0.9
ZERO_TRAVEL_THRESHOLD_KM = 0.01
FREE_DROPOFF_EXTRA_KM = 0.1


def _calculate_fare(service: dict[str, Any], distance_km: float) -> int:
    """Mirrors calculateServiceFare() in js/fare-policy.js."""
    billable_km = min(distance_km, LONG_TRIP_THRESHOLD_KM)
    long_trip_km = max(0.0, distance_km - LONG_TRIP_THRESHOLD_KM)
    fare = (
        service["base"]
        + (billable_km * service["per_km"])
        + (long_trip_km * service["per_km"] * LONG_TRIP_RATE_MULTIPLIER)
    )
    return max(round(fare), service["min_fare"])


def _ride_service(ride: dict[str, Any]) -> dict[str, Any]:
    service = RIDE_SERVICES.get(str(ride.get("vehicle_type") or "").lower())
    if service:
        return service
    return {
        "name": ride.get("service_name") or "Ride",
        "capacity": 1,
        "base": float(ride.get("fare_base") or 0),
        "per_km": float(ride.get("fare_per_km") or 0),
        "min_fare": float(ride.get("fare_base") or 0),
    }


def _location_from_ride(ride: dict[str, Any], key: str) -> Optional[dict[str, float]]:
    value = ride.get(key)
    if not isinstance(value, dict):
        return None
    lat, lng = value.get("lat"), value.get("lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        return {"lat": float(lat), "lng": float(lng)}
    return None


def _finite_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _format_rupees(value: float) -> str:
    return f"Rs {round(value):g}"


def _driver_fare_adjustment(ride: dict[str, Any], action: str) -> dict[str, Any]:
    original_fare = _finite_float(ride.get("fare"))
    planned_km = max(0.0, _finite_float(ride.get("distance_km")))
    service = _ride_service(ride)
    status = str(ride.get("status") or "")
    pickup = {"lat": _finite_float(ride.get("pickup_lat")), "lng": _finite_float(ride.get("pickup_lng"))}
    drop = {"lat": _finite_float(ride.get("drop_lat")), "lng": _finite_float(ride.get("drop_lng"))}
    current = _location_from_ride(ride, "driverLocation")

    onboard = status in {"started", "en_route"} or bool(ride.get("pinVerifiedAt"))
    distance_to_drop_km = planned_km
    extra_dropoff_km = 0.0
    progress_ratio = 0.0
    travelled_km = 0.0
    charged_distance_km = planned_km
    reason = "full_trip"
    note = f"Final fare is {_format_rupees(original_fare)}."
    final_fare = original_fare

    if current and planned_km > 0:
        distance_to_drop_km = _haversine_km(current["lat"], current["lng"], drop["lat"], drop["lng"])
        pickup_to_current_km = _haversine_km(pickup["lat"], pickup["lng"], current["lat"], current["lng"])
        progress_ratio = max(0.0, min(1.0, pickup_to_current_km / planned_km))
        travelled_km = max(0.0, min(pickup_to_current_km, planned_km))
        if pickup_to_current_km > planned_km and distance_to_drop_km > FREE_DROPOFF_EXTRA_KM:
            extra_dropoff_km = distance_to_drop_km

    if not onboard:
        final_fare = 0
        charged_distance_km = 0
        reason = "not_picked_up"
        note = "Passenger trip did not start, so no fare is charged."
    elif not current:
        reason = "gps_unavailable"
        note = f"GPS was unavailable at trip end. Fare stays {_format_rupees(original_fare)}."
    elif travelled_km <= ZERO_TRAVEL_THRESHOLD_KM:
        final_fare = 0
        charged_distance_km = 0
        reason = "zero_passenger_travel"
        note = "No travel after pickup was detected, so the fare is Rs 0."
    elif progress_ratio < FULL_FARE_PROGRESS_RATIO:
        charged_distance_km = travelled_km
        final_fare = _calculate_fare(service, charged_distance_km)
        reason = "partial_trip"
        note = (
            f"Only {round(progress_ratio * 100)}% of the trip was completed. "
            f"Reduced fare: {_format_rupees(final_fare)}."
        )
    elif action == "complete" and extra_dropoff_km > FREE_DROPOFF_EXTRA_KM:
        extra_billable_km = extra_dropoff_km - FREE_DROPOFF_EXTRA_KM
        charged_distance_km = planned_km + extra_billable_km
        final_fare = _calculate_fare(service, charged_distance_km)
        reason = "extra_after_drop"
        note = (
            f"Drop was {round(extra_dropoff_km * 1000)}m past the destination. "
            f"Final fare: {_format_rupees(final_fare)}."
        )
    else:
        charged_distance_km = planned_km
        final_fare = original_fare
        reason = "full_trip_threshold"
        note = f"At least 90% of the trip was completed. Fare stays {_format_rupees(final_fare)}."

    return {
        "original_fare": round(original_fare),
        "final_fare": round(final_fare),
        "planned_distance_km": round(planned_km, 3),
        "travelled_after_pickup_km": round(travelled_km, 3),
        "charged_distance_km": round(charged_distance_km, 3),
        "distance_to_drop_km": round(distance_to_drop_km, 3),
        "extra_dropoff_distance_km": round(extra_dropoff_km, 3),
        "progress_ratio": round(progress_ratio, 4),
        "reason": reason,
        "message": note,
    }


def _coordinate(value: float, minimum: float, maximum: float) -> float:
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise ApiError("Invalid ride coordinates.", 400)
    return round(value, 7)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    value = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def _timestamp_seconds(value: Any) -> Optional[float]:
    if hasattr(value, "timestamp"):
        return value.timestamp()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _driver_type(driver: dict[str, Any]) -> str:
    text = " ".join(
        str(driver.get(key) or "")
        for key in ("vehicle_type", "vehicleType", "vehicle_model", "vehicleModel", "vehicleName")
    ).lower()
    if "auto" in text or "rickshaw" in text or "tuk" in text:
        return "auto"
    if "bike" in text or "scooter" in text or "activa" in text or "motorcycle" in text:
        return "bike"
    return ""


def _require_role(profile: dict[str, Any], expected_role: str, message: str) -> None:
    if profile.get("role") != expected_role:
        raise ApiError(message, 403)


def _require_approved_driver(profile: dict[str, Any], message: str) -> None:
    if profile.get("role") != "driver" or profile.get("verificationStatus") != "approved":
        raise ApiError(message, 403)


def _coarse_location(location: Optional[dict[str, float]]) -> Optional[dict[str, float]]:
    if not location:
        return None
    return {
        "lat": round(float(location["lat"]), 2),
        "lng": round(float(location["lng"]), 2),
    }


def _available_drivers(db, pickup_lat: float, pickup_lng: float, vehicle_type: str) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc).timestamp()
    candidates: list[dict[str, Any]] = []
    for snapshot in db.collection("driverPresence").where("driverAvailability", "==", "searching").stream():
        driver = snapshot.to_dict() or {}
        location = driver.get("driverLocation") or {}
        lat, lng = location.get("lat"), location.get("lng")
        last_seen = _timestamp_seconds(driver.get("lastLocationAt") or driver.get("lastSeenAt") or driver.get("updatedAt"))
        if (
            driver.get("verificationStatus") != "approved"
            or (last_seen is not None and now - last_seen > DRIVER_LOCATION_VISIBLE_SECONDS)
            or (last_seen is None and not driver.get("isConnected"))
            or not isinstance(lat, (int, float))
            or not isinstance(lng, (int, float))
            or _driver_type(driver) != vehicle_type
        ):
            continue
        candidates.append({
            "uid": str(driver.get("uid") or snapshot.id),
            "distance": _haversine_km(pickup_lat, pickup_lng, float(lat), float(lng)),
        })
    candidates.sort(key=lambda item: item["distance"])
    return candidates


async def _server_route(pickup_lat: float, pickup_lng: float, drop_lat: float, drop_lng: float) -> tuple[float, int]:
    key = get_env("GOOGLE_MAPS_SERVER_KEY")
    if not key:
        raise ApiError("Missing GOOGLE_MAPS_SERVER_KEY.", 500)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            response = await client.post(
                "https://routes.googleapis.com/directions/v2:computeRoutes",
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": key,
                    "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
                },
                json={
                    "origin": {"location": {"latLng": {"latitude": pickup_lat, "longitude": pickup_lng}}},
                    "destination": {"location": {"latLng": {"latitude": drop_lat, "longitude": drop_lng}}},
                    "travelMode": "DRIVE",
                    "routingPreference": "TRAFFIC_UNAWARE",
                    "computeAlternativeRoutes": False,
                    "units": "METRIC",
                },
            )
        response.raise_for_status()
        data = response.json()
        route = (data.get("routes") or [None])[0]
        if not route or not route.get("distanceMeters"):
            raise ApiError("Google route not found.", 404)
        duration = str(route.get("duration") or "0").rstrip("s")
        return float(route["distanceMeters"]) / 1000, max(1, round(float(duration) / 60))
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not calculate the ride route.", 503)


def _history_update(ride_id: str, ride: dict[str, Any]) -> dict[str, Any]:
    """Create the minimum compatible history record for a verified ride."""
    return {
        "ride_id": ride_id,
        "passenger_id": ride.get("passenger_id"),
        "driver_id": ride.get("driver_id"),
        "pickup_location": ride.get("pickup_display_address") or ride.get("pickup_name") or "Pickup not recorded",
        "pickup_display_address": ride.get("pickup_display_address") or "",
        "pickup_formatted_address": ride.get("pickup_formatted_address") or "",
        "pickup_landmark": ride.get("pickup_landmark") or "",
        "drop_location": ride.get("drop_display_address") or ride.get("drop_name") or "Drop not recorded",
        "drop_display_address": ride.get("drop_display_address") or "",
        "drop_formatted_address": ride.get("drop_formatted_address") or ride.get("drop_full_address") or "",
        "drop_full_address": ride.get("drop_full_address") or "",
        "drop_landmark": ride.get("drop_landmark") or "",
        "verifiedAt": ride.get("pinVerifiedAt") or ride.get("verifiedAt") or fb_firestore.SERVER_TIMESTAMP,
        "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
        "finalStatusAt": fb_firestore.SERVER_TIMESTAMP,
        "distance_km": float(ride.get("distance_km") or 0),
        "duration_minutes": float(ride.get("duration_minutes") or 0),
        "fare_amount": float(ride.get("fare") or 0),
        "quoted_fare_amount": float(ride.get("quoted_fare") or ride.get("fare_original") or ride.get("fare") or 0),
        "fare_adjustment": ride.get("fare_adjustment") or {},
        "trip_status": "cancelled_by_passenger",
        "final_status": "cancelled",
        "cancelled_by": "passenger",
        "payment_status": ride.get("payment_status") or "pending",
        "driver_name": ride.get("driver_name") or "Driver",
        "passenger_name": ride.get("passenger_name") or "Passenger",
        "vehicle_model": ride.get("vehicle_model") or "Vehicle",
        "vehicle_number": ride.get("vehicle_number") or "Number not recorded",
        "vehicle_type": ride.get("vehicle_type") or "",
        "service_name": ride.get("service_name") or "",
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        "source": "fastapi_passenger_cancellation",
    }


def _driver_history_update(ride_id: str, ride: dict[str, Any], status: str) -> dict[str, Any]:
    """Build a server-owned history record for driver lifecycle transitions."""
    cancelled = status == "cancelled_by_driver"
    completed = status == "completed"
    return {
        "ride_id": ride_id,
        "passenger_id": ride.get("passenger_id"),
        "driver_id": ride.get("driver_id"),
        "pickup_location": ride.get("pickup_display_address") or ride.get("pickup_name") or "Pickup not recorded",
        "drop_location": ride.get("drop_display_address") or ride.get("drop_name") or "Drop not recorded",
        "pickup_display_address": ride.get("pickup_display_address") or "",
        "drop_display_address": ride.get("drop_display_address") or "",
        "drop_full_address": ride.get("drop_full_address") or "",
        "verifiedAt": ride.get("pinVerifiedAt") or fb_firestore.SERVER_TIMESTAMP,
        "completedAt": fb_firestore.SERVER_TIMESTAMP if completed else None,
        "cancelledAt": fb_firestore.SERVER_TIMESTAMP if cancelled else None,
        "finalStatusAt": fb_firestore.SERVER_TIMESTAMP,
        "distance_km": float(ride.get("distance_km") or 0),
        "duration_minutes": float(ride.get("duration_minutes") or 0),
        "fare_amount": float(ride.get("fare") or 0),
        "quoted_fare_amount": float(ride.get("quoted_fare") or ride.get("fare_original") or ride.get("fare") or 0),
        "fare_adjustment": ride.get("fare_adjustment") or {},
        "trip_status": status,
        "final_status": "completed" if completed else "cancelled" if cancelled else "verified",
        "cancelled_by": "driver" if cancelled else "",
        "payment_status": ride.get("payment_status") or "pending",
        "driver_name": ride.get("driver_name") or "Driver",
        "passenger_name": ride.get("passenger_name") or "Passenger",
        "vehicle_model": ride.get("vehicle_model") or "Vehicle",
        "vehicle_number": ride.get("vehicle_number") or "Number not recorded",
        "vehicle_type": ride.get("vehicle_type") or "",
        "service_name": ride.get("service_name") or "",
        "source": "fastapi_driver_lifecycle",
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }


@router.post("")
async def create_passenger_ride(
    body: RideCreateBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Create a ride using server-calculated route, fare, PIN, and dispatch."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    service = RIDE_SERVICES.get(body.vehicleType.strip().lower())
    if not service:
        raise ApiError("Choose a supported ride service.", 400)
    pickup_lat = _coordinate(body.pickupLat, -90, 90)
    pickup_lng = _coordinate(body.pickupLng, -180, 180)
    drop_lat = _coordinate(body.dropLat, -90, 90)
    drop_lng = _coordinate(body.dropLng, -180, 180)
    if _haversine_km(pickup_lat, pickup_lng, drop_lat, drop_lng) < 0.01:
        raise ApiError("Pickup and destination must be different.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile_snapshot = db.collection("users").document(uid).get()
        profile = profile_snapshot.to_dict() or {}
        _require_role(profile, "passenger", "Only passengers can create ride requests.")
        distance_km, duration_minutes = await _server_route(pickup_lat, pickup_lng, drop_lat, drop_lng)
        if not math.isfinite(distance_km) or distance_km < 0 or distance_km > MAX_SERVICEABLE_DISTANCE_KM:
            raise ApiError("This destination is outside LiphtUp's current service area.", 400)
        fare = _calculate_fare(service, distance_km)
        drivers = _available_drivers(db, pickup_lat, pickup_lng, body.vehicleType.strip().lower())
        first_batch = drivers[:DISPATCH_BATCH_SIZE]
        driver_ids = [driver["uid"] for driver in first_batch]
        ride_ref = db.collection("rides").document()
        transaction = db.transaction()

        @fb_firestore.transactional
        def create_transaction(tx):
            active_query = (
                db.collection("rides")
                .where("passenger_id", "==", uid)
                .where("status", "in", list(ACTIVE_PASSENGER_STATUSES))
                .limit(1)
            )
            if list(active_query.stream(transaction=tx)):
                raise ApiError("You already have an active ride request or an ongoing trip.", 409)
            tx.set(ride_ref, ride_data)

        ride_data = {
            "passenger_id": uid,
            "passenger_name": str(profile.get("name") or user.get("name") or "Passenger")[:80],
            "passenger_phone": str(profile.get("phone") or user.get("phone_number") or "")[:40],
            "pickup_name": body.pickupName.strip(),
            "drop_name": body.dropName.strip(),
            "drop_full_address": body.dropFullAddress.strip(),
            "pickup_lat": pickup_lat,
            "pickup_lng": pickup_lng,
            "drop_lat": drop_lat,
            "drop_lng": drop_lng,
            "distance_km": round(distance_km, 2),
            "duration_minutes": duration_minutes,
            "fare": fare,
            "quoted_fare": fare,
            "fare_original": fare,
            "fare_base": service["base"],
            "fare_per_km": service["per_km"],
            "fare_currency": "INR",
            "vehicle_type": body.vehicleType.strip().lower(),
            "service_name": service["name"],
            "passenger_capacity": service["capacity"],
            "status": "pending",
            "driver_id": None,
            "driver_name": None,
            "driver_phone": None,
            "vehicle_model": None,
            "vehicle_number": None,
            "driverAvailabilitySnapshot": None,
            "payment_methods": ["cash", "upi"],
            "payment_status": "pending",
            "verification_pin": f"{secrets.randbelow(10000):04d}",
            "eligible_driver_ids": driver_ids,
            "notified_driver_ids": driver_ids,
            "rejected_driver_ids": [],
            "dispatch_batch_size": DISPATCH_BATCH_SIZE,
            "dispatch_timeout_ms": DISPATCH_TIMEOUT_MS,
            "dispatch_total_candidates": len(drivers),
            "dispatch_round": 1 if driver_ids else 0,
            "search_status": "searching_nearby_drivers" if driver_ids else "no_available_drivers",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        }
        create_transaction(transaction)
        return {
            "ok": True,
            "rideId": ride_ref.id,
            "verificationPin": ride_data["verification_pin"],
            "notifiedDriverIds": driver_ids,
            "ride": {key: value for key, value in ride_data.items() if key != "createdAt"},
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not create this ride request.", 503)


@router.post("/{ride_id}/transition")
def transition_driver_ride(
    ride_id: str,
    body: DriverTransitionBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Apply an authorized driver state transition in one Firestore transaction."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    action = body.action.strip().lower()
    allowed = {
        "arrive": ({"accepted"}, "arrived"),
        "start": ({"arrived"}, "started"),
        "verify_pin": ({"accepted", "arrived"}, "en_route"),
        "complete": ({"started", "en_route"}, "completed"),
        "cancel": ({"accepted", "arrived", "started", "en_route"}, "cancelled_by_driver"),
        "mark_paid": ({"completed"}, "completed"),
    }
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)
    if action not in allowed:
        raise ApiError("Unsupported ride transition.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can update rides.")
        ride_ref = db.collection("rides").document(clean_ride_id)
        history_ref = db.collection("tripHistory").document(clean_ride_id)
        user_ref = db.collection("users").document(uid)
        transaction = db.transaction()
        result: dict[str, Any] = {}

        @fb_firestore.transactional
        def transition_transaction(tx):
            snapshot = ride_ref.get(transaction=tx)
            if not snapshot.exists:
                raise ApiError("Ride not found.", 404)
            ride = snapshot.to_dict() or {}
            if ride.get("driver_id") != uid:
                raise ApiError("Only the assigned driver can update this ride.", 403)
            current_status = ride.get("status")
            valid_statuses, next_status = allowed[action]
            if current_status not in valid_statuses:
                raise ApiError("This ride cannot be updated from its current state.", 409)
            if action == "verify_pin" and str(ride.get("verification_pin") or "") != body.pin.strip():
                raise ApiError("Incorrect verification PIN. Please verify with the passenger.", 400)

            updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
            if action == "verify_pin":
                updates.update({"status": next_status, "pinVerifiedAt": fb_firestore.SERVER_TIMESTAMP, "startedAt": fb_firestore.SERVER_TIMESTAMP})
            elif action == "complete":
                fare_adjustment = _driver_fare_adjustment(ride, action)
                updates.update({
                    "status": next_status,
                    "completedAt": fb_firestore.SERVER_TIMESTAMP,
                    "fare": fare_adjustment["final_fare"],
                    "fare_adjustment": fare_adjustment,
                    "fareFinalizedAt": fb_firestore.SERVER_TIMESTAMP,
                })
            elif action == "cancel":
                fare_adjustment = _driver_fare_adjustment(ride, action)
                updates.update({
                    "status": next_status,
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "fare": fare_adjustment["final_fare"],
                    "fare_adjustment": fare_adjustment,
                    "fareFinalizedAt": fb_firestore.SERVER_TIMESTAMP,
                })
            elif action == "mark_paid":
                updates.update({"payment_status": "paid", "payment_confirmed_by": uid, "paymentConfirmedAt": fb_firestore.SERVER_TIMESTAMP})
            tx.update(ride_ref, updates)

            result.update(ride)
            result["status"] = next_status
            if action in {"complete", "cancel"}:
                result["fare"] = fare_adjustment["final_fare"]
                result["fare_adjustment"] = fare_adjustment
            if action == "mark_paid":
                result["payment_status"] = "paid"
            if action in {"complete", "cancel", "mark_paid"}:
                tx.set(history_ref, _driver_history_update(clean_ride_id, {**ride, **result}, next_status), merge=True)
            if action == "complete":
                tx.update(user_ref, {"lifetime_earnings": fb_firestore.Increment(float(ride.get("fare") or 0)), "total_completed_trips": fb_firestore.Increment(1)})

        transition_transaction(transaction)
        if action in {"complete", "cancel"}:
            availability_update = {"driverAvailability": "searching", "updatedAt": fb_firestore.SERVER_TIMESTAMP}
            db.collection("driverPresence").document(uid).set(availability_update, merge=True)
            db.collection("driverMapPresence").document(uid).set(availability_update, merge=True)
        return {"ok": True, "rideId": clean_ride_id, "status": result.get("status"), "ride": result}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not update this ride.", 503)


@router.post("/{ride_id}/dispatch")
def expand_passenger_dispatch(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Expand a passenger's pending driver search without client Firestore writes."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_role(profile, "passenger", "Only passengers can expand this search.")
        ride_ref = db.collection("rides").document(clean_ride_id)
        snapshot = ride_ref.get()
        if not snapshot.exists:
            raise ApiError("Ride not found.", 404)
        ride = snapshot.to_dict() or {}
        if ride.get("passenger_id") != uid:
            raise ApiError("Only the passenger can expand this search.", 403)
        if ride.get("status") != "pending" or ride.get("driver_id"):
            raise ApiError("Only pending unassigned rides can expand their search.", 409)

        excluded = set(ride.get("notified_driver_ids") or []) | set(ride.get("rejected_driver_ids") or [])
        all_candidates = _available_drivers(
            db,
            float(ride.get("pickup_lat")),
            float(ride.get("pickup_lng")),
            str(ride.get("vehicle_type") or ""),
        )
        next_batch = [item["uid"] for item in all_candidates if item["uid"] not in excluded][: int(ride.get("dispatch_batch_size") or DISPATCH_BATCH_SIZE)]
        notified = list(dict.fromkeys([*(ride.get("notified_driver_ids") or []), *next_batch]))
        eligible = list(dict.fromkeys([*(ride.get("eligible_driver_ids") or []), *next_batch]))
        updates = {
            "eligible_driver_ids": eligible,
            "notified_driver_ids": notified,
            "dispatch_round": int(ride.get("dispatch_round") or 0) + (1 if next_batch else 0),
            "last_dispatch_at": fb_firestore.SERVER_TIMESTAMP,
            "search_status": "searching_nearby_drivers" if next_batch else "no_more_available_drivers",
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        ride_ref.update(updates)
        return {"ok": True, "rideId": clean_ride_id, "driverIds": next_batch, "searchStatus": updates["search_status"]}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not expand the driver search.", 503)


@router.post("/driver-availability")
def update_driver_availability(
    body: DriverAvailabilityBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Update driver availability and presence with server-owned identity fields."""
    uid = str(user.get("uid") or "").strip()
    status = body.status.strip().lower()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if status not in {"offline", "searching", "busy"}:
        raise ApiError("Invalid driver availability status.", 400)
    if (body.lat is None) != (body.lng is None):
        raise ApiError("Both driver coordinates are required together.", 400)
    if body.lat is not None:
        lat = _coordinate(body.lat, -90, 90)
        lng = _coordinate(body.lng, -180, 180)
    else:
        lat = lng = None

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can update driver availability.")
        online = status != "offline"
        user_update: dict[str, Any] = {
            "driverAvailability": status,
            "desiredAvailability": "online" if online else "offline",
            "isConnected": online,
            "notificationEligibleUntil": datetime.now(timezone.utc) + timedelta(minutes=30) if online else datetime.fromtimestamp(0, timezone.utc),
            "driverAvailabilityUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
            "lastSeenAt": fb_firestore.SERVER_TIMESTAMP,
        }
        presence_update: dict[str, Any] = {
            "uid": uid,
            "name": str(profile.get("name") or "Driver")[:80],
            "phone": str(profile.get("phone") or "")[:40],
            "driverAvailability": status,
            "desiredAvailability": "online" if online else "offline",
            "verificationStatus": profile.get("verificationStatus") or "pending_review",
            "vehicle_model": profile.get("vehicle_model") or profile.get("vehicleModel") or "",
            "vehicle_number": profile.get("vehicle_number") or profile.get("vehicleNumber") or "",
            "vehicle_type": _driver_type(profile),
            "isConnected": online,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            "lastSeenAt": fb_firestore.SERVER_TIMESTAMP,
        }
        map_presence_update = {
            key: presence_update[key]
            for key in (
                "uid", "name", "driverAvailability", "desiredAvailability",
                "verificationStatus", "vehicle_model", "vehicle_type", "isConnected",
                "updatedAt", "lastSeenAt",
            )
        }
        if lat is not None:
            user_update["driverLocation"] = {"lat": lat, "lng": lng}
            presence_update["driverLocation"] = {"lat": lat, "lng": lng}
            map_presence_update["driverLocation"] = _coarse_location({"lat": lat, "lng": lng})
        db.collection("users").document(uid).set(user_update, merge=True)
        db.collection("driverPresence").document(uid).set(presence_update, merge=True)
        db.collection("driverMapPresence").document(uid).set(map_presence_update, merge=True)
        return {"ok": True, "status": status}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not update driver availability.", 503)


@router.post("/driver-location")
def update_driver_location(
    body: DriverLocationBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Write authenticated driver telemetry and, when assigned, ride location."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    lat = _coordinate(body.lat, -90, 90)
    lng = _coordinate(body.lng, -180, 180)
    if body.driverAccuracy is not None and (not math.isfinite(body.driverAccuracy) or body.driverAccuracy < 0):
        raise ApiError("Invalid GPS accuracy.", 400)
    if body.driverSpeed is not None and (not math.isfinite(body.driverSpeed) or body.driverSpeed < 0):
        raise ApiError("Invalid GPS speed.", 400)
    if body.driverHeading is not None and not math.isfinite(body.driverHeading):
        raise ApiError("Invalid GPS heading.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile_ref = db.collection("users").document(uid)
        profile = profile_ref.get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can update GPS location.")
        ride_id = str(body.rideId or "").strip()[:160]
        availability = str(profile.get("driverAvailability") or "searching")
        if ride_id:
            ride_ref = db.collection("rides").document(ride_id)
            ride = ride_ref.get().to_dict()
            if not ride:
                raise ApiError("Ride not found.", 404)
            if ride.get("driver_id") != uid:
                raise ApiError("Only the assigned driver can update this ride location.", 403)
            if ride.get("status") not in ACTIVE_PASSENGER_STATUSES:
                raise ApiError("This ride is no longer active.", 409)
            availability = "busy"

        location = {"lat": lat, "lng": lng}
        telemetry = {key: value for key, value in {
            "driverHeading": body.driverHeading,
            "driverSpeed": body.driverSpeed,
            "driverAccuracy": body.driverAccuracy,
        }.items() if value is not None}
        now = datetime.now(timezone.utc)
        presence_update = {
            "driverLocation": location,
            **telemetry,
            "driverAvailability": availability,
            "desiredAvailability": "online",
            "isConnected": True,
            "lastSeenAt": now,
            "lastAppSeenAt": now,
            "lastLocationAt": now,
            "updatedAt": now,
        }
        profile_ref.set({"driverLocation": location, **telemetry, "lastSeenAt": now, "lastLocationAt": now}, merge=True)
        db.collection("driverPresence").document(uid).set(presence_update, merge=True)
        db.collection("driverMapPresence").document(uid).set({
            "uid": uid,
            "name": str(profile.get("name") or "Driver")[:80],
            "driverAvailability": availability,
            "desiredAvailability": "online",
            "verificationStatus": profile.get("verificationStatus"),
            "vehicle_model": profile.get("vehicle_model") or profile.get("vehicleModel") or "",
            "vehicle_type": _driver_type(profile),
            "driverLocation": _coarse_location(location),
            "isConnected": True,
            "lastSeenAt": now,
            "lastLocationAt": now,
            "updatedAt": now,
        }, merge=True)
        if ride_id:
            db.collection("rides").document(ride_id).set({"driverLocation": location, **telemetry, "driverLocationUpdatedAt": now, "updatedAt": now}, merge=True)
        return {"ok": True, "rideId": ride_id or None, "status": availability}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not update driver GPS location.", 503)


@router.post("/driver-push-token")
def save_driver_push_token(
    body: DriverPushTokenBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Store a push token only for the authenticated driver's own account."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if body.permission != "granted":
        raise ApiError("Push permission is not granted.", 400)
    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can register driver push tokens.")
        token_detail = {
            "token": body.token,
            "userAgent": body.userAgent,
            "updatedAt": datetime.now(timezone.utc),
        }
        update = {
            "pushTokens": fb_firestore.ArrayUnion([body.token]),
            "pushTokenDetails": fb_firestore.ArrayUnion([token_detail]),
            "notificationPermission": "granted",
            "pushUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        db.collection("users").document(uid).set(update, merge=True)
        db.collection("driverPresence").document(uid).set(update, merge=True)
        return {"ok": True}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not register driver push token.", 503)


@router.post("/{ride_id}/cancel")
def cancel_passenger_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Cancel an active passenger ride with ownership/state enforcement."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_role(profile, "passenger", "Only passengers can cancel passenger rides.")
        ride_ref = db.collection("rides").document(clean_ride_id)
        history_ref = db.collection("tripHistory").document(clean_ride_id)
        transaction = db.transaction()

        @fb_firestore.transactional
        def cancel_transaction(tx):
            snapshot = ride_ref.get(transaction=tx)
            if not snapshot.exists:
                raise ApiError("Ride not found.", 404)

            ride = snapshot.to_dict() or {}
            if ride.get("passenger_id") != uid:
                raise ApiError("Only the passenger can cancel this ride.", 403)

            status = ride.get("status")
            if status not in ACTIVE_PASSENGER_STATUSES:
                raise ApiError("This ride can no longer be cancelled.", 409)

            tx.update(
                ride_ref,
                {
                    "status": "cancelled_by_passenger",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            if ride.get("pinVerifiedAt"):
                tx.set(history_ref, _history_update(clean_ride_id, ride), merge=True)

        cancel_transaction(transaction)
        return {"ok": True, "rideId": clean_ride_id, "status": "cancelled_by_passenger"}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not cancel this ride.", 503)


@router.post("/{ride_id}/accept")
def accept_driver_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Assign a pending eligible ride to the authenticated driver atomically."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can accept rides.")
        driver_type = _driver_type(profile)
        if driver_type not in RIDE_SERVICES:
            raise ApiError("Your registered vehicle type is missing.", 403)

        active = (
            db.collection("rides")
            .where("driver_id", "==", uid)
            .where("status", "in", list(ACTIVE_PASSENGER_STATUSES - {"pending"}))
            .limit(1)
            .get()
        )
        if active:
            raise ApiError("You already have an active ride.", 409)

        ride_ref = db.collection("rides").document(clean_ride_id)
        transaction = db.transaction()
        accepted_ride: dict[str, Any] = {}

        @fb_firestore.transactional
        def accept_transaction(tx):
            snapshot = ride_ref.get(transaction=tx)
            if not snapshot.exists:
                raise ApiError("Ride request no longer exists.", 404)
            ride = snapshot.to_dict() or {}
            if ride.get("status") != "pending" or ride.get("driver_id"):
                raise ApiError("This ride was already accepted by another driver.", 409)
            if ride.get("vehicle_type") != driver_type:
                raise ApiError("This ride requires a matching registered vehicle.", 403)
            if uid not in (ride.get("eligible_driver_ids") or []):
                raise ApiError("This ride request is no longer available for you.", 403)

            accepted_ride.update(ride)
            accepted_ride.update({
                "status": "accepted",
                "driver_id": uid,
                "driver_name": str(profile.get("name") or "Driver")[:80],
                "driver_phone": str(profile.get("phone") or "")[:40],
                "vehicle_model": str(profile.get("vehicle_model") or profile.get("vehicleModel") or "Registered Vehicle")[:100],
                "vehicle_number": str(profile.get("vehicle_number") or profile.get("vehicleNumber") or "Vehicle number pending")[:60],
                "vehicle_type": driver_type,
            })
            tx.update(ride_ref, {
                "status": "accepted",
                "driver_id": uid,
                "driver_name": accepted_ride["driver_name"],
                "driver_phone": accepted_ride["driver_phone"],
                "vehicle_model": accepted_ride["vehicle_model"],
                "vehicle_number": accepted_ride["vehicle_number"],
                "vehicle_type": driver_type,
                "acceptedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })

        accept_transaction(transaction)
        db.collection("driverPresence").document(uid).set({
            "driverAvailability": "busy",
            "desiredAvailability": "online",
            "isConnected": True,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }, merge=True)
        db.collection("driverMapPresence").document(uid).set({
            "driverAvailability": "busy",
            "desiredAvailability": "online",
            "isConnected": True,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return {"ok": True, "rideId": clean_ride_id, "ride": accepted_ride}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not accept this ride.", 503)
