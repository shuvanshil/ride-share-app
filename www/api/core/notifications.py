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


def normalize_channel_id(channel_id: Optional[str]) -> str:
    raw = str(channel_id or "").strip().lower()
    if raw in ("ride_requests", "ride_request", "ride_updates", "rides"):
        return CHANNEL_RIDE_REQUESTS
    if raw in ("liphtup_wallet_channel", "wallet", "payment", "payments"):
        return CHANNEL_WALLET
    if raw in ("liphtup_driver_channel", "driver", "driver_updates"):
        return CHANNEL_DRIVER_UPDATES
    return CHANNEL_DEFAULT


def collect_tokens(entity_dict: dict[str, Any]) -> list[str]:
    """Extract all valid unique FCM tokens from a user or presence document."""
    if not isinstance(entity_dict, dict):
        return []
    tokens: list[str] = []
    seen: set[str] = set()

    def _add(tok: Any) -> None:
        if isinstance(tok, str) and tok.strip():
            clean = tok.strip()
            if clean not in seen:
                seen.add(clean)
                tokens.append(clean)

    _add(entity_dict.get("fcmToken"))

    for token in entity_dict.get("pushTokens") or []:
        _add(token)

    for detail in entity_dict.get("pushTokenDetails") or []:
        if isinstance(detail, dict):
            _add(detail.get("token"))

    return tokens


def build_deep_link(destination_path: str, params: Optional[dict[str, Any]] = None) -> str:
    """Centralized deep-link generator for web and native."""
    raw = str(destination_path or "/").strip()
    base_origin = APP_BASE_URL
    if not base_origin.startswith(("http://", "https://")):
        base_origin = f"https://{base_origin.lstrip('/')}"

    if raw.startswith(("https://", "http://")):
        base = raw.rstrip("/") if raw not in ("https://", "http://") else base_origin
        if base.startswith("http://") and "localhost" not in base and "127.0.0.1" not in base:
            base = "https://" + base[len("http://"):]
    else:
        path = raw.lstrip("/")
        if path.endswith(".html"):
            path = path[:-5]
        base = f"{base_origin}/{path}" if path else base_origin

    if params:
        query_items = [f"{k}={v}" for k, v in params.items() if v is not None and str(v).strip()]
        if query_items:
            sep = "&" if "?" in base else "?"
            base += sep + "&".join(query_items)
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


def _clean_doc_tokens(doc_snap: Any, bad_set: set[str]) -> None:
    """Remove bad tokens from a single Firestore document snapshot without clobbering valid fcmToken."""
    if not doc_snap or not getattr(doc_snap, "exists", False):
        return
    data = doc_snap.to_dict() or {}
    curr_fcm = data.get("fcmToken")
    curr_push = [t for t in (data.get("pushTokens") or []) if isinstance(t, str) and t.strip()]
    curr_details = [d for d in (data.get("pushTokenDetails") or []) if isinstance(d, dict)]

    has_bad_fcm = isinstance(curr_fcm, str) and curr_fcm.strip() in bad_set
    has_bad_push = any(t.strip() in bad_set for t in curr_push)
    has_bad_details = any(str(d.get("token") or "").strip() in bad_set for d in curr_details)

    if not (has_bad_fcm or has_bad_push or has_bad_details):
        return

    remaining_push = [t for t in curr_push if t.strip() not in bad_set]
    remaining_details = [d for d in curr_details if str(d.get("token") or "").strip() not in bad_set]

    update_payload: dict[str, Any] = {
        "pushTokens": remaining_push,
        "pushTokenDetails": remaining_details,
    }
    if has_bad_fcm:
        update_payload["fcmToken"] = remaining_push[-1] if remaining_push else None

    try:
        doc_snap.reference.update(update_payload)
    except Exception:
        try:
            doc_snap.reference.set(update_payload, merge=True)
        except Exception:
            pass


def cleanup_invalid_tokens(db, invalid_tokens: list[str], target_uids: Optional[list[str]] = None) -> None:
    """Remove inactive/unregistered tokens across Firestore users and driverPresence."""
    if not invalid_tokens or not db:
        return
    bad_set = {str(t).strip() for t in invalid_tokens if isinstance(t, str) and str(t).strip()}
    if not bad_set:
        return
    unique_invalid = list(bad_set)
    logger.info("Cleaning up %d invalid push tokens from Firestore", len(unique_invalid))
    try:
        if target_uids:
            for uid in set(str(u).strip() for u in target_uids if u):
                try:
                    _clean_doc_tokens(db.collection("users").document(uid).get(), bad_set)
                except Exception:
                    pass
                try:
                    _clean_doc_tokens(db.collection("driverPresence").document(uid).get(), bad_set)
                except Exception:
                    pass

        for bad_token in unique_invalid:
            for coll_name in ("users", "driverPresence"):
                try:
                    snaps = db.collection(coll_name).where("pushTokens", "array_contains", bad_token).get()
                    for snap in snaps:
                        _clean_doc_tokens(snap, bad_set)
                except Exception:
                    pass
                try:
                    fcm_snaps = db.collection(coll_name).where("fcmToken", "==", bad_token).get()
                    for snap in fcm_snaps:
                        _clean_doc_tokens(snap, bad_set)
                except Exception:
                    pass
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
    resolved_channel = normalize_channel_id(channel_id)
    resolved_url = build_deep_link(url or "/")
    webpush_link = resolved_url if resolved_url.startswith("https://") else f"https://liphtup.in/{resolved_url.lstrip('/')}"
    icon_base = APP_BASE_URL if APP_BASE_URL.startswith("https://") else "https://liphtup.in"

    event_id = str(uuid.uuid4())
    data_payload: dict[str, str] = {
        "eventId": event_id,
        "schemaVersion": "1.0",
        "type": str(event_type),
        "title": str(title),
        "body": str(body),
        "url": str(resolved_url),
        "channel_id": str(resolved_channel),
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
            channel_id=resolved_channel,
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
        fcm_options=fb_messaging.WebpushFCMOptions(link=webpush_link),
        notification=fb_messaging.WebpushNotification(
            title=title,
            body=body,
            icon=f"{icon_base}/assets/icons/liphtup-icon-192.png",
            badge=f"{icon_base}/assets/icons/liphtup-icon-192.png",
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


def _is_invalid_token_error(exc: Any) -> bool:
    if exc is None:
        return False
    cls_name = type(exc).__name__.lower()
    err_str = str(exc).lower()
    err_code = str(getattr(exc, "code", "") or "").lower()
    if isinstance(exc, fb_messaging.UnregisteredError):
        return True
    if any(k in cls_name for k in ("unregistered", "senderidmismatch", "thirdpartyauth", "notfound")):
        return True
    if any(
        k in err_str or k in err_code
        for k in (
            "not-registered",
            "unregistered",
            "invalid-registration-token",
            "not a valid fcm registration token",
            "requested entity was not found",
            "registration-token-not-registered",
            "sender-id-mismatch",
            "mismatched-credential",
            "third-party-auth-error",
            "not_found",
        )
    ):
        return True
    return False


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
    target_uids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Sends push notification to given tokens, handles invalid token cleanup, and returns delivery summary.
    """
    clean_tokens = list(dict.fromkeys(t.strip() for t in tokens if t and isinstance(t, str) and t.strip()))[:500]
    if not clean_tokens:
        return {
            "ok": True,
            "sent": 0,
            "failed": 0,
            "skipped": "no_tokens",
            "successful_tokens": [],
            "failed_tokens": [],
            "invalid_tokens": [],
        }

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
        successful_tokens: list[str] = []
        retry_candidate_tokens: list[str] = []
        failed_tokens: list[str] = []

        responses_list = getattr(response, "responses", None) or []
        for idx, resp in enumerate(responses_list):
            tok = clean_tokens[idx] if idx < len(clean_tokens) else ""
            if getattr(resp, "success", False):
                if tok:
                    successful_tokens.append(tok)
            else:
                exc = getattr(resp, "exception", None)
                if _is_invalid_token_error(exc):
                    if tok:
                        invalid_tokens.append(tok)
                        failed_tokens.append(tok)
                else:
                    if tok:
                        retry_candidate_tokens.append(tok)

        # If any non-invalid tokens failed due to platform-specific config options, retry with core payload
        if retry_candidate_tokens:
            try:
                fallback_msg = fb_messaging.MulticastMessage(
                    tokens=retry_candidate_tokens,
                    notification=fb_messaging.Notification(title=title, body=body),
                    data=message.data,
                )
                retry_resp = fb_messaging.send_each_for_multicast(fallback_msg, app=app)
                for r_idx, r_item in enumerate(getattr(retry_resp, "responses", None) or []):
                    r_tok = retry_candidate_tokens[r_idx] if r_idx < len(retry_candidate_tokens) else ""
                    if getattr(r_item, "success", False):
                        if r_tok:
                            successful_tokens.append(r_tok)
                    else:
                        if _is_invalid_token_error(getattr(r_item, "exception", None)) and r_tok:
                            invalid_tokens.append(r_tok)
                        if r_tok:
                            failed_tokens.append(r_tok)
            except Exception:
                failed_tokens.extend(retry_candidate_tokens)

        if invalid_tokens and db:
            cleanup_invalid_tokens(db, invalid_tokens, target_uids=target_uids)

        sent_count = len(successful_tokens) if responses_list else int(getattr(response, "success_count", 0) or 0)
        fail_count = len(failed_tokens) if responses_list else int(getattr(response, "failure_count", 0) or 0)

        logger.info(
            "Push notification dispatch: type=%s, success=%d, failed=%d, invalid_removed=%d",
            event_type,
            sent_count,
            fail_count,
            len(invalid_tokens),
        )
        return {
            "ok": True,
            "sent": sent_count,
            "failed": fail_count,
            "invalid_tokens_removed": len(invalid_tokens),
            "successful_tokens": successful_tokens,
            "failed_tokens": failed_tokens,
            "invalid_tokens": invalid_tokens,
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("Push notification delivery error (%s): %s", event_type, exc)
        return {
            "ok": False,
            "sent": 0,
            "failed": len(clean_tokens),
            "error": str(exc),
            "successful_tokens": [],
            "failed_tokens": clean_tokens,
            "invalid_tokens": [],
        }


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
