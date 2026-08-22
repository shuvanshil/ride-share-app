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
from datetime import datetime, date, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from google.api_core import exceptions as gcloud_exceptions
from pydantic import BaseModel, ConfigDict, Field

from api.core.admin import (
    now_utc,
    require_admin,
    require_super_admin,
    require_admin_or_super_admin,
    write_audit_log,
)
from api.core.config import get_env
from api.core.errors import ApiError
from api.core.firebase import get_admin_app

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


def _clamp_limit(limit: int) -> int:
    return max(1, min(limit, MAX_PAGE_SIZE))


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


def _backfill_driver_names(rides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    missing_ids = {
        r.get("driver_id")
        for r in rides
        if r.get("driver_id") and not str(r.get("driver_name") or "").strip()
    }
    if not missing_ids:
        return rides
    db = _db()
    names: dict[str, str] = {}
    for uid in missing_ids:
        snap = db.collection("users").document(uid).get()
        if snap.exists:
            data = snap.to_dict() or {}
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

    drivers_coll = db.collection("users").where("role", "==", "driver")
    total_drivers = _safe_count(drivers_coll)
    pending_drivers = _safe_count(drivers_coll.where("verificationStatus", "==", "pending_review"))
    suspended_drivers = _safe_count(drivers_coll.where("verificationStatus", "==", "suspended"))
    blocked_drivers = _safe_count(drivers_coll.where("verificationStatus", "==", "blocked"))
    active_online_drivers = _safe_count(drivers_coll.where("driverAvailability", "in", ["online", "searching"]))
    busy_drivers = _safe_count(drivers_coll.where("driverAvailability", "==", "busy"))

    passengers_coll = db.collection("users").where("role", "==", "passenger")
    total_passengers = _safe_count(passengers_coll)
    new_passengers_today = _safe_count(passengers_coll.where("createdAt", ">=", today_start))

    total_registered = _safe_count(db.collection("users"))
    new_users_today = _safe_count(db.collection("users").where("createdAt", ">=", today_start))
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

    open_sos = _safe_count(db.collection("sosAlerts").where("status", "==", "open"))
    open_reports = _safe_count(db.collection("safetyReports").where("status", "==", "open"))

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
        },
        "drivers": {
            "total": total_drivers,
            "pendingApproval": pending_drivers,
            "suspended": suspended_drivers,
            "blocked": blocked_drivers,
            "activeOnline": active_online_drivers,
            "busy": busy_drivers,
        },
        "passengers": {
            "total": total_passengers,
            "newRegistrationsToday": new_passengers_today,
        },
        "platform": {
            "totalRegisteredUsers": total_registered,
            "totalCompletedRides": total_completed_rides,
        },
        "safety": {
            "openSosAlerts": open_sos,
            "openSafetyReports": open_reports,
        },
        "systemHealth": {
            "status": "attention" if (open_sos > 0 or open_reports > 0 or pending_drivers > 5) else "ok",
            "openSosAlerts": open_sos,
            "pendingDriversCount": pending_drivers,
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

    items, next_cursor = _paginate(base, cursor, limit, "users")
    items = _apply_search(items, q, ["name", "phone", "email", "vehicle_number", "vehicleNumber"])
    return {"ok": True, "drivers": [_sanitize_driver(i) for i in items], "nextCursor": next_cursor}


def _sanitize_driver(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": profile.get("id") or profile.get("uid"),
        "name": profile.get("name"),
        "phone": profile.get("phone"),
        "email": profile.get("email"),
        "profilePhotoUrl": profile.get("profilePhotoUrl"),
        "verificationStatus": profile.get("verificationStatus"),
        "driverAvailability": profile.get("driverAvailability"),
        "vehicleType": profile.get("vehicleType") or profile.get("vehicle_type"),
        "vehicleNumber": profile.get("vehicleNumber") or profile.get("vehicle_number"),
        "vehicleModel": profile.get("vehicleModel") or profile.get("vehicle_model"),
        "drivingLicenseNumber": profile.get("drivingLicenseNumber"),
        "upiId": profile.get("upiId"),
        "lifetimeEarnings": profile.get("lifetime_earnings") or 0,
        "totalCompletedTrips": profile.get("total_completed_trips") or 0,
        "createdAt": profile.get("createdAt"),
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

    recent_query = (
        db.collection("rides")
        .where("driver_id", "==", uid)
        .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
        .limit(20)
    )
    return {
        "ok": True,
        "driver": _sanitize_driver(profile),
        "recentRides": [_doc_dict(d) for d in _stream(recent_query)],
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
    valid_actions = {"approve", "reject", "suspend", "block", "unblock", "update"}
    if body.action not in valid_actions:
        raise ApiError(f"Unknown action '{body.action}'.", 400)

    db = _db()
    ref = db.collection("users").document(uid)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Driver not found.", 404)
    before = _doc_dict(snap)

    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
    if body.action == "approve":
        updates["verificationStatus"] = "approved"
    elif body.action == "reject":
        updates["verificationStatus"] = "rejected"
    elif body.action == "suspend":
        updates["verificationStatus"] = "suspended"
    elif body.action == "block":
        updates["verificationStatus"] = "blocked"
    elif body.action == "unblock":
        updates["verificationStatus"] = "approved"
    elif body.action == "update":
        if not body.fields:
            raise ApiError("No fields provided for update.", 400)
        allowed = {"name", "email", "vehicleType", "vehicleNumber", "vehicleModel", "drivingLicenseNumber", "upiId"}
        for k, v in body.fields.items():
            if k in allowed and v is not None:
                updates[k] = str(v).strip()

    ref.set(updates, merge=True)
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

    items, next_cursor = _paginate(base, cursor, limit, "users")
    items = _apply_search(items, q, ["name", "phone", "email"])
    return {"ok": True, "passengers": [_sanitize_passenger(i) for i in items], "nextCursor": next_cursor}


def _sanitize_passenger(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": profile.get("id") or profile.get("uid"),
        "name": profile.get("name"),
        "phone": profile.get("phone"),
        "email": profile.get("email"),
        "accountStatus": profile.get("accountStatus") or "active",
        "createdAt": profile.get("createdAt"),
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
    valid = {"restrict", "unrestrict", "block", "unblock"}
    if body.action not in valid:
        raise ApiError("Unknown passenger action.", 400)

    db = _db()
    ref = db.collection("users").document(uid)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Passenger not found.", 404)
    before = _doc_dict(snap)

    target_status = {
        "restrict": "restricted",
        "unrestrict": "active",
        "block": "blocked",
        "unblock": "active",
    }[body.action]

    updates = {"accountStatus": target_status, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
    ref.set(updates, merge=True)
    write_audit_log(admin_user, f"passenger.{body.action}", "passenger", uid, before, updates, body.notes)
    return {"ok": True, "passenger": _sanitize_passenger(_doc_dict(ref.get()))}


# ---------------------------------------------------------------------------
# Rides (Live + History restricted for Managers)
# ---------------------------------------------------------------------------

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
    return {"ok": True, "rides": _backfill_driver_names(docs)}


@router.get("/rides/history")
def list_ride_history(
    admin_user: dict[str, Any] = Depends(require_admin_or_super_admin),
    status: Optional[str] = Query(default=None),
    vehicleType: Optional[str] = Query(default=None),
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
    if hasFeedback is not None:
        base = base.where("feedback.submitted", "==", hasFeedback)

    if dateFrom and dateTo:
        base = base.where("createdAt", ">=", _day_range_utc(dateFrom, "dateFrom")).where(
            "createdAt", "<", _day_range_utc(dateTo, "dateTo")
        )
    elif dateFrom:
        base = base.where("createdAt", ">=", _day_range_utc(dateFrom, "dateFrom"))

    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "rides")
    items = _apply_search(items, q, ["driver_name", "pickup_name", "drop_name", "passenger_id", "driver_id"])
    return {"ok": True, "rides": _backfill_driver_names(items), "nextCursor": next_cursor}


class RideActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=1, max_length=30)
    fare: Optional[float] = None
    notes: Optional[str] = Field(default=None, max_length=500)


@router.patch("/rides/{ride_id}")
def update_ride(
    ride_id: str,
    body: RideActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    ref = db.collection("rides").document(ride_id)
    snap = ref.get()
    if not snap.exists:
        raise ApiError("Ride not found.", 404)
    before = _doc_dict(snap)

    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}

    if body.action == "cancel":
        if before.get("status") in TERMINAL_RIDE_STATUSES:
            raise ApiError("Ride is already in a terminal state.", 400)
        updates["status"] = "cancelled_by_passenger"
        updates["cancellationReason"] = "Cancelled by administrator"
        updates["cancelledAt"] = fb_firestore.SERVER_TIMESTAMP
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
        buckets[d] = {"date": d, "rides": 0, "completed": 0, "cancelled": 0, "fare": 0.0}

    for data in docs:
        created = data.get("createdAt")
        if not isinstance(created, datetime):
            continue
        key = created.astimezone(timezone.utc).strftime("%Y-%m-%d")
        bucket = buckets.setdefault(key, {"date": key, "rides": 0, "completed": 0, "cancelled": 0, "fare": 0.0})
        bucket["rides"] += 1
        status = str(data.get("status") or "")
        if status == "completed":
            bucket["completed"] += 1
            bucket["fare"] += float(data.get("fare") or 0)
        elif status.startswith("cancelled"):
            bucket["cancelled"] += 1

    ordered = sorted(buckets.values(), key=lambda b: b["date"])
    for b in ordered:
        b["fare"] = round(b["fare"], 2)
    return {"ok": True, "days": ordered}


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
