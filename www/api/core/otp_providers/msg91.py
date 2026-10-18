"""
MSG91 OTP provider implementation.
Handles server-side Access Token verification and phone identifier normalization for MSG91.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..config import require_env
from ..errors import ApiError

MSG91_VERIFY_ACCESS_TOKEN_URL = "https://control.msg91.com/api/v5/widget/verifyAccessToken"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
logger = logging.getLogger(__name__)

_NON_DIGIT_RE = re.compile(r"\D")
_PHONE_RE = re.compile(r"^[6-9]\d{9}$")


def to_msg91_identifier(phone: str) -> str:
    """
    Convert canonical LiphtUP phone (+91XXXXXXXXXX) to MSG91 format (91XXXXXXXXXX without +).
    """
    raw_digits = _NON_DIGIT_RE.sub("", str(phone or "").strip())
    if raw_digits.startswith("91") and len(raw_digits) == 12:
        return raw_digits
    if _PHONE_RE.match(raw_digits):
        return f"91{raw_digits}"
    return raw_digits


def _extract_msg91_phone(data: Any) -> str:
    """
    Extract and normalize verified phone number from MSG91 verifyAccessToken response payload.
    Supports various MSG91 response schemas:
    - {"type": "success", "message": "919876543210"}
    - {"status": "success", "message": "...", "data": {"mobile": "919876543210"}}
    - {"status": "success", "mobile": "919876543210"}
    - {"data": {"number": "919876543210"}}
    """
    candidates = []
    if isinstance(data, dict):
        # 1. Direct fields
        for key in ("mobile", "number", "phone", "identifier", "message"):
            val = data.get(key)
            if isinstance(val, (str, int)):
                candidates.append(str(val))

        # 2. Nested data dict
        inner_data = data.get("data")
        if isinstance(inner_data, dict):
            for key in ("mobile", "number", "phone", "identifier", "message"):
                val = inner_data.get(key)
                if isinstance(val, (str, int)):
                    candidates.append(str(val))
        elif isinstance(inner_data, (str, int)):
            candidates.append(str(inner_data))

    for candidate in candidates:
        raw_digits = _NON_DIGIT_RE.sub("", candidate)
        national_digits = (
            raw_digits[2:] if raw_digits.startswith("91") and len(raw_digits) == 12 else raw_digits
        )
        if _PHONE_RE.match(national_digits):
            return f"+91{national_digits}"

    return ""


async def verify_msg91_access_token(access_token: str) -> dict[str, Any]:
    """
    Validate an MSG91 Widget Access Token (JWT) with MSG91's server API.
    Returns verified payload including canonical verified phone number.
    """
    token_str = str(access_token or "").strip()
    if not token_str:
        raise ApiError("MSG91 access token is missing.", 400)

    auth_key = require_env("MSG91_AUTH_KEY")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    body = {
        "authkey": auth_key,
        "access-token": token_str,
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                MSG91_VERIFY_ACCESS_TOKEN_URL,
                headers=headers,
                json=body,
            )
    except Exception as exc:
        logger.error("MSG91 verifyAccessToken network error: %s", exc)
        raise ApiError("Could not connect to MSG91 verification service.", 502)

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.is_error:
        logger.warning(
            "MSG91 verifyAccessToken HTTP error status=%s response=%s",
            response.status_code,
            data,
        )
        raise ApiError("MSG91 verification token is invalid or expired.", 400)

    # Check status/type in JSON
    response_type = str(data.get("type") or data.get("status") or "").lower()
    if response_type in ("error", "failed", "failure"):
        msg = str(data.get("message") or "Invalid verification token.")
        logger.warning("MSG91 verifyAccessToken returned error: %s", msg)
        raise ApiError("That OTP is incorrect or the verification session expired.", 400)

    verified_phone = _extract_msg91_phone(data)
    if not verified_phone:
        logger.error(
            "Could not extract verified phone identifier from MSG91 response: %s",
            data,
        )
        raise ApiError("Verified phone identity could not be confirmed.", 400)

    return {
        "ok": True,
        "verifiedPhone": verified_phone,
        "raw": data,
    }
