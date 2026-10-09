"""Driver Weekly Payments API Router.

Handles driver-side payment status queries, verification submissions,
payment history retrieval, payment pause settings, and admin offline manual payment recording.
Writes to `driverPayments` and `systemSettings` collections.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import datetime
import logging
import urllib.parse

from fastapi import APIRouter, Depends, Query, Body
from pydantic import BaseModel

from ..core.auth import current_user
from ..core.admin import require_admin, write_audit_log, now_utc
from ..core.config import get_env
from ..core.errors import ApiError
from ..core.firebase import get_admin_app, get_firestore, get_messaging, get_storage_bucket
from ..core.payment_schedule import (
    get_payment_week_info,
    get_week_info_for_week_id,
    allocate_payment_weeks,
    get_ist_now,
    is_date_in_pause_range,
    calculate_dues_and_upcoming,
    DEFAULT_WEEKLY_FEE,
    DEFAULT_PAYEE_UPI_ID,
    IST,
)

logger = logging.getLogger("driver_payments")

router = APIRouter(prefix="/account/driver-payments", tags=["driver-payments"])
admin_router = APIRouter(prefix="/admin/driver-payments", tags=["admin-driver-payments"])


class SubmitPaymentRequest(BaseModel):
    paymentReference: Optional[str] = None
    paymentMethod: Optional[str] = "upi"
    amount: Optional[float] = None
    baseFee: Optional[float] = None
    overdueAmount: Optional[float] = None
    proofStoragePath: Optional[str] = None
    proofDownloadUrl: Optional[str] = None
    proofFileName: Optional[str] = None
    proofFileSize: Optional[int] = None
    proofContentType: Optional[str] = None


class AdminDeclineRequest(BaseModel):
    declineReason: Optional[str] = "Payment could not be verified by accounts team."


class AdminCleanupStorageRequest(BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    dryRun: bool = False



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
        raise ApiError("User account not found.", 404)
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


def _get_reset_baseline_dt(db: Any, profile: Dict[str, Any]) -> Optional[datetime.datetime]:
    reset_baseline_dt = None
    try:
        reset_snap = db.collection("systemSettings").document("driverPaymentReset").get()
        if reset_snap.exists:
            r_val = (reset_snap.to_dict() or {}).get("resetAt")
            if r_val:
                if hasattr(r_val, "astimezone"):
                    reset_baseline_dt = r_val.astimezone(IST)
                elif isinstance(r_val, str):
                    reset_baseline_dt = datetime.datetime.fromisoformat(r_val.replace("Z", "+00:00")).astimezone(IST)
    except Exception:
        pass

    driver_reset = profile.get("paymentResetAt")
    if driver_reset:
        try:
            if hasattr(driver_reset, "astimezone"):
                dr_dt = driver_reset.astimezone(IST)
            elif isinstance(driver_reset, str):
                dr_dt = datetime.datetime.fromisoformat(driver_reset.replace("Z", "+00:00")).astimezone(IST)
            else:
                dr_dt = None
            if dr_dt and (not reset_baseline_dt or dr_dt > reset_baseline_dt):
                reset_baseline_dt = dr_dt
        except Exception:
            pass

    return reset_baseline_dt


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

    driver_id = data.get("driverId") or data.get("driver_id")
    week_id = data.get("weekId") or data.get("week_id")

    storage_path = (
        data.get("proofStoragePath")
        or data.get("proof_storage_path")
        or data.get("storagePath")
        or data.get("storage_path")
        or data.get("proofPath")
        or data.get("proof_path")
        or data.get("screenshotPath")
        or data.get("screenshot_path")
        or data.get("imagePath")
        or data.get("image_path")
        or data.get("filePath")
        or data.get("file_path")
    )
    download_url = (
        data.get("proofDownloadUrl")
        or data.get("proof_download_url")
        or data.get("proofUrl")
        or data.get("proof_url")
        or data.get("downloadUrl")
        or data.get("download_url")
        or data.get("screenshotUrl")
        or data.get("screenshot_url")
        or data.get("imageUrl")
        or data.get("image_url")
        or data.get("proof")
    )

    # If storage_path is missing or is a folder, inspect bucket to resolve the actual image file
    if driver_id:
        try:
            bucket = get_storage_bucket()
            if bucket:
                if not storage_path:
                    # Search bucket for this driver's uploaded proof
                    prefix = f"payment-proofs/{driver_id}/{doc_id}/" if doc_id else f"payment-proofs/{driver_id}/"
                    blobs = list(bucket.list_blobs(prefix=prefix, max_results=3))
                    if not blobs:
                        prefix_driver = f"payment-proofs/{driver_id}/"
                        for b in bucket.list_blobs(prefix=prefix_driver, max_results=20):
                            if week_id and week_id in b.name:
                                storage_path = b.name
                                break
                            if not storage_path:
                                storage_path = b.name
                    elif blobs:
                        storage_path = blobs[0].name
                elif storage_path and storage_path.endswith("/"):
                    # storage_path was saved as a directory prefix
                    blobs = list(bucket.list_blobs(prefix=storage_path, max_results=1))
                    if blobs:
                        storage_path = blobs[0].name
        except Exception:
            pass

    download_url = _resolve_proof_url(storage_path, download_url)

    covered_weeks = data.get("coveredWeeks") or data.get("covered_weeks")
    if not covered_weeks and week_id:
        covered_weeks = [week_id]

    amount_val = data.get("amount")
    if amount_val is not None:
        try:
            amount_val = float(amount_val)
        except (ValueError, TypeError):
            amount_val = DEFAULT_WEEKLY_FEE
    else:
        amount_val = DEFAULT_WEEKLY_FEE

    overdue_val = data.get("overdueAmount") or data.get("overdue_amount") or 0.0
    try:
        overdue_val = float(overdue_val)
    except (ValueError, TypeError):
        overdue_val = 0.0

    base_fee_val = data.get("baseFee") or data.get("base_fee") or DEFAULT_WEEKLY_FEE
    try:
        base_fee_val = float(base_fee_val)
    except (ValueError, TypeError):
        base_fee_val = DEFAULT_WEEKLY_FEE

    return {
        "paymentId": doc_id,
        "driverId": driver_id,
        "driverName": data.get("driverName") or data.get("driver_name", "Driver"),
        "driverPhone": data.get("driverPhone") or data.get("driver_phone", ""),
        "weekId": week_id,
        "weekLabel": data.get("weekLabel") or data.get("week_label", ""),
        "amount": amount_val,
        "baseFee": base_fee_val,
        "overdueAmount": overdue_val,
        "currency": data.get("currency", "INR"),
        "submittedAt": submitted_at_str,
        "status": data.get("status", "submitted"),
        "paymentReference": data.get("paymentReference") or data.get("payment_reference", ""),
        "paymentMethod": data.get("paymentMethod") or data.get("payment_method", "upi"),
        "proofStoragePath": storage_path,
        "proofDownloadUrl": download_url,
        "proofFileName": data.get("proofFileName") or data.get("proof_file_name"),
        "proofFileSize": data.get("proofFileSize") or data.get("proof_file_size"),
        "proofContentType": data.get("proofContentType") or data.get("proof_content_type"),
        "isManualRecord": bool(data.get("isManualRecord", False)),
        "coveredWeeks": covered_weeks or [],
        "submissionId": data.get("submissionId"),
        "submissionTotalAmount": data.get("submissionTotalAmount"),
        "instanceIndex": data.get("instanceIndex"),
        "instanceCount": data.get("instanceCount"),
        "verifiedAt": verified_at_str,
        "verifiedByAdminEmail": data.get("verifiedByAdminEmail") or data.get("verified_by_admin_email"),
        "declineReason": data.get("declineReason") or data.get("decline_reason"),
    }


def _send_payment_notification(
    db: Any,
    driver_id: str,
    status: str,
    amount: float,
    reason: Optional[str] = None,
) -> None:
    now = get_ist_now()
    if status == "submitted":
        title = "Payment Under Review"
        body = f"We received your payment proof of ₹{int(amount)}. Our team will verify it shortly."
        notif_type = "payment_submitted"
    elif status in ("approved", "verified"):
        title = "Payment Verified"
        body = f"Your weekly payment of ₹{int(amount)} has been confirmed. You're all set!"
        notif_type = "payment_verified"
    elif status == "declined":
        title = "Payment Declined"
        decline_msg = f": {reason}" if reason else "."
        body = f"Your payment could not be verified{decline_msg} Please make the payment again."
        notif_type = "payment_declined"
    else:
        return

    # 1. In-App Notification (Firestore)
    try:
        notif_ref = db.collection("users").document(driver_id).collection("inAppNotifications").document()
        notif_ref.set({
            "title": title,
            "body": body,
            "type": notif_type,
            "read": False,
            "createdAt": now,
            "amount": amount,
            "status": status,
            "reason": reason,
        })
    except Exception as exc:
        logger.warning("Failed to save in-app notification for driver %s: %s", driver_id, exc)

    # 2. Push Notification (FCM)
    try:
        driver_doc = db.collection("users").document(driver_id).get()
        if driver_doc.exists:
            driver_data = driver_doc.to_dict() or {}
            tokens = set()
            if driver_data.get("fcmToken"):
                tokens.add(str(driver_data["fcmToken"]).strip())
            if driver_data.get("pushToken"):
                tokens.add(str(driver_data["pushToken"]).strip())
            for detail in driver_data.get("pushTokenDetails") or []:
                if isinstance(detail, dict) and detail.get("token"):
                    tokens.add(str(detail["token"]).strip())

            valid_tokens = [t for t in tokens if t]
            if valid_tokens:
                app = get_admin_app()
                messaging = get_messaging()
                for tok in valid_tokens[:5]:
                    message = messaging.Message(
                        notification=messaging.Notification(title=title, body=body),
                        data={"type": notif_type, "click_action": "FLUTTER_NOTIFICATION_CLICK"},
                        token=tok,
                    )
                    messaging.send(message, app=app)
    except Exception as exc:
        logger.warning("Failed to send push notification for driver %s: %s", driver_id, exc)



@router.get("/status")
def get_driver_payment_status(
    auth_user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, Any]:
    """Retrieve driver's current week payment status and history."""
    uid = auth_user["uid"]
    db = get_firestore()
    profile = _get_driver_profile(db, uid)
    driver_created_at = (
        profile.get("createdAt")
        or profile.get("created_at")
        or profile.get("registrationDate")
        or profile.get("registration_date")
        or profile.get("approvedAt")
        or profile.get("approved_at")
    )

    pause_config = _get_pause_config(db)
    week_info = get_payment_week_info()
    current_week_id = week_info["weekId"]

    # Query all payment submissions for this driver (checking both driverId and legacy driver_id)
    seen_ids = set()
    docs = []
    for field in ("driverId", "driver_id"):
        try:
            for snap in db.collection("driverPayments").where(field, "==", uid).stream():
                if snap.id not in seen_ids:
                    seen_ids.add(snap.id)
                    docs.append(snap)
        except Exception:
            pass

    payment_history: List[Dict[str, Any]] = []
    current_week_submissions: List[Dict[str, Any]] = []

    for doc_snap in docs:
        p_data = _format_payment_doc(doc_snap.id, doc_snap.to_dict() or {})
        payment_history.append(p_data)
        if p_data["weekId"] == current_week_id:
            current_week_submissions.append(p_data)

    # Sort history by submittedAt descending
    payment_history.sort(
        key=lambda x: str(x.get("submittedAt") or ""), reverse=True
    )

    current_week_submissions.sort(
        key=lambda x: str(x.get("submittedAt") or ""), reverse=True
    )

    reset_baseline_dt = _get_reset_baseline_dt(db, profile)
    dues_info = calculate_dues_and_upcoming(
        payment_history, week_info, None, driver_created_at=driver_created_at, reset_baseline_dt=reset_baseline_dt
    )
    total_due = dues_info.get("totalAmountToBePaid", 0)
    unpaid_overdue = dues_info.get("previousUnpaidWeeks", [])
    is_curr_unpaid = dues_info.get("isCurrentWeekUnpaid", False)

    under_review_submissions = [p for p in payment_history if p.get("status") in ("submitted", "under_review")]
    declined_submissions = [p for p in payment_history if p.get("status") == "declined"]

    # Determine overall current week payment status (4 states: due, submitted/under_review, approved/verified, declined)
    if pause_config["isPaused"]:
        status_code = "paused"
        status_label = "Weekly Payments Paused"
        active_submission = current_week_submissions[0] if current_week_submissions else (payment_history[0] if payment_history else None)
    elif total_due > 0:
        due_week_ids = set(unpaid_overdue)
        if is_curr_unpaid:
            due_week_ids.add(current_week_id)

        declined_for_dues = [p for p in declined_submissions if p.get("weekId") in due_week_ids]

        if declined_for_dues:
            status_code = "declined"
            status_label = "Declined"
            active_submission = declined_for_dues[0]
        elif under_review_submissions:
            status_code = "submitted"
            status_label = "Under Review"
            active_submission = under_review_submissions[0]
        else:
            status_code = "due"
            status_label = "Pending"
            active_submission = current_week_submissions[0] if current_week_submissions else None
    else:
        # All dues are 0
        if under_review_submissions:
            status_code = "submitted"
            status_label = "Under Review"
            active_submission = under_review_submissions[0]
        else:
            status_code = "approved"
            status_label = "Verified"
            active_submission = current_week_submissions[0] if current_week_submissions else (payment_history[0] if payment_history else None)

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

    # Calculate authoritative dues dynamically on the server
    driver_created_at = (
        profile.get("createdAt")
        or profile.get("created_at")
        or profile.get("registrationDate")
        or profile.get("registration_date")
        or profile.get("approvedAt")
        or profile.get("approved_at")
    )
    seen_ids = set()
    all_payment_snaps = []
    for field in ("driverId", "driver_id"):
        try:
            for snap in db.collection("driverPayments").where(field, "==", uid).stream():
                if snap.id not in seen_ids:
                    seen_ids.add(snap.id)
                    all_payment_snaps.append(snap)
        except Exception:
            pass

    all_payments = [_format_payment_doc(d.id, d.to_dict() or {}) for d in all_payment_snaps]

    # Prevent duplicate submissions while existing payment is awaiting review
    pending_submissions = [
        p for p in all_payments
        if p.get("status") in ("submitted", "under_review")
    ]
    if pending_submissions:
        raise ApiError(
            "You already have a payment awaiting verification (Under Review). Please wait for approval before making another payment.", 409
        )

    reset_baseline_dt = _get_reset_baseline_dt(db, profile)
    dues_info = calculate_dues_and_upcoming(
        all_payments, week_info, "due", driver_created_at=driver_created_at, reset_baseline_dt=reset_baseline_dt
    )
    calculated_total = dues_info.get("totalAmountToBePaid", DEFAULT_WEEKLY_FEE)

    amount_to_pay = float(body.amount) if body.amount is not None else float(calculated_total)
    if amount_to_pay <= 0:
        amount_to_pay = float(DEFAULT_WEEKLY_FEE)

    if int(round(amount_to_pay)) % DEFAULT_WEEKLY_FEE != 0:
        raise ApiError(
            f"Payment amount must be a multiple of ₹{DEFAULT_WEEKLY_FEE} (e.g., ₹140, ₹280, ₹420).", 400
        )

    num_instances = max(1, int(round(amount_to_pay // DEFAULT_WEEKLY_FEE)))

    # Gather any weeks that already have approved or active submissions to prevent duplicate allocation
    existing_covered_weeks = set()
    for p in all_payments:
        st = p.get("status")
        w = p.get("weekId")
        if w and st in ("approved", "verified", "submitted", "under_review"):
            existing_covered_weeks.add(w)

    allocated_weeks = allocate_payment_weeks(
        unpaid_overdue_weeks=dues_info.get("previousUnpaidWeeks", []),
        current_week_id=current_week_id,
        is_current_week_unpaid=dues_info.get("isCurrentWeekUnpaid", True),
        num_weeks=num_instances,
    )

    # Double check that no allocated week is already awaiting verification
    for wid in allocated_weeks:
        for p in all_payments:
            if p.get("weekId") == wid and p.get("status") in ("submitted", "under_review"):
                raise ApiError(
                    f"Week {wid} already has a payment awaiting verification (Under Review).", 409
                )

    now_ms = int(datetime.datetime.now().timestamp() * 1000)
    submission_id = f"sub_{uid}_{now_ms}"
    resolved_proof_url = _resolve_proof_url(body.proofStoragePath, body.proofDownloadUrl)

    created_instances: List[Dict[str, Any]] = []

    for idx, wid in enumerate(allocated_weeks, 1):
        target_week_info = get_week_info_for_week_id(wid)
        instance_doc_id = f"pymt_{uid}_{wid}_{now_ms}"
        doc_payload = {
            "driverId": uid,
            "driverName": profile.get("name", auth_user.get("name", "Driver")),
            "driverPhone": profile.get("phone", auth_user.get("phone_number", "")),
            "weekId": wid,
            "weekLabel": target_week_info.get("weekLabel") or f"Week {wid}",
            "baseFee": float(DEFAULT_WEEKLY_FEE),
            "overdueAmount": 0.0,
            "amount": float(DEFAULT_WEEKLY_FEE),
            "currency": "INR",
            "submittedAt": get_ist_now(),
            "status": "submitted",
            "paymentReference": (body.paymentReference or "").strip()[:100],
            "paymentMethod": body.paymentMethod or "upi",
            "proofStoragePath": body.proofStoragePath,
            "proofDownloadUrl": resolved_proof_url,
            "proofFileName": body.proofFileName,
            "proofFileSize": body.proofFileSize,
            "proofContentType": body.proofContentType,
            "isManualRecord": False,
            "coveredWeeks": [wid],
            "submissionId": submission_id,
            "submissionTotalAmount": float(amount_to_pay),
            "instanceIndex": idx,
            "instanceCount": len(allocated_weeks),
            "verifiedAt": None,
            "verifiedByAdminUid": None,
            "verifiedByAdminEmail": None,
            "declineReason": None,
        }

        db.collection("driverPayments").document(instance_doc_id).set(doc_payload)
        created_instances.append(_format_payment_doc(instance_doc_id, doc_payload))

    # Send driver notification with full submitted amount
    _send_payment_notification(db, uid, "submitted", amount_to_pay)

    return {
        "ok": True,
        "message": f"Payment submitted for verification successfully ({len(allocated_weeks)} weekly session{'s' if len(allocated_weeks) > 1 else ''} of ₹{DEFAULT_WEEKLY_FEE}).",
        "submissionId": submission_id,
        "payments": created_instances,
        "payment": created_instances[0] if created_instances else {},
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
        # If there is a pending submission for this week, update it. Declined records remain in history.
        if d_data.get("status") in ("submitted", "under_review"):
            doc_ref = doc_snap.reference


    if not doc_ref:
        doc_id = f"pymt_manual_{driver_uid}_{target_week_id}_{int(now.timestamp() * 1000)}"
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

    week_id = payment_data.get("weekId") or payment_data.get("week_id")
    covered_weeks = payment_data.get("coveredWeeks") or payment_data.get("covered_weeks")
    if not covered_weeks and week_id:
        covered_weeks = [week_id]

    now = get_ist_now()
    updates = {
        "status": "approved",
        "verifiedAt": now,
        "verifiedByAdminUid": admin_user.get("uid"),
        "verifiedByAdminEmail": admin_email,
        "declineReason": None,
        "coveredWeeks": covered_weeks,
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

    _send_payment_notification(
        db,
        payment_data.get("driverId"),
        "approved",
        payment_data.get("amount", DEFAULT_WEEKLY_FEE),
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

    _send_payment_notification(
        db,
        payment_data.get("driverId"),
        "declined",
        payment_data.get("amount", DEFAULT_WEEKLY_FEE),
        reason=decline_reason,
    )

    updated_data = {**payment_data, **updates}
    return {
        "ok": True,
        "message": "Payment submission declined.",
        "payment": _format_payment_doc(payment_id, updated_data),
    }


@admin_router.post("/cleanup-storage")
def admin_cleanup_payment_storage(
    body: AdminCleanupStorageRequest = Body(...),
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Scan and delete old payment proof screenshots from Firebase Storage."""
    db = get_firestore()
    docs = list(db.collection("driverPayments").stream())
    matched_docs = []

    start_dt = None
    end_dt = None
    if body.startDate:
        try:
            start_dt = datetime.datetime.fromisoformat(body.startDate.replace("Z", "+00:00"))
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=datetime.timezone.utc)
        except Exception:
            pass
    if body.endDate:
        try:
            end_dt = datetime.datetime.fromisoformat(body.endDate.replace("Z", "+00:00"))
            if end_dt.tzinfo is None:
                end_dt = end_dt.replace(tzinfo=datetime.timezone.utc)
        except Exception:
            pass

    for d in docs:
        data = d.to_dict() or {}
        if not data.get("proofStoragePath"):
            continue

        sub_at = data.get("submittedAt")
        dt = None
        if hasattr(sub_at, "astimezone"):
            dt = sub_at.astimezone(datetime.timezone.utc)
        elif isinstance(sub_at, str):
            try:
                dt = datetime.datetime.fromisoformat(sub_at.replace("Z", "+00:00"))
            except Exception:
                pass
        elif isinstance(sub_at, (int, float)):
            try:
                dt = datetime.datetime.fromtimestamp(sub_at / 1000.0, datetime.timezone.utc)
            except Exception:
                pass

        if start_dt and dt and dt < start_dt:
            continue
        if end_dt and dt and dt > end_dt:
            continue

        matched_docs.append((d, data))

    deleted_count = 0
    errors = []

    if not body.dryRun and matched_docs:
        try:
            bucket = get_storage_bucket()
        except Exception as e:
            raise ApiError(f"Storage bucket connection failed: {e}", 500)

        deleted_paths = set()
        for doc_snap, data in matched_docs:
            raw_path = data.get("proofStoragePath")
            path = raw_path
            if path:
                if path.startswith("gs://"):
                    parts = path.replace("gs://", "", 1).split("/", 1)
                    path = parts[1] if len(parts) > 1 else ""
                path = path.lstrip("/")

            try:
                if path and path not in deleted_paths:
                    blob = bucket.blob(path)
                    if blob.exists():
                        blob.delete()
                    else:
                        # Fallback if path was stored with directory prefix
                        prefix = path.rstrip("/") + "/"
                        for b in bucket.list_blobs(prefix=prefix):
                            try:
                                b.delete()
                            except Exception:
                                pass
                    deleted_paths.add(raw_path)
                    deleted_paths.add(path)
                    deleted_count += 1
                doc_snap.reference.update({
                    "proofStoragePath": None,
                    "proofDownloadUrl": None,
                    "proofDeleted": True,
                    "proofDeletedAt": get_ist_now(),
                })
            except Exception as e:
                errors.append(f"Failed to delete {raw_path}: {e}")
    else:
        deleted_count = len(matched_docs)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payments_storage_cleanup",
        target_type="driverPayments",
        target_id="STORAGE",
        notes=f"Cleaned up {deleted_count} proof files. Dry run: {body.dryRun}",
    )

    return {
        "ok": True,
        "dryRun": body.dryRun,
        "matchedCount": len(matched_docs),
        "deletedCount": deleted_count,
        "errors": errors,
        "message": f"{'Dry run complete. Found' if body.dryRun else 'Successfully deleted'} {deleted_count} proof file(s)."
    }


@admin_router.post("/reset-all")
def admin_reset_all_driver_payments(
    admin_user: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    """Wipe/reset all driver payment records so every driver starts fresh from zeroth week with no dues."""
    db = get_firestore()
    docs = list(db.collection("driverPayments").stream())
    deleted_count = 0
    for doc in docs:
        doc.reference.delete()
        deleted_count += 1

    now = get_ist_now()
    week_info = get_payment_week_info()
    admin_email = admin_user.get("email") or admin_user.get("uid", "admin")

    # Set system-wide reset anchor so all drivers start fresh from current week with 0 dues
    reset_payload = {
        "resetAt": now,
        "resetWeekId": week_info["weekId"],
        "resetByAdminEmail": admin_email,
        "resetByAdminUid": admin_user.get("uid"),
    }
    db.collection("systemSettings").document("driverPaymentReset").set(reset_payload)

    write_audit_log(
        admin_user=admin_user,
        action="driver_payments_reset_all",
        target_type="driverPayments",
        target_id="ALL",
        notes=f"Deleted {deleted_count} payment records. Reset all drivers to current week {week_info['weekId']} with zero dues.",
    )

    return {
        "ok": True,
        "message": f"Successfully reset all driver payments. Deleted {deleted_count} records. All drivers start fresh with no dues.",
        "deletedCount": deleted_count,
        "resetWeekId": week_info["weekId"],
    }

