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

        valid_tokens = [t for t in tokens if t and len(t) > 10]
        if valid_tokens:
            body_text = f"Fare updated. ₹{discount_inr:.0f} promotional adjustment applied. Amount to collect: ₹{remaining_fare_inr:.0f}."
            message = fb_messaging.MulticastMessage(
                notification=fb_messaging.Notification(
                    title="Ride Fare Updated",
                    body=body_text,
                ),
                data={
                    "type": "COUPON_FARE_ADJUSTMENT",
                    "rideId": ride_id,
                    "discountAmount": str(discount_inr),
                    "remainingFare": str(remaining_fare_inr),
                },
                tokens=valid_tokens,
            )
            fb_messaging.send_each_for_multicast(message, app=app)
    except Exception:
        # Non-blocking notification dispatch
        pass


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
