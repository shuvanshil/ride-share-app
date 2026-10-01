"""Distributed request rate limiting for public API endpoints."""
from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import Request

from .config import require_env
from .errors import ApiError
from .firebase import get_firestore

RATE_LIMIT_COLLECTION = "rateLimits"


def client_address(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip() or "unknown"
    return (request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")).strip()


def rate_limit_key(scope: str, address: str) -> str:
    secret = require_env("RATE_LIMIT_SECRET")
    return hmac.new(secret.encode("utf-8"), f"{scope}:{address}".encode("utf-8"), hashlib.sha256).hexdigest()


def enforce_rate_limit(
    request: Request,
    scope: str,
    limit: int,
    window_seconds: int,
    subject: Optional[str] = None,
) -> None:
    if limit < 1 or window_seconds < 1:
        raise ValueError("Rate-limit values must be positive")

    subject_value = str(subject or "").strip()
    key_scope = f"{scope}:{subject_value}" if subject_value else scope
    document_id = rate_limit_key(key_scope, client_address(request))
    now = int(time.time())
    window_start = now - (now % window_seconds)
    db = get_firestore()
    reference = db.collection(RATE_LIMIT_COLLECTION).document(document_id)
    transaction = db.transaction()

    from firebase_admin import firestore

    @firestore.transactional
    def reserve(tx):
        snapshot = reference.get(transaction=tx)
        state = snapshot.to_dict() or {}
        stored_window = int(state.get("windowStart", 0) or 0)
        count = int(state.get("count", 0) or 0) if stored_window == window_start else 0
        if count >= limit:
            retry_after = max(1, window_start + window_seconds - now)
            raise ApiError("Too many requests. Please try again later.", 429, {"retryAfter": retry_after})
        tx.set(reference, {
            "scope": scope,
            "windowStart": window_start,
            "count": count + 1,
            "expiresAt": datetime.fromtimestamp(window_start + window_seconds * 2, timezone.utc),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }, merge=True)

    reserve(transaction)
