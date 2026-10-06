"""Periodic sweeper maintaining pool health, timeouts, scheduled rides, and outbox delivery."""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_NOTIFICATIONS,
    COLLECTION_NOTIFY_ME,
    COLLECTION_SCHEDULED,
    COLLECTION_WPP,
    DEFAULT_SEARCH_RADIUS_KM,
    DRIVER_STALE_TIMEOUT_SEC,
    LOCK_REPAIR_TIMEOUT_SEC,
    MAX_WAIT_PASSENGER_SEC,
    OFFER_TIMEOUT_SEC,
)
from ..core.config import get_env
from .pools import DispatchPoolManager
from .runner import nudge_dispatch, run_dispatch

APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


def sweep_stale_drivers(db: Any, now: float) -> int:
    """Demote drivers whose GPS heartbeat / last_seen has lapsed past DRIVER_STALE_TIMEOUT_SEC."""
    if not db:
        return 0
    demoted = 0
    try:
        stream = db.collection(COLLECTION_DAP).where("state", "in", ["IDLE", "SHARE_OPEN"]).stream()
        for doc in stream:
            data = doc.to_dict() or {}
            last_seen = float(data.get("last_seen") or 0.0)
            if (now - last_seen) > DRIVER_STALE_TIMEOUT_SEC:
                doc.reference.update({
                    "state": "STALE",
                    "updated_at": now,
                })
                DispatchPoolManager.log_event(
                    db,
                    event_type="driver_swept_stale",
                    actor_id=doc.id,
                    details={"elapsed_sec": now - last_seen},
                )
                demoted += 1
    except Exception as exc:
        print(f"Sweep stale drivers error: {exc}", file=sys.stderr)
    return demoted


def sweep_expired_offers(db: Any, now: float) -> int:
    """Revert passengers and drivers stuck in OFFERED state past their offer timeout."""
    if not db:
        return 0
    expired = 0
    try:
        # Check expired passenger offers in WPP
        p_stream = db.collection(COLLECTION_WPP).where("state", "==", "OFFERED").stream()
        for doc in p_stream:
            data = doc.to_dict() or {}
            offer_exp = float(data.get("offer_expires_at") or 0.0)
            if offer_exp > 0 and now >= offer_exp:
                offered_driver = data.get("current_offer_driver_id")
                banned_drivers = list(data.get("banned") or [])
                if offered_driver and offered_driver not in banned_drivers:
                    banned_drivers.append(offered_driver)

                doc.reference.update({
                    "state": "WAITING",
                    "current_offer_driver_id": None,
                    "offer_expires_at": None,
                    "banned": banned_drivers,
                    "updated_at": now,
                })
                expired += 1

                # Revert driver as well if still offered
                if offered_driver:
                    try:
                        d_ref = db.collection(COLLECTION_DAP).document(offered_driver)
                        d_snap = d_ref.get()
                        if d_snap.exists:
                            d_dict = d_snap.to_dict() or {}
                            if d_dict.get("state") == "OFFERED":
                                prev_pool = d_dict.get("pool")
                                new_st = "SHARE_OPEN" if prev_pool == "SHARE" else "IDLE"
                                d_ref.update({
                                    "state": new_st,
                                    "current_offer_passenger_id": None,
                                    "offer_expires_at": None,
                                    "updated_at": now,
                                })
                    except Exception:
                        pass

                # Clean up linked ride and pending request if present
                ride_id = data.get("ride_id")
                if ride_id:
                    try:
                        r_ref = db.collection("rides").document(str(ride_id))
                        r_snap = r_ref.get()
                        if r_snap.exists:
                            r_data = r_snap.to_dict() or {}
                            if r_data.get("status") == "pending" and (
                                not offered_driver or r_data.get("current_offer_driver_id") == offered_driver
                            ):
                                rej = list(r_data.get("rejected_driver_ids") or [])
                                if offered_driver and offered_driver not in rej:
                                    rej.append(offered_driver)
                                r_ref.update({
                                    "current_offer_driver_id": None,
                                    "search_status": "searching_nearby_drivers",
                                    "rejected_driver_ids": rej,
                                    "updatedAt": datetime.now(timezone.utc),
                                })
                    except Exception:
                        pass

                pending_req_id = data.get("pending_request_id")
                if pending_req_id:
                    try:
                        p_req_ref = db.collection("pendingRideRequests").document(str(pending_req_id))
                        p_req_snap = p_req_ref.get()
                        if p_req_snap.exists:
                            p_req_data = p_req_snap.to_dict() or {}
                            if p_req_data.get("status") == "dispatching" and (
                                not offered_driver or p_req_data.get("lockedByDriverId") == offered_driver
                            ):
                                p_rej = list(p_req_data.get("rejected_driver_ids") or [])
                                if offered_driver and offered_driver not in p_rej:
                                    p_rej.append(offered_driver)
                                p_req_ref.update({
                                    "status": "pending",
                                    "lockedByDriverId": None,
                                    "dispatchLockedAt": None,
                                    "rejected_driver_ids": p_rej,
                                    "updatedAt": datetime.now(timezone.utc),
                                })
                    except Exception:
                        pass

                DispatchPoolManager.update_assignment_state(
                    db,
                    passenger_id=doc.id,
                    driver_id=offered_driver,
                    new_state="expired",
                    event_type="offer_expired",
                    details={"reason": "sweeper_timeout", "elapsed_sec": now - offer_exp},
                )

        # Check driver offers that expired independently
        d_stream = db.collection(COLLECTION_DAP).where("state", "==", "OFFERED").stream()
        for doc in d_stream:
            data = doc.to_dict() or {}
            offer_exp = float(data.get("offer_expires_at") or 0.0)
            if offer_exp > 0 and now >= offer_exp:
                prev_pool = data.get("pool")
                new_st = "SHARE_OPEN" if prev_pool == "SHARE" else "IDLE"
                p_id = data.get("current_offer_passenger_id")
                doc.reference.update({
                    "state": new_st,
                    "current_offer_passenger_id": None,
                    "offer_expires_at": None,
                    "updated_at": now,
                })
                DispatchPoolManager.update_assignment_state(
                    db,
                    passenger_id=p_id,
                    driver_id=doc.id,
                    new_state="expired",
                    event_type="offer_expired",
                    details={"reason": "sweeper_timeout", "elapsed_sec": now - offer_exp},
                )
                expired += 1

        if expired > 0:
            nudge_dispatch(db)
    except Exception as exc:
        print(f"Sweep expired offers error: {exc}", file=sys.stderr)
    return expired


def sweep_max_wait_passengers(db: Any, now: float) -> int:
    """Handle passengers whose wait time exceeded MAX_WAIT_PASSENGER_SEC (25 min)."""
    if not db:
        return 0
    timed_out = 0
    try:
        p_stream = db.collection(COLLECTION_WPP).where("state", "==", "WAITING").stream()
        for doc in p_stream:
            data = doc.to_dict() or {}
            req_time = float(data.get("req_time") or 0.0)
            if req_time > 0 and (now - req_time) > MAX_WAIT_PASSENGER_SEC:
                # Mark as timeout in linked ride / pending request
                ride_id = data.get("ride_id")
                if ride_id:
                    try:
                        db.collection("rides").document(str(ride_id)).update({
                            "status": "timeout",
                            "updatedAt": now,
                        })
                    except Exception:
                        pass
                pending_id = data.get("pending_request_id")
                if pending_id:
                    try:
                        db.collection("pendingRideRequests").document(str(pending_id)).update({
                            "status": "expired",
                            "updatedAt": now,
                        })
                    except Exception:
                        pass

                doc.reference.delete()
                DispatchPoolManager.log_event(
                    db,
                    event_type="passenger_max_wait_timeout",
                    actor_id=doc.id,
                    details={"wait_seconds": now - req_time},
                )
                if doc.id:
                    DispatchPoolManager.enqueue_notification(
                        db,
                        recipient_id=doc.id,
                        recipient_role="passenger",
                        notif_type="ride_timeout",
                        title="Ride Search Timed Out",
                        body="No drivers became available in time for your ride request.",
                        data={
                            "requestId": str(pending_id or ""),
                            "rideId": str(ride_id or ""),
                            "type": "ride_timeout",
                            "url": f"{APP_BASE_URL}/services",
                        },
                    )
                timed_out += 1
    except Exception as exc:
        print(f"Sweep max wait passengers error: {exc}", file=sys.stderr)
    return timed_out


def sweep_outbox_notifications(db: Any, now: float) -> int:
    """Deliver queued notifications from dispatchNotifications via Firebase Messaging."""
    if not db:
        return 0
    sent_count = 0
    try:
        docs = list(
            db.collection(COLLECTION_NOTIFICATIONS)
            .where("status", "==", "pending")
            .limit(20)
            .stream()
        )
        for doc in docs:
            data = doc.to_dict() or {}
            recipient_id = data.get("recipient_id")
            recipient_role = data.get("recipient_role")
            title = data.get("title") or "LiphtUp Alert"
            body = data.get("body") or ""
            payload = data.get("data") or {}

            # Attempt to send through app push router / helper
            try:
                from ..routers.rides import _send_driver_push_notification, _send_passenger_push_and_inapp
                if recipient_role == "driver":
                    _send_driver_push_notification(db, recipient_id, title, body, payload)
                else:
                    _send_passenger_push_and_inapp(db, recipient_id, title, body, payload)
                
                doc.reference.update({
                    "status": "sent",
                    "sent_at": now,
                    "updated_at": now,
                })
                sent_count += 1
            except Exception as send_err:
                attempts = int(data.get("attempts") or 0) + 1
                doc.reference.update({
                    "attempts": attempts,
                    "status": "failed" if attempts >= 3 else "pending",
                    "last_error": str(send_err)[:200],
                    "updated_at": now,
                })
    except Exception as exc:
        pass
    return sent_count


def sweep_stuck_locks(db: Any, now: float) -> int:
    """Repair stuck distributed locks or orphaned leases older than LOCK_REPAIR_TIMEOUT_SEC."""
    if not db:
        return 0
    repaired = 0
    try:
        ctrl_ref = db.collection(COLLECTION_CONTROL).document("main")
        snap = ctrl_ref.get()
        if snap.exists:
            data = snap.to_dict() or {}
            holder = data.get("lease_holder")
            exp = float(data.get("lease_expires_at") or 0.0)
            if holder and (now - exp) > LOCK_REPAIR_TIMEOUT_SEC:
                ctrl_ref.update({
                    "lease_holder": None,
                    "lease_expires_at": 0.0,
                    "dirty": True,
                    "updated_at": now,
                })
                repaired += 1
    except Exception:
        pass
    return repaired


def _parse_ts(val: Any) -> float | None:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if hasattr(val, "timestamp"):
        return float(val.timestamp())
    if isinstance(val, str):
        try:
            return float(datetime.fromisoformat(val.replace("Z", "+00:00")).timestamp())
        except Exception:
            return None
    return None


def sweep_scheduled_rides(db: Any, now: float) -> int:
    """Release due scheduled rides to WPP (lead window: 15 min), and timeout unserved scheduled rides (>10 min past time)."""
    if not db:
        return 0
    handled = 0
    try:
        stream = db.collection(COLLECTION_SCHEDULED).where("status", "==", "pending").stream()
        for doc in stream:
            data = doc.to_dict() or {}
            act_ts = _parse_ts(data.get("activatesAt")) or _parse_ts(data.get("scheduledFor"))
            if not act_ts:
                continue

            # 1. Lead window: 15 minutes before scheduled departure time
            lead_window_sec = 15 * 60
            if now >= (act_ts - lead_window_sec):
                if not data.get("released_to_wpp"):
                    passenger_id = str(data.get("passengerId") or data.get("passenger_id") or "")
                    if passenger_id:
                        pickup = data.get("pickup") or {}
                        drop = data.get("drop") or data.get("dropoff") or {}
                        fare = float(data.get("fare") or 0.0)
                        veh_type = str(data.get("vehicleType") or "auto").strip().lower()
                        wants_share = str(data.get("rideType") or "").strip().lower() == "share" or veh_type == "share"
                        if veh_type == "share":
                            veh_type = "auto"
                        DispatchPoolManager.sync_passenger_wpp(
                            db=db,
                            passenger_id=passenger_id,
                            pickup=pickup,
                            drop=drop,
                            fare=fare,
                            vehicle_type=veh_type,
                            wants_share=wants_share,
                            seats=1,
                            mode="auto",
                            pending_request_id=doc.id,
                        )
                        doc.reference.update({
                            "released_to_wpp": True,
                            "released_at": now,
                            "updated_at": now,
                        })
                        DispatchPoolManager.log_event(
                            db,
                            event_type="scheduled_ride_released_wpp",
                            actor_id=passenger_id,
                            details={"scheduled_request_id": doc.id, "activates_at": act_ts},
                        )
                        handled += 1

            # 2. Check timeout: 10 minutes past scheduled time without driver match
            if now >= (act_ts + 600) and not data.get("scheduleTimedOut"):
                passenger_id = str(data.get("passengerId") or data.get("passenger_id") or "")
                doc.reference.update({
                    "scheduleTimedOut": True,
                    "status": "schedule_timed_out",
                    "updated_at": now,
                })
                try:
                    db.collection("pendingRideRequests").document(doc.id).update({
                        "scheduleTimedOut": True,
                        "status": "schedule_timed_out",
                        "updatedAt": now,
                    })
                except Exception:
                    pass
                if passenger_id:
                    DispatchPoolManager.enqueue_notification(
                        db,
                        recipient_id=passenger_id,
                        recipient_role="passenger",
                        notif_type="scheduled_timeout",
                        title="Scheduled Ride Update",
                        body="We are actively searching, but no driver has accepted your scheduled ride yet. We will keep trying.",
                        data={
                            "requestId": doc.id,
                            "type": "scheduled_timeout",
                            "url": f"{APP_BASE_URL}/services?restorePending={doc.id}",
                        },
                    )
                handled += 1

            # 3. Hard expiry: 2 hours after scheduled time
            if now >= (act_ts + 7200):
                doc.reference.update({"status": "expired", "updated_at": now})
                try:
                    db.collection("pendingRideRequests").document(doc.id).update({"status": "expired", "updatedAt": now})
                except Exception:
                    pass
                passenger_id = str(data.get("passengerId") or data.get("passenger_id") or "")
                if passenger_id:
                    DispatchPoolManager.remove_passenger_wpp(db, passenger_id, reason="scheduled_expired")
                handled += 1

    except Exception as exc:
        print(f"Sweep scheduled rides error: {exc}", file=sys.stderr)
    return handled


def sweep_notify_me(db: Any, now: float) -> int:
    """Evaluate notify-me requests for nearby available drivers and expire past-TTL entries."""
    if not db:
        return 0
    handled = 0
    try:
        from .engine.geo import haversine_km
        stream = db.collection(COLLECTION_NOTIFY_ME).where("status", "==", "pending").stream()
        for doc in stream:
            data = doc.to_dict() or {}
            passenger_id = str(data.get("passengerId") or data.get("passenger_id") or "")
            expires_at = _parse_ts(data.get("expiresAt"))

            # 1. TTL expiry check
            if expires_at and now > expires_at:
                doc.reference.update({"status": "expired", "updated_at": now})
                try:
                    db.collection("pendingRideRequests").document(doc.id).update({"status": "expired", "updatedAt": now})
                except Exception:
                    pass
                handled += 1
                continue

            # 2. Check for nearby available driver if not already notified
            if not data.get("lastNotifiedAt"):
                pickup = data.get("pickup") or {}
                p_lat = pickup.get("lat")
                p_lng = pickup.get("lng")
                if p_lat is None or p_lng is None:
                    continue

                search_radius_m = float(data.get("searchRadius") or (DEFAULT_SEARCH_RADIUS_KM * 1000.0))
                search_radius_km = search_radius_m / 1000.0
                req_veh = str(data.get("vehicleType") or "auto").strip().lower()

                # Look for eligible drivers in DAP
                drivers_stream = db.collection(COLLECTION_DAP).where("state", "in", ["IDLE", "SHARE_OPEN"]).stream()
                matched_driver_id = None
                for d_doc in drivers_stream:
                    d_val = d_doc.to_dict() or {}
                    d_veh = str(d_val.get("vehicle_type") or "auto").strip().lower()
                    if req_veh != "any" and req_veh != d_veh and req_veh != "share":
                        continue
                    d_loc = d_val.get("loc") or {}
                    d_lat = d_loc.get("lat")
                    d_lng = d_loc.get("lng")
                    if d_lat is not None and d_lng is not None:
                        dist = haversine_km(float(d_lat), float(d_lng), float(p_lat), float(p_lng))
                        if dist <= search_radius_km:
                            matched_driver_id = d_doc.id
                            break

                # Fallback to driverPresence if DAP hasn't indexed the driver yet
                if not matched_driver_id:
                    try:
                        p_stream = db.collection("driverPresence").where("driverAvailability", "in", ["searching", "online"]).limit(20).stream()
                        for dp_doc in p_stream:
                            dp_val = dp_doc.to_dict() or {}
                            dp_loc = dp_val.get("driverLocation") or {}
                            dp_lat = dp_loc.get("lat")
                            dp_lng = dp_loc.get("lng")
                            if dp_lat is not None and dp_lng is not None:
                                dp_veh = str(dp_val.get("vehicle_type") or dp_val.get("vehicleType") or "auto").strip().lower()
                                if req_veh != "any" and req_veh != dp_veh and req_veh != "share":
                                    continue
                                dist = haversine_km(float(dp_lat), float(dp_lng), float(p_lat), float(p_lng))
                                if dist <= search_radius_km:
                                    matched_driver_id = dp_doc.id
                                    break
                    except Exception:
                        pass

                if matched_driver_id:
                    doc.reference.update({
                        "lastNotifiedAt": now,
                        "updated_at": now,
                    })
                    try:
                        db.collection("pendingRideRequests").document(doc.id).update({
                            "lastNotifiedAt": now,
                            "updatedAt": now,
                        })
                    except Exception:
                        pass
                    if passenger_id:
                        p_name = pickup.get("name") or "your location"
                        DispatchPoolManager.enqueue_notification(
                            db,
                            recipient_id=passenger_id,
                            recipient_role="passenger",
                            notif_type="pending_driver_available",
                            title="Driver Available Nearby!",
                            body=f"An approved driver is now available near {p_name}. Tap to search now!",
                            data={
                                "requestId": doc.id,
                                "type": "pending_driver_available",
                                "driverId": matched_driver_id,
                                "url": f"{APP_BASE_URL}/services?restorePending={doc.id}",
                            },
                        )
                    handled += 1

    except Exception as exc:
        print(f"Sweep notify-me error: {exc}", file=sys.stderr)
    return handled


def run_dispatch_sweeper(db: Any = None) -> dict[str, Any]:
    """Execute complete 10s pool sweeper pass."""
    now = time.time()
    stale_drivers = sweep_stale_drivers(db, now)
    expired_offers = sweep_expired_offers(db, now)
    max_wait = sweep_max_wait_passengers(db, now)
    scheduled_handled = sweep_scheduled_rides(db, now)
    notify_me_handled = sweep_notify_me(db, now)
    outbox_sent = sweep_outbox_notifications(db, now)
    stuck_locks = sweep_stuck_locks(db, now)

    # If any state was cleared or modified or scheduled ride released, trigger matching pass
    if expired_offers > 0 or stuck_locks > 0 or scheduled_handled > 0:
        run_dispatch(db, force=False)

    return {
        "ok": True,
        "stale_drivers_demoted": stale_drivers,
        "expired_offers_reverted": expired_offers,
        "max_wait_timed_out": max_wait,
        "scheduled_rides_handled": scheduled_handled,
        "notify_me_handled": notify_me_handled,
        "outbox_notifications_sent": outbox_sent,
        "stuck_locks_repaired": stuck_locks,
        "timestamp": now,
    }
