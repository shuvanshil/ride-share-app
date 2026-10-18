"""Telegram notification helper for internal operational alerts."""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

import httpx
from firebase_admin import firestore as fb_firestore

from .config import get_env

logger = logging.getLogger(__name__)

APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")
KOLKATA_TZ = ZoneInfo("Asia/Kolkata")
CLAIM_LOCK_TIMEOUT_SECONDS = 60


def is_sensitive_time_window(dt: datetime, tz: ZoneInfo = KOLKATA_TZ) -> bool:
    """
    Evaluates whether a datetime falls within the Sensitive Ride window
    of 8:00 PM (20:00:00) to 5:00 AM (04:59:59) in Asia/Kolkata timezone.
    - 20:00:00 - 23:59:59 -> True (hour >= 20)
    - 00:00:00 - 04:59:59 -> True (hour < 5)
    - 05:00:00 - 19:59:59 -> False
    """
    if dt.tzinfo is None:
        local_dt = dt.replace(tzinfo=timezone.utc).astimezone(tz)
    else:
        local_dt = dt.astimezone(tz)
    hour = local_dt.hour
    return hour >= 20 or hour < 5


def get_telegram_config() -> tuple[Optional[str], Optional[str]]:
    """Retrieve Telegram Bot credentials from environment variables securely."""
    token = get_env("TELEGRAM_BOT_TOKEN")
    chat_id = get_env("TELEGRAM_CHAT_ID")
    return (token.strip() if token else None, chat_id.strip() if chat_id else None)


def build_live_ride_url(ride_id: str) -> str:
    """Build the canonical live tracking URL for a ride."""
    clean_id = str(ride_id or "").strip()
    return f"{APP_BASE_URL}/track?ride={clean_id}"


def format_sensitive_ride_message(
    passenger_name: str,
    driver_name: str,
    passenger_phone: str,
    driver_phone: str,
    live_ride_url: str,
) -> str:
    """Construct the exact standardized Sensitive Ride notification text."""
    p_name = str(passenger_name or "Passenger").strip()
    d_name = str(driver_name or "Driver").strip()
    p_phone = str(passenger_phone or "N/A").strip()
    d_phone = str(driver_phone or "N/A").strip()
    url = str(live_ride_url or "").strip()

    return (
        "Alert Type: Sensitive Ride\n\n"
        f"Passenger name: {p_name}\n"
        f"Driver name: {d_name}\n"
        f"Passenger Mobile number: {p_phone}\n"
        f"Driver's Mobile number: {d_phone}\n"
        f"URL for live ride details: {url}"
    )


def send_telegram_alert(
    text: str,
    bot_token: Optional[str] = None,
    chat_id: Optional[str] = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """
    Send a message to the configured Telegram chat via Telegram Bot API.
    Never logs or exposes the bot token in logs or error messages.
    """
    token = bot_token or get_env("TELEGRAM_BOT_TOKEN")
    target_chat = chat_id or get_env("TELEGRAM_CHAT_ID")

    if not token or not target_chat:
        return {"ok": False, "error": "Telegram credentials not configured."}

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": str(target_chat).strip(),
        "text": text,
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, json=payload)
            if response.status_code == 200:
                data = response.json()
                if data.get("ok"):
                    return {"ok": True, "result": data.get("result", {})}
                return {"ok": False, "error": f"Telegram API returned not ok: {data.get('description', 'Unknown error')}"}
            return {"ok": False, "status_code": response.status_code, "error": "Telegram API request failed."}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Telegram alert delivery failed: %s", type(exc).__name__)
        return {"ok": False, "error": f"Network or client error: {type(exc).__name__}"}


def claim_and_send_sensitive_ride_alert(
    db: Any,
    ride_id: str,
    bot_token: Optional[str] = None,
    chat_id: Optional[str] = None,
    worker_id: Optional[str] = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """
    Atomically claims a sensitive ride and delivers Telegram notification with strict idempotency.
    Returns status dict indicating whether the alert was sent or skipped.
    """
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not clean_ride_id:
        return {"ok": False, "error": "Missing ride ID"}

    token = bot_token or get_env("TELEGRAM_BOT_TOKEN")
    target_chat = chat_id or get_env("TELEGRAM_CHAT_ID")
    if not token or not target_chat:
        return {"ok": False, "error": "Telegram credentials not configured."}

    claim_id = worker_id or secrets.token_hex(8)
    ride_ref = db.collection("rides").document(clean_ride_id)
    transaction = db.transaction()

    claim_result: dict[str, Any] = {}

    @fb_firestore.transactional
    def claim_transaction(tx):
        snapshot = ride_ref.get(transaction=tx)
        if not snapshot.exists:
            return {"claimed": False, "reason": "not_found"}

        ride = snapshot.to_dict() or {}
        if not ride.get("sensitiveRide"):
            return {"claimed": False, "reason": "not_sensitive"}

        if ride.get("sensitiveRideNotificationSent") is True:
            return {"claimed": False, "reason": "already_sent"}

        claimed_at = ride.get("sensitiveRideNotificationClaimedAt")
        if claimed_at:
            c_time = None
            if isinstance(claimed_at, datetime):
                c_time = claimed_at if claimed_at.tzinfo else claimed_at.replace(tzinfo=timezone.utc)
            elif hasattr(claimed_at, "timestamp"):
                c_time = datetime.fromtimestamp(claimed_at.timestamp(), tz=timezone.utc)

            if c_time:
                age_seconds = (datetime.now(timezone.utc) - c_time).total_seconds()
                if age_seconds < CLAIM_LOCK_TIMEOUT_SECONDS:
                    return {"claimed": False, "reason": "currently_locked"}

        tx.update(ride_ref, {
            "sensitiveRideNotificationClaimedAt": fb_firestore.SERVER_TIMESTAMP,
            "sensitiveRideNotificationClaimId": claim_id,
        })
        return {"claimed": True, "ride": ride}

    try:
        claim_result = claim_transaction(transaction)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to claim sensitive ride %s: %s", clean_ride_id, exc)
        return {"ok": False, "error": f"Claim transaction failed: {exc}"}

    if not claim_result.get("claimed"):
        return {"ok": True, "sent": False, "skipped": claim_result.get("reason", "not_claimed")}

    ride_data = claim_result.get("ride") or {}
    message_text = format_sensitive_ride_message(
        passenger_name=ride_data.get("passenger_name") or "",
        driver_name=ride_data.get("driver_name") or "",
        passenger_phone=ride_data.get("passenger_phone") or "",
        driver_phone=ride_data.get("driver_phone") or "",
        live_ride_url=build_live_ride_url(clean_ride_id),
    )

    telegram_res = send_telegram_alert(
        text=message_text,
        bot_token=token,
        chat_id=target_chat,
        timeout=timeout,
    )

    if telegram_res.get("ok"):
        result_payload = telegram_res.get("result") or {}
        msg_id = result_payload.get("message_id")
        try:
            ride_ref.update({
                "sensitiveRideNotificationSent": True,
                "sensitiveRideNotificationSentAt": fb_firestore.SERVER_TIMESTAMP,
                "sensitiveRideTelegramMessageId": msg_id,
                "sensitiveRideNotificationClaimId": None,
            })
            return {"ok": True, "sent": True, "rideId": clean_ride_id, "messageId": msg_id}
        except Exception as exc:  # noqa: BLE001
            logger.error("Telegram sent but failed to update Firestore for ride %s: %s", clean_ride_id, exc)
            return {"ok": True, "sent": True, "rideId": clean_ride_id, "warning": "Firestore mark_sent update failed"}
    else:
        # Release claim on failure so subsequent worker runs can retry immediately
        try:
            ride_ref.update({
                "sensitiveRideNotificationClaimedAt": None,
                "sensitiveRideNotificationClaimId": None,
            })
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "sent": False, "error": telegram_res.get("error", "Telegram delivery failed")}
