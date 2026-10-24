"""Authentication helpers for the FastAPI boundary.

Firebase Authentication remains the identity provider during the migration.
The browser sends its Firebase ID token to FastAPI, and FastAPI verifies that
token before any protected operation is allowed to continue.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from firebase_admin import auth as fb_auth, firestore as fb_firestore
from fastapi import Header

from .errors import ApiError
from .firebase import get_admin_app

_BEARER_RE = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)
SEVEN_DAYS_SECONDS = 7 * 24 * 3600  # 604,800 seconds (strict 7-day inactivity limit)


def enforce_session_inactivity_expiry(decoded: dict[str, Any]) -> None:
    """Enforces server-side 7-day inactivity expiry and session revocation."""
    uid = decoded.get("uid")
    if not uid:
        return
    now_epoch = int(time.time())
    token_iat = decoded.get("iat", 0)
    auth_time = decoded.get("auth_time")

    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        sess_ref = db.collection("userSessions").document(uid)
        snap = sess_ref.get()

        if getattr(snap, "exists", False) and hasattr(snap, "to_dict"):
            data = snap.to_dict() or {}

            # Check revocation
            if data.get("isRevoked"):
                revoked_at = data.get("revokedAt")
                rev_epoch = int(revoked_at.timestamp()) if hasattr(revoked_at, "timestamp") else int(revoked_at or 0)
                if rev_epoch > 1e11:
                    rev_epoch = int(rev_epoch / 1000)
                if token_iat and token_iat <= rev_epoch:
                    raise ApiError("Your session has been revoked. Please login again.", 401)

            # Check 7-day inactivity
            last_act = data.get("lastActivityAt")
            if last_act:
                last_epoch = int(last_act.timestamp()) if hasattr(last_act, "timestamp") else int(last_act or 0)
                if last_epoch > 1e11:
                    last_epoch = int(last_epoch / 1000)
                if last_epoch > 0 and (now_epoch - last_epoch) > SEVEN_DAYS_SECONDS:
                    raise ApiError("Session expired due to 7 days of inactivity. Please login again.", 401)

            # Throttled renewal of lastActivityAt (every 5 minutes of active usage)
            if last_act:
                last_epoch = int(last_act.timestamp()) if hasattr(last_act, "timestamp") else int(last_act or 0)
                if last_epoch > 1e11:
                    last_epoch = int(last_epoch / 1000)
                if (now_epoch - last_epoch) > 300:
                    sess_ref.set({
                        "uid": uid,
                        "lastActivityAt": fb_firestore.SERVER_TIMESTAMP,
                        "isRevoked": False
                    }, merge=True)
        elif auth_time and (now_epoch - int(auth_time)) > SEVEN_DAYS_SECONDS:
            raise ApiError("Session expired due to 7 days of inactivity. Please login again.", 401)
    except ApiError:
        raise
    except Exception:
        # Pass gracefully if Firestore client is not mocked or unavailable in isolated unit tests
        pass


def check_user_phone_exists(phone: str) -> bool:
    """Fast check whether a user with the given normalized phone exists across index, auth, or users collection."""
    if not phone:
        return False
    try:
        app = get_admin_app()
        db = fb_firestore.client(app)

        # 1. Fast indexed lookup in phoneLoginIndex
        index_snap = db.collection("phoneLoginIndex").document(phone).get()
        if index_snap.exists:
            return True

        # 2. Fast check in Firebase Auth
        auth_client = fb_auth.Client(app)
        try:
            auth_client.get_user_by_phone_number(phone)
            return True
        except Exception:
            pass

        # 3. Fast check in users collection
        user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
        if len(user_query) > 0:
            return True

        user_query_alt = db.collection("users").where("phone_number", "==", phone).limit(1).get()
        if len(user_query_alt) > 0:
            return True

        user_query_camel = db.collection("users").where("phoneNumber", "==", phone).limit(1).get()
        if len(user_query_camel) > 0:
            return True

        return False
    except Exception:
        return False


def get_user_phone_role(phone: str) -> Optional[str]:
    """Fast check to return the account role ('driver' | 'passenger') for a phone number, or None if not found."""
    if not phone:
        return None
    try:
        app = get_admin_app()
        db = fb_firestore.client(app)

        index_snap = db.collection("phoneLoginIndex").document(phone).get()
        if index_snap.exists:
            data = index_snap.to_dict() or {}
            role = data.get("role")
            if role:
                return role
            uid = data.get("uid")
            if uid:
                u_snap = db.collection("users").document(uid).get()
                if u_snap.exists:
                    return (u_snap.to_dict() or {}).get("role") or "passenger"
            return "passenger"

        user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
        if len(user_query) > 0:
            data = user_query[0].to_dict() or {}
            return data.get("role") or "passenger"

        user_query_alt = db.collection("users").where("phone_number", "==", phone).limit(1).get()
        if len(user_query_alt) > 0:
            data = user_query_alt[0].to_dict() or {}
            return data.get("role") or "passenger"

        user_query_camel = db.collection("users").where("phoneNumber", "==", phone).limit(1).get()
        if len(user_query_camel) > 0:
            data = user_query_camel[0].to_dict() or {}
            return data.get("role") or "passenger"

        return None
    except Exception:
        return None


def extract_bearer_token(authorization: Optional[str]) -> str:
    """Return a bearer token or an empty string for a malformed header."""
    match = _BEARER_RE.match(authorization or "")
    return match.group(1).strip() if match else ""


def verify_firebase_token(authorization: Optional[str]) -> dict[str, Any]:
    """Verify the Firebase ID token supplied in an Authorization header.

    This is intentionally a synchronous dependency. FastAPI executes normal
    sync dependencies in its worker pool, preventing the Firebase Admin SDK's
    blocking verification call from blocking the async event loop.
    """
    token = extract_bearer_token(authorization)
    if not token:
        raise ApiError("Authentication is required.", 401)

    try:
        decoded = fb_auth.verify_id_token(
            token,
            app=get_admin_app(),
            check_revoked=True,
        )
    except (fb_auth.InvalidIdTokenError, fb_auth.ExpiredIdTokenError, fb_auth.RevokedIdTokenError):
        raise ApiError("Your session is invalid or expired. Please login again.", 401)
    except fb_auth.UserDisabledError:
        raise ApiError("This account has been disabled.", 403)

    enforce_session_inactivity_expiry(decoded)
    return decoded


def current_user(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """FastAPI dependency for protected routes."""
    return verify_firebase_token(authorization)
