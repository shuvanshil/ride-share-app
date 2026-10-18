"""Authentication/session endpoints used during the Firebase migration."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends

from ..core.auth import current_user
from ..core.firebase import fb_auth, fb_firestore, get_admin_app
from ..core.otp import normalize_phone

router = APIRouter(prefix="/auth", tags=["auth"])


class CheckPhoneBody(BaseModel):
    phone: Optional[str] = None


@router.get("/session")
def session(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Return the verified Firebase identity without exposing the token."""
    return {
        "ok": True,
        "user": {
            "uid": user.get("uid", ""),
            "email": user.get("email", ""),
            "phone": user.get("phone_number", ""),
            "emailVerified": bool(user.get("email_verified", False)),
        },
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
            if hasattr(index_snap, "to_dict") and callable(index_snap.to_dict):
                idx_data = index_snap.to_dict() or {}
                role = idx_data.get("role")
                if not role:
                    uid = idx_data.get("uid")
                    if uid:
                        u_snap = db.collection("users").document(uid).get()
                        if getattr(u_snap, "exists", False) and hasattr(u_snap, "to_dict"):
                            role = (u_snap.to_dict() or {}).get("role")
                if not role:
                    role = "passenger"
            return {"ok": True, "exists": True, "phone": phone, "role": role}

        # 2. Fast check in Firebase Auth
        auth_client = fb_auth.Client(app)
        try:
            auth_client.get_user_by_phone_number(phone)
            return {"ok": True, "exists": True, "phone": phone, "role": "passenger"}
        except Exception:
            pass

        # 3. Fast check in users collection
        try:
            user_query = db.collection("users").where("phone", "==", phone).limit(1).get()
            if hasattr(user_query, "__len__") and len(user_query) > 0:
                first = user_query[0]
                role = "passenger"
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    role = (first.to_dict() or {}).get("role") or "passenger"
                return {"ok": True, "exists": True, "phone": phone, "role": role}

            user_query_alt = db.collection("users").where("phone_number", "==", phone).limit(1).get()
            if hasattr(user_query_alt, "__len__") and len(user_query_alt) > 0:
                first = user_query_alt[0]
                role = "passenger"
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    role = (first.to_dict() or {}).get("role") or "passenger"
                return {"ok": True, "exists": True, "phone": phone, "role": role}

            user_query_camel = db.collection("users").where("phoneNumber", "==", phone).limit(1).get()
            if hasattr(user_query_camel, "__len__") and len(user_query_camel) > 0:
                first = user_query_camel[0]
                role = "passenger"
                if hasattr(first, "to_dict") and callable(first.to_dict):
                    role = (first.to_dict() or {}).get("role") or "passenger"
                return {"ok": True, "exists": True, "phone": phone, "role": role}
        except Exception:
            pass

        return {"ok": True, "exists": False, "phone": phone}
    except Exception as e:
        return {"ok": True, "exists": False, "phone": phone, "warning": str(e)}

