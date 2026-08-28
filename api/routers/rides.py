"""Server-authoritative ride lifecycle operations."""
from __future__ import annotations

import math
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Query, Request
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging
from pydantic import BaseModel, ConfigDict, Field

from ..core.auth import current_user
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.fare_policy import (
    FREE_DROPOFF_EXTRA_KM,
    FULL_FARE_PROGRESS_RATIO,
    MAX_SERVICEABLE_DISTANCE_KM,
    RIDE_SERVICES,
    ZERO_TRAVEL_THRESHOLD_KM,
    calculate_fare,
    get_service_fare_policy,
)
from ..core.firebase import get_admin_app
from ..core.geo import decode_polyline, haversine_km, road_distance_along_route_km

router = APIRouter(prefix="/rides", tags=["rides"])

ACTIVE_PASSENGER_STATUSES = {"pending", "accepted", "arrived", "started", "en_route"}
DISPATCH_BATCH_SIZE = 10
DISPATCH_TIMEOUT_MS = 45000
DRIVER_NOTIFICATION_ELIGIBLE_HOURS = 12
DRIVER_LOCATION_VISIBLE_SECONDS = DRIVER_NOTIFICATION_ELIGIBLE_HOURS * 60 * 60
KOLKATA_TZ = ZoneInfo("Asia/Kolkata")
# Heartbeat gap threshold used to accrue "online hours" for the driver
# dashboard. Only small, continuous gaps between GPS/availability writes are
# credited as online time -- a phone that was closed for hours and just
# reconnected should not suddenly get hours of "online" time backdated.
ONLINE_HEARTBEAT_MAX_GAP_SECONDS = 90
SAFETY_REPORT_CATEGORIES = {
    "unsafe_driving",
    "harassment",
    "route_deviation",
    "vehicle_condition",
    "payment_dispute",
    "rude_behavior",
    "other",
}
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")
PENDING_REQUEST_DEFAULT_TTL_SECONDS = 25 * 60  # 25 minutes
AUTO_NO_SHOW_COOLDOWN_SECONDS = 15 * 60  # 15 minutes cooldown after repeated no-shows
MAX_AUTO_NO_SHOW_THRESHOLD = 3


def _safe_ride_dict(ride: dict[str, Any]) -> dict[str, Any]:
    """Strip Firestore Sentinel and non-JSON-serializable types from a ride dict for API responses."""
    safe: dict[str, Any] = {}
    for k, v in ride.items():
        if hasattr(v, "isoformat"):
            # DatetimeWithNanoseconds or datetime — convert to ISO string
            safe[k] = v.isoformat()
        elif isinstance(v, dict):
            safe[k] = _safe_ride_dict(v)
        elif isinstance(v, list):
            safe[k] = [
                _safe_ride_dict(item) if isinstance(item, dict) else
                (item.isoformat() if hasattr(item, "isoformat") else item)
                for item in v
                if not hasattr(item, "_sentinel")
            ]
        elif hasattr(v, "_sentinel") or type(v).__name__ in ("Sentinel", "Increment"):
            # Firestore SERVER_TIMESTAMP, Increment — skip, will be set server-side
            pass
        else:
            safe[k] = v
    return safe


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


class SosBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: Optional[float] = None
    lng: Optional[float] = None
    note: str = Field(default="", max_length=300)


class ShareTripBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enable: bool = True


class SafetyReportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rideId: str = Field(default="", max_length=160)
    category: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=1000)


class PendingRideRequestBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pickupName: str = Field(min_length=1, max_length=200)
    dropName: str = Field(min_length=1, max_length=200)
    pickupLat: float
    pickupLng: float
    dropLat: float
    dropLng: float
    vehicleType: str = Field(default="auto", max_length=20)
    searchRadius: Optional[float] = Field(default=5000.0)
    mode: str = Field(default="notify_only", max_length=30)
    fareEstimate: Optional[dict[str, Any]] = None
    activatesAt: Optional[str] = None
    dropFullAddress: Optional[str] = Field(default="", max_length=500)


class PendingRideCancelBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: Optional[str] = Field(default="cancelled_by_user", max_length=100)


class DemandEventBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    eventType: str = Field(min_length=1, max_length=50)
    pickupLat: Optional[float] = None
    pickupLng: Optional[float] = None
    vehicleType: Optional[str] = Field(default="auto", max_length=20)
    metadata: Optional[dict[str, Any]] = None


# RIDE_SERVICES, MAX_SERVICEABLE_DISTANCE_KM, FULL_FARE_PROGRESS_RATIO,
# FREE_DROPOFF_EXTRA_KM, and ZERO_TRAVEL_THRESHOLD_KM all come from
# api/core/fare_policy.py, which reads /fare-policy.config.json -- the same
# file js/fare-policy.js reads. Edit that JSON file to change pricing; there
# is nothing fare-related to edit in this router.


def _calculate_fare(service: dict[str, Any], distance_km: float) -> int:
    return calculate_fare(service, distance_km)


def _ride_service(ride: dict[str, Any]) -> dict[str, Any]:
    fare_per_km = ride.get("fare_per_km")
    fare_base = ride.get("fare_base")
    if fare_per_km is not None and fare_base is not None:
        return {
            "name": ride.get("service_name") or "Ride",
            "capacity": int(ride.get("passenger_capacity") or 1),
            "base": float(fare_base or 0),
            "per_km": float(fare_per_km or 0),
            "min_fare": float(ride.get("fare_min") or fare_base or 0),
        }
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
        # "How far past/short of the exact drop pin is the driver right now"
        # is a small, local distance -- straight-line is fine there.
        distance_to_drop_km = _haversine_km(current["lat"], current["lng"], drop["lat"], drop["lng"])

        # "How much of the trip has the driver actually covered" is NOT a
        # small local distance -- it spans the whole route, so on a winding
        # road straight-line (haversine) distance from pickup to the driver's
        # current GPS ping is always shorter than the road distance actually
        # driven, which would systematically under-count progress_ratio and
        # under-pay the driver on non-straight routes. Use the real road
        # route (the Google-Routes polyline saved when the ride was created)
        # to measure distance travelled ALONG the road instead, falling back
        # to straight-line only when no route polyline was stored (e.g. an
        # older ride, or the routing call failed at creation time).
        route_points = decode_polyline(str(ride.get("route_polyline") or ""))
        road_travelled_km = road_distance_along_route_km(route_points, current)
        pickup_to_current_km = (
            road_travelled_km
            if road_travelled_km is not None
            else _haversine_km(pickup["lat"], pickup["lng"], current["lat"], current["lng"])
        )

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
    return haversine_km(lat1, lng1, lat2, lng2)


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
    v_type = str(driver.get("vehicle_type") or driver.get("vehicleType") or "").strip().lower()
    if v_type in {"auto", "bike"}:
        return v_type

    text = " ".join(
        str(driver.get(key) or "")
        for key in ("vehicle_type", "vehicleType", "vehicle_model", "vehicleModel", "vehicleName")
    ).lower()

    if "auto" in text or "rickshaw" in text or "tuk" in text or "3w" in text or "three" in text:
        return "auto"

    return "bike"


def _require_role(profile: dict[str, Any], expected_role: str, message: str) -> None:
    if profile.get("role") != expected_role:
        raise ApiError(message, 403)


def _to_utc_datetime(val: Any) -> Optional[datetime]:
    if not val:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=KOLKATA_TZ).astimezone(timezone.utc)
        return val.astimezone(timezone.utc)
    if isinstance(val, dict):
        secs = val.get("seconds") or val.get("_seconds")
        if secs is not None:
            try:
                return datetime.fromtimestamp(float(secs), tz=timezone.utc)
            except Exception:
                pass
    if hasattr(val, "timestamp") and callable(getattr(val, "timestamp")):
        try:
            return datetime.fromtimestamp(val.timestamp(), tz=timezone.utc)
        except Exception:
            pass
    try:
        s = str(val).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=KOLKATA_TZ).astimezone(timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _require_approved_driver(profile: dict[str, Any], message: str) -> None:
    v_status = profile.get("verificationStatus") or profile.get("verification_status") or profile.get("status") or ("approved" if profile.get("role") == "driver" else None)
    if profile.get("role") != "driver" or v_status != "approved":
        raise ApiError(message, 403)


def _coarse_location(location: Optional[dict[str, float]]) -> Optional[dict[str, float]]:
    if not location:
        return None
    return {
        "lat": round(float(location["lat"]), 4),
        "lng": round(float(location["lng"]), 4),
    }


def _build_driver_availability_updates(
    status: str,
    profile: dict[str, Any],
    location: Optional[dict[str, float]] = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    online = status != "offline"
    now = datetime.now(timezone.utc)
    notification_eligible_until = (
        now + timedelta(hours=DRIVER_NOTIFICATION_ELIGIBLE_HOURS)
        if online
        else datetime.fromtimestamp(0, timezone.utc)
    )
    v_status = profile.get("verificationStatus") or profile.get("verification_status") or profile.get("status") or "approved"
    user_update: dict[str, Any] = {
        "driverAvailability": status,
        "desiredAvailability": "online" if online else "offline",
        "isConnected": online,
        "notificationEligibleUntil": notification_eligible_until,
        "driverAvailabilityUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
        "lastSeenAt": fb_firestore.SERVER_TIMESTAMP,
    }
    presence_update: dict[str, Any] = {
        "uid": str(profile.get("uid") or "")[:160],
        "name": str(profile.get("name") or "Driver")[:80],
        "phone": str(profile.get("phone") or "")[:40],
        "driverAvailability": status,
        "desiredAvailability": "online" if online else "offline",
        "verificationStatus": v_status,
        "vehicle_model": profile.get("vehicle_model") or profile.get("vehicleModel") or "",
        "vehicle_number": profile.get("vehicle_number") or profile.get("vehicleNumber") or "",
        "vehicle_type": _driver_type(profile),
        "isConnected": online,
        "notificationEligibleUntil": notification_eligible_until,
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
    eff_loc = location or profile.get("driverLocation") or profile.get("location")
    if not eff_loc or not isinstance(eff_loc, dict) or "lat" not in eff_loc or "lng" not in eff_loc:
        eff_loc = None

    if eff_loc and "lat" in eff_loc and "lng" in eff_loc:
        loc_dict = {"lat": float(eff_loc["lat"]), "lng": float(eff_loc["lng"])}
        user_update["driverLocation"] = loc_dict
        presence_update["driverLocation"] = loc_dict
        map_presence_update["driverLocation"] = _coarse_location(loc_dict)

    return user_update, presence_update, map_presence_update


def _kolkata_day_str(moment: Optional[datetime] = None) -> str:
    moment = moment or datetime.now(timezone.utc)
    return moment.astimezone(KOLKATA_TZ).strftime("%Y-%m-%d")


def _daily_stats_ref(db, uid: str, day: Optional[str] = None):
    day = day or _kolkata_day_str()
    return db.collection("driverDailyStats").document(f"{uid}_{day}"), day


def _bump_daily_stats(db, uid: str, increments: dict[str, Any]) -> None:
    """Best-effort increment of today's per-driver dashboard counters
    (earnings, completed/declined rides, online seconds). Never raises --
    a dashboard counter must never block or fail a ride/GPS/availability
    write, which is why this is called after the main operation succeeds."""
    if not increments or not uid:
        return
    try:
        ref, day = _daily_stats_ref(db, uid)
        payload: dict[str, Any] = {
            "driver_id": uid,
            "date": day,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        for key, value in increments.items():
            payload[key] = fb_firestore.Increment(value)
        ref.set(payload, merge=True)
    except Exception:  # noqa: BLE001
        pass


def _accumulate_online_seconds(db, uid: str, previous_moment: Any, still_online: bool) -> None:
    """Adds elapsed time to today's driverDailyStats.online_seconds, based
    on the gap since the driver's previously recorded heartbeat (GPS ping or
    availability write). Only short, continuous gaps count -- see
    ONLINE_HEARTBEAT_MAX_GAP_SECONDS."""
    if not still_online:
        return
    previous_seconds = _timestamp_seconds(previous_moment)
    if previous_seconds is None:
        return
    elapsed = datetime.now(timezone.utc).timestamp() - previous_seconds
    if 0 < elapsed <= ONLINE_HEARTBEAT_MAX_GAP_SECONDS:
        _bump_daily_stats(db, uid, {"online_seconds": elapsed})


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


def _availability_for_location_update(profile: dict[str, Any], ride_id: str) -> tuple[str, str]:
    """Derive availability and persisted desiredAvailability for a location update.

    Rules:
    - If the driver is intentionally offline (desiredAvailability == 'offline'), preserve offline.
    - If there's an active ride_id, availability is 'busy'.
    - Otherwise availability is 'searching'.
    Returns (availability, desiredAvailability)
    """
    desired = str(profile.get("desiredAvailability") or "").strip().lower()
    if desired == "offline":
        return "offline", "offline"
    if ride_id:
        # When a ride is active the driver is busy but their desiredAvailability
        # remains whatever they had persisted (default to 'online').
        return "busy", ("online" if desired != "offline" else "offline")
    # Not offline and no active ride => searching
    return "searching", ("online" if desired != "offline" else "offline")


async def _server_route(pickup_lat: float, pickup_lng: float, drop_lat: float, drop_lng: float) -> tuple[float, int, str]:
    """Returns (distance_km, duration_minutes, encoded_polyline).

    The polyline is saved on the ride so that later, when checking how much
    of the trip the driver has actually covered, we can measure that
    distance along the real road route instead of a straight line -- see
    road_distance_along_route_km() in api/core/geo.py.
    """
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
                    "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
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
        encoded_polyline = str((route.get("polyline") or {}).get("encodedPolyline") or "")
        return float(route["distanceMeters"]) / 1000, max(1, round(float(duration) / 60)), encoded_polyline
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

    ride_requested_at = datetime.now(timezone.utc)
    service = get_service_fare_policy(body.vehicleType.strip().lower(), ride_requested_at)
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
        distance_km, duration_minutes, route_polyline = await _server_route(pickup_lat, pickup_lng, drop_lat, drop_lng)
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
            # Only block if there is a ride already accepted or ongoing with an assigned driver
            ongoing_query = (
                db.collection("rides")
                .where("passenger_id", "==", uid)
                .where("status", "in", ["accepted", "arrived", "started", "en_route"])
                .limit(1)
            )
            if list(ongoing_query.stream(transaction=tx)):
                raise ApiError("You already have an ongoing trip with a driver.", 409)

            # Auto-cancel any unaccepted searching/pending ride documents for this passenger
            unaccepted_query = (
                db.collection("rides")
                .where("passenger_id", "==", uid)
                .where("status", "in", ["pending", "searching", "dispatching"])
            )
            for old_doc in unaccepted_query.stream(transaction=tx):
                tx.update(old_doc.reference, {
                    "status": "cancelled_by_passenger",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                })

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
            # Saved so post-trip fare adjustment can measure how much of the
            # trip the driver actually drove along the real road, instead of
            # a straight line -- see road_distance_along_route_km() in
            # api/core/geo.py and _driver_fare_adjustment() below.
            "route_polyline": route_polyline,
            "fare": fare,
            "quoted_fare": fare,
            "fare_original": fare,
            "fare_base": service["base"],
            "fare_per_km": service["per_km"],
            "fare_min": service["min_fare"],
            "fare_is_night": service["is_night_fare"],
            "fare_requested_at": ride_requested_at.isoformat(),
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
            # No PIN is assigned at request time. It is only generated once a
            # driver accepts the ride (see accept_driver_ride below), so the
            # passenger never sees a pickup PIN before there is an assigned
            # driver to share it with.
            "verification_pin": None,
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
            "notifiedDriverIds": driver_ids,
            "ride": {key: value for key, value in ride_data.items() if key != "createdAt"},
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not create this ride request.", 503)


# ---------------------------------------------------------------------------
# Pending Ride Requests (Feature 3): notify_only / auto / schedule
# IMPORTANT: These fixed-path routes MUST be registered before the
# /{ride_id} wildcard routes so FastAPI matches them without ambiguity.
# ---------------------------------------------------------------------------

@router.get("/pending-request/active")
def get_active_pending_request(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Fetch active pending ride request for the passenger with lazy-expiry enforcement."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    db = fb_firestore.client(get_admin_app())
    pending_q = (
        db.collection("pendingRideRequests")
        .where("passengerId", "==", uid)
        .where("status", "in", ["pending", "dispatching"])
        .limit(1)
    )
    docs = list(pending_q.stream())
    if not docs:
        return {"ok": True, "hasActivePending": False, "pendingRequest": None}

    doc = docs[0]
    data = doc.to_dict() or {}
    now = datetime.now(timezone.utc)
    expires_at = data.get("expiresAt")
    if expires_at:
        exp_time = (
            expires_at
            if isinstance(expires_at, datetime)
            else (datetime.fromtimestamp(expires_at.timestamp(), tz=timezone.utc) if hasattr(expires_at, "timestamp") else None)
        )
        if exp_time and now > exp_time:
            doc.reference.update({"status": "expired", "updatedAt": fb_firestore.SERVER_TIMESTAMP})
            _log_demand_event(db, "pending_expired", {"requestId": doc.id, "passengerId": uid})
            return {"ok": True, "hasActivePending": False, "pendingRequest": None}

    return {"ok": True, "hasActivePending": True, "pendingRequest": {**data, "requestId": doc.id}}


@router.post("/pending-request")
async def create_pending_request(
    body: PendingRideRequestBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Create or update a persistent pending ride request (Feature 3)."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    db = fb_firestore.client(get_admin_app())
    profile = db.collection("users").document(uid).get().to_dict() or {}
    _require_role(profile, "passenger", "Only passengers can create pending ride requests.")

    pickup_lat = _coordinate(body.pickupLat, -90, 90)
    pickup_lng = _coordinate(body.pickupLng, -180, 180)
    drop_lat = _coordinate(body.dropLat, -90, 90)
    drop_lng = _coordinate(body.dropLng, -180, 180)
    mode = body.mode.strip().lower()
    if mode not in {"auto", "notify_only", "schedule"}:
        mode = "notify_only"

    # Check for no-show cooldown on auto mode
    if mode == "auto":
        no_show_count = int(profile.get("autoNoShowCount") or 0)
        last_no_show = _timestamp_seconds(profile.get("lastAutoNoShowAt"))
        if no_show_count >= MAX_AUTO_NO_SHOW_THRESHOLD and last_no_show:
            elapsed = datetime.now(timezone.utc).timestamp() - last_no_show
            if elapsed < AUTO_NO_SHOW_COOLDOWN_SECONDS:
                remaining_min = math.ceil((AUTO_NO_SHOW_COOLDOWN_SECONDS - elapsed) / 60)
                raise ApiError(
                    f"Auto-booking is temporarily cooling down ({remaining_min} min remaining) due to recent missed requests. Please use 'Notify Me' mode instead.",
                    429,
                )

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=PENDING_REQUEST_DEFAULT_TTL_SECONDS)
    activates_at_dt = None
    if body.activatesAt:
        activates_at_dt = _to_utc_datetime(body.activatesAt)
        if activates_at_dt:
            expires_at = max(now + timedelta(seconds=PENDING_REQUEST_DEFAULT_TTL_SECONDS), activates_at_dt + timedelta(hours=2))

    # Prevent duplicate active requests by reusing existing active document
    existing_q = (
        db.collection("pendingRideRequests")
        .where("passengerId", "==", uid)
        .where("status", "==", "pending")
        .limit(1)
    )
    existing_docs = list(existing_q.stream())
    if existing_docs:
        req_ref = existing_docs[0].reference
    else:
        req_ref = db.collection("pendingRideRequests").document()

    fare_estimate = body.fareEstimate or {}
    pending_doc_data = {
        "requestId": req_ref.id,
        "passengerId": uid,
        "passengerName": str(profile.get("name") or "User")[:80],
        "passengerPhone": str(profile.get("phone") or "")[:40],
        "pickup": {
            "name": body.pickupName.strip()[:200],
            "address": body.pickupName.strip()[:200],
            "lat": pickup_lat,
            "lng": pickup_lng,
        },
        "drop": {
            "name": body.dropName.strip()[:200],
            "address": body.dropFullAddress.strip()[:500] or body.dropName.strip()[:200],
            "lat": drop_lat,
            "lng": drop_lng,
        },
        "vehicleType": body.vehicleType.strip().lower() or "auto",
        "searchRadius": float(body.searchRadius or 5000.0),
        "mode": mode,
        "status": "pending",
        "createdAt": fb_firestore.SERVER_TIMESTAMP if not existing_docs else existing_docs[0].to_dict().get("createdAt"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        "expiresAt": expires_at,
        "activatesAt": activates_at_dt,
        "fare": float(fare_estimate.get("fare") or 0),
        "distanceKm": float(fare_estimate.get("distance_km") or 0),
        "fareEstimate": fare_estimate,
        "lockedByDriverId": None,
        "rejected_driver_ids": [],
    }

    req_ref.set(pending_doc_data, merge=True)

    # Immediately trigger activation & driver matching sweep if due or searching
    try:
        activate_due_scheduled_requests(db)
    except Exception as exc:
        print(f"Immediate scheduled activation error: {exc}")

    _log_demand_event(db, "pending_created", {
        "requestId": req_ref.id,
        "passengerId": uid,
        "mode": mode,
        "searchRadius": float(body.searchRadius or 5000.0),
        "vehicleType": body.vehicleType,
        "pickupLat": pickup_lat,
        "pickupLng": pickup_lng,
    })

    return {
        "ok": True,
        "requestId": req_ref.id,
        "mode": mode,
        "expiresAt": expires_at.isoformat(),
    }


@router.post("/pending-request/{request_id}/cancel")
def cancel_pending_request(
    request_id: str,
    body: PendingRideCancelBody = PendingRideCancelBody(),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Cancel an active pending ride request safely without blocking the user."""
    uid = str(user.get("uid") or "").strip()
    clean_req_id = request_id.strip()[:160]

    try:
        db = fb_firestore.client(get_admin_app())
        doc_ref = db.collection("pendingRideRequests").document(clean_req_id)
        doc_snap = doc_ref.get()
        if doc_snap.exists:
            doc_ref.update({
                "status": "cancelled",
                "cancelReason": (body.reason or "cancelled_by_user")[:100],
                "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            try:
                _log_demand_event(db, "pending_cancelled", {
                    "requestId": clean_req_id,
                    "passengerId": uid,
                    "reason": (body.reason or "cancelled_by_user")[:100],
                })
            except Exception:
                pass
    except Exception as exc:
        print(f"Cancel pending request exception handled: {exc}")

    return {"ok": True, "requestId": clean_req_id, "status": "cancelled"}


# ---------------------------------------------------------------------------
# End of pending-request routes
# ---------------------------------------------------------------------------


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
                final_fare_val = fare_adjustment["final_fare"]
                final_fare_paise = int(round(float(final_fare_val) * 100))
                wallet_paid_paise = int(ride.get("walletPaidAmountPaise") or int(round(float(ride.get("wallet_paid_amount") or 0) * 100)))
                cash_paid_paise = int(ride.get("cashPaidAmountPaise") or 0)
                rem_fare_paise = max(0, final_fare_paise - (wallet_paid_paise + cash_paid_paise))
                is_fully_paid = rem_fare_paise == 0

                complete_updates = {
                    "status": next_status,
                    "completedAt": fb_firestore.SERVER_TIMESTAMP,
                    "fare": final_fare_val,
                    "farePaise": final_fare_paise,
                    "walletPaidAmountPaise": wallet_paid_paise,
                    "remainingFarePaise": rem_fare_paise,
                    "remaining_fare": round(rem_fare_paise / 100.0, 2),
                    "fare_adjustment": fare_adjustment,
                    "fareFinalizedAt": fb_firestore.SERVER_TIMESTAMP,
                }
                if is_fully_paid:
                    complete_updates["payment_status"] = "paid"
                    complete_updates["paymentConfirmedAt"] = fb_firestore.SERVER_TIMESTAMP
                updates.update(complete_updates)
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
            if ride.get("share_enabled"):
                # Keep the public live-tracking snapshot (see set_trip_share
                # below) in sync with real ride status, and stop sharing the
                # moment the trip reaches a terminal state.
                share_ref = db.collection("tripShareView").document(clean_ride_id)
                if next_status in {"completed", "cancelled_by_driver"}:
                    tx.delete(share_ref)
                else:
                    tx.set(share_ref, {"status": next_status, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True)

        transition_transaction(transaction)
        if action == "complete":
            _bump_daily_stats(db, uid, {"completed_rides": 1, "earnings": float(result.get("fare") or 0)})
        if action in {"complete", "cancel"}:
            availability_status = "offline"
            if str(profile.get("desiredAvailability") or "").strip().lower() != "offline" and str(profile.get("driverAvailability") or "").strip().lower() != "offline":
                availability_status = "searching"
            user_update, presence_update, map_presence_update = _build_driver_availability_updates(availability_status, profile)
            db.collection("users").document(uid).set(user_update, merge=True)
            db.collection("driverPresence").document(uid).set(presence_update, merge=True)
            db.collection("driverMapPresence").document(uid).set(map_presence_update, merge=True)
            if availability_status == "searching":
                _match_pending_requests_for_driver(db, uid, profile, profile.get("driverLocation") or profile.get("location"))
        return {"ok": True, "rideId": clean_ride_id, "status": result.get("status"), "ride": _safe_ride_dict(result)}
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
        batch_size = int(ride.get("dispatch_batch_size") or DISPATCH_BATCH_SIZE)
        next_batch = [item["uid"] for item in all_candidates if item["uid"] not in excluded][:batch_size]

        # Retry search resilience: If no new unnotified drivers exist, but active drivers are currently online and searching,
        # fallback to re-dispatching active candidates (excluding explicitly rejected drivers first, then all active candidates)
        if not next_batch and all_candidates:
            rejected = set(ride.get("rejected_driver_ids") or [])
            next_batch = [item["uid"] for item in all_candidates if item["uid"] not in rejected][:batch_size]
            if not next_batch:
                next_batch = [item["uid"] for item in all_candidates][:batch_size]

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
        user_update, presence_update, map_presence_update = _build_driver_availability_updates(
            status,
            {**profile, "uid": uid},
            {"lat": lat, "lng": lng} if lat is not None else None,
        )
        _accumulate_online_seconds(db, uid, profile.get("lastSeenAt"), status != "offline")
        db.collection("users").document(uid).set(user_update, merge=True)
        db.collection("driverPresence").document(uid).set(presence_update, merge=True)
        db.collection("driverMapPresence").document(uid).set(map_presence_update, merge=True)
        if status == "searching":
            activate_due_scheduled_requests(db)
            _match_pending_requests_for_driver(
                db, uid, profile, {"lat": lat, "lng": lng} if lat is not None else profile.get("driverLocation") or profile.get("location")
            )
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
        # Derive availability using the driver's persisted desiredAvailability
        # so intentionally-offline drivers remain offline and active rides
        # correctly mark the driver as busy.
        availability, persisted_desired = _availability_for_location_update(profile, ride_id)
        _accumulate_online_seconds(db, uid, profile.get("lastLocationAt") or profile.get("lastSeenAt"), availability != "offline")
        if ride_id:
            # Validate ride ownership and status when a ride_id is supplied.
            ride_ref = db.collection("rides").document(ride_id)
            ride = ride_ref.get().to_dict()
            if not ride:
                raise ApiError("Ride not found.", 404)
            if ride.get("driver_id") != uid:
                raise ApiError("Only the assigned driver can update this ride location.", 403)
            if ride.get("status") not in ACTIVE_PASSENGER_STATUSES:
                raise ApiError("This ride is no longer active.", 409)

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
            "desiredAvailability": persisted_desired,
            "isConnected": True,
            "notificationEligibleUntil": now + timedelta(hours=DRIVER_NOTIFICATION_ELIGIBLE_HOURS),
            "lastSeenAt": now,
            "lastAppSeenAt": now,
            "lastLocationAt": now,
            "updatedAt": now,
        }
        profile_ref.set({
            "driverLocation": location,
            **telemetry,
            "notificationEligibleUntil": now + timedelta(hours=DRIVER_NOTIFICATION_ELIGIBLE_HOURS),
            "lastSeenAt": now,
            "lastLocationAt": now,
        }, merge=True)
        db.collection("driverPresence").document(uid).set(presence_update, merge=True)
        db.collection("driverMapPresence").document(uid).set({
            "uid": uid,
            "name": str(profile.get("name") or "Driver")[:80],
            "driverAvailability": availability,
            "desiredAvailability": persisted_desired,
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
            if ride.get("share_enabled"):
                # Mirror only coordinates/status into the public, sanitized
                # live-tracking snapshot -- see set_trip_share() below.
                db.collection("tripShareView").document(ride_id).set(
                    {"driverLocation": location, "status": ride.get("status"), "updatedAt": now}, merge=True
                )
        if availability == "searching" and not ride_id:
            activate_due_scheduled_requests(db)
            _match_pending_requests_for_driver(db, uid, profile, location)
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
        notification_eligible_until = (
            datetime.now(timezone.utc) + timedelta(hours=DRIVER_NOTIFICATION_ELIGIBLE_HOURS)
            if str(profile.get("desiredAvailability") or profile.get("driverAvailability") or "").strip().lower() != "offline"
            else datetime.fromtimestamp(0, timezone.utc)
        )
        update = {
            "fcmToken": body.token,
            "pushTokens": fb_firestore.ArrayUnion([body.token]),
            "pushTokenDetails": fb_firestore.ArrayUnion([token_detail]),
            "notificationPermission": "granted",
            "notificationEligibleUntil": notification_eligible_until,
            "lastAppSeenAt": fb_firestore.SERVER_TIMESTAMP,
            "pushUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        db.collection("users").document(uid).set(update, merge=True)
        db.collection("driverPresence").document(uid).set(update, merge=True)
        return {"ok": True}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not register driver push token.", 503)


@router.post("/passenger-push-token")
def save_passenger_push_token(
    body: DriverPushTokenBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Store a push token for the authenticated passenger's account."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if body.permission != "granted":
        raise ApiError("Push permission is not granted.", 400)
    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_role(profile, "passenger", "Only passengers can register passenger push tokens.")
        token_detail = {
            "token": body.token,
            "userAgent": body.userAgent,
            "updatedAt": datetime.now(timezone.utc),
        }
        update = {
            "fcmToken": body.token,
            "pushTokens": fb_firestore.ArrayUnion([body.token]),
            "pushTokenDetails": fb_firestore.ArrayUnion([token_detail]),
            "notificationPermission": "granted",
            "lastAppSeenAt": fb_firestore.SERVER_TIMESTAMP,
            "pushUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        db.collection("users").document(uid).set(update, merge=True)
        return {"ok": True}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not register passenger push token.", 503)


@router.post("/{ride_id}/cancel")
def cancel_passenger_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Cancel an active passenger ride cleanly without blocking the user under any scenario."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]

    try:
        db = fb_firestore.client(get_admin_app())
        ride_ref = db.collection("rides").document(clean_ride_id)
        ride_snap = ride_ref.get()

        if ride_snap.exists:
            ride = ride_snap.to_dict() or {}
            ride_ref.update({
                "status": "cancelled_by_passenger",
                "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            
            try:
                if ride.get("pinVerifiedAt"):
                    history_ref = db.collection("tripHistory").document(clean_ride_id)
                    history_ref.set(_history_update(clean_ride_id, ride), merge=True)
                if ride.get("share_enabled"):
                    db.collection("tripShareView").document(clean_ride_id).delete()
            except Exception:
                pass

            return {"ok": True, "rideId": clean_ride_id, "status": "cancelled_by_passenger"}

        # Fallback check in pendingRideRequests
        pending_ref = db.collection("pendingRideRequests").document(clean_ride_id)
        pending_snap = pending_ref.get()
        if pending_snap.exists:
            pending_ref.update({
                "status": "cancelled",
                "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            try:
                _log_demand_event(db, "pending_cancelled", {"requestId": clean_ride_id, "passengerId": uid, "reason": "passenger_cancelled"})
            except Exception:
                pass
            return {"ok": True, "requestId": clean_ride_id, "status": "cancelled"}

    except Exception as exc:
        print(f"Cancel passenger ride exception handled: {exc}")

    return {"ok": True, "rideId": clean_ride_id, "status": "cancelled_by_passenger"}


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
            status = str(ride.get("status") or "").strip().lower()

            if status in ("cancelled", "cancelled_by_passenger", "cancelled_by_driver"):
                raise ApiError("This ride request was cancelled by the passenger.", 409)
            if status != "pending" or ride.get("driver_id"):
                raise ApiError("This ride was already accepted by another driver.", 409)

            # Enforce 5-minute expiration timer server-side
            now = datetime.now(timezone.utc)
            created_at = ride.get("createdAt")
            c_time = None
            if created_at:
                if isinstance(created_at, datetime):
                    c_time = created_at
                elif hasattr(created_at, "timestamp"):
                    c_time = datetime.fromtimestamp(created_at.timestamp(), tz=timezone.utc)
            elif ride.get("fare_requested_at"):
                try:
                    c_time = datetime.fromisoformat(str(ride["fare_requested_at"]).replace("Z", "+00:00"))
                except Exception:
                    c_time = None

            if c_time and (now - c_time).total_seconds() > 300:  # 5 minutes
                tx.update(ride_ref, {
                    "status": "timeout",
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP
                })
                raise ApiError("This ride request has expired.", 410)

            if ride.get("vehicle_type") != driver_type:
                raise ApiError("This ride requires a matching registered vehicle.", 403)
            if uid not in (ride.get("eligible_driver_ids") or []):
                raise ApiError("This ride request is no longer available for you.", 403)
            if uid in (ride.get("rejected_driver_ids") or []):
                raise ApiError("You have already declined this ride request.", 403)

            # The pickup verification PIN is assigned only now, at the moment
            # a driver actually accepts -- never at ride-request time.
            verification_pin = str(ride.get("verification_pin") or "").strip() or f"{secrets.randbelow(10000):04d}"

            accepted_ride.update(ride)
            accepted_ride.update({
                "status": "accepted",
                "driver_id": uid,
                "driver_name": str(profile.get("name") or "Driver")[:80],
                "driver_phone": str(profile.get("phone") or "")[:40],
                "driver_profile_photo": str(profile.get("profilePhotoUrl") or "")[:500000],
                "vehicle_model": str(profile.get("vehicle_model") or profile.get("vehicleModel") or "Registered Vehicle")[:100],
                "vehicle_number": str(profile.get("vehicle_number") or profile.get("vehicleNumber") or "Vehicle number pending")[:60],
                "vehicle_type": driver_type,
                "verification_pin": verification_pin,
            })
            tx.update(ride_ref, {
                "status": "accepted",
                "driver_id": uid,
                "driver_name": accepted_ride["driver_name"],
                "driver_phone": accepted_ride["driver_phone"],
                "driver_profile_photo": accepted_ride["driver_profile_photo"],
                "vehicle_model": accepted_ride["vehicle_model"],
                "vehicle_number": accepted_ride["vehicle_number"],
                "vehicle_type": driver_type,
                "verification_pin": verification_pin,
                "acceptedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })

            # Synchronize pendingRideRequest status if this was an auto/scheduled dispatch
            pending_req_id = ride.get("pendingRequestId")
            if pending_req_id:
                pending_ref = db.collection("pendingRideRequests").document(str(pending_req_id))
                tx.update(pending_ref, {
                    "status": "matched",
                    "matchedDriverId": uid,
                    "matchedAt": fb_firestore.SERVER_TIMESTAMP,
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


@router.post("/{ride_id}/reject")
def reject_driver_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Lets a driver explicitly decline a pending ride request they were
    notified about. The ride stays open for the remaining eligible drivers;
    this driver is recorded in rejected_driver_ids and the request stops
    showing in their incoming-requests queue (see driver.js / driver-service.js
    filtering on rejected_driver_ids). Declines also count toward the
    driver-dashboard acceptance-rate stat."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can decline rides.")
        ride_ref = db.collection("rides").document(clean_ride_id)
        snapshot = ride_ref.get()
        if not snapshot.exists:
            raise ApiError("Ride request no longer exists.", 404)
        ride = snapshot.to_dict() or {}
        if ride.get("status") != "pending" or ride.get("driver_id"):
            # Already accepted/cancelled/expired elsewhere -- nothing to decline.
            return {"ok": True, "rideId": clean_ride_id, "status": ride.get("status") or "unavailable"}
        if uid not in (ride.get("eligible_driver_ids") or []):
            raise ApiError("This ride request is no longer available for you.", 403)

        ride_ref.update({
            "status": "declined",
            "rejected_driver_ids": fb_firestore.ArrayUnion([uid]),
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        })

        # Rollback pendingRideRequest to "pending" so the next candidate driver can claim it
        pending_req_id = ride.get("pendingRequestId")
        if pending_req_id:
            pending_ref = db.collection("pendingRideRequests").document(str(pending_req_id))
            try:
                @fb_firestore.transactional
                def rollback_pending_tx(tx):
                    p_snap = pending_ref.get(transaction=tx)
                    if p_snap.exists:
                        p_data = p_snap.to_dict() or {}
                        if p_data.get("status") == "dispatching" and p_data.get("lockedByDriverId") == uid:
                            tx.update(pending_ref, {
                                "status": "pending",
                                "lockedByDriverId": None,
                                "dispatchLockedAt": None,
                                "rejected_driver_ids": fb_firestore.ArrayUnion([uid]),
                                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                            })
                rollback_pending_tx(db.transaction())

                # Cascading dispatch: immediately attempt to match next available driver
                searching_drivers = list(db.collection("driverPresence").where("driverAvailability", "==", "searching").limit(20).stream())
                for d_doc in searching_drivers:
                    if d_doc.id == uid:
                        continue
                    driver_uid = d_doc.id
                    d_data = d_doc.to_dict() or {}
                    d_profile = db.collection("users").document(driver_uid).get().to_dict() or {}
                    d_loc = d_data.get("driverLocation") or d_profile.get("driverLocation") or d_profile.get("location")
                    if driver_uid and d_loc:
                        matched_id = _match_pending_requests_for_driver(db, driver_uid, d_profile, d_loc)
                        if matched_id:
                            break
            except Exception as e:
                print(f"Pending rollback cascading dispatch error: {e}")

        _bump_daily_stats(db, uid, {"declined_count": 1})
        return {"ok": True, "rideId": clean_ride_id, "status": "declined"}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not decline this ride.", 503)


@router.get("/driver-dashboard")
def get_driver_dashboard(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Feature 1 (Driver Dashboard): today's earnings/completed rides/online
    hours plus queued-request and performance stats, all computed
    server-side from driverDailyStats (a small per-driver-per-day counter
    doc, see _bump_daily_stats) and the driver's own users/{uid} profile.
    No new composite Firestore index is required: driverDailyStats is read
    by direct document ID, and the pending-request scan below filters a
    small, already-indexed `status == "pending"` result set in Python
    rather than requiring an array-contains composite index."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        _require_approved_driver(profile, "Only approved drivers can view the driver dashboard.")

        daily_ref, day = _daily_stats_ref(db, uid)
        daily = daily_ref.get().to_dict() or {}

        current_trip = None
        active_docs = list(
            db.collection("rides")
            .where("driver_id", "==", uid)
            .where("status", "in", list(ACTIVE_PASSENGER_STATUSES - {"pending"}))
            .limit(1)
            .stream()
        )
        if active_docs:
            ride = active_docs[0].to_dict() or {}
            current_trip = {
                "rideId": active_docs[0].id,
                "status": ride.get("status"),
                "passengerName": ride.get("passenger_name"),
                "pickupName": ride.get("pickup_name"),
                "dropName": ride.get("drop_name"),
                "fare": ride.get("fare"),
            }

        pending_count = 0
        pending_preview: list[dict[str, Any]] = []
        for doc_snap in db.collection("rides").where("status", "==", "pending").limit(200).stream():
            ride = doc_snap.to_dict() or {}
            if uid not in (ride.get("eligible_driver_ids") or []):
                continue
            if uid in (ride.get("rejected_driver_ids") or []):
                continue
            pending_count += 1
            if len(pending_preview) < 5:
                pending_preview.append({
                    "rideId": doc_snap.id,
                    "pickupName": ride.get("pickup_name"),
                    "dropName": ride.get("drop_name"),
                    "fare": ride.get("fare"),
                    "vehicleType": ride.get("vehicle_type"),
                })

        completed_today = int(daily.get("completed_rides") or 0)
        declined_today = int(daily.get("declined_count") or 0)
        decided_today = completed_today + declined_today
        lifetime_trips = int(profile.get("total_completed_trips") or 0)
        lifetime_earnings = float(profile.get("lifetime_earnings") or 0)

        return {
            "ok": True,
            "date": day,
            "today": {
                "earnings": round(float(daily.get("earnings") or 0), 2),
                "completedRides": completed_today,
                "declinedRides": declined_today,
                "onlineHours": round(float(daily.get("online_seconds") or 0) / 3600, 2),
                "acceptanceRate": round(completed_today / decided_today, 2) if decided_today else None,
            },
            "pendingTrips": {"count": pending_count, "preview": pending_preview},
            "currentTrip": current_trip,
            "performance": {
                "lifetimeEarnings": round(lifetime_earnings, 2),
                "lifetimeCompletedTrips": lifetime_trips,
                "averageFare": round(lifetime_earnings / lifetime_trips, 2) if lifetime_trips else 0,
            },
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not load the driver dashboard.", 503)


def _trip_share_snapshot(ride: dict[str, Any]) -> dict[str, Any]:
    """Sanitized, contact-free snapshot mirrored to the public
    `tripShareView` collection -- see set_trip_share(). Deliberately
    excludes phone numbers and any field not needed to render a read-only
    live map for a trusted contact."""
    return {
        "status": ride.get("status"),
        "pickup_name": ride.get("pickup_name") or "",
        "drop_name": ride.get("drop_name") or "",
        "driver_name": ride.get("driver_name") or "",
        "vehicle_model": ride.get("vehicle_model") or "",
        "vehicle_number": ride.get("vehicle_number") or "",
        "vehicle_type": ride.get("vehicle_type") or "",
        "fare": ride.get("fare"),
        "driverLocation": ride.get("driverLocation"),
        "pickup_lat": ride.get("pickup_lat"),
        "pickup_lng": ride.get("pickup_lng"),
        "drop_lat": ride.get("drop_lat"),
        "drop_lng": ride.get("drop_lng"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }


@router.post("/{ride_id}/share")
def set_trip_share(
    ride_id: str,
    body: ShareTripBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Feature 3 (live trip sharing): turns sharing on/off for one ride.
    While enabled, a sanitized snapshot is mirrored to
    `tripShareView/{rideId}` (public read, server-only write -- see
    firestore.rules) so a passenger can send the plain link
    `/track?ride=<rideId>` to a trusted contact who never needs a LiphtUp
    account. The full `rides` document, with contact numbers and PIN,
    always stays private. The snapshot is kept in sync by
    update_driver_location() and transition_driver_ride() above, and is
    deleted the moment the trip ends or sharing is turned off."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        ride_ref = db.collection("rides").document(clean_ride_id)
        snapshot = ride_ref.get()
        if not snapshot.exists:
            raise ApiError("Ride not found.", 404)
        ride = snapshot.to_dict() or {}
        if ride.get("passenger_id") != uid:
            raise ApiError("Only the passenger can share this ride.", 403)

        share_ref = db.collection("tripShareView").document(clean_ride_id)
        if body.enable:
            if ride.get("status") not in ACTIVE_PASSENGER_STATUSES:
                raise ApiError("Only an active ride can be shared.", 409)
            ride_ref.set({"share_enabled": True, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True)
            share_ref.set(_trip_share_snapshot(ride), merge=True)
        else:
            ride_ref.set({"share_enabled": False, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True)
            share_ref.delete()
        return {"ok": True, "rideId": clean_ride_id, "enabled": body.enable}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not update trip sharing.", 503)


@router.post("/{ride_id}/sos")
def trigger_ride_sos(
    ride_id: str,
    body: SosBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Feature 3 (emergency SOS): records an SOS raised from an active ride
    by either participant. This never replaces calling local emergency
    services -- the app tells the rider to do that first -- it additionally
    raises a real-time alert the admin console's Safety section shows
    immediately (see firestore.rules `sosAlerts` + admin.py), and stores the
    reporter's last known location for follow-up."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        ride_ref = db.collection("rides").document(clean_ride_id)
        snapshot = ride_ref.get()
        if not snapshot.exists:
            raise ApiError("Ride not found.", 404)
        ride = snapshot.to_dict() or {}

        if uid == ride.get("passenger_id"):
            role = "passenger"
            reporter_name = ride.get("passenger_name") or "Passenger"
            reporter_phone = ride.get("passenger_phone") or ""
        elif uid == ride.get("driver_id"):
            role = "driver"
            reporter_name = ride.get("driver_name") or "Driver"
            reporter_phone = ride.get("driver_phone") or ""
        else:
            raise ApiError("Only ride participants can raise an SOS for this ride.", 403)

        location = None
        if body.lat is not None and body.lng is not None:
            location = {"lat": _coordinate(body.lat, -90, 90), "lng": _coordinate(body.lng, -180, 180)}

        alert_ref = db.collection("sosAlerts").document()
        alert_ref.set({
            "ride_id": clean_ride_id,
            "reporter_id": uid,
            "reporter_role": role,
            "reporter_name": str(reporter_name)[:80],
            "reporter_phone": str(reporter_phone)[:40],
            "location": location,
            "note": body.note.strip(),
            "pickup_name": ride.get("pickup_name") or "",
            "drop_name": ride.get("drop_name") or "",
            "passenger_name": ride.get("passenger_name") or "",
            "driver_name": ride.get("driver_name") or "",
            "vehicle_number": ride.get("vehicle_number") or "",
            "status": "open",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        })
        ride_ref.set(
            {"sos_active": True, "sos_last_alert_id": alert_ref.id, "updatedAt": fb_firestore.SERVER_TIMESTAMP},
            merge=True,
        )
        return {"ok": True, "alertId": alert_ref.id}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not send the SOS alert. Please call local emergency services directly.", 503)


@router.post("/safety-report")
def submit_safety_report(
    body: SafetyReportBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Feature 3 (suspicious activity reporting): lets a signed-in passenger
    or driver report a safety/behavior concern, optionally tied to a
    specific ride. Always server-written to `safetyReports` so a report can
    never be edited or deleted by the account it concerns; reviewed from the
    admin console's Safety section (see admin.py)."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    category = body.category.strip().lower()
    if category not in SAFETY_REPORT_CATEGORIES:
        raise ApiError("Choose a valid report category.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        profile = db.collection("users").document(uid).get().to_dict() or {}
        ride_id = body.rideId.strip()[:160]
        ride_snapshot: dict[str, Any] = {}
        if ride_id:
            ride_doc = db.collection("rides").document(ride_id).get()
            if not ride_doc.exists:
                raise ApiError("Ride not found.", 404)
            ride = ride_doc.to_dict() or {}
            if uid not in {ride.get("passenger_id"), ride.get("driver_id")}:
                raise ApiError("You can only report a ride you were part of.", 403)
            ride_snapshot = {
                "pickup_name": ride.get("pickup_name") or "",
                "drop_name": ride.get("drop_name") or "",
                "passenger_id": ride.get("passenger_id"),
                "passenger_name": ride.get("passenger_name") or "",
                "driver_id": ride.get("driver_id"),
                "driver_name": ride.get("driver_name") or "",
            }

        report_ref = db.collection("safetyReports").document()
        report_ref.set({
            "ride_id": ride_id or None,
            "reporter_id": uid,
            "reporter_role": profile.get("role") or "unknown",
            "reporter_name": str(profile.get("name") or "")[:80],
            "reporter_phone": str(profile.get("phone") or "")[:40],
            "category": category,
            "description": body.description.strip(),
            **ride_snapshot,
            "status": "open",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        })
        return {"ok": True, "reportId": report_ref.id}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not submit this report.", 503)


# ===========================================================================
# Feature 3 & 4: Pending Ride Requests & Demand Matching
# ===========================================================================

def _collect_tokens(user_data: dict[str, Any]) -> list[str]:
    tokens: set[str] = set()
    for token in user_data.get("pushTokens") or []:
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())
    for detail in user_data.get("pushTokenDetails") or []:
        token = (detail or {}).get("token") if isinstance(detail, dict) else None
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())
    return list(tokens)


def _log_demand_event(db, event_type: str, metadata: dict[str, Any]) -> None:
    """Server-side demand and search analytics logger (Feature 4.6)."""
    try:
        db.collection("rideDemandEvents").document().set({
            "eventType": str(event_type).strip().lower(),
            **metadata,
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        })
    except Exception as exc:  # noqa: BLE001
        print(f"Demand event logging skipped: {exc}")


def _send_passenger_push_and_inapp(db, passenger_id: str, title: str, body: str, data_payload: dict[str, Any]) -> None:
    """Send push notification to passenger if token exists, and record in-app notification document fallback."""
    try:
        user_doc = db.collection("users").document(passenger_id).get()
        if not user_doc.exists:
            return
        user_data = user_doc.to_dict() or {}

        # Save in-app notification document for users without push permission
        db.collection("users").document(passenger_id).collection("inAppNotifications").document().set({
            "title": title,
            "body": body,
            "data": data_payload,
            "read": False,
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        })

        tokens = _collect_tokens(user_data)
        if not tokens:
            return

        app = get_admin_app()
        link_url = data_payload.get("url") or f"{APP_BASE_URL}/services"
        message = fb_messaging.MulticastMessage(
            tokens=tokens,
            data={**{k: str(v) for k, v in data_payload.items()}, "title": title, "body": body},
            webpush=fb_messaging.WebpushConfig(
                headers={"Urgency": "high", "TTL": "600"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=link_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag=f"liphtup-passenger-{passenger_id}",
                    renotify=True,
                    require_interaction=True,
                ),
            ),
        )
        fb_messaging.send_each_for_multicast(message, app=app)
    except Exception as exc:  # noqa: BLE001
        print(f"Passenger notification skipped: {exc}")


def _send_driver_push_notification(db, driver_id: str, title: str, body: str, data_payload: dict[str, Any]) -> None:
    """Send push notification to driver if tokens exist."""
    try:
        user_doc = db.collection("users").document(driver_id).get()
        if not user_doc.exists:
            return
        user_data = user_doc.to_dict() or {}
        tokens = _collect_tokens(user_data)
        if not tokens:
            return

        app = get_admin_app()
        link_url = data_payload.get("url") or f"{APP_BASE_URL}/driver?rideId={data_payload.get('rideId', '')}&from=push"
        message = fb_messaging.MulticastMessage(
            tokens=tokens,
            data={**{k: str(v) for k, v in data_payload.items()}, "title": title, "body": body},
            webpush=fb_messaging.WebpushConfig(
                headers={"Urgency": "high", "TTL": "600"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=link_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag=f"liphtup-driver-{driver_id}",
                    renotify=True,
                    require_interaction=True,
                ),
            ),
        )
        fb_messaging.send_each_for_multicast(message, app=app)
    except Exception as exc:  # noqa: BLE001
        print(f"Driver notification skipped: {exc}")


def _match_pending_requests_for_driver(
    db,
    driver_id: str,
    driver_profile: dict[str, Any],
    driver_location: Optional[dict[str, float]],
) -> Optional[str]:
    """FIFO matching of pending requests against a newly available driver with atomic race-condition lock."""
    if not driver_location or "lat" not in driver_location or "lng" not in driver_location:
        return None

    driver_lat = float(driver_location["lat"])
    driver_lng = float(driver_location["lng"])
    driver_type = _driver_type(driver_profile)

    now = datetime.now(timezone.utc)

    # Clean up stale locks for requests locked > 45s without driver acceptance (ignored requests)
    try:
        stale_locks = list(
            db.collection("pendingRideRequests")
            .where("status", "==", "dispatching")
            .limit(10)
            .stream()
        )
        for sdoc in stale_locks:
            sdata = sdoc.to_dict() or {}
            locked_at = sdata.get("dispatchLockedAt")
            locked_driver = sdata.get("lockedByDriverId")
            if locked_at:
                locked_dt = _to_utc_datetime(locked_at)
                if locked_dt and (now - locked_dt) > timedelta(seconds=45):
                    sdoc.reference.update({
                        "status": "pending",
                        "lockedByDriverId": None,
                        "dispatchLockedAt": None,
                        "rejected_driver_ids": fb_firestore.ArrayUnion([locked_driver]) if locked_driver else [],
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    })
    except Exception:
        pass

    pending_query = (
        db.collection("pendingRideRequests")
        .where("status", "==", "pending")
        .order_by("createdAt", direction=fb_firestore.Query.ASCENDING)
        .limit(20)
    )

    try:
        docs = list(pending_query.stream())
    except Exception:  # noqa: BLE001
        return None

    for doc in docs:
        data = doc.to_dict() or {}
        req_id = doc.id

        # Skip if driver previously declined this pending request
        if driver_id in (data.get("rejected_driver_ids") or []):
            continue

        # Check TTL expiry
        expires_at = data.get("expiresAt")
        if expires_at:
            exp_time = (
                expires_at
                if isinstance(expires_at, datetime)
                else (datetime.fromtimestamp(expires_at.timestamp(), tz=timezone.utc) if hasattr(expires_at, "timestamp") else None)
            )
            if exp_time and now > exp_time:
                doc.reference.update({"status": "expired", "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                _log_demand_event(db, "pending_expired", {"requestId": req_id, "passengerId": data.get("passengerId")})
                continue

        # Check scheduled activation time (lead window: 15 minutes before activatesAt up to 2 hours after)
        activates_at = data.get("activatesAt")
        act_time = None
        if activates_at:
            act_time = _to_utc_datetime(activates_at)
            if act_time:
                if now < (act_time - timedelta(minutes=15)):
                    continue
                if now > (act_time + timedelta(hours=2)):
                    doc.reference.update({"status": "expired", "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                    continue

        # Check vehicle type match
        req_vehicle = str(data.get("vehicleType") or "").strip().lower()
        if req_vehicle and req_vehicle != "any" and req_vehicle != driver_type:
            continue

        # Check radius match
        pickup = data.get("pickup") or {}
        p_lat = pickup.get("lat")
        p_lng = pickup.get("lng")
        if p_lat is None or p_lng is None:
            continue

        search_radius_meters = float(data.get("searchRadius") or 5000.0)
        search_radius_km = search_radius_meters / 1000.0
        distance_km = _haversine_km(driver_lat, driver_lng, float(p_lat), float(p_lng))

        if distance_km > search_radius_km:
            continue

        mode = str(data.get("mode") or "notify_only").strip().lower()
        passenger_id = str(data.get("passengerId") or data.get("passenger_id") or "").strip()
        # Support both "drop" (new) and "dropoff" (legacy) field names
        drop = data.get("drop") or data.get("dropoff") or {}
        d_lat = drop.get("lat") or p_lat
        d_lng = drop.get("lng") or p_lng

        if mode in {"notify_only", "notify"}:
            doc.reference.update({
                "lastNotifiedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            _log_demand_event(db, "pending_matched_notify", {
                "requestId": req_id,
                "passengerId": passenger_id,
                "driverId": driver_id,
                "distanceKm": distance_km,
            })
            _send_passenger_push_and_inapp(
                db,
                passenger_id,
                "Driver Available Nearby!",
                f"An approved driver is now available near {pickup.get('name', 'your location')}. Tap to search now!",
                {
                    "url": f"{APP_BASE_URL}/services?restorePending={req_id}",
                    "type": "pending_driver_available",
                    "requestId": req_id,
                }
            )
            continue

        if mode == "schedule":
            # Schedule mode: only search AFTER scheduled activation time
            if not act_time or now < act_time:
                continue

            doc.reference.update({
                "lastNotifiedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            _log_demand_event(db, "pending_matched_schedule", {
                "requestId": req_id,
                "passengerId": passenger_id,
                "driverId": driver_id,
                "distanceKm": distance_km,
            })
            _send_passenger_push_and_inapp(
                db,
                passenger_id,
                "Driver Available for Scheduled Ride!",
                f"A driver is now available for your scheduled pickup near {pickup.get('name', 'your location')}. Tap to confirm and search.",
                {
                    "url": f"{APP_BASE_URL}/services?restorePending={req_id}",
                    "type": "pending_driver_available",
                    "requestId": req_id,
                }
            )
            continue

        if mode == "auto":
            # Create standard live ride document targeting this driver
            ride_ref = db.collection("rides").document()
            pending_ref = db.collection("pendingRideRequests").document(req_id)
            claimed = False

            @fb_firestore.transactional
            def claim_tx(tx):
                snap = pending_ref.get(transaction=tx)
                if not snap.exists:
                    return False
                curr = snap.to_dict() or {}
                if curr.get("status") != "pending" or curr.get("lockedByDriverId"):
                    return False
                if driver_id in (curr.get("rejected_driver_ids") or []):
                    return False
                
                update_fields = {
                    "status": "dispatching",
                    "rideId": ride_ref.id,
                    "lockedByDriverId": driver_id,
                    "dispatchLockedAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                }
                if curr.get("mode") == "schedule":
                    update_fields["mode"] = "auto"
                    update_fields["sourceMode"] = "schedule"
                    
                tx.update(pending_ref, update_fields)
                return True

            try:
                claimed = claim_tx(db.transaction())
            except Exception as e:
                claimed = False

            if not claimed:
                continue  # Another worker claimed it; gracefully evaluate next candidate

            service = RIDE_SERVICES.get(driver_type, RIDE_SERVICES["bike"])
            fare_amount = float(data.get("fare") or 0)
            ride_data = {
                "passenger_id": passenger_id,
                "passengerId": passenger_id,
                "passenger_name": str(data.get("passengerName") or "Passenger")[:80],
                "passenger_phone": str(data.get("passengerPhone") or "")[:40],
                "pickup_name": str(pickup.get("name") or "Pickup location")[:120],
                "drop_name": str(drop.get("name") or "Destination")[:120],
                "drop_full_address": str(drop.get("fullAddress") or "")[:240],
                "pickup_lat": float(p_lat),
                "pickup_lng": float(p_lng),
                "drop_lat": float(d_lat),
                "drop_lng": float(d_lng),
                "distance_km": round(float(data.get("distanceKm") or 0), 2),
                "duration_minutes": float(data.get("durationMinutes") or 0),
                "fare": fare_amount,
                "quoted_fare": fare_amount,
                "fare_original": fare_amount,
                "fare_base": service["base"],
                "fare_per_km": service["per_km"],
                "fare_min": service["min_fare"],
                "fare_is_night": service["is_night_fare"],
                "fare_requested_at": datetime.now(timezone.utc).isoformat(),
                "fare_currency": "INR",
                "vehicle_type": driver_type,
                "service_name": service["name"],
                "passenger_capacity": service["capacity"],
                "status": "pending",
                "sourceMode": data.get("sourceMode") or ("schedule" if data.get("mode") == "schedule" else "auto"),
                "pendingRequestId": req_id,
                "driver_id": None,
                "driver_name": None,
                "driver_phone": None,
                "vehicle_model": None,
                "vehicle_number": None,
                "payment_methods": ["cash", "upi"],
                "payment_status": "pending",
                "verification_pin": None,
                "eligible_driver_ids": [driver_id],
                "notified_driver_ids": [driver_id],
                "rejected_driver_ids": [],
                "dispatch_batch_size": 1,
                "dispatch_timeout_ms": 300000,
                "dispatch_total_candidates": 1,
                "dispatch_round": 1,
                "search_status": "searching_nearby_drivers",
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            }
            ride_ref.set(ride_data)
            pending_ref.update({"rideId": ride_ref.id})

            _log_demand_event(db, "pending_matched_auto", {
                "requestId": req_id,
                "rideId": ride_ref.id,
                "passengerId": passenger_id,
                "driverId": driver_id,
                "distanceKm": distance_km,
            })
            _send_passenger_push_and_inapp(
                db,
                passenger_id,
                "Driver Found!",
                f"We found a driver for your ride to {drop.get('name', 'Destination')}.",
                {"url": f"{APP_BASE_URL}/services", "type": "pending_matched_auto", "requestId": req_id, "rideId": ride_ref.id}
            )
            _send_driver_push_notification(
                db,
                driver_id,
                "New Ride Request!",
                f"Passenger: {data.get('passengerName', 'Rider')} - Pickup: {pickup.get('name', 'Pickup')}",
                {
                    "type": "NEW_PASSENGER_AVAILABLE",
                    "rideId": ride_ref.id,
                    "passengerName": str(data.get("passengerName") or "Rider"),
                    "pickupLocation": str(pickup.get("name") or "Pickup"),
                    "estimatedEarning": str(round(fare_amount)),
                    "url": f"{APP_BASE_URL}/driver?rideId={ride_ref.id}&from=push"
                }
            )
            return req_id

        elif mode == "notify_only":
            # Never dispatch to individual driver; only notify passenger
            doc.reference.update({
                "lastNotifiedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            _log_demand_event(db, "pending_matched_notify", {
                "requestId": req_id,
                "passengerId": passenger_id,
                "driverId": driver_id,
                "distanceKm": distance_km,
            })
            _send_passenger_push_and_inapp(
                db,
                passenger_id,
                "Driver Available Nearby",
                f"A driver is now available near {pickup.get('name', 'your location')}. Tap to book your ride.",
                {
                    "url": f"{APP_BASE_URL}/services?restorePending={req_id}",
                    "type": "pending_driver_available",
                    "requestId": req_id,
                }
            )

    return None




def activate_due_scheduled_requests(db) -> int:
    """Evaluates due scheduled requests starting after their activatesAt time."""
    now = datetime.now(timezone.utc)
    try:
        docs = list(
            db.collection("pendingRideRequests")
            .where("status", "==", "pending")
            .where("mode", "==", "schedule")
            .limit(50)
            .stream()
        )
    except Exception:
        return 0

    evaluated_count = 0
    for doc in docs:
        data = doc.to_dict() or {}
        activates_at = data.get("activatesAt")
        if not activates_at:
            continue
        act_time = _to_utc_datetime(activates_at)
        if not act_time:
            continue

        if now >= act_time:
            evaluated_count += 1
            # Check if 10 minutes pass after scheduled time with no driver match
            if now >= (act_time + timedelta(minutes=10)) and not data.get("scheduleTimedOut"):
                doc.reference.update({
                    "scheduleTimedOut": True,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                })
                _send_passenger_push_and_inapp(
                    db,
                    str(data.get("passengerId") or ""),
                    "Scheduled Ride Update",
                    "No driver found within 10 minutes of your scheduled time. Tap to update scheduled time by 15 minutes or cancel.",
                    {"url": f"{APP_BASE_URL}/services", "type": "schedule_timeout_prompt", "requestId": doc.id}
                )

    try:
        searching_drivers = list(db.collection("driverPresence").where("driverAvailability", "==", "searching").limit(20).stream())
        for d_doc in searching_drivers:
            d_data = d_doc.to_dict() or {}
            driver_uid = d_doc.id
            d_profile = db.collection("users").document(driver_uid).get().to_dict() or {}
            d_loc = d_data.get("driverLocation") or d_profile.get("driverLocation") or d_profile.get("location")
            if driver_uid and d_loc:
                _match_pending_requests_for_driver(db, driver_uid, d_profile, d_loc)
    except Exception as exc:
        print(f"Scheduled activation driver sweep error: {exc}")

    return evaluated_count


@router.post("/pending-request/{request_id}/reschedule-15min")
def reschedule_pending_request_15min(
    request_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Extends scheduled activatesAt time by 15 minutes for a pending scheduled ride request."""
    uid = str(user.get("uid") or "").strip()
    clean_id = request_id.strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    db = fb_firestore.client(get_admin_app())
    doc_ref = db.collection("pendingRideRequests").document(clean_id)
    doc_snap = doc_ref.get()
    if not doc_snap.exists:
        return {"ok": True, "status": "already_cancelled", "message": "Pending request not found."}

    data = doc_snap.to_dict() or {}
    if data.get("passengerId") != uid and data.get("passenger_id") != uid:
        raise ApiError("Only the passenger can update this scheduled request.", 403)

    now = datetime.now(timezone.utc)
    curr_activates = data.get("activatesAt")
    curr_dt = _to_utc_datetime(curr_activates) if curr_activates else now
    if not curr_dt or curr_dt < now:
        curr_dt = now

    new_activates_dt = curr_dt + timedelta(minutes=15)
    new_expires_dt = max(now + timedelta(seconds=PENDING_REQUEST_DEFAULT_TTL_SECONDS), new_activates_dt + timedelta(hours=2))

    doc_ref.update({
        "activatesAt": new_activates_dt,
        "expiresAt": new_expires_dt,
        "scheduleTimedOut": False,
        "lastNotifiedAt": None,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    _log_demand_event(db, "pending_rescheduled_15min", {"requestId": clean_id, "passengerId": uid})
    return {
        "ok": True,
        "requestId": clean_id,
        "status": "pending",
        "newActivatesAt": new_activates_dt.isoformat(),
    }


@router.post("/scheduled/activate-due")
def activate_scheduled_due_endpoint(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Background trigger to activate scheduled requests due within 10 minutes."""
    db = fb_firestore.client(get_admin_app())
    count = activate_due_scheduled_requests(db)
    return {"ok": True, "activatedCount": count}


@router.get("/cron/activate-scheduled")
@router.get("/scheduled/activate-due-cron")
def cron_activate_scheduled(request: Request) -> dict[str, Any]:
    """Cron endpoint called periodically (e.g. Vercel Cron) to promote scheduled rides."""
    cron_secret = os.getenv("CRON_SECRET", "").strip()
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization") or ""
    x_cron_header = request.headers.get("x-cron-secret") or request.headers.get("X-Cron-Secret") or ""
    
    if cron_secret:
        valid_auth = (auth_header == f"Bearer {cron_secret}") or (x_cron_header == cron_secret)
        if not valid_auth:
            raise ApiError("Unauthorized cron request.", 401)
            
    db = fb_firestore.client(get_admin_app())
    count = activate_due_scheduled_requests(db)
    
    # Trigger matching for active searching drivers against promoted schedule requests
    if count > 0:
        try:
            searching_drivers = list(db.collection("driverPresence").where("driverAvailability", "==", "searching").limit(20).stream())
            for doc in searching_drivers:
                d_data = doc.to_dict() or {}
                driver_uid = doc.id
                d_profile = db.collection("users").document(driver_uid).get().to_dict() or {}
                d_loc = d_data.get("driverLocation") or d_profile.get("driverLocation")
                if driver_uid and d_loc:
                    _match_pending_requests_for_driver(db, driver_uid, d_profile, d_loc)
        except Exception as exc:
            print(f"Cron matching sweep skipped: {exc}")

    return {"ok": True, "activatedCount": count}


@router.get("/driver/nearby-demand")
def get_driver_nearby_demand(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Return non-PII two-tier aggregate demand counts (Waiting Now & Scheduled Soon) for online drivers."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    db = fb_firestore.client(get_admin_app())
    profile = db.collection("users").document(uid).get().to_dict() or {}
    _require_approved_driver(profile, "Only approved drivers can view demand.")

    driver_loc = profile.get("driverLocation") or profile.get("location")
    if not driver_loc or "lat" not in driver_loc or "lng" not in driver_loc:
        return {
            "ok": True,
            "waitingCount": 0,
            "scheduledSoonCount": 0,
            "scheduledWindowLabel": "",
            "roughArea": ""
        }

    d_lat = float(driver_loc["lat"])
    d_lng = float(driver_loc["lng"])
    driver_type = _driver_type(profile)

    now = datetime.now(timezone.utc)
    next_hour = now + timedelta(hours=1)

    # Perform activation sweep on due scheduled requests
    activate_due_scheduled_requests(db)

    pending_docs = list(
        db.collection("pendingRideRequests")
        .where("status", "==", "pending")
        .limit(50)
        .stream()
    )

    waiting_count = 0
    scheduled_soon_count = 0
    rough_area = ""
    for doc in pending_docs:
        data = doc.to_dict() or {}
        mode = str(data.get("mode") or "notify_only").strip().lower()
        expires_at = data.get("expiresAt")
        if expires_at:
            exp_time = (
                expires_at
                if isinstance(expires_at, datetime)
                else (datetime.fromtimestamp(expires_at.timestamp(), tz=timezone.utc) if hasattr(expires_at, "timestamp") else None)
            )
            if exp_time and now > exp_time:
                continue

        pickup = data.get("pickup") or {}
        p_lat = pickup.get("lat")
        p_lng = pickup.get("lng")
        if p_lat is None or p_lng is None:
            continue

        req_vehicle = str(data.get("vehicleType") or "").strip().lower()
        if req_vehicle and req_vehicle != "any" and req_vehicle != driver_type:
            continue

        dist_km = _haversine_km(d_lat, d_lng, float(p_lat), float(p_lng))
        if dist_km <= 10.0:
            if mode == "schedule":
                activates_at = data.get("activatesAt")
                act_time = None
                if activates_at:
                    if isinstance(activates_at, datetime):
                        act_time = activates_at
                    else:
                        try:
                            act_time = datetime.fromisoformat(str(activates_at).replace("Z", "+00:00"))
                        except Exception:
                            act_time = None
                if act_time and now <= act_time <= next_hour:
                    scheduled_soon_count += 1
            else:
                waiting_count += 1
                if not rough_area:
                    rough_area = str(pickup.get("name") or "your area")

    # Build human-friendly scheduled time window label
    window_start = now.strftime("%I:%M %p").lstrip("0")
    window_end = next_hour.strftime("%I:%M %p").lstrip("0")
    scheduled_window_label = f"between {window_start} – {window_end}"

    return {
        "ok": True,
        "waitingCount": waiting_count,
        "scheduledSoonCount": scheduled_soon_count,
        "scheduledWindowLabel": scheduled_window_label,
        "roughArea": rough_area
    }


@router.post("/log-demand-event")
def log_client_demand_event(
    body: DemandEventBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Client event logger for search timeout, radius expansion, etc. (Feature 4.6)."""
    uid = str(user.get("uid") or "").strip()
    db = fb_firestore.client(get_admin_app())
    _log_demand_event(db, body.eventType, {
        "userId": uid or "anonymous",
        "pickupLat": body.pickupLat,
        "pickupLng": body.pickupLng,
        "vehicleType": body.vehicleType,
        "metadata": body.metadata or {},
    })
    return {"ok": True}


# ---------------------------------------------------------------------------
# Ride Feedback (Feature: Passenger Feedback System)
# ---------------------------------------------------------------------------

VALID_EXPERIENCES = {"poor", "decent", "good", "loved"}
MAX_FEEDBACK_REASONS = 3
MAX_REASON_LENGTH = 80

VALID_REASONS: dict[str, set[str]] = {
    "poor": {
        "driver_was_late", "driver_misbehaved", "driver_was_rude",
        "unsafe_driving", "vehicle_issue", "bad_app_experience",
        "app_glitches", "payment_issue", "booking_problem", "other",
    },
    "decent": {
        "driver_was_late", "long_waiting_time", "vehicle_could_be_better",
        "app_experience_could_improve", "booking_was_confusing",
        "payment_issue", "route_destination_issue", "other",
    },
    "good": {
        "friendly_driver", "smooth_ride", "quick_pickup", "easy_booking",
        "good_vehicle", "good_app_experience", "fair_price", "easy_payment",
    },
    "loved": {
        "excellent_driver", "very_smooth_ride", "quick_pickup",
        "great_vehicle", "easy_booking", "great_app_experience",
        "fair_price", "would_ride_again",
    },
}


class RideFeedbackBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experience: str = Field(..., description="One of: poor, decent, good, loved")
    reasons: list[str] = Field(default_factory=list, description="Up to 3 secondary reason keys")


@router.post("/{ride_id}/feedback")
def submit_ride_feedback(
    ride_id: str,
    body: RideFeedbackBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Submit ride-level passenger feedback for a completed ride.

    Feedback is stored as a nested ``feedback`` object on the ride document
    (``rides/{rideId}.feedback``).  This is NOT a driver rating — no driver
    profile is modified.

    Rules:
    - Ride must be in status ``completed``.
    - Caller must be the ride's ``passenger_id``.
    - Exactly one ``experience`` value must be supplied.
    - Up to ``MAX_FEEDBACK_REASONS`` secondary ``reasons`` may be supplied.
    - Reasons must be valid keys for the chosen experience level.
    - A ride can only receive one feedback record — re-submission returns 409.
    """
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authentication is required.", 401)

    experience = str(body.experience or "").strip().lower()
    if experience not in VALID_EXPERIENCES:
        raise ApiError(
            f"experience must be one of: {', '.join(sorted(VALID_EXPERIENCES))}.", 400
        )

    # Validate reasons
    reasons: list[str] = []
    seen: set[str] = set()
    valid_for_exp = VALID_REASONS[experience]
    for r in (body.reasons or []):
        key = str(r or "").strip().lower()[:MAX_REASON_LENGTH]
        if not key:
            continue
        if key not in valid_for_exp:
            raise ApiError(f"reason '{key}' is not valid for experience '{experience}'.", 400)
        if key in seen:
            continue
        seen.add(key)
        reasons.append(key)
        if len(reasons) >= MAX_FEEDBACK_REASONS:
            break

    clean_ride_id = str(ride_id or "").strip()
    if not clean_ride_id:
        raise ApiError("ride_id is required.", 400)

    db = fb_firestore.client(get_admin_app())
    ride_ref = db.collection("rides").document(clean_ride_id)

    try:
        snapshot = ride_ref.get()
        if not snapshot.exists:
            raise ApiError("Ride not found.", 404)

        ride = snapshot.to_dict() or {}

        # Authorisation: caller must be the passenger
        if str(ride.get("passenger_id") or "") != uid:
            raise ApiError("You are not authorised to submit feedback for this ride.", 403)

        # State guard: ride must be completed
        if ride.get("status") != "completed":
            raise ApiError("Feedback can only be submitted for completed rides.", 409)

        # Duplicate prevention
        existing_feedback = ride.get("feedback") or {}
        if existing_feedback.get("submitted") is True:
            raise ApiError("Feedback has already been submitted for this ride.", 409)

        # Store feedback as nested field on the ride document
        feedback_payload: dict[str, Any] = {
            "submitted": True,
            "submittedAt": fb_firestore.SERVER_TIMESTAMP,
            "experience": experience,
            "reasons": reasons,
            "passengerId": uid,
            "driverId": str(ride.get("driver_id") or ""),
            "rideId": clean_ride_id,
        }

        ride_ref.update({"feedback": feedback_payload})

        return {"ok": True, "rideId": clean_ride_id}

    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not submit feedback. Please try again.", 503)
