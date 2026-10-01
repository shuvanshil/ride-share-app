"""
OTP session-token signing/verification and core security service.
Maintains application-level security, rate-limiting, and the provider-switch abstraction.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json as json_lib
import re
import time
from typing import Any, Literal, Optional

import httpx

from .config import get_env, require_env
from .errors import ApiError
from .firebase import get_firestore
from .otp_providers.existing import (
    TWOFACTOR_BASE_URL,
    TWOFACTOR_DEFAULT_TEMPLATE,
    fetch_two_factor_json,
    send_two_factor_otp,
    verify_two_factor_otp,
)
from .otp_providers.msg91 import (
    to_msg91_identifier,
    verify_msg91_access_token,
)

# -----------------------------------------------------------------------------
# SINGLE SOURCE-CODE PROVIDER SWITCH
# Supported values: "existing" | "msg91"
# -----------------------------------------------------------------------------
OTP_PROVIDER: Literal["existing", "msg91"] = "existing"

OTP_TEMPLATE_NAME = get_env("TWOFACTOR_OTP_TEMPLATE", TWOFACTOR_DEFAULT_TEMPLATE)
TOKEN_TTL_MS = 10 * 60 * 1000  # 10 minutes
OTP_SEND_COOLDOWN_SECONDS = 60
OTP_SEND_WINDOW_SECONDS = 60 * 60
OTP_MAX_SENDS_PER_WINDOW = 5
OTP_MAX_VERIFY_ATTEMPTS = 5
OTP_SECURITY_COLLECTION = "otpSecurity"

_PHONE_RE = re.compile(r"^[6-9]\d{9}$")
_NON_DIGIT_RE = re.compile(r"\D")


def get_active_otp_provider_name() -> str:
    """Return the canonical provider name for user profile metadata ('2factor' or 'msg91')."""
    return "2factor" if OTP_PROVIDER == "existing" else "msg91"


def validate_active_provider_config() -> None:
    """Validate environment configuration required strictly for the active OTP provider."""
    require_env("OTP_SESSION_SECRET")
    if OTP_PROVIDER == "existing":
        require_env("TWOFACTOR_API_KEY")
    elif OTP_PROVIDER == "msg91":
        require_env("MSG91_WIDGET_ID")
        require_env("MSG91_WIDGET_TOKEN")
        require_env("MSG91_AUTH_KEY")


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


def _otp_security_ref(phone: str, purpose: str):
    # Phone numbers are normalized and hashed so sensitive mobile numbers
    # do not become raw document IDs in the security collection.
    key = hashlib.sha256(f"{purpose}:{phone}".encode("utf-8")).hexdigest()
    return get_firestore().collection(OTP_SECURITY_COLLECTION).document(key)


def reserve_otp_send(
    phone: str,
    purpose: str,
    now: Optional[float] = None,
    is_retry: bool = False,
) -> None:
    """
    Reserve an OTP send slot using a Firestore transaction.
    Enforces the 60s cooldown and the 5-send hourly rolling window for both providers.
    """
    current_time = now if now is not None else time.time()
    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def reserve(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}

        # 1. Cooldown Check (60 seconds)
        last_sent = float(state.get("lastSentAt", 0) or 0)
        if last_sent and current_time - last_sent < OTP_SEND_COOLDOWN_SECONDS:
            raise ApiError("Please wait before requesting another OTP.", 429)

        # 2. Hourly Send Window Check (5 sends / hour)
        sends = [
            float(value)
            for value in state.get("sendTimestamps", [])
            if current_time - float(value) < OTP_SEND_WINDOW_SECONDS
        ]
        if len(sends) >= OTP_MAX_SENDS_PER_WINDOW:
            raise ApiError("Too many OTP requests. Please try again later.", 429)

        sends.append(current_time)
        update_payload: dict[str, Any] = {
            "sendTimestamps": sends,
            "lastSentAt": current_time,
            "purpose": purpose,
            "phone": phone,
            "provider": OTP_PROVIDER,
            "verifyAttempts": 0,
            "verifiedAt": None,
            "tokenIssued": False,
            "isLocked": False,
        }
        if not is_retry:
            update_payload["activeSessionId"] = None

        tx.set(reference, update_payload, merge=True)

    reserve(transaction)


def bind_otp_session(phone: str, purpose: str, session_id: str) -> None:
    """
    Bind a runtime provider request ID (e.g., MSG91 reqId) to an already-authorized OTP session.
    Prevents client from injecting a reqId into an invalid, locked, or unreserved session.
    """
    cleaned_session_id = str(session_id or "").strip()
    if not cleaned_session_id:
        raise ApiError("Invalid OTP session identifier.", 400)

    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def bind(tx):
        snapshot = reference.get(transaction=tx)
        if not snapshot.exists:
            raise ApiError("No active OTP request found for this mobile number.", 400)
        state = snapshot.to_dict() or {}
        if state.get("isLocked"):
            raise ApiError("This OTP session has been locked. Please request a new OTP.", 429)
        if state.get("verifiedAt"):
            raise ApiError("This OTP has already been verified.", 400)

        tx.set(
            reference,
            {
                "activeSessionId": cleaned_session_id,
                "verifyAttempts": 0,
                "verifiedAt": None,
                "tokenIssued": False,
                "boundAt": time.time(),
            },
            merge=True,
        )

    bind(transaction)


def record_otp_session(phone: str, purpose: str, session_id: str) -> None:
    """Record the active session ID for an OTP request (used by existing 2Factor path)."""
    _otp_security_ref(phone, purpose).set(
        {
            "activeSessionId": session_id,
            "verifyAttempts": 0,
            "verifiedAt": None,
            "tokenIssued": False,
            "isLocked": False,
        },
        merge=True,
    )


def record_failed_otp_attempt(phone: str, purpose: str, session_id: str) -> None:
    """
    Increment failed verify attempts and lock session if maximum attempts exceeded.
    Validates that the session_id strictly belongs to the phone/purpose session.
    """
    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def record(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}
        active_id = str(state.get("activeSessionId") or "").strip()

        if not active_id or active_id != str(session_id or "").strip():
            raise ApiError("OTP session is invalid or expired. Request a new OTP.", 400)

        if state.get("verifiedAt"):
            return  # Already verified, ignore spurious failed callbacks

        attempts = int(state.get("verifyAttempts", 0) or 0) + 1
        is_locked = attempts >= OTP_MAX_VERIFY_ATTEMPTS
        tx.set(reference, {"verifyAttempts": attempts, "isLocked": is_locked}, merge=True)

        if is_locked:
            raise ApiError("Too many failed attempts. This OTP session has expired. Please request a new OTP.", 429)

    record(transaction)


def mark_otp_verified(phone: str, purpose: str, session_id: str) -> None:
    """
    Mark an OTP session as verified in Firestore and enforce one-time token issuance.
    Protects against token replay and reminting attacks.
    """
    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def mark(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}
        active_id = str(state.get("activeSessionId") or "").strip()

        if not active_id or active_id != str(session_id or "").strip():
            raise ApiError("OTP session is invalid or expired. Request a new OTP.", 400)
        if state.get("isLocked") or int(state.get("verifyAttempts", 0) or 0) >= OTP_MAX_VERIFY_ATTEMPTS:
            raise ApiError("This OTP session has been locked due to too many attempts. Request a new OTP.", 429)
        if state.get("tokenIssued"):
            raise ApiError("This OTP verification has already been consumed.", 400)

        tx.set(
            reference,
            {
                "verifiedAt": time.time(),
                "tokenIssued": True,
            },
            merge=True,
        )

    mark(transaction)


def firestore_transactional():
    from firebase_admin import firestore

    return firestore.transactional


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
