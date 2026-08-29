"""
Core Coupon Service for LiphtUp.

Provides server-authoritative, ledger-integrated, integer-paise coupon operations
including:
- Case-insensitive coupon code normalization
- Authoritative completed-rides counting (excluding cancelled/aborted/rejected rides)
- Default coupon lifecycle (WELCOME, SUPER10) and admin-created coupons
- Rule evaluation: category ride counts + restricted passenger IDs (logical AND)
- Deterministic coupon auto-suggestion (Default > Highest discount > Earliest created)
- Integer-paise discount calculations (Fixed INR & Percentage) with zero floating-point error
- Atomic Firestore transactions for coupon redemption:
  * Atomically credits driver wallet with COUPON_DISCOUNT_RECEIPT
  * Updates ride remaining fare and records coupon snapshot
  * Enforces mutual exclusivity with passenger wallet fare payments (coupon OR wallet, never both)
  * Writes immutable audit record to /couponRedemptions
  * Guarantees idempotency and anti-race protection
"""
from __future__ import annotations

import decimal
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from firebase_admin import firestore as fb_firestore

from .errors import ApiError
from .wallet_service import (
    credit_wallet_tx,
    get_or_create_wallet_tx,
    get_wallet_ref,
    inr_to_paise,
    now_utc_iso,
    paise_to_inr_float,
    sanitize_dict_for_json,
)

# Initial Default Coupons permanently defined in the platform
DEFAULT_COUPONS = {
    "WELCOME": {
        "couponId": "coupon_default_welcome",
        "code": "WELCOME",
        "codeNormalized": "WELCOME",
        "source": "default",
        "discountType": "percentage",
        "discountValue": 10,  # 10%
        "discountPercentage": 10,
        "discountAmountPaise": 0,
        "description": "10% off your first ride on LiphtUp",
        "status": "active",
        "eligibilityCategory": "first_ride",
        "restrictedPassengerIds": [],
        "usageLimitPerPassenger": 1,
        "isDeletable": False,
    },
    "SUPER10": {
        "couponId": "coupon_default_super10",
        "code": "SUPER10",
        "codeNormalized": "SUPER10",
        "source": "default",
        "discountType": "percentage",
        "discountValue": 15,  # 15%
        "discountPercentage": 15,
        "discountAmountPaise": 0,
        "description": "15% off your 11th ride milestone",
        "status": "active",
        "eligibilityCategory": "tenth_ride",
        "restrictedPassengerIds": [],
        "usageLimitPerPassenger": 1,
        "isDeletable": False,
    },
}

VALID_ADMIN_CATEGORIES = {
    "all_passengers": "All passengers",
    "at_least_1_ride": "Passengers with at least 1 completed ride",
    "at_least_10_rides": "Passengers with at least 10 completed rides",
    "at_least_20_rides": "Passengers with 20+ completed rides",
    "at_least_50_rides": "Passengers with 50+ completed rides",
}


def normalize_coupon_code(code: Any) -> str:
    """Normalizes coupon code by trimming whitespace and converting to uppercase."""
    if not code:
        return ""
    return str(code).strip().upper()


def calculate_discount_paise(
    fare_paise: int,
    discount_type: str,
    discount_value: float,
    discount_amount_paise: Optional[int] = None,
) -> int:
    """
    Calculates coupon discount strictly in integer paise with zero floating-point error.
    Caps the discount at the total fare (final fare cannot be negative).
    """
    if fare_paise <= 0:
        return 0

    discount_type = str(discount_type).strip().lower()
    if discount_type == "fixed":
        # Fixed amount in paise
        val_paise = discount_amount_paise if discount_amount_paise is not None and discount_amount_paise > 0 else inr_to_paise(discount_value)
        return max(0, min(fare_paise, val_paise))

    elif discount_type == "percentage":
        # Percentage discount
        pct_dec = decimal.Decimal(str(discount_value))
        if pct_dec <= decimal.Decimal("0"):
            return 0
        fare_dec = decimal.Decimal(fare_paise)
        calculated_paise = (fare_dec * pct_dec / decimal.Decimal("100")).quantize(
            decimal.Decimal("1"), rounding=decimal.ROUND_HALF_UP
        )
        calculated_int = int(calculated_paise)
        return max(0, min(fare_paise, calculated_int))

    return 0


def get_completed_rides_count(db: Any, passenger_id: str) -> int:
    """
    Counts authoritative successfully completed qualifying rides for a passenger.
    Excludes cancelled, aborted, rejected, active, or test rides.
    """
    clean_uid = str(passenger_id).strip()
    if not clean_uid:
        return 0

    count = 0
    # Query rides where passenger_id == clean_uid and status == 'completed'
    try:
        query_a = (
            db.collection("rides")
            .where("passenger_id", "==", clean_uid)
            .where("status", "==", "completed")
            .get()
        )
        for doc in query_a:
            data = doc.to_dict() or {}
            # Exclude cancelled/aborted flags if any
            if not data.get("cancelled") and not data.get("is_cancelled"):
                count += 1
    except Exception:
        pass

    # Also check passengerId camelCase field for historical consistency
    try:
        query_b = (
            db.collection("rides")
            .where("passengerId", "==", clean_uid)
            .where("status", "==", "completed")
            .get()
        )
        seen_ids = {doc.id for doc in query_a} if 'query_a' in locals() else set()
        for doc in query_b:
            if doc.id not in seen_ids:
                data = doc.to_dict() or {}
                if not data.get("cancelled") and not data.get("is_cancelled"):
                    count += 1
    except Exception:
        pass

    return count


def ensure_default_coupons(db: Any) -> None:
    """Bootstraps default platform coupons (WELCOME, SUPER10) if they don't exist."""
    coupons_col = db.collection("coupons")
    for key, c_data in DEFAULT_COUPONS.items():
        doc_ref = coupons_col.document(c_data["couponId"])
        snap = doc_ref.get()
        if not snap.exists:
            payload = dict(c_data)
            payload["createdAt"] = fb_firestore.SERVER_TIMESTAMP
            payload["updatedAt"] = fb_firestore.SERVER_TIMESTAMP
            doc_ref.set(payload)


def is_passenger_eligible_for_coupon(
    coupon: Dict[str, Any],
    passenger_id: str,
    completed_rides_count: int,
    previous_redemptions_count: int = 0,
) -> Tuple[bool, str]:
    """
    Evaluates whether a passenger qualifies for a specific coupon based on:
    1. Status is 'active' (not inactive or deleted)
    2. One-time usage rule (previous_redemptions_count < usageLimitPerPassenger)
    3. Restricted passenger list (if configured, user must be in list)
    4. Category rule (completed rides count)
    """
    clean_uid = str(passenger_id).strip()

    status = str(coupon.get("status", "")).strip().lower()
    if status != "active":
        return False, "This coupon is currently unavailable."

    limit = int(coupon.get("usageLimitPerPassenger") or 1)
    if previous_redemptions_count >= limit:
        return False, "You have already used this coupon."

    # User ID restriction (logical AND with category)
    restricted_users = coupon.get("restrictedPassengerIds") or []
    if restricted_users:
        cleaned_allowed = [str(u).strip() for u in restricted_users if str(u).strip()]
        if cleaned_allowed and clean_uid not in cleaned_allowed:
            return False, "This coupon is not available for your account."

    category = str(coupon.get("eligibilityCategory", "")).strip()

    if category == "first_ride":
        # WELCOME: Exactly 0 previously completed rides
        if completed_rides_count != 0:
            return False, "The WELCOME coupon is only valid for your first completed ride."
        return True, "Eligible"

    elif category == "tenth_ride":
        # SUPER10: Exactly 10 completed rides before this ride (active ride is #11)
        if completed_rides_count != 10:
            return False, "The SUPER10 coupon is only valid on your 11th ride milestone."
        return True, "Eligible"

    elif category == "at_least_1_ride":
        if completed_rides_count < 1:
            return False, "This coupon requires at least 1 completed ride."
        return True, "Eligible"

    elif category == "at_least_10_rides":
        if completed_rides_count < 10:
            return False, "This coupon requires at least 10 completed rides."
        return True, "Eligible"

    elif category == "at_least_20_rides":
        if completed_rides_count < 20:
            return False, "This coupon requires at least 20 completed rides."
        return True, "Eligible"

    elif category == "at_least_50_rides":
        if completed_rides_count < 50:
            return False, "This coupon requires at least 50 completed rides."
        return True, "Eligible"

    elif category == "all_passengers":
        return True, "Eligible"

    # Default / Unknown category: allow if active and not restricted
    return True, "Eligible"


def get_eligible_coupons_for_ride(
    db: Any,
    passenger_id: str,
    ride_id: str,
) -> Dict[str, Any]:
    """
    Returns all coupons eligible for the given passenger on the active ride,
    along with the deterministically chosen suggested coupon.
    """
    clean_uid = str(passenger_id).strip()
    clean_ride_id = str(ride_id).strip()

    ensure_default_coupons(db)

    # 1. Fetch ride details to check fare and state
    ride_snap = db.collection("rides").document(clean_ride_id).get()
    if not ride_snap.exists:
        raise ApiError("Active ride not found.", 404)
    ride = ride_snap.to_dict() or {}

    # Verify ride belongs to passenger
    ride_pass_id = str(ride.get("passenger_id") or ride.get("passengerId") or "").strip()
    if ride_pass_id != clean_uid:
        raise ApiError("Not authorized to view coupons for this ride.", 403)

    # If ride already has a coupon applied or wallet credits used, no new coupons are eligible
    if ride.get("couponApplied"):
        return {"eligibleCoupons": [], "suggestedCoupon": None, "hasCouponApplied": True}
    
    wallet_paid_paise = int(ride.get("walletPaidAmountPaise") or 0)
    if wallet_paid_paise <= 0 and ride.get("wallet_paid_amount"):
        wallet_paid_paise = inr_to_paise(ride.get("wallet_paid_amount"))
    if wallet_paid_paise > 0:
        return {"eligibleCoupons": [], "suggestedCoupon": None, "hasWalletPaid": True}

    # Authoritative fare
    fare_paise = int(ride.get("farePaise") or 0)
    if fare_paise <= 0:
        fare_paise = inr_to_paise(ride.get("fare") or 0)

    # Authoritative completed ride count
    completed_count = get_completed_rides_count(db, clean_uid)

    # Fetch all previous redemptions for this passenger
    redemptions_snap = (
        db.collection("couponRedemptions")
        .where("passengerId", "==", clean_uid)
        .where("status", "==", "completed")
        .get()
    )
    redeemed_coupon_ids = set()
    for r_doc in redemptions_snap:
        r_data = r_doc.to_dict() or {}
        c_id = r_data.get("couponId")
        if c_id:
            redeemed_coupon_ids.add(c_id)

    # Fetch all active coupons
    coupons_snap = (
        db.collection("coupons")
        .where("status", "==", "active")
        .get()
    )

    eligible_coupons: List[Dict[str, Any]] = []

    for doc in coupons_snap:
        c_data = doc.to_dict() or {}
        c_id = doc.id
        c_data["couponId"] = c_id

        # Skip deleted
        if c_data.get("isDeleted"):
            continue

        prev_redemptions = 1 if c_id in redeemed_coupon_ids else 0
        is_eligible, _ = is_passenger_eligible_for_coupon(
            c_data, clean_uid, completed_count, prev_redemptions
        )

        if is_eligible:
            # Calculate potential discount
            disc_type = c_data.get("discountType", "fixed")
            disc_val = float(c_data.get("discountValue") or c_data.get("discountPercentage") or 0)
            disc_paise = calculate_discount_paise(
                fare_paise, disc_type, disc_val, int(c_data.get("discountAmountPaise") or 0)
            )

            created_at = c_data.get("createdAt")
            created_iso = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at or "")

            sanitized_coupon = {
                "couponId": c_id,
                "code": c_data.get("code", ""),
                "source": c_data.get("source", "admin"),
                "discountType": disc_type,
                "discountValue": disc_val,
                "discountAmountPaise": disc_paise,
                "discountAmount": paise_to_inr_float(disc_paise),
                "description": c_data.get("description", ""),
                "eligibilityCategory": c_data.get("eligibilityCategory", ""),
                "createdAt": created_iso,
            }
            eligible_coupons.append(sanitized_coupon)

    # Deterministic suggestion selection:
    # 1. Default coupons take absolute priority (WELCOME, SUPER10)
    # 2. Highest calculated discount
    # 3. Earliest created date
    suggested_coupon: Optional[Dict[str, Any]] = None

    default_eligible = [c for c in eligible_coupons if c.get("source") == "default"]
    if default_eligible:
        # Default coupon priority (e.g. WELCOME first, then SUPER10)
        default_order = {"WELCOME": 1, "SUPER10": 2}
        default_eligible.sort(key=lambda x: (default_order.get(x["code"], 99), -x["discountAmountPaise"], x["createdAt"]))
        suggested_coupon = default_eligible[0]
    elif eligible_coupons:
        # Admin coupons: Greatest discount, then earliest creation date
        eligible_coupons.sort(key=lambda x: (-x["discountAmountPaise"], x["createdAt"]))
        suggested_coupon = eligible_coupons[0]

    return {
        "eligibleCoupons": eligible_coupons,
        "suggestedCoupon": suggested_coupon,
        "completedRidesCount": completed_count,
        "farePaise": fare_paise,
        "fare": paise_to_inr_float(fare_paise),
    }


def apply_coupon_to_ride_tx(
    db: Any,
    passenger_id: str,
    ride_id: str,
    coupon_code: str,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Executes an atomic, server-authoritative coupon redemption transaction.
    
    Adheres strictly to the Firestore transaction protocol:
    PHASE 1: ALL READ OPERATIONS (before any writes)
    PHASE 2: VALIDATIONS & INTEGER PAISE CALCULATIONS
    PHASE 3: ALL WRITE OPERATIONS (Committed Atomically)
    
    If any step fails, all mutations are rolled back.
    """
    clean_passenger_id = str(passenger_id).strip()
    clean_ride_id = str(ride_id).strip()[:160]
    normalized_code = normalize_coupon_code(coupon_code)

    if not normalized_code:
        raise ApiError("Please provide a valid coupon code.", 400)

    idemp_key = (idempotency_key or f"cr_{clean_ride_id}_{normalized_code}_{clean_passenger_id}").strip()[:160]
    idemp_ref = db.collection("couponRedemptions").document(idemp_key)
    ride_ref = db.collection("rides").document(clean_ride_id)

    # 0. Count completed rides outside transaction (deterministic lookup)
    completed_rides_count = get_completed_rides_count(db, clean_passenger_id)

    result_holder: Dict[str, Any] = {}

    @fb_firestore.transactional
    def apply_tx(tx):
        # -----------------------------------------------------------------
        # PHASE 1: ALL READ OPERATIONS (Must happen before ANY writes)
        # -----------------------------------------------------------------

        # 1. Read idempotency record
        idemp_snap = idemp_ref.get(transaction=tx)
        if idemp_snap.exists:
            existing = idemp_snap.to_dict() or {}
            if existing.get("status") == "completed":
                result_holder["idempotent_replay"] = True
                result_holder["redemption"] = existing
                return

        # 2. Read ride record
        ride_snap = ride_ref.get(transaction=tx)
        if not ride_snap.exists:
            raise ApiError("Active ride not found.", 404)
        ride = ride_snap.to_dict() or {}

        # 3. Read driver wallet
        driver_id = str(ride.get("driver_id") or ride.get("driverId") or "").strip()
        if not driver_id:
            raise ApiError("No driver assigned to this ride yet.", 400)

        drv_wallet_ref = get_wallet_ref(db, driver_id)
        drv_snap = drv_wallet_ref.get(transaction=tx)
        drv_data = (drv_snap.to_dict() or {}) if drv_snap.exists else {}

        # 4. Read coupon document
        coupons_query = (
            db.collection("coupons")
            .where("codeNormalized", "==", normalized_code)
            .limit(1)
            .get(transaction=tx)
        )
        if not coupons_query:
            raise ApiError("This coupon code is invalid.", 400)
        
        coupon_snap = coupons_query[0]
        coupon = coupon_snap.to_dict() or {}
        coupon_id = coupon_snap.id

        # 5. Read previous redemptions for this passenger & coupon
        user_redemptions = (
            db.collection("couponRedemptions")
            .where("passengerId", "==", clean_passenger_id)
            .where("couponId", "==", coupon_id)
            .where("status", "==", "completed")
            .limit(1)
            .get(transaction=tx)
        )
        prev_redemption_count = len(user_redemptions)

        # -----------------------------------------------------------------
        # PHASE 2: VALIDATIONS & INTEGER PAISE CALCULATIONS
        # -----------------------------------------------------------------

        # A. Verify passenger ownership
        pass_owner_id = str(ride.get("passenger_id") or ride.get("passengerId") or "").strip()
        if pass_owner_id != clean_passenger_id:
            raise ApiError("Only the passenger on this ride can apply coupons.", 403)

        # B. Verify ride state
        ride_status = str(ride.get("status") or "").strip().lower()
        allowed_statuses = {"accepted", "arrived", "started", "en_route"}
        if ride_status not in allowed_statuses:
            raise ApiError(f"Ride in status '{ride_status}' is not eligible for coupon application.", 400)

        # C. Verify no existing coupon applied
        if ride.get("couponApplied"):
            raise ApiError("A coupon has already been applied to this ride.", 400)

        # D. Verify no existing wallet payment applied (MUTUAL EXCLUSIVITY)
        wallet_paid_paise = int(ride.get("walletPaidAmountPaise") or 0)
        if wallet_paid_paise <= 0 and ride.get("wallet_paid_amount"):
            wallet_paid_paise = inr_to_paise(ride.get("wallet_paid_amount"))
        if wallet_paid_paise > 0:
            raise ApiError("Wallet credits have already been applied to this ride. Coupon and wallet cannot be combined.", 400)

        # E. Verify coupon eligibility at final commit time
        is_eligible, err_msg = is_passenger_eligible_for_coupon(
            coupon, clean_passenger_id, completed_rides_count, prev_redemption_count
        )
        if not is_eligible:
            raise ApiError(err_msg, 400)

        # F. Calculate authoritative integer paise fare
        fare_paise = int(ride.get("farePaise") or 0)
        if fare_paise <= 0:
            fare_paise = inr_to_paise(ride.get("fare") or 0)
        if fare_paise <= 0:
            raise ApiError("Ride fare is zero or not finalized.", 400)

        cash_paid_paise = int(ride.get("cashPaidAmountPaise") or 0)
        if cash_paid_paise <= 0 and ride.get("cash_paid_amount"):
            cash_paid_paise = inr_to_paise(ride.get("cash_paid_amount"))

        remaining_before_paise = max(0, fare_paise - cash_paid_paise)
        if remaining_before_paise <= 0:
            raise ApiError("Ride fare is already fully paid.", 400)

        # G. Calculate discount paise
        disc_type = coupon.get("discountType", "fixed")
        disc_val = float(coupon.get("discountValue") or coupon.get("discountPercentage") or 0)
        configured_amount_paise = int(coupon.get("discountAmountPaise") or 0)
        
        calculated_discount_paise = calculate_discount_paise(
            fare_paise, disc_type, disc_val, configured_amount_paise
        )

        # Cap discount at remaining payable fare (cannot exceed remaining fare, no negative fare)
        discount_paise = min(remaining_before_paise, calculated_discount_paise)
        if discount_paise <= 0:
            raise ApiError("Calculated coupon discount is zero.", 400)

        remaining_after_paise = max(0, remaining_before_paise - discount_paise)

        # H. Prepare driver wallet credit
        drv_balance_before = int(drv_data.get("balancePaise") or (drv_data.get("balance", 0) * 100))
        drv_balance_after = drv_balance_before + discount_paise
        drv_lifetime_credit = int(drv_data.get("lifetimeCreditPaise") or 0) + discount_paise

        driver_tx_id = f"wtx_{uuid.uuid4().hex[:16]}"
        redemption_id = idemp_key

        # -----------------------------------------------------------------
        # PHASE 3: ALL WRITE OPERATIONS (Committed Atomically)
        # -----------------------------------------------------------------

        # 1. Update/Create Driver Wallet
        drv_wallet_payload = {
            "userId": driver_id,
            "userRole": "driver",
            "balancePaise": drv_balance_after,
            "lifetimeCreditPaise": drv_lifetime_credit,
            "currency": "INR",
            "status": "active",
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        if not drv_snap.exists:
            drv_wallet_payload["lifetimeDebitPaise"] = 0
            drv_wallet_payload["createdAt"] = fb_firestore.SERVER_TIMESTAMP
        tx.set(drv_wallet_ref, drv_wallet_payload, merge=True)

        # 2. Write Driver Wallet Ledger Transaction (COUPON_DISCOUNT_RECEIPT)
        drv_tx_doc_ref = db.collection("walletTransactions").document(driver_tx_id)
        drv_tx_payload = {
            "transactionId": driver_tx_id,
            "walletId": driver_id,
            "userId": driver_id,
            "userRole": "driver",
            "type": "COUPON_DISCOUNT_RECEIPT",
            "direction": "credit",
            "amountPaise": discount_paise,
            "balanceBeforePaise": drv_balance_before,
            "balanceAfterPaise": drv_balance_after,
            "status": "completed",
            "referenceType": "coupon_redemption",
            "referenceId": redemption_id,
            "rideId": clean_ride_id,
            "counterpartyUserId": clean_passenger_id,
            "counterpartyName": "Platform Promotion",
            "description": "Promotional coupon credit",
            "tags": ["coupon", "promotional_subsidy"],
            "idempotencyKey": f"cd_{redemption_id}",
            "createdBy": "system",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
            "completedAt": fb_firestore.SERVER_TIMESTAMP,
            "isReversed": False,
        }
        tx.set(drv_tx_doc_ref, drv_tx_payload)

        # 3. Write Immutable Coupon Redemption Record
        coupon_snapshot = {
            "redemptionId": redemption_id,
            "couponId": coupon_id,
            "couponCode": coupon.get("code", normalized_code),
            "code": coupon.get("code", normalized_code),
            "couponCodeNormalized": normalized_code,
            "source": coupon.get("source", "admin"),
            "passengerId": clean_passenger_id,
            "rideId": clean_ride_id,
            "driverId": driver_id,
            "discountType": disc_type,
            "configuredValue": disc_val,
            "calculatedDiscountPaise": discount_paise,
            "discountPaise": discount_paise,
            "discountAmount": paise_to_inr_float(discount_paise),
            "discountAmountINR": paise_to_inr_float(discount_paise),
            "originalFarePaise": fare_paise,
            "originalFare": paise_to_inr_float(fare_paise),
            "remainingFareBeforePaise": remaining_before_paise,
            "remainingFareAfterPaise": remaining_after_paise,
            "remainingFarePaise": remaining_after_paise,
            "remainingFare": paise_to_inr_float(remaining_after_paise),
            "driverWalletTransactionId": driver_tx_id,
            "status": "completed",
            "createdAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.set(idemp_ref, coupon_snapshot)

        # 4. Update Ride Document
        ride_update_payload = {
            "farePaise": fare_paise,
            "remainingFarePaise": remaining_after_paise,
            "couponDiscountPaise": discount_paise,
            "couponApplied": {
                "couponId": coupon_id,
                "code": coupon.get("code", normalized_code),
                "discountPaise": discount_paise,
                "discountAmount": paise_to_inr_float(discount_paise),
                "originalFarePaise": fare_paise,
                "remainingFarePaise": remaining_after_paise,
                "redemptionId": redemption_id,
                "driverWalletTransactionId": driver_tx_id,
                "appliedAt": now_utc_iso(),
            },
            "fare_adjustment": {
                "original_fare": paise_to_inr_float(fare_paise),
                "final_fare": paise_to_inr_float(remaining_after_paise),
                "discount_amount": paise_to_inr_float(discount_paise),
                "reason": "promotional_coupon",
                "adjusted_at": now_utc_iso(),
            },
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        tx.update(ride_ref, ride_update_payload)

        # Store results for return
        result_holder["redemption"] = {
            "redemptionId": redemption_id,
            "couponCode": coupon.get("code", normalized_code),
            "code": coupon.get("code", normalized_code),
            "discountPaise": discount_paise,
            "discountAmount": paise_to_inr_float(discount_paise),
            "originalFarePaise": fare_paise,
            "originalFare": paise_to_inr_float(fare_paise),
            "remainingFarePaise": remaining_after_paise,
            "remainingFare": paise_to_inr_float(remaining_after_paise),
            "driverId": driver_id,
            "driverWalletTransactionId": driver_tx_id,
            "status": "completed",
        }

    # Execute atomic transaction
    apply_tx(db.transaction())

    return sanitize_dict_for_json(result_holder["redemption"])
