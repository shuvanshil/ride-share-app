"""
Admin Coupon API Router.

Provides administrative controls for:
- Listing all platform coupons (default & admin-created) with redemption metrics (GET /admin/coupons)
- Creating new promotional coupons (POST /admin/coupons)
- Activating/deactivating coupons (POST /admin/coupons/{id}/activate | deactivate)
- Soft-deleting / archiving coupons (DELETE /admin/coupons/{id})
- Viewing detailed redemption audit logs per coupon (GET /admin/coupons/{id}/redemptions)
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Path, Query
from firebase_admin import firestore as fb_firestore
from pydantic import BaseModel, Field

from ..core.admin import require_admin, write_audit_log
from ..core.coupon_service import (
    VALID_ADMIN_CATEGORIES,
    ensure_default_coupons,
    inr_to_paise,
    normalize_coupon_code,
    paise_to_inr_float,
    sanitize_dict_for_json,
)
from ..core.errors import ApiError
from ..core.firebase import get_firestore

router = APIRouter(prefix="/admin/coupons", tags=["admin-coupons"])


class CreateCouponRequest(BaseModel):
    code: str = Field(min_length=2, max_length=30)
    discountType: str = Field(pattern="^(fixed|percentage)$")
    discountValue: float = Field(gt=0)
    eligibilityCategory: str = Field(default="all_passengers")
    restrictedPassengerIds: Optional[List[str]] = Field(default_factory=list)
    description: Optional[str] = Field(default="", max_length=300)
    status: Optional[str] = Field(default="active", pattern="^(active|inactive)$")


class UpdateCouponRequest(BaseModel):
    description: Optional[str] = Field(default=None, max_length=300)
    status: Optional[str] = Field(default=None, pattern="^(active|inactive)$")
    eligibilityCategory: Optional[str] = None
    restrictedPassengerIds: Optional[List[str]] = None


@router.get("")
async def list_admin_coupons(
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Lists all default and admin-created coupons with usage counts and redemption metrics."""
    ensure_default_coupons(db)

    coupons_snap = db.collection("coupons").get()
    
    # Pre-count redemptions by couponId
    redemptions_snap = db.collection("couponRedemptions").where("status", "==", "completed").get()
    usage_counts: Dict[str, int] = {}
    total_subsidies_paise: Dict[str, int] = {}
    for r in redemptions_snap:
        r_data = r.to_dict() or {}
        c_id = r_data.get("couponId")
        if c_id:
            usage_counts[c_id] = usage_counts.get(c_id, 0) + 1
            disc_paise = int(r_data.get("calculatedDiscountPaise") or 0)
            total_subsidies_paise[c_id] = total_subsidies_paise.get(c_id, 0) + disc_paise

    coupons = []
    for doc in coupons_snap:
        data = doc.to_dict() or {}
        c_id = doc.id
        if data.get("isDeleted"):
            continue

        created_at = data.get("createdAt")
        created_iso = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at or "")

        updated_at = data.get("updatedAt")
        updated_iso = updated_at.isoformat() if hasattr(updated_at, "isoformat") else str(updated_at or "")

        disc_type = data.get("discountType", "fixed")
        disc_val = float(data.get("discountValue") or data.get("discountPercentage") or 0)
        
        redemptions_count = usage_counts.get(c_id, 0)
        subsidies_paise = total_subsidies_paise.get(c_id, 0)

        coupons.append({
            "couponId": c_id,
            "code": data.get("code", ""),
            "codeNormalized": data.get("codeNormalized", ""),
            "source": data.get("source", "admin"),
            "discountType": disc_type,
            "discountValue": disc_val,
            "discountAmountPaise": int(data.get("discountAmountPaise") or 0),
            "status": data.get("status", "active"),
            "eligibilityCategory": data.get("eligibilityCategory", "all_passengers"),
            "restrictedPassengerIds": data.get("restrictedPassengerIds") or [],
            "description": data.get("description", ""),
            "isDeletable": data.get("isDeletable", data.get("source") != "default"),
            "redemptionsCount": redemptions_count,
            "totalSubsidiesINR": paise_to_inr_float(subsidies_paise),
            "createdAt": created_iso,
            "updatedAt": updated_iso,
        })

    # Sort default first, then newest
    coupons.sort(key=lambda x: (0 if x["source"] == "default" else 1, x.get("createdAt", "")), reverse=False)

    return {
        "ok": True,
        "coupons": coupons,
        "validCategories": VALID_ADMIN_CATEGORIES,
    }


@router.post("")
async def create_admin_coupon(
    payload: CreateCouponRequest,
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Creates a new admin promotional coupon with case-insensitive unique code."""
    admin_uid = admin["uid"]
    normalized_code = normalize_coupon_code(payload.code)

    if not normalized_code or len(normalized_code) < 2:
        raise ApiError("Coupon code must be at least 2 alphanumeric characters.", 400)

    # Check for reserved / conflicting codes
    existing_query = db.collection("coupons").where("codeNormalized", "==", normalized_code).get()
    for doc in existing_query:
        d = doc.to_dict() or {}
        if not d.get("isDeleted"):
            raise ApiError(f"A coupon with code '{normalized_code}' already exists.", 400)

    if payload.eligibilityCategory not in VALID_ADMIN_CATEGORIES and payload.eligibilityCategory not in ("first_ride", "tenth_ride"):
        raise ApiError(f"Invalid eligibility category: {payload.eligibilityCategory}", 400)

    if payload.discountType == "percentage" and payload.discountValue > 100:
        raise ApiError("Percentage discount cannot exceed 100%.", 400)

    coupon_id = f"cpn_{uuid.uuid4().hex[:12]}"
    doc_ref = db.collection("coupons").document(coupon_id)

    disc_amount_paise = inr_to_paise(payload.discountValue) if payload.discountType == "fixed" else 0

    coupon_doc = {
        "couponId": coupon_id,
        "code": payload.code.strip().upper(),
        "codeNormalized": normalized_code,
        "source": "admin",
        "discountType": payload.discountType,
        "discountValue": payload.discountValue,
        "discountAmountPaise": disc_amount_paise,
        "status": payload.status or "active",
        "eligibilityCategory": payload.eligibilityCategory,
        "restrictedPassengerIds": [str(u).strip() for u in (payload.restrictedPassengerIds or []) if str(u).strip()],
        "description": payload.description or "",
        "usageLimitPerPassenger": 1,
        "isDeletable": True,
        "createdByAdminUid": admin_uid,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }

    doc_ref.set(coupon_doc)

    write_audit_log(
        db,
        admin_uid=admin_uid,
        action="CREATE_COUPON",
        target_id=coupon_id,
        target_type="coupon",
        metadata={
            "code": normalized_code,
            "discountType": payload.discountType,
            "discountValue": payload.discountValue,
            "category": payload.eligibilityCategory,
        },
    )

    return {
        "ok": True,
        "couponId": coupon_id,
        "code": normalized_code,
        "message": f"Coupon {normalized_code} created successfully.",
    }


@router.patch("/{coupon_id}")
async def update_admin_coupon(
    coupon_id: str = Path(..., min_length=1, max_length=160),
    payload: UpdateCouponRequest = Body(...),
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Updates an existing coupon's metadata or restriction settings."""
    admin_uid = admin["uid"]
    doc_ref = db.collection("coupons").document(coupon_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise ApiError("Coupon not found.", 404)
    data = snap.to_dict() or {}

    updates: Dict[str, Any] = {"updatedAt": fb_firestore.SERVER_TIMESTAMP}
    if payload.description is not None:
        updates["description"] = payload.description.strip()
    if payload.status is not None:
        updates["status"] = payload.status
    if payload.eligibilityCategory is not None:
        if payload.eligibilityCategory not in VALID_ADMIN_CATEGORIES:
            raise ApiError(f"Invalid eligibility category: {payload.eligibilityCategory}", 400)
        updates["eligibilityCategory"] = payload.eligibilityCategory
    if payload.restrictedPassengerIds is not None:
        updates["restrictedPassengerIds"] = [str(u).strip() for u in payload.restrictedPassengerIds if str(u).strip()]

    doc_ref.update(updates)

    write_audit_log(
        db,
        admin_uid=admin_uid,
        action="UPDATE_COUPON",
        target_id=coupon_id,
        target_type="coupon",
        metadata=sanitize_dict_for_json(updates),
    )

    return {"ok": True, "message": "Coupon updated successfully."}


@router.post("/{coupon_id}/activate")
async def activate_coupon(
    coupon_id: str = Path(..., min_length=1, max_length=160),
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Activates a coupon immediately."""
    admin_uid = admin["uid"]
    doc_ref = db.collection("coupons").document(coupon_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise ApiError("Coupon not found.", 404)

    doc_ref.update({"status": "active", "updatedAt": fb_firestore.SERVER_TIMESTAMP})

    write_audit_log(
        db,
        admin_uid=admin_uid,
        action="ACTIVATE_COUPON",
        target_id=coupon_id,
        target_type="coupon",
    )

    return {"ok": True, "message": "Coupon activated."}


@router.post("/{coupon_id}/deactivate")
async def deactivate_coupon(
    coupon_id: str = Path(..., min_length=1, max_length=160),
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Deactivates a coupon immediately so it cannot be newly redeemed."""
    admin_uid = admin["uid"]
    doc_ref = db.collection("coupons").document(coupon_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise ApiError("Coupon not found.", 404)

    doc_ref.update({"status": "inactive", "updatedAt": fb_firestore.SERVER_TIMESTAMP})

    write_audit_log(
        db,
        admin_uid=admin_uid,
        action="DEACTIVATE_COUPON",
        target_id=coupon_id,
        target_type="coupon",
    )

    return {"ok": True, "message": "Coupon deactivated."}


@router.delete("/{coupon_id}")
async def delete_or_archive_coupon(
    coupon_id: str = Path(..., min_length=1, max_length=160),
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """
    Deletes or archives an admin-created coupon.
    Rejects deletion of default platform coupons.
    Soft-deletes/archives coupons to preserve audit integrity of historical redemptions.
    """
    admin_uid = admin["uid"]
    doc_ref = db.collection("coupons").document(coupon_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise ApiError("Coupon not found.", 404)
    data = snap.to_dict() or {}

    if data.get("source") == "default" or not data.get("isDeletable", True):
        raise ApiError("Default platform coupons (such as WELCOME, SUPER10) cannot be deleted. You can deactivate them instead.", 400)

    # Soft delete to preserve audit history
    doc_ref.update({
        "status": "deleted",
        "isDeleted": True,
        "deletedAt": fb_firestore.SERVER_TIMESTAMP,
        "deletedByAdminUid": admin_uid,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    })

    write_audit_log(
        db,
        admin_uid=admin_uid,
        action="DELETE_COUPON",
        target_id=coupon_id,
        target_type="coupon",
        metadata={"code": data.get("code")},
    )

    return {"ok": True, "message": "Coupon archived successfully."}


@router.get("/{coupon_id}/redemptions")
async def get_coupon_redemptions(
    coupon_id: str = Path(..., min_length=1, max_length=160),
    admin: Dict[str, Any] = Depends(require_admin),
    db: Any = Depends(get_firestore),
):
    """Returns complete audit history of all redemptions for a coupon."""
    redemptions_snap = (
        db.collection("couponRedemptions")
        .where("couponId", "==", coupon_id)
        .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
        .limit(100)
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
            "passengerId": d.get("passengerId"),
            "driverId": d.get("driverId"),
            "rideId": d.get("rideId"),
            "calculatedDiscountINR": d.get("discountAmountINR", paise_to_inr_float(int(d.get("calculatedDiscountPaise") or 0))),
            "originalFareINR": paise_to_inr_float(int(d.get("originalFarePaise") or 0)),
            "remainingFareAfterINR": paise_to_inr_float(int(d.get("remainingFareAfterPaise") or 0)),
            "driverWalletTransactionId": d.get("driverWalletTransactionId"),
            "status": d.get("status", "completed"),
            "createdAt": created_iso,
        })
    return {
        "ok": True,
        "couponId": coupon_id,
        "redemptions": items,
    }
