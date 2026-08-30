"""
Admin Wallet API Router.

Handles administrative passenger promotional credit grants, reversals (> ₹1,000),
driver manual settlement lifecycle, settlement date configuration, and ledger reconciliation.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Query
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging
from pydantic import BaseModel, Field

from ..core.admin import require_admin, write_audit_log
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app, get_firestore
from ..core.wallet_service import (
    create_driver_settlement,
    grant_passenger_credit,
    inr_to_paise,
    paise_to_inr_float,
    reconcile_wallet,
    resolve_driver_full_wallet_balance,
    resolve_driver_settlement,
    reverse_admin_credit,
)

router = APIRouter(prefix="/admin/wallet", tags=["admin-wallet"])
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


class GrantPassengerCreditRequest(BaseModel):
    passengerId: str = Field(min_length=1, max_length=160)
    amountPaise: Optional[int] = Field(default=None, ge=1)
    amount: Optional[float] = None
    tags: List[str] = Field(min_length=1)
    description: Optional[str] = Field(default="", max_length=300)


class ReverseCreditRequest(BaseModel):
    transactionId: str = Field(min_length=1, max_length=160)
    reason: str = Field(min_length=1, max_length=300)


class CreateSettlementRequest(BaseModel):
    driverId: str = Field(min_length=1, max_length=160)
    settlementDate: Optional[str] = None


class ResolveSettlementRequest(BaseModel):
    settlementId: Optional[str] = Field(default=None, max_length=160)
    driverId: Optional[str] = Field(default=None, max_length=160)
    adminNote: Optional[str] = Field(default="", max_length=500)


class UpdateSettlementConfigRequest(BaseModel):
    nextSettlementDate: str = Field(min_length=4, max_length=50)


def _mask_upi(upi: Optional[str]) -> str:
    """Masks UPI ID for list views to protect privacy."""
    if not upi:
        return "Not on file"
    parts = upi.split("@")
    if len(parts) != 2:
        return upi
    handle, provider = parts
    if len(handle) <= 2:
        masked_handle = handle + "**"
    else:
        masked_handle = handle[:2] + "****" + handle[-1]
    return f"{masked_handle}@{provider}"


def _send_settlement_resolved_push(driver_id: str, amount_inr: float, upi_id: str):
    """Dispatches background push and in-app notification to driver after settlement resolution."""
    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        tokens = set()
        
        # Check driverPresence
        presence_snap = db.collection("driverPresence").document(driver_id).get()
        if presence_snap.exists:
            driver_data = presence_snap.to_dict() or {}
            tokens.update(driver_data.get("pushTokens") or [])
            for detail in driver_data.get("pushTokenDetails") or []:
                tok = (detail or {}).get("token") if isinstance(detail, dict) else None
                if tok and isinstance(tok, str):
                    tokens.add(tok.strip())

        # Check users doc
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

        title = "Wallet Settlement Paid!"
        body_text = f"₹{amount_inr:g} has been successfully settled and paid to your registered UPI ID ({upi_id})."
        notification_url = f"{APP_BASE_URL}/driver-payments.html?tab=wallet"
        data_payload = {
            "type": "driver_settlement_resolved",
            "title": title,
            "body": body_text,
            "amount": str(amount_inr),
            "url": notification_url,
        }

        # 1. Always record in-app notification document
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
                headers={"Urgency": "high", "TTL": "600"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=notification_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body_text,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    badge=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag="driver-settlement",
                ),
            ),
        )
        resp = fb_messaging.send_each_for_multicast(message, app=app)
        print(f"[PUSH] Sent driver settlement push to {len(unique_tokens)} tokens (success: {resp.success_count}, failed: {resp.failure_count})")
    except Exception as exc:  # noqa: BLE001
        print(f"[PUSH_ERROR] Driver settlement push failed: {exc}")


def _send_passenger_credit_push(passenger_id: str, amount_inr: float, tag_label: str):
    """Dispatches background push and in-app notification to passenger after credit grant."""
    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        user_snap = db.collection("users").document(passenger_id).get()
        if not user_snap.exists:
            return
        user_data = user_snap.to_dict() or {}
        tokens = set(user_data.get("pushTokens") or [])
        for detail in user_data.get("pushTokenDetails") or []:
            tok = (detail or {}).get("token") if isinstance(detail, dict) else None
            if tok and isinstance(tok, str):
                tokens.add(tok.strip())
        if user_data.get("fcmToken"):
            tokens.add(str(user_data.get("fcmToken")).strip())

        title = "Wallet Credit Received!"
        body_text = f"You received ₹{amount_inr:g} {tag_label} wallet credits! Thank you for riding with LiphtUp."
        notification_url = f"{APP_BASE_URL}/profile.html?open=wallet"
        data_payload = {
            "type": "passenger_credit_received",
            "title": title,
            "body": body_text,
            "amount": str(amount_inr),
            "url": notification_url,
        }

        # 1. Always record in-app notification document
        try:
            db.collection("users").document(passenger_id).collection("inAppNotifications").document().set({
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
            print(f"[PUSH] No registered push tokens found for passenger {passenger_id}")
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
                headers={"Urgency": "high", "TTL": "600"},
                fcm_options=fb_messaging.WebpushFCMOptions(link=notification_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body_text,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    badge=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag="passenger-credit",
                ),
            ),
        )
        resp = fb_messaging.send_each_for_multicast(message, app=app)
        print(f"[PUSH] Sent passenger credit push to {len(unique_tokens)} tokens (success: {resp.success_count}, failed: {resp.failure_count})")
    except Exception as exc:  # noqa: BLE001
        print(f"[PUSH_ERROR] Passenger credit push failed: {exc}")


# =====================================================================
# PASSENGER CREDIT MANAGEMENT ENDPOINTS
# =====================================================================

@router.get("/passengers")
def admin_list_passengers_wallets(
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """List passengers with materialized wallet balance and transaction summary."""
    db = get_firestore()

    # Query passengers from users collection
    query = db.collection("users").where("role", "==", "passenger")
    docs = list(query.stream())

    results = []
    search_term = (search or "").lower().strip()

    for doc in docs:
        u_data = doc.to_dict() or {}
        uid = doc.id
        name = u_data.get("name", "Passenger")
        phone = u_data.get("phone", "")
        email = u_data.get("email", "")

        if search_term:
            if search_term not in name.lower() and search_term not in phone and search_term not in uid and search_term not in email.lower():
                continue

        wallet_snap = db.collection("wallets").document(uid).get()
        balance_paise = 0
        lifetime_credit_paise = 0
        lifetime_debit_paise = 0
        if wallet_snap.exists:
            w_data = wallet_snap.to_dict() or {}
            balance_paise = int(w_data.get("balancePaise") or 0)
            lifetime_credit_paise = int(w_data.get("lifetimeCreditPaise") or 0)
            lifetime_debit_paise = int(w_data.get("lifetimeDebitPaise") or 0)

        created_at = u_data.get("createdAt")
        created_at_str = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at or "")

        results.append(
            {
                "userId": uid,
                "passengerId": uid,
                "name": name,
                "phone": phone,
                "email": email,
                "balancePaise": balance_paise,
                "balance": paise_to_inr_float(balance_paise),
                "lifetimeCreditPaise": lifetime_credit_paise,
                "lifetimeCredit": paise_to_inr_float(lifetime_credit_paise),
                "lifetimeDebitPaise": lifetime_debit_paise,
                "lifetimeDebit": paise_to_inr_float(lifetime_debit_paise),
                "createdAt": created_at_str,
            }
        )

    results.sort(key=lambda x: x["balancePaise"], reverse=True)
    return {"ok": True, "passengers": results[:limit], "totalCount": len(results)}


@router.get("/user/{uid}/transactions")
@router.get("/passenger/{uid}/transactions")
def admin_get_passenger_transactions(
    uid: str,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Retrieve full transaction ledger for a specific passenger."""
    db = get_firestore()
    docs = list(db.collection("walletTransactions").where("userId", "==", uid).stream())

    txs = []
    for d in docs:
        data = d.to_dict() or {}
        created_at = data.get("createdAt")
        created_at_str = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at or "")
        amount_paise = int(data.get("amountPaise") or 0)
        is_credit = data.get("direction") == "credit"
        is_reversed = bool(data.get("isReversed", False))
        is_reversible = is_credit and (amount_paise > 100000) and not is_reversed

        txs.append(
            {
                "transactionId": data.get("transactionId"),
                "transactionType": data.get("type"),
                "type": data.get("type"),
                "direction": data.get("direction"),
                "amountPaise": amount_paise,
                "amount": paise_to_inr_float(amount_paise),
                "balanceBeforePaise": int(data.get("balanceBeforePaise") or 0),
                "balanceBefore": paise_to_inr_float(int(data.get("balanceBeforePaise") or 0)),
                "balanceAfterPaise": int(data.get("balanceAfterPaise") or 0),
                "balanceAfter": paise_to_inr_float(int(data.get("balanceAfterPaise") or 0)),
                "status": data.get("status"),
                "description": data.get("description"),
                "tags": data.get("tags") or [],
                "createdBy": data.get("createdBy"),
                "isReversible": is_reversible,
                "isReversed": is_reversed,
                "reversedTransactionId": data.get("reversedTransactionId"),
                "reversalReason": data.get("reversalReason"),
                "createdAt": created_at_str,
            }
        )

    txs.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
    return {"ok": True, "transactions": txs}


@router.post("/passenger/grant-credit")
@router.post("/passenger-credit")
def admin_grant_credit(
    body: GrantPassengerCreditRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Grant promotional/bonus wallet credits to a passenger."""
    db = get_firestore()

    # Determine amount in integer paise
    if body.amountPaise is not None and body.amountPaise > 0:
        amount_paise = int(body.amountPaise)
    elif body.amount is not None and body.amount > 0:
        amount_paise = inr_to_paise(body.amount)
    else:
        raise ApiError("Valid credit amount is required.", 400)

    # Clean tags
    clean_tags = [t.strip() for t in body.tags if t and t.strip()]
    if not clean_tags:
        raise ApiError("At least one tag must be selected (e.g. 'Refund', 'Changes settlement', 'Conflict settlement', 'Bonus').", 400)

    result = grant_passenger_credit(
        db=db,
        passenger_id=body.passengerId,
        amount_paise=amount_paise,
        tags=clean_tags,
        description=body.description or "Promotional credit",
        admin_user=admin_user,
    )

    # Dispatches background push notification
    tag_label = clean_tags[0] if clean_tags else "bonus"
    _send_passenger_credit_push(
        passenger_id=body.passengerId,
        amount_inr=paise_to_inr_float(amount_paise),
        tag_label=tag_label,
    )

    return {
        "ok": True,
        "message": f"Successfully granted ₹{paise_to_inr_float(amount_paise):g} credits to passenger.",
        "transaction": result,
    }


@router.post("/passenger/reverse-credit")
@router.post("/credit-reversal")
def admin_reverse_credit(
    body: ReverseCreditRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Reverses an admin-issued credit strictly > ₹1,000 (100,000 paise).
    Enforces that passenger has sufficient available balance without becoming negative.
    """
    db = get_firestore()
    result = reverse_admin_credit(
        db=db,
        original_tx_id=body.transactionId,
        admin_user=admin_user,
        reason=body.reason,
    )

    return {
        "ok": True,
        "message": "Credit reversal completed successfully.",
        "result": result,
    }


# =====================================================================
# DRIVER SETTLEMENT MANAGEMENT ENDPOINTS
# =====================================================================

@router.get("/driver/settlements-summary")
@router.get("/driver-settlements")
def admin_list_driver_settlements(
    status_filter: Optional[str] = Query(None, alias="status"),
    search: Optional[str] = Query(None),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """List drivers with available wallet balances, UPI snapshot, and settlement status."""
    db = get_firestore()

    drivers = list(db.collection("users").where("role", "==", "driver").stream())
    cfg_snap = db.collection("systemSettings").document("driverSettlementConfig").get()
    next_date = (cfg_snap.to_dict() or {}).get("nextSettlementDate") if cfg_snap.exists else None

    results = []
    search_term = (search or "").lower().strip()

    for d_doc in drivers:
        d_data = d_doc.to_dict() or {}
        driver_id = d_doc.id
        name = d_data.get("name", "Driver")
        phone = d_data.get("phone", "")
        raw_upi = d_data.get("upiId", "")

        if search_term:
            if search_term not in name.lower() and search_term not in phone and search_term not in driver_id and search_term not in raw_upi.lower():
                continue

        # Driver wallet
        wallet_snap = db.collection("wallets").document(driver_id).get()
        balance_paise = 0
        lifetime_credit_paise = 0
        if wallet_snap.exists:
            w_data = wallet_snap.to_dict() or {}
            balance_paise = int(w_data.get("balancePaise") or 0)
            lifetime_credit_paise = int(w_data.get("lifetimeCreditPaise") or 0)

        # Check active or last settlement
        settlements = list(
            db.collection("driverSettlements")
            .where("driverId", "==", driver_id)
            .stream()
        )
        settlements.sort(key=lambda x: str((x.to_dict() or {}).get("createdAt") or ""), reverse=True)

        active_settlement = None
        last_settlement = None
        for s in settlements:
            s_dict = s.to_dict() or {}
            if s_dict.get("status") in ["ready", "processing"] and not active_settlement:
                active_settlement = s_dict
            if s_dict.get("status") == "resolved" and not last_settlement:
                last_settlement = s_dict

        if active_settlement:
            settlement_status = active_settlement.get("status")
            if "settlementAmount" not in active_settlement:
                active_settlement["settlementAmount"] = paise_to_inr_float(int(active_settlement.get("settlementAmountPaise") or 0))
        elif balance_paise > 0:
            settlement_status = "ready"
        else:
            settlement_status = "ongoing"

        if status_filter and settlement_status != status_filter:
            continue

        results.append(
            {
                "driverId": driver_id,
                "userId": driver_id,
                "name": name,
                "phone": phone,
                "upiId": raw_upi,
                "maskedUpiId": _mask_upi(raw_upi),
                "balancePaise": balance_paise,
                "balance": paise_to_inr_float(balance_paise),
                "lifetimeCreditPaise": lifetime_credit_paise,
                "lifetimeCredit": paise_to_inr_float(lifetime_credit_paise),
                "settlementStatus": settlement_status,
                "activeSettlement": active_settlement,
                "lastSettlementAmountPaise": int(last_settlement.get("settlementAmountPaise") or 0) if last_settlement else 0,
                "lastSettlementAmount": paise_to_inr_float(int(last_settlement.get("settlementAmountPaise") or 0)) if last_settlement else 0,
                "lastSettlementDate": (last_settlement.get("settlementDate") if last_settlement else None),
                "nextSettlementDate": next_date or "To be scheduled",
            }
        )

    results.sort(key=lambda x: x["balancePaise"], reverse=True)
    return {"ok": True, "driverSettlements": results, "drivers": results}


@router.post("/driver/create-settlement")
@router.post("/driver-settlement/create")
def admin_create_driver_settlement(
    body: CreateSettlementRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Atomically create a driver settlement capturing current balance and UPI ID."""
    db = get_firestore()
    settlement = create_driver_settlement(
        db=db,
        driver_id=body.driverId,
        admin_user=admin_user,
        custom_settlement_date=body.settlementDate,
    )
    return {
        "ok": True,
        "message": f"Settlement created for ₹{settlement.get('settlementAmount'):g}. Proceed with manual UPI payment.",
        "settlement": settlement,
    }


@router.post("/driver/resolve-settlement")
@router.post("/driver-settlement/resolve")
@router.post("/driver-settlement/{settlement_id}/resolve")
def admin_resolve_settlement(
    body: ResolveSettlementRequest = Body(...),
    settlement_id: Optional[str] = None,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Atomically resolves a driver settlement.
    If driverId is provided, resolves the entire available wallet balance.
    If settlementId is provided, resolves that specific settlement.
    """
    driver_id = body.driverId
    target_id = settlement_id or body.settlementId
    db = get_firestore()

    if driver_id:
        result = resolve_driver_full_wallet_balance(
            db=db,
            driver_id=driver_id,
            admin_user=admin_user,
            admin_note=body.adminNote,
        )
    elif target_id:
        result = resolve_driver_settlement(
            db=db,
            settlement_id=target_id,
            admin_user=admin_user,
            admin_note=body.adminNote,
        )
    else:
        raise ApiError("Either driverId or settlementId is required.", 400)

    # Dispatches background push notification to driver
    _send_settlement_resolved_push(
        driver_id=result["driverId"],
        amount_inr=result["settledAmount"],
        upi_id=result.get("upiIdSnapshot", ""),
    )

    return {
        "ok": True,
        "message": f"Settlement marked as resolved. ₹{result['settledAmount']:g} transferred and deducted from driver wallet.",
        "result": result,
        "settlement": result,
    }


@router.get("/driver/settlement-config")
@router.get("/settlement-config")
def admin_get_settlement_config(admin_user: Dict[str, Any] = Depends(require_admin)) -> Dict[str, Any]:
    """Retrieve global next scheduled driver settlement date."""
    db = get_firestore()
    cfg_snap = db.collection("systemSettings").document("driverSettlementConfig").get()
    cfg_data = (cfg_snap.to_dict() or {}) if cfg_snap.exists else {}
    next_date = cfg_data.get("nextSettlementDate")
    return {
        "ok": True,
        "nextSettlementDate": next_date,
        "config": cfg_data,
    }


@router.post("/driver/settlement-config")
@router.post("/settlement-config")
def admin_update_settlement_config(
    body: UpdateSettlementConfigRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Configure or update the global next scheduled driver settlement date."""
    db = get_firestore()
    admin_email = admin_user.get("email", "admin@liphtup.in")
    clean_date = body.nextSettlementDate.strip()

    doc_ref = db.collection("systemSettings").document("driverSettlementConfig")
    doc_ref.set({
        "nextSettlementDate": clean_date,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedByAdminEmail": admin_email,
        "updatedByAdminUid": admin_user.get("uid"),
    }, merge=True)

    write_audit_log(
        admin_user=admin_user,
        action="driver_settlement_config_updated",
        target_type="systemSettings",
        target_id="driverSettlementConfig",
        after={"nextSettlementDate": clean_date, "updatedByAdminEmail": admin_email},
    )

    return {
        "ok": True,
        "message": "Driver settlement schedule updated successfully.",
        "config": {
            "nextSettlementDate": clean_date,
            "updatedByAdminEmail": admin_email,
            "updatedByAdminUid": admin_user.get("uid"),
        },
        "nextSettlementDate": clean_date,
    }


@router.get("/reconcile/{user_id}")
def admin_reconcile_wallet(
    user_id: str,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Runs a ledger-vs-materialized balance reconciliation for audit purposes."""
    db = get_firestore()
    report = reconcile_wallet(db, user_id)
    return {"ok": True, "report": report, "reconciliationReport": report}
