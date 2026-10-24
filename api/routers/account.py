"""
Account lifecycle endpoints. Direct port of register-account.js,
reset-password.js, and delete-account.js.
"""
from __future__ import annotations

import re
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Header
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from pydantic import BaseModel, ConfigDict

from ..core.config import get_env, require_env
from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.firebase import get_admin_app
from ..core.otp import get_active_otp_provider_name, verify_token

router = APIRouter()
logger = logging.getLogger(__name__)

DRIVER_TERMS_VERSION = "2026-07-10"
DRIVER_PRIVACY_POLICY_VERSION = "2026-07-10"

ACTIVE_PASSENGER_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"]
ACTIVE_DRIVER_STATUSES = ["accepted", "arrived", "started", "en_route"]


def _clean_string(value: Any, max_length: int = 200) -> str:
    return str(value or "").strip()[:max_length]


def _normalize_email(value: Any) -> str:
    return _clean_string(value, 320).lower()


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    profilePhotoUrl: Optional[str] = None
    vehicleType: Optional[str] = None
    vehicleNumber: Optional[str] = None
    vehicleModel: Optional[str] = None
    drivingLicenseNumber: Optional[str] = None
    upiId: Optional[str] = None
    termsAccepted: Optional[bool] = None

class RegisterAccountBody(BaseModel):
    verificationToken: Optional[str] = None
    password: Optional[str] = None
    profile: Optional[dict[str, Any]] = None


class RegisterDriverBody(BaseModel):
    verificationToken: Optional[str] = None
    phone: Optional[str] = None
    password: Optional[str] = None
    profile: Optional[dict[str, Any]] = None


class ResetPasswordBody(BaseModel):
    verificationToken: Optional[str] = None
    password: Optional[str] = None


class DeleteAccountBody(BaseModel):
    confirmation: Optional[str] = None
    password: Optional[str] = None


class ProfileUpdateBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    email: str = ""
    gender: str | None = None
    profilePhotoUrl: str = ""
    vehicleType: str | None = None
    vehicleModel: str | None = None
    vehicleNumber: str | None = None
    drivingLicenseNumber: str | None = None
    upiId: str | None = None


def _validate_base_profile(profile: dict[str, Any]) -> dict[str, str]:
    name = _clean_string(profile.get("name"), 80)
    email = _normalize_email(profile.get("email"))
    role = "driver" if profile.get("role") == "driver" else "passenger"
    raw_gender = _clean_string(profile.get("gender"), 20).lower()
    gender = "Male" if raw_gender == "male" else ("Female" if raw_gender == "female" else "Others")

    if len(name) < 2:
        raise ApiError("Enter your full name.", 400)
    if email and not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        raise ApiError("Enter a valid email address.", 400)

    return {"name": name, "email": email, "role": role, "gender": gender}


def _build_profile(uid: str, phone: str, profile: dict[str, Any]) -> dict[str, Any]:
    base = _validate_base_profile(profile)
    profile_data: dict[str, Any] = {
        "uid": uid,
        "name": base["name"],
        "phone": phone,
        "email": base["email"],
        "role": base["role"],
        "gender": base["gender"],
        "phoneVerified": True,
        "authProvider": "password",
        "otpProvider": get_active_otp_provider_name(),
        "profileCompleted": True,
        "createdAt": datetime.now(timezone.utc),
    }

    if base["role"] == "driver":
        profile_photo_url = _clean_string(profile.get("profilePhotoUrl"), 1500)
        vehicle_type_raw = profile.get("vehicleType")
        vehicle_type = "auto" if vehicle_type_raw == "auto" else ("bike" if vehicle_type_raw == "bike" else "")
        vehicle_number = _clean_string(profile.get("vehicleNumber"), 20).upper()
        vehicle_model = _clean_string(profile.get("vehicleModel"), 80)
        license_number = _clean_string(profile.get("drivingLicenseNumber"), 30).upper()
        upi_id = _clean_string(profile.get("upiId"), 100).lower()

        if not vehicle_type or not vehicle_number or not vehicle_model or not license_number or not upi_id:
            raise ApiError("Drivers must add all required vehicle and payment details.", 400)

        if profile.get("termsAccepted") is not True:
            raise ApiError("Drivers must agree to LiphtUp's Terms and Conditions & Privacy Policy.", 400)

        accepted_at = datetime.now(timezone.utc)

        profile_data.update(
            {
                "profilePhotoUrl": profile_photo_url,
                "vehicleType": vehicle_type,
                "vehicle_type": vehicle_type,
                "vehicleNumber": vehicle_number,
                "vehicle_number": vehicle_number,
                "vehicleModel": vehicle_model,
                "vehicle_model": vehicle_model,
                "drivingLicenseNumber": license_number,
                "upiId": upi_id,
                "termsAccepted": True,
                "termsAcceptedAt": accepted_at,
                "termsVersion": DRIVER_TERMS_VERSION,
                "privacyPolicyAccepted": True,
                "privacyPolicyAcceptedAt": accepted_at,
                "privacyPolicyVersion": DRIVER_PRIVACY_POLICY_VERSION,
                "verificationStatus": "pending_review",
                "driverAvailability": "offline",
                "lifetime_earnings": 0,
                "total_completed_trips": 0,
            }
        )

    return profile_data


async def _phone_already_exists(auth_client: fb_auth.Client, db, phone: str) -> bool:
    try:
        auth_client.get_user_by_phone_number(phone)
        return True
    except Exception:
        pass

    index_snap = db.collection("phoneLoginIndex").document(phone).get()
    if index_snap.exists:
        return True

    user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
    if len(user_query) > 0:
        return True

    user_query_alt = db.collection("users").where("phone_number", "==", phone).limit(1).get()
    if len(user_query_alt) > 0:
        return True

    user_query_camel = db.collection("users").where("phoneNumber", "==", phone).limit(1).get()
    return len(user_query_camel) > 0


@router.post("/register-account")
async def register_account(body: RegisterAccountBody) -> dict[str, Any]:
    created_uid = ""
    auth_client: Optional[fb_auth.Client] = None

    try:
        token_payload = verify_token(body.verificationToken, "register")
        password = body.password or ""

        if len(password) < 6:
            raise ApiError("Password must be at least 6 characters.", 400)

        app = get_admin_app()
        auth_client = fb_auth.Client(app)
        db = fb_firestore.client(app)

        if await _phone_already_exists(auth_client, db, token_payload["phone"]):
            raise ApiError("An account already exists for this mobile number. Please login instead.", 409)

        base = _validate_base_profile(body.profile or {})
        clean_phone = token_payload["phone"].replace("+", "")
        effective_email = base["email"] or f"{clean_phone}@user.liphtup.in"
        create_user_kwargs: dict[str, Any] = {
            "password": password,
            "display_name": base["name"],
            "phone_number": token_payload["phone"],
            "email": effective_email,
        }

        user_record = auth_client.create_user(**create_user_kwargs)
        created_uid = user_record.uid

        # Enforce passenger role: register-account is strictly dedicated to passenger registration
        merged_profile_input = {**(body.profile or {}), **base, "role": "passenger"}
        profile_data = _build_profile(created_uid, token_payload["phone"], merged_profile_input)

        db.collection("users").document(created_uid).set(profile_data)
        db.collection("phoneLoginIndex").document(token_payload["phone"]).set(
            {
                "uid": created_uid,
                "email": effective_email,
                "role": "passenger",
                "phone": token_payload["phone"],
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        custom_token = auth_client.create_custom_token(created_uid)
        if isinstance(custom_token, bytes):
            custom_token = custom_token.decode("utf-8")

        response_profile = dict(profile_data)
        response_profile["createdAt"] = int(datetime.now(timezone.utc).timestamp() * 1000)

        return {"ok": True, "customToken": custom_token, "profile": response_profile}
    except ApiError:
        if created_uid and auth_client:
            try:
                auth_client.delete_user(created_uid)
            except Exception:  # noqa: BLE001
                pass
            try:
                db.collection("users").document(created_uid).delete()
            except Exception:  # noqa: BLE001
                pass
            try:
                db.collection("phoneLoginIndex").document(token_payload["phone"]).delete()
            except Exception:  # noqa: BLE001
                pass
        raise
    except Exception as error:  # noqa: BLE001
        if created_uid and auth_client:
            try:
                auth_client.delete_user(created_uid)
            except Exception:  # noqa: BLE001
                pass
            try:
                db.collection("users").document(created_uid).delete()
            except Exception:  # noqa: BLE001
                pass
            try:
                db.collection("phoneLoginIndex").document(token_payload["phone"]).delete()
            except Exception:  # noqa: BLE001
                pass
        raise ApiError("Could not create account. Please try again.", 500)


def _validate_driver_fields(profile: dict[str, Any]) -> dict[str, Any]:
    vehicle_type_raw = str(profile.get("vehicleType") or profile.get("vehicle_type") or "").strip().lower()
    vehicle_type = "auto" if vehicle_type_raw == "auto" else ("bike" if vehicle_type_raw == "bike" else "")
    vehicle_number = _clean_string(profile.get("vehicleNumber") or profile.get("vehicle_number"), 20).upper()
    vehicle_model = _clean_string(profile.get("vehicleModel") or profile.get("vehicle_model"), 80)
    license_number = _clean_string(
        profile.get("drivingLicenseNumber")
        or profile.get("licenseNumber")
        or profile.get("driving_license_number")
        or profile.get("license_number"),
        30,
    ).upper()
    upi_id = _clean_string(profile.get("upiId"), 100).lower()

    if vehicle_type not in {"bike", "auto"}:
        raise ApiError("Drivers must select Bike / Scooty or Auto.", 400)
    if not vehicle_number or not re.match(r"^[A-Z0-9 -]{4,20}$", vehicle_number):
        raise ApiError("Enter a valid vehicle registration number.", 400)
    if len(vehicle_model) < 2:
        raise ApiError("Enter the vehicle model.", 400)
    if not license_number or not re.match(r"^[A-Z0-9 -]{5,30}$", license_number):
        raise ApiError("Enter a valid driving licence number.", 400)
    if not upi_id or not re.match(r"^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$", upi_id):
        raise ApiError("Enter a valid UPI ID (e.g. name@upi).", 400)

    if profile.get("termsAccepted") is not True:
        raise ApiError("Drivers must agree to LiphtUp's Terms and Conditions & Privacy Policy.", 400)

    return {
        "vehicleType": vehicle_type,
        "vehicle_type": vehicle_type,
        "vehicleNumber": vehicle_number,
        "vehicle_number": vehicle_number,
        "vehicleModel": vehicle_model,
        "vehicle_model": vehicle_model,
        "drivingLicenseNumber": license_number,
        "upiId": upi_id,
        "termsAccepted": True,
    }


@router.post("/register-driver")
async def register_driver(body: RegisterDriverBody) -> dict[str, Any]:
    created_uid = ""
    auth_client: Optional[fb_auth.Client] = None

    try:
        token_payload = verify_token(body.verificationToken, "driver_register")
        token_phone = token_payload["phone"]

        if body.phone:
            from ..core.otp import normalize_phone
            submitted_phone = normalize_phone(body.phone)
            if not submitted_phone or submitted_phone != token_phone:
                raise ApiError("Submitted mobile number does not match verified number.", 400)

        password = body.password or ""
        profile_input = body.profile or {}

        # 1. Base personal info validation
        name = _clean_string(profile_input.get("name"), 80)
        email = _normalize_email(profile_input.get("email"))
        raw_gender = _clean_string(profile_input.get("gender"), 20).lower()
        gender = "Male" if raw_gender == "male" else ("Female" if raw_gender == "female" else "Others")

        if len(name) < 2:
            raise ApiError("Enter your full name.", 400)
        if email and not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
            raise ApiError("Enter a valid email address.", 400)

        # 2. Driver-specific fields validation
        driver_fields = _validate_driver_fields(profile_input)

        app = get_admin_app()
        auth_client = fb_auth.Client(app)
        db = fb_firestore.client(app)

        # 3. Check for existing account
        existing_index = db.collection("phoneLoginIndex").document(token_phone).get()
        existing_uid = None
        existing_role = None

        if existing_index.exists:
            idx_data = existing_index.to_dict() or {}
            existing_uid = idx_data.get("uid")
            existing_role = idx_data.get("role")

        if not existing_uid:
            user_query = db.collection("users").where("phone", "==", token_phone).limit(1).get()
            if not user_query:
                user_query = db.collection("users").where("phone_number", "==", token_phone).limit(1).get()
            if not user_query:
                user_query = db.collection("users").where("phoneNumber", "==", token_phone).limit(1).get()
            if user_query:
                u_data = user_query[0].to_dict() or {}
                existing_uid = u_data.get("uid") or user_query[0].id
                existing_role = u_data.get("role")
            else:
                try:
                    fb_u = auth_client.get_user_by_phone_number(token_phone)
                    if fb_u:
                        existing_uid = fb_u.uid
                except Exception:
                    pass

        # Authoritative check from users collection if UID is known
        if existing_uid:
            u_snap = db.collection("users").document(existing_uid).get()
            if u_snap.exists:
                actual_role = (u_snap.to_dict() or {}).get("role")
                if actual_role:
                    existing_role = actual_role

        if not existing_role and existing_uid:
            existing_role = "passenger"

        # If already registered as a driver, disallow duplicate driver profile
        if existing_role == "driver":
            raise ApiError("An account already exists for this mobile number. Please login instead.", 409)

        # Prevent upgrade if passenger has an in-flight ride
        if existing_uid and _has_active_ride(db, "passenger_id", existing_uid, ACTIVE_PASSENGER_STATUSES):
            raise ApiError("Cannot register as a driver while you have an active ride in progress.", 400)

        accepted_at = datetime.now(timezone.utc)

        # Case A: Existing passenger upgrading to driver account
        if existing_uid:
            user_ref = db.collection("users").document(existing_uid)
            u_snap = user_ref.get()
            existing_profile = u_snap.to_dict() or {} if u_snap.exists else {}

            driver_updates: dict[str, Any] = {
                "name": name,
                "email": email or existing_profile.get("email", ""),
                "gender": gender,
                "role": "driver",  # Trusted server-side driver role assignment
                "phone": token_phone,
                "phoneVerified": True,
                "vehicleType": driver_fields["vehicleType"],
                "vehicle_type": driver_fields["vehicle_type"],
                "vehicleNumber": driver_fields["vehicleNumber"],
                "vehicle_number": driver_fields["vehicle_number"],
                "vehicleModel": driver_fields["vehicleModel"],
                "vehicle_model": driver_fields["vehicle_model"],
                "drivingLicenseNumber": driver_fields["drivingLicenseNumber"],
                "upiId": driver_fields["upiId"],
                "termsAccepted": True,
                "termsAcceptedAt": accepted_at,
                "termsVersion": DRIVER_TERMS_VERSION,
                "privacyPolicyAccepted": True,
                "privacyPolicyAcceptedAt": accepted_at,
                "privacyPolicyVersion": DRIVER_PRIVACY_POLICY_VERSION,
                "verificationStatus": "pending_review",
                "driverAvailability": "offline",
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }

            clean_token_phone = token_phone.replace("+", "")
            effective_email = email or existing_profile.get("email") or f"{clean_token_phone}@user.liphtup.in"

            user_ref.set(driver_updates, merge=True)
            db.collection("phoneLoginIndex").document(token_phone).set(
                {
                    "uid": existing_uid,
                    "email": effective_email,
                    "role": "driver",
                    "phone": token_phone,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

            if password and len(password) >= 6:
                try:
                    update_kwargs: dict[str, Any] = {"password": password, "display_name": name}
                    if email:
                        update_kwargs["email"] = email
                    auth_client.update_user(existing_uid, **update_kwargs)
                except Exception:
                    pass

            custom_token = auth_client.create_custom_token(existing_uid)
            if isinstance(custom_token, bytes):
                custom_token = custom_token.decode("utf-8")

            response_profile = {**existing_profile, **driver_updates, "uid": existing_uid}
            response_profile["updatedAt"] = int(accepted_at.timestamp() * 1000)
            return {"ok": True, "customToken": custom_token, "profile": _sanitize_for_json(response_profile)}

        # Case B: Brand new driver account
        if len(password) < 6:
            raise ApiError("Password must be at least 6 characters.", 400)

        clean_token_phone = token_phone.replace("+", "")
        effective_email = email or f"{clean_token_phone}@user.liphtup.in"
        create_user_kwargs: dict[str, Any] = {
            "password": password,
            "display_name": name,
            "phone_number": token_phone,
            "email": effective_email,
        }

        user_record = auth_client.create_user(**create_user_kwargs)
        created_uid = user_record.uid

        profile_data: dict[str, Any] = {
            "uid": created_uid,
            "name": name,
            "phone": token_phone,
            "email": email,
            "role": "driver",  # Trusted server-side driver role assignment
            "gender": gender,
            "phoneVerified": True,
            "authProvider": "password",
            "otpProvider": get_active_otp_provider_name(),
            "profileCompleted": True,
            "createdAt": accepted_at,
            "vehicleType": driver_fields["vehicleType"],
            "vehicle_type": driver_fields["vehicle_type"],
            "vehicleNumber": driver_fields["vehicleNumber"],
            "vehicle_number": driver_fields["vehicle_number"],
            "vehicleModel": driver_fields["vehicleModel"],
            "vehicle_model": driver_fields["vehicle_model"],
            "drivingLicenseNumber": driver_fields["drivingLicenseNumber"],
            "upiId": driver_fields["upiId"],
            "termsAccepted": True,
            "termsAcceptedAt": accepted_at,
            "termsVersion": DRIVER_TERMS_VERSION,
            "privacyPolicyAccepted": True,
            "privacyPolicyAcceptedAt": accepted_at,
            "privacyPolicyVersion": DRIVER_PRIVACY_POLICY_VERSION,
            "verificationStatus": "pending_review",
            "driverAvailability": "offline",
            "lifetime_earnings": 0,
            "total_completed_trips": 0,
        }

        db.collection("users").document(created_uid).set(profile_data)
        db.collection("phoneLoginIndex").document(token_phone).set(
            {
                "uid": created_uid,
                "email": effective_email,
                "role": "driver",
                "phone": token_phone,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        custom_token = auth_client.create_custom_token(created_uid)
        if isinstance(custom_token, bytes):
            custom_token = custom_token.decode("utf-8")

        response_profile = dict(profile_data)
        response_profile["createdAt"] = int(accepted_at.timestamp() * 1000)

        return {"ok": True, "customToken": custom_token, "profile": _sanitize_for_json(response_profile)}
    except ApiError:
        if created_uid and auth_client:
            try:
                auth_client.delete_user(created_uid)
            except Exception:
                pass
            try:
                db.collection("users").document(created_uid).delete()
            except Exception:
                pass
            try:
                db.collection("phoneLoginIndex").document(token_phone).delete()
            except Exception:
                pass
        raise
    except Exception as error:
        if created_uid and auth_client:
            try:
                auth_client.delete_user(created_uid)
            except Exception:
                pass
            try:
                db.collection("users").document(created_uid).delete()
            except Exception:
                pass
            try:
                db.collection("phoneLoginIndex").document(token_phone).delete()
            except Exception:
                pass
        raise ApiError("Could not create driver account. Please try again.", 500)


@router.post("/reset-password")
async def reset_password(body: ResetPasswordBody) -> dict[str, Any]:
    try:
        token_payload = verify_token(body.verificationToken, "reset")
        password = body.password or ""

        if len(password) < 6:
            raise ApiError("Password must be at least 6 characters.", 400)

        app = get_admin_app()
        auth_client = fb_auth.Client(app)
        db = fb_firestore.client(app)

        phone = token_payload["phone"]
        login_index_snap = db.collection("phoneLoginIndex").document(phone).get()
        login_index = login_index_snap.to_dict() if login_index_snap.exists else None

        if not login_index:
            user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
            if user_query:
                doc = user_query[0]
                profile = doc.to_dict() or {}
                login_index = {
                    "uid": profile.get("uid") or doc.id,
                    "email": profile.get("email") or "",
                    "role": profile.get("role") or "passenger",
                    "phone": phone,
                }

        if not login_index or not login_index.get("uid"):
            raise ApiError("No LiphtUp account was found for this phone number.", 404)

        auth_client.update_user(login_index["uid"], password=password)

        if login_index.get("email"):
            db.collection("phoneLoginIndex").document(phone).set(
                {
                    "uid": login_index["uid"],
                    "email": login_index["email"],
                    "role": login_index.get("role") or "passenger",
                    "phone": phone,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

        return {"ok": True, "email": login_index.get("email") or "", "phone": phone}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not update password. Please try again.", 500)


def _get_bearer_token(authorization: Optional[str]) -> str:
    match = re.match(r"^Bearer\s+(.+)$", authorization or "", re.IGNORECASE)
    return match.group(1) if match else ""


async def _verify_password(email: str, password: str) -> Optional[dict[str, Any]]:
    web_api_key = require_env("FIREBASE_WEB_API_KEY")
    if not email or not password or not web_api_key:
        return None

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        response = await client.post(
            f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={web_api_key}",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            json={"email": email, "password": password, "returnSecureToken": True},
        )

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.is_error:
        provider_error = data.get("error") if isinstance(data, dict) else None
        provider_code = provider_error.get("message") if isinstance(provider_error, dict) else "unknown"
        logger.warning(
            "Firebase password verification rejected: status=%s code=%s",
            response.status_code,
            provider_code,
        )
        return None
    return data


def _has_active_ride(db, field_name: str, uid: str, statuses: list[str]) -> bool:
    docs = (
        db.collection("rides")
        .where(field_name, "==", uid)
        .where("status", "in", statuses)
        .limit(1)
        .get()
    )
    return len(docs) > 0


def _anonymize_ride_data(role: str) -> dict[str, Any]:
    deleted_at = fb_firestore.SERVER_TIMESTAMP
    if role == "driver":
        return {
            "driver_name": "Deleted driver",
            "driver_phone": "",
            "driver_profile_photo": "",
            "driver_deleted": True,
            "driver_deleted_at": deleted_at,
        }
    return {
        "passenger_name": "Deleted passenger",
        "passenger_phone": "",
        "passenger_profile_photo": "",
        "passenger_deleted": True,
        "passenger_deleted_at": deleted_at,
    }


def _anonymize_collection_by_participant(db, collection_name: str, field_name: str, uid: str, role: str) -> int:
    docs = db.collection(collection_name).where(field_name, "==", uid).get()
    if not docs:
        return 0

    updates = _anonymize_ride_data(role)
    batch = db.batch()
    count = 0
    pending_writes = 0

    for doc_snap in docs:
        batch.set(doc_snap.reference, updates, merge=True)
        count += 1
        pending_writes += 1

        if pending_writes == 450:
            batch.commit()
            batch = db.batch()
            pending_writes = 0

    if pending_writes:
        batch.commit()

    return count


def _remove_driver_from_pending_dispatches(db, uid: str) -> int:
    docs = db.collection("rides").where("eligible_driver_ids", "array_contains", uid).get()
    if not docs:
        return 0

    remove_uid = fb_firestore.ArrayRemove([uid])
    batch = db.batch()
    count = 0
    pending_writes = 0

    for doc_snap in docs:
        data = doc_snap.to_dict() or {}
        if data.get("status") != "pending":
            continue

        batch.update(
            doc_snap.reference,
            {
                "eligible_driver_ids": remove_uid,
                "notified_driver_ids": remove_uid,
                "rejected_driver_ids": remove_uid,
            },
        )
        count += 1
        pending_writes += 1

        if pending_writes == 450:
            batch.commit()
            batch = db.batch()
            pending_writes = 0

    if pending_writes:
        batch.commit()

    return count


def _delete_account_data(auth_client: fb_auth.Client, db, uid: str, profile: dict[str, Any]) -> None:
    role = "driver" if profile.get("role") == "driver" else "passenger"
    phone = profile.get("phone") or ""

    if _has_active_ride(db, "passenger_id", uid, ACTIVE_PASSENGER_STATUSES):
        raise ApiError("Please complete or cancel your active passenger ride before deleting your account.", 409)

    if _has_active_ride(db, "driver_id", uid, ACTIVE_DRIVER_STATUSES):
        raise ApiError("Please complete or cancel your active driver trip before deleting your account.", 409)

    if role == "driver":
        try:
            db.collection("driverPresence").document(uid).delete()
            db.collection("driverMapPresence").document(uid).delete()
        except Exception:  # noqa: BLE001
            pass

    _remove_driver_from_pending_dispatches(db, uid)
    _anonymize_collection_by_participant(db, "rides", "passenger_id", uid, "passenger")
    _anonymize_collection_by_participant(db, "rides", "driver_id", uid, "driver")
    _anonymize_collection_by_participant(db, "tripHistory", "passenger_id", uid, "passenger")
    _anonymize_collection_by_participant(db, "tripHistory", "driver_id", uid, "driver")

    try:
        db.collection("deletedAccounts").document(uid).set(
            {
                "uid": uid,
                "role": role,
                "deletedAt": fb_firestore.SERVER_TIMESTAMP,
                "phoneReleased": bool(phone),
                "emailReleased": bool(profile.get("email")),
            },
            merge=True,
        )
    except Exception:  # noqa: BLE001
        pass

    cleanup_batch = db.batch()
    cleanup_batch.delete(db.collection("users").document(uid))
    if phone:
        cleanup_batch.delete(db.collection("phoneLoginIndex").document(phone))
    cleanup_batch.commit()

    auth_client.delete_user(uid)


@router.post("/delete-account")
async def delete_account(body: DeleteAccountBody, authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    confirmation = (body.confirmation or "").strip()
    password = body.password or ""

    if confirmation != "DELETE":
        raise ApiError("Type DELETE to confirm permanent account deletion.", 400)
    if len(password) < 6:
        raise ApiError("Enter your account password to delete this account.", 400)

    id_token = _get_bearer_token(authorization)
    if not id_token:
        raise ApiError("Please login again before deleting your account.", 401)

    try:
        app = get_admin_app()
        auth_client = fb_auth.Client(app)
        db = fb_firestore.client(app)

        decoded_token = auth_client.verify_id_token(id_token, check_revoked=True)
        uid = decoded_token["uid"]

        auth_user = auth_client.get_user(uid)
        user_snap = db.collection("users").document(uid).get()
        profile = user_snap.to_dict() if user_snap.exists else {}

        email = auth_user.email or profile.get("email") or ""
        password_check = await _verify_password(email, password)

        if not password_check:
            logger.warning("Account deletion password verification failed before UID comparison")
            raise ApiError("The password you entered is incorrect.", 401)
        if password_check.get("localId") != uid:
            logger.warning("Account deletion password verification returned a different Firebase user")
            raise ApiError("The password you entered is incorrect.", 401)

        _delete_account_data(
            auth_client,
            db,
            uid,
            {**profile, "email": email, "phone": profile.get("phone") or auth_user.phone_number or ""},
        )

        return {"ok": True}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not delete your account. Please try again.", 500)


def _clean_profile_value(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _validate_profile_update(body: ProfileUpdateBody, role: str) -> dict[str, Any]:
    name = _clean_profile_value(body.name, 80)
    email = _clean_profile_value(body.email, 320).lower()
    photo = _clean_profile_value(body.profilePhotoUrl, 650000)

    if len(name) < 2:
        raise ApiError("Enter your full name.", 400)
    if email and not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        raise ApiError("Enter a valid email address.", 400)

    updates: dict[str, Any] = {
        "name": name,
        "email": email,
        "profilePhotoUrl": photo,
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
    }

    if body.gender is not None:
        raw_g = _clean_profile_value(body.gender, 20).lower()
        updates["gender"] = "Male" if raw_g == "male" else ("Female" if raw_g == "female" else "Others")

    if role != "driver":
        if any(
            value is not None
            for value in [
                body.vehicleType,
                body.vehicleModel,
                body.vehicleNumber,
                body.drivingLicenseNumber,
                body.upiId,
            ]
        ):
            raise ApiError("Driver fields are not allowed for passenger accounts.", 403)
        return updates

    vehicle_type = _clean_profile_value(body.vehicleType, 10).lower()
    vehicle_model = _clean_profile_value(body.vehicleModel, 80)
    vehicle_number = _clean_profile_value(body.vehicleNumber, 20).upper()
    license_number = _clean_profile_value(body.drivingLicenseNumber, 30).upper()
    upi_id = _clean_profile_value(body.upiId, 100).lower()

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


@router.get("/profile")
def get_profile(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Return the authenticated user's Firestore profile."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        db = fb_firestore.client(get_admin_app())
        snapshot = db.collection("users").document(uid).get()
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not load your profile.", 503)

    if not snapshot.exists:
        raise ApiError("User profile not found.", 404)

    profile = snapshot.to_dict() or {}
    profile.setdefault("uid", uid)
    profile.setdefault("gender", "Others")
    return {"ok": True, "profile": _sanitize_for_json(profile)}


@router.patch("/profile")
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
        updates = _validate_profile_update(body, role)

        auth_client = fb_auth.Client(app)
        auth_update_kwargs: dict[str, Any] = {"display_name": updates["name"]}
        if updates["email"]:
            auth_update_kwargs["email"] = updates["email"]
        auth_client.update_user(uid, **auth_update_kwargs)
        user_ref.update(updates)

        phone = existing.get("phone") or user.get("phone_number") or ""
        if phone and updates["email"] != existing.get("email"):
            db.collection("phoneLoginIndex").document(phone).set(
                {"email": updates["email"], "updatedAt": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )

        if role == "driver":
            private_presence_update = {
                "name": updates["name"],
                "phone": phone,
                "profilePhotoUrl": updates["profilePhotoUrl"],
                "vehicle_type": updates["vehicle_type"],
                "vehicle_model": updates["vehicle_model"],
                "vehicle_number": updates["vehicle_number"],
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }
            db.collection("driverPresence").document(uid).set(private_presence_update, merge=True)
            db.collection("driverMapPresence").document(uid).set(
                {
                    "uid": uid,
                    "name": updates["name"],
                    "vehicle_type": updates["vehicle_type"],
                    "vehicle_model": updates["vehicle_model"],
                    "verificationStatus": existing.get("verificationStatus") or "pending_review",
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

        updated_snapshot = user_ref.get()
        profile = updated_snapshot.to_dict() or {**existing, **updates}
        profile.setdefault("uid", uid)
        return {"ok": True, "profile": _sanitize_for_json(profile)}
    except ApiError:
        raise
    except fb_auth.EmailAlreadyExistsError:
        raise ApiError("That email address is already in use.", 409)
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not save your profile.", 503)


@router.post("/driver/acknowledge-approval")
@router.post("/driver-acknowledge-approval")
def acknowledge_driver_approval(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Mark driver approval notification as acknowledged in persistent database."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        user_ref = db.collection("users").document(uid)
        snap = user_ref.get()
        if not snap.exists:
            raise ApiError("User profile not found.", 404)

        profile = snap.to_dict() or {}
        if profile.get("role") != "driver":
            raise ApiError("Only driver accounts can acknowledge driver approval.", 403)
        if profile.get("verificationStatus") != "approved":
            raise ApiError("Only approved drivers can acknowledge approval.", 400)

        updates = {
            "approvalAcknowledged": True,
            "approvalAcknowledgedAt": fb_firestore.SERVER_TIMESTAMP,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        user_ref.set(updates, merge=True)

        updated_profile = {**profile, **updates, "approvalAcknowledged": True}
        updated_profile.setdefault("uid", uid)
        return {"ok": True, "profile": _sanitize_for_json(updated_profile)}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        logger.exception("Failed to acknowledge driver approval: %s", error)
        raise ApiError("Could not acknowledge approval.", 503)


@router.post("/driver/re-apply")
@router.post("/driver-reapply")
def reapply_driver_registration(
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Reset a rejected driver application back to pending_review."""
    uid = str(user.get("uid") or "").strip()
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)

    try:
        app = get_admin_app()
        db = fb_firestore.client(app)
        user_ref = db.collection("users").document(uid)
        snap = user_ref.get()
        if not snap.exists:
            raise ApiError("User profile not found.", 404)

        profile = snap.to_dict() or {}
        if profile.get("role") != "driver":
            raise ApiError("Only driver accounts can re-apply.", 403)
        if profile.get("verificationStatus") != "rejected":
            raise ApiError("Only rejected drivers can re-apply.", 400)

        updates = {
            "verificationStatus": "pending_review",
            "approvalAcknowledged": False,
            "rejectionReason": None,
            "driverAvailability": "offline",
            "desiredAvailability": "offline",
            "reappliedAt": fb_firestore.SERVER_TIMESTAMP,
            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        }
        user_ref.set(updates, merge=True)

        # Sync presence
        db.collection("driverPresence").document(uid).set(
            {
                "verificationStatus": "pending_review",
                "driverAvailability": "offline",
                "desiredAvailability": "offline",
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        db.collection("driverMapPresence").document(uid).set(
            {
                "verificationStatus": "pending_review",
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        updated_profile = {**profile, **updates, "verificationStatus": "pending_review", "rejectionReason": None}
        updated_profile.setdefault("uid", uid)
        return {"ok": True, "profile": _sanitize_for_json(updated_profile)}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        logger.exception("Failed to re-apply driver registration: %s", error)
        raise ApiError("Could not submit re-application.", 503)
