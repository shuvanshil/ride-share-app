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
from .firebase import get_firestore

TWOFACTOR_BASE_URL = "https://2factor.in/API/V1"
OTP_TEMPLATE_NAME = get_env("TWOFACTOR_OTP_TEMPLATE", "OTP1")
TOKEN_TTL_MS = 10 * 60 * 1000  # 10 minutes, matches the original TOKEN_TTL_MS
OTP_SEND_COOLDOWN_SECONDS = 60
OTP_SEND_WINDOW_SECONDS = 60 * 60
OTP_MAX_SENDS_PER_WINDOW = 5
OTP_MAX_VERIFY_ATTEMPTS = 5
OTP_SECURITY_COLLECTION = "otpSecurity"

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


def _otp_security_ref(phone: str, purpose: str):
    # Phone numbers are already normalized, but must not become readable
    # document IDs in a collection that may later be inspected by operators.
    key = hashlib.sha256(f"{purpose}:{phone}".encode("utf-8")).hexdigest()
    return get_firestore().collection(OTP_SECURITY_COLLECTION).document(key)


def reserve_otp_send(phone: str, purpose: str, now: Optional[float] = None) -> None:
    """Reserve an OTP send slot using a Firestore transaction."""
    current_time = now if now is not None else time.time()
    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def reserve(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}
        sends = [float(value) for value in state.get("sendTimestamps", []) if current_time - float(value) < OTP_SEND_WINDOW_SECONDS]
        last_sent = float(state.get("lastSentAt", 0) or 0)
        if last_sent and current_time - last_sent < OTP_SEND_COOLDOWN_SECONDS:
            raise ApiError("Please wait before requesting another OTP.", 429)
        if len(sends) >= OTP_MAX_SENDS_PER_WINDOW:
            raise ApiError("Too many OTP requests. Please try again later.", 429)
        sends.append(current_time)
        tx.set(reference, {"sendTimestamps": sends, "lastSentAt": current_time, "purpose": purpose}, merge=True)

    reserve(transaction)


def record_otp_session(phone: str, purpose: str, session_id: str) -> None:
    _otp_security_ref(phone, purpose).set(
        {"activeSessionId": session_id, "verifyAttempts": 0, "verifiedAt": None},
        merge=True,
    )


def record_failed_otp_attempt(phone: str, purpose: str, session_id: str) -> None:
    reference = _otp_security_ref(phone, purpose)
    db = get_firestore()
    transaction = db.transaction()

    @firestore_transactional()
    def record(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}
        if state.get("activeSessionId") != session_id:
            raise ApiError("OTP session is invalid or expired. Request a new OTP.", 400)
        attempts = int(state.get("verifyAttempts", 0) or 0) + 1
        tx.set(reference, {"verifyAttempts": attempts}, merge=True)
        if attempts >= OTP_MAX_VERIFY_ATTEMPTS:
            raise ApiError("Too many OTP attempts. Request a new OTP.", 429)

    record(transaction)


def mark_otp_verified(phone: str, purpose: str, session_id: str) -> None:
    reference = _otp_security_ref(phone, purpose)
    snapshot = reference.get()
    state = snapshot.to_dict() or {}
    if state.get("activeSessionId") != session_id:
        raise ApiError("OTP session is invalid or expired. Request a new OTP.", 400)
    reference.set({"verifiedAt": time.time()}, merge=True)


def firestore_transactional():
    # Kept as a small indirection so OTP security helpers remain easy to unit
    # test without importing the Firebase module at test collection time.
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
