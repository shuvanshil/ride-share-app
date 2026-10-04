"""Centralized, resilient Firestore database service and domain helpers.

Provides authoritative database operations, concurrency controls, atomic helpers,
audit trail logging, and multi-collection consistency synchronization for rides,
ride-share trips, driver presence, ledger, and user operations.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from firebase_admin import firestore as fb_firestore

from ..core.errors import ApiError
from ..core.firebase import get_admin_app

logger = logging.getLogger(__name__)

# Canonical Collection Names
COLLECTION_RIDES = "rides"
COLLECTION_SHARE_TRIPS = "shareTrips"
COLLECTION_USERS = "users"
COLLECTION_DRIVER_PRESENCE = "driverPresence"
COLLECTION_DRIVER_MAP_PRESENCE = "driverMapPresence"
COLLECTION_PENDING_RIDE_REQUESTS = "pendingRideRequests"
COLLECTION_TRIP_HISTORY = "tripHistory"
COLLECTION_AUDIT_LOGS = "auditLogs"
COLLECTION_RIDE_AUDITS = "ride_audits"
COLLECTION_FINANCIAL_LEDGER = "financialLedger"
COLLECTION_WALLET_TRANSACTIONS = "walletTransactions"
COLLECTION_WALLETS = "wallets"
COLLECTION_SAFETY_REPORTS = "safetyReports"
COLLECTION_SOS_ALERTS = "sosAlerts"
COLLECTION_DRIVER_PAYMENTS = "driverPayments"
COLLECTION_DRIVER_DAILY_STATS = "driverDailyStats"
COLLECTION_COUPONS = "coupons"
COLLECTION_COUPON_REDEMPTIONS = "couponRedemptions"

# Active Ride Status Set
ACTIVE_RIDE_STATUSES: Set[str] = {"accepted", "arrived", "started", "en_route"}
TERMINAL_RIDE_STATUSES: Set[str] = {
    "completed",
    "cancelled",
    "cancelled_by_driver",
    "cancelled_by_passenger",
    "no_show",
    "timeout",
    "expired",
}


def get_db():
    """Retrieve the Firebase Firestore client."""
    return fb_firestore.client(get_admin_app())


def get_doc(collection: str, doc_id: str, tx: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """Safely fetch a document dictionary by collection and ID."""
    if not doc_id:
        return None
    db = get_db()
    ref = db.collection(collection).document(str(doc_id).strip())
    snap = ref.get(transaction=tx) if tx is not None else ref.get()
    if snap.exists:
        data = snap.to_dict() or {}
        data["id"] = snap.id
        return data
    return None


def record_ride_audit(
    db: Any,
    ride_id: str,
    action: str,
    actor_id: str,
    actor_role: str,
    details: Optional[Dict[str, Any]] = None,
    tx: Optional[Any] = None,
) -> str:
    """Record an immutable, tamper-proof audit log entry for ride state transitions.

    Guarantees that state changes (accept, transition, cancel, skip, feedback)
    are auditable across passengers, drivers, and admins.
    """
    if db is None:
        db = get_db()
    ref = db.collection(COLLECTION_RIDE_AUDITS).document()
    payload = {
        "rideId": str(ride_id).strip()[:160],
        "action": str(action).strip().lower()[:80],
        "actorId": str(actor_id).strip()[:160],
        "actorRole": str(actor_role).strip().lower()[:40],
        "details": details or {},
        "timestamp": fb_firestore.SERVER_TIMESTAMP,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
    }
    try:
        if tx is not None:
            tx.set(ref, payload)
        else:
            ref.set(payload)
        return ref.id
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to record ride audit: %s", exc)
        return ""


def record_financial_ledger_entry(
    db: Any,
    entry_id: str,
    amount_paise: int,
    entry_type: str,
    from_user_id: Optional[str] = None,
    to_user_id: Optional[str] = None,
    ride_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    tx: Optional[Any] = None,
) -> bool:
    """Record a double-entry financial ledger transaction in financialLedger."""
    if db is None:
        db = get_db()
    clean_id = str(entry_id).strip()[:160]
    ref = db.collection(COLLECTION_FINANCIAL_LEDGER).document(clean_id)
    payload = {
        "entryId": clean_id,
        "amountPaise": int(amount_paise),
        "amountInr": round(float(amount_paise) / 100.0, 2),
        "entryType": str(entry_type).strip().lower(),
        "fromUserId": str(from_user_id).strip() if from_user_id else None,
        "toUserId": str(to_user_id).strip() if to_user_id else None,
        "rideId": str(ride_id).strip() if ride_id else None,
        "details": details or {},
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
    }
    try:
        if tx is not None:
            tx.set(ref, payload, merge=True)
        else:
            ref.set(payload, merge=True)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to record financial ledger entry: %s", exc)
        return False


def driver_has_other_active_rides(
    db: Any,
    driver_id: str,
    exclude_ride_id: Optional[str] = None,
) -> bool:
    """Check if the driver has any other active rides besides exclude_ride_id."""
    if not driver_id or db is None:
        return False
    try:
        docs = list(
            db.collection(COLLECTION_RIDES)
            .where("driver_id", "==", driver_id)
            .where("status", "in", list(ACTIVE_RIDE_STATUSES))
            .limit(2)
            .stream()
        )
        for doc in docs:
            if exclude_ride_id and doc.id == exclude_ride_id:
                continue
            return True
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("Error checking driver active rides: %s", exc)
        return False


def driver_has_open_share_trips(
    db: Any,
    driver_id: str,
    exclude_trip_id: Optional[str] = None,
) -> bool:
    """Check if the driver has open share trips (status in to_pickup or active)."""
    if not driver_id or db is None:
        return False
    try:
        docs = list(
            db.collection(COLLECTION_SHARE_TRIPS)
            .where("driverId", "==", driver_id)
            .where("status", "in", ["to_pickup", "active"])
            .limit(2)
            .stream()
        )
        for doc in docs:
            if exclude_trip_id and doc.id == exclude_trip_id:
                continue
            return True
        return False
    except Exception:
        # Fallback to query without IN filter in case of index issues
        try:
            for doc in db.collection(COLLECTION_SHARE_TRIPS).where("driverId", "==", driver_id).stream():
                if exclude_trip_id and doc.id == exclude_trip_id:
                    continue
                d = doc.to_dict() or {}
                if d.get("status") in {"to_pickup", "active"}:
                    return True
        except Exception:
            pass
        return False


def update_driver_presence_synchronized(
    db: Any,
    driver_id: str,
    availability: str,
    desired_availability: Optional[str] = None,
    is_connected: bool = True,
    profile_data: Optional[Dict[str, Any]] = None,
) -> None:
    """Synchronize driver availability across users, driverPresence, and driverMapPresence."""
    if not driver_id or db is None:
        return
    clean_driver_id = str(driver_id).strip()
    profile = profile_data or {}
    if not profile:
        try:
            snap = db.collection(COLLECTION_USERS).document(clean_driver_id).get()
            if snap.exists:
                profile = snap.to_dict() or {}
        except Exception:
            profile = {}

    status = str(availability).strip().lower()
    desired = (
        str(desired_availability).strip().lower()
        if desired_availability
        else str(profile.get("desiredAvailability") or ("online" if is_connected else "offline")).strip().lower()
    )

    now = datetime.now(timezone.utc)
    from ..routers.rides import _build_driver_availability_updates

    user_update, presence_update, map_presence_update = _build_driver_availability_updates(status, profile)
    user_update["desiredAvailability"] = desired
    presence_update["desiredAvailability"] = desired
    map_presence_update["desiredAvailability"] = desired

    try:
        db.collection(COLLECTION_USERS).document(clean_driver_id).set(user_update, merge=True)
        db.collection(COLLECTION_DRIVER_PRESENCE).document(clean_driver_id).set(presence_update, merge=True)
        db.collection(COLLECTION_DRIVER_MAP_PRESENCE).document(clean_driver_id).set(map_presence_update, merge=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to synchronize driver presence: %s", exc)


def sync_share_trip_passenger_ids(
    db: Any,
    trip_id: str,
    child_ride_ids: Optional[List[str]] = None,
    tx: Optional[Any] = None,
) -> List[str]:
    """Inspects child rides to extract all passenger IDs and updates passenger_ids/passengerIds on shareTrips.

    This enables secure, direct Firestore realtime reads for passengers as defined in firestore.rules.
    """
    if not trip_id or db is None:
        return []

    trip_ref = db.collection(COLLECTION_SHARE_TRIPS).document(trip_id)
    if child_ride_ids is None:
        t_snap = trip_ref.get(transaction=tx) if tx is not None else trip_ref.get()
        if t_snap.exists:
            t_data = t_snap.to_dict() or {}
            child_ride_ids = list(t_data.get("childRideIds") or [])
        else:
            child_ride_ids = []

    p_ids: Set[str] = set()
    for cid in child_ride_ids:
        c_ref = db.collection(COLLECTION_RIDES).document(cid)
        c_snap = c_ref.get(transaction=tx) if tx is not None else c_ref.get()
        if c_snap.exists:
            c_data = c_snap.to_dict() or {}
            pid = c_data.get("passenger_id") or c_data.get("passengerId")
            if pid:
                p_ids.add(str(pid).strip())

    passenger_list = sorted(list(p_ids))
    trip_ref = db.collection(COLLECTION_SHARE_TRIPS).document(trip_id)
    update_data = {
        "passenger_ids": passenger_list,
        "passengerIds": passenger_list,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    if tx is not None:
        tx.update(trip_ref, update_data)
    else:
        trip_ref.update(update_data)
    return passenger_list
