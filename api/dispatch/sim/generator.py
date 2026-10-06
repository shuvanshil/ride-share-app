"""Synthetic scenario generator with seeded PRNG for deterministic dispatch simulations."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from ..engine.plan import DriverEntry, PassengerEntry

# Agartala regional bounding box
LAT_MIN, LAT_MAX = 23.8000, 23.8600
LON_MIN, LON_MAX = 91.2600, 91.3200

# Activity hotspots
HOTSPOTS = [
    (23.8320, 91.2820),  # City Center / Post Office Chowmuhani
    (23.8120, 91.2720),  # Badharghat Railway Station
    (23.8550, 91.2950),  # GB Pant Medical College & Hospital
]


@dataclass
class ScenarioData:
    scenario_name: str
    seed: int
    duration_seconds: float
    passengers: list[PassengerEntry]
    drivers: list[DriverEntry]
    scheduled_rides: list[dict[str, Any]] = field(default_factory=list)
    notify_me_requests: list[dict[str, Any]] = field(default_factory=list)
    driver_arrivals: list[dict[str, Any]] = field(default_factory=list)


def _rand_point(rng: random.Random) -> tuple[float, float]:
    return (
        round(rng.uniform(LAT_MIN, LAT_MAX), 5),
        round(rng.uniform(LON_MIN, LON_MAX), 5),
    )


def _clustered_point(rng: random.Random) -> tuple[float, float]:
    center = rng.choice(HOTSPOTS)
    # 0.005 deg ~= 550m standard deviation
    lat = rng.gauss(center[0], 0.005)
    lon = rng.gauss(center[1], 0.005)
    return (
        round(max(LAT_MIN, min(LAT_MAX, lat)), 5),
        round(max(LON_MIN, min(LON_MAX, lon)), 5),
    )


def generate_scenario(scenario_name: str, seed: int = 42, base_time: float = 1700000000.0) -> ScenarioData:
    """Deterministically generate passenger, driver, scheduled, and notify-me sets for a given scenario."""
    rng = random.Random(seed)
    duration_sec = 1800.0  # 30-minute standard simulation horizon

    passengers: list[PassengerEntry] = []
    drivers: list[DriverEntry] = []
    scheduled_rides: list[dict[str, Any]] = []
    notify_me_requests: list[dict[str, Any]] = []
    driver_arrivals: list[dict[str, Any]] = []

    if scenario_name == "low_demand":
        n_pax, n_drv = 15, 25
        share_ratio = 0.2
    elif scenario_name == "normal_demand":
        n_pax, n_drv = 50, 35
        share_ratio = 0.3
    elif scenario_name == "rush_demand":
        n_pax, n_drv = 120, 40
        share_ratio = 0.35
    elif scenario_name == "scarce_drivers":
        n_pax, n_drv = 80, 15
        share_ratio = 0.3
    elif scenario_name == "clustered_demand":
        n_pax, n_drv = 80, 30
        share_ratio = 0.35
    elif scenario_name == "share_heavy_demand":
        n_pax, n_drv = 70, 25
        share_ratio = 0.85
    elif scenario_name == "scheduled_during_rush":
        n_pax, n_drv = 90, 40
        share_ratio = 0.3
    elif scenario_name == "notify_me_mid_run":
        n_pax, n_drv = 30, 10
        share_ratio = 0.25
    else:
        n_pax, n_drv = 40, 30
        share_ratio = 0.3

    # Generate initial drivers
    for d_i in range(n_drv):
        loc = _clustered_point(rng) if scenario_name == "clustered_demand" and rng.random() < 0.75 else _rand_point(rng)
        idle_offset = rng.uniform(0.0, 900.0)  # idle between 0 and 15 min prior
        v_type = "auto" if rng.random() < 0.8 else "bike"
        drivers.append(
            DriverEntry(
                id=f"drv_{scenario_name}_{d_i+1:03d}",
                loc=loc,
                cell="",
                state="IDLE",
                pool="IDLE",
                idle_since=base_time - idle_offset,
                seats_free=3 if v_type == "auto" else 1,
                route=[],
                last_seen=base_time,
                version=1,
                vehicle_type=v_type,
                is_approved=True,
            )
        )

    # Generate passengers
    for p_i in range(n_pax):
        is_clustered = scenario_name == "clustered_demand" and rng.random() < 0.8
        pickup = _clustered_point(rng) if is_clustered else _rand_point(rng)
        drop = _clustered_point(rng) if is_clustered else _rand_point(rng)
        arr_time = base_time + rng.uniform(0.0, duration_sec)
        wants_share = rng.random() < share_ratio
        v_type = "auto" if wants_share else ("auto" if rng.random() < 0.75 else "bike")
        fare = round(rng.uniform(60.0, 180.0), 2)

        passengers.append(
            PassengerEntry(
                id=f"pax_{scenario_name}_{p_i+1:03d}",
                pickup=pickup,
                drop=drop,
                req_time=arr_time,
                wants_share=wants_share,
                seats=1,
                fare=fare,
                state="WAITING",
                version=1,
                vehicle_type=v_type,
                mode="auto",
            )
        )

    # Specific Scenario Adjustments
    if scenario_name == "scheduled_during_rush":
        # Add 20 scheduled rides with departure times during the 30-min window
        for s_i in range(20):
            sched_offset = rng.uniform(300.0, duration_sec)
            sched_time = base_time + sched_offset
            # Release 15 min before scheduled departure
            activates_at = sched_time - 900.0
            p_id = f"pax_sched_{s_i+1:03d}"
            pickup = _rand_point(rng)
            drop = _rand_point(rng)
            scheduled_rides.append({
                "id": f"sched_{s_i+1:03d}",
                "passenger_id": p_id,
                "scheduled_at": sched_time,
                "activates_at": activates_at,
                "pickup": pickup,
                "drop": drop,
                "fare": round(rng.uniform(90.0, 220.0), 2),
                "vehicle_type": "auto",
                "wants_share": False,
            })

    if scenario_name == "notify_me_mid_run":
        # 10 passengers subscribe to Notify-Me in areas with no drivers initially
        for nm_i in range(10):
            req_time = base_time + rng.uniform(60.0, 600.0)
            p_id = f"pax_nm_{nm_i+1:03d}"
            pickup = (round(LAT_MAX - 0.008 + rng.uniform(0, 0.006), 5), round(LON_MAX - 0.008 + rng.uniform(0, 0.006), 5))
            notify_me_requests.append({
                "id": f"nm_{nm_i+1:03d}",
                "passenger_id": p_id,
                "created_at": req_time,
                "expires_at": req_time + 1200.0,
                "pickup": pickup,
                "search_radius_km": 4.0,
                "vehicle_type": "auto",
            })
        # 5 drivers appear mid-run around t=600s and t=1200s near those locations
        for da_i in range(5):
            arr_t = base_time + (600.0 if da_i < 3 else 1200.0)
            loc = (round(LAT_MAX - 0.007 + rng.uniform(0, 0.004), 5), round(LON_MAX - 0.007 + rng.uniform(0, 0.004), 5))
            driver_arrivals.append({
                "driver_id": f"drv_mid_{da_i+1:03d}",
                "arrival_time": arr_t,
                "loc": loc,
                "vehicle_type": "auto",
            })

    return ScenarioData(
        scenario_name=scenario_name,
        seed=seed,
        duration_seconds=duration_sec,
        passengers=passengers,
        drivers=drivers,
        scheduled_rides=scheduled_rides,
        notify_me_requests=notify_me_requests,
        driver_arrivals=driver_arrivals,
    )
