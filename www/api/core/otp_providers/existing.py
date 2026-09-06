"""
Existing 2Factor.in OTP provider implementation.
Handles low-level transport and verification with 2Factor.in API.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..config import get_env, require_env
from ..errors import ApiError

TWOFACTOR_BASE_URL = "https://2factor.in/API/V1"
TWOFACTOR_DEFAULT_TEMPLATE = "OTP1"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def fetch_two_factor_json(url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(url, headers={"Accept": "application/json"})

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.is_error:
        raise ApiError("OTP provider request failed.", 502)

    return data


async def send_two_factor_otp(phone: str, template_name: str = "") -> str:
    """
    Send an OTP via 2Factor.in SMS and return the provider session ID.
    """
    api_key = require_env("TWOFACTOR_API_KEY")
    tpl = (template_name or get_env("TWOFACTOR_OTP_TEMPLATE", TWOFACTOR_DEFAULT_TEMPLATE) or "").strip()

    parts = [
        TWOFACTOR_BASE_URL,
        quote(api_key, safe=""),
        "SMS",
        quote(phone, safe=""),
        "AUTOGEN",
    ]
    if tpl:
        parts.append(quote(tpl, safe=""))

    data = await fetch_two_factor_json("/".join(parts))

    if data.get("Status") != "Success" or not data.get("Details"):
        raise ApiError("Could not send OTP.", 502)

    return str(data.get("Details"))


async def verify_two_factor_otp(session_id: str, otp: str) -> bool:
    """
    Verify an OTP code with 2Factor.in for the given provider session ID.
    Returns True if matched, False if invalid or expired.
    """
    api_key = require_env("TWOFACTOR_API_KEY")
    verify_url = "/".join(
        [
            TWOFACTOR_BASE_URL,
            quote(api_key, safe=""),
            "SMS",
            "VERIFY",
            quote(session_id, safe=""),
            quote(otp, safe=""),
        ]
    )

    data = await fetch_two_factor_json(verify_url)

    status = str(data.get("Status") or "").lower()
    details = str(data.get("Details") or "").lower()
    return details == "otp matched" or (status == "success" and "matched" in details)
