"""Invariants and data-consistency checker for dispatch pools and daily reconciliation."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

from .config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_NOTIFY_ME,
    COLLECTION_RUNS,
    COLLECTION_SCHEDULED,
    COLLECTION_STATS,
    COLLECTION_STATS_DAILY,
    COLLECTION_WPP,
    SWEEPER_GRACE_PERIOD_SEC,
)


def _safe_ts(val: Any) -> float | None:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if hasattr(val, "timestamp"):
        return float(val.timestamp())
    if isinstance(val, str):
        try:
            return float(datetime.fromisoformat(val.replace("Z", "+00:00")).timestamp())
        except Exception:
            return None
    return None


def reconcile_daily(db: Any, day: Optional[str] = None) -> dict[str, Any]:
    """Recompute daily counters from dispatchEvents and dispatchAssignments and check against dispatchStatsDaily.
    
    Args:
        db: Firestore database client
        day: Target date string in YYYY-MM-DD format (defaults to UTC today)
    """
    if not db:
        return {"ok": False, "error": "db_not_initialized"}

    if not day:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Start and end timestamps for the day in UTC
    dt_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start_ts = dt_start.timestamp()
    end_ts = start_ts + 86400.0

    # 1. Tally from dispatchAssignments
    asgn_count = 0
    asgn_offered = 0
    asgn_accepted = 0
    try:
        docs = db.collection(COLLECTION_ASSIGNMENTS).stream()
        for doc in docs:
            d = doc.to_dict() or {}
            c_ts = _safe_ts(d.get("created_at") or d.get("timestamp"))
            if c_ts and start_ts <= c_ts < end_ts:
                asgn_count += 1
                st = str(d.get("state") or "").lower()
                if st in ("offered", "pending"):
                    asgn_offered += 1
                elif st in ("accepted", "completed"):
                    asgn_accepted += 1
    except Exception:
        pass

    # 2. Tally from dispatchEvents
    events_count = 0
    events_by_type: dict[str, int] = {}
    try:
        docs = db.collection(COLLECTION_EVENTS).stream()
        for doc in docs:
            d = doc.to_dict() or {}
            t_ts = _safe_ts(d.get("timestamp"))
            if t_ts and start_ts <= t_ts < end_ts:
                events_count += 1
                etype = str(d.get("event_type") or "unknown")
                events_by_type[etype] = events_by_type.get(etype, 0) + 1
    except Exception:
        pass

    # 3. Fetch stored daily stats record
    daily_record = {}
    try:
        snap = db.collection(COLLECTION_STATS_DAILY).document(day).get()
        if getattr(snap, "exists", False):
            daily_record = snap.to_dict() or {}
    except Exception:
        pass

    computed = {
        "date": day,
        "total_assignments": asgn_count,
        "assignments_offered": asgn_offered,
        "assignments_accepted": asgn_accepted,
        "total_events": events_count,
        "events_by_type": events_by_type,
    }

    # Compare mismatches
    mismatches: dict[str, Any] = {}
    if daily_record:
        for k in ("total_assignments", "assignments_offered", "assignments_accepted", "total_events"):
            stored_val = daily_record.get(k)
            comp_val = computed.get(k)
            if stored_val is not None and stored_val != comp_val:
                mismatches[k] = {"stored": stored_val, "computed": comp_val}

    return {
        "day": day,
        "computed": computed,
        "stored": daily_record,
        "matches": len(mismatches) == 0,
        "mismatches": mismatches,
    }


def check_dispatch_invariants(db: Any) -> dict[str, Any]:
    """Inspect dispatch pools, verify structural invariants and data consistency, and update dispatchStats/live."""
    now = time.time()
    if not db:
        return {"ok": False, "error": "db_not_initialized"}

    violations: list[str] = []
    consistency_errors: list[str] = []

    # Fetch all WPP
    wpp_docs = {}
    try:
        for doc in db.collection(COLLECTION_WPP).stream():
            wpp_docs[doc.id] = doc.to_dict() or {}
    except Exception as exc:
        violations.append(f"Failed to read WPP: {exc}")

    # Fetch all DAP
    dap_docs = {}
    try:
        for doc in db.collection(COLLECTION_DAP).stream():
            dap_docs[doc.id] = doc.to_dict() or {}
    except Exception as exc:
        violations.append(f"Failed to read DAP: {exc}")

    # 1. Pool sizes and oldest metrics
    wpp_waiting = 0
    wpp_offered = 0
    oldest_pax = None
    min_req_time = float("inf")

    for p_id, p in wpp_docs.items():
        st = str(p.get("state") or "WAITING")
        if st == "WAITING":
            wpp_waiting += 1
            req_t = _safe_ts(p.get("req_time")) or now
            if req_t < min_req_time:
                min_req_time = req_t
                oldest_pax = {
                    "id": p_id,
                    "req_time": req_t,
                    "wait_seconds": round(now - req_t, 1),
                }
        elif st == "OFFERED":
            wpp_offered += 1

    dap_idle = 0
    dap_share = 0
    dap_busy = 0
    dap_offered = 0
    oldest_driver = None
    min_idle_since = float("inf")

    for d_id, d in dap_docs.items():
        st = str(d.get("state") or "IDLE")
        pool = str(d.get("pool") or "")
        is_share = pool == "SHARE" or st in ("SHARE_OPEN", "SHARE")

        if st == "OFFERED":
            dap_offered += 1
        elif is_share:
            dap_share += 1
        elif st == "IDLE":
            dap_idle += 1
        else:
            dap_busy += 1

        if (st in ("IDLE", "SHARE_OPEN", "SHARE") or pool in ("IDLE", "SHARE")) and st != "OFFERED":
            idle_t = _safe_ts(d.get("idle_since"))
            if idle_t and 0 < idle_t < min_idle_since:
                min_idle_since = idle_t
                oldest_driver = {
                    "id": d_id,
                    "idle_since": idle_t,
                    "idle_seconds": round(now - idle_t, 1),
                }

    # 2. Invariant 1: A driver is in at most one sub-pool
    for d_id, d in dap_docs.items():
        st = str(d.get("state") or "")
        pool = str(d.get("pool") or "")
        valid_states = {"IDLE", "SHARE_OPEN", "SHARE", "BUSY", "OFFLINE", "OFFERED", "STALE"}
        if st not in valid_states:
            violations.append(f"Driver {d_id} has invalid state '{st}'")

    # 3. Invariant 2: p.state=OFFERED iff partner driver is OFFERED pointing back
    outstanding_offers: list[dict[str, Any]] = []

    for p_id, p in wpp_docs.items():
        if p.get("state") == "OFFERED":
            d_id = str(p.get("current_offer_driver_id") or "")
            exp = _safe_ts(p.get("offer_expires_at")) or 0.0
            outstanding_offers.append({
                "passenger_id": p_id,
                "driver_id": d_id,
                "offer_expires_at": exp,
                "remaining_seconds": round(exp - now, 1),
            })
            if not d_id:
                violations.append(f"Passenger {p_id} state=OFFERED without current_offer_driver_id")
            elif d_id not in dap_docs:
                violations.append(f"Passenger {p_id} offered to non-existent driver {d_id}")
            else:
                d = dap_docs[d_id]
                if d.get("state") != "OFFERED":
                    violations.append(f"Partner mismatch: passenger {p_id} OFFERED to driver {d_id} with state={d.get('state')}")
                elif str(d.get("current_offer_passenger_id") or "") != p_id:
                    violations.append(f"Offer reciprocity violation: passenger {p_id} points to driver {d_id}, but driver points to {d.get('current_offer_passenger_id')}")

    for d_id, d in dap_docs.items():
        if d.get("state") == "OFFERED":
            p_id = str(d.get("current_offer_passenger_id") or "")
            if not p_id:
                violations.append(f"Driver {d_id} state=OFFERED without current_offer_passenger_id")
            elif p_id not in wpp_docs:
                violations.append(f"Driver {d_id} offered to non-existent passenger {p_id}")
            else:
                p = wpp_docs[p_id]
                if p.get("state") != "OFFERED":
                    violations.append(f"Partner mismatch: driver {d_id} OFFERED to passenger {p_id} with state={p.get('state')}")
                elif str(p.get("current_offer_driver_id") or "") != d_id:
                    violations.append(f"Offer reciprocity violation: driver {d_id} points to passenger {p_id}, but passenger points to {p.get('current_offer_driver_id')}")

    # 4. Invariant 3: seatsFree is never negative
    for d_id, d in dap_docs.items():
        seats = d.get("seatsFree")
        if seats is None:
            seats = d.get("seats_free", 0)
        try:
            seats_num = int(seats)
            if seats_num < 0:
                violations.append(f"Driver {d_id} has negative seatsFree ({seats_num})")
        except (ValueError, TypeError):
            violations.append(f"Driver {d_id} has invalid seatsFree format ({seats})")

    # 5. Invariant 4: Every OFFERED entry is either unexpired or about to be swept (within grace period)
    for p_id, p in wpp_docs.items():
        if p.get("state") == "OFFERED":
            exp = _safe_ts(p.get("offer_expires_at"))
            if exp and now > (exp + SWEEPER_GRACE_PERIOD_SEC):
                violations.append(f"Stuck OFFERED passenger {p_id}: expired at {exp} (elapsed {now - exp:.1f}s without sweeper cleanup)")

    for d_id, d in dap_docs.items():
        if d.get("state") == "OFFERED":
            exp = _safe_ts(d.get("offer_expires_at"))
            if exp and now > (exp + SWEEPER_GRACE_PERIOD_SEC):
                violations.append(f"Stuck OFFERED driver {d_id}: expired at {exp} (elapsed {now - exp:.1f}s without sweeper cleanup)")

    # 6. Data-consistency: Every terminal outcome has a matching event
    terminal_states = {"accepted", "completed", "declined", "rejected", "expired", "cancelled", "timeout", "failed"}
    try:
        all_events = list(db.collection(COLLECTION_EVENTS).stream())
        event_dicts = [e.to_dict() or {} for e in all_events]
        for doc in db.collection(COLLECTION_ASSIGNMENTS).stream():
            d = doc.to_dict() or {}
            st = str(d.get("state") or "").lower()
            if st in terminal_states:
                aid = str(d.get("assignment_id") or doc.id)
                pid = str(d.get("passenger_id") or "")
                did = str(d.get("driver_id") or "")
                has_event = any(
                    (
                        e.get("actor_id") in (did, pid)
                        or str((e.get("details") or {}).get("assignment_id") or "") == aid
                        or str((e.get("details") or {}).get("passenger_id") or "") == pid
                    )
                    and any(kw in str(e.get("event_type") or "").lower() for kw in (st, "accepted", "share", "declined", "expired", "cancelled", "removed", "timeout"))
                    for e in event_dicts
                )
                if not has_event:
                    consistency_errors.append(f"Terminal assignment {aid} ({st}) missing matching event in {COLLECTION_EVENTS}")
    except Exception:
        pass

    # 7. Data-consistency: OFFERED pool entry has PENDING/offered assignment and vice versa
    active_assignments = {}
    try:
        asgn_stream = db.collection(COLLECTION_ASSIGNMENTS).stream()
        for doc in asgn_stream:
            d = doc.to_dict() or {}
            st = str(d.get("state") or "").lower()
            if st in ("offered", "pending"):
                p_id = str(d.get("passenger_id") or "")
                d_id = str(d.get("driver_id") or "")
                if p_id and d_id:
                    active_assignments[(p_id, d_id)] = doc.id
    except Exception:
        pass

    # Check offered pairs have assignment
    for offer in outstanding_offers:
        p_id = offer["passenger_id"]
        d_id = offer["driver_id"]
        if (p_id, d_id) not in active_assignments:
            consistency_errors.append(f"Offered pair ({p_id}, {d_id}) missing matching assignment in {COLLECTION_ASSIGNMENTS}")

    # Check active assignments have offered pair
    for (p_id, d_id), asgn_id in active_assignments.items():
        p_data = wpp_docs.get(p_id)
        d_data = dap_docs.get(d_id)
        if not p_data or p_data.get("state") != "OFFERED":
            consistency_errors.append(f"Assignment {asgn_id} is active but passenger {p_id} is not OFFERED in WPP")
        if not d_data or d_data.get("state") != "OFFERED":
            consistency_errors.append(f"Assignment {asgn_id} is active but driver {d_id} is not OFFERED in DAP")

    # 8. Data-consistency: No ACTIVE/pending notify-me or SCHEDULED entry past expiry/release without sweep
    try:
        for doc in db.collection(COLLECTION_NOTIFY_ME).stream():
            d = doc.to_dict() or {}
            st = str(d.get("status") or "").lower()
            if st in ("pending", "active"):
                exp = _safe_ts(d.get("expiresAt"))
                if exp and now > (exp + SWEEPER_GRACE_PERIOD_SEC):
                    consistency_errors.append(f"Notify-me request {doc.id} past TTL ({exp}) without sweeper cleanup")
    except Exception:
        pass

    try:
        for doc in db.collection(COLLECTION_SCHEDULED).stream():
            d = doc.to_dict() or {}
            st = str(d.get("status") or "").lower()
            if st in ("pending", "active"):
                act_ts = _safe_ts(d.get("activatesAt")) or _safe_ts(d.get("scheduledFor"))
                if act_ts and not d.get("released_to_wpp") and now >= (act_ts + SWEEPER_GRACE_PERIOD_SEC):
                    consistency_errors.append(f"Scheduled ride {doc.id} past activatesAt ({act_ts}) without release or sweeper cleanup")
    except Exception:
        pass

    # 8. Reconcile daily stats
    recon = reconcile_daily(db)

    live_stats = {
        "timestamp": now,
        "pool_sizes": {
            "wpp": {"waiting": wpp_waiting, "offered": wpp_offered, "total": wpp_waiting + wpp_offered},
            "dap": {
                "idle": dap_idle,
                "share": dap_share,
                "busy": dap_busy,
                "offered": dap_offered,
                "total_available": dap_idle + dap_share,
            },
        },
        "oldest_waiting_passenger": oldest_pax,
        "oldest_idle_driver": oldest_driver,
        "outstanding_offers": outstanding_offers,
        "violations_count": len(violations),
        "consistency_errors_count": len(consistency_errors),
        "healthy": len(violations) == 0 and len(consistency_errors) == 0,
    }

    # Persist live summary to dispatchStats/live
    try:
        db.collection(COLLECTION_STATS).document("live").set(live_stats, merge=True)
    except Exception:
        pass

    return {
        "ok": True,
        "timestamp": now,
        "pool_sizes": live_stats["pool_sizes"],
        "oldest_waiting_passenger": oldest_pax,
        "oldest_idle_driver": oldest_driver,
        "outstanding_offers": outstanding_offers,
        "invariant_violations": violations,
        "consistency_errors": consistency_errors,
        "reconciliation": recon,
        "live": live_stats,
    }
