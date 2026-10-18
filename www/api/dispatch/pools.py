"""Pool schema, models, and transactional state machines for LiphtUp Dispatch (Phase 1)."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

from .config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_NOTIFICATIONS,
    COLLECTION_NOTIFY_ME,
    COLLECTION_RUNS,
    COLLECTION_SCHEDULED,
    COLLECTION_STATS_DAILY,
    COLLECTION_WPP,
    OFFER_TIMEOUT_SEC,
    SHARE_MAX_SEATS,
)
from .engine.geo import lat_lon_to_cell
from .engine.plan import DriverEntry, PassengerEntry


def _now_ts() -> float:
    return time.time()


def _to_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val) if val is not None else default
    except (ValueError, TypeError):
        return default


class DispatchPoolManager:
    """Manages transactional reads and writes to dispatch pools."""

    @staticmethod
    def sync_passenger_wpp(
        db: Any,
        passenger_id: str,
        pickup: dict[str, Any],
        drop: dict[str, Any],
        fare: float = 0.0,
        vehicle_type: str = "auto",
        wants_share: bool = False,
        seats: int = 1,
        banned: Optional[set[str] | list[str]] = None,
        mode: str = "auto",
        ride_id: Optional[str] = None,
        pending_request_id: Optional[str] = None,
        req_time: Optional[float] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Add or update a passenger in the Waiting Passenger Pool (WPP). Idempotent."""
        if not db or not passenger_id:
            return {}

        now = _now_ts()
        req_ts = req_time if req_time is not None else now
        banned_list = list(banned) if banned else []

        doc_ref = db.collection(COLLECTION_WPP).document(passenger_id)
        existing = {}
        try:
            snap = doc_ref.get()
            if hasattr(snap, "exists") and snap.exists:
                existing = snap.to_dict() or {}
        except Exception:
            pass

        new_version = int(existing.get("version") or 0) + 1
        current_state = existing.get("state")
        # Only WAITING or OFFERED. If new, set WAITING. If already OFFERED, preserve offer state.
        state = current_state if current_state in ("WAITING", "OFFERED") else "WAITING"

        p_data = {
            "id": passenger_id,
            "passenger_id": passenger_id,
            "pickup": {
                "lat": _to_float(pickup.get("lat")),
                "lng": _to_float(pickup.get("lng")),
                "name": str(pickup.get("name") or "Pickup")[:120],
            },
            "drop": {
                "lat": _to_float(drop.get("lat")),
                "lng": _to_float(drop.get("lng")),
                "name": str(drop.get("name") or "Drop")[:120],
                "address": str(drop.get("address") or drop.get("fullAddress") or "")[:240],
            },
            "fare": round(_to_float(fare), 2),
            "vehicle_type": (vehicle_type or "auto").strip().lower(),
            "wants_share": bool(wants_share),
            "seats": max(1, int(seats or 1)),
            "banned": banned_list,
            "state": state,
            "version": new_version,
            "mode": mode,
            "ride_id": ride_id or existing.get("ride_id"),
            "pending_request_id": pending_request_id or existing.get("pending_request_id"),
            "req_time": req_ts,
            "last_seen": now,
            "updated_at": now,
            "metadata": metadata or existing.get("metadata") or {},
        }
        if "created_at" not in existing:
            p_data["created_at"] = now

        doc_ref.set(p_data, merge=True)
        DispatchPoolManager.log_event(
            db,
            event_type="wpp_passenger_synced",
            actor_id=passenger_id,
            details={"state": state, "version": new_version, "ride_id": ride_id},
        )
        return p_data

    @staticmethod
    def remove_passenger_wpp(db: Any, passenger_id: str, reason: str = "completed") -> bool:
        """Idempotently remove a passenger from WPP."""
        if not db or not passenger_id:
            return False
        try:
            doc_ref = db.collection(COLLECTION_WPP).document(passenger_id)
            doc_ref.delete()
            DispatchPoolManager.log_event(
                db,
                event_type="wpp_passenger_removed",
                actor_id=passenger_id,
                details={"reason": reason},
            )
            return True
        except Exception:
            return False

    @staticmethod
    def sync_driver_dap(
        db: Any,
        driver_id: str,
        loc: Optional[dict[str, Any] | tuple[float, float]],
        availability: str,
        vehicle_type: str = "auto",
        is_approved: bool = True,
        seats_free: int = 1,
        route: Optional[list[dict[str, Any]]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Add or update a driver in Driver Availability Pool (DAP). Idempotent."""
        if not db or not driver_id:
            return {}

        now = _now_ts()
        doc_ref = db.collection(COLLECTION_DAP).document(driver_id)
        existing = {}
        try:
            snap = doc_ref.get()
            if hasattr(snap, "exists") and snap.exists:
                existing = snap.to_dict() or {}
        except Exception:
            pass

        # Parse location
        lat, lng = 0.0, 0.0
        if isinstance(loc, dict):
            lat = _to_float(loc.get("lat"))
            lng = _to_float(loc.get("lng"))
        elif isinstance(loc, (list, tuple)) and len(loc) >= 2:
            lat = _to_float(loc[0])
            lng = _to_float(loc[1])
        else:
            old_loc = existing.get("loc") or {}
            lat = _to_float(old_loc.get("lat"))
            lng = _to_float(old_loc.get("lng"))

        cell = lat_lon_to_cell(lat, lng) if (lat != 0.0 or lng != 0.0) else ""

        # Determine target state
        clean_avail = (availability or "offline").strip().lower()
        route_list = route if route is not None else (existing.get("routeStops") or existing.get("route") or [])
        free_seats = max(0, min(SHARE_MAX_SEATS, int(seats_free if seats_free is not None else (existing.get("seatsFree") if existing.get("seatsFree") is not None else (existing.get("seats_free") or 1)))))

        if clean_avail in ("offline", "busy"):
            state = "BUSY" if clean_avail == "busy" else "OFFLINE"
            pool = state
        elif clean_avail in ("searching", "online"):
            if existing.get("state") == "OFFERED":
                state = "OFFERED"
                pool = existing.get("pool") or "OFFERED"
            elif free_seats > 0 and bool(route_list):
                state = "SHARE_OPEN"
                pool = "SHARE"
            else:
                state = "IDLE"
                pool = "IDLE"
        else:
            state = "IDLE"
            pool = "IDLE"

        idle_since = existing.get("idle_since")
        if state in ("IDLE", "SHARE_OPEN") and (not idle_since or existing.get("state") in ("BUSY", "OFFLINE")):
            idle_since = now
        elif state not in ("IDLE", "SHARE_OPEN"):
            idle_since = 0.0

        new_version = int(existing.get("version") or 0) + 1

        d_data = {
            "id": driver_id,
            "driver_id": driver_id,
            "loc": {"lat": lat, "lng": lng},
            "cell": cell,
            "state": state,
            "pool": pool,
            "idle_since": idle_since or now,
            "seats_free": free_seats,
            "seatsFree": free_seats,
            "route": route_list,
            "routeStops": route_list,
            "last_seen": now,
            "version": new_version,
            "vehicle_type": (vehicle_type or "auto").strip().lower(),
            "is_approved": bool(is_approved),
            "updated_at": now,
            "metadata": metadata or existing.get("metadata") or {},
        }
        if "created_at" not in existing:
            d_data["created_at"] = now

        doc_ref.set(d_data, merge=True)
        DispatchPoolManager.log_event(
            db,
            event_type="dap_driver_synced",
            actor_id=driver_id,
            details={"state": state, "pool": pool, "version": new_version, "cell": cell, "seats_free": free_seats},
        )
        return d_data

    @staticmethod
    def remove_driver_dap(db: Any, driver_id: str, reason: str = "offline") -> bool:
        """Idempotently remove a driver from active DAP."""
        if not db or not driver_id:
            return False
        try:
            doc_ref = db.collection(COLLECTION_DAP).document(driver_id)
            doc_ref.delete()
            DispatchPoolManager.log_event(
                db,
                event_type="dap_driver_removed",
                actor_id=driver_id,
                details={"reason": reason},
            )
            return True
        except Exception:
            return False

    @staticmethod
    def get_active_pool_entries(db: Any) -> tuple[list[PassengerEntry], list[DriverEntry]]:
        """Fetch visible WAITING passengers and IDLE / SHARE_OPEN drivers for dispatch matching."""
        if not db:
            return [], []

        passengers: list[PassengerEntry] = []
        drivers: list[DriverEntry] = []

        try:
            # Query WAITING passengers
            wpp_stream = db.collection(COLLECTION_WPP).where("state", "==", "WAITING").stream()
            for doc in wpp_stream:
                d = doc.to_dict() or {}
                pickup_loc = d.get("pickup") or {}
                drop_loc = d.get("drop") or {}
                passengers.append(
                    PassengerEntry(
                        id=str(d.get("id") or doc.id),
                        pickup=(_to_float(pickup_loc.get("lat")), _to_float(pickup_loc.get("lng"))),
                        drop=(_to_float(drop_loc.get("lat")), _to_float(drop_loc.get("lng"))),
                        req_time=_to_float(d.get("req_time"), _now_ts()),
                        wants_share=bool(d.get("wants_share")),
                        seats=int(d.get("seats") or 1),
                        fare=_to_float(d.get("fare")),
                        banned=set(d.get("banned") or []),
                        state=str(d.get("state") or "WAITING"),
                        version=int(d.get("version") or 1),
                        vehicle_type=str(d.get("vehicle_type") or "auto"),
                        mode=str(d.get("mode") or "auto"),
                        metadata=d.get("metadata") or {},
                    )
                )
        except Exception:
            pass

        try:
            # Query IDLE, SHARE_OPEN, and SHARE drivers
            dap_stream = db.collection(COLLECTION_DAP).where("state", "in", ["IDLE", "SHARE_OPEN", "SHARE"]).stream()
            for doc in dap_stream:
                d = doc.to_dict() or {}
                loc = d.get("loc") or {}
                raw_pool = d.get("pool")
                state_val = str(d.get("state") or "IDLE")
                pool_val = str(raw_pool) if raw_pool else ("SHARE" if state_val in ("SHARE_OPEN", "SHARE") else state_val)
                seats_val = int(d.get("seatsFree") if d.get("seatsFree") is not None else (d.get("seats_free") or 1))
                route_val = d.get("routeStops") or d.get("route") or []

                drivers.append(
                    DriverEntry(
                        id=str(d.get("id") or doc.id),
                        loc=(_to_float(loc.get("lat")), _to_float(loc.get("lng"))),
                        cell=str(d.get("cell") or ""),
                        state=state_val,
                        pool=pool_val,
                        idle_since=_to_float(d.get("idle_since"), _now_ts()),
                        seats_free=max(0, min(SHARE_MAX_SEATS, seats_val)),
                        route=route_val,
                        last_seen=_to_float(d.get("last_seen"), _now_ts()),
                        version=int(d.get("version") or 1),
                        vehicle_type=str(d.get("vehicle_type") or "auto"),
                        is_approved=bool(d.get("is_approved", True)),
                        metadata=d.get("metadata") or {},
                    )
                )
            if not drivers:
                try:
                    presence_stream = db.collection("driverPresence").where("driverAvailability", "in", ["searching", "online"]).limit(20).stream()
                    for doc in presence_stream:
                        dp = doc.to_dict() or {}
                        dp_loc = dp.get("driverLocation") or {}
                        lat = _to_float(dp_loc.get("lat"))
                        lng = _to_float(dp_loc.get("lng"))
                        if lat != 0.0 or lng != 0.0:
                            v_type = str(dp.get("vehicle_type") or dp.get("vehicleType") or "auto").strip().lower()
                            d_entry = DispatchPoolManager.sync_driver_dap(
                                db=db,
                                driver_id=doc.id,
                                loc=(lat, lng),
                                availability="searching",
                                vehicle_type=v_type,
                                is_approved=True,
                            )
                            drivers.append(
                                DriverEntry(
                                    id=doc.id,
                                    loc=(lat, lng),
                                    cell=str(d_entry.get("cell") or ""),
                                    state="IDLE",
                                    pool="IDLE",
                                    idle_since=_now_ts(),
                                    seats_free=1,
                                    route=[],
                                    last_seen=_now_ts(),
                                    version=1,
                                    vehicle_type=v_type,
                                    is_approved=True,
                                    metadata={},
                                )
                            )
                except Exception:
                    pass
        except Exception:
            pass

        return passengers, drivers

    @staticmethod
    def accept_share_assignment(
        db: Any,
        driver_id: str,
        passenger_id: str,
        seats_needed: int = 1,
        new_route_stops: Optional[list[dict[str, Any]]] = None,
        transaction: Any = None,
    ) -> dict[str, Any]:
        """Atomically decrement seatsFree, update routeStops, and maintain pool=SHARE in transaction."""
        if not db or not driver_id:
            return {}

        now = _now_ts()
        doc_ref = db.collection(COLLECTION_DAP).document(driver_id)
        snap = doc_ref.get(transaction=transaction) if transaction is not None else doc_ref.get()
        if not getattr(snap, "exists", False):
            raise ValueError(f"Driver {driver_id} not found in DAP")

        data = snap.to_dict() or {}
        curr_seats = int(data.get("seatsFree") if data.get("seatsFree") is not None else (data.get("seats_free") or 1))
        new_seats = curr_seats - max(1, seats_needed)

        if new_seats < 0:
            raise ValueError(f"Cannot accept share ride: seatsFree cannot be negative (current={curr_seats}, needed={seats_needed})")

        new_pool = "SHARE"
        new_state = "SHARE_OPEN" if new_seats > 0 else "BUSY"
        stops_to_set = new_route_stops if new_route_stops is not None else (data.get("routeStops") or data.get("route") or [])

        update_payload = {
            "seats_free": new_seats,
            "seatsFree": new_seats,
            "pool": new_pool,
            "state": new_state,
            "route": stops_to_set,
            "routeStops": stops_to_set,
            "updated_at": now,
        }

        if transaction is not None:
            transaction.update(doc_ref, update_payload)
        else:
            doc_ref.update(update_payload)

        DispatchPoolManager.log_event(
            db,
            event_type="share_assignment_accepted",
            actor_id=driver_id,
            details={"passenger_id": passenger_id, "seats_left": new_seats, "pool": new_pool},
        )
        return {**data, **update_payload}

    @staticmethod
    def complete_share_stop(
        db: Any,
        driver_id: str,
        passenger_id: str,
        seats_freed: int = 1,
        remaining_stops: Optional[list[dict[str, Any]]] = None,
        transaction: Any = None,
    ) -> dict[str, Any]:
        """Atomically free seats upon rider dropoff; return to IDLE when empty or stay SHARE if riders remain."""
        if not db or not driver_id:
            return {}

        now = _now_ts()
        doc_ref = db.collection(COLLECTION_DAP).document(driver_id)
        snap = doc_ref.get(transaction=transaction) if transaction is not None else doc_ref.get()
        if not getattr(snap, "exists", False):
            raise ValueError(f"Driver {driver_id} not found in DAP")

        data = snap.to_dict() or {}
        curr_seats = int(data.get("seatsFree") if data.get("seatsFree") is not None else (data.get("seats_free") or 0))
        new_seats = min(SHARE_MAX_SEATS, curr_seats + max(1, seats_freed))

        rem_stops = remaining_stops if remaining_stops is not None else []
        has_remaining_drops = any(s.get("kind") == "drop" for s in rem_stops) or (bool(rem_stops) and new_seats < SHARE_MAX_SEATS)

        if not has_remaining_drops or new_seats >= SHARE_MAX_SEATS:
            # Trip completed: back to IDLE
            new_pool = "IDLE"
            new_state = "IDLE"
            new_seats = SHARE_MAX_SEATS
            rem_stops = []
        else:
            new_pool = "SHARE"
            new_state = "SHARE_OPEN"

        update_payload = {
            "seats_free": new_seats,
            "seatsFree": new_seats,
            "pool": new_pool,
            "state": new_state,
            "route": rem_stops,
            "routeStops": rem_stops,
            "updated_at": now,
        }

        if transaction is not None:
            transaction.update(doc_ref, update_payload)
        else:
            doc_ref.update(update_payload)

        DispatchPoolManager.log_event(
            db,
            event_type="share_stop_completed",
            actor_id=driver_id,
            details={"passenger_id": passenger_id, "seats_free": new_seats, "pool": new_pool},
        )
        return {**data, **update_payload}

    @staticmethod
    def end_share_trip(
        db: Any,
        driver_id: str,
        transaction: Any = None,
    ) -> dict[str, Any]:
        """Atomically reset driver to IDLE and seatsFree=SHARE_MAX_SEATS on trip end."""
        if not db or not driver_id:
            return {}

        now = _now_ts()
        doc_ref = db.collection(COLLECTION_DAP).document(driver_id)
        update_payload = {
            "seats_free": SHARE_MAX_SEATS,
            "seatsFree": SHARE_MAX_SEATS,
            "pool": "IDLE",
            "state": "IDLE",
            "route": [],
            "routeStops": [],
            "idle_since": now,
            "updated_at": now,
        }

        if transaction is not None:
            transaction.update(doc_ref, update_payload)
        else:
            doc_ref.update(update_payload)

        DispatchPoolManager.log_event(
            db,
            event_type="share_trip_ended",
            actor_id=driver_id,
            details={"pool": "IDLE", "seats_free": SHARE_MAX_SEATS},
        )
        return update_payload

    @staticmethod
    def bump_daily_stats(db: Any, deltas: dict[str, int], now: Optional[float] = None) -> None:
        """Increment daily counters in dispatchStatsDaily."""
        if not db or not deltas:
            return
        try:
            ts = now if now is not None else _now_ts()
            day_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            doc_ref = db.collection(COLLECTION_STATS_DAILY).document(day_str)
            snap = doc_ref.get()
            curr = snap.to_dict() if getattr(snap, "exists", False) else {}
            new_data = dict(curr)
            new_data["date"] = day_str
            for k, delta in deltas.items():
                new_data[k] = int(new_data.get(k) or 0) + int(delta)
            new_data["updated_at"] = ts
            doc_ref.set(new_data, merge=True)
        except Exception:
            pass

    @staticmethod
    def log_event(db: Any, event_type: str, actor_id: str, details: Optional[dict[str, Any]] = None) -> None:
        """Record an audit event into dispatchEvents."""
        if not db:
            return
        try:
            now = _now_ts()
            event_id = f"evt_{int(now * 1000)}_{actor_id[:12]}"
            db.collection(COLLECTION_EVENTS).document(event_id).set({
                "event_id": event_id,
                "event_type": event_type,
                "actor_id": actor_id,
                "details": details or {},
                "timestamp": now,
            })
            DispatchPoolManager.bump_daily_stats(db, {"total_events": 1}, now)
        except Exception:
            pass

    @staticmethod
    def update_assignment_state(
        db: Any,
        passenger_id: Optional[str] = None,
        driver_id: Optional[str] = None,
        new_state: str = "accepted",
        event_type: Optional[str] = None,
        details: Optional[dict[str, Any]] = None,
    ) -> int:
        """Update active assignment(s) for a passenger/driver to a terminal or new state and log matching event."""
        if not db or (not passenger_id and not driver_id):
            return 0
        now = _now_ts()
        updated_count = 0
        try:
            stream = db.collection(COLLECTION_ASSIGNMENTS).where("state", "in", ["offered", "pending"]).stream()
            for doc in stream:
                d = doc.to_dict() or {}
                p_match = not passenger_id or str(d.get("passenger_id") or "") == passenger_id
                d_match = not driver_id or str(d.get("driver_id") or "") == driver_id
                if p_match and d_match:
                    doc.reference.update({
                        "state": new_state,
                        "updated_at": now,
                    })
                    updated_count += 1
                    evt_type = event_type or f"assignment_{new_state}"
                    evt_details = {
                        **(details or {}),
                        "assignment_id": doc.id,
                        "passenger_id": d.get("passenger_id"),
                        "driver_id": d.get("driver_id"),
                        "state": new_state,
                    }
                    actor = driver_id or str(d.get("driver_id") or passenger_id or "system")
                    DispatchPoolManager.log_event(db, evt_type, actor, evt_details)

                    if new_state in ("accepted", "completed"):
                        DispatchPoolManager.bump_daily_stats(db, {"assignments_accepted": 1}, now)
        except Exception:
            pass
        return updated_count

    @staticmethod
    def enqueue_notification(
        db: Any,
        recipient_id: str,
        recipient_role: str,
        notif_type: str,
        title: str,
        body: str,
        data: Optional[dict[str, Any]] = None,
    ) -> str:
        """Enqueue an outbound notification into dispatchNotifications."""
        if not db or not recipient_id:
            return ""
        now = _now_ts()
        nid = f"notif_{int(now * 1000)}_{recipient_id[:12]}"
        try:
            db.collection(COLLECTION_NOTIFICATIONS).document(nid).set({
                "id": nid,
                "recipient_id": recipient_id,
                "recipient_role": recipient_role,
                "type": notif_type,
                "title": title,
                "body": body,
                "data": data or {},
                "status": "pending",
                "attempts": 0,
                "created_at": now,
                "updated_at": now,
            })
        except Exception:
            pass
        return nid
