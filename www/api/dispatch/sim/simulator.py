"""Discrete event simulation runner comparing New Pool Engine against Greedy Baseline."""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import Any

from ..engine.geo import haversine_km
from ..engine.plan import Assignment, DriverEntry, PassengerEntry
from ..engine.solve import solve_dispatch
from .baseline import run_baseline_matching
from .generator import ScenarioData, generate_scenario


@dataclass
class SimulationResult:
    scenario_name: str
    engine_name: str
    total_passengers: int
    assigned_count: int
    unassigned_count: int
    mean_wait_min: float
    p95_wait_min: float
    max_wait_min: float
    total_pickup_minutes: float
    driver_idle_spread: float        # Standard deviation of driver idle times (minutes)
    pax_wait_gt_10min_count: int
    scheduled_total: int
    scheduled_assigned_on_time: int
    scheduled_assigned_share_pct: float
    notify_me_total: int
    notify_me_fired_once_count: int


def _percentile(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    sorted_d = sorted(data)
    k = (len(sorted_d) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_d[int(k)]
    d0 = sorted_d[int(f)] * (c - k)
    d1 = sorted_d[int(c)] * (k - f)
    return round(d0 + d1, 2)


def run_simulation(scenario: ScenarioData, engine: str = "new_engine") -> SimulationResult:
    """Run discrete-time event simulation for a scenario using either 'new_engine' or 'baseline'."""
    tick_sec = 15.0  # 15s dispatch cycle
    total_ticks = int(scenario.duration_seconds / tick_sec)
    base_time = scenario.passengers[0].req_time if scenario.passengers else 1700000000.0
    # Normalize start time to 0
    t_start = min([p.req_time for p in scenario.passengers] + [base_time])

    # Copy drivers
    drivers: dict[str, DriverEntry] = {
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
        for d in scenario.drivers
    }

    # Tracking collections
    waiting_passengers: dict[str, PassengerEntry] = {}
    assigned_passengers: set[str] = set()
    pax_wait_times: list[float] = []
    pax_pickup_times: list[float] = []
    driver_idle_times: list[float] = []

    # Scheduled tracking
    scheduled_pending = list(scenario.scheduled_rides)
    sched_meta: dict[str, dict[str, Any]] = {s["passenger_id"]: s for s in scenario.scheduled_rides}
    scheduled_assigned_on_time_count = 0
    scheduled_assigned_total_count = 0

    # Notify-me tracking
    notify_me_pending = list(scenario.notify_me_requests)
    notify_me_fired: dict[str, int] = {nm["id"]: 0 for nm in scenario.notify_me_requests}

    # Passenger arrivals queue
    pax_queue = sorted(scenario.passengers, key=lambda p: p.req_time)
    pax_idx = 0

    # Mid-run driver arrivals queue
    driver_arr_queue = sorted(scenario.driver_arrivals, key=lambda d: d["arrival_time"])
    drv_arr_idx = 0

    for step in range(total_ticks):
        current_time = t_start + (step * tick_sec)

        # 1. Admit on-demand passenger arrivals
        while pax_idx < len(pax_queue) and pax_queue[pax_idx].req_time <= current_time:
            p = pax_queue[pax_idx]
            waiting_passengers[p.id] = PassengerEntry(
                id=p.id,
                pickup=p.pickup,
                drop=p.drop,
                req_time=p.req_time,
                wants_share=p.wants_share,
                seats=p.seats,
                fare=p.fare,
                banned=set(p.banned),
                state="WAITING",
                vehicle_type=p.vehicle_type,
                mode=p.mode,
            )
            pax_idx += 1

        # 2. Release due scheduled rides
        remaining_sched = []
        for s in scheduled_pending:
            if current_time >= s["activates_at"]:
                pid = s["passenger_id"]
                waiting_passengers[pid] = PassengerEntry(
                    id=pid,
                    pickup=s["pickup"],
                    drop=s["drop"],
                    req_time=current_time,
                    wants_share=s["wants_share"],
                    seats=1,
                    fare=s["fare"],
                    state="WAITING",
                    vehicle_type=s["vehicle_type"],
                    mode="schedule",
                )
            else:
                remaining_sched.append(s)
        scheduled_pending = remaining_sched

        # 3. Admit mid-run driver arrivals
        while drv_arr_idx < len(driver_arr_queue) and driver_arr_queue[drv_arr_idx]["arrival_time"] <= current_time:
            arr = driver_arr_queue[drv_arr_idx]
            drivers[arr["driver_id"]] = DriverEntry(
                id=arr["driver_id"],
                loc=arr["loc"],
                state="IDLE",
                pool="IDLE",
                idle_since=current_time,
                seats_free=3 if arr.get("vehicle_type") == "auto" else 1,
                vehicle_type=arr.get("vehicle_type", "auto"),
                is_approved=True,
            )
            drv_arr_idx += 1

        # 4. Check notify-me requests for nearby available drivers
        remaining_nm = []
        for nm in notify_me_pending:
            if current_time > nm["expires_at"]:
                continue
            # Look for available driver within search radius
            found_driver = False
            for d in drivers.values():
                if d.state in ("IDLE", "SHARE_OPEN", "SHARE") or d.pool in ("IDLE", "SHARE"):
                    dist_km = haversine_km(d.loc[0], d.loc[1], nm["pickup"][0], nm["pickup"][1])
                    if dist_km <= nm["search_radius_km"]:
                        found_driver = True
                        break
            if found_driver:
                notify_me_fired[nm["id"]] += 1
            else:
                remaining_nm.append(nm)
        notify_me_pending = remaining_nm

        # 5. Execute Dispatch Engine
        active_pax = list(waiting_passengers.values())
        active_drvs = [
            d for d in drivers.values()
            if (d.state in ("IDLE", "SHARE_OPEN", "SHARE") or d.pool in ("IDLE", "SHARE")) and d.seats_free > 0
        ]

        if active_pax and active_drvs:
            if engine == "new_engine":
                plan = solve_dispatch(
                    passengers=active_pax,
                    drivers=active_drvs,
                    now=current_time,
                )
                assignments = plan.assignments
            else:
                assignments = run_baseline_matching(
                    passengers=active_pax,
                    drivers=active_drvs,
                    now=current_time,
                )

            # 6. Apply assignments
            for asgn in assignments:
                pid = asgn.passenger_id
                did = asgn.driver_id
                if pid not in waiting_passengers:
                    continue

                p_entry = waiting_passengers.pop(pid)
                assigned_passengers.add(pid)

                # Wait time in minutes
                wait_min = (current_time - p_entry.req_time) / 60.0
                pax_wait_times.append(max(0.0, wait_min))
                pax_pickup_times.append(asgn.eta_minutes)

                # Check scheduled ride on-time delivery
                if pid in sched_meta:
                    scheduled_assigned_total_count += 1
                    sched_target = sched_meta[pid]["scheduled_at"]
                    # If assigned on or before scheduled departure time
                    if current_time <= sched_target:
                        scheduled_assigned_on_time_count += 1

                # Driver idle time spread
                if did in drivers:
                    d_obj = drivers[did]
                    idle_dur = max(0.0, (current_time - d_obj.idle_since) / 60.0)
                    driver_idle_times.append(idle_dur)

                    # Update driver state for simulation
                    if d_obj.is_share:
                        d_obj.seats_free -= p_entry.seats
                        if d_obj.seats_free <= 0:
                            d_obj.state = "BUSY"
                    else:
                        if p_entry.wants_share:
                            d_obj.seats_free = max(0, d_obj.seats_free - p_entry.seats)
                            d_obj.pool = "SHARE"
                            d_obj.state = "SHARE_OPEN" if d_obj.seats_free > 0 else "BUSY"
                            d_obj.route = [
                                {"kind": "pickup", "rideId": pid, "lat": p_entry.pickup[0], "lng": p_entry.pickup[1]},
                                {"kind": "drop", "rideId": pid, "lat": p_entry.drop[0], "lng": p_entry.drop[1]},
                            ]
                        else:
                            d_obj.state = "BUSY"
                            d_obj.seats_free = 0

    total_pax = len(scenario.passengers) + len(scenario.scheduled_rides)
    assigned_count = len(assigned_passengers)
    unassigned_count = total_pax - assigned_count

    mean_wait = round(statistics.mean(pax_wait_times), 2) if pax_wait_times else 0.0
    p95_wait = _percentile(pax_wait_times, 0.95)
    max_wait = round(max(pax_wait_times), 2) if pax_wait_times else 0.0
    tot_pickup = round(sum(pax_pickup_times), 1)

    spread_idle = (
        round(statistics.stdev(driver_idle_times), 2)
        if len(driver_idle_times) > 1
        else (round(driver_idle_times[0], 2) if driver_idle_times else 0.0)
    )

    pax_gt_10min = len([w for w in pax_wait_times if w > 10.0])

    tot_sched = len(scenario.scheduled_rides)
    sched_pct = round((scheduled_assigned_on_time_count / tot_sched * 100.0), 1) if tot_sched > 0 else 100.0

    tot_nm = len(scenario.notify_me_requests)
    nm_fired_once = len([v for v in notify_me_fired.values() if v == 1])

    return SimulationResult(
        scenario_name=scenario.scenario_name,
        engine_name=engine,
        total_passengers=total_pax,
        assigned_count=assigned_count,
        unassigned_count=unassigned_count,
        mean_wait_min=mean_wait,
        p95_wait_min=p95_wait,
        max_wait_min=max_wait,
        total_pickup_minutes=tot_pickup,
        driver_idle_spread=spread_idle,
        pax_wait_gt_10min_count=pax_gt_10min,
        scheduled_total=tot_sched,
        scheduled_assigned_on_time=scheduled_assigned_on_time_count,
        scheduled_assigned_share_pct=sched_pct,
        notify_me_total=tot_nm,
        notify_me_fired_once_count=nm_fired_once,
    )
