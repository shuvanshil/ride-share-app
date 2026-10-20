"""Daily Fee Engine for LiphtUp Phase 2.

Handles:
- Distance-based daily fees (₹1/km integer paise calculation)
- Deterministic driver fees generation (driverFees, driverFeeWeeks, feeState)
- Level-triggered adjustment reconciliations
- Restriction evaluations
- Payment batches and allocations
"""
from __future__ import annotations

import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from .errors import ApiError
from .service_day import (
    IST,
    service_date,
    service_date_str,
    day_close,
    day_start,
    is_service_day_closed,
    week_id,
    fee_due_at,
    calculate_paise_for_distance,
    paise_to_rupees_float,
    get_ist_now,
    _to_ist_datetime,
    _to_date,
)

COLLECTION_DRIVER_FEES = "driverFees"
COLLECTION_DRIVER_FEE_WEEKS = "driverFeeWeeks"
COLLECTION_FEE_STATE = "feeState"
COLLECTION_FEE_PAYMENT_BATCHES = "feePaymentBatches"
COLLECTION_FEE_REMINDERS = "feeReminders"
COLLECTION_DAILY_STATS = "driverDailyStats"


# ============================================================================
# PURE DOMAIN LOGIC
# ============================================================================

def fee_status(fee_paise: int, paid_paise: int, review_paise: int) -> str:
    """Derive status of a fee record.
    Returns: UNPAID | UNDER_REVIEW | PARTIAL | PAID
    """
    if fee_paise <= 0:
        return "PAID"
    if paid_paise >= fee_paise:
        return "PAID"
    if paid_paise > 0:
        return "PARTIAL"
    if review_paise >= fee_paise:
        return "UNDER_REVIEW"
    return "UNPAID"


def remaining_paise(fee_paise: int, paid_paise: int, review_paise: int) -> int:
    """Calculate actionable remaining paise on a fee (never negative).
    Amounts under review are excluded from remaining.
    """
    rem = fee_paise - paid_paise - review_paise
    return max(0, rem)


def evaluate_fee_restriction(
    fees: List[Dict[str, Any]],
    now: Optional[Union[datetime.datetime, str]] = None,
) -> Tuple[bool, int, str]:
    """Pure evaluation of driver restriction status.

    Returns:
        (is_restricted: bool, overdue_paise: int, reason: str)

    Rules:
    - Restricted iff the sum of remaining_paise over fees with due_at <= now is > 0.
    - Fees under review (review_paise) reduce remaining, so valid submissions awaiting review do not block.
    - Sunday-exception fee has due_at set to following Sunday, so during its week due_at <= now is False.
    """
    curr = _to_ist_datetime(now)
    overdue_paise = 0

    for f in fees:
        due_val = f.get("due_at")
        if not due_val:
            continue
        due_dt = _to_ist_datetime(due_val)
        if due_dt <= curr:
            f_paise = int(f.get("fee_paise") or 0)
            p_paise = int(f.get("paid_paise") or 0)
            r_paise = int(f.get("review_paise") or 0)
            rem = remaining_paise(f_paise, p_paise, r_paise)
            overdue_paise += rem

    if overdue_paise > 0:
        overdue_inr = paise_to_rupees_float(overdue_paise)
        return True, overdue_paise, f"Account restricted due to ₹{overdue_inr:.2f} overdue platform fee."
    return False, 0, ""


# ============================================================================
# FIRESTORE INTEGRATION & TRANSACTIONS
# ============================================================================

def _update_week_aggregate_tx(
    tx: Any,
    db: Any,
    uid: str,
    week_id_str: str,
    fee_paise_delta: int = 0,
    paid_paise_delta: int = 0,
    review_paise_delta: int = 0,
) -> Dict[str, Any]:
    """Atomically update a week aggregate doc in driverFeeWeeks/{uid}_{weekId}."""
    week_doc_id = f"{uid}_{week_id_str}"
    week_ref = db.collection(COLLECTION_DRIVER_FEE_WEEKS).document(week_doc_id)
    week_snap = tx.get(week_ref)
    week_data = week_snap.to_dict() or {} if week_snap.exists else {}

    tot_fee = max(0, int(week_data.get("total_fee_paise") or 0) + fee_paise_delta)
    tot_paid = max(0, int(week_data.get("paid_paise") or 0) + paid_paise_delta)
    tot_review = max(0, int(week_data.get("review_paise") or 0) + review_paise_delta)
    tot_rem = max(0, tot_fee - tot_paid - tot_review)

    now = get_ist_now()
    payload = {
        "uid": uid,
        "weekId": week_id_str,
        "total_fee_paise": tot_fee,
        "paid_paise": tot_paid,
        "review_paise": tot_review,
        "remaining_paise": tot_rem,
        "updated_at": now.isoformat(),
    }
    tx.set(week_ref, payload, merge=True)
    return payload


def ensure_fees_generated(
    db: Any,
    uid: str,
    now: Optional[datetime.datetime] = None,
    max_days: int = 14,
) -> List[Dict[str, Any]]:
    """Generates daily fees from the driver's last_generated_day pointer up to the last CLOSED service day.

    - Max 14 days per call.
    - Idempotent under repeats and concurrency.
    - Zero distance days create no driverFees record.
    - Billed fee = (round(distance_km * 1000) + 5) // 10 paise.
    - Advances feeState pointer and updates driverFeeWeeks in transactions.
    """
    curr = _to_ist_datetime(now)
    # The last closed service day is the day whose day_close is <= curr
    # For example, if now is 2026-10-20 18:00 IST, today's service day (closing at 20:00) is NOT closed.
    # Yesterday 2026-10-19 is closed.
    today_serv_date = service_date(curr)
    if is_service_day_closed(today_serv_date, curr):
        last_closed_date = today_serv_date
    else:
        last_closed_date = today_serv_date - datetime.timedelta(days=1)

    state_ref = db.collection(COLLECTION_FEE_STATE).document(uid)
    state_snap = state_ref.get()
    state_data = state_snap.to_dict() or {} if state_snap.exists else {}

    # Check if there is a system-wide reset anchor
    reset_anchor_date = None
    try:
        reset_snap = db.collection("systemSettings").document("driverPaymentReset").get()
        if reset_snap.exists:
            r_data = reset_snap.to_dict() or {}
            r_s = r_data.get("resetServiceDate")
            if not r_s:
                r_at = r_data.get("resetAt")
                if r_at:
                    r_s = service_date_str(r_at)
            if r_s:
                reset_anchor_date = _to_date(r_s)
    except Exception:
        pass

    last_gen_str = state_data.get("last_generated_day")
    if isinstance(last_gen_str, str) and last_gen_str.strip():
        try:
            start_date = _to_date(last_gen_str) + datetime.timedelta(days=1)
        except Exception:
            start_date = max(last_closed_date - datetime.timedelta(days=max_days - 1), datetime.date(2026, 1, 1))
    else:
        # Check driver registration/creation or default to up to 14 days back
        start_date = max(
            last_closed_date - datetime.timedelta(days=max_days - 1),
            datetime.date(2026, 1, 1),
        )

    if reset_anchor_date:
        # Do not generate fees for days on or before reset anchor
        start_date = max(start_date, reset_anchor_date + datetime.timedelta(days=1))

    if start_date > last_closed_date:
        return []

    # Gather dates to process (max 14 days)
    candidate_dates: List[datetime.date] = []
    d = start_date
    while d <= last_closed_date and len(candidate_dates) < max_days:
        candidate_dates.append(d)
        d += datetime.timedelta(days=1)

    created_fees: List[Dict[str, Any]] = []

    for c_date in candidate_dates:
        c_str = c_date.strftime("%Y-%m-%d")
        w_id = week_id(c_date)
        due_dt = fee_due_at(c_date)
        daily_stat_id = f"{uid}_{c_str}"
        daily_snap = db.collection(COLLECTION_DAILY_STATS).document(daily_stat_id).get()
        daily_data = daily_snap.to_dict() or {} if daily_snap.exists else {}

        dist_km = float(daily_data.get("distance_km") or 0.0)
        fee_id = f"{uid}_{c_str}"
        fee_ref = db.collection(COLLECTION_DRIVER_FEES).document(fee_id)

        # Transactionally create fee doc if distance > 0 and doc does not exist
        tx = db.transaction()

        def _gen_tx(txn: Any) -> Optional[Dict[str, Any]]:
            f_snap = txn.get(fee_ref)
            if not f_snap.exists:
                if dist_km > 0:
                    metres = int(round(dist_km * 1000.0))
                    fee_paise = (metres + 5) // 10
                    fee_doc = {
                        "uid": uid,
                        "feeId": fee_id,
                        "serviceDate": c_str,
                        "weekId": w_id,
                        "due_at": due_dt.isoformat(),
                        "billed_distance_m": metres,
                        "distance_km": dist_km,
                        "fee_paise": fee_paise,
                        "paid_paise": 0,
                        "review_paise": 0,
                        "remaining_paise": fee_paise,
                        "status": fee_status(fee_paise, 0, 0),
                        "waived_free": False,
                        "needs_attention": False,
                        "created_at": get_ist_now().isoformat(),
                        "updated_at": get_ist_now().isoformat(),
                    }
                    txn.set(fee_ref, fee_doc)
                    _update_week_aggregate_tx(txn, db, uid, w_id, fee_paise_delta=fee_paise)
                    # Advance pointer in feeState
                    txn.set(state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                    return fee_doc
                else:
                    # Zero distance: advance pointer without fee doc
                    txn.set(state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                    return None
            else:
                # Fee doc already exists, ensure pointer advanced
                txn.set(state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                return f_snap.to_dict()

        try:
            res = _gen_tx(tx)
            if res:
                created_fees.append(res)
        except Exception:
            pass

    return created_fees


def reconcile_fee_adjustment(
    db: Any,
    uid: str,
    service_date_val: Union[datetime.date, str],
    source: str = "admin_distance_approval",
    ride_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Level-triggered reconciliation for a closed service day fee.

    Compares driverDailyStats.distance_km to driverFees.billed_distance_m.
    - If target_paise > fee_paise:
      Creates an adjustment record in subcollection driverFees/{uid}_{serviceDate}/adjustments/{adjId},
      raises fee_paise, and updates driverFeeWeeks aggregate in same transaction.
    - If target_paise < fee_paise:
      Sets needs_attention = True.
    - Idempotent: repeated calls create no extra adjustments.
    """
    s_date = _to_date(service_date_val)
    s_str = s_date.strftime("%Y-%m-%d")
    w_id = week_id(s_date)
    fee_id = f"{uid}_{s_str}"
    fee_ref = db.collection(COLLECTION_DRIVER_FEES).document(fee_id)
    daily_ref = db.collection(COLLECTION_DAILY_STATS).document(f"{uid}_{s_str}")

    tx = db.transaction()

    def _reconcile_tx(txn: Any) -> Optional[Dict[str, Any]]:
        fee_snap = txn.get(fee_ref)
        if not fee_snap.exists:
            # Fee doc hasn't been generated yet (e.g. day not closed or zero distance initially)
            return None
        daily_snap = txn.get(daily_ref)
        daily_data = daily_snap.to_dict() or {} if daily_snap.exists else {}
        dist_km = float(daily_data.get("distance_km") or 0.0)

        fee_data = fee_snap.to_dict() or {}
        curr_fee_paise = int(fee_data.get("fee_paise") or 0)
        billed_m = int(fee_data.get("billed_distance_m") or 0)

        target_m = int(round(dist_km * 1000.0))
        target_paise = (target_m + 5) // 10
        delta_paise = target_paise - curr_fee_paise

        if delta_paise > 0:
            adj_id = f"adj_{target_m}"
            adj_ref = fee_ref.collection("adjustments").document(adj_id)
            adj_snap = txn.get(adj_ref)
            if not adj_snap.exists:
                adj_payload = {
                    "adjId": adj_id,
                    "delta_paise": delta_paise,
                    "from_metres": billed_m,
                    "to_metres": target_m,
                    "source": source,
                    "ride_id": ride_id,
                    "created_at": get_ist_now().isoformat(),
                }
                txn.set(adj_ref, adj_payload)

            new_fee_paise = target_paise
            new_billed_m = target_m
            p_paise = int(fee_data.get("paid_paise") or 0)
            r_paise = int(fee_data.get("review_paise") or 0)
            new_rem = max(0, new_fee_paise - p_paise - r_paise)

            txn.update(fee_ref, {
                "fee_paise": new_fee_paise,
                "billed_distance_m": new_billed_m,
                "distance_km": dist_km,
                "remaining_paise": new_rem,
                "updated_at": get_ist_now().isoformat(),
            })
            _update_week_aggregate_tx(txn, db, uid, w_id, fee_paise_delta=delta_paise)
            return {"adjusted": True, "delta_paise": delta_paise, "fee_paise": new_fee_paise}
        elif delta_paise < 0:
            txn.update(fee_ref, {"needs_attention": True, "updated_at": get_ist_now().isoformat()})
            return {"adjusted": False, "needs_attention": True}

        return {"adjusted": False, "delta_paise": 0}

    return _reconcile_tx(tx)


def get_driver_fee_summary(
    db: Any,
    uid: str,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """Retrieve full fee summary for a driver:
    - Lazy generation of pending closed fees
    - Fee days list
    - Payable paise, under review paise, overdue paise
    - Restriction state
    - Next deadline & deadline modal info
    """
    curr = _to_ist_datetime(now)
    # Lazy generate any unbilled closed days
    ensure_fees_generated(db, uid, now=curr)

    # Read all driver fees for this driver
    fee_docs = list(db.collection(COLLECTION_DRIVER_FEES).where("uid", "==", uid).stream())
    fees_list: List[Dict[str, Any]] = []

    for snap in fee_docs:
        d = snap.to_dict() or {}
        f_paise = int(d.get("fee_paise") or 0)
        p_paise = int(d.get("paid_paise") or 0)
        r_paise = int(d.get("review_paise") or 0)
        rem = remaining_paise(f_paise, p_paise, r_paise)
        st = fee_status(f_paise, p_paise, r_paise)

        fees_list.append({
            "feeId": snap.id,
            "serviceDate": d.get("serviceDate"),
            "weekId": d.get("weekId"),
            "distance_m": int(d.get("billed_distance_m") or 0),
            "distance_km": float(d.get("distance_km") or round(int(d.get("billed_distance_m") or 0) / 1000.0, 2)),
            "fee_paise": f_paise,
            "paid_paise": p_paise,
            "review_paise": r_paise,
            "remaining_paise": rem,
            "status": st,
            "due_at": d.get("due_at"),
            "waived_free": False,
            "needs_attention": bool(d.get("needs_attention", False)),
        })

    fees_list.sort(key=lambda x: str(x.get("serviceDate") or ""), reverse=True)

    payable_paise = sum(f["remaining_paise"] for f in fees_list)
    under_review_paise = sum(f["review_paise"] for f in fees_list)

    # Restriction evaluation:
    # Check if driver payment pause is active in systemSettings
    is_paused = False
    try:
        pause_snap = db.collection("systemSettings").document("driverPaymentPause").get()
        if pause_snap.exists:
            p_data = pause_snap.to_dict() or {}
            is_paused = bool(p_data.get("isPaused", False))
            start_d = p_data.get("startDate")
            end_d = p_data.get("endDate")
            if is_paused and start_d and end_d:
                from .payment_schedule import is_date_in_pause_range
                is_paused = is_date_in_pause_range(curr, start_d, end_d, True)
    except Exception:
        pass

    is_restricted, overdue_paise, restriction_reason = evaluate_fee_restriction(fees_list, curr)
    if is_paused:
        is_restricted = False
        restriction_reason = "Payments paused by administration."

    overdue_days = 0
    earliest_overdue_due_date = None
    if overdue_paise > 0:
        overdue_fees = [f for f in fees_list if _to_ist_datetime(f.get("due_at")) <= curr and f["remaining_paise"] > 0]
        if overdue_fees:
            earliest_due_dt = min(_to_ist_datetime(f["due_at"]) for f in overdue_fees)
            earliest_overdue_due_date = earliest_due_dt.strftime("%d %b %Y")
            diff_days = max(1, (curr.date() - earliest_due_dt.date()).days)
            overdue_days = diff_days

    # Fetch pending under-review batches and items for this driver
    under_review_batches: List[Dict[str, Any]] = []
    under_review_items: List[Dict[str, Any]] = []
    try:
        pending_batch_snaps = list(
            db.collection(COLLECTION_FEE_PAYMENT_BATCHES)
            .where("uid", "==", uid)
            .where("status", "==", "PENDING")
            .stream()
        )
        for b_snap in pending_batch_snaps:
            b_data = b_snap.to_dict() or {}
            b_id = b_snap.id
            alloc_snaps = list(b_snap.reference.collection("allocations").stream())
            b_allocs = []
            for a_s in alloc_snaps:
                a_data = a_s.to_dict() or {}
                st = str(a_data.get("status") or "").upper()
                if st == "PENDING":
                    s_date_str = a_data.get("serviceDate") or a_s.id.replace(f"{uid}_", "")
                    try:
                        s_dt = _to_date(s_date_str)
                        formatted_d = s_dt.strftime("%d %b %Y")
                    except Exception:
                        formatted_d = s_date_str

                    amt_paise = int(a_data.get("amount_paise") or 0)
                    fee_match = next((f for f in fees_list if f["feeId"] == a_data.get("fee_id") or f["serviceDate"] == s_date_str), None)
                    dist_km = fee_match["distance_km"] if fee_match else 0.0

                    item_dict = {
                        "feeId": a_data.get("fee_id") or a_s.id,
                        "fee_id": a_data.get("fee_id") or a_s.id,
                        "serviceDate": s_date_str,
                        "formatted_date": formatted_d,
                        "amount_paise": amt_paise,
                        "amount_inr": paise_to_rupees_float(amt_paise),
                        "distance_km": dist_km,
                        "status": "UNDER_REVIEW",
                        "batchId": b_id,
                        "proofDownloadUrl": b_data.get("proofDownloadUrl"),
                    }
                    b_allocs.append(item_dict)
                    under_review_items.append(item_dict)

            if b_allocs:
                under_review_batches.append({
                    "batchId": b_id,
                    "created_at": b_data.get("created_at"),
                    "total_paise": b_data.get("total_paise", 0),
                    "total_inr": paise_to_rupees_float(b_data.get("total_paise", 0)),
                    "proofDownloadUrl": b_data.get("proofDownloadUrl"),
                    "allocations": b_allocs,
                })
    except Exception:
        pass

    # Next upcoming deadline
    # Find active fees due in the future
    future_fees = [f for f in fees_list if _to_ist_datetime(f.get("due_at")) > curr and f["remaining_paise"] > 0]
    next_deadline_dt = min([_to_ist_datetime(f["due_at"]) for f in future_fees]) if future_fees else None
    if not next_deadline_dt:
        # Default to current week's Sunday 23:59:59 IST
        curr_serv_d = service_date(curr)
        next_deadline_dt = fee_due_at(curr_serv_d)

    # Actionable balance = overdue_paise (or fees due at next deadline)
    # Part F4 app-open modal criteria:
    # Actionable balance > 0 and deadline is within 48 hours.
    # Excludes under-review amounts and Sunday-exception fee alone.
    sec_to_deadline = max(0, int((next_deadline_dt - curr).total_seconds()))
    hours_left = sec_to_deadline // 3600
    minutes_left = (sec_to_deadline % 3600) // 60

    show_deadline_modal = (
        not is_paused
        and payable_paise > 0
        and sec_to_deadline <= 48 * 3600
        and (overdue_paise > 0 or any(_to_ist_datetime(f["due_at"]) == next_deadline_dt for f in fees_list if f["remaining_paise"] > 0))
    )

    deadline_label = "Sunday 11:59 PM IST"
    deadline_modal_obj = {
        "show": show_deadline_modal,
        "actionable_balance_paise": payable_paise,
        "actionable_balance_inr": paise_to_rupees_float(payable_paise),
        "deadline": deadline_label,
        "deadline_iso": next_deadline_dt.isoformat(),
        "remaining_seconds": sec_to_deadline,
        "remaining_hours": hours_left,
        "remaining_minutes": minutes_left,
    }

    return {
        "server_now": curr.isoformat(),
        "isPaused": is_paused,
        "payable_paise": payable_paise,
        "payable_inr": paise_to_rupees_float(payable_paise),
        "under_review_paise": under_review_paise,
        "under_review_inr": paise_to_rupees_float(under_review_paise),
        "overdue_paise": overdue_paise,
        "overdue_inr": paise_to_rupees_float(overdue_paise),
        "overdue_days": overdue_days,
        "earliest_overdue_due_date": earliest_overdue_due_date,
        "restriction": {
            "is_restricted": is_restricted,
            "overdue_paise": overdue_paise,
            "overdue_inr": paise_to_rupees_float(overdue_paise),
            "reason": restriction_reason,
        },
        "next_deadline": next_deadline_dt.isoformat(),
        "deadline_modal": deadline_modal_obj,
        "fees": fees_list,
        "under_review_batches": under_review_batches,
        "under_review_items": under_review_items,
    }


def update_week_aggregate_tx(
    tx: Any,
    db: Any,
    uid: str,
    week_id_str: str,
    fee_paise_delta: int = 0,
    paid_paise_delta: int = 0,
    review_paise_delta: int = 0,
) -> Dict[str, Any]:
    """Public export of _update_week_aggregate_tx."""
    return _update_week_aggregate_tx(tx, db, uid, week_id_str, fee_paise_delta, paid_paise_delta, review_paise_delta)


def allocate_manual_fee_payment(
    db: Any,
    uid: str,
    amount_inr: Optional[float] = None,
    amount_paise: Optional[int] = None,
    admin_user: Optional[Dict[str, Any]] = None,
    payment_method: str = "cash",
    payment_reference: str = "Offline Cash Payment",
    admin_email: Optional[str] = None,
) -> Dict[str, Any]:
    """Allocate an offline / manual payment across open fees chronologically.

    - Ensures fees generated up to closed date.
    - Allocates paise to oldest unpaid/partially paid fees first.
    - Updates fee docs and driverFeeWeeks atomically.
    - Creates an approved batch record in feePaymentBatches.
    """
    ensure_fees_generated(db, uid)

    fee_snaps = list(
        db.collection(COLLECTION_DRIVER_FEES)
        .where("uid", "==", uid)
        .stream()
    )
    # Sort chronologically
    fee_snaps.sort(key=lambda s: str((s.to_dict() or {}).get("serviceDate") or ""))

    if amount_paise is not None:
        amt_paise = int(amount_paise)
    elif amount_inr is not None:
        amt_paise = int(round(amount_inr * 100))
    else:
        # Auto-compute total outstanding dues
        amt_paise = sum(
            remaining_paise(
                int((s.to_dict() or {}).get("fee_paise") or 0),
                int((s.to_dict() or {}).get("paid_paise") or 0),
                int((s.to_dict() or {}).get("review_paise") or 0),
            )
            for s in fee_snaps
        )

    if amt_paise <= 0:
        raise ApiError("Payment amount must be greater than zero.", 400)

    now_str = get_ist_now().isoformat()
    adm_email = admin_email or (admin_user.get("email") if admin_user else None) or (admin_user.get("uid") if admin_user else None) or "admin"

    rem_to_allocate = amt_paise
    allocated_items: List[Dict[str, Any]] = []

    for f_snap in fee_snaps:
        if rem_to_allocate <= 0:
            break
        f_data = f_snap.to_dict() or {}
        f_paise = int(f_data.get("fee_paise") or 0)
        p_paise = int(f_data.get("paid_paise") or 0)
        r_paise = int(f_data.get("review_paise") or 0)
        needed = remaining_paise(f_paise, p_paise, r_paise)
        if needed <= 0:
            continue

        alloc = min(needed, rem_to_allocate)
        new_paid = p_paise + alloc
        new_rem = remaining_paise(f_paise, new_paid, r_paise)
        new_st = fee_status(f_paise, new_paid, r_paise)

        tx = db.transaction()

        def _alloc_tx(txn: Any) -> None:
            txn.update(f_snap.reference, {
                "paid_paise": new_paid,
                "remaining_paise": new_rem,
                "status": new_st,
                "updated_at": now_str,
            })
            w_id = f_data.get("weekId") or week_id(f_data.get("serviceDate"))
            if w_id:
                _update_week_aggregate_tx(txn, db, uid, w_id, paid_paise_delta=alloc)

        _alloc_tx(tx)
        rem_to_allocate -= alloc
        allocated_items.append({
            "fee_id": f_snap.id,
            "serviceDate": f_data.get("serviceDate"),
            "amount_paise": alloc,
            "amount_inr": paise_to_rupees_float(alloc),
            "status": "APPROVED",
            "decided_by": admin_email,
            "decided_at": now_str,
            "note": f"Manual offline recording ({payment_reference})",
        })

    # Record in feePaymentBatches
    batch_id = f"manual_{uid}_{int(datetime.datetime.now().timestamp() * 1000)}"
    batch_ref = db.collection(COLLECTION_FEE_PAYMENT_BATCHES).document(batch_id)
    total_allocated = amt_paise - rem_to_allocate
    batch_payload = {
        "batchId": batch_id,
        "uid": uid,
        "idempotency_key": f"manual_{batch_id}",
        "total_paise": total_allocated,
        "total_inr": paise_to_rupees_float(total_allocated),
        "status": "DECIDED",
        "paymentMethod": payment_method,
        "paymentReference": payment_reference,
        "is_manual": True,
        "recorded_by": adm_email,
        "allocation_count": len(allocated_items),
        "created_at": now_str,
        "updated_at": now_str,
    }
    batch_ref.set(batch_payload)
    for a_item in allocated_items:
        batch_ref.collection("allocations").document(a_item["fee_id"]).set(a_item)

    return {
        "ok": True,
        "batchId": batch_id,
        "allocated_paise": total_allocated,
        "settled_total_paise": total_allocated,
        "allocated_inr": paise_to_rupees_float(total_allocated),
        "unallocated_paise": rem_to_allocate,
        "allocations": allocated_items,
    }


def create_payment_batch(
    db: Any,
    uid: str,
    idempotency_key: str,
    allocations_input: List[Dict[str, Any]],
    proof_data: Dict[str, Any],
    profile: Dict[str, Any],
) -> Dict[str, Any]:
    """Submit a driver payment batch with per-day allocations.

    In one transaction:
    - Validate idempotency: returns existing batch if already submitted.
    - Each fee must belong to the caller.
    - amount_paise must equal current remaining_paise of each fee (409 if mismatch).
    - Fee cannot be in two pending allocations.
    - Increase review_paise per fee.
    - Create batch and allocations.
    - Update driverFeeWeeks aggregate.
    """
    clean_idem = idempotency_key.strip()
    if not clean_idem:
        raise ApiError("Idempotency key is required.", 400)

    # Check for existing batch with same idempotency key
    existing_batches = list(
        db.collection(COLLECTION_FEE_PAYMENT_BATCHES)
        .where("uid", "==", uid)
        .where("idempotency_key", "==", clean_idem)
        .limit(1)
        .stream()
    )
    if existing_batches:
        b_snap = existing_batches[0]
        b_data = b_snap.to_dict() or {}
        # Fetch allocations
        alloc_snaps = list(b_snap.reference.collection("allocations").stream())
        b_data["allocations"] = [a.to_dict() for a in alloc_snaps]
        return {"ok": True, "batch": b_data, "idempotent": True}

    if not allocations_input:
        raise ApiError("At least one fee allocation is required.", 400)

    total_submitted_paise = sum(int(a.get("amount_paise") or 0) for a in allocations_input)
    if total_submitted_paise <= 0:
        raise ApiError("Payment total must be greater than zero.", 400)

    now_ms = int(datetime.datetime.now().timestamp() * 1000)
    batch_id = f"batch_{uid}_{now_ms}"
    batch_ref = db.collection(COLLECTION_FEE_PAYMENT_BATCHES).document(batch_id)

    # Collect fee refs
    fee_ids = [str(a["fee_id"]).strip() for a in allocations_input]
    if len(fee_ids) != len(set(fee_ids)):
        raise ApiError("Duplicate fee allocation in the same payment batch.", 400)

    # Fetch and validate all fees inside transaction
    tx = db.transaction()

    def _batch_tx(txn: Any) -> Dict[str, Any]:
        allocations_to_save: List[Dict[str, Any]] = []

        for alloc in allocations_input:
            f_id = str(alloc["fee_id"]).strip()
            req_amount = int(alloc["amount_paise"])
            f_ref = db.collection(COLLECTION_DRIVER_FEES).document(f_id)
            f_snap = txn.get(f_ref)

            if not f_snap.exists:
                raise ApiError(f"Fee record {f_id} not found.", 404)

            f_data = f_snap.to_dict() or {}
            if f_data.get("uid") != uid:
                raise ApiError("Cannot submit payment for another driver's fee.", 403)

            f_paise = int(f_data.get("fee_paise") or 0)
            p_paise = int(f_data.get("paid_paise") or 0)
            r_paise = int(f_data.get("review_paise") or 0)
            curr_rem = remaining_paise(f_paise, p_paise, r_paise)

            if req_amount != curr_rem:
                raise ApiError(
                    f"Fee amount for {f_id} has changed (current remaining: ₹{paise_to_rupees_float(curr_rem):.2f}). Please refresh.",
                    409,
                    details={"fee_id": f_id, "current_remaining_paise": curr_rem},
                )

            # Check that fee is not already under review
            if r_paise > 0:
                raise ApiError(f"Fee {f_id} is already awaiting verification (under review).", 409)

            new_review_paise = r_paise + req_amount
            new_rem_paise = remaining_paise(f_paise, p_paise, new_review_paise)

            txn.update(f_ref, {
                "review_paise": new_review_paise,
                "remaining_paise": new_rem_paise,
                "status": fee_status(f_paise, p_paise, new_review_paise),
                "updated_at": get_ist_now().isoformat(),
            })

            w_id = f_data.get("weekId") or week_id(f_data.get("serviceDate"))
            _update_week_aggregate_tx(txn, db, uid, w_id, review_paise_delta=req_amount)

            alloc_doc = {
                "fee_id": f_id,
                "serviceDate": f_data.get("serviceDate"),
                "amount_paise": req_amount,
                "amount_inr": paise_to_rupees_float(req_amount),
                "status": "PENDING",
                "decided_by": None,
                "decided_at": None,
                "note": None,
            }
            allocations_to_save.append(alloc_doc)

        batch_payload = {
            "batchId": batch_id,
            "uid": uid,
            "driverName": profile.get("name", "Driver"),
            "driverPhone": profile.get("phone", ""),
            "idempotency_key": clean_idem,
            "total_paise": total_submitted_paise,
            "total_inr": paise_to_rupees_float(total_submitted_paise),
            "status": "PENDING",
            "proofStoragePath": proof_data.get("proofStoragePath"),
            "proofDownloadUrl": proof_data.get("proofDownloadUrl"),
            "proofFileName": proof_data.get("proofFileName"),
            "proofFileSize": proof_data.get("proofFileSize"),
            "proofContentType": proof_data.get("proofContentType"),
            "paymentReference": (proof_data.get("paymentReference") or "").strip()[:100],
            "paymentMethod": proof_data.get("paymentMethod") or "upi",
            "allocation_count": len(allocations_to_save),
            "created_at": get_ist_now().isoformat(),
            "updated_at": get_ist_now().isoformat(),
        }

        txn.set(batch_ref, batch_payload)
        for a_doc in allocations_to_save:
            a_ref = batch_ref.collection("allocations").document(a_doc["fee_id"])
            txn.set(a_ref, a_doc)

        batch_payload["allocations"] = allocations_to_save
        return batch_payload

    result = _batch_tx(tx)
    return {"ok": True, "batch": result, "idempotent": False}


def decide_payment_allocation(
    db: Any,
    batch_id: str,
    fee_id: str,
    decision: str,
    note: Optional[str],
    admin_user: Dict[str, Any],
) -> Dict[str, Any]:
    """Admin approves or declines a single allocation in a payment batch.

    Each decision in one transaction:
    - Allocation must still be PENDING (idempotent for identical decision; 409 for conflict).
    - Approve: review_paise -= amount; paid_paise += amount.
    - Decline: review_paise -= amount (returns amount to payable!).
    - Record decided_by, decided_at, note.
    - Set batch status when all allocations decided.
    - Update week aggregate.
    """
    clean_dec = decision.strip().lower()
    if clean_dec not in ("approve", "decline"):
        raise ApiError("Decision must be either 'approve' or 'decline'.", 400)

    clean_note = (note or "").strip()
    if clean_dec == "decline" and not clean_note:
        raise ApiError("A note is required when declining an allocation.", 422)

    batch_ref = db.collection(COLLECTION_FEE_PAYMENT_BATCHES).document(batch_id)
    alloc_ref = batch_ref.collection("allocations").document(fee_id)
    fee_ref = db.collection(COLLECTION_DRIVER_FEES).document(fee_id)

    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")
    now_str = get_ist_now().isoformat()

    tx = db.transaction()

    def _decide_tx(txn: Any) -> Dict[str, Any]:
        batch_snap = txn.get(batch_ref)
        if not batch_snap.exists:
            raise ApiError(f"Payment batch {batch_id} not found.", 404)

        alloc_snap = txn.get(alloc_ref)
        if not alloc_snap.exists:
            raise ApiError(f"Allocation for {fee_id} not found in batch {batch_id}.", 404)

        alloc_data = alloc_snap.to_dict() or {}
        curr_status = alloc_data.get("status")

        target_status = "APPROVED" if clean_dec == "approve" else "DECLINED"
        if curr_status == target_status:
            return {"ok": True, "message": "Decision already applied.", "allocation": alloc_data}
        if curr_status in ("APPROVED", "DECLINED"):
            raise ApiError(f"Allocation already decided as {curr_status}.", 409)

        fee_snap = txn.get(fee_ref)
        if not fee_snap.exists:
            raise ApiError(f"Fee doc {fee_id} not found.", 404)

        fee_data = fee_snap.to_dict() or {}
        uid = fee_data.get("uid") or (batch_snap.to_dict() or {}).get("uid")
        w_id = fee_data.get("weekId") or week_id(fee_data.get("serviceDate"))
        amount = int(alloc_data.get("amount_paise") or 0)

        f_paise = int(fee_data.get("fee_paise") or 0)
        p_paise = int(fee_data.get("paid_paise") or 0)
        r_paise = int(fee_data.get("review_paise") or 0)

        new_r_paise = max(0, r_paise - amount)

        if clean_dec == "approve":
            new_p_paise = p_paise + amount
            new_rem = remaining_paise(f_paise, new_p_paise, new_r_paise)
            txn.update(fee_ref, {
                "review_paise": new_r_paise,
                "paid_paise": new_p_paise,
                "remaining_paise": new_rem,
                "status": fee_status(f_paise, new_p_paise, new_r_paise),
                "updated_at": now_str,
            })
            _update_week_aggregate_tx(txn, db, uid, w_id, paid_paise_delta=amount, review_paise_delta=-amount)
        else:  # decline
            new_rem = remaining_paise(f_paise, p_paise, new_r_paise)
            txn.update(fee_ref, {
                "review_paise": new_r_paise,
                "remaining_paise": new_rem,
                "status": fee_status(f_paise, p_paise, new_r_paise),
                "updated_at": now_str,
            })
            _update_week_aggregate_tx(txn, db, uid, w_id, review_paise_delta=-amount)

        updated_alloc = {
            **alloc_data,
            "status": target_status,
            "decided_by": admin_email,
            "decided_at": now_str,
            "note": clean_note,
        }
        txn.set(alloc_ref, updated_alloc, merge=True)

        # Check all allocations in batch to see if all are decided
        all_allocs = list(batch_ref.collection("allocations").stream(transaction=txn))
        all_decided = True
        for a_s in all_allocs:
            if a_s.id == fee_id:
                st = target_status
            else:
                st = (a_s.to_dict() or {}).get("status")
            if st == "PENDING":
                all_decided = False
                break

        if all_decided:
            txn.update(batch_ref, {"status": "DECIDED", "updated_at": now_str})
        else:
            txn.update(batch_ref, {"updated_at": now_str})

        return {"ok": True, "allocation": updated_alloc, "uid": uid}

    result = _decide_tx(tx)
    return result
