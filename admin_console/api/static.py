"""Serves admin-console static files from the isolated admin_console tree."""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from api.core.errors import ApiError

router = APIRouter(prefix="/admin-console-static", tags=["admin-static"])

STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


@router.get("/{asset_path:path}")
def get_admin_asset(asset_path: str):
    requested = (STATIC_ROOT / asset_path).resolve()
    try:
        requested.relative_to(STATIC_ROOT)
    except ValueError as exc:
        raise ApiError("Admin asset not found.", 404) from exc
    if not requested.is_file():
        raise ApiError("Admin asset not found.", 404)

    media_type = mimetypes.guess_type(str(requested))[0]
    return FileResponse(requested, media_type=media_type)
