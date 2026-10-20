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
from zoneinfo import ZoneInfo

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
from ..core.notifications import send_user_notification, CHANNEL_DEFAULT

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


def _batch_get_dicts(db, collection_name: str, uids: Any) -> dict[str, dict[str, Any]]:
    clean_uids = [str(u).strip() for u in (uids or []) if u and str(u).strip()]
    unique_uids = list(dict.fromkeys(clean_uids))
    if not unique_uids:
        return {}
    result: dict[str, dict[str, Any]] = {}
    if hasattr(db, "get_all"):
        for idx in range(0, len(unique_uids), 100):
            chunk = unique_uids[idx : idx + 100]
            refs = [db.collection(collection_name).document(uid) for uid in chunk]
            try:
                for snap in db.get_all(refs):
                    if getattr(snap, "exists", False):
                        result[snap.id] = snap.to_dict() or {}
            except Exception:
                for uid in chunk:
                    try:
                        snap = db.collection(collection_name).document(uid).get()
                        if snap.exists:
                            result[uid] = snap.to_dict() or {}
                    except Exception:
                        pass
    else:
        for uid in unique_uids:
            try:
                snap = db.collection(collection_name).document(uid).get()
                if snap.exists:
                    result[uid] = snap.to_dict() or {}
            except Exception:
                pass
    return result


def _batch_get_users(db, uids: Any) -> dict[str, dict[str, Any]]:
    return _batch_get_dicts(db, "users", uids)


def _to_utc_ms(val: Any) -> Optional[int]:
    if val is None:
        return None
    if isinstance(val, datetime):
        dt = val.astimezone(timezone.utc) if val.tzinfo else val.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    if isinstance(val, (int, float)):
        fval = float(val)
        if fval <= 0:
            return None
        if fval > 1e11:
            return int(fval)
        return int(fval * 1000)
    if hasattr(val, "timestamp") and callable(getattr(val, "timestamp")):
        try:
            return int(float(val.timestamp()) * 1000)
        except Exception:
            pass
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        try:
            fval = float(s)
            if fval > 1e11:
                return int(fval)
            if fval > 0:
                return int(fval * 1000)
        except Exception:
            pass
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            return None
    return None


def _to_utc_iso(val: Any, fallback_dt: Optional[datetime] = None) -> str:
    ms = _to_utc_ms(val)
    if ms is not None:
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()
    fb = fallback_dt or now_utc()
    return fb.isoformat()


def _backfill_driver_names(rides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rides:
        return rides
    db = _db()
    parent_trip_ids = {
        str(r.get("parentTripId") or "").strip()
        for r in rides
        if r.get("parentTripId")
        and not (
            r.get("driver_id")
            or r.get("driverId")
            or r.get("assignedDriverId")
            or r.get("assigned_driver_id")
            or (isinstance(r.get("driver"), dict) and (r["driver"].get("id") or r["driver"].get("uid")))
        )
    }
    parent_trips_map = _batch_get_dicts(db, "shareTrips", parent_trip_ids) if parent_trip_ids else {}

    user_ids: set[str] = set()
    for r in rides:
        drv_obj = r.get("driver") if isinstance(r.get("driver"), dict) else {}
        pax_obj = r.get("passenger") if isinstance(r.get("passenger"), dict) else {}

        d_id = str(
            r.get("driver_id")
            or r.get("driverId")
            or r.get("assignedDriverId")
            or r.get("assigned_driver_id")
            or drv_obj.get("id")
            or drv_obj.get("uid")
            or ""
        ).strip()
        if not d_id and r.get("parentTripId"):
            pt = parent_trips_map.get(str(r.get("parentTripId")).strip()) or {}
            pt_drv = pt.get("driver") if isinstance(pt.get("driver"), dict) else {}
            d_id = str(
                pt.get("driverId")
                or pt.get("driver_id")
                or pt.get("assignedDriverId")
                or pt_drv.get("id")
                or ""
            ).strip()
            if d_id:
                r["driver_id"] = d_id
            pt_d_name = pt.get("driverName") or pt.get("driver_name") or pt_drv.get("name")
            if not r.get("driver_name") and pt_d_name:
                r["driver_name"] = str(pt_d_name)[:80]
        elif d_id and not r.get("driver_id"):
            r["driver_id"] = d_id

        p_id = str(
            r.get("passenger_id")
            or r.get("passengerId")
            or r.get("userId")
            or r.get("user_id")
            or pax_obj.get("id")
            or pax_obj.get("uid")
            or ""
        ).strip()
        if p_id and not r.get("passenger_id"):
            r["passenger_id"] = p_id

        if d_id:
            user_ids.add(d_id)
        if p_id:
            user_ids.add(p_id)

    user_map = _batch_get_users(db, user_ids) if user_ids else {}

    invalid_driver_names = {
        "driver",
        "unassigned",
        "unassigned driver",
        "driver details unavailable",
        "unknown",
        "n/a",
        "--",
        "—",
    }
    invalid_pax_names = {
        "passenger",
        "passenger details unavailable",
        "unknown",
        "n/a",
        "--",
        "—",
    }

    for r in rides:
        drv_obj = r.get("driver") if isinstance(r.get("driver"), dict) else {}
        pax_obj = r.get("passenger") if isinstance(r.get("passenger"), dict) else {}

        driver_id = str(r.get("driver_id") or r.get("driverId") or "").strip()
        existing_d_name = str(r.get("driver_name") or r.get("driverName") or drv_obj.get("name") or "").strip()
        if existing_d_name == driver_id or existing_d_name.lower() in invalid_driver_names:
            existing_d_name = ""

        if driver_id:
            u_drv = user_map.get(driver_id) or {}
            u_drv_name = str(u_drv.get("name") or u_drv.get("displayName") or u_drv.get("fullName") or "").strip()
            if u_drv_name == driver_id or u_drv_name.lower() in invalid_driver_names:
                u_drv_name = ""
            resolved_d_name = existing_d_name or u_drv_name
            if resolved_d_name:
                r["driver_name"] = resolved_d_name[:80]
                r["driver_assignment_status"] = "assigned"
            else:
                r["driver_name"] = "Driver details unavailable"
                r["driver_assignment_status"] = "unavailable"
            drv_phone = r.get("driver_phone") or r.get("driverPhone") or drv_obj.get("phone") or u_drv.get("phone")
            if not r.get("driver_phone") and drv_phone:
                r["driver_phone"] = str(drv_phone)[:40]
            veh_num = (
                r.get("vehicle_number")
                or r.get("vehicleNumber")
                or drv_obj.get("plate")
                or u_drv.get("vehicleNumber")
                or u_drv.get("vehicle_number")
            )
            if not r.get("vehicle_number") and veh_num:
                r["vehicle_number"] = str(veh_num)[:40]
            veh_type = (
                r.get("vehicle_type")
                or r.get("vehicleType")
                or drv_obj.get("vehicleType")
                or u_drv.get("vehicleType")
                or u_drv.get("vehicle_type")
            )
            if not r.get("vehicle_type") and veh_type:
                r["vehicle_type"] = str(veh_type)[:30]
        else:
            if existing_d_name:
                r["driver_name"] = existing_d_name[:80]
                r["driver_assignment_status"] = "assigned"
            else:
                r["driver_name"] = None
                r["driver_assignment_status"] = "unassigned"

        passenger_id = str(r.get("passenger_id") or r.get("passengerId") or r.get("userId") or r.get("user_id") or "").strip()
        existing_p_name = str(r.get("passenger_name") or r.get("passengerName") or pax_obj.get("name") or "").strip()
        if existing_p_name == passenger_id or existing_p_name.lower() in invalid_pax_names:
            existing_p_name = ""

        if passenger_id:
            u_pax = user_map.get(passenger_id) or {}
            u_pax_name = str(u_pax.get("name") or u_pax.get("displayName") or u_pax.get("fullName") or "").strip()
            if u_pax_name == passenger_id or u_pax_name.lower() in invalid_pax_names:
                u_pax_name = ""
            pax_phone = str(
                r.get("passenger_phone")
                or r.get("passengerPhone")
                or pax_obj.get("phone")
                or u_pax.get("phone")
                or ""
            ).strip()
            resolved_p_name = existing_p_name or u_pax_name or pax_phone
            r["passenger_name"] = resolved_p_name[:80] if resolved_p_name else "Passenger details unavailable"
            if not r.get("passenger_phone") and pax_phone:
                r["passenger_phone"] = pax_phone[:40]
        else:
            r["passenger_name"] = existing_p_name[:80] if existing_p_name else "Passenger details unavailable"

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
# Dashboard Overview & Unified Activity Feed
# ---------------------------------------------------------------------------

def _collect_activity_feed(db, limit: int = 30) -> list[dict[str, Any]]:
    now = now_utc()
    fallback_ms = int(now.timestamp() * 1000)
    raw_events: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def _add_event(
        ev_id: str,
        ev_type: str,
        category: str,
        text: str,
        raw_ts: Any,
        color: str = "primary",
        icon: str = "ti-activity",
        target_type: Optional[str] = None,
        target_id: Optional[str] = None,
        section: str = "dashboard",
    ) -> None:
        if not ev_id or ev_id in seen_ids:
            return
        ms = _to_utc_ms(raw_ts)
        if ms is None:
            ms = fallback_ms
        iso_str = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()
        seen_ids.add(ev_id)
        raw_events.append({
            "id": ev_id,
            "type": ev_type,
            "category": category,
            "text": text,
            "at": iso_str,
            "timestampMs": ms,
            "color": color,
            "icon": icon,
            "targetType": target_type,
            "targetId": str(target_id) if target_id else None,
            "section": section,
        })

    # 1. Recent Drivers (registrations + approvals)
    try:
        drv_q = db.collection("users").where("role", "==", "driver").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        drv_docs = [_doc_dict(d) for d in _stream(drv_q)]
    except Exception:
        try:
            drv_docs = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "driver").limit(12))]
        except Exception:
            drv_docs = []

    for u in drv_docs:
        uid = str(u.get("id") or u.get("uid") or "").strip()
        name = u.get("name") or u.get("phone") or "Driver"
        if u.get("createdAt"):
            _add_event(
                ev_id=f"drv_reg_{uid}",
                ev_type="driver_registered",
                category="driver",
                text=f"New driver registered: {name}",
                raw_ts=u.get("createdAt"),
                color="primary",
                icon="ti-steering-wheel",
                target_type="driver",
                target_id=uid,
                section="drivers",
            )
        if str(u.get("verificationStatus") or "").lower() == "approved" and (u.get("approvedAt") or u.get("updatedAt")):
            _add_event(
                ev_id=f"drv_app_{uid}",
                ev_type="driver_approved",
                category="driver",
                text=f"Driver approved: {name}",
                raw_ts=u.get("approvedAt") or u.get("updatedAt"),
                color="success",
                icon="ti-user-check",
                target_type="driver",
                target_id=uid,
                section="drivers",
            )

    # 2. Recent Passengers (registrations)
    try:
        pax_q = db.collection("users").where("role", "==", "passenger").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        pax_docs = [_doc_dict(d) for d in _stream(pax_q)]
    except Exception:
        try:
            pax_docs = [_doc_dict(d) for d in _stream(db.collection("users").where("role", "==", "passenger").limit(12))]
        except Exception:
            pax_docs = []

    for u in pax_docs:
        uid = str(u.get("id") or u.get("uid") or "").strip()
        name = u.get("name") or u.get("phone") or "Passenger"
        if u.get("createdAt"):
            _add_event(
                ev_id=f"pax_reg_{uid}",
                ev_type="passenger_registered",
                category="passenger",
                text=f"New passenger registered: {name}",
                raw_ts=u.get("createdAt"),
                color="primary",
                icon="ti-user-plus",
                target_type="passenger",
                target_id=uid,
                section="passengers",
            )

    # 3. Rides (requests, driver assignments, completions, cancellations)
    try:
        rides_q = db.collection("rides").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(20)
        recent_r_docs = _backfill_driver_names([_doc_dict(d) for d in _stream(rides_q)])
    except Exception:
        try:
            recent_r_docs = _backfill_driver_names([_doc_dict(d) for d in _stream(db.collection("rides").limit(20))])
        except Exception:
            recent_r_docs = []

    for r in recent_r_docs:
        r_id = str(r.get("id") or "").strip()
        short_id = f"#LP{r_id[-5:].upper()}" if len(r_id) >= 5 else f"#{r_id}"
        st = str(r.get("status") or r.get("final_status") or "").lower()
        pax_name = r.get("passenger_name") if r.get("passenger_name") and r.get("passenger_name") != "Passenger details unavailable" else ""
        drv_name = r.get("driver_name") if r.get("driver_name") and r.get("driver_name") != "Driver details unavailable" else ""

        if st == "completed":
            fare = r.get("fare")
            fare_txt = f" (₹{fare})" if fare else ""
            _add_event(
                ev_id=f"ride_comp_{r_id}",
                ev_type="ride_completed",
                category="ride",
                text=f"Ride {short_id} completed{fare_txt}" + (f" • {pax_name}" if pax_name else ""),
                raw_ts=r.get("completedAt") or r.get("updatedAt") or r.get("createdAt"),
                color="success",
                icon="ti-circle-check",
                target_type="ride",
                target_id=r_id,
                section="ride-history",
            )
        elif st.startswith("cancel") or r.get("cancelled") or r.get("is_cancelled"):
            _add_event(
                ev_id=f"ride_canc_{r_id}",
                ev_type="ride_cancelled",
                category="ride",
                text=f"Ride {short_id} cancelled" + (f" ({pax_name})" if pax_name else ""),
                raw_ts=r.get("cancelledAt") or r.get("finalStatusAt") or r.get("updatedAt") or r.get("createdAt"),
                color="danger",
                icon="ti-circle-x",
                target_type="ride",
                target_id=r_id,
                section="ride-history",
            )
        elif st in ("accepted", "arrived", "started", "en_route", "in_progress"):
            _add_event(
                ev_id=f"ride_assign_{r_id}",
                ev_type="ride_assigned",
                category="ride",
                text=f"Ride {short_id} assigned to {drv_name or 'driver'}",
                raw_ts=r.get("startedAt") or r.get("acceptedAt") or r.get("updatedAt") or r.get("createdAt"),
                color="info",
                icon="ti-car",
                target_type="ride",
                target_id=r_id,
                section="live-rides",
            )
        elif st in ("pending", "searching", "requested"):
            _add_event(
                ev_id=f"ride_req_{r_id}",
                ev_type="ride_requested",
                category="ride",
                text=f"New ride request {short_id}" + (f" by {pax_name}" if pax_name else ""),
                raw_ts=r.get("createdAt") or r.get("updatedAt"),
                color="primary",
                icon="ti-map-pin",
                target_type="ride",
                target_id=r_id,
                section="live-rides",
            )

    # 4. SOS Alerts
    try:
        sos_q = db.collection("sosAlerts").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        sos_docs = [_doc_dict(d) for d in _stream(sos_q)]
    except Exception:
        try:
            sos_docs = [_doc_dict(d) for d in _stream(db.collection("sosAlerts").limit(12))]
        except Exception:
            sos_docs = []

    for s in sos_docs:
        sid = str(s.get("id") or "").strip()
        ride_ref = s.get("ride_id") or s.get("rideId") or ""
        user_lbl = s.get("reporter_name") or s.get("passenger_name") or s.get("userName") or s.get("passengerName") or "Participant"
        alert_label = f"Ride #{str(ride_ref)[-5:].upper()}" if ride_ref else user_lbl
        _add_event(
            ev_id=f"sos_trig_{sid}",
            ev_type="sos_alert",
            category="safety",
            text=f"SOS alert triggered: {alert_label} ({user_lbl})",
            raw_ts=s.get("createdAt") or s.get("triggeredAt"),
            color="danger",
            icon="ti-alert-triangle",
            target_type="sos",
            target_id=sid,
            section="safety",
        )
        if str(s.get("status") or "").lower() == "resolved" and s.get("resolvedAt"):
            _add_event(
                ev_id=f"sos_res_{sid}",
                ev_type="sos_resolved",
                category="safety",
                text=f"SOS alert resolved: {alert_label}",
                raw_ts=s.get("resolvedAt") or s.get("updatedAt"),
                color="success",
                icon="ti-shield-check",
                target_type="sos",
                target_id=sid,
                section="safety",
            )

    # 5. Safety Reports
    try:
        rep_q = db.collection("safetyReports").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        rep_docs = [_doc_dict(d) for d in _stream(rep_q)]
    except Exception:
        try:
            rep_docs = [_doc_dict(d) for d in _stream(db.collection("safetyReports").limit(12))]
        except Exception:
            rep_docs = []

    for rep in rep_docs:
        rid = str(rep.get("id") or "").strip()
        cat = str(rep.get("category") or "incident").replace("_", " ").title()
        reporter = rep.get("reporter_name") or rep.get("passenger_name") or "User"
        _add_event(
            ev_id=f"rep_sub_{rid}",
            ev_type="safety_report",
            category="safety",
            text=f"Safety report ({cat}) submitted by {reporter}",
            raw_ts=rep.get("createdAt"),
            color="warning",
            icon="ti-report",
            target_type="safety_report",
            target_id=rid,
            section="safety",
        )

    # 6. Driver Weekly Payments (submitted / approved / declined)
    try:
        pmt_q = db.collection("driverPayments").order_by("submittedAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        pmt_docs = [_doc_dict(d) for d in _stream(pmt_q)]
    except Exception:
        try:
            pmt_docs = [_doc_dict(d) for d in _stream(db.collection("driverPayments").limit(12))]
        except Exception:
            pmt_docs = []

    for p in pmt_docs:
        pid = str(p.get("id") or "").strip()
        p_status = str(p.get("status") or "").lower()
        drv_name = p.get("driverName") or p.get("name") or "Driver"
        amt = p.get("amount") or 0
        if p_status in ("approved", "verified"):
            _add_event(
                ev_id=f"pmt_app_{pid}",
                ev_type="payment_completed",
                category="payment",
                text=f"{drv_name} weekly payment approved (₹{amt})",
                raw_ts=p.get("verifiedAt") or p.get("updatedAt") or p.get("submittedAt") or p.get("createdAt"),
                color="success",
                icon="ti-receipt",
                target_type="payment",
                target_id=pid,
                section="payments",
            )
        elif p_status in ("declined", "rejected"):
            _add_event(
                ev_id=f"pmt_dec_{pid}",
                ev_type="payment_declined",
                category="payment",
                text=f"{drv_name} weekly payment declined (₹{amt})",
                raw_ts=p.get("verifiedAt") or p.get("updatedAt") or p.get("submittedAt") or p.get("createdAt"),
                color="danger",
                icon="ti-receipt-off",
                target_type="payment",
                target_id=pid,
                section="payments",
            )
        elif p_status in ("submitted", "pending_verification", "pending"):
            _add_event(
                ev_id=f"pmt_sub_{pid}",
                ev_type="payment_submitted",
                category="payment",
                text=f"{drv_name} submitted weekly fee payment (₹{amt})",
                raw_ts=p.get("submittedAt") or p.get("createdAt"),
                color="warning",
                icon="ti-clock-dollar",
                target_type="payment",
                target_id=pid,
                section="payments",
            )

    # 7. Wallet Credits Granted
    try:
        wtx_q = db.collection("walletTransactions").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        wtx_docs = [_doc_dict(d) for d in _stream(wtx_q)]
    except Exception:
        try:
            wtx_docs = [_doc_dict(d) for d in _stream(db.collection("walletTransactions").limit(12))]
        except Exception:
            wtx_docs = []

    for tx in wtx_docs:
        tx_id = str(tx.get("id") or "").strip()
        tx_type = str(tx.get("type") or "").upper()
        direction = str(tx.get("direction") or "").lower()
        if "CREDIT" in tx_type or direction == "credit":
            amt = tx.get("amount")
            if amt is None and tx.get("amountPaise") is not None:
                amt = round(float(tx.get("amountPaise") or 0) / 100.0, 2)
            amt_val = amt if amt is not None else 0
            u_id = tx.get("userId") or tx.get("passengerId") or ""
            _add_event(
                ev_id=f"wtx_cred_{tx_id}",
                ev_type="wallet_credit",
                category="wallet",
                text=f"Wallet credit of ₹{amt_val} granted" + (f" to user {str(u_id)[:8]}" if u_id else ""),
                raw_ts=tx.get("createdAt"),
                color="success",
                icon="ti-wallet",
                target_type="passenger" if u_id else "wallet",
                target_id=u_id or tx_id,
                section="wallet-payments",
            )

    # 8. Coupons Created
    try:
        cpn_q = db.collection("coupons").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(10)
        cpn_docs = [_doc_dict(d) for d in _stream(cpn_q)]
    except Exception:
        try:
            cpn_docs = [_doc_dict(d) for d in _stream(db.collection("coupons").limit(10))]
        except Exception:
            cpn_docs = []

    for c in cpn_docs:
        cid = str(c.get("id") or c.get("code") or "").strip()
        code = str(c.get("code") or cid).upper()
        if c.get("createdAt"):
            _add_event(
                ev_id=f"cpn_create_{cid}",
                ev_type="coupon_created",
                category="coupon",
                text=f"Promotional coupon {code} created",
                raw_ts=c.get("createdAt"),
                color="purple",
                icon="ti-ticket",
                target_type="coupon",
                target_id=cid,
                section="coupons",
            )

    # 9. Admin & Manager Role Assignments + Key Admin Audit Events
    try:
        role_docs = [_doc_dict(d) for d in _stream(db.collection("adminRoles").limit(10))]
    except Exception:
        role_docs = []

    for ar in role_docs:
        ar_uid = str(ar.get("id") or ar.get("uid") or "").strip()
        role_lbl = str(ar.get("role") or "admin").replace("_", " ").title()
        email_lbl = ar.get("email") or ar.get("name") or ar_uid
        ts_val = ar.get("assignedAt") or ar.get("updatedAt") or ar.get("createdAt")
        if ts_val:
            _add_event(
                ev_id=f"role_assign_{ar_uid}",
                ev_type="role_assigned",
                category="admin",
                text=f"{role_lbl} role assigned to {email_lbl}",
                raw_ts=ts_val,
                color="purple",
                icon="ti-shield-lock",
                target_type="permission",
                target_id=ar_uid,
                section="permissions",
            )

    try:
        audit_q = db.collection("auditLogs").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(12)
        audit_docs = [_doc_dict(d) for d in _stream(audit_q)]
    except Exception:
        try:
            audit_docs = [_doc_dict(d) for d in _stream(db.collection("auditLogs").limit(12))]
        except Exception:
            audit_docs = []

    for al in audit_docs:
        al_id = str(al.get("id") or "").strip()
        act = str(al.get("action") or "").strip()
        target_id = str(al.get("targetId") or "").strip()
        actor = al.get("adminEmail") or "Admin"
        notes = str(al.get("notes") or "").strip()
        if not act:
            continue
        if act == "notification.broadcast":
            _add_event(
                ev_id=f"audit_{al_id}",
                ev_type="broadcast_sent",
                category="admin",
                text=notes or f"Push broadcast sent by {actor}",
                raw_ts=al.get("createdAt"),
                color="info",
                icon="ti-speakerphone",
                target_type="notification",
                target_id=target_id,
                section="notifications",
            )
        elif act.startswith("permissions."):
            _add_event(
                ev_id=f"audit_{al_id}",
                ev_type="role_assigned",
                category="admin",
                text=notes or f"Permission updated by {actor}",
                raw_ts=al.get("createdAt"),
                color="purple",
                icon="ti-shield-lock",
                target_type="permission",
                target_id=target_id,
                section="permissions",
            )

    # Strictly sort all events in descending chronological order by UTC epoch ms
    raw_events.sort(key=lambda x: int(x.get("timestampMs") or 0), reverse=True)
    return raw_events[: max(1, min(limit, 100))]


@router.get("/activity-feed")
def get_activity_feed(
    admin_user: dict[str, Any] = Depends(require_admin),
    limit: int = Query(default=30),
    category: Optional[str] = Query(default=None),
) -> dict[str, Any]:
    db = _db()
    activities = _collect_activity_feed(db, limit=max(1, min(limit, 100)))
    if category and category.lower() != "all":
        cat_lower = category.lower()
        activities = [a for a in activities if str(a.get("category") or "").lower().startswith(cat_lower.rstrip("s"))]
    return {"ok": True, "activities": activities, "items": activities}



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

    recent_activity = _collect_activity_feed(db, limit=30)

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
    all_driver_rides.sort(key=lambda r: _to_utc_ms(r.get("createdAt") or r.get("updatedAt")) or 0, reverse=True)
    all_driver_rides = _backfill_driver_names(all_driver_rides)
    rating_summary = _compute_driver_rating_summary(all_driver_rides, profile)
    sanitized = _sanitize_driver(profile)
    if sanitized.get("rating") is None and rating_summary.get("averageRating") is not None:
        sanitized["rating"] = rating_summary["averageRating"]

    return {
        "ok": True,
        "driver": sanitized,
        "ratingSummary": rating_summary,
        "recentRides": all_driver_rides[:10],
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
    if body.action == "approve":
        try:
            app_url = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")
            send_user_notification(
                db=db,
                user_id=uid,
                event_type="driver_approved",
                title="Registration Approved! 🎉",
                body="Congratulations! Your driver account has been approved. You can now go online and start accepting trips.",
                url=f"{app_url}/driver.html",
                channel_id=CHANNEL_DEFAULT,
                tag=f"driver-approved-{uid}",
                extra_data={"type": "driver_approved", "driverId": uid},
                fallback_inapp=True,
                is_driver=True,
            )
        except Exception as push_err:
            logger.warning("Failed to dispatch driver approval push notification to %s: %s", uid, push_err)
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

    rides_docs.sort(key=lambda r: _to_utc_ms(r.get("createdAt") or r.get("updatedAt")) or 0, reverse=True)
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
        "recentRides": rides_docs[:10],
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
            if not r.get("driver_name") or r.get("driver_name") == d_id:
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
            if not r.get("passenger_name") or r.get("passenger_name") == p_id:
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
        st_d_name = st_data.get("driverName")
        if st_d_name == d_id:
            st_d_name = None
        d_name = st_d_name or (child_rides[0].get("driver_name") if child_rides else None) or d_profile.get("name") or "Driver"
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
            c_raw_status = str(cr.get("status") or "").strip().lower()
            c_pin_verified = bool(
                cr.get("pin_verified")
                or cr.get("pinVerified")
                or cr.get("pinVerifiedAt")
                or c_raw_status in ("started", "in_progress", "en_route", "completed")
            )
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
                "pin_verified": c_pin_verified,
                "startedAt": c_time,
                "elapsedText": c_elapsed,
                "driverLocation": cr.get("driverLocation") or drv_loc,
            })

        parent_status = "Finding Riders" if joined_count < max_seats and st_data.get("status") == "pending" else "On Trip"
        parent_raw_status = (
            st_data.get("status")
            or (child_rides[0].get("status") if child_rides else None)
            or ("pending" if parent_status == "Finding Riders" else "en_route")
        )
        parent_pin_verified = any(ci.get("pin_verified") for ci in child_items) or str(parent_raw_status).lower() in (
            "started",
            "in_progress",
            "en_route",
        )
        hierarchy.append({
            "id": st_id,
            "displayId": parent_display_id,
            "isParent": True,
            "isShareTripDoc": True,
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
            "rawStatus": parent_raw_status,
            "pin_verified": parent_pin_verified,
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
        sr_raw_status = str(sr.get("status") or "").strip().lower()
        sr_pin_verified = bool(
            sr.get("pin_verified")
            or sr.get("pinVerified")
            or sr.get("pinVerifiedAt")
            or sr_raw_status in ("started", "in_progress", "en_route", "completed")
        )

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
            "pin_verified": sr_pin_verified,
            "startedAt": time_str,
            "elapsedText": elapsed_str,
            "driverLocation": sr.get("driverLocation"),
        }

        hierarchy.append({
            "id": sr["id"],
            "displayId": parent_display_id,
            "isParent": True,
            "isShareTripDoc": False,
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
            "rawStatus": sr.get("status"),
            "pin_verified": sr_pin_verified,
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
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("rides").document(ride_id)
    snap = ref.get()
    if not snap.exists:
        st_snap = db.collection("shareTrips").document(ride_id).get()
        if not st_snap.exists:
            raise ApiError("Ride not found.", 404)
        st_data = _doc_dict(st_snap)
        child_docs = [_doc_dict(d) for d in _stream(db.collection("rides").where("parentTripId", "==", ride_id))]
        child_docs = _backfill_driver_names(child_docs)
        first_child = child_docs[0] if child_docs else {}
        ride = {
            "id": ride_id,
            "rideType": "share",
            "isParentShareTrip": True,
            "parentTripId": ride_id,
            "status": st_data.get("status") or first_child.get("status") or "active",
            "driver_id": st_data.get("driverId") or st_data.get("driver_id") or first_child.get("driver_id"),
            "driver_name": st_data.get("driverName") or first_child.get("driver_name"),
            "driver_phone": first_child.get("driver_phone"),
            "vehicle_type": st_data.get("vehicleType") or first_child.get("vehicle_type") or "auto",
            "vehicle_number": first_child.get("vehicle_number"),
            "passenger_id": first_child.get("passenger_id"),
            "passenger_name": first_child.get("passenger_name") or f"{len(child_docs)} Share Passengers",
            "passenger_phone": first_child.get("passenger_phone"),
            "pickup_name": st_data.get("pickup_name") or first_child.get("pickup_name"),
            "drop_name": st_data.get("drop_name") or first_child.get("drop_name"),
            "pickup_lat": st_data.get("pickup_lat") or first_child.get("pickup_lat"),
            "pickup_lng": st_data.get("pickup_lng") or first_child.get("pickup_lng"),
            "drop_lat": st_data.get("drop_lat") or first_child.get("drop_lat"),
            "drop_lng": st_data.get("drop_lng") or first_child.get("drop_lng"),
            "driverLocation": st_data.get("driverLocation") or first_child.get("driverLocation"),
            "fare": sum(float(c.get("fare") or 0) for c in child_docs),
            "createdAt": st_data.get("createdAt") or first_child.get("createdAt"),
            "updatedAt": st_data.get("updatedAt") or first_child.get("updatedAt"),
            "adminNotes": st_data.get("adminNotes") or [],
        }
        ride = _backfill_driver_names([ride])[0]
        sibling_rides = [
            {
                "rideId": c.get("id"),
                "passenger_id": c.get("passenger_id"),
                "passenger_name": c.get("passenger_name") or "Passenger details unavailable",
                "passenger_phone": c.get("passenger_phone") or "",
                "seatOrder": c.get("seatOrder") or (idx + 1),
                "status": c.get("status"),
                "fare": c.get("fare"),
                "pickup_name": c.get("pickup_name"),
                "drop_name": c.get("drop_name"),
            }
            for idx, c in enumerate(child_docs)
        ]
        ride["siblingChildRides"] = sibling_rides
        return {"ok": True, "ride": ride, "siblingChildRides": sibling_rides}

    ride = _backfill_driver_names([_doc_dict(snap)])[0]
    sibling_rides = []
    parent_trip_id = ride.get("parentTripId")
    if parent_trip_id:
        try:
            raw_siblings = [
                _doc_dict(s)
                for s in _stream(db.collection("rides").where("parentTripId", "==", parent_trip_id))
                if s.id != ride_id
            ]
            raw_siblings = _backfill_driver_names(raw_siblings)
            for s_data in raw_siblings:
                sibling_rides.append({
                    "rideId": s_data.get("id"),
                    "passenger_id": s_data.get("passenger_id"),
                    "passenger_name": s_data.get("passenger_name") or "Passenger details unavailable",
                    "passenger_phone": s_data.get("passenger_phone") or "",
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
    "resolved": ["resolved", "dismissed", "closed"],
}


class BulkSafetyDeleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: Optional[list[str]] = Field(default=None, max_length=100)
    alertIds: Optional[list[str]] = Field(default=None, max_length=100)
    reportIds: Optional[list[str]] = Field(default=None, max_length=100)


def _enrich_safety_records(db, records: list[dict[str, Any]], kind: str = "sos") -> list[dict[str, Any]]:
    if not records:
        return records

    ride_ids: set[str] = set()
    for rec in records:
        r_id = str(rec.get("ride_id") or rec.get("rideId") or "").strip()
        if r_id:
            ride_ids.add(r_id)

    rides_map = _batch_get_dicts(db, "rides", ride_ids) if ride_ids else {}

    parent_trip_ids: set[str] = set()
    for rec in records:
        pt_id = str(rec.get("parent_trip_id") or rec.get("parentTripId") or "").strip()
        if pt_id:
            parent_trip_ids.add(pt_id)
    for r_data in rides_map.values():
        pt_id = str(r_data.get("parentTripId") or "").strip()
        if pt_id:
            parent_trip_ids.add(pt_id)

    share_trips_map = _batch_get_dicts(db, "shareTrips", parent_trip_ids) if parent_trip_ids else {}

    user_ids: set[str] = set()
    for rec in records:
        r_id = str(rec.get("ride_id") or rec.get("rideId") or "").strip()
        r_data = rides_map.get(r_id) or {}
        pt_id = str(rec.get("parent_trip_id") or rec.get("parentTripId") or r_data.get("parentTripId") or "").strip()
        pt_data = share_trips_map.get(pt_id) or {}

        for cand in (
            rec.get("reporter_id"),
            rec.get("reporterId"),
            rec.get("userId"),
            rec.get("user_id"),
            rec.get("passenger_id"),
            rec.get("passengerId"),
            rec.get("driver_id"),
            rec.get("driverId"),
            r_data.get("passenger_id"),
            r_data.get("passengerId"),
            r_data.get("driver_id"),
            r_data.get("driverId"),
            pt_data.get("driverId"),
            pt_data.get("driver_id"),
        ):
            c_str = str(cand or "").strip()
            if c_str:
                user_ids.add(c_str)

    users_map = _batch_get_users(db, user_ids) if user_ids else {}
    emergency_docs_map = _batch_get_dicts(db, "emergencyContacts", user_ids) if user_ids else {}

    enriched: list[dict[str, Any]] = []
    for rec in records:
        item = dict(rec)
        r_id = str(item.get("ride_id") or item.get("rideId") or "").strip()
        r_data = dict(rides_map.get(r_id) or {})
        pt_id = str(item.get("parent_trip_id") or item.get("parentTripId") or r_data.get("parentTripId") or "").strip()
        pt_data = dict(share_trips_map.get(pt_id) or {})

        reporter_id = str(
            item.get("reporter_id")
            or item.get("reporterId")
            or item.get("userId")
            or item.get("user_id")
            or ""
        ).strip()
        reporter_profile = users_map.get(reporter_id) or {}
        reporter_role = str(
            item.get("reporter_role")
            or item.get("reporterRole")
            or reporter_profile.get("role")
            or ""
        ).strip().lower()

        passenger_id = str(
            item.get("passenger_id")
            or item.get("passengerId")
            or r_data.get("passenger_id")
            or r_data.get("passengerId")
            or (reporter_id if reporter_role == "passenger" else "")
            or (reporter_id if not r_id and reporter_role != "driver" else "")
        ).strip()
        driver_id = str(
            item.get("driver_id")
            or item.get("driverId")
            or r_data.get("driver_id")
            or r_data.get("driverId")
            or pt_data.get("driverId")
            or pt_data.get("driver_id")
            or (reporter_id if reporter_role == "driver" else "")
        ).strip()

        pax_profile = users_map.get(passenger_id) or {}
        drv_profile = users_map.get(driver_id) or {}

        pax_name = (
            str(item.get("passenger_name") or item.get("passengerName") or "").strip()
            or str(r_data.get("passenger_name") or r_data.get("passengerName") or "").strip()
            or str(pax_profile.get("name") or "").strip()
            or (str(item.get("reporter_name") or "").strip() if reporter_role == "passenger" else "")
        )
        if pax_name == passenger_id or pax_name.lower() in ("passenger", "passenger details unavailable", "n/a", "--"):
            pax_name = str(pax_profile.get("name") or "").strip() or pax_name

        pax_phone = (
            str(item.get("passenger_phone") or item.get("passengerPhone") or "").strip()
            or str(r_data.get("passenger_phone") or r_data.get("passengerPhone") or "").strip()
            or str(pax_profile.get("phone") or pax_profile.get("phoneNumber") or "").strip()
            or (str(item.get("reporter_phone") or item.get("phone") or "").strip() if reporter_role == "passenger" else "")
        )

        drv_name = (
            str(item.get("driver_name") or item.get("driverName") or "").strip()
            or str(r_data.get("driver_name") or r_data.get("driverName") or "").strip()
            or str(pt_data.get("driverName") or "").strip()
            or str(drv_profile.get("name") or "").strip()
            or (str(item.get("reporter_name") or "").strip() if reporter_role == "driver" else "")
        )
        if drv_name == driver_id or drv_name.lower() in ("driver", "driver details unavailable", "unassigned", "n/a", "--"):
            drv_name = str(drv_profile.get("name") or "").strip() or drv_name

        drv_phone = (
            str(item.get("driver_phone") or item.get("driverPhone") or "").strip()
            or str(r_data.get("driver_phone") or r_data.get("driverPhone") or "").strip()
            or str(drv_profile.get("phone") or drv_profile.get("phoneNumber") or "").strip()
            or (str(item.get("reporter_phone") or "").strip() if reporter_role == "driver" else "")
        )

        veh_number = (
            str(item.get("vehicle_number") or item.get("vehicleNumber") or "").strip()
            or str(r_data.get("vehicle_number") or r_data.get("vehicleNumber") or "").strip()
            or str(drv_profile.get("vehicleNumber") or drv_profile.get("vehicle_number") or "").strip()
        )
        veh_type = (
            str(item.get("vehicle_type") or item.get("vehicleType") or "").strip()
            or str(r_data.get("vehicle_type") or r_data.get("vehicleType") or "").strip()
            or str(pt_data.get("vehicleType") or "").strip()
            or str(drv_profile.get("vehicleType") or drv_profile.get("vehicle_type") or "").strip()
        )
        veh_model = (
            str(r_data.get("vehicle_model") or r_data.get("vehicleModel") or "").strip()
            or str(drv_profile.get("vehicleModel") or drv_profile.get("vehicle_model") or "").strip()
        )

        raw_rep_name = str(item.get("reporter_name") or item.get("reporterName") or "").strip()
        if raw_rep_name == reporter_id:
            raw_rep_name = ""
        reporter_name = (
            raw_rep_name
            or str(reporter_profile.get("name") or "").strip()
            or (pax_name if reporter_role == "passenger" else (drv_name if reporter_role == "driver" else ""))
        )
        reporter_phone = (
            str(item.get("reporter_phone") or item.get("reporterPhone") or "").strip()
            or str(reporter_profile.get("phone") or reporter_profile.get("phoneNumber") or "").strip()
            or (pax_phone if reporter_role == "passenger" else (drv_phone if reporter_role == "driver" else ""))
        )

        # Emergency contacts lookup (check passenger and reporter)
        emergency_contacts: list[dict[str, Any]] = []
        for ec_uid in dict.fromkeys([passenger_id, reporter_id]):
            if not ec_uid:
                continue
            ec_doc = emergency_docs_map.get(ec_uid) or {}
            raw_list = ec_doc.get("contacts") or (users_map.get(ec_uid) or {}).get("emergencyContacts") or []
            if isinstance(raw_list, list):
                for c in raw_list:
                    if isinstance(c, dict) and (c.get("name") or c.get("phone")):
                        emergency_contacts.append({
                            "name": str(c.get("name") or "Emergency Contact"),
                            "phone": str(c.get("phone") or c.get("phoneNumber") or ""),
                            "relationship": str(c.get("relationship") or c.get("relation") or ""),
                        })
            u_ec_phone = (users_map.get(ec_uid) or {}).get("emergencyPhone") or (users_map.get(ec_uid) or {}).get("emergency_contact")
            if u_ec_phone and not emergency_contacts:
                emergency_contacts.append({
                    "name": "Primary Emergency Contact",
                    "phone": str(u_ec_phone),
                    "relationship": "",
                })

        pickup_name = (
            str(item.get("pickup_name") or item.get("pickupName") or item.get("pickup_location") or "").strip()
            or str(r_data.get("pickup_name") or r_data.get("pickupName") or r_data.get("pickup_display_address") or r_data.get("pickup_location") or "").strip()
            or str(pt_data.get("pickup_name") or "").strip()
        )
        drop_name = (
            str(item.get("drop_name") or item.get("dropName") or item.get("drop_location") or "").strip()
            or str(r_data.get("drop_name") or r_data.get("dropName") or r_data.get("drop_display_address") or r_data.get("drop_location") or "").strip()
            or str(pt_data.get("drop_name") or "").strip()
        )

        snap_obj = item.get("location_snapshot") or item.get("locationSnapshot") or {}
        if not isinstance(snap_obj, dict):
            snap_obj = {}

        loc_obj = item.get("location") or {}
        if not isinstance(loc_obj, dict):
            loc_obj = {}

        r_drv_loc = r_data.get("driverLocation") or pt_data.get("driverLocation") or {}
        if not isinstance(r_drv_loc, dict):
            r_drv_loc = {}
        r_pax_loc = r_data.get("passengerLocation") or {}
        if not isinstance(r_pax_loc, dict):
            r_pax_loc = {}

        pickup_lat = (
            snap_obj.get("pickup_lat")
            if snap_obj.get("pickup_lat") is not None
            else (item.get("pickup_lat") if item.get("pickup_lat") is not None else (r_data.get("pickup_lat") if r_data.get("pickup_lat") is not None else pt_data.get("pickup_lat")))
        )
        pickup_lng = (
            snap_obj.get("pickup_lng")
            if snap_obj.get("pickup_lng") is not None
            else (item.get("pickup_lng") if item.get("pickup_lng") is not None else (r_data.get("pickup_lng") if r_data.get("pickup_lng") is not None else pt_data.get("pickup_lng")))
        )
        drop_lat = (
            snap_obj.get("drop_lat")
            if snap_obj.get("drop_lat") is not None
            else (item.get("drop_lat") if item.get("drop_lat") is not None else (r_data.get("drop_lat") if r_data.get("drop_lat") is not None else pt_data.get("drop_lat")))
        )
        drop_lng = (
            snap_obj.get("drop_lng")
            if snap_obj.get("drop_lng") is not None
            else (item.get("drop_lng") if item.get("drop_lng") is not None else (r_data.get("drop_lng") if r_data.get("drop_lng") is not None else pt_data.get("drop_lng")))
        )

        inc_lat = (
            loc_obj.get("lat")
            if loc_obj.get("lat") is not None
            else (item.get("lat") if item.get("lat") is not None else snap_obj.get("incident_lat"))
        )
        inc_lng = (
            loc_obj.get("lng")
            if loc_obj.get("lng") is not None
            else (item.get("lng") if item.get("lng") is not None else snap_obj.get("incident_lng"))
        )

        drv_lat = snap_obj.get("driver_lat") if snap_obj.get("driver_lat") is not None else r_drv_loc.get("lat")
        drv_lng = snap_obj.get("driver_lng") if snap_obj.get("driver_lng") is not None else r_drv_loc.get("lng")
        if (drv_lat is None or drv_lng is None) and reporter_role == "driver" and inc_lat is not None and inc_lng is not None:
            drv_lat, drv_lng = inc_lat, inc_lng

        pax_lat = snap_obj.get("passenger_lat") if snap_obj.get("passenger_lat") is not None else r_pax_loc.get("lat")
        pax_lng = snap_obj.get("passenger_lng") if snap_obj.get("passenger_lng") is not None else r_pax_loc.get("lng")
        if (pax_lat is None or pax_lng is None) and reporter_role == "passenger" and inc_lat is not None and inc_lng is not None:
            pax_lat, pax_lng = inc_lat, inc_lng
        if pax_lat is None or pax_lng is None:
            pax_lat, pax_lng = pickup_lat, pickup_lng

        ride_status = str(item.get("ride_status") or snap_obj.get("ride_status") or r_data.get("status") or pt_data.get("status") or "").strip()
        pin_verified = bool(
            item.get("pin_verified")
            or snap_obj.get("pin_verified")
            or r_data.get("pinVerifiedAt")
            or r_data.get("startedAt")
            or ride_status.lower() in ("started", "en_route", "in_progress", "completed")
        )

        location_snapshot = {
            "incident_lat": inc_lat if inc_lat is not None else (drv_lat if drv_lat is not None else pickup_lat),
            "incident_lng": inc_lng if inc_lng is not None else (drv_lng if drv_lng is not None else pickup_lng),
            "driver_lat": drv_lat,
            "driver_lng": drv_lng,
            "passenger_lat": pax_lat,
            "passenger_lng": pax_lng,
            "pickup_lat": pickup_lat,
            "pickup_lng": pickup_lng,
            "drop_lat": drop_lat,
            "drop_lng": drop_lng,
            "ride_status": ride_status,
            "pin_verified": pin_verified,
            "vehicle_type": veh_type or "auto",
            "captured_at": snap_obj.get("captured_at") or _to_utc_iso(item.get("createdAt")),
        }

        item.update({
            "ride_id": r_id or None,
            "rideId": r_id or None,
            "parent_trip_id": pt_id or None,
            "ride_status": ride_status or None,
            "ride_type": str(r_data.get("rideType") or ("share" if pt_id else "single")),
            "fare": r_data.get("fare"),
            "pin_verified": pin_verified,
            "reporter_id": reporter_id or None,
            "reporter_role": reporter_role or "unknown",
            "reporter_name": reporter_name or None,
            "reporter_phone": reporter_phone or None,
            "passenger_id": passenger_id or None,
            "passenger_name": pax_name or None,
            "passenger_phone": pax_phone or None,
            "passenger_email": pax_profile.get("email") or None,
            "driver_id": driver_id or None,
            "driver_name": drv_name or None,
            "driver_phone": drv_phone or None,
            "driver_email": drv_profile.get("email") or None,
            "vehicle_number": veh_number or None,
            "vehicle_type": veh_type or None,
            "vehicle_model": veh_model or None,
            "pickup_name": pickup_name or None,
            "drop_name": drop_name or None,
            "pickup_lat": pickup_lat,
            "pickup_lng": pickup_lng,
            "drop_lat": drop_lat,
            "drop_lng": drop_lng,
            "emergency_contacts": emergency_contacts,
            "location_snapshot": location_snapshot,
            "ride": r_data if r_data else None,
        })
        enriched.append(item)

    return enriched


@router.get("/safety/sos-alerts")
def list_sos_alerts(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default="open"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    db = _db()
    base = db.collection("sosAlerts")
    values = SAFETY_STATUS_GROUPS.get(status, ["open"]) if status else None
    if values:
        base = base.where("status", "in", values)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "sosAlerts")
    items = _enrich_safety_records(db, items, kind="sos")
    return {"ok": True, "alerts": items, "nextCursor": next_cursor}


@router.get("/safety/sos-alerts/{alert_id}")
def get_sos_alert(
    alert_id: str,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    snap = db.collection("sosAlerts").document(alert_id).get()
    if not snap.exists:
        raise ApiError("SOS alert not found.", 404)
    enriched = _enrich_safety_records(db, [_doc_dict(snap)], kind="sos")[0]
    return {"ok": True, "alert": enriched}


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
        ride_id = before.get("ride_id") or before.get("rideId")
        if ride_id:
            db.collection("rides").document(ride_id).set(
                {"sos_active": False, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True
            )

    write_audit_log(admin_user, f"sos_alert.{body.action}", "sos_alert", alert_id, before, updates, body.notes)
    enriched = _enrich_safety_records(db, [_doc_dict(ref.get())], kind="sos")[0]
    return {"ok": True, "alert": enriched}


@router.delete("/safety/sos-alerts/{alert_id}")
def delete_sos_alert(
    alert_id: str,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("sosAlerts").document(alert_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("SOS alert not found.", 404)
    before = _doc_dict(snap)
    st = str(before.get("status") or "open").strip().lower()
    if st not in {"resolved", "dismissed", "closed"}:
        raise ApiError("Active or open SOS alerts cannot be deleted. Please resolve the incident first.", 400)

    ref.delete()
    write_audit_log(admin_user, "sos_alert.delete", "sos_alert", alert_id, before, {}, "Resolved SOS alert deleted by admin")
    return {"ok": True, "deletedId": alert_id}


@router.post("/safety/sos-alerts/bulk-delete")
def bulk_delete_sos_alerts(
    body: BulkSafetyDeleteBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    raw_ids = body.alertIds or body.ids or []
    clean_ids = [str(i).strip()[:160] for i in raw_ids if str(i).strip()]
    if not clean_ids:
        raise ApiError("No SOS alert IDs provided for deletion.", 400)

    db = _db()
    batch = db.batch()
    deleted_ids: list[str] = []
    blocked_open_ids: list[str] = []

    for aid in dict.fromkeys(clean_ids):
        ref = db.collection("sosAlerts").document(aid)
        snap = ref.get()
        if not snap.exists:
            continue
        data = _doc_dict(snap)
        st = str(data.get("status") or "open").strip().lower()
        if st not in {"resolved", "dismissed", "closed"}:
            blocked_open_ids.append(aid)
            continue
        batch.delete(ref)
        deleted_ids.append(aid)

    if blocked_open_ids and not deleted_ids:
        raise ApiError("Active or open SOS alerts cannot be deleted. Only resolved or closed incidents may be deleted.", 400)

    if deleted_ids:
        batch.commit()
        write_audit_log(
            admin_user,
            "sos_alert.bulk_delete",
            "sos_alert",
            "bulk",
            {},
            {"deletedIds": deleted_ids, "skippedOpenIds": blocked_open_ids},
            f"Bulk deleted {len(deleted_ids)} resolved SOS alerts",
        )

    return {"ok": True, "deletedCount": len(deleted_ids), "deletedIds": deleted_ids, "skippedOpenIds": blocked_open_ids}


@router.get("/safety/reports")
def list_safety_reports(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default="open"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    db = _db()
    base = db.collection("safetyReports")
    values = SAFETY_STATUS_GROUPS.get(status, ["open"]) if status else None
    if values:
        base = base.where("status", "in", values)
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "safetyReports")
    items = _enrich_safety_records(db, items, kind="report")
    return {"ok": True, "reports": items, "nextCursor": next_cursor}


@router.get("/safety/reports/{report_id}")
def get_safety_report(
    report_id: str,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    snap = db.collection("safetyReports").document(report_id).get()
    if not snap.exists:
        raise ApiError("Safety report not found.", 404)
    enriched = _enrich_safety_records(db, [_doc_dict(snap)], kind="report")[0]
    return {"ok": True, "report": enriched}


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
    enriched = _enrich_safety_records(db, [_doc_dict(ref.get())], kind="report")[0]
    return {"ok": True, "report": enriched}


@router.delete("/safety/reports/{report_id}")
def delete_safety_report(
    report_id: str,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("safetyReports").document(report_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Safety report not found.", 404)
    before = _doc_dict(snap)
    st = str(before.get("status") or "open").strip().lower()
    if st not in {"resolved", "dismissed", "closed"}:
        raise ApiError("Open safety reports cannot be deleted. Please resolve or dismiss the report first.", 400)

    ref.delete()
    write_audit_log(admin_user, "safety_report.delete", "safety_report", report_id, before, {}, "Resolved safety report deleted by admin")
    return {"ok": True, "deletedId": report_id}


@router.post("/safety/reports/bulk-delete")
def bulk_delete_safety_reports(
    body: BulkSafetyDeleteBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    raw_ids = body.reportIds or body.ids or []
    clean_ids = [str(i).strip()[:160] for i in raw_ids if str(i).strip()]
    if not clean_ids:
        raise ApiError("No safety report IDs provided for deletion.", 400)

    db = _db()
    batch = db.batch()
    deleted_ids: list[str] = []
    blocked_open_ids: list[str] = []

    for rid in dict.fromkeys(clean_ids):
        ref = db.collection("safetyReports").document(rid)
        snap = ref.get()
        if not snap.exists:
            continue
        data = _doc_dict(snap)
        st = str(data.get("status") or "open").strip().lower()
        if st not in {"resolved", "dismissed", "closed"}:
            blocked_open_ids.append(rid)
            continue
        batch.delete(ref)
        deleted_ids.append(rid)

    if blocked_open_ids and not deleted_ids:
        raise ApiError("Open safety reports cannot be deleted. Only resolved, dismissed, or closed reports may be deleted.", 400)

    if deleted_ids:
        batch.commit()
        write_audit_log(
            admin_user,
            "safety_report.bulk_delete",
            "safety_report",
            "bulk",
            {},
            {"deletedIds": deleted_ids, "skippedOpenIds": blocked_open_ids},
            f"Bulk deleted {len(deleted_ids)} resolved safety reports",
        )

    return {"ok": True, "deletedCount": len(deleted_ids), "deletedIds": deleted_ids, "skippedOpenIds": blocked_open_ids}


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
    status_val = str(before.get("status") or "open").strip().lower()
    if status_val != "resolved":
        raise ApiError("Cannot delete an open or unresolved failure report. Resolve it first.", 400)

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
    skipped_open_ids: list[str] = []

    for fid in body.failureIds:
        clean_id = str(fid).strip()[:160]
        if not clean_id:
            continue
        ref = db.collection("failureReports").document(clean_id)
        if body.action == "delete":
            snap = ref.get()
            if not snap.exists:
                continue
            doc_data = _doc_dict(snap)
            if str(doc_data.get("status") or "open").strip().lower() != "resolved":
                skipped_open_ids.append(clean_id)
                continue
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

    if body.action == "delete" and updated_count == 0 and skipped_open_ids:
        raise ApiError("Cannot delete open or unresolved failure reports. Resolve them first.", 400)

    if updated_count > 0:
        batch.commit()

    write_audit_log(
        admin_user,
        f"failure_report.bulk_{body.action}",
        "failure_report",
        "bulk",
        {},
        {"count": updated_count, "action": body.action, "skippedOpenIds": skipped_open_ids},
        f"Bulk {body.action} performed on {updated_count} reports",
    )
    return {"ok": True, "count": updated_count, "action": body.action, "skippedOpenIds": skipped_open_ids}


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
        normalize_channel_id,
    )

    user_docs: list[dict[str, Any]] = []
    if target == "user":
        target_uid = (payload.targetUid or "").strip()
        if not target_uid:
            raise ApiError("targetUid is required when target is 'user'.", 400)

        seen_uids: set[str] = set()

        def _append_user(doc_d: Optional[dict[str, Any]]) -> None:
            if not doc_d:
                return
            u_id = str(doc_d.get("id") or doc_d.get("uid") or "").strip()
            if u_id and u_id not in seen_uids:
                seen_uids.add(u_id)
                user_docs.append(doc_d)

        snap = db.collection("users").document(target_uid).get()
        if snap.exists:
            _append_user(_doc_dict(snap))

        if not user_docs:
            digits = "".join(ch for ch in target_uid if ch.isdigit())
            last10 = digits[-10:] if len(digits) >= 10 else ""
            phone_candidates: list[str] = []
            for cand in (target_uid, f"+91{last10}" if len(last10) == 10 else "", last10, f"+{digits}" if digits else ""):
                if cand and cand not in phone_candidates:
                    phone_candidates.append(cand)

            # Check phoneLoginIndex first
            for p_cand in phone_candidates:
                try:
                    idx_snap = db.collection("phoneLoginIndex").document(p_cand).get()
                    if idx_snap.exists:
                        idx_data = idx_snap.to_dict() or {}
                        idx_uid = str(idx_data.get("uid") or "").strip()
                        if idx_uid:
                            u_snap = db.collection("users").document(idx_uid).get()
                            if u_snap.exists:
                                _append_user(_doc_dict(u_snap))
                except Exception:
                    pass

            # Check users collection phone fields
            for p_cand in phone_candidates:
                for field_name in ("phone", "phone_number", "phoneNumber"):
                    try:
                        for d in _stream(db.collection("users").where(field_name, "==", p_cand).limit(5)):
                            _append_user(_doc_dict(d))
                    except Exception:
                        pass
                if user_docs:
                    break

            # Try matching by email (exact and lowercase)
            if not user_docs:
                for e_cand in list(dict.fromkeys([target_uid, target_uid.lower()])):
                    try:
                        for d in _stream(db.collection("users").where("email", "==", e_cand).limit(5)):
                            _append_user(_doc_dict(d))
                    except Exception:
                        pass

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

    recipient_uids = [str(u.get("id") or u.get("uid") or "").strip() for u in user_docs if (u.get("id") or u.get("uid"))]
    driver_uids = [
        str(u.get("id") or u.get("uid") or "").strip()
        for u in user_docs
        if (u.get("id") or u.get("uid")) and str(u.get("role") or "").strip().lower() == "driver"
    ]
    presence_map = _batch_get_dicts(db, "driverPresence", driver_uids) if driver_uids else {}

    all_tokens: list[str] = []
    seen_tokens: set[str] = set()
    user_tokens_map: dict[str, list[str]] = {}

    for u in user_docs:
        u_id = str(u.get("id") or u.get("uid") or "").strip()
        u_toks: list[str] = []
        for tok in collect_tokens(u):
            if tok not in u_toks:
                u_toks.append(tok)
            if tok not in seen_tokens:
                seen_tokens.add(tok)
                all_tokens.append(tok)
        if u_id and u_id in presence_map:
            for tok in collect_tokens(presence_map[u_id]):
                if tok not in u_toks:
                    u_toks.append(tok)
                if tok not in seen_tokens:
                    seen_tokens.add(tok)
                    all_tokens.append(tok)
        if u_id:
            user_tokens_map[u_id] = u_toks

    deep_link = build_deep_link(payload.deepLink or "/")
    raw_channel = (payload.channelId or payload.category or "general").strip() or "general"
    normalized_channel = normalize_channel_id(raw_channel)

    doc_ref = db.collection("adminBroadcasts").document()
    broadcast_id = doc_ref.id

    dispatch_res: dict[str, Any] = {"sent": 0, "failed": 0, "successful_tokens": [], "invalid_tokens_removed": 0}
    if all_tokens:
        try:
            dispatch_res = dispatch_push_notification(
                tokens=all_tokens,
                event_type=NotificationEvent.GENERAL_ALERT,
                title=title,
                body=body_text,
                url=deep_link,
                channel_id=normalized_channel,
                tag=f"admin_broadcast_{broadcast_id}",
                extra_data={
                    "source": "admin_broadcast",
                    "target": raw_target,
                    "broadcastId": broadcast_id,
                    "category": payload.category or "announcement",
                },
                db=db,
                target_uids=recipient_uids,
            )
        except Exception as exc:
            logger.warning("Broadcast push dispatch warning: %s", exc)

    raw_sent = int(dispatch_res.get("sent") or 0)
    raw_failed = int(dispatch_res.get("failed") or 0)
    invalid_removed = int(dispatch_res.get("invalid_tokens_removed") or 0)
    successful_tokens_set = set(dispatch_res.get("successful_tokens") or [])

    push_delivered_users = 0
    for u_id in recipient_uids:
        u_toks = user_tokens_map.get(u_id, [])
        if successful_tokens_set:
            if set(u_toks) & successful_tokens_set:
                push_delivered_users += 1
        elif raw_sent > 0 and u_toks:
            push_delivered_users += 1

    queued_users = max(0, len(user_docs) - push_delivered_users)
    now_iso = now_utc().isoformat()

    # Fan-out notifications to userNotifications collection so online and offline-to-online clients receive them reliably
    for u in user_docs[:500]:
        uid_val = str(u.get("id") or u.get("uid") or "").strip()
        if not uid_val:
            continue
        u_toks = user_tokens_map.get(uid_val, [])
        user_push_ok = bool(set(u_toks) & successful_tokens_set) if successful_tokens_set else (raw_sent > 0 and bool(u_toks))
        notif_doc_id = f"{broadcast_id}_{uid_val}"
        notif_payload = {
            "userId": uid_val,
            "broadcastId": broadcast_id,
            "title": title,
            "body": body_text,
            "category": payload.category or "announcement",
            "deepLink": deep_link,
            "channelId": raw_channel,
            "read": False,
            "delivered": False,
            "pushSent": user_push_ok,
            "status": "push_sent" if user_push_ok else "scheduled_online",
            "createdAt": now_iso,
        }
        try:
            db.collection("userNotifications").document(notif_doc_id).set(notif_payload)
        except Exception:
            try:
                db.collection("userNotifications").document().set(notif_payload)
            except Exception:
                pass

    record = {
        "target": raw_target,
        "targetUid": (payload.targetUid or "").strip() or None,
        "category": payload.category or "announcement",
        "title": title,
        "body": body_text,
        "deepLink": deep_link,
        "channelId": raw_channel,
        "recipientCount": len(user_docs),
        "tokenCount": len(all_tokens),
        "fcmDispatchedCount": len(all_tokens),
        "sentCount": raw_sent,
        "failedCount": raw_failed,
        "invalidTokensCleaned": invalid_removed,
        "deliveredCount": push_delivered_users,
        "queuedCount": queued_users,
        "deliveryStatus": (
            "delivered"
            if (len(user_docs) > 0 and push_delivered_users >= len(user_docs))
            else ("partial_queued" if push_delivered_users > 0 else "scheduled_online")
        ),
        "sentByUid": admin_user.get("uid"),
        "sentByEmail": admin_user.get("email"),
        "createdAt": now_iso,
    }
    record_with_id = {"id": broadcast_id, **record}
    try:
        doc_ref.set({**record, "createdAt": fb_firestore.SERVER_TIMESTAMP, "createdAtIso": now_iso})
    except Exception:
        pass

    write_audit_log(
        admin_user,
        "notification.broadcast",
        "adminBroadcast",
        broadcast_id,
        {},
        record,
        f"Broadcast '{title}' to {raw_target} ({len(user_docs)} users, {raw_sent} push sent, {queued_users} scheduled for online delivery)",
    )
    return {
        "ok": True,
        "broadcast": record_with_id,
        "recipientCount": len(user_docs),
        "tokenCount": len(all_tokens),
        "sentCount": raw_sent,
        "failedCount": raw_failed,
        "deliveredCount": push_delivered_users,
        "queuedCount": queued_users,
    }


send_admin_broadcast = send_notification_broadcast


class BulkBroadcastDeleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    broadcastIds: Optional[list[str]] = Field(default=None, max_length=100)
    ids: Optional[list[str]] = Field(default=None, max_length=100)


@router.delete("/notifications/broadcasts/{broadcast_id}")
def delete_notification_broadcast(
    broadcast_id: str,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    clean_id = str(broadcast_id or "").strip()[:160]
    if not clean_id:
        raise ApiError("Broadcast ID is required.", 400)
    db = _db()
    ref = db.collection("adminBroadcasts").document(clean_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Broadcast record not found.", 404)
    before = _doc_dict(snap)
    ref.delete()
    write_audit_log(
        admin_user,
        "notification.broadcast_delete",
        "adminBroadcast",
        clean_id,
        before,
        {},
        f"Deleted broadcast history record '{before.get('title') or clean_id}'",
    )
    return {"ok": True, "deletedId": clean_id}


@router.post("/notifications/broadcasts/bulk-delete")
def bulk_delete_notification_broadcasts(
    body: BulkBroadcastDeleteBody,
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
) -> dict[str, Any]:
    raw_ids = body.broadcastIds or body.ids or []
    clean_ids = [str(i).strip()[:160] for i in raw_ids if str(i).strip()]
    if not clean_ids:
        raise ApiError("No broadcast IDs provided for deletion.", 400)
    db = _db()
    batch = db.batch()
    deleted_ids: list[str] = []
    for bid in dict.fromkeys(clean_ids):
        ref = db.collection("adminBroadcasts").document(bid)
        snap = ref.get()
        if not snap.exists:
            continue
        batch.delete(ref)
        deleted_ids.append(bid)
    if deleted_ids:
        batch.commit()
        write_audit_log(
            admin_user,
            "notification.broadcast_bulk_delete",
            "adminBroadcast",
            "bulk",
            {},
            {"deletedIds": deleted_ids},
            f"Bulk deleted {len(deleted_ids)} broadcast history records",
        )
    return {"ok": True, "deletedCount": len(deleted_ids), "deletedIds": deleted_ids}


# ---------------------------------------------------------------------------
# Distance Disparity Review & Resolution Endpoints (Backend-only)
# ---------------------------------------------------------------------------

KOLKATA_TZ = ZoneInfo("Asia/Kolkata")


def _kolkata_day_str(moment: Optional[datetime] = None) -> str:
    from ..core.service_day import service_date_str
    return service_date_str(moment)


class DistanceReviewDecisionBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    decision: Optional[str] = None
    approved_km: Optional[float] = None
    note: Optional[str] = None


@router.get("/distance-reviews")
def list_distance_reviews(
    status: Optional[str] = None,
    driverId: Optional[str] = None,
    driver_id: Optional[str] = None,
    dayKey: Optional[str] = None,
    fromDayKey: Optional[str] = None,
    toDayKey: Optional[str] = None,
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    cursor: Optional[str] = None,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """List distance disparity reviews with filtering and pagination."""
    db = _db()
    limit = _clamp_limit(limit)
    base = db.collection("distanceReviews")

    target_driver = driverId or driver_id
    if status:
        base = base.where("status", "==", status.strip().upper())
    if target_driver:
        base = base.where("driverId", "==", target_driver.strip())
    if dayKey:
        base = base.where("dayKey", "==", dayKey.strip())
    else:
        if fromDayKey:
            base = base.where("dayKey", ">=", fromDayKey.strip())
        if toDayKey:
            base = base.where("dayKey", "<=", toDayKey.strip())

    try:
        base_ordered = base.order_by("created_at", direction=fb_firestore.Query.DESCENDING)
        items, next_cursor = _paginate(base_ordered, cursor, limit, "distanceReviews")
    except Exception:
        try:
            base_ordered = base.order_by("rideId", direction=fb_firestore.Query.DESCENDING)
            items, next_cursor = _paginate(base_ordered, cursor, limit, "distanceReviews")
        except Exception:
            items, next_cursor = _paginate(base, cursor, limit, "distanceReviews")

    return {
        "ok": True,
        "reviews": items,
        "items": items,
        "nextCursor": next_cursor,
        "next_cursor": next_cursor,
    }


@router.get("/distance-reviews/{ride_id}")
def get_distance_review_detail(
    ride_id: str,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """Get full details of a distance review, including ride, driver, and evidence."""
    clean_id = str(ride_id).strip()[:160]
    db = _db()
    snap = db.collection("distanceReviews").document(clean_id).get()
    if not snap.exists:
        raise ApiError("Distance review not found.", 404)
    review_data = snap.to_dict() or {}
    review_data["id"] = snap.id

    ride_snap = db.collection("rides").document(clean_id).get()
    ride_data = ride_snap.to_dict() if ride_snap.exists else None

    driver_id = str(review_data.get("driverId") or "")
    driver_data = None
    if driver_id:
        driver_snap = db.collection("users").document(driver_id).get()
        if driver_snap.exists:
            driver_data = driver_snap.to_dict() or {}
            driver_data["id"] = driver_snap.id

    daily_doc_id = str(review_data.get("dailyStatsDocId") or "")
    daily_stats = None
    if daily_doc_id:
        daily_snap = db.collection("driverDailyStats").document(daily_doc_id).get()
        if daily_snap.exists:
            daily_stats = daily_snap.to_dict() or {}
            daily_stats["id"] = daily_snap.id

    return {
        "ok": True,
        "review": review_data,
        "ride": ride_data,
        "driver": driver_data,
        "dailyStats": daily_stats,
    }


@router.post("/distance-reviews/{ride_id}/decision")
def decide_distance_review(
    ride_id: str,
    body: DistanceReviewDecisionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """Execute an admin distance disparity decision (approve/decline) in one atomic transaction."""
    clean_id = str(ride_id).strip()[:160]
    decision = str(body.decision or "").strip().lower()
    if decision not in {"approve", "decline"}:
        raise ApiError("Decision must be 'approve' or 'decline'.", 422)

    note = str(body.note or "").strip()
    if not note or len(note) > 500:
        raise ApiError("Note is required (1-500 characters).", 422)

    db = _db()
    review_ref = db.collection("distanceReviews").document(clean_id)
    result_holder: dict[str, Any] = {}
    transaction = db.transaction()

    @fb_firestore.transactional
    def decision_transaction(tx):
        review_snap = review_ref.get(transaction=tx)
        if not review_snap.exists:
            raise ApiError("Distance review not found.", 404)
        review = review_snap.to_dict() or {}
        current_status = str(review.get("status") or "").upper()

        P = float(review.get("planned_km") or 0.0)
        prov_km = float(review.get("provisional_km") or 0.0)

        if decision == "approve":
            if body.approved_km is not None:
                decided_km = float(body.approved_km)
            else:
                decided_km = prov_km
            max_allowed = min(300.0, max(3.0 * P, P + 10.0))
            if decided_km < 0.0 or decided_km > max_allowed or decided_km > 300.0:
                raise ApiError(f"approved_km must be between 0 and {max_allowed:.2f} km.", 422)
        else:
            decided_km = 0.0

        # Check for idempotency or conflict on already-decided review
        if current_status != "PENDING":
            if decision == "approve" and current_status == "APPROVED" and abs(float(review.get("decided_km") or 0.0) - decided_km) < 1e-3:
                result_holder.update({
                    "ok": True,
                    "rideId": clean_id,
                    "status": "APPROVED",
                    "decided_km": decided_km,
                    "decided_by": review.get("decided_by"),
                    "message": "Decision already applied.",
                })
                return
            if decision == "decline" and current_status == "DECLINED":
                result_holder.update({
                    "ok": True,
                    "rideId": clean_id,
                    "status": "DECLINED",
                    "decided_km": 0.0,
                    "decided_by": review.get("decided_by"),
                    "message": "Decision already applied.",
                })
                return
            raise ApiError("This review has already been decided with a conflicting decision.", 409)

        admin_identity = str(admin_user.get("email") or admin_user.get("uid") or "admin")
        daily_doc_id = str(review.get("dailyStatsDocId") or f"{review.get('driverId')}_{review.get('dayKey')}")
        daily_ref = db.collection("driverDailyStats").document(daily_doc_id)
        daily_snap = daily_ref.get(transaction=tx)
        daily_data = daily_snap.to_dict() or {} if daily_snap.exists else {}

        orig_ur_km = float(daily_data.get("under_review_km") or 0.0)
        orig_ur_count = int(daily_data.get("under_review_count") or 0)
        new_ur_km = max(0.0, round(orig_ur_km - prov_km, 3))
        new_ur_count = max(0, orig_ur_count - 1)

        daily_updates: dict[str, Any] = {
            "under_review_km": new_ur_km,
            "under_review_count": new_ur_count,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        if decision == "approve" and decided_km > 0:
            curr_dist = float(daily_data.get("distance_km") or 0.0)
            daily_updates["distance_km"] = round(curr_dist + decided_km, 3)

        tx.set(daily_ref, daily_updates, merge=True)

        if decision == "approve" and decided_km > 0:
            driver_ref = db.collection("users").document(str(review.get("driverId")))
            # lifetime_distance_km counts only from deployment onward. Do NOT backfill.
            tx.set(driver_ref, {"lifetime_distance_km": fb_firestore.Increment(round(decided_km, 3))}, merge=True)

        after_day_close = (review.get("dayKey") != _kolkata_day_str())
        adj_ref = daily_ref.collection("adjustments").document(clean_id)
        tx.set(adj_ref, {
            "rideId": clean_id,
            "decision": decision,
            "decided_km": round(decided_km, 3),
            "admin": admin_identity,
            "timestamp": fb_firestore.SERVER_TIMESTAMP,
            "note": note,
            "after_day_close": after_day_close,
        })

        new_status = "APPROVED" if decision == "approve" else "DECLINED"
        tx.update(review_ref, {
            "status": new_status,
            "decided_by": admin_identity,
            "decided_at": fb_firestore.SERVER_TIMESTAMP,
            "decided_km": round(decided_km, 3),
            "note": note,
            "updated_at": fb_firestore.SERVER_TIMESTAMP,
        })

        new_dist_status = "counted" if decision == "approve" and decided_km > 0 else ("zero" if decision == "approve" else "declined")
        hist_ref = db.collection("tripHistory").document(clean_id)
        r_ref = db.collection("rides").document(clean_id)
        status_updates = {
            "distance_status": new_dist_status,
            "counted_distance_km": round(decided_km, 3),
            "distance_reviewed_at": fb_firestore.SERVER_TIMESTAMP,
            "distance_reviewed_by": admin_identity,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.set(hist_ref, status_updates, merge=True)
        tx.set(r_ref, status_updates, merge=True)

        result_holder.update({
            "ok": True,
            "rideId": clean_id,
            "status": new_status,
            "decided_km": round(decided_km, 3),
            "decided_by": admin_identity,
        })

    decision_transaction(transaction)
    
    try:
        from ..core.fee_engine import reconcile_fee_adjustment
        rev_snap = review_ref.get()
        if rev_snap.exists:
            rev_data = rev_snap.to_dict() or {}
            d_id = str(rev_data.get("driverId") or "")
            d_day = str(rev_data.get("dayKey") or "")
            if d_id and d_day:
                reconcile_fee_adjustment(
                    db,
                    uid=d_id,
                    service_date_val=d_day,
                    source="admin_distance_approval",
                    ride_id=clean_id,
                )
    except Exception as fee_reconcile_err:
        logger.warning("Failed to reconcile fee adjustment for ride %s: %s", clean_id, fee_reconcile_err)

    write_audit_log(
        admin_user,
        "distance_review.decision",
        "distanceReview",
        clean_id,
        {},
        {"decision": decision, "decided_km": result_holder.get("decided_km"), "note": note},
        f"Admin {admin_user.get('email') or 'admin'} decided review {clean_id}: {decision} ({result_holder.get('decided_km')} km)",
    )

    return result_holder





