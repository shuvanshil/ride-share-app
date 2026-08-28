"""
Core Wallet Service for LiphtUp.

Provides authoritative, ledger-based, integer-paise wallet operations across
passenger credits, active ride transfers, admin credit grants/reversals, and
manual driver UPI settlements.
"""
from __future__ import annotations

import decimal
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from firebase_admin import firestore as fb_firestore

from .admin import write_audit_log
from .errors import ApiError


REVERSAL_MIN_THRESHOLD_PAISE = 100000  # Strictly > 100,000 paise (i.e. > ₹1,000.00)


def inr_to_paise(val: Any) -> int:
    """Safely converts an INR amount (int, float, or str) to integer paise without float errors."""
    if val is None:
        return 0
    if isinstance(val, int):
        return val * 100
    s = str(val).strip().replace(",", "")
    if not s:
        return 0
    try:
        d = decimal.Decimal(s)
        # Multiply by 100 and quantize to integer paise
        paise_dec = (d * decimal.Decimal("100")).quantize(decimal.Decimal("1"), rounding=decimal.ROUND_HALF_UP)
        return int(paise_dec)
    except Exception as exc:
        raise ApiError(f"Invalid monetary value: {val}", 400) from exc


def paise_to_inr_float(paise: int) -> float:
    """Converts integer paise to INR float for display formatting."""
    return round(paise / 100.0, 2)


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_dict_for_json(data: Any) -> Any:
    """Recursively replaces Firestore Sentinels and datetime objects with ISO strings so dicts are safely JSON-serializable."""
    if isinstance(data, dict):
        cleaned = {}
        for k, v in data.items():
            if hasattr(v, "__class__") and "Sentinel" in v.__class__.__name__:
                cleaned[k] = datetime.now(timezone.utc).isoformat()
            elif isinstance(v, (dict, list)):
                cleaned[k] = sanitize_dict_for_json(v)
            elif hasattr(v, "isoformat"):
                cleaned[k] = v.isoformat()
            else:
                cleaned[k] = v
        return cleaned
    elif isinstance(data, list):
        return [sanitize_dict_for_json(item) for item in data]
    elif hasattr(data, "__class__") and "Sentinel" in data.__class__.__name__:
        return datetime.now(timezone.utc).isoformat()
    elif hasattr(data, "isoformat"):
        return data.isoformat()
    return data


def get_wallet_ref(db: Any, user_id: str):
    return db.collection("wallets").document(user_id)


def get_or_create_wallet_tx(tx: Any, db: Any, user_id: str, role: str) -> Dict[str, Any]:
    """Retrieves or initializes a wallet document inside a transaction."""
    ref = get_wallet_ref(db, user_id)
    snap = ref.get(transaction=tx)
    if snap.exists:
        data = snap.to_dict() or {}
        # Ensure integer paise fields exist
        if "balancePaise" not in data:
            data["balancePaise"] = int(data.get("balance", 0) * 100)
            data["lifetimeCreditPaise"] = int(data.get("lifetimeCredits", 0) * 100)
            data["lifetimeDebitPaise"] = int(data.get("lifetimeDebits", 0) * 100)
            tx.set(ref, data, merge=True)
        return data

    new_wallet = {
        "userId": user_id,
        "userRole": role,
        "balancePaise": 0,
        "currency": "INR",
        "status": "active",
        "lifetimeCreditPaise": 0,
        "lifetimeDebitPaise": 0,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }
    tx.set(ref, new_wallet)
    return new_wallet


def credit_wallet_tx(
    tx: Any,
    db: Any,
    user_id: str,
    role: str,
    amount_paise: int,
    tx_type: str,
    reference_type: str,
    reference_id: str,
    tags: Optional[List[str]] = None,
    description: str = "",
    created_by: str = "system",
    idempotency_key: Optional[str] = None,
    ride_id: Optional[str] = None,
    counterparty_user_id: Optional[str] = None,
    counterparty_name: Optional[str] = None,
) -> Tuple[Dict[str, Any], str]:
    """Credits a user's wallet atomically inside a Firestore transaction."""
    if not isinstance(amount_paise, int) or amount_paise <= 0:
        raise ApiError("Credit amount in paise must be a positive integer.", 400)

    wallet = get_or_create_wallet_tx(tx, db, user_id, role)
    if wallet.get("status") == "suspended":
        raise ApiError("Wallet is suspended.", 403)

    balance_before = int(wallet.get("balancePaise", 0))
    balance_after = balance_before + amount_paise
    lifetime_credit = int(wallet.get("lifetimeCreditPaise", 0)) + amount_paise

    wallet_ref = get_wallet_ref(db, user_id)
    tx.update(
        wallet_ref,
        {
            "balancePaise": balance_after,
            "lifetimeCreditPaise": lifetime_credit,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        },
    )

    tx_id = f"wtx_{uuid.uuid4().hex[:16]}"
    tx_doc_ref = db.collection("walletTransactions").document(tx_id)
    tx_payload = {
        "transactionId": tx_id,
        "walletId": user_id,
        "userId": user_id,
        "userRole": role,
        "type": tx_type,
        "direction": "credit",
        "amountPaise": amount_paise,
        "balanceBeforePaise": balance_before,
        "balanceAfterPaise": balance_after,
        "status": "completed",
        "referenceType": reference_type,
        "referenceId": reference_id,
        "rideId": ride_id,
        "counterpartyUserId": counterparty_user_id,
        "counterpartyName": counterparty_name,
        "description": description,
        "tags": tags or [],
        "idempotencyKey": idempotency_key,
        "createdBy": created_by,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
        "completedAt": fb_firestore.SERVER_TIMESTAMP,
        "isReversed": False,
    }
    tx.set(tx_doc_ref, tx_payload)
    return tx_payload, tx_id


def debit_wallet_tx(
    tx: Any,
    db: Any,
    user_id: str,
    role: str,
    amount_paise: int,
    tx_type: str,
    reference_type: str,
    reference_id: str,
    description: str = "",
    created_by: str = "system",
    tags: Optional[List[str]] = None,
    idempotency_key: Optional[str] = None,
    ride_id: Optional[str] = None,
    counterparty_user_id: Optional[str] = None,
    counterparty_name: Optional[str] = None,
    reversed_transaction_id: Optional[str] = None,
    reversal_reason: Optional[str] = None,
) -> Tuple[Dict[str, Any], str]:
    """Debits a user's wallet atomically inside a Firestore transaction."""
    if not isinstance(amount_paise, int) or amount_paise <= 0:
        raise ApiError("Debit amount in paise must be a positive integer.", 400)

    wallet = get_or_create_wallet_tx(tx, db, user_id, role)
    if wallet.get("status") == "suspended":
        raise ApiError("Wallet is suspended.", 403)

    balance_before = int(wallet.get("balancePaise", 0))
    if balance_before < amount_paise:
        raise ApiError("Insufficient wallet balance.", 400)

    balance_after = balance_before - amount_paise
    lifetime_debit = int(wallet.get("lifetimeDebitPaise", 0)) + amount_paise

    wallet_ref = get_wallet_ref(db, user_id)
    tx.update(
        wallet_ref,
        {
            "balancePaise": balance_after,
            "lifetimeDebitPaise": lifetime_debit,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        },
    )

    tx_id = f"wtx_{uuid.uuid4().hex[:16]}"
    tx_doc_ref = db.collection("walletTransactions").document(tx_id)
    tx_payload = {
        "transactionId": tx_id,
        "walletId": user_id,
        "userId": user_id,
        "userRole": role,
        "type": tx_type,
        "direction": "debit",
        "amountPaise": amount_paise,
        "balanceBeforePaise": balance_before,
        "balanceAfterPaise": balance_after,
        "status": "completed",
        "referenceType": reference_type,
        "referenceId": reference_id,
        "rideId": ride_id,
        "counterpartyUserId": counterparty_user_id,
        "counterpartyName": counterparty_name,
        "description": description,
        "tags": tags or [],
        "idempotencyKey": idempotency_key,
        "createdBy": created_by,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
        "completedAt": fb_firestore.SERVER_TIMESTAMP,
        "reversedTransactionId": reversed_transaction_id,
        "reversalReason": reversal_reason,
    }
    tx.set(tx_doc_ref, tx_payload)
    return tx_payload, tx_id


# =====================================================================
# Top-level transactional methods
# =====================================================================

def transfer_ride_fare(
    db: Any,
    passenger_id: str,
    ride_id: str,
    requested_amount_paise: Optional[int] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Executes an atomic passenger-to-driver ride wallet transfer.
    Ensures transaction-safe idempotency, authoritative fare calculation,
    and single-transaction 3-way balance & ride mutation.
    """
    clean_ride_id = str(ride_id).strip()[:160]
    clean_passenger_id = str(passenger_id).strip()
    idemp_key = (idempotency_key or f"rwp_{clean_ride_id}_{clean_passenger_id}").strip()[:160]

    ride_ref = db.collection("rides").document(clean_ride_id)
    idemp_ref = db.collection("rideWalletPayments").document(idemp_key)
    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def transfer_tx(tx):
        # 1. Transaction-safe idempotency check inside tx
        existing_payment_snap = idemp_ref.get(transaction=tx)
        if existing_payment_snap.exists:
            existing = existing_payment_snap.to_dict() or {}
            if existing.get("status") == "completed":
                result_holder["idempotent_replay"] = True
                result_holder["payment"] = existing
                return

        # 2. Authoritative Ride validation
        ride_snap = ride_ref.get(transaction=tx)
        if not ride_snap.exists:
            raise ApiError("Ride not found.", 404)
        ride = ride_snap.to_dict() or {}

        if str(ride.get("passenger_id") or "") != clean_passenger_id:
            raise ApiError("Only the passenger associated with this ride can pay using wallet.", 403)

        driver_id = str(ride.get("driver_id") or "").strip()
        if not driver_id:
            raise ApiError("No driver assigned to this ride yet.", 400)

        # Ride state verification
        ride_status = str(ride.get("status") or "").strip()
        # Allowed payable states: started, en_route (after PIN verification), or completed with remaining fare
        allowed_payable_statuses = {"started", "en_route", "completed"}
        if ride_status not in allowed_payable_statuses:
            raise ApiError(f"Ride in state '{ride_status}' is not eligible for wallet payment.", 400)

        # Calculate authoritative fare in integer paise
        fare_paise = int(ride.get("farePaise") or 0)
        if fare_paise <= 0:
            # Fallback legacy float normalization if needed
            fare_paise = inr_to_paise(ride.get("fare") or 0)

        if fare_paise <= 0:
            raise ApiError("Ride fare is zero or not finalized.", 400)

        # Calculate all existing payments
        wallet_paid_paise = int(ride.get("walletPaidAmountPaise") or 0)
        if wallet_paid_paise <= 0 and ride.get("wallet_paid_amount"):
            wallet_paid_paise = inr_to_paise(ride.get("wallet_paid_amount") or 0)

        cash_paid_paise = int(ride.get("cashPaidAmountPaise") or 0)
        if cash_paid_paise <= 0 and ride.get("cash_paid_amount"):
            cash_paid_paise = inr_to_paise(ride.get("cash_paid_amount") or 0)

        total_paid_paise = wallet_paid_paise + cash_paid_paise
        remaining_fare_paise = max(0, fare_paise - total_paid_paise)

        if remaining_fare_paise <= 0:
            raise ApiError("Ride fare is already fully paid.", 400)

        # 3. Passenger wallet balance check
        pass_wallet = get_or_create_wallet_tx(tx, db, clean_passenger_id, "passenger")
        pass_balance_paise = int(pass_wallet.get("balancePaise", 0))
        if pass_balance_paise <= 0:
            raise ApiError("Insufficient wallet balance.", 400)

        # Determine transfer amount (exact integer paise)
        max_possible_paise = min(pass_balance_paise, remaining_fare_paise)
        if requested_amount_paise is not None and requested_amount_paise > 0:
            if requested_amount_paise > max_possible_paise:
                transfer_paise = max_possible_paise
            else:
                transfer_paise = requested_amount_paise
        else:
            transfer_paise = max_possible_paise

        if transfer_paise <= 0:
            raise ApiError("Calculated wallet transfer amount is zero.", 400)

        # 4. Atomic 3-way mutation:
        # a) Debit Passenger
        pass_tx_payload, pass_tx_id = debit_wallet_tx(
            tx=tx,
            db=db,
            user_id=clean_passenger_id,
            role="passenger",
            amount_paise=transfer_paise,
            tx_type="RIDE_WALLET_PAYMENT",
            reference_type="ride_fare_payment",
            reference_id=clean_ride_id,
            description=f"Ride fare payment for Ride #{clean_ride_id[:8]}",
            created_by=clean_passenger_id,
            idempotency_key=idemp_key,
            ride_id=clean_ride_id,
            counterparty_user_id=driver_id,
            counterparty_name=ride.get("driver_name", "Driver"),
        )

        # b) Credit Driver
        drv_tx_payload, drv_tx_id = credit_wallet_tx(
            tx=tx,
            db=db,
            user_id=driver_id,
            role="driver",
            amount_paise=transfer_paise,
            tx_type="RIDE_WALLET_RECEIPT",
            reference_type="ride_fare_payment",
            reference_id=clean_ride_id,
            description=f"Ride fare received for Ride #{clean_ride_id[:8]}",
            created_by=clean_passenger_id,
            idempotency_key=idemp_key,
            ride_id=clean_ride_id,
            counterparty_user_id=clean_passenger_id,
            counterparty_name=ride.get("passenger_name", "Passenger"),
        )

        # c) Update Ride document
        new_wallet_paid_paise = wallet_paid_paise + transfer_paise
        new_remaining_paise = max(0, fare_paise - (new_wallet_paid_paise + cash_paid_paise))
        is_fully_paid = new_remaining_paise == 0

        ride_updates = {
            "farePaise": fare_paise,
            "walletPaidAmountPaise": new_wallet_paid_paise,
            "wallet_paid_amount": paise_to_inr_float(new_wallet_paid_paise),
            "remainingFarePaise": new_remaining_paise,
            "remaining_fare": paise_to_inr_float(new_remaining_paise),
            "wallet_payment_status": "paid" if is_fully_paid else "partially_paid",
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        if is_fully_paid:
            ride_updates["payment_status"] = "paid"
            ride_updates["paymentConfirmedAt"] = fb_firestore.SERVER_TIMESTAMP

        tx.update(ride_ref, ride_updates)

        # d) Persist dedicated RideWalletPayment record
        rwp_payload = {
            "paymentId": idemp_key,
            "rideId": clean_ride_id,
            "passengerId": clean_passenger_id,
            "driverId": driver_id,
            "amountPaise": transfer_paise,
            "amount": paise_to_inr_float(transfer_paise),
            "passengerTransactionId": pass_tx_id,
            "driverTransactionId": drv_tx_id,
            "status": "completed",
            "idempotencyKey": idemp_key,
            "farePaise": fare_paise,
            "remainingFarePaise": new_remaining_paise,
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
            "completedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.set(idemp_ref, rwp_payload)

        result_holder["idempotent_replay"] = False
        result_holder["transferPaise"] = transfer_paise
        result_holder["transferAmount"] = paise_to_inr_float(transfer_paise)
        result_holder["remainingFarePaise"] = new_remaining_paise
        result_holder["remainingFare"] = paise_to_inr_float(new_remaining_paise)
        result_holder["passengerBalancePaise"] = pass_tx_payload["balanceAfterPaise"]
        result_holder["passengerBalance"] = paise_to_inr_float(pass_tx_payload["balanceAfterPaise"])
        result_holder["driverId"] = driver_id
        result_holder["passengerId"] = clean_passenger_id
        result_holder["rideId"] = clean_ride_id
        result_holder["payment"] = rwp_payload

    # Run transaction
    transaction = db.transaction()
    transfer_tx(transaction)

    return sanitize_dict_for_json(result_holder)


def create_driver_settlement(
    db: Any,
    driver_id: str,
    admin_user: Dict[str, Any],
    custom_settlement_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Atomically creates a driver settlement record, capturing the driver's current
    wallet balance and registered UPI snapshot. Rejects if an active settlement already exists.
    """
    clean_driver_id = str(driver_id).strip()
    admin_uid = admin_user.get("uid", "admin")
    admin_email = admin_user.get("email", "admin@liphtup.in")

    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def create_tx(tx):
        # 1. Verify driver profile & UPI
        user_ref = db.collection("users").document(clean_driver_id)
        user_snap = user_ref.get(transaction=tx)
        if not user_snap.exists:
            raise ApiError("Driver user record not found.", 404)
        user_data = user_snap.to_dict() or {}
        if user_data.get("role") != "driver":
            raise ApiError("User is not a driver.", 400)

        upi_id = (user_data.get("upiId") or "").strip()
        if not upi_id:
            raise ApiError("Driver does not have a registered UPI ID on file.", 400)

        # 2. Verify driver wallet & balance
        wallet = get_or_create_wallet_tx(tx, db, clean_driver_id, "driver")
        current_balance_paise = int(wallet.get("balancePaise", 0))
        if current_balance_paise <= 0:
            raise ApiError("Driver wallet has no balance to settle.", 400)

        # 3. Check for existing active (ready or processing) settlement
        existing_active = list(
            db.collection("driverSettlements")
            .where("driverId", "==", clean_driver_id)
            .where("status", "in", ["ready", "processing"])
            .stream()
        )
        if existing_active:
            raise ApiError("Driver already has an active unresolved settlement.", 409)

        # 4. Get default or configured next settlement date
        settlement_date = custom_settlement_date
        if not settlement_date:
            cfg_snap = db.collection("systemSettings").document("driverSettlementConfig").get(transaction=tx)
            if cfg_snap.exists:
                settlement_date = (cfg_snap.to_dict() or {}).get("nextSettlementDate")
        if not settlement_date:
            settlement_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        settlement_id = f"stl_{clean_driver_id}_{int(datetime.now(timezone.utc).timestamp())}"
        settlement_ref = db.collection("driverSettlements").document(settlement_id)

        settlement_payload = {
            "settlementId": settlement_id,
            "driverId": clean_driver_id,
            "driverNameSnapshot": user_data.get("name", "Driver"),
            "driverPhoneSnapshot": user_data.get("phone", ""),
            "walletId": clean_driver_id,
            "settlementAmountPaise": current_balance_paise,
            "settlementAmount": paise_to_inr_float(current_balance_paise),
            "walletBalanceAtCreationPaise": current_balance_paise,
            "status": "ready",
            "upiIdSnapshot": upi_id,
            "settlementDate": settlement_date,
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
            "createdByAdminUid": admin_uid,
            "createdByAdminEmail": admin_email,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.set(settlement_ref, settlement_payload)
        result_holder["settlement"] = settlement_payload

    transaction = db.transaction()
    create_tx(transaction)

    write_audit_log(
        admin_user=admin_user,
        action="driver_settlement_created",
        target_type="driverSettlements",
        target_id=result_holder["settlement"]["settlementId"],
        after=result_holder["settlement"],
    )

    return sanitize_dict_for_json(result_holder["settlement"])


def resolve_driver_settlement(
    db: Any,
    settlement_id: str,
    admin_user: Dict[str, Any],
    admin_note: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Atomically resolves a driver settlement by deducting EXACTLY the captured settlement amount
    from the driver's wallet. Any newer ride credits received after settlement creation remain safe.
    """
    clean_stl_id = str(settlement_id).strip()
    admin_uid = admin_user.get("uid", "admin")
    admin_email = admin_user.get("email", "admin@liphtup.in")

    settlement_ref = db.collection("driverSettlements").document(clean_stl_id)
    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def resolve_tx(tx):
        snap = settlement_ref.get(transaction=tx)
        if not snap.exists:
            raise ApiError("Settlement record not found.", 404)
        stl = snap.to_dict() or {}

        current_status = stl.get("status")
        if current_status == "resolved":
            raise ApiError("This settlement has already been resolved and paid.", 409)
        if current_status not in ["ready", "processing"]:
            raise ApiError(f"Settlement cannot be resolved from status '{current_status}'.", 400)

        driver_id = stl.get("driverId")
        settlement_amount_paise = int(stl.get("settlementAmountPaise") or 0)
        if settlement_amount_paise <= 0:
            raise ApiError("Settlement amount is invalid.", 400)

        # Debit EXACT captured settlement amount
        tx_payload, tx_id = debit_wallet_tx(
            tx=tx,
            db=db,
            user_id=driver_id,
            role="driver",
            amount_paise=settlement_amount_paise,
            tx_type="DRIVER_SETTLEMENT",
            reference_type="driver_settlement",
            reference_id=clean_stl_id,
            description=f"Manual UPI settlement paid to {stl.get('upiIdSnapshot')}",
            created_by=admin_email,
        )

        updates = {
            "status": "resolved",
            "resolvedAt": fb_firestore.SERVER_TIMESTAMP,
            "resolvedByAdminUid": admin_uid,
            "resolvedByAdminEmail": admin_email,
            "walletTransactionId": tx_id,
            "adminNote": (admin_note or "").strip()[:500],
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.update(settlement_ref, updates)

        result_holder["settlementId"] = clean_stl_id
        result_holder["driverId"] = driver_id
        result_holder["settledAmountPaise"] = settlement_amount_paise
        result_holder["settledAmount"] = paise_to_inr_float(settlement_amount_paise)
        result_holder["remainingDriverBalancePaise"] = tx_payload["balanceAfterPaise"]
        result_holder["remainingDriverBalance"] = paise_to_inr_float(tx_payload["balanceAfterPaise"])
        result_holder["upiIdSnapshot"] = stl.get("upiIdSnapshot")
        result_holder["transactionId"] = tx_id

    transaction = db.transaction()
    resolve_tx(transaction)

    write_audit_log(
        admin_user=admin_user,
        action="driver_settlement_resolved",
        target_type="driverSettlements",
        target_id=clean_stl_id,
        after=result_holder,
    )

    return sanitize_dict_for_json(result_holder)


def grant_passenger_credit(
    db: Any,
    passenger_id: str,
    amount_paise: int,
    tags: List[str],
    description: str,
    admin_user: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Grants promotional/bonus credit to a passenger wallet.
    Requires at least one tag. Operates in integer paise.
    """
    clean_pass_id = str(passenger_id).strip()
    if not isinstance(amount_paise, int) or amount_paise <= 0:
        raise ApiError("Credit amount in paise must be a positive integer.", 400)
    if not tags or not any(str(t).strip() for t in tags):
        raise ApiError("At least one tag is required for admin wallet credit.", 400)

    admin_email = admin_user.get("email", "admin@liphtup.in")
    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def grant_tx(tx):
        user_ref = db.collection("users").document(clean_pass_id)
        user_snap = user_ref.get(transaction=tx)
        if not user_snap.exists:
            raise ApiError("Passenger account not found.", 404)
        user_data = user_snap.to_dict() or {}
        if user_data.get("role") != "passenger":
            raise ApiError("Wallet credits can only be granted to passenger accounts.", 400)

        grant_ref_id = f"adm_grant_{uuid.uuid4().hex[:12]}"
        tx_payload, tx_id = credit_wallet_tx(
            tx=tx,
            db=db,
            user_id=clean_pass_id,
            role="passenger",
            amount_paise=amount_paise,
            tx_type="ADMIN_CREDIT",
            reference_type="admin_grant",
            reference_id=grant_ref_id,
            tags=[str(t).strip() for t in tags if str(t).strip()],
            description=description.strip()[:300] or "Admin promotional wallet credit",
            created_by=admin_email,
        )
        result_holder["transaction"] = tx_payload

    transaction = db.transaction()
    grant_tx(transaction)

    write_audit_log(
        admin_user=admin_user,
        action="passenger_credit_granted",
        target_type="walletTransactions",
        target_id=result_holder["transaction"]["transactionId"],
        after=result_holder["transaction"],
    )

    return sanitize_dict_for_json(result_holder["transaction"])


def reverse_admin_credit(
    db: Any,
    original_tx_id: str,
    admin_user: Dict[str, Any],
    reason: str,
) -> Dict[str, Any]:
    """
    Reverses an admin-issued credit strictly > 100,000 paise (> ₹1,000.00).
    Requires full reversal and passenger available balance >= credit amount.
    """
    clean_tx_id = str(original_tx_id).strip()
    admin_email = admin_user.get("email", "admin@liphtup.in")
    clean_reason = str(reason).strip()[:300]
    if not clean_reason:
        raise ApiError("Reversal reason is required.", 400)

    orig_ref = db.collection("walletTransactions").document(clean_tx_id)
    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def reverse_tx(tx):
        snap = orig_ref.get(transaction=tx)
        if not snap.exists:
            raise ApiError("Original transaction record not found.", 404)
        orig_tx = snap.to_dict() or {}

        if orig_tx.get("type") != "ADMIN_CREDIT":
            raise ApiError("Only admin-issued credits can be reversed.", 400)
        if orig_tx.get("isReversed") is True:
            raise ApiError("This transaction has already been reversed.", 409)

        amount_paise = int(orig_tx.get("amountPaise") or 0)
        # Server-side enforcement of strictly > ₹1,000 (100,000 paise)
        if amount_paise <= REVERSAL_MIN_THRESHOLD_PAISE:
            raise ApiError(
                f"Credits of ₹1,000 or less ({amount_paise} paise) cannot be reversed through the administrative interface.",
                400,
            )

        passenger_id = orig_tx.get("userId")
        pass_wallet = get_or_create_wallet_tx(tx, db, passenger_id, "passenger")
        current_balance = int(pass_wallet.get("balancePaise", 0))

        if current_balance < amount_paise:
            raise ApiError(
                f"Cannot reverse: passenger current balance (₹{paise_to_inr_float(current_balance)}) is less than the reversal amount (₹{paise_to_inr_float(amount_paise)}). Negative balances are not permitted.",
                400,
            )

        # Create reversal debit ledger entry
        rev_tx_payload, rev_tx_id = debit_wallet_tx(
            tx=tx,
            db=db,
            user_id=passenger_id,
            role="passenger",
            amount_paise=amount_paise,
            tx_type="CREDIT_REVERSAL",
            reference_type="admin_reversal",
            reference_id=clean_tx_id,
            description=f"Reversal of Transaction #{clean_tx_id[:8]}: {clean_reason}",
            created_by=admin_email,
            reversed_transaction_id=clean_tx_id,
            reversal_reason=clean_reason,
        )

        # Mark original transaction as reversed (immutability preserved; historical record unchanged)
        tx.update(
            orig_ref,
            {
                "isReversed": True,
                "reversedTransactionId": rev_tx_id,
                "reversalReason": clean_reason,
                "reversedAt": fb_firestore.SERVER_TIMESTAMP,
            },
        )

        result_holder["reversalTransaction"] = rev_tx_payload
        result_holder["originalTransactionId"] = clean_tx_id

    transaction = db.transaction()
    reverse_tx(transaction)

    write_audit_log(
        admin_user=admin_user,
        action="passenger_credit_reversed",
        target_type="walletTransactions",
        target_id=result_holder["reversalTransaction"]["transactionId"],
        after=result_holder,
    )

    return sanitize_dict_for_json(result_holder)


def reconcile_wallet(db: Any, user_id: str) -> Dict[str, Any]:
    """
    Audit and reconciliation tool. Computes net completed ledger balance
    from `walletTransactions` and compares it to `wallets.balancePaise`.
    """
    clean_uid = str(user_id).strip()
    wallet_snap = db.collection("wallets").document(clean_uid).get()
    materialized_balance_paise = 0
    if wallet_snap.exists:
        materialized_balance_paise = int((wallet_snap.to_dict() or {}).get("balancePaise", 0))

    tx_docs = list(
        db.collection("walletTransactions")
        .where("userId", "==", clean_uid)
        .where("status", "==", "completed")
        .stream()
    )

    computed_credits_paise = 0
    computed_debits_paise = 0
    for doc in tx_docs:
        d = doc.to_dict() or {}
        amt = int(d.get("amountPaise") or 0)
        direction = d.get("direction")
        if direction == "credit":
            computed_credits_paise += amt
        elif direction == "debit":
            computed_debits_paise += amt

    expected_balance_paise = computed_credits_paise - computed_debits_paise
    is_balanced = (expected_balance_paise == materialized_balance_paise)

    return sanitize_dict_for_json({
        "userId": clean_uid,
        "materializedBalancePaise": materialized_balance_paise,
        "materializedBalance": paise_to_inr_float(materialized_balance_paise),
        "computedCreditsPaise": computed_credits_paise,
        "computedCredits": paise_to_inr_float(computed_credits_paise),
        "computedDebitsPaise": computed_debits_paise,
        "computedDebits": paise_to_inr_float(computed_debits_paise),
        "expectedBalancePaise": expected_balance_paise,
        "expectedBalance": paise_to_inr_float(expected_balance_paise),
        "computedBalancePaise": expected_balance_paise,
        "computedBalance": paise_to_inr_float(expected_balance_paise),
        "isBalanced": is_balanced,
        "discrepancyPaise": materialized_balance_paise - expected_balance_paise,
        "discrepancy": paise_to_inr_float(materialized_balance_paise - expected_balance_paise),
        "transactionCount": len(tx_docs),
        "totalTransactions": len(tx_docs),
        "reconciledAt": now_utc_iso(),
    })
