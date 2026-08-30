"""
Passenger Coupon API Router.

Provides endpoints for:
- Querying eligible and suggested coupons for an active ride (GET /coupons/eligible)
- Applying a promotional coupon to an active ride atomically (POST /coupons/apply)
- Viewing historical passenger coupon redemptions (GET /coupons/redemptions)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Query
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging
from pydantic import BaseModel, Field

from ..core.auth import current_user
from ..core.config import get_env
from ..core.coupon_service import (
    apply_coupon_to_ride_tx,
    get_eligible_coupons_for_ride,
    normalize_coupon_code,
    paise_to_inr_float,
    sanitize_dict_for_json,
)
from ..core.errors import ApiError
from ..core.firebase import get_admin_app, get_firestore

router = APIRouter(prefix="/coupons", tags=["coupons"])


class ApplyCouponRequest(BaseModel):
    rideId: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=50)
    idempotencyKey: Optional[str] = Field(default=None, max_length=160)


def _send_driver_coupon_push(driver_id: str, ride_id: str, discount_inr: float, remaining_fare_inr: float):
    """Dispatches background push and in-app telemetry alert to driver after coupon application commits."""
    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        tokens = set()

        presence_snap = db.collection("driverPresence").document(driver_id).get()
        if presence_snap.exists:
            driver_data = presence_snap.to_dict() or {}
            tokens.update(driver_data.get("pushTokens") or [])
            for detail in driver_data.get("pushTokenDetails") or []:
                tok = (detail or {}).get("token") if isinstance(detail, dict) else None
                if tok and isinstance(tok, str):
                    tokens.add(tok.strip())

        user_snap = db.collection("users").document(driver_id).get()
        if user_snap.exists:
            u_data = user_snap.to_dict() or {}
            tokens.update(u_data.get("pushTokens") or [])
            for detail in u_data.get("pushTokenDetails") or []:
                tok = (detail or {}).get("token") if isinstance(detail, dict) else None
                if tok and isinstance(tok, str):
                    tokens.add(tok.strip())
            if u_data.get("fcmToken"):
                tokens.add(str(u_data.get("fcmToken")).strip())

        title = "Ride Fare Updated"
        body_text = f"Coupon applied! ₹{discount_inr:g} platform subsidy credited to your wallet. Remaining cash to collect: ₹{remaining_fare_inr:g}."
        notification_url = f"{APP_BASE_URL}/driver?rideId={ride_id}&from=coupon_push"
        data_payload = {
            "type": "COUPON_FARE_ADJUSTMENT",
            "rideId": ride_id,
            "title": title,
            "body": body_text,
            "discountAmount": str(discount_inr),
            "remainingFare": str(remaining_fare_inr),
            "url": notification_url,
        }

        # 1. Save in-app notification document for driver
        try:
            db.collection("users").document(driver_id).collection("inAppNotifications").document().set({
                "title": title,
                "body": body_text,
                "data": data_payload,
                "read": False,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            pass

        unique_tokens = list(dict.fromkeys(t for t in tokens if t))[:100]
        if not unique_tokens:
            return

        message = fb_messaging.MulticastMessage(
            tokens=unique_tokens,
            notification=fb_messaging.Notification(title=title, body=body_text),
            data={**{k: str(v) for k, v in data_payload.items()}},
            android=fb_messaging.AndroidConfig(
                priority="high",
                notification=fb_messaging.AndroidNotification(
                    title=title,
                    body=body_text,
                    sound="default",
                    channel_id="ride_requests",
                ),
            ),
            apns=fb_messaging.ApnsConfig(
                payload=fb_messaging.ApnsPayload(
                    aps=fb_messaging.Aps(sound="default", badge=1)
                )
            ),
            webpush=fb_messaging.WebpushConfig(
                headers={"Urgency": "high", "TTL": "300"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=notification_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body_text,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    badge=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag=f"coupon-pay-{ride_id}",
                    renotify=True,
                ),
            ),
        )
        resp = fb_messaging.send_each_for_multicast(message, app=app)
        print(f"[PUSH] Sent driver coupon subsidy push to {len(unique_tokens)} tokens (success: {resp.success_count}, failed: {resp.failure_count})")
    except Exception as exc:  # noqa: BLE001
        print(f"[PUSH_ERROR] Driver coupon subsidy push failed: {exc}")


@router.get("/eligible")
async def get_eligible_coupons(
    rideId: str = Query(..., min_length=1, max_length=160),
    user: Dict[str, Any] = Depends(current_user),
    db: Any = Depends(get_firestore),
):
    """
    Returns eligible coupons and the deterministically suggested coupon for the active ride.
    Enforces server-authoritative validation based on ride history, status, and restrictions.
    """
    user_id = user["uid"]
    data = get_eligible_coupons_for_ride(db, user_id, rideId)
    return {
        "ok": True,
        **data,
    }


@router.post("/apply")
async def apply_coupon(
    payload: ApplyCouponRequest,
    user: Dict[str, Any] = Depends(current_user),
    db: Any = Depends(get_firestore),
):
    """
    Atomically applies a promotional coupon to an active ride.
    Credits the driver's wallet with COUPON_DISCOUNT_RECEIPT without debiting driver earnings.
    Enforces mutual exclusivity with wallet credits and protects against concurrency/duplicate submission.
    """
    user_id = user["uid"]
    result = apply_coupon_to_ride_tx(
        db=db,
        passenger_id=user_id,
        ride_id=payload.rideId,
        coupon_code=payload.code,
        idempotency_key=payload.idempotencyKey,
    )

    # Dispatch driver background push notification post-commit
    driver_id = result.get("driverId")
    if driver_id:
        discount_amt = result.get("discountAmount", 0.0)
        remaining_amt = result.get("remainingFare", 0.0)
        _send_driver_coupon_push(driver_id, payload.rideId, discount_amt, remaining_amt)

    return {
        "ok": True,
        "result": result,
    }


@router.get("/redemptions")
async def get_my_coupon_redemptions(
    user: Dict[str, Any] = Depends(current_user),
    db: Any = Depends(get_firestore),
):
    """Returns the passenger's historical coupon redemptions."""
    user_id = user["uid"]
    redemptions_snap = (
        db.collection("couponRedemptions")
        .where("passengerId", "==", user_id)
        .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
        .limit(50)
        .get()
    )
    items = []
    for doc in redemptions_snap:
        d = doc.to_dict() or {}
        created_at = d.get("createdAt")
        created_iso = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at or "")
        items.append({
            "redemptionId": d.get("redemptionId", doc.id),
            "couponCode": d.get("couponCode"),
            "discountAmount": d.get("discountAmountINR", paise_to_inr_float(int(d.get("calculatedDiscountPaise") or 0))),
            "rideId": d.get("rideId"),
            "status": d.get("status", "completed"),
            "createdAt": created_iso,
        })
    return {
        "ok": True,
        "redemptions": items,
    }
