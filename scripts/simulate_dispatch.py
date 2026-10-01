"""Simulation harness comparing legacy nearest-first, hex-batch exact, and hex-batch greedy-regret.

Evaluates scenarios:
- 20 drivers / 10 rides
- 100 drivers / 60 rides
- 300 drivers / 200 rides
- 40-ride rush (40 rides / 30 drivers)
"""
from __future__ import annotations

import json
import math
import random
import time
from typing import Any

from api.core.eta import compute_cheap_eta_minutes
from api.core.geo import get_all_zone_ids, get_zone_ring, is_in_lla, point_to_zone
from api.core.matching import compute_pair_cost, solve_batch_matching, solve_greedy_regret


def load_zones():
    with open("config/zones.json", "r", encoding="utf-8") as f:
        return json.load(f)


def load_lla():
    with open("config/lla.json", "r", encoding="utf-8") as f:
        return json.load(f)


def generate_random_point_in_lla(lla_data: dict[str, Any]) -> tuple[float, float]:
    bbox = lla_data["bounding_box"]
    while True:
        lat = random.uniform(bbox["min_lat"], bbox["max_lat"])
        lng = random.uniform(bbox["min_lng"], bbox["max_lng"])
        if is_in_lla(lat, lng, lla_data):
            return lat, lng


def run_scenario(
    name: str,
    num_drivers: int,
    num_rides: int,
    lla_data: dict[str, Any],
    zones_data: dict[str, Any],
    seed: int = 42,
) -> dict[str, Any]:
    random.seed(seed)

    # 1. Generate Drivers
    drivers = []
    for i in range(num_drivers):
        d_lat, d_lng = generate_random_point_in_lla(lla_data)
        d_zone = point_to_zone(d_lat, d_lng, zones_data)
        drivers.append({
            "id": f"driver_{i+1}",
            "lat": d_lat,
            "lng": d_lng,
            "zoneId": d_zone,
            "age_sec": random.uniform(5.0, 35.0),
        })

    # 2. Generate Rides
    rides = []
    for j in range(num_rides):
        p_lat, p_lng = generate_random_point_in_lla(lla_data)
        p_zone = point_to_zone(p_lat, p_lng, zones_data)
        rides.append({
            "id": f"ride_{j+1}",
            "pickup_lat": p_lat,
            "pickup_lng": p_lng,
            "zoneId": p_zone,
            "waiting_minutes": random.uniform(0.5, 4.0),
        })

    results = {}

    # --- Strategy A: Legacy Nearest-First ---
    t0 = time.time()
    legacy_assigned_drivers = set()
    legacy_waits = []
    legacy_matches = 0

    for r in rides:
        # Sort all available drivers by straight distance
        cands = [
            (d, compute_cheap_eta_minutes(d["lat"], d["lng"], r["pickup_lat"], r["pickup_lng"]))
            for d in drivers
            if d["id"] not in legacy_assigned_drivers
        ]
        if cands:
            cands.sort(key=lambda x: x[1])
            best_d, eta = cands[0]
            legacy_assigned_drivers.add(best_d["id"])
            legacy_waits.append(eta)
            legacy_matches += 1

    t_legacy_ms = (time.time() - t0) * 1000.0

    # Build Zone Candidate Map for Hex-Batch
    candidate_map: dict[str, list[tuple[str, float]]] = {}
    for r in rides:
        active_zones = set(get_zone_ring(r["zoneId"], ring_level=1, zones_config=zones_data))
        cands = []
        for d in drivers:
            if d["zoneId"] in active_zones:
                eta = compute_cheap_eta_minutes(d["lat"], d["lng"], r["pickup_lat"], r["pickup_lng"], driver_location_age_sec=d["age_sec"])
                cost = compute_pair_cost(eta, waiting_minutes=r["waiting_minutes"])
                cands.append((d["id"], cost))
        cands.sort(key=lambda x: x[1])
        candidate_map[r["id"]] = cands[:8]

    # --- Strategy B: Hex-Batch Exact (Hungarian) ---
    t0 = time.time()
    exact_proposals = solve_batch_matching(rides, candidate_map)
    t_exact_ms = (time.time() - t0) * 1000.0

    exact_waits = []
    exact_matches = 0
    driver_dict = {d["id"]: d for d in drivers}
    for r in rides:
        d_id = exact_proposals.get(r["id"])
        if d_id and d_id in driver_dict:
            d = driver_dict[d_id]
            eta = compute_cheap_eta_minutes(d["lat"], d["lng"], r["pickup_lat"], r["pickup_lng"])
            exact_waits.append(eta)
            exact_matches += 1

    # --- Strategy C: Hex-Batch Greedy Regret ---
    t0 = time.time()
    regret_proposals = solve_greedy_regret(rides, candidate_map)
    t_regret_ms = (time.time() - t0) * 1000.0

    regret_waits = []
    regret_matches = 0
    for r in rides:
        d_id = regret_proposals.get(r["id"])
        if d_id and d_id in driver_dict:
            d = driver_dict[d_id]
            eta = compute_cheap_eta_minutes(d["lat"], d["lng"], r["pickup_lat"], r["pickup_lng"])
            regret_waits.append(eta)
            regret_matches += 1

    def calc_stats(waits, matches, solve_ms):
        if not waits:
            return {"mean": 0.0, "p90": 0.0, "max": 0.0, "match_rate": 0.0, "solve_ms": round(solve_ms, 2)}
        sorted_w = sorted(waits)
        p90_idx = min(len(sorted_w) - 1, int(len(sorted_w) * 0.90))
        return {
            "mean": round(sum(sorted_w) / len(sorted_w), 2),
            "p90": round(sorted_w[p90_idx], 2),
            "max": round(max(sorted_w), 2),
            "match_rate": round((matches / num_rides) * 100.0, 1),
            "solve_ms": round(solve_ms, 2),
        }

    return {
        "scenario": name,
        "drivers": num_drivers,
        "rides": num_rides,
        "legacy": calc_stats(legacy_waits, legacy_matches, t_legacy_ms),
        "hex_batch_exact": calc_stats(exact_waits, exact_matches, t_exact_ms),
        "hex_batch_regret": calc_stats(regret_waits, regret_matches, t_regret_ms),
    }


def main():
    lla = load_lla()
    zones = load_zones()

    scenarios = [
        ("20 Drivers / 10 Rides", 20, 10),
        ("100 Drivers / 60 Rides", 100, 60),
        ("300 Drivers / 200 Rides", 300, 200),
        ("40-Ride Rush (30 Drivers)", 30, 40),
    ]

    print("==========================================================================================")
    print("                      LIPHTUP DISPATCH ALGORITHM SIMULATION REPORT                        ")
    print("==========================================================================================")

    for name, n_d, n_r in scenarios:
        res = run_scenario(name, n_d, n_r, lla, zones)
        print(f"\n--- Scenario: {name} ---")
        print(f"| Strategy              | Mean Wait | p90 Wait  | Max Wait  | Match Rate | Solve Time |")
        print(f"|-----------------------|-----------|-----------|-----------|------------|------------|")
        leg = res["legacy"]
        exa = res["hex_batch_exact"]
        reg = res["hex_batch_regret"]
        print(f"| Legacy Nearest-First  | {leg['mean']:>6.2f} m  | {leg['p90']:>6.2f} m  | {leg['max']:>6.2f} m  | {leg['match_rate']:>8.1f}%  | {leg['solve_ms']:>7.2f} ms |")
        print(f"| Hex-Batch (Hungarian) | {exa['mean']:>6.2f} m  | {exa['p90']:>6.2f} m  | {exa['max']:>6.2f} m  | {exa['match_rate']:>8.1f}%  | {exa['solve_ms']:>7.2f} ms |")
        print(f"| Hex-Batch (Regret)    | {reg['mean']:>6.2f} m  | {reg['p90']:>6.2f} m  | {reg['max']:>6.2f} m  | {reg['match_rate']:>8.1f}%  | {reg['solve_ms']:>7.2f} ms |")


if __name__ == "__main__":
    main()
