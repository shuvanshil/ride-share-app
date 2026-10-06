"""Reimplemented baseline dispatch algorithm (greedy FIFO nearest free driver)."""
from __future__ import annotations

from typing import Optional

from ..config import AVERAGE_SPEED_KMH, BASE_MAX_ETA_MIN
from ..engine.detour import compute_detour_penalty
from ..engine.eta import pickup_eta_minutes
from ..engine.plan import Assignment, DriverEntry, PassengerEntry


def run_baseline_matching(
    passengers: list[PassengerEntry],
    drivers: list[DriverEntry],
    now: float,
    max_pickup_eta: float = 15.0,
    avg_speed_kmh: float = AVERAGE_SPEED_KMH,
) -> list[Assignment]:
    """Greedy baseline dispatch: Processes passengers in FIFO arrival order and pairs with the nearest free driver."""
    # Sort passengers strictly by arrival order (FIFO)
    waiting_pax = sorted(
        [p for p in passengers if p.state == "WAITING"],
        key=lambda p: p.req_time,
    )

    # Track available driver copies
    avail_drivers: dict[str, DriverEntry] = {
        d.id: DriverEntry(
            id=d.id,
            loc=d.loc,
            cell=d.cell,
            state=d.state,
            pool=d.pool,
            idle_since=d.idle_since,
            seats_free=d.seats_free,
            route=list(d.route),
            last_seen=d.last_seen,
            version=d.version,
            vehicle_type=d.vehicle_type,
            is_approved=d.is_approved,
        )
        for d in drivers
        if d.is_approved and (d.state in ("IDLE", "SHARE_OPEN", "SHARE") or d.pool in ("IDLE", "SHARE"))
    }

    assignments: list[Assignment] = []

    for p in waiting_pax:
        p_veh = (p.vehicle_type or "auto").strip().lower()
        wants_share = bool(p.wants_share or p_veh == "share")
        if p_veh == "share":
            p_veh = "auto"

        best_driver_id: Optional[str] = None
        best_eta: float = float("inf")
        best_detour: float = 0.0
        best_stops: list = []

        for d_id, d in avail_drivers.items():
            if d.id in p.banned:
                continue

            # Vehicle check
            d_veh = (d.vehicle_type or "auto").strip().lower()
            if wants_share:
                if d_veh != "auto":
                    continue
            elif p_veh != "any" and p_veh != d_veh:
                continue

            # Share checks
            if d.is_share:
                if not wants_share or d.seats_free < p.seats:
                    continue
                detour_res = compute_detour_penalty(p, d, avg_speed_kmh=avg_speed_kmh)
                if detour_res is None:
                    continue
                penalty, p_eta, stops = detour_res
                if p_eta < best_eta and p_eta <= max_pickup_eta:
                    best_eta = p_eta
                    best_driver_id = d_id
                    best_detour = penalty
                    best_stops = stops
            else:
                # Idle driver
                eta = pickup_eta_minutes(d.loc[0], d.loc[1], p.pickup[0], p.pickup[1], avg_speed_kmh=avg_speed_kmh)
                if eta < best_eta and eta <= max_pickup_eta:
                    best_eta = eta
                    best_driver_id = d_id
                    best_detour = 0.0
                    best_stops = []

        if best_driver_id is not None:
            chosen_drv = avail_drivers[best_driver_id]
            assignments.append(
                Assignment(
                    passenger_id=p.id,
                    driver_id=best_driver_id,
                    cost=best_eta,
                    eta_minutes=round(best_eta, 2),
                    detour_minutes=round(best_detour, 2),
                    fare=round(p.fare, 2),
                    timestamp=now,
                    route_stops=best_stops,
                )
            )

            # Update driver state in local simulation pool
            if chosen_drv.is_share:
                chosen_drv.seats_free -= p.seats
                chosen_drv.route = best_stops
                if chosen_drv.seats_free <= 0:
                    del avail_drivers[best_driver_id]
            else:
                if wants_share:
                    chosen_drv.seats_free = max(0, chosen_drv.seats_free - p.seats)
                    chosen_drv.pool = "SHARE"
                    chosen_drv.state = "SHARE_OPEN" if chosen_drv.seats_free > 0 else "BUSY"
                    chosen_drv.route = [
                        {"kind": "pickup", "rideId": p.id, "lat": p.pickup[0], "lng": p.pickup[1]},
                        {"kind": "drop", "rideId": p.id, "lat": p.drop[0], "lng": p.drop[1]},
                    ]
                    if chosen_drv.seats_free <= 0:
                        del avail_drivers[best_driver_id]
                else:
                    # Claimed exclusively
                    del avail_drivers[best_driver_id]

    return assignments
