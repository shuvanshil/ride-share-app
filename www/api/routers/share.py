from __future__ import annotations

import math
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from firebase_admin import firestore as fb_firestore

from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.fare_policy import calculate_fare, get_service_fare_policy
from ..core.firebase import get_admin_app
from ..core.share_config import (
    SHARE_MAX_SEATS,
    SHARE_OFFER_TIMEOUT_S,
    SHARE_PICKUP_WAIT_S,
    calculate_share_fare,
    get_share_config_dict,
)
from ..core.share_routing import (
    find_optimal_share_route,
    recompute_shared_info_and_stops,
)

router = APIRouter(prefix="/share", tags=["share"])


def finalize_trip_if_done(trip_id: str, db: Any = None, tx: Any = None) -> bool:
    if not trip_id:
        return False
    if db is None:
        db = fb_firestore.client(get_admin_app())
    trip_ref = db.collection("shareTrips").document(trip_id)
    trip_snap = trip_ref.get(transaction=tx) if tx is not None else trip_ref.get()
    if not trip_snap.exists:
        return False
    trip_data = trip_snap.to_dict() or {}
    if trip_data.get("status") in {"completed", "cancelled"}:
        return False
    remote_on_board = int(trip_data.get("remoteOnBoard") or 0)
    if remote_on_board > 0:
        return False
    child_ids = trip_data.get("childRideIds") or []
    terminal_statuses = {
        "completed",
        "cancelled",
        "cancelled_by_driver",
        "cancelled_by_passenger",
        "no_show",
    }
    for cid in child_ids:
        c_snap = (
            db.collection("rides").document(cid).get(transaction=tx)
            if tx is not None
            else db.collection("rides").document(cid).get()
        )
        if c_snap.exists:
            c_status = (c_snap.to_dict() or {}).get("status")
            if c_status not in terminal_statuses:
                return False

    update_payload = {
        "status": "completed",
        "seatsUsed": 0,
        "endedAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    if tx is not None:
        tx.update(trip_ref, update_payload)
    else:
        trip_ref.update(update_payload)
    return True


def _sync_driver_availability_after_trip(db: Any, uid: str) -> None:
    if not uid or db is None:
        return
    try:
        open_share_trips = []
        try:
            open_share_trips = list(
                db.collection("shareTrips")
                .where("driverId", "==", uid)
                .where("status", "in", ["to_pickup", "active"])
                .limit(1)
                .stream()
            )
        except Exception:
            for doc_snap in db.collection("shareTrips").where("driverId", "==", uid).stream():
                t_data = doc_snap.to_dict() or {}
                if t_data.get("status") in {"to_pickup", "active"}:
                    open_share_trips.append(doc_snap)
        if not open_share_trips:
            profile = db.collection("users").document(uid).get().to_dict() or {}
            from .rides import _build_driver_availability_updates, _match_pending_requests_for_driver
            availability_status = "offline"
            if (
                str(profile.get("desiredAvailability") or "").strip().lower() != "offline"
                and str(profile.get("driverAvailability") or "").strip().lower() != "offline"
            ):
                availability_status = "searching"
            user_update, presence_update, map_presence_update = _build_driver_availability_updates(availability_status, profile)
            db.collection("users").document(uid).set(user_update, merge=True)
            db.collection("driverPresence").document(uid).set(presence_update, merge=True)
            db.collection("driverMapPresence").document(uid).set(map_presence_update, merge=True)
            if availability_status == "searching":
                _match_pending_requests_for_driver(
                    db, uid, profile, profile.get("driverLocation") or profile.get("location")
                )
    except Exception:
        pass


@router.get("/config")
def get_share_config() -> dict[str, Any]:
    return {"ok": True, "config": get_share_config_dict()}


@router.get("/quote")
def get_share_quote(
    distanceMeters: Optional[float] = Query(None),
    distanceKm: Optional[float] = Query(None),
) -> dict[str, Any]:
    meters = 0.0
    if distanceMeters is not None and math.isfinite(distanceMeters):
        meters = max(0.0, float(distanceMeters))
    elif distanceKm is not None and math.isfinite(distanceKm):
        meters = max(0.0, float(distanceKm) * 1000.0)

    dist_km = meters / 1000.0
    now = datetime.now(timezone.utc)
    auto_service = get_service_fare_policy("auto", now)
    normal_auto_fare = calculate_fare(auto_service, dist_km) if auto_service else 0
    share_fare = calculate_share_fare(meters)

    return {
        "ok": True,
        "distanceMeters": int(round(meters)),
        "distanceKm": round(dist_km, 2),
        "normalFare": int(normal_auto_fare),
        "shareFare": int(share_fare),
    }


@router.post("/offers/{ride_id}/accept")
def accept_share_offer(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_ride_id = ride_id.strip()
    db = fb_firestore.client(get_admin_app())

    ride_ref = db.collection("rides").document(clean_ride_id)
    ride_snap = ride_ref.get()
    if not ride_snap.exists:
        raise ApiError("Ride request not found.", 404)
    ride = ride_snap.to_dict() or {}

    if ride.get("driver_id") == uid and ride.get("status") == "accepted":
        return {
            "ok": True,
            "alreadyAccepted": True,
            "rideId": clean_ride_id,
            "sharedInfo": ride.get("sharedInfo", {}),
        }

    if ride.get("status") != "pending" or (ride.get("driver_id") and ride.get("driver_id") != uid):
        raise ApiError("Ride request is no longer available.", 409)

    parent_docs = []
    try:
        parent_docs = list(
            db.collection("shareTrips")
            .where("driverId", "==", uid)
            .where("status", "in", ["active", "to_pickup"])
            .limit(1)
            .stream()
        )
    except Exception:
        for doc_snap in db.collection("shareTrips").where("driverId", "==", uid).stream():
            t_data = doc_snap.to_dict() or {}
            if t_data.get("status") in {"active", "to_pickup"}:
                parent_docs.append(doc_snap)
                break
    if not parent_docs:
        raise ApiError("Active shared trip not found for driver.", 404)

    parent_doc = parent_docs[0]
    parent_trip = parent_doc.to_dict() or {}
    parent_trip_id = parent_doc.id

    current_seats = int(parent_trip.get("seatsUsed") or 0)
    if current_seats >= SHARE_MAX_SEATS:
        raise ApiError("No available seats on current trip.", 400)

    user_doc = db.collection("users").document(uid).get()
    profile = user_doc.to_dict() or {}

    driver_loc = profile.get("driverLocation") or {}
    if not driver_loc:
        presence_doc = db.collection("driverPresence").document(uid).get()
        if presence_doc.exists:
            driver_loc = presence_doc.to_dict().get("driverLocation") or {}
    d_lat = float(driver_loc.get("lat") or ride.get("pickup_lat") or 0.0)
    d_lng = float(driver_loc.get("lng") or ride.get("pickup_lng") or 0.0)
    driver_pos = (d_lat, d_lng)

    child_ids = list(parent_trip.get("childRideIds") or [])
    existing_child_rides = []
    for cid in child_ids:
        c_doc = db.collection("rides").document(cid).get()
        if c_doc.exists:
            c_dict = c_doc.to_dict() or {}
            c_dict["ride_id"] = cid
            existing_child_rides.append(c_dict)

    candidate_pickup = {
        "rideId": clean_ride_id,
        "kind": "pickup",
        "passengerName": str(ride.get("passenger_name") or "Passenger")[:80],
        "name": str(ride.get("pickup_name") or "Pickup")[:200],
        "lat": ride.get("pickup_lat"),
        "lng": ride.get("pickup_lng"),
        "status": "pending",
    }
    candidate_drop = {
        "rideId": clean_ride_id,
        "kind": "drop",
        "passengerName": str(ride.get("passenger_name") or "Passenger")[:80],
        "name": str(ride.get("drop_name") or "Destination")[:200],
        "lat": ride.get("drop_lat"),
        "lng": ride.get("drop_lng"),
        "status": "pending",
    }

    candidate_ride_dict = dict(ride)
    candidate_ride_dict["ride_id"] = clean_ride_id
    candidate_ride_dict["seatOrder"] = current_seats + 1

    all_child_rides = existing_child_rides + [candidate_ride_dict]

    pending_stops = [
        s for s in parent_trip.get("stopOrder", []) if s.get("status") != "completed"
    ]
    candidate_stops = [candidate_pickup, candidate_drop]

    baseline_etas: dict[str, str] = {}
    for cr in existing_child_rides:
        cid = str(cr.get("ride_id") or "")
        b = cr.get("baselineEtaIso") or (cr.get("sharedInfo") or {}).get("baselineEtaIso")
        if cid and b:
            baseline_etas[cid] = str(b)

    opt_route = find_optimal_share_route(
        driver_pos, pending_stops, baseline_etas, candidate_stops=candidate_stops
    )
    if opt_route is None or not opt_route.get("valid"):
        raise ApiError("Cannot add ride: exceeds detour threshold.", 400)

    candidate_drop_eta = opt_route["drop_etas"].get(clean_ride_id)
    cand_baseline_eta_iso = (
        candidate_drop_eta.isoformat()
        if candidate_drop_eta
        else datetime.now(timezone.utc).isoformat()
    )
    candidate_ride_dict["baselineEtaIso"] = cand_baseline_eta_iso

    updated_parent_trip = dict(parent_trip)
    updated_parent_trip["stopOrder"] = [
        s for s in parent_trip.get("stopOrder", []) if s.get("status") == "completed"
    ] + opt_route["stops"]
    updated_parent_trip["seatsUsed"] = current_seats + 1

    full_stops, shared_info_map = recompute_shared_info_and_stops(
        driver_pos, updated_parent_trip, all_child_rides
    )

    verification_pin = f"{secrets.randbelow(9000) + 1000:04d}"

    new_child_ids = child_ids + [clean_ride_id]
    parent_doc.reference.update({
        "childRideIds": new_child_ids,
        "seatsUsed": current_seats + 1,
        "stopOrder": full_stops,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    cand_shared_info = shared_info_map.get(clean_ride_id, {})
    ride_ref.update({
        "status": "accepted",
        "driver_id": uid,
        "driver_name": str(profile.get("name") or "Driver")[:80],
        "driver_phone": str(profile.get("phone") or "")[:40],
        "driver_profile_photo": profile.get("profile_photo") or profile.get("profilePhoto"),
        "vehicle_model": str(
            profile.get("vehicle_model")
            or profile.get("vehicleModel")
            or "Registered Auto"
        )[:100],
        "vehicle_number": str(
            profile.get("vehicle_number")
            or profile.get("vehicleNumber")
            or "Vehicle number pending"
        )[:60],
        "vehicle_type": "auto",
        "verification_pin": verification_pin,
        "parentTripId": parent_trip_id,
        "seatOrder": current_seats + 1,
        "baselineEtaIso": cand_baseline_eta_iso,
        "sharedInfo": cand_shared_info,
        "acceptedAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    for cr in existing_child_rides:
        cid = str(cr.get("ride_id") or "")
        if cid and cid in shared_info_map:
            db.collection("rides").document(cid).update({
                "sharedInfo": shared_info_map[cid],
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })
            p_id = cr.get("passenger_id")
            if p_id:
                try:
                    from .rides import _send_passenger_push_and_inapp

                    _send_passenger_push_and_inapp(
                        db,
                        p_id,
                        "Passenger Joined",
                        "A new passenger joined your shared route.",
                        {
                            "type": "share_update",
                            "rideId": cid,
                            "parentTripId": parent_trip_id,
                        },
                    )
                except Exception:
                    pass

    return {
        "ok": True,
        "rideId": clean_ride_id,
        "parentTripId": parent_trip_id,
        "sharedInfo": cand_shared_info,
    }


@router.post("/offers/{ride_id}/decline")
def decline_share_offer(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_ride_id = ride_id.strip()
    db = fb_firestore.client(get_admin_app())
    ride_ref = db.collection("rides").document(clean_ride_id)
    ride_snap = ride_ref.get()
    if not ride_snap.exists:
        return {"ok": True, "declined": True}

    ride = ride_snap.to_dict() or {}
    rejected = list(ride.get("rejected_driver_ids") or [])
    if uid not in rejected:
        rejected.append(uid)

    priority_drivers = list(ride.get("priority_driver_ids") or [])
    next_driver_id = None
    for pd in priority_drivers:
        if pd not in rejected:
            next_driver_id = pd
            break

    now = datetime.now(timezone.utc)
    if next_driver_id:
        ride_ref.update({
            "rejected_driver_ids": rejected,
            "current_offer_driver_id": next_driver_id,
            "eligible_driver_ids": [next_driver_id],
            "offer_expires_at": (
                now + timedelta(seconds=SHARE_OFFER_TIMEOUT_S)
            ).isoformat(),
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        })
        try:
            from .rides import _send_driver_push_notification

            _send_driver_push_notification(
                db,
                next_driver_id,
                "Share Ride Add-on",
                f"Shared Ride Add-on: {ride.get('pickup_name')} -> {ride.get('drop_name')}",
                {
                    "type": "share_addon",
                    "rideId": clean_ride_id,
                    "rideType": "share",
                    "fare": str(ride.get("fare") or 0),
                },
            )
        except Exception:
            pass
    else:
        from .rides import (
            DISPATCH_BATCH_SIZE,
            _available_drivers,
            _send_driver_push_notification,
        )

        p_lat = float(ride.get("pickup_lat") or 0.0)
        p_lng = float(ride.get("pickup_lng") or 0.0)
        auto_drivers = _available_drivers(db, p_lat, p_lng, "auto")
        first_batch = [d["uid"] for d in auto_drivers[:DISPATCH_BATCH_SIZE]]
        ride_ref.update({
            "rejected_driver_ids": rejected,
            "current_offer_driver_id": None,
            "eligible_driver_ids": first_batch,
            "notified_driver_ids": first_batch,
            "dispatch_mode": "auto_share",
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        })
        for d_id in first_batch:
            try:
                _send_driver_push_notification(
                    db,
                    d_id,
                    "Share Ride request",
                    f"Shared Ride: {ride.get('pickup_name')} -> {ride.get('drop_name')} (₹{ride.get('fare')})",
                    {
                        "type": "share_ride",
                        "rideId": clean_ride_id,
                        "rideType": "share",
                        "fare": str(ride.get("fare") or 0),
                    },
                )
            except Exception:
                pass

    return {"ok": True, "declined": True}


@router.post("/trips/{trip_id}/remote/add")
def add_remote_passenger(
    trip_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_trip_id = trip_id.strip()
    db = fb_firestore.client(get_admin_app())
    trip_ref = db.collection("shareTrips").document(clean_trip_id)
    trip_snap = trip_ref.get()
    if not trip_snap.exists:
        raise ApiError("Trip not found.", 404)

    trip = trip_snap.to_dict() or {}
    if trip.get("driverId") != uid:
        raise ApiError("Unauthorized.", 403)

    if trip.get("status") not in {"active", "to_pickup"}:
        raise ApiError("Remote passengers can only be added when trip is active.", 400)

    seats_used = int(trip.get("seatsUsed") or 0)
    if seats_used >= SHARE_MAX_SEATS:
        raise ApiError("No seats available.", 400)

    remote_seq = int(trip.get("remoteSeq") or 0) + 1
    remote_on_board = int(trip.get("remoteOnBoard") or 0) + 1
    new_seats_used = seats_used + 1
    label = f"Remote passenger {remote_seq}"

    trip_ref.update({
        "remoteSeq": remote_seq,
        "remoteOnBoard": remote_on_board,
        "seatsUsed": new_seats_used,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    child_ids = trip.get("childRideIds") or []
    for cid in child_ids:
        c_ref = db.collection("rides").document(cid)
        c_snap = c_ref.get()
        if c_snap.exists:
            c_data = c_snap.to_dict() or {}
            s_info = dict(c_data.get("sharedInfo") or {})
            s_info["seatsOccupied"] = new_seats_used
            s_info["ridersOnboard"] = int(s_info.get("ridersOnboard") or 1) + 1
            other_riders = max(0, new_seats_used - 1)
            del_val = int(s_info.get("delayMin") or 0)
            if del_val > 0 and other_riders > 0:
                s_info["message"] = (
                    f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''} • +{del_val} min detour"
                )
            elif other_riders > 0:
                s_info["message"] = (
                    f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''}"
                )
            else:
                s_info["message"] = "Direct route"
            c_ref.update({
                "sharedInfo": s_info,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })

    return {
        "ok": True,
        "label": label,
        "seatsUsed": new_seats_used,
        "remoteOnBoard": remote_on_board,
    }


@router.post("/trips/{trip_id}/remote/drop")
def drop_remote_passenger(
    trip_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_trip_id = trip_id.strip()
    db = fb_firestore.client(get_admin_app())
    trip_ref = db.collection("shareTrips").document(clean_trip_id)
    trip_snap = trip_ref.get()
    if not trip_snap.exists:
        raise ApiError("Trip not found.", 404)

    trip = trip_snap.to_dict() or {}
    if trip.get("driverId") != uid:
        raise ApiError("Unauthorized.", 403)

    remote_on_board = int(trip.get("remoteOnBoard") or 0)
    if remote_on_board <= 0:
        raise ApiError("No remote passengers on board.", 400)

    new_remote_on_board = remote_on_board - 1
    new_seats_used = max(0, int(trip.get("seatsUsed") or 1) - 1)

    trip_ref.update({
        "remoteOnBoard": new_remote_on_board,
        "seatsUsed": new_seats_used,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    child_ids = trip.get("childRideIds") or []
    for cid in child_ids:
        c_ref = db.collection("rides").document(cid)
        c_snap = c_ref.get()
        if c_snap.exists:
            c_data = c_snap.to_dict() or {}
            s_info = dict(c_data.get("sharedInfo") or {})
            s_info["seatsOccupied"] = new_seats_used
            s_info["ridersOnboard"] = max(0, int(s_info.get("ridersOnboard") or 1) - 1)
            other_riders = max(0, new_seats_used - 1)
            del_val = int(s_info.get("delayMin") or 0)
            if del_val > 0 and other_riders > 0:
                s_info["message"] = (
                    f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''} • +{del_val} min detour"
                )
            elif other_riders > 0:
                s_info["message"] = (
                    f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''}"
                )
            else:
                s_info["message"] = "Direct route"
            c_ref.update({
                "sharedInfo": s_info,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })

    finalize_trip_if_done(clean_trip_id, db)
    _sync_driver_availability_after_trip(db, uid)

    return {
        "ok": True,
        "seatsUsed": new_seats_used,
        "remoteOnBoard": new_remote_on_board,
    }


@router.post("/trips/{trip_id}/cancel")
def cancel_share_trip(
    trip_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_trip_id = trip_id.strip()
    db = fb_firestore.client(get_admin_app())
    trip_ref = db.collection("shareTrips").document(clean_trip_id)
    trip_snap = trip_ref.get()
    if not trip_snap.exists:
        raise ApiError("Trip not found.", 404)
    trip = trip_snap.to_dict() or {}
    if trip.get("driverId") != uid:
        raise ApiError("Unauthorized.", 403)

    child_ids = list(trip.get("childRideIds") or [])
    for cid in child_ids:
        c_ref = db.collection("rides").document(cid)
        c_snap = c_ref.get()
        if c_snap.exists:
            c_data = c_snap.to_dict() or {}
            c_status = c_data.get("status")
            if c_status in {"pending", "accepted", "arrived"}:
                c_ref.update({
                    "status": "cancelled_by_driver",
                    "cancellationReason": "Driver cancelled shared trip",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                })
            elif c_status in {"started", "en_route"}:
                c_ref.update({
                    "status": "completed",
                    "completedAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                })

    trip_ref.update({
        "status": "cancelled",
        "seatsUsed": 0,
        "remoteOnBoard": 0,
        "endedAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    _sync_driver_availability_after_trip(db, uid)

    return {"ok": True, "tripId": clean_trip_id, "status": "cancelled"}


@router.post("/rides/{ride_id}/skip")
def skip_no_show_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_ride_id = ride_id.strip()
    db = fb_firestore.client(get_admin_app())
    ride_ref = db.collection("rides").document(clean_ride_id)
    ride_snap = ride_ref.get()
    if not ride_snap.exists:
        raise ApiError("Ride request not found.", 404)
    ride = ride_snap.to_dict() or {}
    if ride.get("driver_id") != uid:
        raise ApiError("Unauthorized.", 403)
    if ride.get("status") != "arrived":
        raise ApiError("Can only skip after arriving at pickup.", 400)

    arrived_at = ride.get("arrivedAt")
    if not arrived_at:
        raise ApiError("Driver arrival time not recorded.", 400)

    if isinstance(arrived_at, datetime):
        arrived_dt = arrived_at
    elif hasattr(arrived_at, "timestamp"):
        arrived_dt = datetime.fromtimestamp(arrived_at.timestamp(), tz=timezone.utc)
    else:
        try:
            arrived_dt = datetime.fromisoformat(str(arrived_at).replace("Z", "+00:00"))
        except Exception:
            raise ApiError("Invalid arrival time.", 400)

    if arrived_dt.tzinfo is None:
        arrived_dt = arrived_dt.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    elapsed_s = (now - arrived_dt).total_seconds()
    if elapsed_s < SHARE_PICKUP_WAIT_S:
        raise ApiError(
            f"Must wait at least {SHARE_PICKUP_WAIT_S} seconds before skipping no-show passenger.",
            400,
        )

    ride_ref.update({
        "status": "no_show",
        "cancellation_reason": "no_show",
        "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    parent_trip_id = ride.get("parentTripId")
    if parent_trip_id:
        parent_ref = db.collection("shareTrips").document(parent_trip_id)
        p_snap = parent_ref.get()
        if p_snap.exists:
            p_data = p_snap.to_dict() or {}
            child_ids = p_data.get("childRideIds") or []
            stop_order = [
                s
                for s in (p_data.get("stopOrder") or [])
                if s.get("rideId") != clean_ride_id
            ]
            active_child_rides = []
            for cid in child_ids:
                if cid != clean_ride_id:
                    c_doc = db.collection("rides").document(cid).get()
                    if c_doc.exists:
                        c_dict = c_doc.to_dict() or {}
                        if c_dict.get("status") in {
                            "accepted",
                            "arrived",
                            "started",
                            "en_route",
                        }:
                            c_dict["ride_id"] = cid
                            active_child_rides.append(c_dict)

            remote_count = int(p_data.get("remoteOnBoard") or 0)
            new_seats = max(0, len(active_child_rides) + remote_count)

            user_doc = db.collection("users").document(uid).get()
            profile = user_doc.to_dict() or {}
            driver_loc = profile.get("driverLocation") or {}
            d_pos = (
                float(driver_loc.get("lat") or 0.0),
                float(driver_loc.get("lng") or 0.0),
            )

            updated_p_trip = dict(p_data)
            updated_p_trip["stopOrder"] = stop_order
            updated_p_trip["seatsUsed"] = new_seats

            full_stops, shared_info_map = recompute_shared_info_and_stops(
                d_pos, updated_p_trip, active_child_rides
            )

            parent_ref.update({
                "seatsUsed": new_seats,
                "stopOrder": full_stops,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            })

            for acr in active_child_rides:
                cid = acr["ride_id"]
                if cid in shared_info_map:
                    db.collection("rides").document(cid).update({
                        "sharedInfo": shared_info_map[cid],
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    })

            finalize_trip_if_done(parent_trip_id, db)

    return {"ok": True, "rideId": clean_ride_id, "status": "no_show"}


@router.get("/trips/{trip_id}")
def get_share_trip(
    trip_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    clean_trip_id = trip_id.strip()
    db = fb_firestore.client(get_admin_app())
    trip_ref = db.collection("shareTrips").document(clean_trip_id)
    trip_snap = trip_ref.get()
    if not trip_snap.exists:
        raise ApiError("Trip not found.", 404)

    trip_data = trip_snap.to_dict() or {}
    if trip_data.get("status") in {"active", "to_pickup"}:
        if finalize_trip_if_done(clean_trip_id, db):
            trip_snap = trip_ref.get()
            trip_data = trip_snap.to_dict() or {}

    return {"ok": True, "trip": trip_data}
