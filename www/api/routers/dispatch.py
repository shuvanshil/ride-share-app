"""Dispatch router exposing dispatch triggers and analytics endpoints."""
from __future__ import annotations

from typing import Any, Optional
from fastapi import APIRouter, Depends, Query, Request

from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.firebase import get_admin_app
from ..dispatch.queries import (
    get_dispatch_status,
    get_recent_assignments,
    get_recent_events,
    get_recent_runs,
)
from ..dispatch.runner import nudge_dispatch, run_dispatch
from ..dispatch.sweeper import run_dispatch_sweeper

import firebase_admin.firestore as fb_firestore


router = APIRouter(prefix="/dispatch", tags=["dispatch"])


def _get_db():
    try:
        return fb_firestore.client(get_admin_app())
    except Exception:
        return None


@router.post("/nudge")
def nudge_dispatch_endpoint() -> dict[str, Any]:
    """Trigger an immediate dispatch runner matching pass."""
    db = _get_db()
    result = run_dispatch(db, force=False)
    return {"ok": True, "result": result}


@router.post("/sweep")
def sweep_dispatch_endpoint() -> dict[str, Any]:
    """Trigger an immediate dispatch sweeper maintenance pass."""
    db = _get_db()
    result = run_dispatch_sweeper(db)
    return {"ok": True, "result": result}


@router.get("/status")
def status_dispatch_endpoint(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    """Return current dispatch operational and pool status."""
    db = _get_db()
    return get_dispatch_status(db)


@router.get("/runs")
def runs_dispatch_endpoint(
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Return recent dispatch solver runs."""
    db = _get_db()
    return {"ok": True, "runs": get_recent_runs(db, limit=limit)}


@router.get("/assignments")
def assignments_dispatch_endpoint(
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Return recent dispatch assignments."""
    db = _get_db()
    return {"ok": True, "assignments": get_recent_assignments(db, limit=limit)}


@router.get("/events")
def events_dispatch_endpoint(
    limit: int = Query(default=30, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Return recent dispatch lifecycle events."""
    db = _get_db()
    return {"ok": True, "events": get_recent_events(db, limit=limit)}
