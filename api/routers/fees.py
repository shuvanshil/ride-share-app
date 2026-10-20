"""Distance-based Fees API Router for LiphtUp Phase 2.

Driver endpoints:
- GET /api/fees/summary
- GET /api/fees/{serviceDate}/calculation
- POST /api/fees/payments

Admin endpoints:
- GET /api/admin/fee-batches
- GET /api/admin/fee-batches/{id}
- POST /api/admin/fee-batches/{id}/allocations/{feeId}/decision

Reminder trigger:
- POST /api/fees/reminders/trigger
"""
from __future__ import annotations

import datetime
import os
import urllib.parse
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, Query, Body, Path
from pydantic import BaseModel, Field

from ..core.auth import current_user
from ..core.admin import require_admin, write_audit_log
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app, get_firestore, get_messaging, get_storage_bucket
from ..core.service_day import (
    IST,
    service_date,
    service_date_str,
    day_close,
    day_start,
    fee_due_at,
    calculate_paise_for_distance,
    paise_to_rupees_float,
    get_ist_now,
    _to_ist_datetime,
    _to_date,
)
from ..core.fee_engine import (
    COLLECTION_DRIVER_FEES,
    COLLECTION_DRIVER_FEE_WEEKS,
    COLLECTION_FEE_PAYMENT_BATCHES,
    COLLECTION_FEE_REMINDERS,
    COLLECTION_DAILY_STATS,
    ensure_fees_generated,
    get_driver_fee_summary,
    create_payment_batch,
    decide_payment_allocation,
    fee_status,
    remaining_paise,
    evaluate_fee_restriction,
)

router = APIRouter(prefix="/fees", tags=["fees"])
admin_router = APIRouter(prefix="/admin", tags=["admin-fees"])


# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================

class AllocationItem(BaseModel):
    fee_id: str
    amount_paise: int = Field(..., gt=0)


class SubmitFeePaymentRequest(BaseModel):
    idempotency_key: str
    allocations: List[AllocationItem]
    proofStoragePath: Optional[str] = None
    proofDownloadUrl: Optional[str] = None
    proofFileName: Optional[str] = None
    proofFileSize: Optional[int] = None
    proofContentType: Optional[str] = None
    paymentReference: Optional[str] = None
    paymentMethod: Optional[str] = "upi"


class AllocationDecisionRequest(BaseModel):
    decision: str = Field(..., description="'approve' or 'decline'")
    note: Optional[str] = None


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _resolve_proof_url(storage_path: Optional[str], client_download_url: Optional[str] = None) -> Optional[str]:
    if client_download_url and str(client_download_url).strip():
        return str(client_download_url).strip()
    if not storage_path:
        return None
    try:
        bucket = get_storage_bucket()
        if bucket:
            blob = bucket.blob(storage_path)
            return blob.generate_signed_url(
                expiration=datetime.timedelta(days=7),
                method="GET",
            )
    except Exception:
        pass
    try:
        bucket_name = get_env("FIREBASE_STORAGE_BUCKET") or f"{get_env('FIREBASE_PROJECT_ID')}.firebasestorage.app"
        encoded_path = urllib.parse.quote(storage_path, safe="")
        return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded_path}?alt=media"
    except Exception:
        return None


def _send_payment_notification(
    db: Any,
    driver_id: str,
    status: str,
    amount_inr: float,
    reason: Optional[str] = None,
) -> None:
    now = get_ist_now()
    app_base_url = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")
    dest_url = f"{app_base_url}/driver-payments"

    if status == "submitted":
        title = "Payment Under Review"
        body = f"We received your payment proof of ₹{amount_inr:.2f}. Our team will verify each daily allocation shortly."
        notif_type = "fee_payment_submitted"
    elif status == "approved":
        title = "Payment Allocation Approved"
        body = f"Your daily fee allocation of ₹{amount_inr:.2f} has been verified and approved."
        notif_type = "fee_payment_approved"
    elif status == "declined":
        title = "Payment Allocation Declined"
        decline_msg = f": {reason}" if reason else "."
        body = f"Your daily fee payment of ₹{amount_inr:.2f} was declined{decline_msg} It has returned to your payable balance."
        notif_type = "fee_payment_declined"
    else:
        return

    try:
        notif_ref = db.collection("users").document(driver_id).collection("inAppNotifications").document()
        notif_ref.set({
            "title": title,
            "body": body,
            "type": notif_type,
            "url": dest_url,
            "read": False,
            "createdAt": now.isoformat(),
            "amount": amount_inr,
            "status": status,
            "reason": reason,
        })
    except Exception:
        pass

    try:
        driver_doc = db.collection("users").document(driver_id).get()
        if driver_doc.exists:
            driver_data = driver_doc.to_dict() or {}
            tokens = set()
            for k in ("fcmToken", "pushToken"):
                if driver_data.get(k):
                    tokens.add(str(driver_data[k]).strip())
            for t in driver_data.get("pushTokens") or []:
                if isinstance(t, str) and t.strip():
                    tokens.add(t.strip())
            for detail in driver_data.get("pushTokenDetails") or []:
                if isinstance(detail, dict) and detail.get("token"):
                    tokens.add(str(detail["token"]).strip())

            valid_tokens = [t for t in tokens if t]
            if valid_tokens:
                app = get_admin_app()
                messaging = get_messaging()
                for tok in valid_tokens[:5]:
                    msg = messaging.Message(
                        notification=messaging.Notification(title=title, body=body),
                        data={"type": notif_type, "url": dest_url, "amount": str(amount_inr)},
                        token=tok,
                    )
                    messaging.send(msg, app=app)
    except Exception:
        pass


# ============================================================================
# DRIVER ENDPOINTS
# ============================================================================

@router.get("/summary")
def get_fees_summary(
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Retrieve driver's comprehensive fee summary:
    - List of fee days (serviceDate, weekId, distance_m, fee_paise, remaining_paise, status, due_at)
    - Payable paise, under review paise, overdue paise
    - Restriction state with structured reason
    - Next deadline and deadline modal info
    """
    uid = str(auth_user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    db = get_firestore()
    summary = get_driver_fee_summary(db, uid)
    return {"ok": True, **summary}


@router.get("/{service_date_param}/calculation")
def get_fee_calculation(
    service_date_param: str = Path(..., description="Service date in YYYY-MM-DD format"),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Retrieve detailed fee calculation and per-ride breakdown for a service day.

    Returns:
    - Finalized distance (km and metres)
    - Per-ride breakdown from tripHistory (ride id, terminal time, counted km, determination method)
    - Excluded rides (under review or declined)
    - Fee formula details: ₹1/km conversion, integer half-up rounding step, fee paise
    - Adjustments breakdown trail
    """
    uid = str(auth_user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    s_date = _to_date(service_date_param)
    s_str = s_date.strftime("%Y-%m-%d")
    db = get_firestore()

    # Ensure fee generated if closed
    ensure_fees_generated(db, uid)

    fee_id = f"{uid}_{s_str}"
    fee_ref = db.collection(COLLECTION_DRIVER_FEES).document(fee_id)
    fee_snap = fee_ref.get()

    daily_snap = db.collection(COLLECTION_DAILY_STATS).document(f"{uid}_{s_str}").get()
    daily_data = daily_snap.to_dict() or {} if daily_snap.exists else {}

    fee_data = fee_snap.to_dict() or {} if fee_snap.exists else {}
    finalized_km = float(daily_data.get("distance_km") or fee_data.get("distance_km") or 0.0)
    billed_m = int(fee_data.get("billed_distance_m") or round(finalized_km * 1000.0))
    fee_paise = int(fee_data.get("fee_paise") or calculate_paise_for_distance(finalized_km))

    # Per-ride breakdown from tripHistory for this driver and service date
    trip_snaps = list(db.collection("tripHistory").where("driver_id", "==", uid).stream())
    rides_breakdown: List[Dict[str, Any]] = []
    excluded_rides: List[Dict[str, Any]] = []

    for t_snap in trip_snaps:
        t_data = t_snap.to_dict() or {}
        term_time = (
            t_data.get("finalStatusAt")
            or t_data.get("completedAt")
            or t_data.get("cancelledAt")
            or t_data.get("verifiedAt")
            or t_data.get("updatedAt")
        )
        if not term_time:
            continue
        try:
            r_serv_date = service_date_str(term_time)
        except Exception:
            continue

        if r_serv_date != s_str:
            continue

        r_id = t_data.get("ride_id") or t_snap.id
        c_km = float(t_data.get("counted_distance_km") or 0.0)
        d_status = str(t_data.get("distance_status") or "zero").lower()
        rec = t_data.get("distance_reconciliation") or {}
        raw_method = str(rec.get("method") or "TRACKED").upper()

        if t_data.get("distance_reviewed_at") or t_data.get("distance_reviewed_by"):
            determination = "admin-approved" if c_km > 0 else "admin-declined"
        elif "GPS" in raw_method or raw_method == "TRACKED" or raw_method == "AUTO_ACCEPTED":
            determination = "tracked"
        elif "ESTIMAT" in raw_method or "FALLBACK" in raw_method:
            determination = "estimated"
        else:
            determination = "tracked"

        ride_entry = {
            "rideId": r_id,
            "terminalTime": str(term_time),
            "pickup": t_data.get("pickup_location") or "Pickup",
            "drop": t_data.get("drop_location") or "Drop",
            "counted_km": c_km,
            "status": t_data.get("trip_status") or t_data.get("final_status") or "completed",
            "distance_status": d_status,
            "determination_method": determination,
        }

        if d_status == "counted" and c_km > 0:
            rides_breakdown.append(ride_entry)
        else:
            excluded_rides.append(ride_entry)

    # Subcollection adjustments
    adjustments_list: List[Dict[str, Any]] = []
    if fee_snap.exists:
        for adj_snap in fee_ref.collection("adjustments").stream():
            adj_data = adj_snap.to_dict() or {}
            adjustments_list.append({
                "adjId": adj_snap.id,
                "delta_paise": int(adj_data.get("delta_paise") or 0),
                "delta_inr": paise_to_rupees_float(int(adj_data.get("delta_paise") or 0)),
                "from_metres": int(adj_data.get("from_metres") or 0),
                "to_metres": int(adj_data.get("to_metres") or 0),
                "source": adj_data.get("source"),
                "ride_id": adj_data.get("ride_id"),
                "created_at": adj_data.get("created_at"),
            })

    formula = {
        "rate": "₹1 per km (0.1 paise per metre)",
        "formula": "fee_paise = (metres + 5) // 10",
        "finalized_km": finalized_km,
        "billed_metres": billed_m,
        "fee_paise": fee_paise,
        "fee_inr": paise_to_rupees_float(fee_paise),
    }

    return {
        "ok": True,
        "serviceDate": s_str,
        "feeId": fee_id,
        "finalized_km": finalized_km,
        "billed_metres": billed_m,
        "fee_paise": fee_paise,
        "fee_inr": paise_to_rupees_float(fee_paise),
        "due_at": fee_data.get("due_at") or fee_due_at(s_date).isoformat(),
        "status": fee_status(fee_paise, int(fee_data.get("paid_paise") or 0), int(fee_data.get("review_paise") or 0)),
        "formula": formula,
        "counted_rides": rides_breakdown,
        "excluded_rides": excluded_rides,
        "adjustments": adjustments_list,
    }


@router.post("/payments")
def submit_fee_payment(
    body: SubmitFeePaymentRequest = Body(...),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Submit a driver payment batch with allocations to individual daily fees."""
    uid = str(auth_user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    db = get_firestore()
    profile = db.collection("users").document(uid).get().to_dict() or {}

    resolved_proof_url = _resolve_proof_url(body.proofStoragePath, body.proofDownloadUrl)
    proof_data = {
        "proofStoragePath": body.proofStoragePath,
        "proofDownloadUrl": resolved_proof_url,
        "proofFileName": body.proofFileName,
        "proofFileSize": body.proofFileSize,
        "proofContentType": body.proofContentType,
        "paymentReference": body.paymentReference,
        "paymentMethod": body.paymentMethod,
    }

    allocations_input = [a.model_dump() for a in body.allocations]
    result = create_payment_batch(
        db=db,
        uid=uid,
        idempotency_key=body.idempotency_key,
        allocations_input=allocations_input,
        proof_data=proof_data,
        profile=profile,
    )

    # Send driver notification
    if not result.get("idempotent"):
        tot_inr = paise_to_rupees_float(result["batch"].get("total_paise", 0))
        _send_payment_notification(db, uid, "submitted", tot_inr)

    return result


# ============================================================================
# ADMIN ENDPOINTS
# ============================================================================

@admin_router.get("/fee-batches")
def admin_list_fee_batches(
    status: Optional[str] = Query(None, description="Filter by status: PENDING | DECIDED"),
    driver_id: Optional[str] = Query(None, description="Filter by driver UID"),
    limit: int = Query(50, ge=1, le=200),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """List payment batches for admin verification."""
    db = get_firestore()
    query = db.collection(COLLECTION_FEE_PAYMENT_BATCHES)

    if status:
        query = query.where("status", "==", status.strip().upper())
    if driver_id:
        query = query.where("uid", "==", driver_id.strip())

    docs = list(query.limit(limit).stream())
    batches: List[Dict[str, Any]] = []

    for d in docs:
        b_data = d.to_dict() or {}
        b_data["batchId"] = d.id
        alloc_snaps = list(d.reference.collection("allocations").stream())
        b_data["allocations"] = [a.to_dict() for a in alloc_snaps]
        batches.append(b_data)

    batches.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
    return {"ok": True, "batches": batches, "count": len(batches)}


@admin_router.get("/drivers/{driver_id}/fees-summary")
def admin_get_driver_fee_summary(
    driver_id: str,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Retrieve full fee summary for a specific driver (admin endpoint)."""
    db = get_firestore()
    summary = get_driver_fee_summary(db, driver_id.strip())
    return {"ok": True, **summary}


@admin_router.get("/fee-batches/{batch_id}")
def admin_get_fee_batch(
    batch_id: str,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Retrieve detailed info for a single payment batch and its allocations."""
    db = get_firestore()
    b_ref = db.collection(COLLECTION_FEE_PAYMENT_BATCHES).document(batch_id)
    b_snap = b_ref.get()
    if not b_snap.exists:
        raise ApiError("Payment batch not found.", 404)

    b_data = b_snap.to_dict() or {}
    b_data["batchId"] = b_snap.id
    alloc_snaps = list(b_ref.collection("allocations").stream())
    b_data["allocations"] = [a.to_dict() for a in alloc_snaps]

    return {"ok": True, "batch": b_data}


@admin_router.post("/fee-batches/{batch_id}/allocations/{fee_id}/decision")
def admin_decide_fee_allocation(
    batch_id: str,
    fee_id: str,
    body: AllocationDecisionRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Approve or decline an individual allocation in a payment batch."""
    db = get_firestore()
    res = decide_payment_allocation(
        db=db,
        batch_id=batch_id,
        fee_id=fee_id,
        decision=body.decision,
        note=body.note,
        admin_user=admin_user,
    )

    # Write audit log
    write_audit_log(
        admin_user,
        "fee_payment.allocation_decision",
        "feePaymentBatch",
        f"{batch_id}/{fee_id}",
        {},
        {"decision": body.decision, "note": body.note},
        f"Admin decided allocation {fee_id} in {batch_id}: {body.decision}",
    )

    # Best-effort notification to driver
    uid = res.get("uid")
    if uid:
        try:
            alloc_data = res.get("allocation") or {}
            amt_inr = paise_to_rupees_float(int(alloc_data.get("amount_paise") or 0))
            _send_payment_notification(
                db,
                uid,
                body.decision.lower(),
                amt_inr,
                reason=body.note if body.decision.lower() == "decline" else None,
            )
        except Exception:
            pass

    return {"ok": True, "message": f"Allocation {body.decision}d successfully.", **res}


# ============================================================================
# REMINDERS TRIGGER ENDPOINT (EXTERNAL SCHEDULER / CRON)
# ============================================================================

@router.post("/reminders/trigger")
@router.get("/reminders/trigger")
def trigger_fee_reminders(
    x_reminder_secret: Optional[str] = Header(None, alias="X-Reminder-Secret"),
    admin_user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Trigger scheduled fee reminders at 48h, 24h, 12h, 6h before Sunday 23:59:59 IST deadline.

    Requires secret header X-Reminder-Secret matching FEE_REMINDER_SECRET env var.
    Deduplicates via feeReminders/{uid}_{deadlineDate}_{hours}.
    Skips earlier thresholds if late trigger.
    """
    configured_secret = get_env("FEE_REMINDER_SECRET") or get_env("CRON_SECRET") or "liphtup-fees-secret-2026"
    if not x_reminder_secret or x_reminder_secret.strip() != configured_secret.strip():
        raise ApiError("Unauthorized: Invalid reminder trigger secret.", 401)

    curr = get_ist_now()
    curr_serv_date = service_date(curr)
    deadline_dt = fee_due_at(curr_serv_date)
    deadline_date_str = deadline_dt.strftime("%Y-%m-%d")

    diff_sec = (deadline_dt - curr).total_seconds()
    if diff_sec < 0 or diff_sec > 48 * 3600:
        return {"ok": True, "message": "Outside reminder window (not within 48h before deadline).", "sent_count": 0}

    hours_left = diff_sec / 3600.0

    # Determine passed thresholds: 48, 24, 12, 6
    # Active threshold is the smallest one that has passed (e.g. if 18h left, 24h has passed)
    thresholds = [48, 24, 12, 6]
    eligible_threshold = None
    for th in sorted(thresholds):
        if hours_left <= th:
            eligible_threshold = th
            break

    if not eligible_threshold:
        return {"ok": True, "message": "No reminder threshold reached.", "sent_count": 0}

    db = get_firestore()
    drivers = list(db.collection("users").where("role", "==", "driver").stream())
    sent_count = 0

    app_base_url = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")
    dest_url = f"{app_base_url}/driver-payments"

    for d_doc in drivers:
        uid = d_doc.id
        summary = get_driver_fee_summary(db, uid, now=curr)

        # Actionable remaining: check if driver owes fees due at this deadline
        # (under-review amounts and carried-forward Sunday-exception fee are excluded)
        actionable_paise = sum(
            int(f.get("remaining_paise") or 0)
            for f in summary.get("fees", [])
            if _to_ist_datetime(f.get("due_at")) <= deadline_dt
        )
        if actionable_paise <= 0:
            continue

        # Check dedupe doc
        reminder_doc_id = f"{uid}_{deadline_date_str}_{eligible_threshold}"
        rem_ref = db.collection(COLLECTION_FEE_REMINDERS).document(reminder_doc_id)
        rem_snap = rem_ref.get()
        if rem_snap.exists:
            continue

        # Mark all earlier thresholds as skipped for this deadline
        for th in thresholds:
            if th > eligible_threshold:
                prev_id = f"{uid}_{deadline_date_str}_{th}"
                db.collection(COLLECTION_FEE_REMINDERS).document(prev_id).set({
                    "uid": uid,
                    "deadline": deadline_date_str,
                    "threshold_hours": th,
                    "status": "SKIPPED_LATE",
                    "created_at": curr.isoformat(),
                }, merge=True)

        # Mark current threshold as SENT
        rem_ref.set({
            "uid": uid,
            "deadline": deadline_date_str,
            "threshold_hours": eligible_threshold,
            "status": "SENT",
            "amount_paise": actionable_paise,
            "created_at": curr.isoformat(),
        })

        # Send notification
        actionable_inr = paise_to_rupees_float(actionable_paise)
        title = f"Platform Fee Due Reminder ({eligible_threshold}h left)"
        body = f"You have ₹{actionable_inr:.2f} due before Sunday 11:59 PM IST. Please complete your payment to continue receiving rides."

        try:
            db.collection("users").document(uid).collection("inAppNotifications").document().set({
                "title": title,
                "body": body,
                "type": "fee_reminder",
                "url": dest_url,
                "read": False,
                "createdAt": curr.isoformat(),
                "amount": payable_inr,
            })
            sent_count += 1
        except Exception:
            pass

    return {
        "ok": True,
        "message": f"Processed fee reminders for {eligible_threshold}h threshold.",
        "sent_count": sent_count,
        "threshold": eligible_threshold,
    }
