"""Admin read and analytics queries for the dispatch subsystem."""
from __future__ import annotations

import time
from typing import Any

from .config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_RUNS,
    COLLECTION_WPP,
)
from .runner import get_consecutive_errors


def get_dispatch_status(db: Any) -> dict[str, Any]:
    """Retrieve current operational status of the dispatch pool system."""
    if not db:
        return {"ok": False, "error": "db_not_initialized"}

    now = time.time()
    ctrl_data = {}
    try:
        snap = db.collection(COLLECTION_CONTROL).document("main").get()
        if snap.exists:
            ctrl_data = snap.to_dict() or {}
    except Exception:
        pass

    wpp_waiting = 0
    wpp_offered = 0
    try:
        wpp_waiting = len(list(db.collection(COLLECTION_WPP).where("state", "==", "WAITING").stream()))
        wpp_offered = len(list(db.collection(COLLECTION_WPP).where("state", "==", "OFFERED").stream()))
    except Exception:
        pass

    dap_idle = 0
    dap_share = 0
    dap_busy = 0
    try:
        dap_idle = len(list(db.collection(COLLECTION_DAP).where("state", "==", "IDLE").stream()))
        dap_share = len(list(db.collection(COLLECTION_DAP).where("state", "==", "SHARE_OPEN").stream()))
        dap_busy = len(list(db.collection(COLLECTION_DAP).where("state", "in", ["BUSY", "OFFERED"]).stream()))
    except Exception:
        pass

    consecutive_errs = get_consecutive_errors()
    lease_expires = float(ctrl_data.get("lease_expires_at") or 0.0)

    return {
        "ok": True,
        "timestamp": now,
        "consecutive_engine_errors": consecutive_errs,
        "fallback_active": consecutive_errs >= 3,
        "lease": {
            "holder": ctrl_data.get("lease_holder"),
            "active": lease_expires > now,
            "expires_in_sec": max(0.0, round(lease_expires - now, 2)),
        },
        "dirty": bool(ctrl_data.get("dirty")),
        "wpp": {
            "waiting": wpp_waiting,
            "offered": wpp_offered,
            "total": wpp_waiting + wpp_offered,
        },
        "dap": {
            "idle": dap_idle,
            "share_open": dap_share,
            "busy_or_offered": dap_busy,
            "total_available": dap_idle + dap_share,
        },
    }


def get_recent_runs(db: Any, limit: int = 20) -> list[dict[str, Any]]:
    """Retrieve history of recent dispatch runner execution cycles."""
    if not db:
        return []
    runs = []
    try:
        docs = (
            db.collection(COLLECTION_RUNS)
            .order_by("timestamp", direction="DESCENDING")
            .limit(limit)
            .stream()
        )
        for doc in docs:
            runs.append(doc.to_dict() or {})
    except Exception:
        # In case compound index not built, fetch without order_by
        try:
            docs = db.collection(COLLECTION_RUNS).limit(limit).stream()
            runs = [d.to_dict() or {} for d in docs]
        except Exception:
            pass
    return runs


def get_recent_assignments(db: Any, limit: int = 20) -> list[dict[str, Any]]:
    """Retrieve history of recent driver-passenger pairings."""
    if not db:
        return []
    assignments = []
    try:
        docs = (
            db.collection(COLLECTION_ASSIGNMENTS)
            .order_by("created_at", direction="DESCENDING")
            .limit(limit)
            .stream()
        )
        for doc in docs:
            assignments.append(doc.to_dict() or {})
    except Exception:
        try:
            docs = db.collection(COLLECTION_ASSIGNMENTS).limit(limit).stream()
            assignments = [d.to_dict() or {} for d in docs]
        except Exception:
            pass
    return assignments


def get_recent_events(db: Any, limit: int = 30) -> list[dict[str, Any]]:
    """Retrieve audit log of recent dispatch lifecycle events."""
    if not db:
        return []
    events = []
    try:
        docs = db.collection(COLLECTION_EVENTS).limit(limit).stream()
        events = [d.to_dict() or {} for d in docs]
        events.sort(key=lambda x: x.get("timestamp", 0.0), reverse=True)
    except Exception:
        pass
    return events


def get_ride_timeline(db: Any, ride_id: str) -> list[dict[str, Any]]:
    """Retrieve chronologically ordered lifecycle events for a given ride ID."""
    if not db or not ride_id:
        return []
    timeline = []
    try:
        stream = db.collection(COLLECTION_EVENTS).stream()
        for doc in stream:
            d = doc.to_dict() or {}
            details = d.get("details") or {}
            if (
                d.get("actor_id") == ride_id
                or str(details.get("ride_id") or "") == ride_id
                or str(details.get("passenger_id") or "") == ride_id
            ):
                timeline.append(d)
        timeline.sort(key=lambda x: x.get("timestamp", 0.0))
    except Exception:
        pass
    return timeline


def get_live_dispatch_stats(db: Any) -> dict[str, Any]:
    """Inspect invariants, data consistency, and live pool operational counters."""
    from .invariants import check_dispatch_invariants
    return check_dispatch_invariants(db)


def reconcile_daily_stats(db: Any, day: Optional[str] = None) -> dict[str, Any]:
    """Recompute daily dispatch counters and check against dispatchStatsDaily."""
    from .invariants import reconcile_daily
    return reconcile_daily(db, day)

