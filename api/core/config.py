"""
Environment variable access, mirroring the `getEnv` / `requireEnv` helpers
that were duplicated across `_google.js` and `_otp.js`.

All of these must be configured in the Vercel Project -> Settings ->
Environment Variables (same names as before -- nothing to rename):

    FIREBASE_PROJECT_ID
    FIREBASE_CLIENT_EMAIL
    FIREBASE_PRIVATE_KEY
    FIREBASE_WEB_API_KEY        (optional, has a fallback default)
    GOOGLE_MAPS_BROWSER_KEY
    GOOGLE_MAPS_SERVER_KEY
    TWOFACTOR_API_KEY
    TWOFACTOR_OTP_TEMPLATE      (optional, defaults to "OTP1")
    OTP_SESSION_SECRET
    PUBLIC_APP_URL / APP_BASE_URL (optional, defaults to https://liphtup.in)
"""
from __future__ import annotations

import os

from .errors import ApiError


def get_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default) or default


def require_env(name: str) -> str:
    value = get_env(name)
    if not value:
        raise ApiError(f"Missing {name}.", 500)
    return value
