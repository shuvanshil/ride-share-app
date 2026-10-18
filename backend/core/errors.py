"""
Shared error type for the API.

The original Node/Vercel functions always responded with JSON shaped like
``{"error": "message", ...extra}`` and a specific HTTP status code (see
``json(res, statusCode, payload)`` in the old ``_google.js`` / ``_otp.js``
helpers). The frontend (see js/login.js, js/profile.js, js/app.js, js/map.js)
reads ``data.error`` / ``data.message`` directly from the JSON body -- it does
NOT expect FastAPI's default ``{"detail": ...}`` shape.

`ApiError` + the exception handler registered in `index.py` reproduce that
exact contract so the existing frontend code keeps working unmodified.
"""
from __future__ import annotations

from typing import Any, Optional


class ApiError(Exception):
    """Raise this anywhere in the API layer to return a JSON error response.

    Mirrors the pattern of `const error = new Error(...); error.status = 400;`
    used throughout the original Vercel functions.
    """

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.extra = extra or {}

    def to_payload(self) -> dict[str, Any]:
        payload = {"error": self.message}
        payload.update(self.extra)
        return payload
