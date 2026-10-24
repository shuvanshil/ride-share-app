"""Authentication/session endpoints used during the Firebase migration."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends

from ..core.auth import current_user, SEVEN_DAYS_SECONDS
from ..core.errors import ApiError
from ..core.firebase import fb_auth, fb_firestore, get_admin_app
from ..core.otp import normalize_phone

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


class CheckPhoneBody(BaseModel):
    phone: Optional[str] = None


@router.post("/logout")
def logout(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Revoke user refresh tokens server-side and mark session revoked in Firestore."""
    uid = user.get("uid", "")
    if uid:
        try:
            app = get_admin_app()
            # 1. Revoke Firebase refresh tokens server-side
            fb_auth.revoke_refresh_tokens(uid, app=app)
            # 2. Mark session revoked in Firestore
            db = fb_firestore.client(app)
            now_ts = datetime.now(timezone.utc)
            db.collection("userSessions").document(uid).set({
                "uid": uid,
                "revokedAt": now_ts,
                "isRevoked": True,
                "lastActivityAt": now_ts,
            }, merge=True)
        except Exception as e:
            logger.warning("Error revoking session for %s: %s", uid, e)
    return {"ok": True, "message": "Logged out and session revoked successfully."}


@router.get("/session")
def session(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Return the verified Firebase identity, validate 7-day inactivity, and return authoritative expiry."""
    uid = user.get("uid", "")
    app = get_admin_app()
    db = fb_firestore.client(app)

    now = datetime.now(timezone.utc)
    now_epoch = int(now.timestamp())
    sess_ref = db.collection("userSessions").document(uid)
    snap = sess_ref.get()

    if getattr(snap, "exists", False) and hasattr(snap, "to_dict"):
        data = snap.to_dict() or {}
        last_act = data.get("lastActivityAt")
        if last_act:
            last_epoch = int(last_act.timestamp()) if hasattr(last_act, "timestamp") else int(last_act or 0)
            if last_epoch > 1e11:
                last_epoch = int(last_epoch / 1000)
            if last_epoch > 0 and (now_epoch - last_epoch) > SEVEN_DAYS_SECONDS:
                raise ApiError("Session expired due to 7 days of inactivity. Please login again.", 401)

    expires_at_epoch = now_epoch + SEVEN_DAYS_SECONDS
    sess_ref.set({
        "uid": uid,
        "lastActivityAt": now,
        "expiresAt": datetime.fromtimestamp(expires_at_epoch, timezone.utc),
        "isRevoked": False,
    }, merge=True)

    return {
        "ok": True,
        "user": {
            "uid": uid,
            "email": user.get("email", ""),
            "phone": user.get("phone_number", ""),
            "emailVerified": bool(user.get("email_verified", False)),
        },
        "lastMeaningfulActivityAt": now_epoch * 1000,
        "expiresAt": expires_at_epoch * 1000,
    }


@router.post("/activity")
def activity(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Renew authoritative 7-day inactivity deadline on meaningful activity."""
    uid = user.get("uid", "")
    app = get_admin_app()
    db = fb_firestore.client(app)

    now = datetime.now(timezone.utc)
    now_epoch = int(now.timestamp())
    sess_ref = db.collection("userSessions").document(uid)
    expires_at_epoch = now_epoch + SEVEN_DAYS_SECONDS

    sess_ref.set({
        "uid": uid,
        "lastActivityAt": now,
        "expiresAt": datetime.fromtimestamp(expires_at_epoch, timezone.utc),
        "isRevoked": False,
    }, merge=True)

    return {
        "ok": True,
        "lastMeaningfulActivityAt": now_epoch * 1000,
        "expiresAt": expires_at_epoch * 1000,
    }


@router.post("/check-phone")
async def check_phone(body: CheckPhoneBody) -> dict[str, Any]:
    """Fast check to see if a user with the phone number already exists."""
    raw_phone = (body.phone or "").strip()
    phone = normalize_phone(raw_phone)
    if not phone:
        return {"ok": True, "exists": False, "phone": raw_phone}

    try:
        app = get_admin_app()
        db = fb_firestore.client(app)

        # 1. Fast indexed lookup in phoneLoginIndex
        index_snap = db.collection("phoneLoginIndex").document(phone).get()
        if getattr(index_snap, "exists", False):
            role = "passenger"
            email = ""
            if hasattr(index_snap, "to_dict") and callable(index_snap.to_dict):
                idx_data = index_snap.to_dict() or {}
                role = idx_data.get("role")
                email = idx_data.get("email") or ""
                uid = idx_data.get("uid")
                if not role or not email:
                    if uid:
                        u_snap = db.collection("users").document(uid).get()
                        if getattr(u_snap, "exists", False) and hasattr(u_snap, "to_dict"):
                            u_data = u_snap.to_dict() or {}
                            if not role:
                                role = u_data.get("role")
                            if not email:
                                email = u_data.get("email") or ""
                if not role:
                    role = "passenger"
            if not email:
                email = f"{phone.replace('+', '')}@user.liphtup.in"
            return {"ok": True, "exists": True, "phone": phone, "role": role, "email": email}

        # 2. Fast check in Firebase Auth
        auth_client = fb_auth.Client(app)
        try:
            fb_u = auth_client.get_user_by_phone_number(phone)
            email = getattr(fb_u, "email", None) or f"{phone.replace('+', '')}@user.liphtup.in"
            return {"ok": True, "exists": True, "phone": phone, "role": "passenger", "email": email}
        except Exception:
            pass

        # 3. Fast check in users collection
        try:
            user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
            if hasattr(user_query, "__len__") and len(user_query) > 0:
                first = user_query[0]
                role = "passenger"
                email = ""
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    u_dict = first.to_dict() or {}
                    role = u_dict.get("role") or "passenger"
                    email = u_dict.get("email") or ""
                if not email:
                    email = f"{phone.replace('+', '')}@user.liphtup.in"
                return {"ok": True, "exists": True, "phone": phone, "role": role, "email": email}

            user_query_alt = db.collection("users").where("phone_number", "==", phone).limit(1).get()
            if hasattr(user_query_alt, "__len__") and len(user_query_alt) > 0:
                first = user_query_alt[0]
                role = "passenger"
                email = ""
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    u_dict = first.to_dict() or {}
                    role = u_dict.get("role") or "passenger"
                    email = u_dict.get("email") or ""
                if not email:
                    email = f"{phone.replace('+', '')}@user.liphtup.in"
                return {"ok": True, "exists": True, "phone": phone, "role": role, "email": email}

            user_query_camel = db.collection("users").where("phoneNumber", "==", phone).limit(1).get()
            if hasattr(user_query_camel, "__len__") and len(user_query_camel) > 0:
                first = user_query_camel[0]
                role = "passenger"
                email = ""
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    u_dict = first.to_dict() or {}
                    role = u_dict.get("role") or "passenger"
                    email = u_dict.get("email") or ""
                if not email:
                    email = f"{phone.replace('+', '')}@user.liphtup.in"
                return {"ok": True, "exists": True, "phone": phone, "role": role, "email": email}
        except Exception:
            pass

        return {"ok": True, "exists": False, "phone": phone}
    except Exception as e:
        return {"ok": True, "exists": False, "phone": phone, "warning": str(e)}
