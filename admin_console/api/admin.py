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

New collection introduced here: `auditLogs/{logId}` (server-only writes,
never readable by clients directly).
"""
from __future__ import annotations

import hmac
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from google.api_core import exceptions as gcloud_exceptions
from pydantic import BaseModel, ConfigDict, Field

from admin_console.api.core.admin import now_utc, require_admin, write_audit_log
from api.core.config import get_env
from api.core.errors import ApiError
from api.core.firebase import get_admin_app

router = APIRouter(prefix="/admin", tags=["admin"])

DRIVER_STATUSES = {"pending_review", "approved", "rejected", "suspended", "blocked"}
PASSENGER_STATUSES = {"active", "restricted", "blocked"}
ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"]
TERMINAL_RIDE_STATUSES = ["completed", "cancelled_by_passenger", "cancelled_by_driver"]
# Grouped status values the console's drill-downs and filters accept, in
# addition to one exact Firestore status string. "all" skips the status
# filter entirely (date-only browsing of every ride, any status).
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
MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 25


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _db():
    return fb_firestore.client(get_admin_app())


def _clamp_limit(limit: int) -> int:
    return max(1, min(MAX_PAGE_SIZE, limit))


def _count(query) -> int:
    """Server-side count aggregation, with a bounded fallback for older
    google-cloud-firestore versions that don't expose `.count()`."""
    try:
        result = query.count().get()
        return int(result[0][0].value)
    except AttributeError:
        return len(query.limit(1000).get())
    except Exception:  # noqa: BLE001
        return 0


def _stream(query) -> list:
    """Runs `.stream()` and turns a missing-composite-index failure into a
    clear, actionable 503 instead of an opaque 500. `FailedPrecondition` is
    exactly what Firestore raises when a query (usually a `.where(...)`
    combined with `.order_by(...)`) needs a composite index that hasn't been
    created yet -- see docs/firestore-indexes.md / firestore.indexes.json for
    the exact indexes this console needs."""
    try:
        return list(query.stream())
    except gcloud_exceptions.FailedPrecondition as exc:
        raise ApiError(
            "This view needs a Firestore index that hasn't been created yet. "
            "Ask whoever manages the Firebase project to deploy the indexes "
            "in firestore.indexes.json (or open the Firebase console link "
            "from the server logs for this exact query).",
            503,
            {"firestoreIndexError": str(exc)[:300]},
        ) from exc


def _doc_dict(snapshot) -> dict[str, Any]:
    data = snapshot.to_dict() or {}
    data["id"] = snapshot.id
    return data


def _paginate(base_query, cursor: Optional[str], limit: int, id_field_collection: str):
    """Apply an opaque document-id cursor to an already `.order_by(...)`
    query. `cursor` is the `id` of the last row the client already has."""
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
    """Some rides -- typically ones accepted before `driver_name` was
    reliably written, or where the profile's `name` was blank at accept
    time -- have a `driver_id` but no usable `driver_name`. Rather than show
    a blank cell in the admin console, look the current name up from
    `users/{driver_id}` once per distinct driver and patch it in for
    display only (this never writes back to the ride document)."""
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
    """UTC-midnight boundary for a YYYY-MM-DD string. Buckets are UTC days,
    not Asia/Kolkata days -- close enough for admin filtering/reporting, and
    documented here so it isn't mistaken for IST-exact."""
    d = _parse_day(day_str, field_name)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _apply_search(items: list[dict[str, Any]], q: str, fields: list[str]) -> list[dict[str, Any]]:
    """Firestore has no native substring search; for the moderate row counts
    an admin page fetches at once, filtering the fetched page in Python is
    simpler and cheaper than maintaining a search index. This only filters
    within the current page -- see the docstring on the drivers/passengers
    list endpoints for the tradeoff this implies."""
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
# Session check
# ---------------------------------------------------------------------------

@router.get("/verify")
def verify_admin(admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """The dashboard calls this right after Firebase sign-in to confirm the
    admin claim is present before rendering anything else."""
    return {
        "ok": True,
        "uid": admin_user.get("uid"),
        "email": admin_user.get("email"),
        "name": admin_user.get("name") or admin_user.get("email"),
    }


class BootstrapAdminBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    secret: str = Field(min_length=1, max_length=200)


@router.post("/bootstrap")
def bootstrap_admin(body: BootstrapAdminBody) -> dict[str, Any]:
    """Grants the admin custom claim to an existing Firebase Auth user,
    without needing an existing admin session or a locally-run script.

    Gated by ADMIN_BOOTSTRAP_SECRET -- a Vercel env var you make up
    yourself (NOT a Firebase credential). Set it once, call this endpoint
    for each person you want to make an admin, then optionally remove the
    env var again. This intentionally does not require an existing admin,
    so the first admin can be created with nothing more than a Firebase
    Auth account and this one secret.
    """
    configured_secret = get_env("ADMIN_BOOTSTRAP_SECRET")
    if not configured_secret:
        raise ApiError("Admin bootstrap is not configured on this deployment.", 503)
    if not hmac.compare_digest(body.secret, configured_secret):
        raise ApiError("Invalid bootstrap secret.", 403)

    try:
        user = fb_auth.get_user_by_email(body.email.strip().lower(), app=get_admin_app())
    except fb_auth.UserNotFoundError:
        raise ApiError("No Firebase Auth user exists with that email yet. Create it first.", 404)

    claims = dict(user.custom_claims or {})
    claims["admin"] = True
    fb_auth.set_custom_user_claims(user.uid, claims, app=get_admin_app())
    # Force any already-open session to re-mint its ID token with the claim.
    fb_auth.revoke_refresh_tokens(user.uid, app=get_admin_app())

    write_audit_log(
        {"uid": user.uid, "email": user.email},
        "admin.bootstrap_grant",
        "user",
        user.uid,
        None,
        {"admin": True},
        "Granted via /api/admin/bootstrap",
    )
    return {"ok": True, "uid": user.uid, "email": user.email, "message": "Admin access granted. Sign in at /admin."}


# ---------------------------------------------------------------------------
# Dashboard overview
# ---------------------------------------------------------------------------

@router.get("/overview")
def get_overview(admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    db = _db()
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    users = db.collection("users")
    drivers = users.where("role", "==", "driver")
    passengers = users.where("role", "==", "passenger")

    driver_counts = {
        status: _count(drivers.where("verificationStatus", "==", status))
        for status in DRIVER_STATUSES
    }
    online_count = _count(drivers.where("driverAvailability", "in", ["online", "searching"]))
    busy_count = _count(drivers.where("driverAvailability", "==", "busy"))
    offline_count = _count(drivers.where("driverAvailability", "==", "offline"))

    rides = db.collection("rides")
    today_rides_query = rides.where("createdAt", ">=", today_start)
    active_ride_docs = _stream(rides.where("status", "in", ACTIVE_RIDE_STATUSES).limit(500))
    active_rides_count = len(active_ride_docs)
    active_ride_passenger_ids = sorted(
        {d.to_dict().get("passenger_id") for d in active_ride_docs if d.to_dict().get("passenger_id")}
    )

    today_docs = list(today_rides_query.stream())
    today_total = len(today_docs)
    today_completed = sum(1 for d in today_docs if d.to_dict().get("status") == "completed")
    today_cancelled = sum(
        1 for d in today_docs if str(d.to_dict().get("status", "")).startswith("cancelled")
    )
    today_fare_collected = sum(
        float(d.to_dict().get("fare") or 0)
        for d in today_docs
        if d.to_dict().get("status") == "completed"
    )
    today_distance = sum(float(d.to_dict().get("distance_km") or 0) for d in today_docs)
    completed_today_count = max(today_completed, 1) if today_completed else 0

    new_users_today = _count(users.where("createdAt", ">=", today_start))
    new_drivers_today = _count(drivers.where("createdAt", ">=", today_start))

    # A lightweight, best-effort health signal for the dashboard's "system
    # health" card -- not a real uptime monitor, just enough for an admin to
    # notice "nothing has happened in a while" at a glance. Never raises:
    # a failure here degrades to "unknown" rather than breaking the whole
    # overview response.
    system_health: dict[str, Any] = {"status": "ok", "notes": []}
    try:
        last_audit = list(
            db.collection("auditLogs").order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(1).stream()
        )
        system_health["lastAdminActionAt"] = _doc_dict(last_audit[0]).get("createdAt") if last_audit else None
    except Exception:  # noqa: BLE001
        system_health["status"] = "unknown"
        system_health["notes"].append("Could not read the audit log.")
    if active_rides_count > 0 and online_count == 0:
        system_health["status"] = "attention"
        system_health["notes"].append("There are active rides but no drivers currently online.")
    if driver_counts.get("pending_review", 0) > 0:
        system_health["notes"].append(
            f"{driver_counts.get('pending_review', 0)} driver(s) waiting for approval."
        )

    return {
        "ok": True,
        "systemHealth": system_health,
        "today": {
            "totalRides": today_total,
            "completedRides": today_completed,
            "cancelledRides": today_cancelled,
            "activeRides": active_rides_count,
            "activeRidePassengerIds": active_ride_passenger_ids,
            "totalDistanceKm": round(today_distance, 1),
            "totalFareCollected": round(today_fare_collected, 2),
            "averageRideDistanceKm": round(today_distance / today_total, 2) if today_total else 0,
            "newUsersToday": new_users_today,
            "newDriversToday": new_drivers_today,
        },
        "drivers": {
            "total": sum(driver_counts.values()),
            "activeOnline": online_count,
            "busy": busy_count,
            "offline": offline_count,
            "pendingApproval": driver_counts.get("pending_review", 0),
            "suspended": driver_counts.get("suspended", 0),
            "blocked": driver_counts.get("blocked", 0),
            "approved": driver_counts.get("approved", 0),
        },
        "passengers": {
            "total": _count(passengers),
            "newRegistrationsToday": _count(passengers.where("createdAt", ">=", today_start)),
        },
        "platform": {
            "totalRegisteredUsers": _count(users),
            "totalCompletedRides": _count(rides.where("status", "==", "completed")),
        },
    }


# ---------------------------------------------------------------------------
# Driver management
# ---------------------------------------------------------------------------

@router.get("/drivers")
def list_drivers(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default=None),
    availability: Optional[str] = Query(default=None),
    q: str = Query(default=""),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    """List drivers. `status` filters by verificationStatus (use
    `pending_review` for the "waiting for approval" quick filter).
    `availability` filters by current online/busy/offline state (`online`
    also matches `searching`). `q` searches name/phone/vehicle number
    *within the fetched page* -- combine with the other filters to narrow
    the page for a useful search on larger driver lists."""
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


_DRIVER_ACTION_STATUS = {
    "approve": "approved",
    "reject": "rejected",
    "suspend": "suspended",
    "block": "blocked",
    "unblock": "approved",
}
_EDITABLE_DRIVER_FIELDS = {
    "name",
    "email",
    "vehicleType",
    "vehicleNumber",
    "vehicleModel",
    "drivingLicenseNumber",
    "upiId",
}


@router.patch("/drivers/{uid}")
def update_driver(
    uid: str,
    body: DriverActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    db = _db()
    user_ref = db.collection("users").document(uid)
    snap = user_ref.get()
    if not snap.exists:
        raise ApiError("Driver not found.", 404)
    before = _doc_dict(snap)
    if before.get("role") != "driver":
        raise ApiError("This account is not a driver.", 400)

    if body.action in _DRIVER_ACTION_STATUS:
        new_status = _DRIVER_ACTION_STATUS[body.action]
        updates: dict[str, Any] = {
            "verificationStatus": new_status,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        user_ref.set(updates, merge=True)

        # Blocking/suspending a driver also takes them off the road immediately
        # and disables Firebase Auth sign-in for block (not for suspend, which
        # is meant to be a temporary, reversible hold).
        if body.action in {"block", "suspend"}:
            db.collection("driverPresence").document(uid).set(
                {"driverAvailability": "offline", "isConnected": False,
                 "updatedAt": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )
            db.collection("driverMapPresence").document(uid).set(
                {"driverAvailability": "offline", "updatedAt": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )
        try:
            if body.action == "block":
                fb_auth.update_user(uid, disabled=True, app=get_admin_app())
            elif body.action == "unblock":
                fb_auth.update_user(uid, disabled=False, app=get_admin_app())
        except Exception:  # noqa: BLE001
            pass

    elif body.action == "update":
        if not body.fields:
            raise ApiError("No fields to update were provided.", 400)
        disallowed = set(body.fields) - _EDITABLE_DRIVER_FIELDS
        if disallowed:
            raise ApiError(f"These fields cannot be edited here: {', '.join(sorted(disallowed))}.", 400)
        updates = {**body.fields, "updatedAt": fb_firestore.SERVER_TIMESTAMP}
        if "vehicleType" in updates:
            updates["vehicle_type"] = updates["vehicleType"]
        if "vehicleNumber" in updates:
            updates["vehicle_number"] = updates["vehicleNumber"]
        if "vehicleModel" in updates:
            updates["vehicle_model"] = updates["vehicleModel"]
        user_ref.set(updates, merge=True)
    else:
        raise ApiError("Unknown driver action.", 400)

    write_audit_log(admin_user, f"driver.{body.action}", "driver", uid, before, body.fields, body.notes)
    updated = _sanitize_driver(_doc_dict(user_ref.get()))
    return {"ok": True, "driver": updated}


# ---------------------------------------------------------------------------
# Passenger management
# ---------------------------------------------------------------------------

@router.get("/passengers")
def list_passengers(
    admin_user: dict[str, Any] = Depends(require_admin),
    q: str = Query(default=""),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = (
        _db()
        .collection("users")
        .where("role", "==", "passenger")
        .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    )
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


_PASSENGER_ACTION_STATUS = {
    "restrict": "restricted",
    "unrestrict": "active",
    "block": "blocked",
    "unblock": "active",
}


@router.patch("/passengers/{uid}")
def update_passenger(
    uid: str,
    body: PassengerActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if body.action not in _PASSENGER_ACTION_STATUS:
        raise ApiError("Unknown passenger action.", 400)

    db = _db()
    user_ref = db.collection("users").document(uid)
    snap = user_ref.get()
    if not snap.exists:
        raise ApiError("Passenger not found.", 404)
    before = _doc_dict(snap)
    if before.get("role") != "passenger":
        raise ApiError("This account is not a passenger.", 400)

    new_status = _PASSENGER_ACTION_STATUS[body.action]
    user_ref.set(
        {"accountStatus": new_status, "updatedAt": fb_firestore.SERVER_TIMESTAMP}, merge=True
    )
    try:
        fb_auth.update_user(uid, disabled=(body.action == "block"), app=get_admin_app())
    except Exception:  # noqa: BLE001
        pass

    write_audit_log(admin_user, f"passenger.{body.action}", "passenger", uid, before, None, body.notes)
    return {"ok": True, "passenger": _sanitize_passenger(_doc_dict(user_ref.get()))}


# ---------------------------------------------------------------------------
# Live ride monitoring
# ---------------------------------------------------------------------------

@router.get("/rides/live")
def list_live_rides(admin_user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    db = _db()
    query = (
        db.collection("rides")
        .where("status", "in", ACTIVE_RIDE_STATUSES)
        .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
        .limit(200)
    )
    items = [_doc_dict(d) for d in _stream(query)]
    items = _backfill_driver_names(items)
    return {"ok": True, "rides": items}


class RideActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str = Field(min_length=1, max_length=30)
    notes: str = Field(default="", max_length=500)
    fare: Optional[float] = None
    pickupName: Optional[str] = Field(default=None, max_length=200)
    dropName: Optional[str] = Field(default=None, max_length=200)


@router.patch("/rides/{ride_id}")
def update_ride(
    ride_id: str,
    body: RideActionBody,
    admin_user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """Administrative overrides to an in-flight or just-finished ride.
    Passenger/driver-facing transitions (accept/arrive/start/complete) stay
    owned by routers/rides.py; this endpoint only covers the admin-specific
    actions the console needs: cancelling a stuck ride, correcting a fare
    or address after the fact, and appending an internal admin note."""
    db = _db()
    ride_ref = db.collection("rides").document(ride_id)
    snap = ride_ref.get()
    if not snap.exists:
        raise ApiError("Ride not found.", 404)
    before = _doc_dict(snap)

    updates: dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
    if body.action == "cancel":
        if before.get("status") not in ACTIVE_RIDE_STATUSES:
            raise ApiError("Only an active ride can be cancelled.", 409)
        updates["status"] = "cancelled_by_passenger"
        updates["cancelledAt"] = fb_firestore.SERVER_TIMESTAMP
        updates["adminCancelled"] = True
        if body.notes:
            updates["cancellationReason"] = body.notes[:300]
    elif body.action == "update_fare":
        if body.fare is None or body.fare < 0:
            raise ApiError("A valid fare amount is required.", 400)
        updates["fare"] = round(body.fare, 2)
        updates["fareAdjustedByAdmin"] = True
    elif body.action == "edit_addresses":
        if body.pickupName:
            updates["pickupName"] = body.pickupName[:200]
        if body.dropName:
            updates["dropName"] = body.dropName[:200]
        if "pickupName" not in updates and "dropName" not in updates:
            raise ApiError("Provide at least one address to update.", 400)
    elif body.action == "add_note":
        if not body.notes.strip():
            raise ApiError("Note text is required.", 400)
        existing = before.get("adminNotes") or []
        existing = existing if isinstance(existing, list) else []
        existing.append(
            {
                "text": body.notes.strip()[:500],
                "byEmail": admin_user.get("email") or "",
                "at": now_utc().isoformat(),
            }
        )
        updates["adminNotes"] = existing[-50:]  # bounded, newest 50 notes
    else:
        raise ApiError("Unknown ride action.", 400)

    ride_ref.set(updates, merge=True)

    write_audit_log(admin_user, f"ride.{body.action}", "ride", ride_id, before, updates, body.notes)
    return {"ok": True, "ride": _doc_dict(ride_ref.get())}


# ---------------------------------------------------------------------------
# Ride history
# ---------------------------------------------------------------------------

@router.get("/rides/history")
def list_ride_history(
    admin_user: dict[str, Any] = Depends(require_admin),
    status: Optional[str] = Query(default=None),
    vehicleType: Optional[str] = Query(default=None),
    driverId: Optional[str] = Query(default=None),
    passengerId: Optional[str] = Query(default=None),
    dateFrom: Optional[str] = Query(default=None, description="Inclusive, YYYY-MM-DD (UTC day)."),
    dateTo: Optional[str] = Query(default=None, description="Exclusive, YYYY-MM-DD (UTC day)."),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    """Reads rides straight from `rides` (not `tripHistory`, which uses a
    different field schema -- pickup_location/fare_amount/trip_status --
    built for passenger/driver receipts). Keeping the admin console on one
    schema means a fare correction here is immediately reflected with no
    risk of the two collections drifting out of sync.

    `status` accepts either one exact Firestore status (e.g.
    `cancelled_by_driver`, for the Ride History page's dropdown) or one of
    the grouped values in RIDE_STATUS_GROUPS (`all`, `active`, `completed`,
    `cancelled` -- used by the dashboard's clickable KPI cards). Leaving it
    out entirely keeps the original default: completed/cancelled rides
    only. `dateFrom`/`dateTo` narrow to a day or a month (pass the first day
    of this month and the first day of next month) using UTC day
    boundaries."""
    limit = _clamp_limit(limit)
    base = _db().collection("rides")
    if status:
        if status in RIDE_STATUS_GROUPS:
            values = RIDE_STATUS_GROUPS[status]
            if values is not None:
                base = base.where("status", "in", values)
        elif status in ACTIVE_RIDE_STATUSES or status in TERMINAL_RIDE_STATUSES:
            base = base.where("status", "==", status)
        else:
            raise ApiError("Unknown ride status filter.", 400)
    elif not dateFrom and not dateTo:
        base = base.where("status", "in", TERMINAL_RIDE_STATUSES)
    if vehicleType:
        base = base.where("vehicle_type", "==", vehicleType)
    if driverId:
        base = base.where("driver_id", "==", driverId)
    if passengerId:
        base = base.where("passenger_id", "==", passengerId)
    if dateFrom:
        base = base.where("createdAt", ">=", _day_range_utc(dateFrom, "dateFrom"))
    if dateTo:
        base = base.where("createdAt", "<", _day_range_utc(dateTo, "dateTo"))
    base = base.order_by("createdAt", direction=fb_firestore.Query.DESCENDING)

    items, next_cursor = _paginate(base, cursor, limit, "rides")
    items = _backfill_driver_names(items)
    return {"ok": True, "rides": items, "nextCursor": next_cursor}


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@router.get("/analytics/rides-daily")
def rides_daily(
    admin_user: dict[str, Any] = Depends(require_admin),
    days: int = Query(default=14, ge=1, le=90),
) -> dict[str, Any]:
    """Buckets ride counts/fare per calendar day (Asia/Kolkata-agnostic UTC
    buckets) over a bounded recent window. Fetches the window once and
    buckets in Python -- fine up to a few thousand rides; if ride volume
    grows well beyond that, replace this with precomputed daily rollup
    documents written by a scheduled job instead of scanning `rides`."""
    since = now_utc() - timedelta(days=days)
    docs = (
        _db()
        .collection("rides")
        .where("createdAt", ">=", since)
        .stream()
    )
    buckets: dict[str, dict[str, Any]] = {}
    for d in docs:
        data = d.to_dict() or {}
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
# Audit log
# ---------------------------------------------------------------------------

@router.get("/audit-logs")
def list_audit_logs(
    admin_user: dict[str, Any] = Depends(require_admin),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_PAGE_SIZE),
) -> dict[str, Any]:
    limit = _clamp_limit(limit)
    base = _db().collection("auditLogs").order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
    items, next_cursor = _paginate(base, cursor, limit, "auditLogs")
    return {"ok": True, "logs": items, "nextCursor": next_cursor}
