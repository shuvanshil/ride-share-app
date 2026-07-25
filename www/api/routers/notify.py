"""
Push-notification endpoint. Direct port of notify-ride-request.js.
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Header
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging
from pydantic import BaseModel

from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

router = APIRouter()

DRIVER_NOTIFICATION_ELIGIBLE_MS = 30 * 60 * 1000
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


class NotifyRideRequestBody(BaseModel):
    rideId: Optional[str] = None
    driverIds: Optional[list[str]] = None


def _clean_id(value: Any) -> str:
    return str(value or "").strip()[:160]


def _timestamp_ms(value: Any) -> int:
    if not value:
        return 0
    if hasattr(value, "timestamp"):
        try:
            return int(value.timestamp() * 1000)
        except Exception:  # noqa: BLE001
            pass
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    return 0


def _is_notification_eligible(driver: dict[str, Any]) -> bool:
    if driver.get("desiredAvailability") == "offline" or driver.get("driverAvailability") == "offline":
        return False

    eligible_until = _timestamp_ms(driver.get("notificationEligibleUntil"))
    if eligible_until:
        return eligible_until >= int(time.time() * 1000)

    last_seen_at = _timestamp_ms(driver.get("lastAppSeenAt") or driver.get("lastSeenAt") or driver.get("updatedAt"))
    return bool(last_seen_at) and (int(time.time() * 1000) - last_seen_at) <= DRIVER_NOTIFICATION_ELIGIBLE_MS


def _collect_tokens(driver: dict[str, Any]) -> list[str]:
    tokens: set[str] = set()
    for token in driver.get("pushTokens") or []:
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())
    for detail in driver.get("pushTokenDetails") or []:
        token = (detail or {}).get("token") if isinstance(detail, dict) else None
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())
    return list(tokens)


def _verify_passenger(authorization: Optional[str], app) -> dict[str, Any]:
    match = re.match(r"^Bearer\s+(.+)$", authorization or "", re.IGNORECASE)
    if not match:
        raise ApiError("Missing passenger authorization.", 401)
    return fb_auth.verify_id_token(match.group(1), app=app)


@router.post("/notify-ride-request")
async def notify_ride_request(body: NotifyRideRequestBody, authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    try:
        app = get_admin_app()
        decoded = _verify_passenger(authorization, app)
        db = fb_firestore.client(app)

        ride_id = _clean_id(body.rideId)
        driver_ids = list(dict.fromkeys(_clean_id(d) for d in (body.driverIds or []) if _clean_id(d)))[:20]

        if not ride_id or not driver_ids:
            raise ApiError("Ride ID and driver IDs are required.", 400)

        ride_snap = db.collection("rides").document(ride_id).get()
        if not ride_snap.exists:
            raise ApiError("Ride request not found.", 404)

        ride = ride_snap.to_dict() or {}
        if ride.get("passenger_id") != decoded.get("uid"):
            raise ApiError("Only the passenger can notify drivers for this ride.", 403)
        if ride.get("status") != "pending" or ride.get("driver_id"):
            raise ApiError("Ride is no longer pending.", 409)

        eligible_set = set(ride.get("eligible_driver_ids") or [])
        allowed_driver_ids = [d for d in driver_ids if d in eligible_set]
        if not allowed_driver_ids:
            return {"ok": True, "sent": 0, "skipped": "no-eligible-drivers"}

        driver_docs = [db.collection("driverPresence").document(d).get() for d in allowed_driver_ids]

        tokens: list[str] = []
        for driver_doc in driver_docs:
            if not driver_doc.exists:
                continue
            driver = driver_doc.to_dict() or {}
            if not _is_notification_eligible(driver):
                continue
            tokens.extend(_collect_tokens(driver))

        unique_tokens = list(dict.fromkeys(tokens))[:500]
        if not unique_tokens:
            return {"ok": True, "sent": 0, "skipped": "no-driver-tokens"}

        pickup = ride.get("pickup_display_address") or ride.get("pickup_name") or "Pickup location"
        drop = ride.get("drop_display_address") or ride.get("drop_name") or ride.get("drop_full_address") or "Destination"
        fare = float(ride.get("fare") or 0)
        body_text = f"{pickup} to {drop}" + (f" - Rs {fare:g}" if fare > 0 else "")

        notification_url = f"{APP_BASE_URL}/driver.html?rideId={ride_id}&from=push"

        message = fb_messaging.MulticastMessage(
            tokens=unique_tokens,
            data={
                "type": "ride_request",
                "rideId": ride_id,
                "title": "New LiphtUp ride request",
                "body": body_text,
                "url": notification_url,
            },
            webpush=fb_messaging.WebpushConfig(
                headers={"Urgency": "high", "TTL": "90"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=notification_url),
                notification=fb_messaging.WebpushNotification(
                    title="New LiphtUp ride request",
                    body=body_text,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    badge=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag=f"liphtup-ride-{ride_id}",
                    renotify=True,
                    require_interaction=True,
                    vibrate=[350, 180, 350, 180, 700],
                    actions=[fb_messaging.WebpushNotificationAction(action="open", title="Open ride")],
                ),
            ),
        )

        response = fb_messaging.send_each_for_multicast(message, app=app)

        return {"ok": True, "sent": response.success_count, "failed": response.failure_count}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not send ride notifications.", 500)
