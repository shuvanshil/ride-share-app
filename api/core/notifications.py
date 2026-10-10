"""
Centralized Notification Engine for LiphtUp.
Shared across web and mobile (Capacitor Android) delivery mechanisms.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging

# Ensure compatibility with both camelCase and UPPERCASE naming in firebase_admin.messaging
if not hasattr(fb_messaging, "ApnsConfig") and hasattr(fb_messaging, "APNSConfig"):
    setattr(fb_messaging, "ApnsConfig", getattr(fb_messaging, "APNSConfig"))
if not hasattr(fb_messaging, "ApnsPayload") and hasattr(fb_messaging, "APNSPayload"):
    setattr(fb_messaging, "ApnsPayload", getattr(fb_messaging, "APNSPayload"))

from .config import get_env
from .firebase import get_admin_app

logger = logging.getLogger("liphtup.notifications")
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")

# Standard Notification Channels
CHANNEL_RIDE_REQUESTS = "ride_requests"
CHANNEL_WALLET = "liphtup_wallet_channel"
CHANNEL_DRIVER_UPDATES = "liphtup_driver_channel"
CHANNEL_DEFAULT = "default"

# Event Types
class NotificationEvent:
    RIDE_REQUEST = "ride_request"
    RIDE_ACCEPTED = "ride_accepted"
    DRIVER_ARRIVED = "driver_arrived"
    RIDE_STARTED = "ride_started"
    RIDE_COMPLETED = "ride_completed"
    RIDE_CANCELLED = "ride_cancelled"
    NEW_PASSENGER_AVAILABLE = "NEW_PASSENGER_AVAILABLE"
    SHARE_ADDON = "share_addon"
    PAYMENT_DUE = "payment_due"
    PAYMENT_VERIFIED = "payment_verified"
    PAYMENT_ACTION_REQUIRED = "payment_action_required"
    WALLET_CREDITED = "wallet_credited"
    COUPON_ALERT = "coupon_alert"
    GENERAL_ALERT = "general_alert"


# Cache for event-level deduplication (short TTL)
_RECENT_DISPATCHES: dict[str, float] = {}
_DEDUP_WINDOW_SECONDS = 5.0


def _clean_id(value: Any) -> str:
    return str(value or "").strip()[:160]


def collect_tokens(entity_dict: dict[str, Any]) -> list[str]:
    """Extract all valid unique FCM tokens from a user or presence document."""
    tokens: set[str] = set()
    fcm_token = entity_dict.get("fcmToken")
    if isinstance(fcm_token, str) and fcm_token.strip():
        tokens.add(fcm_token.strip())

    for token in entity_dict.get("pushTokens") or []:
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())

    for detail in entity_dict.get("pushTokenDetails") or []:
        token = (detail or {}).get("token") if isinstance(detail, dict) else None
        if isinstance(token, str) and token.strip():
            tokens.add(token.strip())

    return list(tokens)


def build_deep_link(destination_path: str, params: Optional[dict[str, Any]] = None) -> str:
    """Centralized deep-link generator for web and native."""
    path = destination_path.lstrip("/")
    # Normalise web clean paths
    if path.endswith(".html"):
        path = path[:-5]
    base = f"{APP_BASE_URL}/{path}" if path else APP_BASE_URL
    if params:
        query_items = [f"{k}={v}" for k, v in params.items() if v is not None and str(v).strip()]
        if query_items:
            base += "?" + "&".join(query_items)
    return base


def _check_idempotency(recipient_id: str, event_type: str, entity_id: str) -> bool:
    """Return True if event is a duplicate within the dedup window."""
    now = time.time()
    # Expire old records
    expired_keys = [k for k, ts in _RECENT_DISPATCHES.items() if now - ts > _DEDUP_WINDOW_SECONDS * 2]
    for k in expired_keys:
        _RECENT_DISPATCHES.pop(k, None)

    key = f"{recipient_id}:{event_type}:{entity_id}"
    last_sent = _RECENT_DISPATCHES.get(key)
    if last_sent and (now - last_sent) < _DEDUP_WINDOW_SECONDS:
        return True
    _RECENT_DISPATCHES[key] = now
    return False


def cleanup_invalid_tokens(db, invalid_tokens: list[str]) -> None:
    """Remove inactive/unregistered tokens across Firestore users and driverPresence."""
    if not invalid_tokens or not db:
        return
    unique_invalid = list(set(invalid_tokens))
    logger.info("Cleaning up %d invalid push tokens from Firestore", len(unique_invalid))
    try:
        for bad_token in unique_invalid:
            users = db.collection("users").where("pushTokens", "array_contains", bad_token).get()
            for u in users:
                u.reference.update({
                    "pushTokens": fb_firestore.ArrayRemove([bad_token]),
                    "fcmToken": None if (u.to_dict() or {}).get("fcmToken") == bad_token else fb_firestore.DELETE_FIELD,
                })
            presence = db.collection("driverPresence").where("pushTokens", "array_contains", bad_token).get()
            for p in presence:
                p.reference.update({
                    "pushTokens": fb_firestore.ArrayRemove([bad_token]),
                    "fcmToken": None if (p.to_dict() or {}).get("fcmToken") == bad_token else fb_firestore.DELETE_FIELD,
                })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Token cleanup encountered an error: %s", exc)


def create_fcm_multicast_message(
    tokens: list[str],
    event_type: str,
    title: str,
    body: str,
    url: str,
    channel_id: str = CHANNEL_DEFAULT,
    tag: Optional[str] = None,
    extra_data: Optional[dict[str, Any]] = None,
) -> fb_messaging.MulticastMessage:
    """
    Constructs a unified FCM MulticastMessage adhering to the LiphtUp payload contract.
    Ensures sound, vibration, channel alignment, and deep linking across Android and Web.
    """
    event_id = str(uuid.uuid4())
    data_payload: dict[str, str] = {
        "eventId": event_id,
        "schemaVersion": "1.0",
        "type": str(event_type),
        "title": str(title),
        "body": str(body),
        "url": str(url),
        "channel_id": str(channel_id),
        "tag": str(tag or f"liphtup-{event_type}"),
        "timestamp": str(int(time.time() * 1000)),
        "sound": "default",
    }
    if extra_data:
        for k, v in extra_data.items():
            if v is not None:
                data_payload[k] = str(v)

    android_config = fb_messaging.AndroidConfig(
        priority="high",
        notification=fb_messaging.AndroidNotification(
            title=title,
            body=body,
            sound="default",
            channel_id=channel_id,
            priority="max",
            default_vibrate_timings=True,
            visibility="public",
            tag=tag,
        ),
    )

    apns_config = fb_messaging.ApnsConfig(
        payload=fb_messaging.ApnsPayload(
            aps=fb_messaging.Aps(sound="default", badge=1, content_available=True)
        )
    )

    webpush_config = fb_messaging.WebpushConfig(
        headers={"Urgency": "high", "TTL": "600"},
        fcm_options=fb_messaging.WebpushFCMOptions(link=url),
        notification=fb_messaging.WebpushNotification(
            title=title,
            body=body,
            icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
            badge=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
            tag=tag or f"liphtup-{event_type}",
            renotify=True,
            require_interaction=True,
            vibrate=[350, 180, 350, 180, 700],
            actions=[fb_messaging.WebpushNotificationAction(action="open", title="Open")],
        ),
    )

    return fb_messaging.MulticastMessage(
        tokens=tokens,
        notification=fb_messaging.Notification(title=title, body=body),
        data=data_payload,
        android=android_config,
        apns=apns_config,
        webpush=webpush_config,
    )


def dispatch_push_notification(
    tokens: list[str],
    event_type: str,
    title: str,
    body: str,
    url: str,
    channel_id: str = CHANNEL_DEFAULT,
    tag: Optional[str] = None,
    extra_data: Optional[dict[str, Any]] = None,
    db: Optional[Any] = None,
) -> dict[str, Any]:
    """
    Sends push notification to given tokens, handles invalid token cleanup, and returns delivery summary.
    """
    clean_tokens = list(dict.fromkeys(t for t in tokens if t and isinstance(t, str) and t.strip()))[:500]
    if not clean_tokens:
        return {"ok": True, "sent": 0, "skipped": "no_tokens"}

    app = get_admin_app()
    message = create_fcm_multicast_message(
        tokens=clean_tokens,
        event_type=event_type,
        title=title,
        body=body,
        url=url,
        channel_id=channel_id,
        tag=tag,
        extra_data=extra_data,
    )

    try:
        response = fb_messaging.send_each_for_multicast(message, app=app)
        invalid_tokens: list[str] = []
        if response.failure_count > 0:
            for idx, resp in enumerate(response.responses):
                if not resp.success and resp.exception:
                    err_str = str(resp.exception).lower()
                    if (
                        isinstance(resp.exception, fb_messaging.UnregisteredError)
                        or "not-registered" in err_str
                        or "invalid-registration-token" in err_str
                        or "unregistered" in err_str
                    ):
                        invalid_tokens.append(clean_tokens[idx])

        if invalid_tokens and db:
            cleanup_invalid_tokens(db, invalid_tokens)

        logger.info(
            "Push notification dispatch: type=%s, success=%d, failed=%d",
            event_type,
            response.success_count,
            response.failure_count,
        )
        return {
            "ok": True,
            "sent": response.success_count,
            "failed": response.failure_count,
            "invalid_tokens_removed": len(invalid_tokens),
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("Push notification delivery error (%s): %s", event_type, exc)
        return {"ok": False, "sent": 0, "error": str(exc)}


def send_user_notification(
    db: Any,
    user_id: str,
    event_type: str,
    title: str,
    body: str,
    url: str,
    channel_id: str = CHANNEL_DEFAULT,
    tag: Optional[str] = None,
    extra_data: Optional[dict[str, Any]] = None,
    fallback_inapp: bool = True,
    is_driver: bool = False,
) -> dict[str, Any]:
    """
    High-level dispatch targeting a specific user (passenger or driver).
    Includes idempotency checks, in-app notification persistence, and token collection.
    """
    clean_uid = _clean_id(user_id)
    if not clean_uid:
        return {"ok": False, "error": "missing_user_id"}

    entity_id = (extra_data or {}).get("rideId") or (extra_data or {}).get("paymentId") or clean_uid
    if _check_idempotency(clean_uid, event_type, str(entity_id)):
        logger.info("Suppressed duplicate notification dispatch for user %s: %s", clean_uid, event_type)
        return {"ok": True, "skipped": "duplicate_idempotent"}

    # Save in-app notification fallback
    if fallback_inapp and db:
        try:
            db.collection("users").document(clean_uid).collection("inAppNotifications").document().set({
                "title": title,
                "body": body,
                "type": event_type,
                "url": url,
                "data": extra_data or {},
                "read": False,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to save in-app notification record: %s", exc)

    tokens: list[str] = []
    if is_driver:
        presence_doc = db.collection("driverPresence").document(clean_uid).get()
        if presence_doc.exists:
            tokens.extend(collect_tokens(presence_doc.to_dict() or {}))

    if not tokens:
        u_doc = db.collection("users").document(clean_uid).get()
        if u_doc.exists:
            tokens.extend(collect_tokens(u_doc.to_dict() or {}))

    if not tokens:
        return {"ok": True, "sent": 0, "status": "inapp_only_no_push_tokens"}

    computed_tag = tag or (f"liphtup-ride-{entity_id}" if entity_id and entity_id != clean_uid else f"liphtup-{event_type}-{clean_uid}")

    return dispatch_push_notification(
        tokens=tokens,
        event_type=event_type,
        title=title,
        body=body,
        url=url,
        channel_id=channel_id,
        tag=computed_tag,
        extra_data=extra_data,
        db=db,
    )
