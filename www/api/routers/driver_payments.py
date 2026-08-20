"""Driver Weekly Payments API Router.

Handles driver-side payment status queries, verification submissions,
payment history retrieval, payment pause settings, and admin offline manual payment recording.
Writes to `driverPayments` and `systemSettings` collections.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import datetime

from fastapi import APIRouter, Depends, Query, Body
from pydantic import BaseModel

from api.core.auth import current_user
from api.core.admin import require_admin, write_audit_log, now_utc
from api.core.errors import ApiError
from api.core.firebase import get_firestore
from api.core.payment_schedule import (
    get_payment_week_info,
    get_ist_now,
    is_date_in_pause_range,
    calculate_dues_and_upcoming,
    DEFAULT_WEEKLY_FEE,
    DEFAULT_PAYEE_UPI_ID,
)

router = APIRouter(prefix="/api/account/driver-payments", tags=["driver-payments"])
admin_router = APIRouter(prefix="/api/admin/driver-payments", tags=["admin-driver-payments"])


class SubmitPaymentRequest(BaseModel):
    paymentReference: Optional[str] = None
    paymentMethod: Optional[str] = "upi"


class AdminDeclineRequest(BaseModel):
    declineReason: Optional[str] = "Payment could not be verified by accounts team."


class AdminPauseRequest(BaseModel):
    isPaused: bool = True
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    message: Optional[str] = "Weekly payments are currently paused. Chill and relax — no payment is required during this period."


class AdminRecordManualPaymentRequest(BaseModel):
    driverId: str
    weekId: Optional[str] = None
    amount: Optional[float] = DEFAULT_WEEKLY_FEE
    paymentMethod: Optional[str] = "cash"
    paymentReference: Optional[str] = "Offline Cash Payment"


def _get_driver_profile(db: Any, uid: str) -> Dict[str, Any]:
    doc_ref = db.collection("users").document(uid)
    doc_snap = doc_ref.get()
    if not doc_snap.exists:
        raise ApiError("User account not found.", 440)
    profile = doc_snap.to_dict() or {}
    if profile.get("role") != "driver":
        raise ApiError("Only driver accounts can access weekly payment features.", 403)
    return profile


def _sanitize_for_json(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_json(v) for v in obj]
    return obj


def _get_pause_config(db: Any) -> Dict[str, Any]:
    doc_ref = db.collection("systemSettings").document("driverPaymentPause")
    snap = doc_ref.get()
    if not snap.exists:
        return {
            "isPaused": False,
            "configuredPaused": False,
            "startDate": None,
            "endDate": None,
            "message": "Weekly payments are currently paused. Chill and relax — no payment is required during this period.",
        }
    data = snap.to_dict() or {}
    is_paused = bool(data.get("isPaused", False))
    start_date = data.get("startDate")
    end_date = data.get("endDate")
    message = data.get("message") or "Weekly payments are currently paused. Chill and relax — no payment is required during this period."

    active = is_date_in_pause_range(get_ist_now(), start_date, end_date, is_paused)
    return {
        "isPaused": active,
        "configuredPaused": is_paused,
        "startDate": start_date,
        "endDate": end_date,
        "message": message,
    }


def _format_payment_doc(doc_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    submitted_at = data.get("submittedAt")
    if hasattr(submitted_at, "isoformat"):
        submitted_at_str = submitted_at.isoformat()
    elif isinstance(submitted_at, (int, float)):
        submitted_at_str = datetime.datetime.fromtimestamp(submitted_at / 1000.0, datetime.timezone.utc).isoformat()
    else:
        submitted_at_str = str(submitted_at) if submitted_at else None

    verified_at = data.get("verifiedAt")
    if hasattr(verified_at, "isoformat"):
        verified_at_str = verified_at.isoformat()
    elif isinstance(verified_at, (int, float)):
        verified_at_str = datetime.datetime.fromtimestamp(verified_at / 1000.0, datetime.timezone.utc).isoformat()
    else:
        verified_at_str = str(verified_at) if verified_at else None

    return {
        "paymentId": doc_id,
        "driverId": data.get("driverId"),
        "driverName": data.get("driverName", "Driver"),
        "driverPhone": data.get("driverPhone", ""),
        "weekId": data.get("weekId"),
        "weekLabel": data.get("weekLabel", ""),
        "amount": data.get("amount", DEFAULT_WEEKLY_FEE),
        "currency": data.get("currency", "INR"),
        "submittedAt": submitted_at_str,
        "status": data.get("status", "submitted"),
        "paymentReference": data.get("paymentReference", ""),
        "paymentMethod": data.get("paymentMethod", "upi"),
        "isManualRecord": bool(data.get("isManualRecord", False)),
        "verifiedAt": verified_at_str,
        "verifiedByAdminEmail": data.get("verifiedByAdminEmail"),
        "declineReason": data.get("declineReason"),
    }


@router.get("/status")
def get_driver_payment_status(
    auth_user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, Any]:
    """Retrieve driver's current week payment status and history."""
    uid = auth_user["uid"]
    db = get_firestore()
    profile = _get_driver_profile(db, uid)
    driver_created_at = profile.get("createdAt") or profile.get("approvedAt") or profile.get("registrationDate")

    pause_config = _get_pause_config(db)
    week_info = get_payment_week_info()
    current_week_id = week_info["weekId"]

    # Query all payment submissions for this driver
    payments_ref = db.collection("driverPayments").where("driverId", "==", uid)
    docs = list(payments_ref.stream())

    payment_history: List[Dict[str, Any]] = []
    active_submission: Optional[Dict[str, Any]] = None

    for doc_snap in docs:
        p_data = _format_payment_doc(doc_snap.id, doc_snap.to_dict() or {})
        payment_history.append(p_data)
        if p_data["weekId"] == current_week_id:
            if not active_submission or p_data["status"] in ("submitted", "approved"):
                active_submission = p_data

    # Sort history by submittedAt descending
    payment_history.sort(
        key=lambda x: str(x.get("submittedAt") or ""), reverse=True
    )

    # Determine overall current week payment status
    if pause_config["isPaused"]:
        status_code = "paused"
        status_label = "Weekly Payments Paused"
    elif active_submission:
        current_status = active_submission["status"]
        if current_status == "submitted":
            status_code = "submitted"
            status_label = "Payment submitted — awaiting verification"
        elif current_status == "approved":
            status_code = "approved"
            status_label = "Payment Verified & Approved"
        elif current_status == "declined":
            status_code = "declined"
            status_label = "Payment Declined — Please Pay Again"
        else:
            status_code = "due"
            status_label = "Payment Due"
    else:
        if week_info["isPastDeadline"]:
            status_code = "overdue"
            status_label = "Payment Overdue"
        else:
            status_code = "due"
            status_label = "Payment Due"

    dues_info = calculate_dues_and_upcoming(
        payment_history, week_info, status_code, driver_created_at=driver_created_at
    )

    return {
        "ok": True,
        "isPaused": pause_config["isPaused"],
        "pauseConfig": pause_config,
        "pauseMessage": pause_config["message"],
        "weekInfo": week_info,
        "currentStatus": status_code,
        "currentStatusLabel": status_label,
        "activeSubmission": active_submission,
        "duesSummary": dues_info,
        "upcomingWeek": dues_info["upcomingWeek"],
        "isAccountOnHold": dues_info["isAccountOnHold"],
        "history": payment_history,
    }


@router.post("/submit")
def submit_weekly_payment(
    body: SubmitPaymentRequest = Body(...),
    auth_user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Submit a weekly payment verification request."""
    uid = auth_user["uid"]
    db = get_firestore()
    profile = _get_driver_profile(db, uid)

    pause_config = _get_pause_config(db)
    if pause_config["isPaused"]:
        raise ApiError(
            pause_config["message"] or "Weekly payments are currently paused. No payment is required during this period.", 400
        )

    week_info = get_payment_week_info()
    current_week_id = week_info["weekId"]

    # Check for existing active submission for this week
    existing_docs = list(
        db.collection("driverPayments")
        .where("driverId", "==", uid)
        .where("weekId", "==", current_week_id)
        .stream()
    )

    for doc_snap in existing_docs:
        data = doc_snap.to_dict() or {}
        st = data.get("status")
        if st == "submitted":
            raise ApiError(
                "You already have a payment for this week awaiting verification.", 409
            )
        if st == "approved":
            raise ApiError(
                "Your weekly payment for this period has already been verified and approved.", 409
            )

    # Create new submission record
    doc_id = f"pymt_{uid}_{current_week_id}_{int(datetime.datetime.now().timestamp())}"
    doc_ref = db.collection("driverPayments").document(doc_id)

    payload = {
        "driverId": uid,
        "driverName": profile.get("name", auth_user.get("name", "Driver")),
        "driverPhone": profile.get("phone", auth_user.get("phone_number", "")),
        "weekId": current_week_id,
        "weekLabel": week_info["weekLabel"],
        "amount": DEFAULT_WEEKLY_FEE,
        "currency": "INR",
        "submittedAt": get_ist_now(),
        "status": "submitted",
        "paymentReference": (body.paymentReference or "").strip()[:100],
        "paymentMethod": body.paymentMethod or "upi",
        "isManualRecord": False,
        "verifiedAt": None,
        "verifiedByAdminUid": None,
        "verifiedByAdminEmail": None,
        "declineReason": None,
    }

    doc_ref.set(payload)

    return {
        "ok": True,
        "message": "Payment submitted for verification successfully.",
        "payment": _format_payment_doc(doc_id, payload),
    }


@router.get("/history")
def get_payment_history(
    auth_user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, Any]:
    """Get complete payment history for driver."""
    uid = auth_user["uid"]
    db = get_firestore()
    _get_driver_profile(db, uid)

    docs = db.collection("driverPayments").where("driverId", "==", uid).stream()
    history = [_format_payment_doc(d.id, d.to_dict() or {}) for d in docs]
    history.sort(key=lambda x: str(x.get("submittedAt") or ""), reverse=True)

    return {"ok": True, "history": history}


# ============ ADMIN ENDPOINTS ============

@admin_router.get("")
def admin_list_driver_payments(
    status_filter: Optional[str] = Query(None, alias="status"),
    week_filter: Optional[str] = Query(None, alias="weekId"),
    driver_filter: Optional[str] = Query(None, alias="driverId"),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """List driver payment submissions with optional filtering."""
    db = get_firestore()
    query = db.collection("driverPayments")

    if status_filter:
        query = query.where("status", "==", status_filter)
    if week_filter:
        query = query.where("weekId", "==", week_filter)
    if driver_filter:
        query = query.where("driverId", "==", driver_filter)

    docs = list(query.stream())
    payments = [_format_payment_doc(d.id, d.to_dict() or {}) for d in docs]
    payments.sort(key=lambda x: str(x.get("submittedAt") or ""), reverse=True)

    # Compute KPI summary metrics
    pending_count = sum(1 for p in payments if p["status"] == "submitted")
    approved_count = sum(1 for p in payments if p["status"] == "approved")
    declined_count = sum(1 for p in payments if p["status"] == "declined")

    pause_config = _get_pause_config(db)

    return {
        "ok": True,
        "payments": payments,
        "pauseConfig": pause_config,
        "summary": {
            "pendingCount": pending_count,
            "approvedCount": approved_count,
            "declinedCount": declined_count,
            "totalCount": len(payments),
        },
    }


@admin_router.get("/pause")
def admin_get_pause_settings(
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Get driver payment pause settings."""
    db = get_firestore()
    return {"ok": True, "pauseConfig": _get_pause_config(db)}


@admin_router.post("/pause")
def admin_set_pause_settings(
    body: AdminPauseRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Set or update driver weekly payment pause configuration."""
    db = get_firestore()
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    now = get_ist_now()
    doc_ref = db.collection("systemSettings").document("driverPaymentPause")

    payload = {
        "isPaused": body.isPaused,
        "startDate": body.startDate.strip() if body.startDate else None,
        "endDate": body.endDate.strip() if body.endDate else None,
        "message": (body.message or "Weekly payments are currently paused. Chill and relax — no payment is required during this period.").strip(),
        "updatedAt": now,
        "updatedByAdminEmail": admin_email,
        "updatedByAdminUid": admin_user.get("uid"),
    }

    doc_ref.set(payload, merge=True)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payment_pause_updated",
        target_type="systemSettings",
        target_id="driverPaymentPause",
        after=payload,
    )

    return {"ok": True, "message": "Payment pause settings updated successfully.", "pauseConfig": _get_pause_config(db)}


@admin_router.delete("/pause")
def admin_clear_pause_settings(
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Clear/unpause driver weekly payments immediately."""
    db = get_firestore()
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    now = get_ist_now()
    doc_ref = db.collection("systemSettings").document("driverPaymentPause")

    payload = {
        "isPaused": False,
        "startDate": None,
        "endDate": None,
        "message": "Weekly payments are active.",
        "updatedAt": now,
        "updatedByAdminEmail": admin_email,
        "updatedByAdminUid": admin_user.get("uid"),
    }

    doc_ref.set(payload, merge=True)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payment_pause_cleared",
        target_type="systemSettings",
        target_id="driverPaymentPause",
        after=payload,
    )

    return {"ok": True, "message": "Weekly payment pause ended. Normal payment schedule resumed.", "pauseConfig": _get_pause_config(db)}


@admin_router.post("/record-manual")
def admin_record_manual_payment(
    body: AdminRecordManualPaymentRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Record an offline/manual payment on behalf of a driver."""
    db = get_firestore()
    driver_uid = body.driverId.strip()
    profile = _get_driver_profile(db, driver_uid)

    week_info = get_payment_week_info()
    target_week_id = (body.weekId or week_info["weekId"]).strip()
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    now = get_ist_now()

    # Check for existing payment for driver and week
    existing_docs = list(
        db.collection("driverPayments")
        .where("driverId", "==", driver_uid)
        .where("weekId", "==", target_week_id)
        .stream()
    )

    doc_ref = None
    for doc_snap in existing_docs:
        d_data = doc_snap.to_dict() or {}
        if d_data.get("status") == "approved":
            raise ApiError(
                f"Driver already has an approved payment record for week {target_week_id}.", 409
            )
        # If there is a pending or declined payment for this week, update it
        doc_ref = doc_snap.reference

    if not doc_ref:
        doc_id = f"pymt_manual_{driver_uid}_{target_week_id}_{int(now.timestamp())}"
        doc_ref = db.collection("driverPayments").document(doc_id)

    payload = {
        "driverId": driver_uid,
        "driverName": profile.get("name", "Driver"),
        "driverPhone": profile.get("phone", ""),
        "weekId": target_week_id,
        "weekLabel": f"Week {target_week_id}",
        "amount": body.amount or DEFAULT_WEEKLY_FEE,
        "currency": "INR",
        "submittedAt": now,
        "status": "approved",
        "paymentReference": (body.paymentReference or "Offline / Cash Payment").strip(),
        "paymentMethod": (body.paymentMethod or "cash").strip().lower(),
        "isManualRecord": True,
        "verifiedAt": now,
        "verifiedByAdminUid": admin_user.get("uid"),
        "verifiedByAdminEmail": admin_email,
        "declineReason": None,
    }

    doc_ref.set(payload, merge=True)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payment_manual_recorded",
        target_type="driverPayments",
        target_id=doc_ref.id,
        after={
            "driverId": driver_uid,
            "weekId": target_week_id,
            "amount": body.amount,
            "paymentMethod": body.paymentMethod,
        },
    )

    return {
        "ok": True,
        "message": "Manual offline payment recorded and approved successfully.",
        "payment": _format_payment_doc(doc_ref.id, payload),
    }


@admin_router.post("/{payment_id}/approve")
def admin_approve_driver_payment(
    payment_id: str,
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Approve a driver's weekly payment submission."""
    db = get_firestore()
    doc_ref = db.collection("driverPayments").document(payment_id)
    snap = doc_ref.get()

    if not snap.exists:
        raise ApiError("Payment submission record not found.", 404)

    payment_data = snap.to_dict() or {}
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    now = get_ist_now()
    updates = {
        "status": "approved",
        "verifiedAt": now,
        "verifiedByAdminUid": admin_user.get("uid"),
        "verifiedByAdminEmail": admin_email,
        "declineReason": None,
    }

    doc_ref.update(updates)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payment_approved",
        target_type="driverPayments",
        target_id=payment_id,
        before=payment_data,
        after=updates,
    )

    updated_data = {**payment_data, **updates}
    return {
        "ok": True,
        "message": "Payment verified and approved.",
        "payment": _format_payment_doc(payment_id, updated_data),
    }


@admin_router.post("/{payment_id}/decline")
def admin_decline_driver_payment(
    payment_id: str,
    body: AdminDeclineRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Decline a driver's weekly payment submission."""
    db = get_firestore()
    doc_ref = db.collection("driverPayments").document(payment_id)
    snap = doc_ref.get()

    if not snap.exists:
        raise ApiError("Payment submission record not found.", 404)

    payment_data = snap.to_dict() or {}
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    now = get_ist_now()
    decline_reason = (body.declineReason or "Payment could not be verified by accounts team.").strip()

    updates = {
        "status": "declined",
        "verifiedAt": now,
        "verifiedByAdminUid": admin_user.get("uid"),
        "verifiedByAdminEmail": admin_email,
        "declineReason": decline_reason,
    }

    doc_ref.update(updates)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payment_declined",
        target_type="driverPayments",
        target_id=payment_id,
        before=payment_data,
        after=updates,
        notes=decline_reason,
    )

    updated_data = {**payment_data, **updates}
    return {
        "ok": True,
        "message": "Payment submission declined.",
        "payment": _format_payment_doc(payment_id, updated_data),
    }
