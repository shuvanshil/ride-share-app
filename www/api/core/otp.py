"""
OTP session-token signing/verification + 2Factor.in client helpers.
Direct port of `www/api/_otp.js`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json as json_lib
import re
import time
from typing import Any, Optional

import httpx

from .config import get_env, require_env
from .errors import ApiError

TWOFACTOR_BASE_URL = "https://2factor.in/API/V1"
OTP_TEMPLATE_NAME = get_env("TWOFACTOR_OTP_TEMPLATE", "OTP1")
TOKEN_TTL_MS = 10 * 60 * 1000  # 10 minutes, matches the original TOKEN_TTL_MS

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

_PHONE_RE = re.compile(r"^[6-9]\d{9}$")
_NON_DIGIT_RE = re.compile(r"\D")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def normalize_phone(value: Any) -> str:
    raw_phone = _NON_DIGIT_RE.sub("", str(value or "").strip())
    national_phone = (
        raw_phone[2:] if raw_phone.startswith("91") and len(raw_phone) == 12 else raw_phone
    )
    if not _PHONE_RE.match(national_phone):
        return ""
    return f"+91{national_phone}"


def normalize_purpose(value: Any) -> str:
    return "reset" if value == "reset" else "register"


def two_factor_phone(phone_number: str) -> str:
    return phone_number


def sign_token(payload: dict[str, Any]) -> str:
    secret = require_env("OTP_SESSION_SECRET")
    body = _b64url_encode(json_lib.dumps(payload).encode("utf-8"))
    signature = _b64url_encode(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{body}.{signature}"


def build_verification_token(phone: str, purpose: str) -> str:
    now = _now_ms()
    return sign_token(
        {
            "phone": phone,
            "purpose": purpose,
            "verifiedAt": now,
            "expiresAt": now + TOKEN_TTL_MS,
        }
    )


def verify_token(token: Optional[str], expected_purpose: str = "") -> dict[str, Any]:
    secret = require_env("OTP_SESSION_SECRET")
    parts = str(token or "").split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ApiError("Invalid verification token.", 400)

    body, signature = parts
    expected_signature = _b64url_encode(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )

    if not hmac.compare_digest(signature, expected_signature):
        raise ApiError("Invalid verification token.", 400)

    try:
        payload = json_lib.loads(_b64url_decode(body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError("Invalid verification token.", 400)

    if not payload.get("phone") or not payload.get("purpose") or not payload.get("expiresAt"):
        raise ApiError("Invalid verification token.", 400)

    if expected_purpose and payload["purpose"] != expected_purpose:
        raise ApiError("This verification token cannot be used here.", 400)

    if _now_ms() > int(payload["expiresAt"]):
        raise ApiError("This verification has expired. Please request a new OTP.", 400)

    return payload


async def fetch_two_factor_json(url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(url, headers={"Accept": "application/json"})

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.is_error:
        message = data.get("Details") or data.get("Status") or f"2Factor HTTP {response.status_code}"
        raise ApiError(message, response.status_code, {"upstreamData": data})

    return data
