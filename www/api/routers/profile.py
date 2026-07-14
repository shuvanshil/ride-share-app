"""Authenticated profile reads for the incremental backend migration."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from firebase_admin import firestore as fb_firestore

from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

router = APIRouter(prefix="/profile", tags=["profile"])


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
