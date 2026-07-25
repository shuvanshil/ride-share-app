"""Authentication helpers for the FastAPI boundary.

Firebase Authentication remains the identity provider during the migration.
The browser sends its Firebase ID token to FastAPI, and FastAPI verifies that
token before any protected operation is allowed to continue.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from firebase_admin import auth as fb_auth
from fastapi import Header

from .errors import ApiError
from .firebase import get_admin_app

_BEARER_RE = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)


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
        return fb_auth.verify_id_token(
            token,
            app=get_admin_app(),
            check_revoked=True,
        )
    except (fb_auth.InvalidIdTokenError, fb_auth.ExpiredIdTokenError, fb_auth.RevokedIdTokenError):
        raise ApiError("Your session is invalid or expired. Please login again.", 401)
    except fb_auth.UserDisabledError:
        raise ApiError("This account has been disabled.", 403)


def current_user(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """FastAPI dependency for protected routes."""
    return verify_firebase_token(authorization)
