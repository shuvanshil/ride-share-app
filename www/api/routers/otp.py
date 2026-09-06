"""
OTP endpoints with unified LiphtUP security and dual provider support.
Handles config discovery, send authorization, session binding, failure tracking, and verification.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..core.config import get_env, require_env
from ..core.errors import ApiError
from ..core.otp import (
    OTP_PROVIDER,
    OTP_TEMPLATE_NAME,
    bind_otp_session,
    build_verification_token,
    fetch_two_factor_json,
    get_active_otp_provider_name,
    mark_otp_verified,
    normalize_phone,
    normalize_purpose,
    record_failed_otp_attempt,
    record_otp_session,
    reserve_otp_send,
    send_two_factor_otp,
    to_msg91_identifier,
    validate_active_provider_config,
    verify_msg91_access_token,
    verify_two_factor_otp,
)
from ..core.rate_limit import enforce_rate_limit

router = APIRouter()


class SendOtpBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None
    isRetry: Optional[bool] = False
    retryChannel: Optional[str] = None


class BindSessionBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None
    reqId: Optional[str] = None


class ReportFailureBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None
    reqId: Optional[str] = None


class VerifyOtpBody(BaseModel):
    phone: Optional[str] = None
    purpose: Optional[str] = None
    otp: Optional[str] = None
    otpSessionId: Optional[str] = None
    accessToken: Optional[str] = None


@router.get("/otp-config")
@router.get("/otp/config")
async def otp_config() -> dict[str, Any]:
    """
    Return the active OTP provider and client-safe Web SDK configuration.
    Never exposes server secrets like MSG91_AUTH_KEY, OTP_SESSION_SECRET, or TWOFACTOR_API_KEY.
    """
    if OTP_PROVIDER == "msg91":
        widget_id = require_env("MSG91_WIDGET_ID")
        widget_token = require_env("MSG91_WIDGET_TOKEN")
        return {
            "ok": True,
            "provider": "msg91",
            "widgetId": widget_id,
            "tokenAuth": widget_token,
        }

    return {
        "ok": True,
        "provider": "existing",
    }


@router.post("/send-otp")
async def send_otp(request: Request, body: SendOtpBody) -> dict[str, Any]:
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)
    is_retry = bool(body.isRetry)

    if not phone:
        raise ApiError("Enter a valid 10-digit Indian mobile number.", 400)

    enforce_rate_limit(request, "otp-send", 10, 60 * 60, subject=purpose)

    try:
        # Enforce server-side 60s cooldown and 5/hr window limit in Firestore transaction
        reserve_otp_send(phone, purpose, is_retry=is_retry)

        if OTP_PROVIDER == "existing":
            api_key = require_env("TWOFACTOR_API_KEY")
            template_name = (get_env("TWOFACTOR_OTP_TEMPLATE", OTP_TEMPLATE_NAME) or "").strip()
            # Support both direct fetch_two_factor_json monkeypatches in legacy tests and send_two_factor_otp
            from urllib.parse import quote
            from ..core.otp_providers.existing import TWOFACTOR_BASE_URL
            parts = [
                TWOFACTOR_BASE_URL,
                quote(api_key, safe=""),
                "SMS",
                quote(phone, safe=""),
                "AUTOGEN",
            ]
            if template_name:
                parts.append(quote(template_name, safe=""))

            data = await fetch_two_factor_json("/".join(parts))
            if data.get("Status") != "Success" or not data.get("Details"):
                raise ApiError("Could not send OTP.", 502)

            session_id = str(data.get("Details"))
            record_otp_session(phone, purpose, session_id)
            return {
                "ok": True,
                "phone": phone,
                "purpose": purpose,
                "otpSessionId": session_id,
                "provider": "2factor",
            }

        # MSG91 path: Server authorized send/retry; client will invoke MSG91 SDK
        return {
            "ok": True,
            "phone": phone,
            "purpose": purpose,
            "permitted": True,
            "provider": "msg91",
            "identifier": to_msg91_identifier(phone),
        }
    except ApiError:
        raise
    except Exception:  # noqa: BLE001
        raise ApiError("Could not send OTP. Please try again.", 500)


@router.post("/otp/session")
async def bind_session(body: BindSessionBody) -> dict[str, Any]:
    """
    Bind the runtime MSG91 reqId to the authorized LiphtUP session record in Firestore.
    """
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)
    req_id = (body.reqId or "").strip()

    if not phone:
        raise ApiError("Enter a valid 10-digit Indian mobile number.", 400)
    if not req_id:
        raise ApiError("Missing OTP session identifier.", 400)

    bind_otp_session(phone, purpose, req_id)
    return {"ok": True, "phone": phone, "purpose": purpose, "otpSessionId": req_id}


@router.post("/otp/report-failure")
async def report_failure(body: ReportFailureBody) -> dict[str, Any]:
    """
    Record a failed OTP verification attempt from client callbacks.
    Safely increments verifyAttempts and locks the session if 5 attempts exceeded.
    """
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)
    req_id = (body.reqId or "").strip()

    if not phone or not req_id:
        return {"ok": False}

    try:
        record_failed_otp_attempt(phone, purpose, req_id)
    except ApiError as exc:
        if exc.status_code == 429:
            raise
    except Exception:  # noqa: BLE001
        pass

    return {"ok": True}


@router.post("/verify-otp")
async def verify_otp(request: Request, body: VerifyOtpBody) -> dict[str, Any]:
    phone = normalize_phone(body.phone)
    purpose = normalize_purpose(body.purpose)
    otp = (body.otp or "").strip()
    otp_session_id = (body.otpSessionId or "").strip()
    access_token = (body.accessToken or "").strip()

    if not phone:
        raise ApiError("Enter a valid 10-digit Indian mobile number.", 400)

    enforce_rate_limit(request, "otp-verify", 30, 60 * 60, subject=purpose)

    try:
        if OTP_PROVIDER == "existing":
            if not re.match(r"^\d{4,8}$", otp):
                raise ApiError("Enter the OTP sent to your phone.", 400)
            if not otp_session_id:
                raise ApiError("OTP session is missing. Request a new OTP.", 400)

            matched = await verify_two_factor_otp(otp_session_id, otp)
            if not matched:
                record_failed_otp_attempt(phone, purpose, otp_session_id)
                raise ApiError("That OTP is incorrect or expired.", 400)

            mark_otp_verified(phone, purpose, otp_session_id)
            return {
                "ok": True,
                "phone": phone,
                "purpose": purpose,
                "provider": "2factor",
                "verificationToken": build_verification_token(phone, purpose),
            }

        # MSG91 Provider Path
        if not access_token:
            raise ApiError("Verification token is missing. Please verify OTP again.", 400)
        if not otp_session_id:
            raise ApiError("OTP session is missing. Request a new OTP.", 400)

        # 1. Server-side validation of MSG91 access token
        msg91_result = await verify_msg91_access_token(access_token)
        verified_phone = msg91_result.get("verifiedPhone", "")

        # 2. Strict Identity Matching against LiphtUP session phone
        if verified_phone != phone:
            raise ApiError("Verified phone identity does not match the requested mobile number.", 400)

        # 3. Mark session verified and enforce one-time token issuance / attempt limits
        mark_otp_verified(phone, purpose, otp_session_id)

        return {
            "ok": True,
            "phone": phone,
            "purpose": purpose,
            "provider": "msg91",
            "verificationToken": build_verification_token(phone, purpose),
        }
    except ApiError:
        raise
    except Exception:  # noqa: BLE001
        raise ApiError("Could not verify OTP. Please try again.", 500)
