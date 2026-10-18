"""Lease-based dispatch runner with dirty loop, match execution, and resilient fallback."""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_RUNS,
    COLLECTION_WPP,
    FALLBACK_COOLDOWN_SEC,
    LEASE_DURATION_SEC,
    MAX_CONSECUTIVE_ENGINE_ERRORS,
    MAX_PAX_PER_RUN,
    OFFER_TIMEOUT_SEC,
    RUN_TIME_BUDGET_MS,
)
from .engine.plan import Assignment, DispatchPlan, DriverEntry, PassengerEntry
from .engine.solve import solve_dispatch
from .pools import DispatchPoolManager
from ..core.config import get_env

APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


# Global in-memory counter for engine failure tracking
_consecutive_engine_errors: int = 0
_last_engine_failure_ts: float = 0.0
_custom_fallback_handler: Optional[Callable[[Any], Any]] = None


def set_custom_fallback_handler(handler: Optional[Callable[[Any], Any]]) -> None:
    """Register custom fallback hook for legacy dispatch invocation."""
    global _custom_fallback_handler
    _custom_fallback_handler = handler


def get_consecutive_errors() -> int:
    """Return current count of consecutive matching engine errors."""
    return _consecutive_engine_errors


def reset_consecutive_errors() -> None:
    """Reset consecutive engine errors upon successful dispatch run."""
    global _consecutive_engine_errors
    _consecutive_engine_errors = 0


def _acquire_lease(db: Any, runner_id: str, now: float) -> bool:
    """Attempt to acquire distributed lease in dispatchControl."""
    if not db:
        return True

    ctrl_ref = db.collection(COLLECTION_CONTROL).document("main")
    try:
        snap = ctrl_ref.get()
        data = snap.to_dict() if snap.exists else {}
        lease_expires = float(data.get("lease_expires_at") or 0.0)
        holder = data.get("lease_holder")

        # Lease is free or expired or held by same runner
        if holder == runner_id or lease_expires < now:
            ctrl_ref.set({
                "lease_holder": runner_id,
                "lease_expires_at": now + LEASE_DURATION_SEC,
                "last_run_at": now,
                "updated_at": now,
            }, merge=True)
            return True
        else:
            # Mark dirty so current runner continues another pass
            ctrl_ref.set({"dirty": True, "updated_at": now}, merge=True)
            return False
    except Exception:
        return True


def _release_lease(db: Any, runner_id: str) -> None:
    """Release distributed lease in dispatchControl."""
    if not db:
        return
    try:
        ctrl_ref = db.collection(COLLECTION_CONTROL).document("main")
        snap = ctrl_ref.get()
        if snap.exists and snap.to_dict().get("lease_holder") == runner_id:
            ctrl_ref.update({"lease_holder": None, "lease_expires_at": 0.0})
    except Exception:
        pass


def _is_dirty(db: Any) -> bool:
    """Check if dirty flag is raised in dispatchControl."""
    if not db:
        return False
    try:
        snap = db.collection(COLLECTION_CONTROL).document("main").get()
        if snap.exists:
            return bool(snap.to_dict().get("dirty"))
    except Exception:
        pass
    return False


def _clear_dirty(db: Any) -> None:
    """Clear dirty flag in dispatchControl."""
    if not db:
        return
    try:
        db.collection(COLLECTION_CONTROL).document("main").update({"dirty": False})
    except Exception:
        pass


def nudge_dispatch(db: Any) -> None:
    """Flag dispatch as dirty to trigger matching on next loop or worker execution."""
    if not db:
        return
    try:
        db.collection(COLLECTION_CONTROL).document("main").set({"dirty": True}, merge=True)
    except Exception:
        pass


def _claim_assignment_atomic(
    db: Any,
    assignment: Assignment,
    run_id: str,
    now: float,
) -> bool:
    """Atomically commit an assignment: lock passenger & driver to OFFERED and write assignment record."""
    if not db:
        return True

    p_ref = db.collection(COLLECTION_WPP).document(assignment.passenger_id)
    d_ref = db.collection(COLLECTION_DAP).document(assignment.driver_id)
    offer_expires = now + OFFER_TIMEOUT_SEC

    aid = f"asgn_{int(now * 1000)}_{assignment.passenger_id[:8]}"
    asgn_record = {
        "assignment_id": aid,
        "run_id": run_id,
        "passenger_id": assignment.passenger_id,
        "driver_id": assignment.driver_id,
        "cost": assignment.cost,
        "eta_minutes": assignment.eta_minutes,
        "detour_minutes": assignment.detour_minutes,
        "fare": assignment.fare,
        "state": "offered",
        "offer_expires_at": offer_expires,
        "created_at": now,
        "updated_at": now,
    }
    if assignment.route_stops:
        asgn_record["route_stops"] = assignment.route_stops

    try:
        def _apply_claim_tx(tx):
            p_snap = p_ref.get(transaction=tx) if hasattr(p_ref, "get") else None
            d_snap = d_ref.get(transaction=tx) if hasattr(d_ref, "get") else None
            if not p_snap or not d_snap or not getattr(p_snap, "exists", False) or not getattr(d_snap, "exists", False):
                return False, {}

            p_data = p_snap.to_dict() or {}
            d_data = d_snap.to_dict() or {}

            if p_data.get("state") != "WAITING":
                return False, {}
            if d_data.get("state") not in ("IDLE", "SHARE_OPEN", "SHARE") and d_data.get("pool") not in ("IDLE", "SHARE"):
                return False, {}

            p_update = {
                "state": "OFFERED",
                "current_offer_driver_id": assignment.driver_id,
                "offer_expires_at": offer_expires,
                "updated_at": now,
            }
            d_update = {
                "state": "OFFERED",
                "current_offer_passenger_id": assignment.passenger_id,
                "offer_expires_at": offer_expires,
                "updated_at": now,
            }
            if assignment.route_stops:
                d_update["route"] = assignment.route_stops
                d_update["routeStops"] = assignment.route_stops

            asgn_ref = db.collection(COLLECTION_ASSIGNMENTS).document(aid)
            if tx is not None:
                tx.update(p_ref, p_update)
                tx.update(d_ref, d_update)
                tx.set(asgn_ref, asgn_record)
            else:
                p_ref.update(p_update)
                d_ref.update(d_update)
                asgn_ref.set(asgn_record)
            return True, p_data

        if hasattr(db, "transaction"):
            claimed, p_data = _apply_claim_tx(db.transaction())
        else:
            claimed, p_data = _apply_claim_tx(None)

        if not claimed:
            return False

        # If passenger has an active rideId or pendingRequestId in main collections, sync it
        ride_id = p_data.get("ride_id")
        pending_req_id = p_data.get("pending_request_id")

        if not ride_id and pending_req_id:
            try:
                # Fetch pending request details and materialize concrete rides document so driver can accept
                p_req_doc = db.collection("pendingRideRequests").document(str(pending_req_id)).get()
                p_req_data = p_req_doc.to_dict() if p_req_doc.exists else {}

                p_pickup = p_data.get("pickup") or p_req_data.get("pickup") or {}
                p_drop = p_data.get("drop") or p_req_data.get("drop") or {}
                veh_type = p_data.get("vehicle_type") or p_req_data.get("vehicleType") or "auto"
                is_share_val = bool(p_data.get("wants_share") or p_req_data.get("rideType") == "share")

                ride_ref = db.collection("rides").document()
                ride_id = ride_ref.id

                new_ride_data = {
                    "passenger_id": assignment.passenger_id,
                    "passengerId": assignment.passenger_id,
                    "passenger_name": str(p_req_data.get("passengerName") or p_snap.to_dict().get("passenger_name") or "Passenger")[:80],
                    "passenger_phone": str(p_req_data.get("passengerPhone") or p_snap.to_dict().get("passenger_phone") or "")[:40],
                    "pickup_name": str(p_pickup.get("name") or "Pickup location")[:120],
                    "drop_name": str(p_drop.get("name") or "Destination")[:120],
                    "drop_full_address": str(p_drop.get("address") or p_drop.get("fullAddress") or "")[:240],
                    "pickup_lat": float(p_pickup.get("lat") or 0.0),
                    "pickup_lng": float(p_pickup.get("lng") or 0.0),
                    "drop_lat": float(p_drop.get("lat") or 0.0),
                    "drop_lng": float(p_drop.get("lng") or 0.0),
                    "distance_km": float(p_req_data.get("distanceKm") or 0.0),
                    "fare": assignment.fare,
                    "quoted_fare": assignment.fare,
                    "fare_original": assignment.fare,
                    "vehicle_type": veh_type,
                    "rideType": "share" if is_share_val else "normal",
                    "status": "pending",
                    "sourceMode": p_req_data.get("mode") or "auto",
                    "pendingRequestId": str(pending_req_id),
                    "driver_id": None,
                    "eligible_driver_ids": [assignment.driver_id],
                    "notified_driver_ids": [assignment.driver_id],
                    "current_offer_driver_id": assignment.driver_id,
                    "offer_expires_at": datetime.fromtimestamp(offer_expires, tz=timezone.utc).isoformat(),
                    "search_status": "matched_offer_sent",
                    "payment_methods": ["cash", "upi"],
                    "payment_status": "pending",
                    "createdAt": datetime.now(timezone.utc),
                    "updatedAt": datetime.now(timezone.utc),
                }
                ride_ref.set(new_ride_data)
                p_ref.update({"ride_id": ride_id})
                db.collection("pendingRideRequests").document(str(pending_req_id)).update({
                    "rideId": ride_id,
                    "lockedByDriverId": assignment.driver_id,
                    "status": "dispatching",
                    "updatedAt": now,
                })

                # Alert passenger that driver was found
                DispatchPoolManager.enqueue_notification(
                    db,
                    recipient_id=assignment.passenger_id,
                    recipient_role="passenger",
                    notif_type="auto_ride_matched",
                    title="Driver Found!",
                    body="A driver has been matched for your ride request. Waiting for driver confirmation.",
                    data={"rideId": ride_id, "type": "auto_ride_matched", "driverId": assignment.driver_id},
                )
            except Exception as m_err:
                print(f"Error materializing rides doc for pending request: {m_err}", file=sys.stderr)
        elif ride_id:
            try:
                db.collection("rides").document(str(ride_id)).update({
                    "eligible_driver_ids": [assignment.driver_id],
                    "notified_driver_ids": [assignment.driver_id],
                    "current_offer_driver_id": assignment.driver_id,
                    "offer_expires_at": datetime.fromtimestamp(offer_expires, tz=timezone.utc).isoformat(),
                    "search_status": "matched_offer_sent",
                    "updatedAt": now,
                })
            except Exception:
                pass
            if pending_req_id:
                try:
                    db.collection("pendingRideRequests").document(str(pending_req_id)).update({
                        "lockedByDriverId": assignment.driver_id,
                        "status": "dispatching",
                        "updatedAt": now,
                    })
                except Exception:
                    pass

        # Enqueue driver notification in dispatchNotifications
        DispatchPoolManager.enqueue_notification(
            db,
            recipient_id=assignment.driver_id,
            recipient_role="driver",
            notif_type="ride_offer",
            title="New Ride Match!",
            body=f"Trip match found! Pickup ETA: {assignment.eta_minutes:.1f} min (₹{assignment.fare:.0f}).",
            data={
                "passengerId": assignment.passenger_id,
                "rideId": str(ride_id or ""),
                "pendingRequestId": str(pending_req_id or ""),
                "assignmentId": aid,
                "cost": str(assignment.cost),
                "etaMinutes": str(assignment.eta_minutes),
            },
        )

        # Deliver push notification immediately to driver for instant response
        try:
            from ..routers.rides import _send_driver_push_notification
            _send_driver_push_notification(
                db,
                assignment.driver_id,
                "New Ride Match!",
                f"Trip match found! Pickup ETA: {assignment.eta_minutes:.1f} min (₹{assignment.fare:.0f}).",
                {
                    "type": "ride_offer",
                    "passengerId": assignment.passenger_id,
                    "rideId": str(ride_id or ""),
                    "pendingRequestId": str(pending_req_id or ""),
                    "assignmentId": aid,
                    "cost": str(assignment.cost),
                    "etaMinutes": str(assignment.eta_minutes),
                    "url": f"{APP_BASE_URL}/driver-service?rideId={str(ride_id or '')}&from=push",
                },
            )
        except Exception:
            pass

        DispatchPoolManager.log_event(
            db,
            event_type="assignment_offered",
            actor_id=assignment.driver_id,
            details={
                "assignment_id": aid,
                "passenger_id": assignment.passenger_id,
                "cost": assignment.cost,
                "eta": assignment.eta_minutes,
            },
        )
        DispatchPoolManager.bump_daily_stats(
            db,
            {"total_assignments": 1, "assignments_offered": 1},
            now,
        )
        return True
    except Exception as exc:
        print(f"Failed to claim assignment atomically: {exc}", file=sys.stderr)
        return False


def run_dispatch(db: Any = None, force: bool = False) -> dict[str, Any]:
    """Execute lease-based pool matching runner with dirty-flag loop and resilient fallback.
    
    Returns a summary dict of execution results.
    """
    global _consecutive_engine_errors, _last_engine_failure_ts

    now = time.time()
    runner_id = f"runner_{int(now * 1000)}"

    # Check fallback state
    is_fallback = False
    if _consecutive_engine_errors >= MAX_CONSECUTIVE_ENGINE_ERRORS:
        if (now - _last_engine_failure_ts) < FALLBACK_COOLDOWN_SEC:
            is_fallback = True
        else:
            # Cooldown expired: probe the new engine again
            print("[DISPATCH_RECOVERY] Attempting probe recovery for new matching engine.", file=sys.stderr)

    if is_fallback:
        print(
            f"[DISPATCH_FALLBACK] Consecutive errors ({_consecutive_engine_errors}) exceeded threshold. "
            "Executing fallback dispatch mode.",
            file=sys.stderr,
        )
        if _custom_fallback_handler:
            try:
                fb_res = _custom_fallback_handler(db)
                return {"ok": True, "mode": "fallback", "result": fb_res}
            except Exception as exc:
                print(f"[DISPATCH_FALLBACK_ERROR] Fallback handler failed: {exc}", file=sys.stderr)
        return {"ok": False, "mode": "fallback", "error": "fallback_active"}

    if db and not force:
        if not _acquire_lease(db, runner_id, now):
            return {"ok": True, "status": "lease_busy", "runner_id": runner_id}

    total_assignments_made = 0
    runs_executed = 0
    start_ts = time.time()
    last_plan: Optional[DispatchPlan] = None
    reads_count = 1 if db else 0
    writes_count = 1 if db else 0

    try:
        # Dirty loop: keep matching while pools are actively shifting
        loop_count = 0
        max_loops = 5

        while loop_count < max_loops:
            loop_count += 1
            runs_executed += 1
            if db:
                _clear_dirty(db)
                writes_count += 1

            passengers, drivers = DispatchPoolManager.get_active_pool_entries(db)
            if db:
                reads_count += len(passengers) + len(drivers)

            if not passengers or not drivers:
                break

            # Enforce MAX_PAX_PER_RUN cap: prioritize oldest waiting passengers
            if len(passengers) > MAX_PAX_PER_RUN:
                passengers.sort(key=lambda p: p.req_time)
                passengers = passengers[:MAX_PAX_PER_RUN]
                if db:
                    nudge_dispatch(db)
                    writes_count += 1

            # Execute matching engine
            run_id = f"run_{int(time.time() * 1000)}_{loop_count}"
            try:
                plan = solve_dispatch(
                    passengers=passengers,
                    drivers=drivers,
                    now=time.time(),
                    time_budget_ms=RUN_TIME_BUDGET_MS,
                )
                last_plan = plan
                if plan.hit_budget and db:
                    nudge_dispatch(db)
                    writes_count += 1
                # Engine succeeded
                reset_consecutive_errors()
            except Exception as engine_err:
                _consecutive_engine_errors += 1
                _last_engine_failure_ts = time.time()
                print(
                    f"[DISPATCH_ENGINE_ERROR] Matching engine error (#{_consecutive_engine_errors}): {engine_err}",
                    file=sys.stderr,
                )
                if _consecutive_engine_errors >= MAX_CONSECUTIVE_ENGINE_ERRORS:
                    print(
                        f"[DISPATCH_FALLBACK] Error threshold reached ({_consecutive_engine_errors}). "
                        "Invoking fallback dispatch immediately.",
                        file=sys.stderr,
                    )
                    if _custom_fallback_handler:
                        _custom_fallback_handler(db)
                raise engine_err

            assigned_this_pass = 0
            if plan.assignments:
                for asgn in plan.assignments:
                    claimed = _claim_assignment_atomic(db, asgn, run_id, time.time())
                    if db:
                        reads_count += 2
                        writes_count += 3
                    if claimed:
                        assigned_this_pass += 1
                        total_assignments_made += 1

            wpp_waiting = len([p for p in passengers if p.state == "WAITING"])
            dap_idle = len([d for d in drivers if d.state == "IDLE" or d.pool == "IDLE"])
            dap_share = len([d for d in drivers if d.is_share])
            edges_count = len(plan.assignments)

            # Emit one structured log line per dispatch run
            print(
                f"[DISPATCH_RUN] run_id={run_id} duration_ms={plan.execution_ms:.2f} "
                f"wpp_waiting={wpp_waiting} dap_idle={dap_idle} dap_share={dap_share} "
                f"edges={edges_count} assignments={assigned_this_pass} "
                f"reads={reads_count} writes={writes_count}"
            )

            if db:
                try:
                    db.collection(COLLECTION_RUNS).document(run_id).set({
                        "run_id": run_id,
                        "timestamp": time.time(),
                        "duration_ms": plan.execution_ms,
                        "passengers_count": len(passengers),
                        "drivers_count": len(drivers),
                        "wpp_waiting": wpp_waiting,
                        "dap_idle": dap_idle,
                        "dap_share": dap_share,
                        "edges_count": edges_count,
                        "assignments_count": assigned_this_pass,
                        "reads_count": reads_count,
                        "writes_count": writes_count,
                        "total_cost": plan.total_cost,
                        "execution_ms": plan.execution_ms,
                        "status": "success",
                    })
                    writes_count += 1
                except Exception:
                    pass

            if not plan.assignments:
                break

            # If assignments were made, check if dirty flag was re-raised or more matches possible
            if assigned_this_pass > 0 and (db and _is_dirty(db)):
                continue
            else:
                break

    except Exception as exc:
        print(f"Dispatch runner top-level error: {exc}", file=sys.stderr)
        return {
            "ok": False,
            "status": "error",
            "error": str(exc),
            "consecutive_errors": _consecutive_engine_errors,
        }
    finally:
        if db and not force:
            _release_lease(db, runner_id)
        if db and total_assignments_made > 0:
            try:
                from .sweeper import sweep_outbox_notifications
                sweep_outbox_notifications(db, time.time())
            except Exception:
                pass

    duration_ms = round((time.time() - start_ts) * 1000.0, 2)
    return {
        "ok": True,
        "status": "completed",
        "assignments_count": total_assignments_made,
        "runs_executed": runs_executed,
        "duration_ms": duration_ms,
        "consecutive_errors": _consecutive_engine_errors,
        "plan_summary": {
            "assigned": len(last_plan.assignments) if last_plan else 0,
            "unassigned_passengers": len(last_plan.unassigned_passengers) if last_plan else 0,
            "unassigned_drivers": len(last_plan.unassigned_drivers) if last_plan else 0,
        } if last_plan else None,
    }
