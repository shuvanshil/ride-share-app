"""Authentication/session endpoints used during the Firebase migration."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..core.auth import current_user

router = APIRouter(prefix="/auth", tags=["auth"])


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
