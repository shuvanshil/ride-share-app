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
import logging
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("fee_engine")

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

def _tx_get(txn: Any, ref: Any) -> Any:
    """Safely get DocumentSnapshot inside a transaction.
    Handles real Firestore (ref.get(transaction=txn)) and mocks (txn.get(ref)).
    Also unrolls generator if txn.get returned StreamGenerator.
    """
    if ref is None:
        return None
    if txn is not None and hasattr(ref, "get"):
        try:
            return ref.get(transaction=txn)
        except TypeError:
            pass
    if txn is not None and hasattr(txn, "get"):
        res = txn.get(ref)
        if hasattr(res, "__next__") or (hasattr(res, "__iter__") and not hasattr(res, "exists")):
            try:
                return next(iter(res))
            except StopIteration:
                return None
        return res
    if hasattr(ref, "get"):
        return ref.get()
    return None


def _tx_set(txn: Any, ref: Any, data: Any, merge: bool = False) -> None:
    """Set document inside transaction or directly."""
    if txn is not None and hasattr(txn, "set"):
        txn.set(ref, data, merge=merge)
    elif hasattr(ref, "set"):
        ref.set(data, merge=merge)


def _tx_update(txn: Any, ref: Any, data: Any) -> None:
    """Update document inside transaction or directly."""
    if txn is not None and hasattr(txn, "update"):
        txn.update(ref, data)
    elif hasattr(ref, "update"):
        ref.update(data)


def _run_tx(db: Any, func: Any, *args: Any, **kwargs: Any) -> Any:
    """Execute func(txn, *args, **kwargs) within a Firestore transaction safely.
    Handles real google.cloud.firestore transactions (with begin/commit and retry)
    as well as test mock databases (InMemoryFirestore / SimFirestoreClient).
    If transactional execution fails or isn't supported, falls back to direct execution.
    """
    if db is None:
        return None
    try:
        from google.cloud import firestore as fb_firestore
        if hasattr(fb_firestore, "transactional") and hasattr(db, "transaction"):
            tx = db.transaction()
            if hasattr(tx, "_commit") or hasattr(tx, "_begin"):
                wrapped = fb_firestore.transactional(func)
                return wrapped(tx, *args, **kwargs)
    except Exception as e:
        logger.warning("Firestore transactional wrapper unavailable, falling back: %s", e)

    if hasattr(db, "transaction"):
        try:
            tx = db.transaction()
            res = func(tx, *args, **kwargs)
            if hasattr(tx, "_commit"):
                try:
                    tx._commit()
                except Exception:
                    pass
            return res
        except Exception as e:
            logger.error("Transaction execution failed: %s", e)
            raise
    else:
        return func(None, *args, **kwargs)


def _get_week_aggregate_data(tx: Any, db: Any, uid: str, week_id_str: str) -> Dict[str, Any]:
    """Read driverFeeWeeks document in read-phase of transaction."""
    week_doc_id = f"{uid}_{week_id_str}"
    week_ref = db.collection(COLLECTION_DRIVER_FEE_WEEKS).document(week_doc_id)
    week_snap = _tx_get(tx, week_ref)
    return week_snap.to_dict() or {} if (week_snap and week_snap.exists) else {}


def _apply_week_aggregate_write(
    tx: Any,
    db: Any,
    uid: str,
    week_id_str: str,
    week_data: Dict[str, Any],
    fee_paise_delta: int = 0,
    paid_paise_delta: int = 0,
    review_paise_delta: int = 0,
) -> Dict[str, Any]:
    """Write driverFeeWeeks payload in write-phase of transaction."""
    week_doc_id = f"{uid}_{week_id_str}"
    week_ref = db.collection(COLLECTION_DRIVER_FEE_WEEKS).document(week_doc_id)
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
    _tx_set(tx, week_ref, payload, merge=True)
    return payload


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
    week_data = _get_week_aggregate_data(tx, db, uid, week_id_str)
    return _apply_week_aggregate_write(
        tx, db, uid, week_id_str, week_data,
        fee_paise_delta=fee_paise_delta,
        paid_paise_delta=paid_paise_delta,
        review_paise_delta=review_paise_delta,
    )


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
    - Enforces read-before-write transactional discipline for Google Cloud Firestore.
    - Scans past closed days in the active window to recover any missed distance conversions.
    """
    curr = _to_ist_datetime(now)
    # The last closed service day is the day whose day_close is <= curr
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
        start_date = max(
            last_closed_date - datetime.timedelta(days=max_days - 1),
            datetime.date(2026, 1, 1),
        )

    if reset_anchor_date:
        start_date = max(start_date, reset_anchor_date + datetime.timedelta(days=1))

    # Lookback window for missing / zero-billed fee recovery
    lookback_start = max(
        last_closed_date - datetime.timedelta(days=max_days - 1),
        datetime.date(2026, 1, 1),
    )
    if reset_anchor_date:
        lookback_start = max(lookback_start, reset_anchor_date + datetime.timedelta(days=1))

    candidate_dates_set = set()
    # 1. Unprocessed forward dates
    if start_date <= last_closed_date:
        d = start_date
        while d <= last_closed_date and len(candidate_dates_set) < max_days:
            candidate_dates_set.add(d)
            d += datetime.timedelta(days=1)

    # 2. Lookback recovery: check past closed days in window with distance
    cur_d = lookback_start
    while cur_d <= last_closed_date:
        if cur_d not in candidate_dates_set:
            c_str = cur_d.strftime("%Y-%m-%d")
            f_snap = db.collection(COLLECTION_DRIVER_FEES).document(f"{uid}_{c_str}").get()
            if not f_snap.exists:
                d_snap = db.collection(COLLECTION_DAILY_STATS).document(f"{uid}_{c_str}").get()
                if d_snap.exists:
                    d_data = d_snap.to_dict() or {}
                    if float(d_data.get("distance_km") or 0.0) > 0.0:
                        candidate_dates_set.add(cur_d)
            else:
                f_data = f_snap.to_dict() or {}
                if int(f_data.get("billed_distance_m") or 0) == 0:
                    d_snap = db.collection(COLLECTION_DAILY_STATS).document(f"{uid}_{c_str}").get()
                    if d_snap.exists:
                        d_data = d_snap.to_dict() or {}
                        if float(d_data.get("distance_km") or 0.0) > 0.0:
                            candidate_dates_set.add(cur_d)
        cur_d += datetime.timedelta(days=1)

    candidate_dates = sorted(list(candidate_dates_set))
    if not candidate_dates:
        return []

    created_fees: List[Dict[str, Any]] = []

    for c_date in candidate_dates:
        c_str = c_date.strftime("%Y-%m-%d")
        w_id = week_id(c_date)
        due_dt = fee_due_at(c_date)
        daily_stat_id = f"{uid}_{c_str}"
        daily_snap = db.collection(COLLECTION_DAILY_STATS).document(daily_stat_id).get()
        daily_data = daily_snap.to_dict() or {} if daily_snap.exists else {}

        dist_km = float(daily_data.get("distance_km") or 0.0)
        if dist_km <= 0.0:
            # Fallback check tripHistory for counted rides on this service date
            try:
                trips = list(db.collection("tripHistory").where("driver_id", "==", uid).stream())
                sum_km = 0.0
                for ts in trips:
                    td = ts.to_dict() or {}
                    t_time = td.get("finalStatusAt") or td.get("completedAt") or td.get("verifiedAt") or td.get("updatedAt")
                    if t_time and service_date_str(t_time) == c_str:
                        if str(td.get("distance_status") or "").lower() == "counted":
                            sum_km += float(td.get("counted_distance_km") or 0.0)
                if sum_km > 0.0:
                    dist_km = round(sum_km, 2)
            except Exception:
                pass

        fee_id = f"{uid}_{c_str}"
        fee_ref = db.collection(COLLECTION_DRIVER_FEES).document(fee_id)

        # Enforce all reads before all writes in transaction
        def _gen_tx(txn: Any) -> Optional[Dict[str, Any]]:
            # Phase 1: Reads
            f_snap = _tx_get(txn, fee_ref)
            week_data = _get_week_aggregate_data(txn, db, uid, w_id)

            # Phase 2: Writes
            if not f_snap or not f_snap.exists:
                if dist_km > 0.0:
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
                    _tx_set(txn, fee_ref, fee_doc)
                    _apply_week_aggregate_write(txn, db, uid, w_id, week_data, fee_paise_delta=fee_paise)
                    _tx_set(txn, state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                    return fee_doc
                else:
                    _tx_set(txn, state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                    return None
            else:
                f_data = f_snap.to_dict() or {}
                # If existing fee doc has 0 billed distance but distance now exists, adjust it
                curr_billed_m = int(f_data.get("billed_distance_m") or 0)
                target_m = int(round(dist_km * 1000.0))
                if dist_km > 0.0 and curr_billed_m < target_m:
                    target_paise = (target_m + 5) // 10
                    curr_fee_paise = int(f_data.get("fee_paise") or 0)
                    delta_paise = target_paise - curr_fee_paise
                    p_paise = int(f_data.get("paid_paise") or 0)
                    r_paise = int(f_data.get("review_paise") or 0)
                    new_rem = max(0, target_paise - p_paise - r_paise)
                    _tx_update(txn, fee_ref, {
                        "billed_distance_m": target_m,
                        "distance_km": dist_km,
                        "fee_paise": target_paise,
                        "remaining_paise": new_rem,
                        "status": fee_status(target_paise, p_paise, r_paise),
                        "updated_at": get_ist_now().isoformat(),
                    })
                    _apply_week_aggregate_write(txn, db, uid, w_id, week_data, fee_paise_delta=delta_paise)
                    f_data["billed_distance_m"] = target_m
                    f_data["distance_km"] = dist_km
                    f_data["fee_paise"] = target_paise
                    f_data["remaining_paise"] = new_rem

                _tx_set(txn, state_ref, {"last_generated_day": c_str, "updated_at": get_ist_now().isoformat()}, merge=True)
                return f_data

        try:
            res = _run_tx(db, _gen_tx)
            if res:
                created_fees.append(res)
        except Exception as err:
            logger.error("Error generating fee for %s: %s", c_str, err)

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
    - If fee doc does not exist yet and dist_km > 0, generates the fee document.
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

    def _reconcile_tx(txn: Any) -> Optional[Dict[str, Any]]:
        # Phase 1: All Reads
        fee_snap = _tx_get(txn, fee_ref)
        daily_snap = _tx_get(txn, daily_ref)
        daily_data = daily_snap.to_dict() or {} if (daily_snap and daily_snap.exists) else {}
        dist_km = float(daily_data.get("distance_km") or 0.0)

        # Fallback check tripHistory if daily stats is zero
        if dist_km <= 0.0:
            try:
                trips = list(db.collection("tripHistory").where("driver_id", "==", uid).stream())
                sum_km = 0.0
                for ts in trips:
                    td = ts.to_dict() or {}
                    t_time = td.get("finalStatusAt") or td.get("completedAt") or td.get("verifiedAt") or td.get("updatedAt")
                    if t_time and service_date_str(t_time) == s_str:
                        if str(td.get("distance_status") or "").lower() == "counted":
                            sum_km += float(td.get("counted_distance_km") or 0.0)
                if sum_km > 0.0:
                    dist_km = round(sum_km, 2)
            except Exception:
                pass

        week_data = _get_week_aggregate_data(txn, db, uid, w_id)

        # If fee doc does not exist yet:
        if not fee_snap or not fee_snap.exists:
            if dist_km > 0.0:
                target_m = int(round(dist_km * 1000.0))
                fee_paise = (target_m + 5) // 10
                due_dt = fee_due_at(s_date)
                fee_doc = {
                    "uid": uid,
                    "feeId": fee_id,
                    "serviceDate": s_str,
                    "weekId": w_id,
                    "due_at": due_dt.isoformat(),
                    "billed_distance_m": target_m,
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
                _tx_set(txn, fee_ref, fee_doc)
                _apply_week_aggregate_write(txn, db, uid, w_id, week_data, fee_paise_delta=fee_paise)
                return {"adjusted": True, "created": True, "delta_paise": fee_paise, "fee_paise": fee_paise}
            return None

        fee_data = fee_snap.to_dict() or {}
        curr_fee_paise = int(fee_data.get("fee_paise") or 0)
        billed_m = int(fee_data.get("billed_distance_m") or 0)

        target_m = int(round(dist_km * 1000.0))
        target_paise = (target_m + 5) // 10
        delta_paise = target_paise - curr_fee_paise

        adj_id = f"adj_{target_m}"
        adj_ref = fee_ref.collection("adjustments").document(adj_id)
        adj_snap = _tx_get(txn, adj_ref)

        # Phase 2: All Writes
        if delta_paise > 0:
            if not adj_snap or not adj_snap.exists:
                adj_payload = {
                    "adjId": adj_id,
                    "delta_paise": delta_paise,
                    "from_metres": billed_m,
                    "to_metres": target_m,
                    "source": source,
                    "ride_id": ride_id,
                    "created_at": get_ist_now().isoformat(),
                }
                _tx_set(txn, adj_ref, adj_payload)

            new_fee_paise = target_paise
            new_billed_m = target_m
            p_paise = int(fee_data.get("paid_paise") or 0)
            r_paise = int(fee_data.get("review_paise") or 0)
            new_rem = max(0, new_fee_paise - p_paise - r_paise)

            _tx_update(txn, fee_ref, {
                "fee_paise": new_fee_paise,
                "billed_distance_m": new_billed_m,
                "distance_km": dist_km,
                "remaining_paise": new_rem,
                "status": fee_status(new_fee_paise, p_paise, r_paise),
                "updated_at": get_ist_now().isoformat(),
            })
            _apply_week_aggregate_write(txn, db, uid, w_id, week_data, fee_paise_delta=delta_paise)
            return {"adjusted": True, "delta_paise": delta_paise, "fee_paise": new_fee_paise}
        elif delta_paise < 0:
            _tx_update(txn, fee_ref, {"needs_attention": True, "updated_at": get_ist_now().isoformat()})
            return {"adjusted": False, "needs_attention": True}

        return {"adjusted": False, "delta_paise": 0}

    return _run_tx(db, _reconcile_tx)


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

    # If the active current service day is not closed, check driverDailyStats
    # so distance and estimated fee are visible to the driver immediately
    today_date = service_date(curr)
    today_str = service_date_str(today_date)
    has_today = any(f.get("serviceDate") == today_str for f in fees_list)
    if not has_today and not is_service_day_closed(today_date, curr):
        try:
            today_stat_ref = db.collection(COLLECTION_DAILY_STATS).document(f"{uid}_{today_str}")
            today_stat_snap = today_stat_ref.get()
            t_data = today_stat_snap.to_dict() or {} if today_stat_snap.exists else {}
            t_dist_km = float(t_data.get("distance_km") or 0.0)
            if t_dist_km <= 0.0:
                trips = list(db.collection("tripHistory").where("driver_id", "==", uid).stream())
                sum_km = 0.0
                for ts in trips:
                    td = ts.to_dict() or {}
                    t_time = td.get("finalStatusAt") or td.get("completedAt") or td.get("verifiedAt") or td.get("updatedAt")
                    if t_time and service_date_str(t_time) == today_str:
                        if str(td.get("distance_status") or "").lower() == "counted":
                            sum_km += float(td.get("counted_distance_km") or 0.0)
                if sum_km > 0.0:
                    t_dist_km = round(sum_km, 2)

            if t_dist_km > 0.0:
                t_metres = int(round(t_dist_km * 1000.0))
                t_fee_paise = (t_metres + 5) // 10
                fees_list.append({
                    "feeId": f"{uid}_{today_str}",
                    "serviceDate": today_str,
                    "weekId": week_id(today_date),
                    "distance_m": t_metres,
                    "distance_km": t_dist_km,
                    "fee_paise": t_fee_paise,
                    "paid_paise": 0,
                    "review_paise": 0,
                    "remaining_paise": 0,  # Zero: NOT actionable before 8 PM close!
                    "status": "NOT_DUE_YET",
                    "due_at": fee_due_at(today_date).isoformat(),
                    "waived_free": False,
                    "needs_attention": False,
                    "is_current_day": True,
                    "is_closed": False,
                })
        except Exception as e:
            logger.warning("Error checking current service day stats for %s: %s", uid, e)

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

    # Complete payment history list for driver
    payment_history: List[Dict[str, Any]] = []
    try:
        all_batch_snaps = list(
            db.collection(COLLECTION_FEE_PAYMENT_BATCHES)
            .where("uid", "==", uid)
            .stream()
        )
        for b_snap in all_batch_snaps:
            b_data = b_snap.to_dict() or {}
            b_id = b_snap.id
            alloc_snaps = list(b_snap.reference.collection("allocations").stream())
            b_status = str(b_data.get("status") or "PENDING").upper()
            if alloc_snaps:
                for a_s in alloc_snaps:
                    a_data = a_s.to_dict() or {}
                    a_id = a_s.id
                    a_fee_id = a_data.get("fee_id") or a_id
                    a_raw = str(a_data.get("status") or "PENDING").upper()
                    if a_raw == "APPROVED":
                        alloc_status = "approved"
                    elif a_raw == "DECLINED":
                        alloc_status = "declined"
                    elif b_status == "DECIDED":
                        alloc_status = "approved"
                    else:
                        alloc_status = "submitted"

                    s_date_str = a_data.get("serviceDate") or ""
                    try:
                        s_dt = _to_date(s_date_str)
                        week_label = f"Daily Fee ({s_dt.strftime('%d %b %Y')})"
                    except Exception:
                        week_label = f"Daily Fee ({s_date_str})" if s_date_str else f"Fee Payment #{b_id[:6]}"

                    alloc_amt_paise = int(a_data.get("amount_paise") or 0)
                    payment_history.append({
                        "id": f"{b_id}_{a_fee_id}",
                        "batchId": b_id,
                        "feeId": a_fee_id,
                        "serviceDate": s_date_str,
                        "weekLabel": week_label,
                        "weekId": s_date_str or b_id,
                        "amount": paise_to_rupees_float(alloc_amt_paise),
                        "amount_paise": alloc_amt_paise,
                        "status": alloc_status,
                        "submittedAt": a_data.get("created_at") or b_data.get("created_at"),
                        "verifiedAt": a_data.get("decided_at") or b_data.get("decided_at") or b_data.get("created_at"),
                        "declineReason": a_data.get("note"),
                        "proofDownloadUrl": b_data.get("proofDownloadUrl"),
                    })
            else:
                b_amt = paise_to_rupees_float(int(b_data.get("total_paise") or 0))
                payment_history.append({
                    "id": b_id,
                    "batchId": b_id,
                    "weekLabel": f"Fee Payment #{b_id[:6]}",
                    "weekId": b_id,
                    "amount": b_amt,
                    "amount_paise": int(b_data.get("total_paise") or 0),
                    "status": "approved" if b_status == "DECIDED" else "submitted",
                    "submittedAt": b_data.get("created_at"),
                    "verifiedAt": b_data.get("decided_at") or b_data.get("created_at"),
                    "declineReason": None,
                    "proofDownloadUrl": b_data.get("proofDownloadUrl"),
                })
    except Exception:
        pass

    try:
        legacy_snaps = list(
            db.collection("driverPayments")
            .where("driverId", "==", uid)
            .stream()
        )
        for l_snap in legacy_snaps:
            l_data = l_snap.to_dict() or {}
            payment_history.append({
                "id": l_snap.id,
                "weekLabel": l_data.get("weekLabel") or l_data.get("weekId") or "Weekly Fee",
                "weekId": l_data.get("weekId"),
                "amount": float(l_data.get("amount") or 0),
                "status": l_data.get("status", "approved"),
                "submittedAt": l_data.get("submittedAt"),
                "verifiedAt": l_data.get("verifiedAt"),
                "declineReason": l_data.get("declineReason"),
            })
    except Exception:
        pass

    payment_history.sort(key=lambda x: str(x.get("submittedAt") or ""), reverse=True)

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
        "payeeUpiId": "shuvanshil@oksbi",
        "payeeName": "LiphtUp",
        "weekInfo": {
            "weekId": week_id(service_date(curr)),
            "payeeUpiId": "shuvanshil@oksbi",
            "payeeName": "LiphtUp",
        },
        "fees": fees_list,
        "under_review_batches": under_review_batches,
        "under_review_items": under_review_items,
        "history": payment_history,
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
    selected_days: Optional[List[str]] = None,
    driver_name: Optional[str] = None,
    driver_phone: Optional[str] = None,
    admin_user: Optional[Dict[str, Any]] = None,
    payment_method: str = "cash",
    payment_reference: str = "Offline Cash Payment",
    admin_email: Optional[str] = None,
) -> Dict[str, Any]:
    """Allocate an offline / manual payment across open fees (or specific selected days).

    - Ensures fees generated up to closed date.
    - If selected_days is provided, allocates strictly to those selected serviceDates
      and auto-assigns their dayIds ({uid}_{serviceDate}) and weekIds (week_id(serviceDate)).
    - Otherwise allocates paise to oldest unpaid/partially paid fees first.
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

    cleaned_selected_days = [str(d).strip() for d in (selected_days or []) if str(d).strip()]
    if cleaned_selected_days:
        selected_set = set(cleaned_selected_days)
        fee_snaps = [
            s for s in fee_snaps
            if str((s.to_dict() or {}).get("serviceDate") or "").strip() in selected_set
        ]
        # Auto-compute total strictly from the selected days
        amt_paise = sum(
            remaining_paise(
                int((s.to_dict() or {}).get("fee_paise") or 0),
                int((s.to_dict() or {}).get("paid_paise") or 0),
                int((s.to_dict() or {}).get("review_paise") or 0),
            )
            for s in fee_snaps
        )
    elif amount_paise is not None:
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
        s_date = f_data.get("serviceDate")
        w_id = f_data.get("weekId") or (week_id(s_date) if s_date else None)

        def _alloc_tx(txn: Any) -> None:
            update_fields: Dict[str, Any] = {
                "paid_paise": new_paid,
                "remaining_paise": new_rem,
                "status": new_st,
                "updated_at": now_str,
            }
            if w_id and not f_data.get("weekId"):
                update_fields["weekId"] = w_id
            _tx_update(txn, f_snap.reference, update_fields)
            if w_id:
                _update_week_aggregate_tx(txn, db, uid, w_id, paid_paise_delta=alloc)

        _run_tx(db, _alloc_tx)
        rem_to_allocate -= alloc
        allocated_items.append({
            "fee_id": f_snap.id,
            "dayId": f_snap.id,
            "weekId": w_id,
            "serviceDate": s_date,
            "amount_paise": alloc,
            "amount_inr": paise_to_rupees_float(alloc),
            "status": "APPROVED",
            "decided_by": adm_email,
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
        "driverName": driver_name or "Driver",
        "driverPhone": driver_phone or "",
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

    # Re-evaluate restriction and lift if no longer overdue
    try:
        all_fees_after = [
            s.to_dict() or {}
            for s in db.collection(COLLECTION_DRIVER_FEES).where("uid", "==", uid).stream()
        ]
        rest = evaluate_fee_restriction(all_fees_after, get_ist_now())
        if not rest.get("restricted"):
            db.collection("users").document(uid).set(
                {"paymentRestricted": False, "feeOverdueRestricted": False},
                merge=True,
            )
    except Exception:
        pass

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
    def _batch_tx(txn: Any) -> Dict[str, Any]:
        # Phase 1: All Reads & Validations
        allocations_to_save: List[Dict[str, Any]] = []
        fee_updates: List[Tuple[Any, Dict[str, Any]]] = []
        week_deltas: Dict[str, Tuple[Dict[str, Any], int]] = {}

        for alloc in allocations_input:
            f_id = str(alloc["fee_id"]).strip()
            req_amount = int(alloc["amount_paise"])
            f_ref = db.collection(COLLECTION_DRIVER_FEES).document(f_id)
            f_snap = _tx_get(txn, f_ref)

            if not f_snap or not f_snap.exists:
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

            w_id = f_data.get("weekId") or week_id(f_data.get("serviceDate"))
            if w_id not in week_deltas:
                week_data = _get_week_aggregate_data(txn, db, uid, w_id)
                week_deltas[w_id] = (week_data, req_amount)
            else:
                prev_data, prev_delta = week_deltas[w_id]
                week_deltas[w_id] = (prev_data, prev_delta + req_amount)

            fee_updates.append((f_ref, {
                "review_paise": new_review_paise,
                "remaining_paise": new_rem_paise,
                "status": fee_status(f_paise, p_paise, new_review_paise),
                "updated_at": get_ist_now().isoformat(),
            }))

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

        # Phase 2: All Writes
        for f_ref, update_data in fee_updates:
            _tx_update(txn, f_ref, update_data)

        for w_id, (w_data, delta) in week_deltas.items():
            _apply_week_aggregate_write(txn, db, uid, w_id, w_data, review_paise_delta=delta)

        _tx_set(txn, batch_ref, batch_payload)
        for a_doc in allocations_to_save:
            a_ref = batch_ref.collection("allocations").document(a_doc["fee_id"])
            _tx_set(txn, a_ref, a_doc)

        batch_payload["allocations"] = allocations_to_save
        return batch_payload

    result = _run_tx(db, _batch_tx)
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

    def _decide_tx(txn: Any) -> Dict[str, Any]:
        # Phase 1: All Reads
        batch_snap = _tx_get(txn, batch_ref)
        if not batch_snap or not batch_snap.exists:
            raise ApiError(f"Payment batch {batch_id} not found.", 404)

        alloc_snap = _tx_get(txn, alloc_ref)
        if not alloc_snap or not alloc_snap.exists:
            raise ApiError(f"Allocation for {fee_id} not found in batch {batch_id}.", 404)

        alloc_data = alloc_snap.to_dict() or {}
        curr_status = alloc_data.get("status")

        target_status = "APPROVED" if clean_dec == "approve" else "DECLINED"
        if curr_status == target_status:
            return {"ok": True, "message": "Decision already applied.", "allocation": alloc_data}
        if curr_status in ("APPROVED", "DECLINED"):
            raise ApiError(f"Allocation already decided as {curr_status}.", 409)

        fee_snap = _tx_get(txn, fee_ref)
        if not fee_snap or not fee_snap.exists:
            raise ApiError(f"Fee doc {fee_id} not found.", 404)

        fee_data = fee_snap.to_dict() or {}
        uid = fee_data.get("uid") or (batch_snap.to_dict() or {}).get("uid")
        w_id = fee_data.get("weekId") or week_id(fee_data.get("serviceDate"))
        amount = int(alloc_data.get("amount_paise") or 0)

        week_data = _get_week_aggregate_data(txn, db, uid, w_id)

        try:
            if txn is not None and hasattr(batch_ref.collection("allocations"), "stream"):
                try:
                    all_allocs = list(batch_ref.collection("allocations").stream(transaction=txn))
                except TypeError:
                    all_allocs = list(batch_ref.collection("allocations").stream())
            else:
                all_allocs = list(batch_ref.collection("allocations").stream())
        except Exception:
            all_allocs = []

        # Phase 2: All Writes
        f_paise = int(fee_data.get("fee_paise") or 0)
        p_paise = int(fee_data.get("paid_paise") or 0)
        r_paise = int(fee_data.get("review_paise") or 0)

        new_r_paise = max(0, r_paise - amount)

        if clean_dec == "approve":
            new_p_paise = p_paise + amount
            new_rem = remaining_paise(f_paise, new_p_paise, new_r_paise)
            _tx_update(txn, fee_ref, {
                "review_paise": new_r_paise,
                "paid_paise": new_p_paise,
                "remaining_paise": new_rem,
                "status": fee_status(f_paise, new_p_paise, new_r_paise),
                "updated_at": now_str,
            })
            _apply_week_aggregate_write(txn, db, uid, w_id, week_data, paid_paise_delta=amount, review_paise_delta=-amount)
        else:  # decline
            new_rem = remaining_paise(f_paise, p_paise, new_r_paise)
            _tx_update(txn, fee_ref, {
                "review_paise": new_r_paise,
                "remaining_paise": new_rem,
                "status": fee_status(f_paise, p_paise, new_r_paise),
                "updated_at": now_str,
            })
            _apply_week_aggregate_write(txn, db, uid, w_id, week_data, review_paise_delta=-amount)

        updated_alloc = {
            **alloc_data,
            "status": target_status,
            "decided_by": admin_email,
            "decided_at": now_str,
            "note": clean_note,
        }
        _tx_set(txn, alloc_ref, updated_alloc, merge=True)

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
            _tx_update(txn, batch_ref, {"status": "DECIDED", "updated_at": now_str})
        else:
            _tx_update(txn, batch_ref, {"updated_at": now_str})

        return {"ok": True, "allocation": updated_alloc, "uid": uid}

    result = _run_tx(db, _decide_tx)
    return result
