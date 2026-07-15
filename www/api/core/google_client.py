"""
Shared Google Maps helpers. Direct port of `www/api/_google.js`.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from .config import get_env
from .errors import ApiError

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def get_google_config() -> dict[str, str]:
    return {
        "browserKey": get_env("GOOGLE_MAPS_BROWSER_KEY"),
        "serverKey": get_env("GOOGLE_MAPS_SERVER_KEY"),
    }


def require_server_key() -> str:
    server_key = get_google_config()["serverKey"]
    if not server_key:
        raise ApiError("Missing GOOGLE_MAPS_SERVER_KEY.", 500)
    return server_key


async def fetch_json(
    url: str,
    method: str = "GET",
    headers: Optional[dict[str, str]] = None,
    json_body: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Equivalent of fetchJson() in _google.js: raises ApiError with the
    upstream status code + parsed body attached when the response isn't ok.
    """
    request_headers = {"Accept": "application/json", **(headers or {})}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.request(
            method, url, headers=request_headers, json=json_body
        )

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.is_error:
        message = (
            (data.get("error") or {}).get("message")
            if isinstance(data.get("error"), dict)
            else data.get("error_message")
        ) or f"HTTP {response.status_code}"
        raise ApiError(
            message,
            response.status_code,
            {"upstreamStatus": response.status_code, "upstreamData": data},
        )

    return data


def number_or_null(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN check
        return None
    return number
