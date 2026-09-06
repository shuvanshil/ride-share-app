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
        if index_snap.exists:
            return {"ok": True, "exists": True, "phone": phone}

        # 2. Fast check in Firebase Auth
        auth_client = fb_auth.Client(app)
        try:
            auth_client.get_user_by_phone_number(phone)
            return {"ok": True, "exists": True, "phone": phone}
        except Exception:
            pass

        return {"ok": True, "exists": False, "phone": phone}
    except Exception as e:
        return {"ok": True, "exists": False, "phone": phone, "warning": str(e)}

