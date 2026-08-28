"""
User Wallet API Router (Passenger & Driver).

Provides endpoints for querying wallet balance, transaction history,
active ride wallet fare payments, credit acknowledgement, and driver settlement info.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Query
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging
from pydantic import BaseModel, Field

from ..core.auth import current_user
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app, get_firestore
from ..core.wallet_service import (
    inr_to_paise,
    paise_to_inr_float,
    transfer_ride_fare,
)

router = APIRouter(prefix="/wallet", tags=["wallet"])
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


class PayCurrentRideRequest(BaseModel):
    rideId: str = Field(min_length=1, max_length=160)
    amountPaise: Optional[int] = Field(default=None, ge=1)
    amount: Optional[float] = None
    idempotencyKey: Optional[str] = Field(default=None, max_length=160)


class AcknowledgeCreditRequest(BaseModel):
    transactionId: str = Field(min_length=1, max_length=160)


def _format_transaction_for_client(data: Dict[str, Any], user_role: str) -> Dict[str, Any]:
    """Sanitizes transaction documents for least-privilege client consumption."""
    created_at = data.get("createdAt")
    if hasattr(created_at, "isoformat"):
        created_at_str = created_at.isoformat()
    else:
        created_at_str = str(created_at) if created_at else None

    amount_paise = int(data.get("amountPaise") or 0)
    balance_after_paise = int(data.get("balanceAfterPaise") or 0)

    res = {
        "transactionId": data.get("transactionId"),
        "type": data.get("type"),
        "direction": data.get("direction"),
        "amountPaise": amount_paise,
        "amount": paise_to_inr_float(amount_paise),
        "balanceAfterPaise": balance_after_paise,
        "balanceAfter": paise_to_inr_float(balance_after_paise),
        "status": data.get("status", "completed"),
        "description": data.get("description", ""),
        "referenceType": data.get("referenceType"),
        "referenceId": data.get("referenceId"),
        "rideId": data.get("rideId"),
        "tags": data.get("tags") or [],
        "createdAt": created_at_str,
        "isReversed": bool(data.get("isReversed", False)),
    }

    # Role-specific context
    if user_role == "driver":
        res["passengerName"] = data.get("counterpartyName") or "Passenger"
    elif user_role == "passenger":
        res["driverName"] = data.get("counterpartyName") or "Driver"

    return res


def _send_driver_wallet_payment_push(driver_id: str, ride_id: str, amount_inr: float, remaining_fare_inr: float):
    """Dispatches background push and in-app notification to driver after wallet payment commits."""
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

        title = "Wallet Payment Received"
        body_text = f"The passenger paid ₹{amount_inr:g} using wallet credits. Remaining ride fare: ₹{remaining_fare_inr:g}."
        notification_url = f"{APP_BASE_URL}/driver?rideId={ride_id}&from=wallet_push"
        data_payload = {
            "type": "wallet_payment_received",
            "rideId": ride_id,
            "title": title,
            "body": body_text,
            "amount": str(amount_inr),
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
                    tag=f"wallet-pay-{ride_id}",
                    renotify=True,
                ),
            ),
        )
        resp = fb_messaging.send_each_for_multicast(message, app=app)
        print(f"[PUSH] Sent driver wallet payment push to {len(unique_tokens)} tokens (success: {resp.success_count}, failed: {resp.failure_count})")
    except Exception as exc:  # noqa: BLE001
        print(f"[PUSH_ERROR] Driver wallet payment push failed: {exc}")


@router.get("")
@router.get("/")
def get_user_wallet(auth_user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    """Retrieve the authenticated user's wallet profile and spendable balance."""
    uid = auth_user["uid"]
    db = get_firestore()

    wallet_ref = db.collection("wallets").document(uid)
    wallet_snap = wallet_ref.get()

    if not wallet_snap.exists:
        role = auth_user.get("role", "passenger")
        initial_wallet = {
            "userId": uid,
            "userRole": role,
            "balancePaise": 0,
            "currency": "INR",
            "status": "active",
            "lifetimeCreditPaise": 0,
            "lifetimeDebitPaise": 0,
        }
        wallet_ref.set(
            {
                **initial_wallet,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }
        )
        wallet_data = initial_wallet
    else:
        wallet_data = wallet_snap.to_dict() or {}

    balance_paise = int(wallet_data.get("balancePaise") or 0)
    user_role = wallet_data.get("userRole", auth_user.get("role", "passenger"))

    # Active ride check for passenger shortcut
    active_ride_info = None
    if user_role == "passenger":
        active_rides = list(
            db.collection("rides")
            .where("passenger_id", "==", uid)
            .where("status", "in", ["started", "en_route"])
            .limit(1)
            .stream()
        )
        if active_rides:
            r_doc = active_rides[0]
            r_data = r_doc.to_dict() or {}
            fare_paise = int(r_data.get("farePaise") or inr_to_paise(r_data.get("fare") or 0))
            wallet_paid_paise = int(r_data.get("walletPaidAmountPaise") or inr_to_paise(r_data.get("wallet_paid_amount") or 0))
            cash_paid_paise = int(r_data.get("cashPaidAmountPaise") or inr_to_paise(r_data.get("cash_paid_amount") or 0))
            rem_paise = max(0, fare_paise - (wallet_paid_paise + cash_paid_paise))

            if rem_paise > 0:
                active_ride_info = {
                    "rideId": r_doc.id,
                    "farePaise": fare_paise,
                    "fare": paise_to_inr_float(fare_paise),
                    "remainingFarePaise": rem_paise,
                    "remainingFare": paise_to_inr_float(rem_paise),
                    "driverName": r_data.get("driver_name", "Driver"),
                    "driverId": r_data.get("driver_id", ""),
                }

    return {
        "ok": True,
        "wallet": {
            "userId": uid,
            "userRole": user_role,
            "balancePaise": balance_paise,
            "balance": paise_to_inr_float(balance_paise),
            "currency": wallet_data.get("currency", "INR"),
            "status": wallet_data.get("status", "active"),
            "lifetimeCreditPaise": int(wallet_data.get("lifetimeCreditPaise") or 0),
            "lifetimeCredit": paise_to_inr_float(int(wallet_data.get("lifetimeCreditPaise") or 0)),
            "lifetimeDebitPaise": int(wallet_data.get("lifetimeDebitPaise") or 0),
            "lifetimeDebit": paise_to_inr_float(int(wallet_data.get("lifetimeDebitPaise") or 0)),
            "activeRidePayable": active_ride_info,
        },
    }


@router.get("/transactions")
def get_user_transactions(
    limit: int = Query(20, ge=1, le=100),
    direction: Optional[str] = Query(None),
    type_filter: Optional[str] = Query(None, alias="type"),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Retrieve paginated transaction history for the authenticated user."""
    uid = auth_user["uid"]
    role = auth_user.get("role", "passenger")
    db = get_firestore()

    query = db.collection("walletTransactions").where("userId", "==", uid)
    if direction:
        query = query.where("direction", "==", direction.strip().lower())
    if type_filter:
        query = query.where("type", "==", type_filter.strip().upper())

    docs = list(query.stream())
    txs = [_format_transaction_for_client(d.to_dict() or {}, role) for d in docs]
    txs.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)

    total_count = len(txs)
    paginated = txs[:limit]

    return {
        "ok": True,
        "transactions": paginated,
        "totalCount": total_count,
        "hasMore": total_count > limit,
    }


@router.post("/pay-current-ride")
def pay_current_ride(
    body: PayCurrentRideRequest = Body(...),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """
    Executes an atomic passenger-to-driver ride wallet transfer.
    Server independently validates fare, ride state, ownership, and wallet balance.
    """
    uid = auth_user["uid"]
    role = auth_user.get("role", "passenger")
    if role != "passenger":
        raise ApiError("Only passengers can make ride wallet payments.", 403)

    db = get_firestore()

    # Determine amount in integer paise
    requested_paise = None
    if body.amountPaise is not None and body.amountPaise > 0:
        requested_paise = int(body.amountPaise)
    elif body.amount is not None and body.amount > 0:
        requested_paise = inr_to_paise(body.amount)

    result = transfer_ride_fare(
        db=db,
        passenger_id=uid,
        ride_id=body.rideId,
        requested_amount_paise=requested_paise,
        idempotency_key=body.idempotencyKey,
    )

    # Dispatches non-blocking push to driver
    if not result.get("idempotent_replay") and result.get("driverId"):
        _send_driver_wallet_payment_push(
            driver_id=result["driverId"],
            ride_id=result["rideId"],
            amount_inr=result["transferAmount"],
            remaining_fare_inr=result["remainingFare"],
        )

    return {
        "ok": True,
        "message": "Ride wallet payment completed successfully.",
        "result": result,
    }


@router.get("/unacknowledged-credits")
def get_unacknowledged_credits(auth_user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    """Retrieve newly granted promotional credits or driver settlement payouts for celebration modals."""
    uid = auth_user["uid"]
    role = auth_user.get("role", "passenger")
    db = get_firestore()

    unacknowledged: List[Dict[str, Any]] = []

    # 1. Fetch unacknowledged ADMIN_CREDIT transactions (for passengers & general users)
    admin_credits = list(
        db.collection("walletTransactions")
        .where("userId", "==", uid)
        .where("type", "==", "ADMIN_CREDIT")
        .where("status", "==", "completed")
        .stream()
    )
    for doc in admin_credits:
        d = doc.to_dict() or {}
        tx_id = d.get("transactionId")
        if not tx_id:
            continue
        ack_snap = db.collection("walletCreditAcknowledgements").document(f"ack_{uid}_{tx_id}").get()
        if not ack_snap.exists:
            formatted = _format_transaction_for_client(d, role)
            formatted["modalType"] = "admin_credit"
            unacknowledged.append(formatted)

    # 2. If driver, also fetch unacknowledged DRIVER_SETTLEMENT transactions
    if role == "driver":
        driver_settlements = list(
            db.collection("walletTransactions")
            .where("userId", "==", uid)
            .where("type", "==", "DRIVER_SETTLEMENT")
            .where("status", "==", "completed")
            .stream()
        )
        for doc in driver_settlements:
            d = doc.to_dict() or {}
            tx_id = d.get("transactionId")
            if not tx_id:
                continue
            ack_snap = db.collection("walletCreditAcknowledgements").document(f"ack_{uid}_{tx_id}").get()
            if not ack_snap.exists:
                formatted = _format_transaction_for_client(d, "driver")
                formatted["modalType"] = "driver_settlement"
                formatted["settlementAmount"] = formatted.get("amount", 0)
                unacknowledged.append(formatted)

    return {
        "ok": True,
        "unacknowledgedCredits": unacknowledged,
    }


@router.post("/acknowledge-credit")
def acknowledge_credit(
    body: AcknowledgeCreditRequest = Body(...),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Marks a received credit celebration modal as acknowledged."""
    uid = auth_user["uid"]
    db = get_firestore()
    tx_id = body.transactionId.strip()

    ack_ref = db.collection("walletCreditAcknowledgements").document(f"ack_{uid}_{tx_id}")
    ack_ref.set(
        {
            "userId": uid,
            "transactionId": tx_id,
            "acknowledgedAt": fb_firestore.SERVER_TIMESTAMP,
        }
    )

    return {"ok": True, "acknowledged": True}


@router.get("/driver/settlement-info")
def get_driver_settlement_info(auth_user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    """Retrieve settlement history and next scheduled settlement date for driver."""
    uid = auth_user["uid"]
    role = auth_user.get("role", "driver")
    if role != "driver":
        raise ApiError("Only driver accounts can access settlement information.", 403)

    db = get_firestore()

    # 1. Driver wallet
    wallet_snap = db.collection("wallets").document(uid).get()
    balance_paise = 0
    if wallet_snap.exists:
        balance_paise = int((wallet_snap.to_dict() or {}).get("balancePaise", 0))

    # 2. Next settlement date config from systemSettings
    cfg_snap = db.collection("systemSettings").document("driverSettlementConfig").get()
    cfg_data = (cfg_snap.to_dict() or {}) if cfg_snap.exists else {}
    next_date = cfg_data.get("nextSettlementDate") or "To be scheduled"

    # 3. Driver settlement records
    settlements = list(
        db.collection("driverSettlements")
        .where("driverId", "==", uid)
        .stream()
    )
    settlement_list = []
    active_settlement = None
    for s_doc in settlements:
        s_data = s_doc.to_dict() or {}
        st_obj = {
            "settlementId": s_data.get("settlementId"),
            "amountPaise": int(s_data.get("settlementAmountPaise") or 0),
            "amount": paise_to_inr_float(int(s_data.get("settlementAmountPaise") or 0)),
            "status": s_data.get("status"),
            "upiIdSnapshot": s_data.get("upiIdSnapshot"),
            "settlementDate": s_data.get("settlementDate"),
            "createdAt": s_data.get("createdAt").isoformat() if hasattr(s_data.get("createdAt"), "isoformat") else str(s_data.get("createdAt")),
            "resolvedAt": s_data.get("resolvedAt").isoformat() if hasattr(s_data.get("resolvedAt"), "isoformat") else (str(s_data.get("resolvedAt")) if s_data.get("resolvedAt") else None),
        }
        settlement_list.append(st_obj)
        if s_data.get("status") in ["ready", "processing"]:
            active_settlement = st_obj

    settlement_list.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)

    return {
        "ok": True,
        "availableBalancePaise": balance_paise,
        "availableBalance": paise_to_inr_float(balance_paise),
        "nextSettlementDate": next_date,
        "nextSettlementDateFormatted": next_date,
        "activeSettlement": active_settlement,
        "settlements": settlement_list,
    }
