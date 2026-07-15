"""
OTP endpoints. Direct port of send-otp.js and verify-otp.js.
"""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter
from pydantic import BaseModel

from ..core.config import get_env, require_env
from ..core.errors import ApiError
from ..core.otp import (
    OTP_TEMPLATE_NAME,
    TWOFACTOR_BASE_URL,
    build_verification_token,
    fetch_two_factor_json,
    normalize_phone,
    normalize_purpose,
    two_factor_phone,
)

router = APIRouter()


class SendOtpBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None


class VerifyOtpBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None
    otp: Optional[str] = None
    otpSessionId: Optional[str] = None


@router.post("/send-otp")
async def send_otp(body: SendOtpBody) -> dict[str, Any]:
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)

    if not phone:
        raise ApiError("Enter a valid 10-digit Indian mobile number.", 400)

    try:
        api_key = require_env("TWOFACTOR_API_KEY")
        template_name = (get_env("TWOFACTOR_OTP_TEMPLATE", OTP_TEMPLATE_NAME) or "").strip()

        parts = [
            TWOFACTOR_BASE_URL,
            quote(api_key, safe=""),
            "SMS",
            quote(two_factor_phone(phone), safe=""),
            "AUTOGEN",
        ]
        if template_name:
            parts.append(quote(template_name, safe=""))

        data = await fetch_two_factor_json("/".join(parts))

        if data.get("Status") != "Success" or not data.get("Details"):
            raise ApiError(
                "Could not send OTP.",
                502,
                {"providerStatus": data.get("Status") or "", "providerDetails": data.get("Details") or ""},
            )

        return {
            "ok": True,
            "phone": phone,
            "purpose": purpose,
            "otpSessionId": data.get("Details"),
            "provider": "2factor",
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not send OTP. Please try again.", 500, {"message": str(error)})


@router.post("/verify-otp")
async def verify_otp(body: VerifyOtpBody) -> dict[str, Any]:
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)
    otp = (body.otp or "").strip()
    otp_session_id = (body.otpSessionId or "").strip()

    if not phone:
        raise ApiError("Enter a valid 10-digit Indian mobile number.", 400)
    import re

    if not re.match(r"^\d{4,8}$", otp):
        raise ApiError("Enter the OTP sent to your phone.", 400)
    if not otp_session_id:
        raise ApiError("OTP session is missing. Request a new OTP.", 400)

    try:
        api_key = require_env("TWOFACTOR_API_KEY")
        verify_url = "/".join(
            [
                TWOFACTOR_BASE_URL,
                quote(api_key, safe=""),
                "SMS",
                "VERIFY",
                quote(otp_session_id, safe=""),
                quote(otp, safe=""),
            ]
        )

        data = await fetch_two_factor_json(verify_url)

        status = str(data.get("Status") or "").lower()
        details = str(data.get("Details") or "").lower()
        matched = details == "otp matched" or (status == "success" and "matched" in details)

        if not matched:
            raise ApiError(
                "That OTP is incorrect or expired.",
                400,
                {"providerStatus": data.get("Status") or "", "providerDetails": data.get("Details") or ""},
            )

        return {
            "ok": True,
            "phone": phone,
            "purpose": purpose,
            "verificationToken": build_verification_token(phone, purpose),
        }
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not verify OTP. Please try again.", 500, {"message": str(error)})
