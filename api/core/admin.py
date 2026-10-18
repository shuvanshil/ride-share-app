"""
Admin-boundary helpers: who counts as an administrator, and how admin
actions get written to the audit trail.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Header
from firebase_admin import firestore as fb_firestore

from .auth import verify_firebase_token
from .errors import ApiError
from .firebase import get_admin_app


def get_user_admin_role(uid: str, email: str = "") -> str:
    """Retrieves the administrative role for a given user from `adminRoles`.
    If no record exists yet for a user with the `admin: true` claim, they are
    automatically bootstrapped as `super_admin` (as all pre-existing admin
    accounts are Super Admins)."""
    try:
        db = fb_firestore.client(get_admin_app())
        ref = db.collection("adminRoles").document(uid)
        snap = ref.get()
        if snap.exists:
            data = snap.to_dict() or {}
            return data.get("role") or "admin"
        
        # Bootstrap pre-existing admin as super_admin
        role = "super_admin"
        ref.set({
            "uid": uid,
            "email": email,
            "role": role,
            "assignedBy": "system",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP
        }, merge=True)
        return role
    except Exception:
        return "super_admin"


def require_admin(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """FastAPI dependency: verifies the Firebase ID token AND the admin claim.
    Attaches the user's administrative role (super_admin, admin, or manager)."""
    decoded = verify_firebase_token(authorization)
    if decoded.get("admin") is not True:
        raise ApiError("Admin access required.", 403)
    
    uid = decoded.get("uid") or decoded.get("sub") or ""
    email = decoded.get("email") or ""
    role = get_user_admin_role(uid, email)
    decoded["adminRole"] = role
    return decoded


def require_super_admin(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """Requires Super Admin role (access to Permissions & role changes)."""
    admin_user = require_admin(authorization)
    if admin_user.get("adminRole") != "super_admin":
        raise ApiError("Super Admin access required for permission management.", 403)
    return admin_user


def require_admin_or_super_admin(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """Requires Admin or Super Admin role (blocks Manager from restricted sections)."""
    admin_user = require_admin(authorization)
    if admin_user.get("adminRole") not in {"super_admin", "admin"}:
        raise ApiError("This section is restricted to Admins and Super Admins.", 403)
    return admin_user


def write_audit_log(
    admin_user: dict[str, Any],
    action: str,
    target_type: str,
    target_id: str,
    before: Optional[dict[str, Any]] = None,
    after: Optional[dict[str, Any]] = None,
    notes: str = "",
) -> None:
    """Best-effort audit trail entry."""
    try:
        db = fb_firestore.client(get_admin_app())
        role = admin_user.get("adminRole") or "super_admin"
        db.collection("auditLogs").document().set(
            {
                "adminUid": admin_user.get("uid"),
                "adminEmail": admin_user.get("email") or "",
                "adminRole": role,
                "action": action[:80],
                "targetType": target_type[:40],
                "targetId": str(target_id)[:160],
                "before": _redact(before),
                "after": _redact(after),
                "notes": notes[:500],
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            }
        )
    except Exception:  # noqa: BLE001
        pass


def _redact(value: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Keep the audit log free of secrets even if a caller passes a raw doc."""
    if not value:
        return {}
    drop = {"password", "pushTokens", "pushTokenDetails", "verification_pin"}
    return {k: v for k, v in value.items() if k not in drop}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
