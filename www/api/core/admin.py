"""
Admin-boundary helpers: who counts as an administrator, and how admin
actions get written to the audit trail.

Administrators are identified by a Firebase Auth **custom claim**
(``admin: true``) rather than by Firestore project ownership or a
client-editable Firestore field. Custom claims are set with the Admin SDK
(see ``scripts/set_admin_claim.py``) and are embedded in the signed ID
token, so `firestore.rules` can check `request.auth.token.admin == true`
directly with no extra Firestore read, and this API can trust
`decoded_token["admin"]` from `verify_firebase_token` without querying
Firestore either. A user must refresh their ID token (re-login, or an
hour of natural token expiry) after the claim is set before it appears.

This module intentionally does not fall back to a Firestore
`users/{uid}.role == "admin"` field: that field would be writable through
the same profile-update path normal users go through, which would make
"is an admin" a client-controllable value. Keep the custom claim as the
single source of truth.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Header
from firebase_admin import firestore as fb_firestore

from api.core.auth import verify_firebase_token
from api.core.errors import ApiError
from api.core.firebase import get_admin_app


def require_admin(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """FastAPI dependency: verifies the Firebase ID token AND the admin claim."""
    decoded = verify_firebase_token(authorization)
    if decoded.get("admin") is not True:
        raise ApiError("Admin access required.", 403)
    return decoded


def write_audit_log(
    admin_user: dict[str, Any],
    action: str,
    target_type: str,
    target_id: str,
    before: Optional[dict[str, Any]] = None,
    after: Optional[dict[str, Any]] = None,
    notes: str = "",
) -> None:
    """Best-effort audit trail entry. Never raises -- an audit-log failure
    must not block or roll back the admin action it is describing."""
    try:
        db = fb_firestore.client(get_admin_app())
        db.collection("auditLogs").document().set(
            {
                "adminUid": admin_user.get("uid"),
                "adminEmail": admin_user.get("email") or "",
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
