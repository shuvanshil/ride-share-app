"""Authenticated profile reads for the incremental backend migration."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from pydantic import BaseModel, ConfigDict

from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

router = APIRouter(prefix="/profile", tags=["profile"])


class ProfileUpdateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    email: str
    profilePhotoUrl: str = ""
    vehicleType: str | None = None
    vehicleModel: str | None = None
    vehicleNumber: str | None = None
    drivingLicenseNumber: str | None = None
    upiId: str | None = None


def _clean(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _validate_update(body: ProfileUpdateBody, role: str) -> dict[str, Any]:
    name = _clean(body.name, 80)
    email = _clean(body.email, 320).lower()
    photo = _clean(body.profilePhotoUrl, 650000)

    if len(name) < 2:
        raise ApiError("Enter your full name.", 400)
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        raise ApiError("Enter a valid email address.", 400)

    updates: dict[str, Any] = {
        "name": name,
        "email": email,
        "profilePhotoUrl": photo,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }

    if role != "driver":
        driver_values = [
            body.vehicleType,
            body.vehicleModel,
            body.vehicleNumber,
            body.drivingLicenseNumber,
            body.upiId,
        ]
        if any(value is not None for value in driver_values):
            raise ApiError("Driver fields are not allowed for passenger accounts.", 403)
        return updates

    vehicle_type = _clean(body.vehicleType, 10).lower()
    vehicle_model = _clean(body.vehicleModel, 80)
    vehicle_number = _clean(body.vehicleNumber, 20).upper()
    license_number = _clean(body.drivingLicenseNumber, 30).upper()
    upi_id = _clean(body.upiId, 100).lower()

    if vehicle_type not in {"bike", "auto"}:
        raise ApiError("Select Bike / Scooty or Auto as your ride service.", 400)
    if len(vehicle_model) < 2:
        raise ApiError("Enter the registered vehicle model.", 400)
    if not re.match(r"^[A-Z0-9 -]{4,20}$", vehicle_number, re.IGNORECASE):
        raise ApiError("Enter a valid vehicle number.", 400)
    if not re.match(r"^[A-Z0-9 -]{5,30}$", license_number, re.IGNORECASE):
        raise ApiError("Enter a valid driving licence number.", 400)
    if not re.match(r"^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$", upi_id, re.IGNORECASE):
        raise ApiError("Enter a valid UPI ID.", 400)

    updates.update(
        {
            "vehicleType": vehicle_type,
            "vehicle_type": vehicle_type,
            "vehicleModel": vehicle_model,
            "vehicle_model": vehicle_model,
            "vehicleNumber": vehicle_number,
            "vehicle_number": vehicle_number,
            "drivingLicenseNumber": license_number,
            "upiId": upi_id,
        }
    )
    return updates


@router.get("")
def get_profile(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Return the authenticated user's Firestore profile.

    This is deliberately read-only in the first migration step. Profile
    writes will be moved only after their validation and Firebase Auth email
    synchronization rules are finalized.
    """
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        db = fb_firestore.client(get_admin_app())
        snapshot = db.collection("users").document(uid).get()
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not load your profile.", 503, {"message": str(error)})

    if not snapshot.exists:
        raise ApiError("User profile not found.", 404)

    profile = snapshot.to_dict() or {}
    profile.setdefault("uid", uid)
    return {"ok": True, "profile": profile}


@router.patch("")
def update_profile(
    body: ProfileUpdateBody,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Validate and update the authenticated user's profile."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        user_ref = db.collection("users").document(uid)
        snapshot = user_ref.get()
        if not snapshot.exists:
            raise ApiError("User profile not found.", 404)

        existing = snapshot.to_dict() or {}
        role = "driver" if existing.get("role") == "driver" else "passenger"
        updates = _validate_update(body, role)

        # Keep Firebase Auth's login email/display name aligned with the
        # profile document. Firebase rejects duplicate email addresses.
        fb_auth.update_user(uid, email=updates["email"], display_name=updates["name"])
        user_ref.update(updates)

        phone = existing.get("phone") or user.get("phone_number") or ""
        if phone and updates["email"] != existing.get("email"):
            db.collection("phoneLoginIndex").document(phone).set(
                {"email": updates["email"], "updatedAt": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )

        if role == "driver":
            db.collection("driverPresence").document(uid).set(
                {
                    "name": updates["name"],
                    "phone": phone,
                    "profilePhotoUrl": updates["profilePhotoUrl"],
                    "vehicle_type": updates["vehicle_type"],
                    "vehicle_model": updates["vehicle_model"],
                    "vehicle_number": updates["vehicle_number"],
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

        updated_snapshot = user_ref.get()
        profile = updated_snapshot.to_dict() or {**existing, **updates}
        profile.setdefault("uid", uid)
        return {"ok": True, "profile": profile}
    except ApiError:
        raise
    except fb_auth.EmailAlreadyExistsError:
        raise ApiError("That email address is already in use.", 409)
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not save your profile.", 503, {"message": str(error)})
