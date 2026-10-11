"""
Admin console API.

Everything the `/admin` dashboard can change goes through this router using
the Firebase Admin SDK -- exactly like every other business write in this
codebase (see rides.py, account.py). The browser never writes to Firestore
directly, admin included. The Admin SDK bypasses Firestore rules entirely,
and the existing catch-all in firestore.rules (`allow read, write: if
false`) already denies direct client access to every collection this
router touches, including the new `auditLogs` collection -- so no rules
changes were needed. Every mutation is authenticated with `require_admin`
(Firebase ID token + `admin` custom claim) and recorded to `auditLogs` via
`write_audit_log`.
"""
from __future__ import annotations

import hmac
import logging
from datetime import datetime, date, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from google.api_core import exceptions as gcloud_exceptions
from pydantic import BaseModel, ConfigDict, Field

from ..core.admin import (
    now_utc,
    require_admin,
    require_super_admin,
    require_admin_or_super_admin,
    write_audit_log,
)
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])

DRIVER_STATUSES = {"pending_review", "approved", "rejected", "suspended", "blocked"}
PASSENGER_STATUSES = {"active", "restricted", "blocked"}
ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"]
TERMINAL_RIDE_STATUSES = ["completed", "cancelled_by_passenger", "cancelled_by_driver"]
RIDE_STATUS_GROUPS: dict[str, Optional[list[str]]] = {
    "all": None,
    "active": ACTIVE_RIDE_STATUSES,
    "completed": ["completed"],
    "cancelled": ["cancelled_by_passenger", "cancelled_by_driver"],
}
DRIVER_AVAILABILITY_GROUPS: dict[str, list[str]] = {
    "online": ["online", "searching"],
    "busy": ["busy"],
    "offline": ["offline"],
}
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100


def _db():
    return fb_firestore.client(get_admin_app())


def _clamp_limit(limit: Any) -> int:
    try:
        val = int(getattr(limit, "default", limit))
    except Exception:
        val = DEFAULT_PAGE_SIZE
    return max(1, min(val, MAX_PAGE_SIZE))


def _safe_count(base_query) -> int:
    try:
        return base_query.count().get()[0][0].value
    except Exception:
        return 0


def _stream(query) -> list:
    try:
        return list(query.stream())
    except gcloud_exceptions.FailedPrecondition as exc:
        raise ApiError(
            "This view needs a Firestore index that hasn't been created yet. "
            "Ask whoever manages the Firebase project to deploy the indexes "
            "in firestore.indexes.json.",
            503,
            {"firestoreIndexError": str(exc)[:300]},
        ) from exc


def _doc_dict(snapshot) -> dict[str, Any]:
    data = snapshot.to_dict() or {}
    data["id"] = snapshot.id
    return data


def _paginate(base_query, cursor: Optional[str], limit: int, id_field_collection: str):
    query = base_query.limit(limit + 1)
    if cursor:
        cursor_snap = _db().collection(id_field_collection).document(cursor).get()
        if cursor_snap.exists:
            query = query.start_after(cursor_snap)
    docs = _stream(query)
    has_more = len(docs) > limit
    docs = docs[:limit]
    items = [_doc_dict(d) for d in docs]
    next_cursor = items[-1]["id"] if has_more and items else None
    return items, next_cursor


def _batch_get_users(db, uids: Any) -> dict[str, dict[str, Any]]:
    clean_uids = [str(u).strip() for u in (uids or []) if u and str(u).strip()]
    unique_uids = list(dict.fromkeys(clean_uids))
    if not unique_uids:
        return {}
    result: dict[str, dict[str, Any]] = {}
    if hasattr(db, "get_all"):
        for idx in range(0, len(unique_uids), 100):
            chunk = unique_uids[idx : idx + 100]
            refs = [db.collection("users").document(uid) for uid in chunk]
            try:
                for snap in db.get_all(refs):
                    if getattr(snap, "exists", False):
                        result[snap.id] = snap.to_dict() or {}
            except Exception:
                for uid in chunk:
                    try:
                        snap = db.collection("users").document(uid).get()
                        if snap.exists:
                            result[uid] = snap.to_dict() or {}
                    except Exception:
                        pass
    else:
        for uid in unique_uids:
            try:
                snap = db.collection("users").document(uid).get()
                if snap.exists:
                    result[uid] = snap.to_dict() or {}
            except Exception:
                pass
    return result


def _backfill_driver_names(rides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    missing_ids = {
        r.get("driver_id")
        for r in rides
        if r.get("driver_id") and not str(r.get("driver_name") or "").strip()
    }
    if not missing_ids:
        return rides
    db = _db()
    user_map = _batch_get_users(db, missing_ids)
    names: dict[str, str] = {}
    for uid, data in user_map.items():
        if data.get("name"):
            names[uid] = str(data["name"])[:80]
    for r in rides:
        driver_id = r.get("driver_id")
        if driver_id and not str(r.get("driver_name") or "").strip():
            r["driver_name"] = names.get(driver_id) or "Driver"
    return rides


def _parse_day(value: str, field_name: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise ApiError(f"{field_name} must be an ISO date (YYYY-MM-DD).", 400)


def _day_range_utc(day_str: str, field_name: str) -> datetime:
    d = _parse_day(day_str, field_name)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _apply_search(items: list[dict[str, Any]], q: str, fields: list[str]) -> list[dict[str, Any]]:
    if not q:
        return items
    needle = q.strip().lower()
    if not needle:
        return items
    out = []
    for item in items:
        haystack = " ".join(str(item.get(f, "")) for f in fields).lower()
        if needle in haystack:
            out.append(item)
    return out


def _paginate_with_search(
    base_query,
    cursor: Optional[str],
    limit: int,
    id_field_collection: str,
    q: Optional[str],
    search_fields: list[str],
    pre_search_transform=None,
):
    if not q or not str(q).strip():
        items, next_cursor = _paginate(base_query, cursor, limit, id_field_collection)
        if pre_search_transform:
            items = pre_search_transform(items)
        return items, next_cursor

    scan_limit = max(limit * 10, 500)
    docs = _stream(base_query.limit(scan_limit))
    all_items = [_doc_dict(d) for d in docs]
    if pre_search_transform:
        all_items = pre_search_transform(all_items)
    matched = _apply_search(all_items, q, search_fields)

    if cursor:
        cursor_idx = next(
            (i for i, item in enumerate(matched) if (item.get("id") or item.get("uid")) == cursor),
            None,
        )
        if cursor_idx is not None:
            matched = matched[cursor_idx + 1 :]

    has_more = len(matched) > limit
    page = matched[:limit]
    next_cursor = (page[-1].get("id") or page[-1].get("uid")) if has_more and page else None
    return page, next_cursor


# ---------------------------------------------------------------------------
# Session check & Bootstrap
# ---------------------------------------------------------------------------

@router.get("/verify")
def verify_admin(admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return {
        "ok": True,
        "uid": admin_user.get("uid"),
        "email": admin_user.get("email"),
        "name": admin_user.get("name") or admin_user.get("email"),
        "role": admin_user.get("adminRole") or "super_admin"
    }


class BootstrapAdminBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    secret: str = Field(min_length=1, max_length=200)


@router.post("/bootstrap")
def bootstrap_admin(body: BootstrapAdminBody) -> dict[str, Any]:
    expected_secret = get_env("ADMIN_BOOTSTRAP_SECRET", "")
    if not expected_secret:
        raise ApiError("Bootstrap endpoint disabled.", 403)
    if not hmac.compare_digest(body.secret, expected_secret):
        raise ApiError("Invalid secret.", 403)

    try:
        user = fb_auth.get_user_by_email(body.email.strip().lower(), app=get_admin_app())
    except Exception as exc:
        raise ApiError(f"User '{body.email}' not found.", 404) from exc

    fb_auth.set_custom_user_claims(user.uid, {"admin": True}, app=get_admin_app())
    return {"ok": True, "message": f"Admin claim granted to {user.email} (uid: {user.uid})."}


# ---------------------------------------------------------------------------
# Permissions Management (Super Admin Only)
# ---------------------------------------------------------------------------

@router.get("/permissions")
def list_permissions(admin_user: dict[str, Any] = Depends(require_super_admin)) -> dict[str, Any]:
    db = _db()
    roles_docs = [_doc_dict(d) for d in db.collection("adminRoles").stream()]
    users_query = db.collection("users").limit(150)
    all_users = [_doc_dict(u) for u in users_query.stream()]
    
    return {
        "ok": True,
        "adminRoles": roles_docs,
        "eligibleUsers": [
            {
                "uid": u.get("id"),
                "name": u.get("name") or "Unnamed User",
                "email": u.get("email") or "",
                "phone": u.get("phone") or "",
                "userRole": u.get("role") or "user"
            }
            for u in all_users if u.get("email") or u.get("id")
        ]
    }


class AssignRoleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uid: str = Field(min_length=1, max_length=128)
    email: Optional[str] = Field(default="", max_length=320)
    role: str = Field(min_length=1, max_length=30)  # "admin" or "manager"


@router.post("/permissions/assign")
def assign_permission_role(body: AssignRoleBody, admin_user: dict[str, Any] = Depends(require_super_admin)) -> dict[str, Any]:
    if body.role not in {"admin", "manager"}:
        raise ApiError("Only Admin or Manager roles can be assigned.", 400)
    
    db = _db()
    user_snap = db.collection("users").document(body.uid).get()
    user_data = user_snap.to_dict() if user_snap.exists else {}
    email = body.email or user_data.get("email") or ""
    name = user_data.get("name") or email or "Admin User"
    
    try:
        fb_auth.set_custom_user_claims(body.uid, {"admin": True}, app=get_admin_app())
    except Exception as err:
        raise ApiError(f"Could not set admin custom claim: {str(err)}", 500)
    
    ref = db.collection("adminRoles").document(body.uid)
    snap = ref.get()
    before = snap.to_dict() if snap.exists else None
    
    after = {
        "uid": body.uid,
        "email": email,
        "name": name,
        "role": body.role,
        "assignedByUid": admin_user.get("uid"),
        "assignedByEmail": admin_user.get("email") or admin_user.get("uid"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    if not before:
        after["createdAt"] = fb_firestore.SERVER_TIMESTAMP
        after["assignedAt"] = fb_firestore.SERVER_TIMESTAMP

    ref.set(after, merge=True)
    
    action_type = "permissions.change_role" if before else "permissions.assign_role"
    notes = f"Changed role from {before.get('role', 'none')} to {body.role}" if before else f"Assigned {body.role} role to user {email}"
    write_audit_log(admin_user, action_type, "user_permission", body.uid, before, after, notes)
    return {"ok": True, "message": f"Assigned {body.role.upper()} role to {email}."}


@router.delete("/permissions/{target_uid}")
def revoke_permission_role(target_uid: str, admin_user: dict[str, Any] = Depends(require_super_admin)) -> dict[str, Any]:
    if target_uid == admin_user.get("uid"):
        raise ApiError("Super Admin cannot revoke their own permission.", 400)
    
    db = _db()
    ref = db.collection("adminRoles").document(target_uid)
    snap = ref.get()
    if snap.exists and snap.to_dict().get("role") == "super_admin":
        raise ApiError("Super Admin roles cannot be revoked.", 400)
    
    before = snap.to_dict() if snap.exists else None
    
    try:
        fb_auth.set_custom_user_claims(target_uid, {"admin": False}, app=get_admin_app())
    except Exception:
        pass
    
    if snap.exists:
        ref.delete()
    
    write_audit_log(admin_user, "permissions.revoke_role", "user_permission", target_uid, before, None, f"Revoked administrative access for user {before.get('email') if before else target_uid}")
    return {"ok": True, "message": "Administrative access revoked."}


# ---------------------------------------------------------------------------
# Dashboard Overview
# ---------------------------------------------------------------------------

@router.get("/overview")
def get_overview(admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    db = _db()
    now = now_utc()
    today_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    yesterday_start = today_start - timedelta(days=1)
    week_start = today_start - timedelta(days=7)
    month_start = today_start - timedelta(days=30)

    drivers_coll = db.collection("users").where("role", "==", "driver")
    driver_docs = [_doc_dict(d) for d in _stream(drivers_coll)]
    total_drivers = len(driver_docs)

    stale_threshold = now - timedelta(minutes=15)
    pending_drivers = 0
    suspended_drivers = 0
    blocked_drivers = 0
    active_online_drivers = 0
    busy_drivers = 0
    offline_drivers = 0

    for d in driver_docs:
        v_status = str(d.get("verificationStatus") or "pending_review").lower()
        if v_status == "pending_review":
            pending_drivers += 1
        elif v_status == "suspended":
            suspended_drivers += 1
        elif v_status == "blocked":
            blocked_drivers += 1

        # Only approved drivers can be online or busy; unapproved drivers are offline
        if v_status != "approved":
            offline_drivers += 1
            continue

        raw_avail = str(d.get("driverAvailability") or "offline").lower()
        last_seen = d.get("lastLocationAt") or d.get("lastSeenAt") or d.get("lastAppSeenAt")
        if isinstance(last_seen, str):
            try:
                last_seen = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
            except Exception:
                last_seen = None

        is_fresh = False
        if isinstance(last_seen, datetime):
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=timezone.utc)
            is_fresh = (last_seen >= stale_threshold)
        elif raw_avail in ("online", "searching", "busy") and d.get("isConnected"):
            updated_at = d.get("updatedAt")
            if isinstance(updated_at, datetime):
                if updated_at.tzinfo is None:
                    updated_at = updated_at.replace(tzinfo=timezone.utc)
                is_fresh = (updated_at >= stale_threshold)

        if raw_avail == "busy" and is_fresh:
            busy_drivers += 1
        elif raw_avail in ("online", "searching") and is_fresh:
            active_online_drivers += 1
        else:
            offline_drivers += 1

    passengers_coll = db.collection("users").where("role", "==", "passenger")
    total_passengers = _safe_count(passengers_coll)
    new_passengers_today = _safe_count(passengers_coll.where("createdAt", ">=", today_start))

    users_coll = db.collection("users")
    total_registered = _safe_count(users_coll)
    new_users_today = _safe_count(users_coll.where("createdAt", ">=", today_start))
    new_users_week = _safe_count(users_coll.where("createdAt", ">=", week_start))
    new_users_month = _safe_count(users_coll.where("createdAt", ">=", month_start))
    new_drivers_today = _safe_count(drivers_coll.where("createdAt", ">=", today_start))

    rides_coll = db.collection("rides")
    total_completed_rides = _safe_count(rides_coll.where("status", "==", "completed"))

    today_rides_query = rides_coll.where("createdAt", ">=", today_start)
    today_docs = [_doc_dict(d) for d in _stream(today_rides_query)]

    today_total = len(today_docs)
    today_completed_docs = [r for r in today_docs if r.get("status") == "completed"]
    today_completed = len(today_completed_docs)
    today_cancelled = len([r for r in today_docs if str(r.get("status") or "").startswith("cancelled")])
    today_active_docs = [r for r in today_docs if r.get("status") in ACTIVE_RIDE_STATUSES]
    today_active = len(today_active_docs)
    today_fare = round(sum(float(r.get("fare") or 0) for r in today_completed_docs), 2)
    today_km = round(sum(float(r.get("estimated_distance_km") or r.get("distance_km") or 0) for r in today_completed_docs), 2)
    avg_km = round(today_km / today_completed, 2) if today_completed > 0 else 0.0

    yesterday_rides_docs = [_doc_dict(d) for d in _stream(rides_coll.where("createdAt", ">=", yesterday_start).where("createdAt", "<", today_start))]
    yesterday_rides_count = len(yesterday_rides_docs)
    rides_delta_percent = (
        round(((today_total - yesterday_rides_count) / yesterday_rides_count * 100), 1)
        if yesterday_rides_count > 0
        else (100.0 if today_total > 0 else 0.0)
    )

    total_share_rides = _safe_count(rides_coll.where("rideType", "==", "share"))
    completed_share_trips = [_doc_dict(d) for d in _stream(db.collection("shareTrips").where("status", "==", "completed").limit(100))]
    total_completed_share_trips = len(completed_share_trips)
    if total_completed_share_trips > 0:
        total_riders = sum(len(t.get("childRideIds") or []) + int(t.get("remoteSeq") or 0) for t in completed_share_trips)
        avg_riders_per_share_trip = round(total_riders / total_completed_share_trips, 2)
    else:
        avg_riders_per_share_trip = 0.0

    # Attention items
    pending_payments = _safe_count(db.collection("driverPayments").where("status", "==", "submitted"))
    open_sos = _safe_count(db.collection("sosAlerts").where("status", "==", "open"))
    open_reports = _safe_count(db.collection("safetyReports").where("status", "==", "open"))

    # Active users count & real vs-yesterday comparison
    today_passenger_ids = list({r.get("passenger_id") for r in today_docs if r.get("passenger_id")})
    active_passenger_count = len(today_passenger_ids) or max(0, new_passengers_today)
    active_users_total = (active_online_drivers + busy_drivers) + active_passenger_count

    yesterday_active_uids = {
        uid
        for r in yesterday_rides_docs
        for uid in (r.get("passenger_id"), r.get("driver_id"))
        if uid
    }
    yesterday_new_users = _safe_count(users_coll.where("createdAt", ">=", yesterday_start).where("createdAt", "<", today_start))
    yesterday_active_total = max(len(yesterday_active_uids), yesterday_new_users)
    active_users_delta_percent = (
        round(((active_users_total - yesterday_active_total) / yesterday_active_total * 100), 1)
        if yesterday_active_total > 0
        else (100.0 if active_users_total > 0 else 0.0)
    )

    # Recent Rides query (latest 10)
    recent_rides_query = rides_coll.order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(10)
    recent_rides_docs = [_doc_dict(d) for d in _stream(recent_rides_query)]
    recent_rides = _backfill_driver_names(recent_rides_docs)

    # Collect real recent activity events across 6 distinct categories
    all_activities: list[dict[str, Any]] = []

    # 1. New Driver Registrations
    recent_drivers_query = users_coll.where("role", "==", "driver").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(15)
    for u in [_doc_dict(d) for d in _stream(recent_drivers_query)]:
        name = u.get("name") or u.get("phone") or "Driver"
        t = u.get("createdAt")
        t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
        all_activities.append({
            "text": f"New driver registered: {name}",
            "color": "primary",
            "type": "driver_registered",
            "at": t_iso,
        })

    # 2. New Passenger Registrations
    recent_passengers_query = users_coll.where("role", "==", "passenger").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(15)
    for u in [_doc_dict(d) for d in _stream(recent_passengers_query)]:
        name = u.get("name") or u.get("phone") or "Passenger"
        t = u.get("createdAt")
        t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
        all_activities.append({
            "text": f"New passenger registered: {name}",
            "color": "primary",
            "type": "passenger_registered",
            "at": t_iso,
        })

    # 3. Ride Completed
    try:
        completed_rides_query = rides_coll.where("status", "==", "completed").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(15)
        for r in [_doc_dict(d) for d in _stream(completed_rides_query)]:
            r_id = str(r.get("id") or "")
            short_id = f"#LP{r_id[-5:].upper()}" if len(r_id) >= 5 else f"#{r_id}"
            t = r.get("completedAt") or r.get("updatedAt") or r.get("createdAt")
            t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
            fare = r.get("fare")
            fare_txt = f" (₹{fare})" if fare else ""
            all_activities.append({
                "text": f"Ride {short_id} completed{fare_txt}",
                "color": "success",
                "type": "ride_completed",
                "at": t_iso,
            })
    except Exception:
        pass

    # 4. Ride Cancelled
    try:
        cancelled_rides_query = rides_coll.order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(30)
        c_count = 0
        for r in [_doc_dict(d) for d in _stream(cancelled_rides_query)]:
            st = str(r.get("status") or r.get("final_status") or r.get("trip_status") or "").lower()
            if st.startswith("cancel") or r.get("cancelled") or r.get("is_cancelled"):
                r_id = str(r.get("id") or "")
                short_id = f"#LP{r_id[-5:].upper()}" if len(r_id) >= 5 else f"#{r_id}"
                t = r.get("cancelledAt") or r.get("finalStatusAt") or r.get("updatedAt") or r.get("createdAt")
                t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
                all_activities.append({
                    "text": f"Ride {short_id} cancelled",
                    "color": "danger",
                    "type": "ride_cancelled",
                    "at": t_iso,
                })
                c_count += 1
                if c_count >= 15:
                    break
    except Exception:
        pass

    # 5. Driver Weekly Payment Completed
    try:
        recent_pmts_query = (
            db.collection("driverPayments")
            .where("status", "==", "approved")
            .order_by("submittedAt", direction=fb_firestore.Query.DESCENDING)
            .limit(15)
        )
        for p in [_doc_dict(d) for d in _stream(recent_pmts_query)]:
            t = p.get("verifiedAt") or p.get("updatedAt") or p.get("submittedAt") or p.get("createdAt")
            t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
            drv_name = p.get("driverName") or p.get("name") or "Driver"
            amt = p.get("amount") or 0
            all_activities.append({
                "text": f"{drv_name} completed weekly payment (₹{amt})",
                "color": "success",
                "type": "payment_completed",
                "at": t_iso,
            })
    except Exception:
        try:
            for p in [_doc_dict(d) for d in _stream(db.collection("driverPayments").order_by("submittedAt", direction=fb_firestore.Query.DESCENDING).limit(20))]:
                if p.get("status") == "approved":
                    t = p.get("verifiedAt") or p.get("updatedAt") or p.get("submittedAt") or p.get("createdAt")
                    t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
                    drv_name = p.get("driverName") or p.get("name") or "Driver"
                    amt = p.get("amount") or 0
                    all_activities.append({
                        "text": f"{drv_name} completed weekly payment (₹{amt})",
                        "color": "success",
                        "type": "payment_completed",
                        "at": t_iso,
                    })
        except Exception:
            pass

    # 6. SOS Alerts
    try:
        recent_sos_query = db.collection("sosAlerts").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(15)
        for s in [_doc_dict(d) for d in _stream(recent_sos_query)]:
            t = s.get("createdAt") or s.get("triggeredAt")
            t_iso = t.isoformat() if isinstance(t, datetime) else (str(t) if t else now.isoformat())
            ride_ref = s.get("rideId") or s.get("ride_id") or ""
            user_lbl = s.get("userName") or s.get("passengerName") or s.get("phone") or "Passenger"
            alert_label = f"Ride #{str(ride_ref)[-5:].upper()}" if ride_ref else user_lbl
            all_activities.append({
                "text": f"New SOS alert: {alert_label}",
                "color": "danger",
                "type": "sos_alert",
                "at": t_iso,
            })
    except Exception:
        pass

    # Sort all candidates by timestamp descending
    all_activities.sort(key=lambda x: str(x.get("at") or ""), reverse=True)

    # Diversity limiter: max 10 per activity type, feed limit up to 25
    type_counts: dict[str, int] = {}
    diverse_activities: list[dict[str, Any]] = []
    overflow_activities: list[dict[str, Any]] = []

    for act in all_activities:
        act_type = act.get("type", "other")
        count = type_counts.get(act_type, 0)
        if count < 10:
            diverse_activities.append(act)
            type_counts[act_type] = count + 1
            if len(diverse_activities) >= 25:
                break
        else:
            overflow_activities.append(act)

    if len(diverse_activities) < 25 and overflow_activities:
        for act in overflow_activities:
            diverse_activities.append(act)
            if len(diverse_activities) >= 25:
                break

    recent_activity = diverse_activities[:25]

    # Hourly ride activity breakdown for today
    hourly_activity: dict[str, int] = {"6 AM": 0, "9 AM": 0, "12 PM": 0, "3 PM": 0, "6 PM": 0, "9 PM": 0}
    for r in today_docs:
        created_at = r.get("createdAt")
        if isinstance(created_at, datetime):
            h = created_at.hour
        elif isinstance(created_at, str):
            try:
                h = datetime.fromisoformat(created_at.replace("Z", "+00:00")).hour
            except Exception:
                continue
        else:
            continue
        
        if h < 8:
            hourly_activity["6 AM"] += 1
        elif h < 11:
            hourly_activity["9 AM"] += 1
        elif h < 14:
            hourly_activity["12 PM"] += 1
        elif h < 17:
            hourly_activity["3 PM"] += 1
        elif h < 20:
            hourly_activity["6 PM"] += 1
        else:
            hourly_activity["9 PM"] += 1

    # Real 7-day and 30-day ride activity series (ending today)
    start_30d = today_start - timedelta(days=29)
    date_counts_30d: dict[str, int] = {}
    date_labels_30d: dict[str, str] = {}
    for i in range(30):
        day_dt = start_30d + timedelta(days=i)
        day_key = day_dt.strftime("%Y-%m-%d")
        date_counts_30d[day_key] = 0
        date_labels_30d[day_key] = day_dt.strftime("%d %b")

    try:
        rides_30d_docs = [_doc_dict(d) for d in _stream(rides_coll.where("createdAt", ">=", start_30d))]
    except Exception:
        rides_30d_docs = list(today_docs)

    for r in rides_30d_docs:
        created_at = r.get("createdAt")
        dt_val: Optional[datetime] = None
        if isinstance(created_at, datetime):
            dt_val = created_at.astimezone(timezone.utc) if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        elif isinstance(created_at, str):
            try:
                dt_val = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except Exception:
                dt_val = None
        if dt_val is not None:
            d_key = dt_val.strftime("%Y-%m-%d")
            if d_key in date_counts_30d:
                date_counts_30d[d_key] += 1

    ordered_keys_30d = sorted(date_counts_30d.keys())
    ordered_keys_7d = ordered_keys_30d[-7:]
    daily_7d: dict[str, int] = {date_labels_30d[k]: date_counts_30d[k] for k in ordered_keys_7d}
    daily_30d: dict[str, int] = {date_labels_30d[k]: date_counts_30d[k] for k in ordered_keys_30d}

    return {
        "ok": True,
        "generatedAt": now.isoformat(),
        "today": {
            "totalRides": today_total,
            "completedRides": today_completed,
            "cancelledRides": today_cancelled,
            "activeRides": today_active,
            "totalFareCollected": today_fare,
            "totalDistanceKm": today_km,
            "averageRideDistanceKm": avg_km,
            "newUsersToday": new_users_today,
            "newDriversToday": new_drivers_today,
            "activeRidePassengerIds": list({r.get("passenger_id") for r in today_active_docs if r.get("passenger_id")}),
            "vsYesterdayPercent": rides_delta_percent,
        },
        "activeUsers": {
            "total": active_users_total,
            "passengers": active_passenger_count,
            "drivers": active_online_drivers + busy_drivers,
            "vsYesterdayPercent": active_users_delta_percent,
        },
        "attention": {
            "pendingDrivers": pending_drivers,
            "pendingPayments": pending_payments,
            "openSosAlerts": open_sos,
            "openSafetyReports": open_reports,
        },
        "recentActivity": recent_activity,
        "activities": recent_activity,
        "userGrowth": {
            "today": new_users_today,
            "thisWeek": new_users_week or new_users_today,
            "thisMonth": new_users_month or new_users_week or new_users_today,
            "passengers": total_passengers,
            "drivers": total_drivers,
        },
        "drivers": {
            "total": total_drivers,
            "pendingApproval": pending_drivers,
            "suspended": suspended_drivers,
            "blocked": blocked_drivers,
            "activeOnline": active_online_drivers,
            "busy": busy_drivers,
            "offline": offline_drivers,
        },
        "passengers": {
            "total": total_passengers,
            "newRegistrationsToday": new_passengers_today,
        },
        "platform": {
            "totalRegisteredUsers": total_registered,
            "totalCompletedRides": total_completed_rides,
        },
        "share": {
            "totalShareRides": total_share_rides,
            "completedShareTrips": total_completed_share_trips,
            "avgRidersPerShareTrip": avg_riders_per_share_trip,
        },
        "safety": {
            "openSosAlerts": open_sos,
            "openSafetyReports": open_reports,
        },
        "systemHealth": {
            "status": "attention" if (open_sos > 0 or open_reports > 0 or pending_drivers > 5 or pending_payments > 0) else "ok",
            "openSosAlerts": open_sos,
            "pendingDriversCount": pending_drivers,
        },
        "recentRides": recent_rides,
        "rideActivity": {
            "hourly": hourly_activity,
            "daily7d": daily_7d,
            "daily30d": daily_30d,
        },
    }


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

@router.get("/drivers")
def list_drivers(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default=None),
    availability: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("users").where("role", "==", "driver")
    if status:
        if status not in DRIVER_STATUSES:
            raise ApiError("Unknown driver status filter.", 400)
        base = base.where("verificationStatus", "==", status)
    if availability:
        values = DRIVER_AVAILABILITY_GROUPS.get(availability)
        if not values:
            raise ApiError("Unknown driver availability filter.", 400)
        base = base.where("driverAvailability", "in", values)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)

    items, next_cursor = _paginate_with_search(
        base, cursor, limit, "users", q, ["name", "phone", "email", "vehicle_number", "vehicleNumber", "drivingLicenseNumber"]
    )
    return {"ok": True, "drivers": [_sanitize_driver(i) for i in items], "nextCursor": next_cursor}


def _sanitize_driver(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": profile.get("id") or profile.get("uid"),
        "name": profile.get("name"),
        "phone": profile.get("phone"),
        "email": profile.get("email"),
        "profilePhotoUrl": profile.get("profilePhotoUrl"),
        "verificationStatus": profile.get("verificationStatus") or "pending_review",
        "rejectionReason": profile.get("rejectionReason"),
        "suspensionReason": profile.get("suspensionReason"),
        "blockingReason": profile.get("blockingReason"),
        "approvalAcknowledged": profile.get("approvalAcknowledged", False),
        "approvedAt": profile.get("approvedAt"),
        "rejectedAt": profile.get("rejectedAt"),
        "suspendedAt": profile.get("suspendedAt"),
        "blockedAt": profile.get("blockedAt"),
        "reappliedAt": profile.get("reappliedAt"),
        "driverAvailability": profile.get("driverAvailability") if (profile.get("verificationStatus") == "approved") else "offline",
        "vehicleType": profile.get("vehicleType") or profile.get("vehicle_type"),
        "vehicleNumber": profile.get("vehicleNumber") or profile.get("vehicle_number"),
        "vehicleModel": profile.get("vehicleModel") or profile.get("vehicle_model"),
        "drivingLicenseNumber": profile.get("drivingLicenseNumber") or profile.get("licenseNumber"),
        "licensePhotoUrl": profile.get("licensePhotoUrl") or profile.get("drivingLicenseUrl"),
        "rcPhotoUrl": profile.get("rcPhotoUrl") or profile.get("vehicleRcUrl"),
        "aadhaarUrl": profile.get("aadhaarUrl") or profile.get("idProofUrl"),
        "vehiclePhotoUrl": profile.get("vehiclePhotoUrl"),
        "kycDocuments": profile.get("kycDocuments") or profile.get("documents") or {},
        "upiId": profile.get("upiId"),
        "gender": profile.get("gender") or "Others",
        "rating": profile.get("rating") or profile.get("averageRating"),
        "lifetimeEarnings": profile.get("lifetime_earnings") or 0,
        "totalCompletedTrips": profile.get("total_completed_trips") or 0,
        "adminNotes": profile.get("adminNotes") or [],
        "createdAt": profile.get("createdAt"),
    }


FEEDBACK_SCORE_MAP: dict[str, int] = {
    "loved": 5,
    "good": 4,
    "decent": 3,
    "poor": 1,
}


def _compute_driver_rating_summary(rides: list[dict[str, Any]], profile: dict[str, Any]) -> dict[str, Any]:
    breakdown: dict[str, int] = {"loved": 0, "good": 0, "decent": 0, "poor": 0}
    scores: list[float] = []
    reasons: dict[str, int] = {}

    for r in rides:
        fb = r.get("feedback")
        if isinstance(fb, dict) and fb.get("submitted"):
            exp = str(fb.get("experience") or "").strip().lower()
            if exp in breakdown:
                breakdown[exp] += 1
                scores.append(float(FEEDBACK_SCORE_MAP[exp]))
            for reason in (fb.get("reasons") or []):
                clean_r = str(reason).strip()
                if clean_r:
                    reasons[clean_r] = reasons.get(clean_r, 0) + 1
        elif isinstance(r.get("driverRating") or r.get("rating"), (int, float)):
            scores.append(float(r.get("driverRating") or r.get("rating")))

    total_feedback = len(scores)
    if total_feedback > 0:
        avg_rating = round(sum(scores) / total_feedback, 2)
    else:
        prof_rating = profile.get("rating") or profile.get("averageRating")
        avg_rating = round(float(prof_rating), 2) if isinstance(prof_rating, (int, float)) else None

    top_reasons = [
        {"reason": k, "count": v}
        for k, v in sorted(reasons.items(), key=lambda x: x[1], reverse=True)[:5]
    ]
    return {
        "averageRating": avg_rating,
        "totalFeedbackCount": total_feedback,
        "breakdown": breakdown,
        "topReasons": top_reasons,
    }


@router.get("/drivers/{uid}")
def get_driver(uid: str, admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    db = _db()
    snap = db.collection("users").document(uid).get()
    if not snap.exists:
        raise ApiError("Driver not found.", 404)
    profile = _doc_dict(snap)
    if profile.get("role") != "driver":
        raise ApiError("This account is not a driver.", 400)

    try:
        recent_query = (
            db.collection("rides")
            .where("driver_id", "==", uid)
            .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            .limit(50)
        )
        all_driver_rides = [_doc_dict(d) for d in _stream(recent_query)]
    except Exception:
        try:
            all_driver_rides = [_doc_dict(d) for d in _stream(db.collection("rides").where("driver_id", "==", uid).limit(50))]
            all_driver_rides.sort(key=lambda r: str(r.get("createdAt") or ""), reverse=True)
        except Exception:
            all_driver_rides = []
    rating_summary = _compute_driver_rating_summary(all_driver_rides, profile)
    sanitized = _sanitize_driver(profile)
    if sanitized.get("rating") is None and rating_summary.get("averageRating") is not None:
        sanitized["rating"] = rating_summary["averageRating"]

    return {
        "ok": True,
        "driver": sanitized,
        "ratingSummary": rating_summary,
        "recentRides": all_driver_rides[:20],
    }


class DriverActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    notes: str = Field(default="", max_length=500)
    fields: Optional[dict[str, Any]] = None


@router.patch("/drivers/{uid}")
def update_driver(
    uid: str,
    body: DriverActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    valid_actions = {"approve", "reject", "suspend", "block", "unsuspend", "unblock", "update"}
    if body.action not in valid_actions:
        raise ApiError(f"Unknown action '{body.action}'.", 400)

    db = _db()
    ref = db.collection("users").document(uid)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Driver not found.", 404)
    before = _doc_dict(snap)
    current_status = before.get("verificationStatus") or "pending_review"

    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
    if body.action == "approve":
        if current_status != "pending_review":
            raise ApiError(f"Cannot approve a driver in '{current_status}' state.", 400)
        updates["verificationStatus"] = "approved"
        updates["approvalAcknowledged"] = False
        updates["approvedAt"] = fb_firestore.SERVER_TIMESTAMP
        updates["rejectionReason"] = None
        updates["suspensionReason"] = None
        updates["blockingReason"] = None
    elif body.action == "reject":
        if current_status != "pending_review":
            raise ApiError(f"Cannot reject a driver in '{current_status}' state.", 400)
        reason = str(body.notes or (body.fields and body.fields.get("rejectionReason")) or "").strip()
        if not reason:
            reason = "Application requirements were not met."
        updates["verificationStatus"] = "rejected"
        updates["rejectionReason"] = reason
        updates["rejectedAt"] = fb_firestore.SERVER_TIMESTAMP
        updates["driverAvailability"] = "offline"
        updates["desiredAvailability"] = "offline"
    elif body.action == "suspend":
        if current_status != "approved":
            raise ApiError(f"Cannot suspend a driver in '{current_status}' state.", 400)
        reason = str(body.notes or (body.fields and body.fields.get("suspensionReason")) or "").strip()
        updates["verificationStatus"] = "suspended"
        updates["suspensionReason"] = reason if reason else None
        updates["suspendedAt"] = fb_firestore.SERVER_TIMESTAMP
        updates["driverAvailability"] = "offline"
        updates["desiredAvailability"] = "offline"
    elif body.action == "block":
        if current_status != "approved":
            raise ApiError(f"Cannot block a driver in '{current_status}' state.", 400)
        reason = str(body.notes or (body.fields and body.fields.get("blockingReason")) or "").strip()
        updates["verificationStatus"] = "blocked"
        updates["blockingReason"] = reason if reason else None
        updates["blockedAt"] = fb_firestore.SERVER_TIMESTAMP
        updates["driverAvailability"] = "offline"
        updates["desiredAvailability"] = "offline"
    elif body.action == "unsuspend":
        if current_status != "suspended":
            raise ApiError(f"Cannot unsuspend a driver in '{current_status}' state.", 400)
        updates["verificationStatus"] = "approved"
        updates["suspensionReason"] = None
        updates["unsuspendedAt"] = fb_firestore.SERVER_TIMESTAMP
    elif body.action == "unblock":
        if current_status != "blocked":
            raise ApiError(f"Cannot unblock a driver in '{current_status}' state.", 400)
        updates["verificationStatus"] = "approved"
        updates["blockingReason"] = None
        updates["unblockedAt"] = fb_firestore.SERVER_TIMESTAMP
    elif body.action == "update":
        if not body.fields:
            raise ApiError("No fields provided for update.", 400)
        allowed = {"name", "email", "vehicleType", "vehicleNumber", "vehicleModel", "drivingLicenseNumber", "upiId"}
        for k, v in body.fields.items():
            if k in allowed and v is not None:
                updates[k] = str(v).strip()

    ref.set(updates, merge=True)

    # Sync presence if verificationStatus changed
    new_status = updates.get("verificationStatus")
    if new_status:
        presence_update: dict[str, Any] = {
            "verificationStatus": new_status,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        if new_status in ("rejected", "suspended", "blocked"):
            presence_update["driverAvailability"] = "offline"
            presence_update["desiredAvailability"] = "offline"
        db.collection("driverPresence").document(uid).set(presence_update, merge=True)
        db.collection("driverMapPresence").document(uid).set(
            {"verificationStatus": new_status, "updatedAt": fb_firestore.SERVER_TIMESTAMP},
            merge=True,
        )

    write_audit_log(admin_user, f"driver.{body.action}", "driver", uid, before, updates, body.notes)
    return {"ok": True, "driver": _sanitize_driver(_doc_dict(ref.get()))}


# ---------------------------------------------------------------------------
# Passengers (Restricted for Managers)
# ---------------------------------------------------------------------------

@router.get("/passengers")
def list_passengers(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    status: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("users").where("role", "==", "passenger")
    if status:
        if status not in PASSENGER_STATUSES:
            raise ApiError("Unknown passenger status filter.", 400)
        base = base.where("accountStatus", "==", status)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)

    items, next_cursor = _paginate_with_search(
        base, cursor, limit, "users", q, ["name", "phone", "email"]
    )
    return {"ok": True, "passengers": [_sanitize_passenger(i) for i in items], "nextCursor": next_cursor}


def _sanitize_passenger(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": profile.get("id") or profile.get("uid"),
        "name": profile.get("name"),
        "phone": profile.get("phone"),
        "email": profile.get("email"),
        "profilePhotoUrl": profile.get("profilePhotoUrl"),
        "gender": profile.get("gender") or "Others",
        "accountStatus": profile.get("accountStatus") or "active",
        "restrictionReason": profile.get("restrictionReason"),
        "blockingReason": profile.get("blockingReason"),
        "adminNotes": profile.get("adminNotes") or [],
        "createdAt": profile.get("createdAt"),
    }


@router.get("/passengers/{uid}")
def get_passenger(
    uid: str,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    snap = db.collection("users").document(uid).get()
    if not snap.exists:
        raise ApiError("Passenger not found.", 404)
    profile = _doc_dict(snap)
    if profile.get("role") not in ("passenger", None):
        raise ApiError("This account is not a passenger.", 400)

    # 1. Recent rides & lifetime statistics
    rides_docs: list[dict[str, Any]] = []
    try:
        rides_query = (
            db.collection("rides")
            .where("passenger_id", "==", uid)
            .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            .limit(50)
        )
        rides_docs = [_doc_dict(d) for d in _stream(rides_query)]
    except Exception:
        try:
            rides_docs = [_doc_dict(d) for d in _stream(db.collection("rides").where("passenger_id", "==", uid).limit(50))]
        except Exception:
            rides_docs = []

    rides_docs = _backfill_driver_names(rides_docs)
    total_rides = len(rides_docs)
    completed_rides = 0
    cancelled_by_passenger = 0
    cancelled_by_driver = 0
    total_spent = 0.0

    for r in rides_docs:
        st = str(r.get("status") or "").lower()
        if st == "completed":
            completed_rides += 1
            total_spent += float(r.get("fare") or 0)
        elif st == "cancelled_by_passenger":
            cancelled_by_passenger += 1
        elif st == "cancelled_by_driver":
            cancelled_by_driver += 1
        elif st.startswith("cancel"):
            cancelled_by_passenger += 1

    # 2. Wallet balance & transactions
    fallback_bal = round(float(profile.get("walletBalance") or 0.0), 2)
    wallet_data: dict[str, Any] = {
        "balance": fallback_bal,
        "balancePaise": int(round(fallback_bal * 100)),
        "lifetimeCredited": 0.0,
        "lifetimeDebited": 0.0,
        "transactions": [],
        "recentTransactions": [],
    }
    try:
        w_snap = db.collection("wallets").document(uid).get()
        if w_snap.exists:
            wd = _doc_dict(w_snap)
            bal_paise = int(wd.get("balancePaise") or 0)
            cred_paise = int(wd.get("lifetimeCreditPaise") or 0)
            deb_paise = int(wd.get("lifetimeDebitPaise") or 0)
            wallet_data["balancePaise"] = bal_paise
            wallet_data["balance"] = round(bal_paise / 100.0, 2)
            wallet_data["lifetimeCredited"] = round(cred_paise / 100.0, 2)
            wallet_data["lifetimeDebited"] = round(deb_paise / 100.0, 2)
    except Exception:
        pass

    raw_txs: list[dict[str, Any]] = []
    try:
        tx_query = (
            db.collection("walletTransactions")
            .where("userId", "==", uid)
            .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            .limit(15)
        )
        raw_txs = [_doc_dict(d) for d in _stream(tx_query)]
    except Exception:
        try:
            raw_txs = [_doc_dict(d) for d in _stream(db.collection("walletTransactions").where("userId", "==", uid).limit(15))]
            raw_txs.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
        except Exception:
            raw_txs = []

    normalized_txs: list[dict[str, Any]] = []
    for tx in raw_txs:
        if tx.get("amount") is None and tx.get("amountPaise") is not None:
            amt_inr = round(float(tx.get("amountPaise") or 0) / 100.0, 2)
            if str(tx.get("direction") or "").lower() == "debit" and amt_inr > 0:
                amt_inr = -amt_inr
            tx["amount"] = amt_inr
        normalized_txs.append(tx)

    wallet_data["transactions"] = normalized_txs
    wallet_data["recentTransactions"] = normalized_txs

    # 3. Redeemed coupons
    redeemed_coupons: list[dict[str, Any]] = []
    try:
        rc_docs = [_doc_dict(d) for d in _stream(db.collection("couponRedemptions").where("passengerId", "==", uid).limit(20))]
        redeemed_coupons = rc_docs
    except Exception:
        redeemed_coupons = []

    # 4. Associated SOS alerts / safety reports
    safety_events: list[dict[str, Any]] = []
    seen_safety_ids: set[str] = set()
    for field_name in ("passenger_id", "reporter_id", "userId"):
        try:
            for s in [_doc_dict(d) for d in _stream(db.collection("sosAlerts").where(field_name, "==", uid).limit(10))]:
                sid = str(s.get("id") or "")
                if sid not in seen_safety_ids:
                    seen_safety_ids.add(sid)
                    s["eventType"] = "sos_alert"
                    safety_events.append(s)
        except Exception:
            pass
    for field_name in ("reporterId", "reporter_id", "passenger_id"):
        try:
            for rep in [_doc_dict(d) for d in _stream(db.collection("safetyReports").where(field_name, "==", uid).limit(10))]:
                rid = str(rep.get("id") or "")
                if rid not in seen_safety_ids:
                    seen_safety_ids.add(rid)
                    rep["eventType"] = "safety_report"
                    safety_events.append(rep)
        except Exception:
            pass

    return {
        "ok": True,
        "passenger": _sanitize_passenger(profile),
        "rideStats": {
            "totalRides": total_rides,
            "completedRides": completed_rides,
            "cancelledByPassenger": cancelled_by_passenger,
            "cancelledByDriver": cancelled_by_driver,
            "totalSpent": round(total_spent, 2),
        },
        "wallet": wallet_data,
        "redeemedCoupons": redeemed_coupons,
        "safetyEvents": safety_events,
        "recentRides": rides_docs[:20],
    }


class PassengerActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    notes: str = Field(default="", max_length=500)


@router.patch("/passengers/{uid}")
def update_passenger(
    uid: str,
    body: PassengerActionBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    valid = {"restrict", "unrestrict", "block", "unblock", "add_note"}
    if body.action not in valid:
        raise ApiError("Unknown passenger action.", 400)

    db = _db()
    ref = db.collection("users").document(uid)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Passenger not found.", 404)
    before = _doc_dict(snap)

    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
    if body.action == "add_note":
        if not body.notes.strip():
            raise ApiError("Notes cannot be empty.", 400)
        existing_notes = before.get("adminNotes") or []
        if not isinstance(existing_notes, list):
            existing_notes = []
        new_note = {
            "byUid": admin_user.get("uid"),
            "byEmail": admin_user.get("email"),
            "text": body.notes.strip()[:500],
            "at": now_utc().isoformat(),
        }
        updates["adminNotes"] = [new_note] + existing_notes
    else:
        target_status = {
            "restrict": "restricted",
            "unrestrict": "active",
            "block": "blocked",
            "unblock": "active",
        }[body.action]
        updates["accountStatus"] = target_status
        if body.action == "restrict":
            updates["restrictionReason"] = body.notes.strip() or None
        elif body.action == "block":
            updates["blockingReason"] = body.notes.strip() or None
        elif body.action in ("unrestrict", "unblock"):
            updates["restrictionReason"] = None
            updates["blockingReason"] = None

    ref.set(updates, merge=True)
    write_audit_log(admin_user, f"passenger.{body.action}", "passenger", uid, before, updates, body.notes)
    return {"ok": True, "passenger": _sanitize_passenger(_doc_dict(ref.get()))}


# ---------------------------------------------------------------------------
# Rides (Live + History restricted for Managers)
# ---------------------------------------------------------------------------

def _initials(name: Optional[str], default: str = "LP") -> str:
    clean = str(name or "").strip()
    if not clean:
        return default
    parts = clean.split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return clean[:2].upper()


def _format_time_and_elapsed(dt_val: Any) -> tuple[str, str]:
    if not dt_val:
        return "--", "--"
    if isinstance(dt_val, (int, float)):
        dt = datetime.fromtimestamp(dt_val, tz=timezone.utc)
    elif isinstance(dt_val, str):
        try:
            dt = datetime.fromisoformat(dt_val.replace("Z", "+00:00"))
        except Exception:
            return dt_val, ""
    elif isinstance(dt_val, datetime):
        dt = dt_val
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    else:
        return "--", "--"

    now = now_utc()
    time_str = dt.strftime("%I:%M %p").lstrip("0")
    diff_sec = max(0, int((now - dt).total_seconds()))
    if diff_sec < 60:
        elapsed = "just now"
    elif diff_sec < 3600:
        mins = diff_sec // 60
        elapsed = f"{mins} min{'s' if mins > 1 else ''} ago"
    elif diff_sec < 86400:
        hours = diff_sec // 3600
        elapsed = f"{hours} hr{'s' if hours > 1 else ''} ago"
    else:
        days = diff_sec // 86400
        elapsed = f"{days} day{'s' if days > 1 else ''} ago"
    return time_str, elapsed


def _format_display_id(ride_id: str, ride_type: str = "single") -> str:
    clean = str(ride_id or "").replace("#", "").strip()
    prefix = "SR" if ride_type == "share" else "RD"
    digits = "".join(ch for ch in clean if ch.isdigit())
    if len(digits) >= 6:
        core = digits[-6:]
    elif len(clean) >= 6:
        core = clean[-6:].upper()
    else:
        core = clean.upper() or "784512"
    return f"#{prefix}-{core}"


def _build_live_hierarchy(db, rides_docs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    # 1. Backfill all parties (drivers and passengers)
    user_ids = set()
    for r in rides_docs:
        if r.get("driver_id"):
            user_ids.add(r["driver_id"])
        if r.get("passenger_id"):
            user_ids.add(r["passenger_id"])

    # Query active shareTrips as well
    share_trips = []
    try:
        st_query = db.collection("shareTrips").where("status", "in", ["active", "to_pickup", "en_route", "started", "pending"]).limit(50)
        share_trips = [_doc_dict(d) for d in _stream(st_query)]
        for st in share_trips:
            if st.get("driverId") or st.get("driver_id"):
                user_ids.add(st.get("driverId") or st.get("driver_id"))
    except Exception:
        share_trips = []

    user_profiles: dict[str, dict[str, Any]] = _batch_get_users(db, user_ids)

    for r in rides_docs:
        d_id = r.get("driver_id")
        if d_id and d_id in user_profiles:
            u = user_profiles[d_id]
            if not r.get("driver_name"):
                r["driver_name"] = u.get("name") or "Driver"
            if not r.get("driver_phone"):
                r["driver_phone"] = u.get("phone") or ""
            if not r.get("vehicle_number"):
                r["vehicle_number"] = u.get("vehicleNumber") or u.get("vehicle_number") or ""
            if not r.get("vehicle_type"):
                r["vehicle_type"] = u.get("vehicleType") or u.get("vehicle_type") or "auto"
        p_id = r.get("passenger_id")
        if p_id and p_id in user_profiles:
            u = user_profiles[p_id]
            if not r.get("passenger_name"):
                r["passenger_name"] = u.get("name") or "Passenger"
            if not r.get("passenger_phone"):
                r["passenger_phone"] = u.get("phone") or ""

    # Group rides by parentTripId
    share_grouped_rides: dict[str, list[dict[str, Any]]] = {}
    standalone_rides: list[dict[str, Any]] = []

    for r in rides_docs:
        p_trip_id = r.get("parentTripId")
        if p_trip_id:
            share_grouped_rides.setdefault(p_trip_id, []).append(r)
        else:
            standalone_rides.append(r)

    hierarchy: list[dict[str, Any]] = []
    share_trips_by_id = {st["id"]: st for st in share_trips}

    # Process all share trip groups
    all_share_trip_ids = set(share_grouped_rides.keys()) | set(share_trips_by_id.keys())
    for st_id in all_share_trip_ids:
        st_data = share_trips_by_id.get(st_id, {})
        child_rides = share_grouped_rides.get(st_id, [])
        d_id = st_data.get("driverId") or st_data.get("driver_id") or (child_rides[0].get("driver_id") if child_rides else None)
        d_profile = user_profiles.get(d_id, {}) if d_id else {}
        d_name = st_data.get("driverName") or (child_rides[0].get("driver_name") if child_rides else None) or d_profile.get("name") or "Driver"
        d_phone = d_profile.get("phone") or (child_rides[0].get("driver_phone") if child_rides else "")
        v_num = d_profile.get("vehicleNumber") or d_profile.get("vehicle_number") or (child_rides[0].get("vehicle_number") if child_rides else "TR 01 AB 1234")
        v_type = (child_rides[0].get("vehicle_type") if child_rides else None) or d_profile.get("vehicleType") or "auto"

        max_seats = int(st_data.get("maxSeats") or 3)
        joined_count = len(child_rides) or int(st_data.get("seatsUsed") or 1)
        parent_display_id = _format_display_id(st_id, "share")

        pickup_name = (child_rides[0].get("pickup_name") if child_rides else None) or st_data.get("pickup_name") or "Ramakrishna palli"
        drop_name = (child_rides[-1].get("drop_name") if child_rides else None) or st_data.get("drop_name") or "Battala, Agartala"
        pickup_lat = child_rides[0].get("pickup_lat") if child_rides else st_data.get("pickup_lat")
        pickup_lng = child_rides[0].get("pickup_lng") if child_rides else st_data.get("pickup_lng")
        drop_lat = child_rides[-1].get("drop_lat") if child_rides else st_data.get("drop_lat")
        drop_lng = child_rides[-1].get("drop_lng") if child_rides else st_data.get("drop_lng")
        drv_loc = (child_rides[0].get("driverLocation") if child_rides else None) or st_data.get("driverLocation")

        st_created = st_data.get("createdAt") or (child_rides[0].get("createdAt") if child_rides else now_utc())
        time_str, elapsed_str = _format_time_and_elapsed(st_created)

        # Build child objects
        child_items = []
        for idx, cr in enumerate(child_rides):
            c_display_id = f"{parent_display_id}-{idx + 1}"
            c_time, c_elapsed = _format_time_and_elapsed(cr.get("createdAt") or st_created)
            p_name = cr.get("passenger_name") or "Passenger"
            p_phone = cr.get("passenger_phone") or ""
            child_items.append({
                "id": cr["id"],
                "displayId": c_display_id,
                "isChild": True,
                "parentId": st_id,
                "parentDisplayId": parent_display_id,
                "rideType": "share",
                "vehicleType": v_type,
                "passenger": {
                    "id": cr.get("passenger_id"),
                    "name": p_name,
                    "phone": p_phone,
                    "initials": _initials(p_name),
                },
                "driver": {
                    "id": d_id,
                    "name": d_name,
                    "phone": d_phone,
                    "plate": v_num,
                    "initials": _initials(d_name),
                },
                "route": {
                    "pickup": cr.get("pickup_name") or pickup_name,
                    "drop": cr.get("drop_name") or drop_name,
                    "pickup_lat": cr.get("pickup_lat") or pickup_lat,
                    "pickup_lng": cr.get("pickup_lng") or pickup_lng,
                    "drop_lat": cr.get("drop_lat") or drop_lat,
                    "drop_lng": cr.get("drop_lng") or drop_lng,
                },
                "status": "On Trip" if cr.get("status") in ACTIVE_RIDE_STATUSES else (cr.get("status") or "On Trip"),
                "rawStatus": cr.get("status"),
                "startedAt": c_time,
                "elapsedText": c_elapsed,
                "driverLocation": cr.get("driverLocation") or drv_loc,
            })

        parent_status = "Finding Riders" if joined_count < max_seats and st_data.get("status") == "pending" else "On Trip"
        hierarchy.append({
            "id": st_id,
            "displayId": parent_display_id,
            "isParent": True,
            "rideType": "share",
            "vehicleType": v_type,
            "description": f"Share Ride • {max_seats} passengers ({joined_count}/{max_seats} joined)",
            "driver": {
                "id": d_id,
                "name": d_name,
                "phone": d_phone,
                "plate": v_num,
                "initials": _initials(d_name),
            },
            "passengers": {
                "count": joined_count,
                "capacity": max_seats,
                "label": f"{joined_count} / {max_seats}",
                "pct": min(100, int((joined_count / max_seats) * 100)),
            },
            "route": {
                "pickup": pickup_name,
                "drop": drop_name,
                "pickup_lat": pickup_lat,
                "pickup_lng": pickup_lng,
                "drop_lat": drop_lat,
                "drop_lng": drop_lng,
            },
            "status": parent_status,
            "startedAt": time_str,
            "elapsedText": elapsed_str,
            "childRides": child_items,
            "driverLocation": drv_loc,
        })

    # Process standalone / single rides (each has 1 child representing its passenger)
    for sr in standalone_rides:
        is_share = sr.get("rideType") == "share"
        v_type = (sr.get("vehicle_type") or "auto").lower()
        v_label = "Bike / Scooty" if v_type == "bike" else (v_type.capitalize() or "Auto")
        max_seats = 1 if v_type == "bike" else (3 if v_type == "auto" else 4)
        joined_count = 1
        parent_display_id = _format_display_id(sr["id"], "share" if is_share else "single")

        d_id = sr.get("driver_id")
        d_name = sr.get("driver_name") or "Unassigned Driver"
        d_phone = sr.get("driver_phone") or ""
        v_num = sr.get("vehicle_number") or ""
        p_name = sr.get("passenger_name") or "Passenger"
        p_phone = sr.get("passenger_phone") or ""

        pickup_name = sr.get("pickup_name") or "Pickup"
        drop_name = sr.get("drop_name") or "Drop"
        time_str, elapsed_str = _format_time_and_elapsed(sr.get("createdAt") or sr.get("updatedAt"))

        c_display_id = f"{parent_display_id}-1"
        child_item = {
            "id": sr["id"],
            "displayId": c_display_id,
            "isChild": True,
            "parentId": sr["id"],
            "parentDisplayId": parent_display_id,
            "rideType": "share" if is_share else "single",
            "vehicleType": v_type,
            "passenger": {
                "id": sr.get("passenger_id"),
                "name": p_name,
                "phone": p_phone,
                "initials": _initials(p_name),
            },
            "driver": {
                "id": d_id,
                "name": d_name,
                "phone": d_phone,
                "plate": v_num,
                "initials": _initials(d_name),
            },
            "route": {
                "pickup": pickup_name,
                "drop": drop_name,
                "pickup_lat": sr.get("pickup_lat"),
                "pickup_lng": sr.get("pickup_lng"),
                "drop_lat": sr.get("drop_lat"),
                "drop_lng": sr.get("drop_lng"),
            },
            "status": "On Trip" if sr.get("status") in ACTIVE_RIDE_STATUSES else (sr.get("status") or "On Trip"),
            "rawStatus": sr.get("status"),
            "startedAt": time_str,
            "elapsedText": elapsed_str,
            "driverLocation": sr.get("driverLocation"),
        }

        hierarchy.append({
            "id": sr["id"],
            "displayId": parent_display_id,
            "isParent": True,
            "rideType": "share" if is_share else "single",
            "vehicleType": v_type,
            "description": f"{v_label} • {max_seats} passenger{'s' if max_seats > 1 else ''}",
            "driver": {
                "id": d_id,
                "name": d_name,
                "phone": d_phone,
                "plate": v_num,
                "initials": _initials(d_name),
            },
            "passengers": {
                "count": joined_count,
                "capacity": max_seats,
                "label": f"{joined_count} / {max_seats}",
                "pct": min(100, int((joined_count / max_seats) * 100)),
            },
            "route": {
                "pickup": pickup_name,
                "drop": drop_name,
                "pickup_lat": sr.get("pickup_lat"),
                "pickup_lng": sr.get("pickup_lng"),
                "drop_lat": sr.get("drop_lat"),
                "drop_lng": sr.get("drop_lng"),
            },
            "status": "On Trip" if sr.get("status") in ACTIVE_RIDE_STATUSES else (sr.get("status") or "On Trip"),
            "startedAt": time_str,
            "elapsedText": elapsed_str,
            "childRides": [child_item],
            "driverLocation": sr.get("driverLocation"),
        })

    # Compute tab counts
    single_count = sum(1 for h in hierarchy if h.get("rideType") != "share")
    share_count = sum(1 for h in hierarchy if h.get("rideType") == "share")
    child_count = sum(len(h.get("childRides", [])) for h in hierarchy)
    all_count = len(hierarchy) + child_count

    counts = {
        "all": all_count or len(hierarchy),
        "single": single_count,
        "share": share_count,
        "child": child_count,
        "parent": len(hierarchy),
    }

    return hierarchy, counts


@router.get("/rides/live")
def list_live_rides(admin_user: dict[str, Any] = Depends(require_admin_or_super_admin)) -> dict[str, Any]:
    db = _db()
    try:
        query = (
            db.collection("rides")
            .where("status", "in", ACTIVE_RIDE_STATUSES)
            .order_by("updatedAt", direction=fb_firestore.Query.DESCENDING)
            .limit(100)
        )
        docs = [_doc_dict(d) for d in _stream(query)]
    except ApiError as err:
        if err.status_code == 503:
            query = (
                db.collection("rides")
                .where("status", "in", ACTIVE_RIDE_STATUSES)
                .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
                .limit(100)
            )
            docs = [_doc_dict(d) for d in _stream(query)]
            docs.sort(key=lambda r: str(r.get("updatedAt") or r.get("createdAt") or ""), reverse=True)
        else:
            raise err

    backfilled_rides = _backfill_driver_names(docs)
    hierarchy, counts = _build_live_hierarchy(db, backfilled_rides)
    return {
        "ok": True,
        "rides": backfilled_rides,
        "hierarchy": hierarchy,
        "counts": counts,
    }


@router.get("/waiting-pools")
def list_waiting_pools(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    now = now_utc()
    now_ts = now.timestamp()

    # 1. Fetch Passengers in Waiting Passenger Pool (dispatchWPP)
    wpp_docs = [_doc_dict(d) for d in _stream(db.collection("dispatchWPP"))]

    # Also include pending unassigned rides from rides collection if any
    pending_rides = []
    try:
        pr_query = db.collection("rides").where("status", "==", "pending").limit(50)
        pending_rides = [_doc_dict(d) for d in _stream(pr_query)]
    except Exception:
        pending_rides = []

    seen_pids = {p.get("passenger_id") or p.get("id") for p in wpp_docs}
    for pr in pending_rides:
        p_id = pr.get("passenger_id")
        if p_id and p_id not in seen_pids:
            seen_pids.add(p_id)
            wpp_docs.append({
                "id": p_id,
                "passenger_id": p_id,
                "pickup": {"name": pr.get("pickup_name") or "Pickup", "lat": pr.get("pickup_lat"), "lng": pr.get("pickup_lng")},
                "drop": {"name": pr.get("drop_name") or "Drop", "lat": pr.get("drop_lat"), "lng": pr.get("drop_lng")},
                "vehicle_type": pr.get("vehicle_type") or "auto",
                "wants_share": pr.get("rideType") == "share",
                "fare": pr.get("fare") or 0.0,
                "created_at": pr.get("createdAt") or pr.get("updatedAt") or now_ts,
                "state": "WAITING",
                "ride_id": pr.get("id"),
            })

    # 2. Fetch Drivers in Driver Availability Pool (dispatchDAP) & Online Users
    dap_docs = [_doc_dict(d) for d in _stream(db.collection("dispatchDAP"))]

    online_drivers = []
    try:
        od_query = db.collection("users").where("role", "==", "driver").where("verificationStatus", "==", "approved")
        for d in _stream(od_query):
            data = _doc_dict(d)
            if str(data.get("driverAvailability") or "").lower() in ("online", "searching"):
                online_drivers.append(data)
    except Exception:
        online_drivers = []

    seen_dids = {d.get("driver_id") or d.get("id") for d in dap_docs}
    for od in online_drivers:
        d_id = od.get("id")
        if d_id and d_id not in seen_dids:
            seen_dids.add(d_id)
            dap_docs.append({
                "id": d_id,
                "driver_id": d_id,
                "name": od.get("name"),
                "phone": od.get("phone"),
                "vehicleNumber": od.get("vehicleNumber") or od.get("vehicle_number"),
                "vehicleType": od.get("vehicleType") or od.get("vehicle_type"),
                "state": "IDLE",
                "pool": "IDLE",
                "idle_since": now_ts - 300,
                "loc": od.get("lastLocation") or od.get("location") or {"lat": 23.8315, "lng": 91.2868},
            })

    # Batch-fetch all user profiles (passengers + drivers) in one shot
    p_uids = [p.get("passenger_id") or p.get("id") for p in wpp_docs if (p.get("passenger_id") or p.get("id"))]
    d_uids = [d.get("driver_id") or d.get("id") for d in dap_docs if (d.get("driver_id") or d.get("id"))]
    user_docs: dict[str, dict[str, Any]] = _batch_get_users(db, set(p_uids) | set(d_uids))

    passengers_list = []
    for p in wpp_docs:
        pid = p.get("passenger_id") or p.get("id")
        u = user_docs.get(pid, {})
        p_name = u.get("name") or p.get("name") or "Passenger"
        p_phone = u.get("phone") or p.get("phone") or ""

        created = p.get("created_at") or p.get("req_time") or p.get("createdAt") or now_ts
        if isinstance(created, (int, float)):
            wait_sec = max(0, int(now_ts - created))
            since_dt = datetime.fromtimestamp(created, tz=timezone.utc)
        elif isinstance(created, datetime):
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            wait_sec = max(0, int((now - created).total_seconds()))
            since_dt = created
        else:
            wait_sec = 0
            since_dt = now

        wait_mins = max(1, wait_sec // 60)
        since_time = since_dt.strftime("%I:%M %p").lstrip("0")

        v_type = str(p.get("vehicle_type") or "auto").lower()
        if p.get("wants_share") or v_type == "share":
            type_label = "Share"
        elif v_type == "bike":
            type_label = "Bike"
        else:
            type_label = "Auto"

        pickup_data = p.get("pickup") or {}
        drop_data = p.get("drop") or {}
        pickup_loc = pickup_data.get("name") or pickup_data.get("address") or "Pickup Location"
        drop_loc = drop_data.get("name") or drop_data.get("address") or "Drop Location"

        badge_color = "danger" if wait_mins >= 20 else ("warning" if wait_mins >= 5 else "success")
        passengers_list.append({
            "id": pid,
            "passenger_id": pid,
            "name": p_name,
            "phone": p_phone,
            "initials": _initials(p_name, "PA"),
            "type": type_label,
            "vehicleType": v_type,
            "wantsShare": bool(p.get("wants_share") or v_type == "share"),
            "pickupLocation": pickup_loc,
            "pickup_lat": pickup_data.get("lat"),
            "pickup_lng": pickup_data.get("lng"),
            "dropLocation": drop_loc,
            "drop_lat": drop_data.get("lat"),
            "drop_lng": drop_data.get("lng"),
            "fare": float(p.get("fare") or 0.0),
            "waitingSince": since_time,
            "waitingSinceIso": since_dt.isoformat(),
            "waitTimeMinutes": wait_mins,
            "waitTimeText": f"{wait_mins} min",
            "urgencyBadge": badge_color,
            "state": p.get("state") or "WAITING",
            "ride_id": p.get("ride_id"),
        })

    # Sort oldest waiting first by default
    passengers_list.sort(key=lambda x: x["waitTimeMinutes"], reverse=True)

    drivers_list = []
    for d in dap_docs:
        did = d.get("driver_id") or d.get("id")
        u_prof = user_docs.get(did, {})

        d_name = d.get("name") or u_prof.get("name") or "Driver"
        d_phone = d.get("phone") or u_prof.get("phone") or ""
        v_num = d.get("vehicleNumber") or d.get("vehicle_number") or u_prof.get("vehicleNumber") or u_prof.get("vehicle_number") or "TR 01 AB 1234"
        raw_v_type = str(d.get("vehicleType") or d.get("vehicle_type") or u_prof.get("vehicleType") or u_prof.get("vehicle_type") or "auto").lower()
        v_type = "Bike" if raw_v_type == "bike" else "Auto"

        idle_val = d.get("idle_since") or d.get("idleSince") or now_ts
        if isinstance(idle_val, (int, float)):
            idle_sec = max(0, int(now_ts - idle_val))
        elif isinstance(idle_val, datetime):
            if idle_val.tzinfo is None:
                idle_val = idle_val.replace(tzinfo=timezone.utc)
            idle_sec = max(0, int((now - idle_val).total_seconds()))
        else:
            idle_sec = 0

        idle_mins = max(1, idle_sec // 60)
        idle_color = "danger" if idle_mins >= 20 else ("warning" if idle_mins >= 8 else "success")

        loc_data = d.get("loc") or {}
        curr_loc_name = d.get("currentLocation") or d.get("locationName") or u_prof.get("locationName") or "Ramakrishna palli, West Tripura"

        drivers_list.append({
            "id": did,
            "driver_id": did,
            "name": d_name,
            "phone": d_phone,
            "plate": v_num,
            "vehicleType": v_type,
            "initials": _initials(d_name, "DR"),
            "currentLocation": curr_loc_name,
            "lat": loc_data.get("lat"),
            "lng": loc_data.get("lng"),
            "idleTimeMinutes": idle_mins,
            "idleTimeText": f"{idle_mins} min",
            "idleBadge": idle_color,
            "state": d.get("state") or "IDLE",
            "seatsFree": d.get("seats_free") or d.get("seatsFree") or 1,
        })

    # Sort longest idle first by default
    drivers_list.sort(key=lambda x: x["idleTimeMinutes"], reverse=True)

    total_pool_count = len(passengers_list) + len(drivers_list)
    return {
        "ok": True,
        "passengers": passengers_list,
        "drivers": drivers_list,
        "counts": {
            "passengers": len(passengers_list),
            "drivers": len(drivers_list),
            "total": total_pool_count,
        },
    }


class ManualAssignBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    passengerId: Optional[str] = Field(default=None, max_length=128)
    passenger_id: Optional[str] = Field(default=None, max_length=128)
    driverId: Optional[str] = Field(default=None, max_length=128)
    driver_id: Optional[str] = Field(default=None, max_length=128)
    rideId: Optional[str] = Field(default=None, max_length=128)
    ride_id: Optional[str] = Field(default=None, max_length=128)
    notes: Optional[str] = Field(default="", max_length=500)


WaitingPoolAssignBody = ManualAssignBody


@router.post("/waiting-pools/assign")
def assign_waiting_pool_passenger(
    body: ManualAssignBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    now = now_utc()
    now_ts = now.timestamp()
    passenger_id = (body.passengerId or body.passenger_id or "").strip()
    driver_id = (body.driverId or body.driver_id or "").strip()

    if not passenger_id or not driver_id:
        raise ApiError("Both passengerId and driverId are required.", 400)

    # Fetch WPP entry if present
    wpp_ref = db.collection("dispatchWPP").document(passenger_id)
    wpp_snap = wpp_ref.get()
    wpp_data = _doc_dict(wpp_snap) if wpp_snap.exists else {}

    # Check if there is an existing pending/searching ride for this passenger
    ride_id = (body.rideId or body.ride_id or wpp_data.get("ride_id") or "").strip()
    ride_ref = None
    ride_before: dict[str, Any] = {}
    if ride_id:
        candidate_ref = db.collection("rides").document(ride_id)
        candidate_snap = candidate_ref.get()
        if candidate_snap.exists:
            ride_ref = candidate_ref
            ride_before = _doc_dict(candidate_snap)

    if ride_ref is None:
        try:
            pending_docs = list(
                _stream(
                    db.collection("rides")
                    .where("passenger_id", "==", passenger_id)
                    .where("status", "in", ["pending", "searching"])
                    .limit(1)
                )
            )
            if pending_docs:
                ride_ref = pending_docs[0].reference
                ride_before = _doc_dict(pending_docs[0])
                ride_id = ride_before.get("id") or pending_docs[0].id
        except Exception:
            pass

    if not wpp_snap.exists and ride_ref is None:
        raise ApiError("Waiting passenger entry not found in pool or pending rides.", 404)

    # Fetch driver & passenger user profiles
    profiles = _batch_get_users(db, [passenger_id, driver_id])
    drv_profile = profiles.get(driver_id, {})
    dap_snap = db.collection("dispatchDAP").document(driver_id).get()
    dap_data = _doc_dict(dap_snap) if dap_snap.exists else {}

    if not drv_profile and not dap_data:
        raise ApiError("Driver not found.", 404)

    pax_profile = profiles.get(passenger_id, {})
    d_name = drv_profile.get("name") or dap_data.get("name") or "Driver"
    d_phone = drv_profile.get("phone") or dap_data.get("phone") or ""
    v_num = (
        drv_profile.get("vehicleNumber")
        or drv_profile.get("vehicle_number")
        or dap_data.get("vehicleNumber")
        or dap_data.get("vehicle_number")
        or ""
    )
    v_type = (
        drv_profile.get("vehicleType")
        or drv_profile.get("vehicle_type")
        or dap_data.get("vehicleType")
        or dap_data.get("vehicle_type")
        or wpp_data.get("vehicle_type")
        or ride_before.get("vehicle_type")
        or "auto"
    )
    p_name = pax_profile.get("name") or wpp_data.get("name") or ride_before.get("passenger_name") or "Passenger"
    p_phone = pax_profile.get("phone") or wpp_data.get("phone") or ride_before.get("passenger_phone") or ""

    pickup = wpp_data.get("pickup") or {}
    drop = wpp_data.get("drop") or {}
    wants_share = bool(wpp_data.get("wants_share") or ride_before.get("rideType") == "share")

    ride_updates: dict[str, Any] = {
        "status": "accepted",
        "driver_id": driver_id,
        "driver_name": d_name,
        "driver_phone": d_phone,
        "vehicle_number": v_num,
        "vehicle_type": str(v_type).lower(),
        "passenger_id": passenger_id,
        "passenger_name": p_name,
        "passenger_phone": p_phone,
        "assignedByAdmin": True,
        "assignedByAdminUid": admin_user.get("uid"),
        "acceptedAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }

    if ride_ref is not None:
        ride_ref.set(ride_updates, merge=True)
    else:
        ride_ref = db.collection("rides").document()
        ride_id = ride_ref.id
        new_ride_doc = {
            **ride_updates,
            "rideType": "share" if wants_share else "single",
            "pickup_name": pickup.get("name") or pickup.get("address") or "Pickup",
            "pickup_lat": pickup.get("lat"),
            "pickup_lng": pickup.get("lng"),
            "drop_name": drop.get("name") or drop.get("address") or "Drop",
            "drop_lat": drop.get("lat"),
            "drop_lng": drop.get("lng"),
            "fare": float(wpp_data.get("fare") or 0.0),
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        }
        ride_ref.set(new_ride_doc)

    # Remove passenger from dispatchWPP
    if wpp_snap.exists:
        try:
            wpp_ref.delete()
        except Exception:
            pass

    # Update driver state in dispatchDAP and driverPresence
    if dap_snap.exists:
        try:
            db.collection("dispatchDAP").document(driver_id).set(
                {"state": "BUSY", "updated_at": now_ts}, merge=True
            )
        except Exception:
            pass
    try:
        db.collection("driverPresence").document(driver_id).set(
            {"driverAvailability": "busy", "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True
        )
    except Exception:
        pass

    write_audit_log(
        admin_user,
        "dispatch.manual_assign",
        "waiting_pool",
        passenger_id,
        wpp_data or ride_before,
        {"driverId": driver_id, "rideId": ride_id, "status": "accepted"},
        body.notes or f"Manually assigned driver {d_name} ({driver_id}) to passenger {p_name} ({passenger_id})",
    )
    return {
        "ok": True,
        "rideId": ride_id,
        "passengerId": passenger_id,
        "driverId": driver_id,
        "driverName": d_name,
        "passengerName": p_name,
        "message": f"Driver {d_name} assigned to {p_name}.",
    }


@router.delete("/waiting-pools/passengers/{passenger_id}")
def remove_waiting_pool_passenger(
    passenger_id: str,
    notes: Optional[str] = Query(default=""),
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    clean_pid = passenger_id.strip()
    if not clean_pid:
        raise ApiError("Invalid passenger_id.", 400)

    wpp_ref = db.collection("dispatchWPP").document(clean_pid)
    wpp_snap = wpp_ref.get()
    before_data = _doc_dict(wpp_snap) if wpp_snap.exists else {}
    removed_wpp = False
    if wpp_snap.exists:
        wpp_ref.delete()
        removed_wpp = True

    cancelled_rides: list[str] = []
    try:
        pending_docs = list(
            _stream(
                db.collection("rides")
                .where("passenger_id", "==", clean_pid)
                .where("status", "in", ["pending", "searching"])
                .limit(10)
            )
        )
        for pd in pending_docs:
            pd.reference.set(
                {
                    "status": "cancelled_by_passenger",
                    "cancellationReason": "Removed from waiting pool by administrator",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            cancelled_rides.append(pd.id)
    except Exception:
        pass

    if not removed_wpp and not cancelled_rides:
        raise ApiError("Waiting passenger not found in pool.", 404)

    write_audit_log(
        admin_user,
        "dispatch.remove_waiting_passenger",
        "waiting_pool",
        clean_pid,
        before_data,
        {"removedFromWpp": removed_wpp, "cancelledRides": cancelled_rides},
        notes or "Removed from waiting pool by admin",
    )
    return {
        "ok": True,
        "passengerId": clean_pid,
        "cancelledRides": cancelled_rides,
        "message": "Passenger removed from waiting pool.",
    }


@router.get("/live-map")
def get_live_fleet_map(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    """Unified God-View live fleet & demand map data: online/busy drivers, waiting passengers, and active rides."""
    pools_resp = list_waiting_pools(admin_user=admin_user)
    live_resp = list_live_rides(admin_user=admin_user)

    waiting_passengers = pools_resp.get("passengers") or []
    idle_drivers = pools_resp.get("drivers") or []
    active_hierarchy = live_resp.get("hierarchy") or []

    drivers_by_id: dict[str, dict[str, Any]] = {}
    for d in idle_drivers:
        did = d.get("driver_id") or d.get("id")
        if not did:
            continue
        drivers_by_id[did] = {
            "id": did,
            "name": d.get("name") or "Driver",
            "phone": d.get("phone") or "",
            "plate": d.get("plate") or "",
            "vehicleType": str(d.get("vehicleType") or "Auto").lower(),
            "status": "online",
            "lat": d.get("lat"),
            "lng": d.get("lng"),
            "currentLocation": d.get("currentLocation") or "",
            "idleTimeText": d.get("idleTimeText") or "",
            "seatsFree": d.get("seatsFree") or 1,
        }

    # Overlay busy drivers from active rides
    for h in active_hierarchy:
        drv = h.get("driver") or {}
        did = drv.get("id")
        if not did:
            continue
        drv_loc = h.get("driverLocation") or {}
        route = h.get("route") or {}
        lat = drv_loc.get("lat") if isinstance(drv_loc, dict) else None
        lng = drv_loc.get("lng") if isinstance(drv_loc, dict) else None
        if lat is None or lng is None:
            lat = route.get("pickup_lat")
            lng = route.get("pickup_lng")
        existing = drivers_by_id.get(did, {})
        drivers_by_id[did] = {
            "id": did,
            "name": drv.get("name") or existing.get("name") or "Driver",
            "phone": drv.get("phone") or existing.get("phone") or "",
            "plate": drv.get("plate") or existing.get("plate") or "",
            "vehicleType": str(h.get("vehicleType") or existing.get("vehicleType") or "auto").lower(),
            "status": "busy",
            "lat": lat if lat is not None else existing.get("lat"),
            "lng": lng if lng is not None else existing.get("lng"),
            "currentLocation": route.get("pickup") or existing.get("currentLocation") or "",
            "activeRideId": h.get("id"),
            "activeRideDisplayId": h.get("displayId"),
            "seatsFree": max(0, int((h.get("passengers") or {}).get("capacity", 1)) - int((h.get("passengers") or {}).get("count", 1))),
        }

    all_drivers = list(drivers_by_id.values())
    online_count = sum(1 for d in all_drivers if d.get("status") == "online")
    busy_count = sum(1 for d in all_drivers if d.get("status") == "busy")

    return {
        "ok": True,
        "drivers": all_drivers,
        "waitingPassengers": waiting_passengers,
        "activeRides": active_hierarchy,
        "counts": {
            "onlineDrivers": online_count,
            "busyDrivers": busy_count,
            "totalDrivers": len(all_drivers),
            "waitingPassengers": len(waiting_passengers),
            "activeRides": len(active_hierarchy),
        },
    }


@router.get("/rides/history")
def list_ride_history(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    status: Optional[str] = Query(default=None),
    vehicleType: Optional[str] = Query(default=None),
    rideType: Optional[str] = Query(default=None),
    hasFeedback: Optional[bool] = Query(default=None),
    dateFrom: Optional[str] = Query(default=None),
    dateTo: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("rides")

    if status:
        allowed = RIDE_STATUS_GROUPS.get(status, [status])
        if allowed:
            base = base.where("status", "in", allowed)
    if vehicleType:
        base = base.where("vehicle_type", "==", vehicleType)
    if rideType:
        base = base.where("rideType", "==", rideType)
    if hasFeedback is not None:
        base = base.where("feedback.submitted", "==", hasFeedback)

    if dateFrom and dateTo:
        base = base.where("createdAt", ">=", _day_range_utc(dateFrom, "dateFrom")).where(
            "createdAt", "<", _day_range_utc(dateTo, "dateTo")
        )
    elif dateFrom:
        base = base.where("createdAt", ">=", _day_range_utc(dateFrom, "dateFrom"))

    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate_with_search(
        base,
        cursor,
        limit,
        "rides",
        q,
        ["id", "driver_name", "passenger_name", "pickup_name", "drop_name", "passenger_id", "driver_id"],
        pre_search_transform=_backfill_driver_names,
    )
    if not (q and q.strip()):
        items = _backfill_driver_names(items)
    return {"ok": True, "rides": items, "nextCursor": next_cursor}


@router.get("/rides/{ride_id}")
def get_admin_ride(
    ride_id: str,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("rides").document(ride_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Ride not found.", 404)
    ride = _doc_dict(snap)
    sibling_rides = []
    parent_trip_id = ride.get("parentTripId")
    if parent_trip_id:
        try:
            s_docs = db.collection("rides").where("parentTripId", "==", parent_trip_id).stream()
            for s in s_docs:
                if s.id != ride_id:
                    s_data = s.to_dict() or {}
                    sibling_rides.append({
                        "rideId": s.id,
                        "passenger_name": s_data.get("passenger_name") or "Passenger",
                        "seatOrder": s_data.get("seatOrder") or 1,
                        "status": s_data.get("status"),
                        "fare": s_data.get("fare"),
                        "pickup_name": s_data.get("pickup_name"),
                        "drop_name": s_data.get("drop_name"),
                    })
        except Exception:
            pass
    ride["siblingChildRides"] = sibling_rides
    return {"ok": True, "ride": ride, "siblingChildRides": sibling_rides}


class RideActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    fare: Optional[float] = None
    notes: Optional[str] = Field(default=None, max_length=500)
    cancel_all_children: Optional[bool] = False
    cancelAllChildren: Optional[bool] = False


@router.patch("/rides/{ride_id}")
def update_ride(
    ride_id: str,
    body: RideActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("rides").document(ride_id)
    snap = ref.get()

    # Support canceling a parent shareTrip doc directly if ride_id is a shareTrip ID
    if not snap.exists:
        st_ref = db.collection("shareTrips").document(ride_id)
        st_snap = st_ref.get()
        if st_snap.exists and body.action == "cancel":
            st_data = _doc_dict(st_snap)
            st_ref.set({
                "status": "cancelled",
                "seatsUsed": 0,
                "endedAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }, merge=True)
            # Cancel all child rides in this parent trip
            child_docs = db.collection("rides").where("parentTripId", "==", ride_id).stream()
            for cd in child_docs:
                cd.reference.set({
                    "status": "cancelled_by_passenger",
                    "cancellationReason": "Cancelled by administrator",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                }, merge=True)

            d_id = str(st_data.get("driverId") or st_data.get("driver_id") or "").strip()
            if d_id:
                try:
                    from ..services.db import (
                        driver_has_open_share_trips,
                        driver_has_other_active_rides,
                        update_driver_presence_synchronized,
                    )
                    has_active = driver_has_other_active_rides(db, d_id)
                    has_share = driver_has_open_share_trips(db, d_id, exclude_trip_id=ride_id)
                    if not has_active and not has_share:
                        drv_doc = db.collection("users").document(d_id).get()
                        drv_profile = drv_doc.to_dict() or {} if drv_doc.exists else {}
                        avail_status = "offline"
                        if (
                            str(drv_profile.get("desiredAvailability") or "").strip().lower() != "offline"
                            and str(drv_profile.get("driverAvailability") or "").strip().lower() != "offline"
                        ):
                            avail_status = "searching"
                        update_driver_presence_synchronized(
                            db,
                            d_id,
                            availability=avail_status,
                            desired_availability=drv_profile.get("desiredAvailability"),
                            profile_data={**drv_profile, "uid": d_id},
                        )
                except Exception:
                    pass

            write_audit_log(admin_user, "ride.cancel_parent", "shareTrip", ride_id, st_data, {"status": "cancelled"}, body.notes or "")
            return {"ok": True, "message": "Share trip cancelled.", "id": ride_id}
        raise ApiError("Ride not found.", 404)

    before = _doc_dict(snap)
    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}

    if body.action == "cancel":
        if before.get("status") in TERMINAL_RIDE_STATUSES:
            raise ApiError("Ride is already in a terminal state.", 400)
        updates["status"] = "cancelled_by_passenger"
        updates["cancellationReason"] = "Cancelled by administrator"
        updates["cancelledAt"] = fb_firestore.SERVER_TIMESTAMP

        parent_trip_id = before.get("parentTripId")
        cancel_entire_parent = body.cancel_all_children or body.cancelAllChildren
        parent_was_cancelled = False

        if parent_trip_id and cancel_entire_parent:
            # Cancel entire parent trip and all sibling child rides
            try:
                parent_ref = db.collection("shareTrips").document(parent_trip_id)
                parent_ref.set({
                    "status": "cancelled",
                    "seatsUsed": 0,
                    "endedAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                }, merge=True)
                parent_was_cancelled = True
                s_docs = db.collection("rides").where("parentTripId", "==", parent_trip_id).stream()
                for sd in s_docs:
                    if sd.id != ride_id:
                        sd.reference.set({
                            "status": "cancelled_by_passenger",
                            "cancellationReason": "Cancelled by administrator",
                            "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                        }, merge=True)
            except Exception:
                pass
        elif parent_trip_id:
            # Cancel only this child ride, recalculate parent seats
            try:
                parent_ref = db.collection("shareTrips").document(parent_trip_id)
                p_snap = parent_ref.get()
                if p_snap.exists:
                    p_data = p_snap.to_dict() or {}
                    child_ids = p_data.get("childRideIds") or []
                    active_children = [cid for cid in child_ids if cid != ride_id]
                    stop_order = [s for s in (p_data.get("stopOrder") or []) if s.get("rideId") != ride_id]
                    if not active_children and int(p_data.get("remoteOnBoard") or 0) == 0:
                        parent_ref.update({
                            "status": "cancelled",
                            "seatsUsed": 0,
                            "stopOrder": stop_order,
                            "endedAt": fb_firestore.SERVER_TIMESTAMP,
                            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                        })
                        parent_was_cancelled = True
                    else:
                        new_anchor = active_children[0] if active_children else p_data.get("anchorRideId")
                        parent_ref.update({
                            "anchorRideId": new_anchor,
                            "childRideIds": active_children,
                            "seatsUsed": max(0, len(active_children) + int(p_data.get("remoteOnBoard") or 0)),
                            "stopOrder": stop_order,
                            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                        })
            except Exception:
                pass

        driver_id = str(before.get("driver_id") or "").strip()
        if driver_id:
            try:
                from ..services.db import (
                    driver_has_open_share_trips,
                    driver_has_other_active_rides,
                    update_driver_presence_synchronized,
                )
                has_active = driver_has_other_active_rides(db, driver_id, exclude_ride_id=ride_id)
                has_share = driver_has_open_share_trips(
                    db,
                    driver_id,
                    exclude_trip_id=parent_trip_id if (parent_was_cancelled or cancel_entire_parent) else None,
                )
                if not has_active and not has_share:
                    drv_doc = db.collection("users").document(driver_id).get()
                    drv_profile = drv_doc.to_dict() or {} if drv_doc.exists else {}
                    avail_status = "offline"
                    if (
                        str(drv_profile.get("desiredAvailability") or "").strip().lower() != "offline"
                        and str(drv_profile.get("driverAvailability") or "").strip().lower() != "offline"
                    ):
                        avail_status = "searching"
                    update_driver_presence_synchronized(
                        db,
                        driver_id,
                        availability=avail_status,
                        desired_availability=drv_profile.get("desiredAvailability"),
                        profile_data={**drv_profile, "uid": driver_id},
                    )
            except Exception:
                pass
    elif body.action == "update_fare":
        if body.fare is None or body.fare < 0:
            raise ApiError("Valid fare amount required.", 400)
        updates["fare"] = round(body.fare, 2)
        updates["fareAdjustedByAdmin"] = True
    elif body.action == "add_note":
        if not body.notes:
            raise ApiError("Notes cannot be empty.", 400)
        existing_notes = before.get("adminNotes") or []
        if not isinstance(existing_notes, list):
            existing_notes = []
        new_note = {
            "byUid": admin_user.get("uid"),
            "byEmail": admin_user.get("email"),
            "text": body.notes[:500],
            "at": now_utc().isoformat(),
        }
        updates["adminNotes"] = [new_note] + existing_notes
    else:
        raise ApiError("Unknown ride action.", 400)

    ref.set(updates, merge=True)
    write_audit_log(admin_user, f"ride.{body.action}", "ride", ride_id, before, updates, body.notes or "")
    try:
        from ..services.db import record_ride_audit
        record_ride_audit(
            db,
            ride_id,
            action=f"admin_{body.action}",
            actor_id=admin_user.get("uid") or "admin",
            actor_role="admin",
            details={"action": body.action, "notes": body.notes or ""},
        )
    except Exception:
        pass
    return {"ok": True, "ride": _doc_dict(ref.get())}


# ---------------------------------------------------------------------------
# Analytics (Restricted for Managers)
# ---------------------------------------------------------------------------

@router.get("/analytics/rides-daily")
def rides_daily_analytics(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    days: int = Query(default=14),
) -> dict[str, Any]:
    days = max(1, min(days, 90))
    now = now_utc()
    start_bound = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) - timedelta(days=days - 1)

    db = _db()
    rides_query = db.collection("rides").where("createdAt", ">=", start_bound)
    docs = [_doc_dict(d) for d in _stream(rides_query)]

    buckets: dict[str, dict[str, Any]] = {}
    for i in range(days):
        d = (start_bound + timedelta(days=i)).strftime("%Y-%m-%d")
        buckets[d] = {"date": d, "rides": 0, "completed": 0, "cancelled": 0, "fare": 0.0, "distanceKm": 0.0}

    cancel_by_passenger = 0
    cancel_by_driver = 0
    cancel_by_admin_or_system = 0
    cancel_reasons: dict[str, int] = {}

    vehicle_split: dict[str, int] = {"auto": 0, "bike": 0, "car": 0, "share": 0, "single": 0}
    total_rides = 0
    total_completed = 0
    total_cancelled = 0
    total_revenue = 0.0
    total_distance_km = 0.0

    for data in docs:
        created = data.get("createdAt")
        dt_val: Optional[datetime] = None
        if isinstance(created, datetime):
            dt_val = created.astimezone(timezone.utc) if created.tzinfo else created.replace(tzinfo=timezone.utc)
        elif isinstance(created, (int, float)):
            try:
                dt_val = datetime.fromtimestamp(float(created), tz=timezone.utc)
            except Exception:
                dt_val = None
        elif isinstance(created, str):
            try:
                dt_val = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except Exception:
                dt_val = None
        if dt_val is None or dt_val < start_bound:
            continue

        key = dt_val.strftime("%Y-%m-%d")
        bucket = buckets.setdefault(
            key, {"date": key, "rides": 0, "completed": 0, "cancelled": 0, "fare": 0.0, "distanceKm": 0.0}
        )
        bucket["rides"] += 1
        total_rides += 1

        v_type = str(data.get("vehicle_type") or data.get("vehicleType") or "auto").strip().lower()
        if v_type in ("bike", "scooty", "two_wheeler"):
            vehicle_split["bike"] += 1
        elif v_type in ("car", "cab", "sedan", "suv"):
            vehicle_split["car"] += 1
        else:
            vehicle_split["auto"] += 1

        r_type = str(data.get("rideType") or "single").strip().lower()
        if r_type == "share":
            vehicle_split["share"] += 1
        else:
            vehicle_split["single"] += 1

        status = str(data.get("status") or "").strip().lower()
        if status == "completed":
            bucket["completed"] += 1
            total_completed += 1
            fare_val = float(data.get("fare") or 0)
            dist_val = float(data.get("estimated_distance_km") or data.get("distance_km") or 0)
            bucket["fare"] += fare_val
            bucket["distanceKm"] += dist_val
            total_revenue += fare_val
            total_distance_km += dist_val
        elif status.startswith("cancelled"):
            bucket["cancelled"] += 1
            total_cancelled += 1
            reason_raw = str(data.get("cancellationReason") or data.get("cancelReason") or "").strip()
            if "admin" in reason_raw.lower() or status == "cancelled_by_admin":
                cancel_by_admin_or_system += 1
            elif status == "cancelled_by_passenger":
                cancel_by_passenger += 1
            elif status == "cancelled_by_driver":
                cancel_by_driver += 1
            else:
                cancel_by_admin_or_system += 1
            if reason_raw:
                cancel_reasons[reason_raw] = cancel_reasons.get(reason_raw, 0) + 1

    ordered = sorted(buckets.values(), key=lambda b: b["date"])
    for b in ordered:
        b["fare"] = round(b["fare"], 2)
        b["distanceKm"] = round(b["distanceKm"], 2)

    completion_rate = round((total_completed / total_rides * 100), 1) if total_rides > 0 else 0.0
    cancellation_rate = round((total_cancelled / total_rides * 100), 1) if total_rides > 0 else 0.0
    avg_fare = round(total_revenue / total_completed, 2) if total_completed > 0 else 0.0

    top_cancel_reasons = [
        {"reason": k, "count": v}
        for k, v in sorted(cancel_reasons.items(), key=lambda x: x[1], reverse=True)[:6]
    ]

    return {
        "ok": True,
        "days": ordered,
        "summary": {
            "periodDays": days,
            "totalRides": total_rides,
            "completedRides": total_completed,
            "cancelledRides": total_cancelled,
            "completionRate": completion_rate,
            "completionRatePercent": completion_rate,
            "cancellationRate": cancellation_rate,
            "cancellationRatePercent": cancellation_rate,
            "totalFare": round(total_revenue, 2),
            "totalRevenue": round(total_revenue, 2),
            "avgFarePerCompletedRide": avg_fare,
            "averageFare": avg_fare,
            "totalDistanceKm": round(total_distance_km, 2),
        },
        "cancellationBreakdown": {
            "byPassenger": cancel_by_passenger,
            "byDriver": cancel_by_driver,
            "byAdminOrSystem": cancel_by_admin_or_system,
            "totalCancelled": total_cancelled,
            "reasons": top_cancel_reasons,
            "topReasons": top_cancel_reasons,
        },
        "vehicleSplit": {
            **vehicle_split,
            "byVehicle": {
                "auto": vehicle_split["auto"],
                "bike": vehicle_split["bike"],
                "car": vehicle_split["car"],
            },
            "byRideType": {
                "share": vehicle_split["share"],
                "single": vehicle_split["single"],
            },
        },
    }


# ---------------------------------------------------------------------------
# Audit log (Restricted for Managers)
# ---------------------------------------------------------------------------

@router.get("/audit-logs")
def list_audit_logs(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    role: Optional[str] = Query(default=None),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("auditLogs")
    if role:
        base = base.where("adminRole", "==", role)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "auditLogs")
    return {"ok": True, "logs": items, "nextCursor": next_cursor}


# ---------------------------------------------------------------------------
# Safety (Feature 3): SOS alerts + suspicious-activity reports
# ---------------------------------------------------------------------------

SAFETY_STATUS_GROUPS: dict[str, Optional[list[str]]] = {
    "all": None,
    "open": ["open"],
    "resolved": ["resolved", "dismissed"],
}


@router.get("/safety/sos-alerts")
def list_sos_alerts(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default="open"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("sosAlerts")
    values = SAFETY_STATUS_GROUPS.get(status, ["open"]) if status else None
    if values:
        base = base.where("status", "in", values)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "sosAlerts")
    return {"ok": True, "alerts": items, "nextCursor": next_cursor}


class SafetyActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    notes: str = Field(default="", max_length=500)


@router.patch("/safety/sos-alerts/{alert_id}")
def update_sos_alert(
    alert_id: str,
    body: SafetyActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if body.action not in {"resolve", "reopen"}:
        raise ApiError("Unknown SOS alert action.", 400)
    db = _db()
    ref = db.collection("sosAlerts").document(alert_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("SOS alert not found.", 404)
    before = _doc_dict(snap)

    new_status = "resolved" if body.action == "resolve" else "open"
    updates = {
        "status": new_status,
        "resolvedBy": admin_user.get("email") if body.action == "resolve" else None,
        "resolvedAt": fb_firestore.SERVER_TIMESTAMP if body.action == "resolve" else None,
        "adminNotes": body.notes[:500] if body.notes else before.get("adminNotes"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    ref.set(updates, merge=True)
    if body.action == "resolve":
        ride_id = before.get("ride_id")
        if ride_id:
            db.collection("rides").document(ride_id).set(
                {"sos_active": False, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True
            )

    write_audit_log(admin_user, f"sos_alert.{body.action}", "sos_alert", alert_id, before, updates, body.notes)
    return {"ok": True, "alert": _doc_dict(ref.get())}


@router.get("/safety/reports")
def list_safety_reports(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default="open"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("safetyReports")
    values = SAFETY_STATUS_GROUPS.get(status, ["open"]) if status else None
    if values:
        base = base.where("status", "in", values)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "safetyReports")
    return {"ok": True, "reports": items, "nextCursor": next_cursor}


@router.patch("/safety/reports/{report_id}")
def update_safety_report(
    report_id: str,
    body: SafetyActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if body.action not in {"resolve", "dismiss", "reopen"}:
        raise ApiError("Unknown safety report action.", 400)
    db = _db()
    ref = db.collection("safetyReports").document(report_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Safety report not found.", 404)
    before = _doc_dict(snap)

    new_status = {"resolve": "resolved", "dismiss": "dismissed", "reopen": "open"}[body.action]
    updates = {
        "status": new_status,
        "reviewedBy": admin_user.get("email") if body.action != "reopen" else None,
        "reviewedAt": fb_firestore.SERVER_TIMESTAMP if body.action != "reopen" else None,
        "adminNotes": body.notes[:500] if body.notes else before.get("adminNotes"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    ref.set(updates, merge=True)

    write_audit_log(admin_user, f"safety_report.{body.action}", "safety_report", report_id, before, updates, body.notes)
    return {"ok": True, "report": _doc_dict(ref.get())}


# ---------------------------------------------------------------------------
# Backend Failure Reports (Admin Oversight & Management)
# ---------------------------------------------------------------------------

class FailureActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    notes: Optional[str] = Field(default=None, max_length=500)


class BulkFailureActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    failureIds: list[str] = Field(min_length=1, max_length=100)


@router.get("/failures")
def list_failure_reports(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    status: Optional[str] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    sort_order: Optional[str] = Query(default="desc"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("failureReports")

    if status and status.lower() != "all":
        base = base.where("status", "==", status.lower())
    if severity and severity.upper() != "ALL":
        base = base.where("severity", "==", severity.upper())

    direction = fb_firestore.Query.ASCENDING if str(sort_order).lower() == "asc" else fb_firestore.Query.DESCENDING
    base = base.order_by("lastSeenAt", direction=direction)

    items, next_cursor = _paginate(base, cursor, limit, "failureReports")

    # Count total open reports for badge
    open_count = 0
    try:
        open_count = len(list(_db().collection("failureReports").where("status", "==", "open").limit(101).stream()))
    except Exception:
        pass

    return {
        "ok": True,
        "reports": items,
        "nextCursor": next_cursor,
        "openCount": open_count,
    }


@router.patch("/failures/{failure_id}")
def update_failure_report(
    failure_id: str,
    body: FailureActionBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    if body.action not in {"resolve", "reopen", "acknowledge"}:
        raise ApiError("Unknown failure report action. Supported: resolve, reopen, acknowledge.", 400)
    db = _db()
    ref = db.collection("failureReports").document(failure_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Failure report not found.", 404)
    before = _doc_dict(snap)

    status_map = {
        "resolve": "resolved",
        "reopen": "open",
        "acknowledge": "acknowledged",
    }
    new_status = status_map[body.action]
    updates = {
        "status": new_status,
        "reviewedBy": admin_user.get("email"),
        "reviewedAt": fb_firestore.SERVER_TIMESTAMP,
        "adminNotes": body.notes[:500] if body.notes else before.get("adminNotes"),
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    ref.set(updates, merge=True)

    write_audit_log(admin_user, f"failure_report.{body.action}", "failure_report", failure_id, before, updates, body.notes or "")
    return {"ok": True, "report": _doc_dict(ref.get())}


@router.delete("/failures/{failure_id}")
def delete_failure_report(
    failure_id: str,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("failureReports").document(failure_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Failure report not found.", 404)
    before = _doc_dict(snap)

    ref.delete()
    write_audit_log(admin_user, "failure_report.delete", "failure_report", failure_id, before, {}, "Report deleted by admin")
    return {"ok": True, "message": "Failure report deleted successfully."}


@router.post("/failures/bulk")
def bulk_failure_action(
    body: BulkFailureActionBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    if body.action not in {"resolve", "reopen", "delete"}:
        raise ApiError("Unknown bulk action. Supported: resolve, reopen, delete.", 400)
    db = _db()
    batch = db.batch()
    updated_count = 0

    for fid in body.failureIds:
        clean_id = str(fid).strip()[:160]
        if not clean_id:
            continue
        ref = db.collection("failureReports").document(clean_id)
        if body.action == "delete":
            batch.delete(ref)
        else:
            new_status = "resolved" if body.action == "resolve" else "open"
            batch.set(
                ref,
                {
                    "status": new_status,
                    "reviewedBy": admin_user.get("email"),
                    "reviewedAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
        updated_count += 1

    if updated_count > 0:
        batch.commit()

    write_audit_log(
        admin_user,
        f"failure_report.bulk_{body.action}",
        "failure_report",
        "bulk",
        {},
        {"count": updated_count, "action": body.action},
        f"Bulk {body.action} performed on {updated_count} reports",
    )
    return {"ok": True, "count": updated_count, "action": body.action}


@router.get("/dispatch-stats")
def get_admin_dispatch_stats(
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """Admin-only endpoint returning pool sizes, oldest entries, outstanding offers, invariant violations, and daily reconciliation."""
    db = _db()
    from ..dispatch.invariants import check_dispatch_invariants
    return check_dispatch_invariants(db)


# ---------------------------------------------------------------------------
# Admin Broadcast & Targeted Push Notification Center
# ---------------------------------------------------------------------------

BROADCAST_TARGET_ALIASES = {
    "all": "all",
    "all_users": "all",
    "drivers": "drivers",
    "all_drivers": "drivers",
    "passengers": "passengers",
    "all_passengers": "passengers",
    "online_drivers": "online_drivers",
    "pending_drivers": "pending_drivers",
    "overdue_drivers": "overdue_drivers",
    "user": "user",
    "specific_user": "user",
}


class BroadcastNotificationBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    target: str = Field(min_length=1, max_length=32)
    targetUid: Optional[str] = Field(default=None, max_length=128)
    category: Optional[str] = Field(default="announcement", max_length=60)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=500)
    deepLink: Optional[str] = Field(default="/", max_length=250)
    channelId: Optional[str] = Field(default="general", max_length=60)


AdminBroadcastBody = BroadcastNotificationBody


@router.get("/notifications/broadcasts")
def list_notification_broadcasts(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    limit: int = Query(default=25),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    db = _db()
    items: list[dict[str, Any]] = []
    try:
        query = (
            db.collection("adminBroadcasts")
            .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            .limit(limit)
        )
        items = [_doc_dict(d) for d in _stream(query)]
    except Exception:
        try:
            items = [_doc_dict(d) for d in _stream(db.collection("adminBroadcasts").limit(limit))]
            items.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
        except Exception:
            items = []
    return {"ok": True, "broadcasts": items}


list_broadcast_notifications = list_notification_broadcasts


@router.post("/notifications/broadcast")
def send_notification_broadcast(
    payload: BroadcastNotificationBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    raw_target = payload.target.strip().lower()
    target = BROADCAST_TARGET_ALIASES.get(raw_target)
    if not target:
        raise ApiError(f"Invalid target '{payload.target}'.", 400)

    title = payload.title.strip()
    body_text = payload.body.strip()
    if not title or not body_text:
        raise ApiError("Notification title and body cannot be empty.", 400)

    db = _db()
    from ..core.notifications import (
        NotificationEvent,
        build_deep_link,
        collect_tokens,
        dispatch_push_notification,
    )

    user_docs: list[dict[str, Any]] = []
    if target == "user":
        target_uid = (payload.targetUid or "").strip()
        if not target_uid:
            raise ApiError("targetUid is required when target is 'user'.", 400)
        snap = db.collection("users").document(target_uid).get()
        if snap.exists:
            user_docs.append(_doc_dict(snap))
        else:
            # Try matching by phone or email
            by_phone = list(_stream(db.collection("users").where("phone", "==", target_uid).limit(5)))
            by_email = list(_stream(db.collection("users").where("email", "==", target_uid).limit(5))) if not by_phone else []
            for d in (by_phone or by_email):
                user_docs.append(_doc_dict(d))
        if not user_docs:
            raise ApiError(f"Target user '{target_uid}' not found.", 404)
    elif target == "drivers":
        user_docs = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "driver").limit(1000))]
    elif target == "online_drivers":
        all_drv = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "driver").limit(1000))]
        user_docs = [
            d for d in all_drv
            if str(d.get("driverAvailability") or "").strip().lower() in ("online", "searching", "busy")
        ]
    elif target == "pending_drivers":
        all_drv = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "driver").limit(1000))]
        user_docs = [
            d for d in all_drv
            if str(d.get("verificationStatus") or "pending_review").strip().lower() == "pending_review"
        ]
    elif target == "overdue_drivers":
        overdue_driver_ids: set[str] = set()
        try:
            for p_snap in _stream(db.collection("driverPayments").where("status", "in", ["overdue", "pending_verification"]).limit(500)):
                pd = _doc_dict(p_snap)
                did = str(pd.get("driverId") or pd.get("driver_id") or "").strip()
                if did:
                    overdue_driver_ids.add(did)
        except Exception:
            pass
        all_drv = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "driver").limit(1000))]
        user_docs = [
            d for d in all_drv
            if (d.get("id") or d.get("uid")) in overdue_driver_ids
            or bool(d.get("overdueFee"))
            or str(d.get("feeStatus") or "").strip().lower() == "overdue"
        ]
    elif target == "passengers":
        user_docs = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "passenger").limit(1000))]
    else:  # "all"
        user_docs = [_doc_dict(d) for d in _stream(db.collection("users").limit(1500))]

    all_tokens: list[str] = []
    seen_tokens: set[str] = set()
    for u in user_docs:
        for tok in collect_tokens(u):
            if tok not in seen_tokens:
                seen_tokens.add(tok)
                all_tokens.append(tok)

    deep_link = build_deep_link(payload.deepLink or "/")
    channel_id = (payload.channelId or payload.category or "general").strip() or "general"

    dispatch_res: dict[str, Any] = {"sent": 0, "failed": 0}
    if all_tokens:
        try:
            dispatch_res = dispatch_push_notification(
                tokens=all_tokens,
                event_type=NotificationEvent.GENERAL_ALERT,
                title=title,
                body=body_text,
                url=deep_link,
                channel_id=channel_id,
                tag=f"admin_broadcast_{int(now_utc().timestamp())}",
                extra_data={"source": "admin_broadcast", "target": raw_target},
                db=db,
            )
        except Exception as exc:
            logger.warning("Broadcast push dispatch warning: %s", exc)

    now_iso = now_utc().isoformat()
    record = {
        "target": raw_target,
        "targetUid": (payload.targetUid or "").strip() or None,
        "category": payload.category or "announcement",
        "title": title,
        "body": body_text,
        "deepLink": deep_link,
        "channelId": channel_id,
        "recipientCount": len(user_docs),
        "tokenCount": len(all_tokens),
        "fcmDispatchedCount": len(all_tokens),
        "sentCount": int(dispatch_res.get("sent") or 0),
        "failedCount": int(dispatch_res.get("failed") or 0),
        "sentByUid": admin_user.get("uid"),
        "sentByEmail": admin_user.get("email"),
        "createdAt": now_iso,
    }
    doc_ref = db.collection("adminBroadcasts").document()
    record_with_id = {"id": doc_ref.id, **record}
    try:
        doc_ref.set({**record, "createdAt": fb_firestore.SERVER_TIMESTAMP})
    except Exception:
        pass

    # Fan-out in-app notifications to userNotifications collection (capped to 500 to avoid oversized writes)
    for u in user_docs[:500]:
        uid_val = u.get("id") or u.get("uid")
        if not uid_val:
            continue
        try:
            db.collection("userNotifications").document().set(
                {
                    "userId": str(uid_val),
                    "broadcastId": doc_ref.id,
                    "title": title,
                    "body": body_text,
                    "category": payload.category or "announcement",
                    "deepLink": deep_link,
                    "channelId": channel_id,
                    "read": False,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                }
            )
        except Exception:
            pass

    write_audit_log(
        admin_user,
        "notification.broadcast",
        "adminBroadcast",
        doc_ref.id,
        {},
        record,
        f"Broadcast '{title}' to {raw_target} ({len(user_docs)} users, {len(all_tokens)} tokens)",
    )
    return {
        "ok": True,
        "broadcast": record_with_id,
        "recipientCount": len(user_docs),
        "tokenCount": len(all_tokens),
        "sentCount": int(dispatch_res.get("sent") or 0),
        "failedCount": int(dispatch_res.get("failed") or 0),
    }


send_admin_broadcast = send_notification_broadcast



