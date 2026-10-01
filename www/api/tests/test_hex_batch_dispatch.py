from __future__ import annotations

import random
import pytest

from api.core.eta import compute_cheap_eta_minutes
from api.core.matching import (
    brute_force_min_cost,
    compute_pair_cost,
    hungarian_min_cost,
    solve_batch_matching,
    solve_greedy_regret,
)


def test_hungarian_vs_brute_force_exact_matches():
    """Verify Hungarian algorithm matches brute-force optimal assignment up to 7x7."""
    random.seed(42)

    # Test various square and rectangular dimensions
    test_dimensions = [
        (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7),
        (2, 4), (3, 5), (4, 6), (5, 7)
    ]

    for n, m in test_dimensions:
        for _ in range(5):  # 5 random matrices per dimension
            matrix = [
                [round(random.uniform(1.0, 50.0), 2) for _ in range(m)]
                for _ in range(n)
            ]

            brute_assignment, brute_cost = brute_force_min_cost(matrix)
            hungarian_assignment = hungarian_min_cost(matrix)

            hungarian_cost = sum(matrix[i][hungarian_assignment[i]] for i in range(n))

            assert abs(hungarian_cost - brute_cost) < 1e-5, (
                f"Mismatch on {n}x{m} matrix: Hungarian {hungarian_cost} vs Brute {brute_cost}\n"
                f"Hungarian: {hungarian_assignment}, Brute: {brute_assignment}\nMatrix: {matrix}"
            )


def test_abx_worked_example():
    """Specification worked example:

    Passenger A: Driver X (5 min), Next Best Y (7 min)
    Passenger B: Driver X (6 min), Next Best Y (15 min)

    Naive nearest first gives A->X (5), B->Y (15) = 20 total.
    Optimal Hungarian gives B->X (6), A->Y (7) = 13 total.
    """
    rides = [
        {"id": "passenger_A", "pickup_lat": 24.3, "pickup_lng": 92.1},
        {"id": "passenger_B", "pickup_lat": 24.4, "pickup_lng": 92.2},
    ]

    candidate_map = {
        "passenger_A": [("driver_X", 5.0), ("driver_Y", 7.0)],
        "passenger_B": [("driver_X", 6.0), ("driver_Y", 15.0)],
    }

    proposals = solve_batch_matching(rides, candidate_map)

    assert proposals["passenger_B"] == "driver_X", "Driver X must be assigned to Passenger B to minimize total wait"
    assert proposals["passenger_A"] == "driver_Y", "Driver Y must be assigned to Passenger A"


def test_shortage_more_rides_than_drivers():
    """When rides outnumber drivers, solver maximizes matched count and picks optimal assignment."""
    rides = [
        {"id": "r1"},
        {"id": "r2"},
        {"id": "r3"},
    ]
    candidate_map = {
        "r1": [("d1", 5.0), ("d2", 10.0)],
        "r2": [("d1", 6.0), ("d2", 8.0)],
        "r3": [("d1", 20.0)],
    }

    proposals = solve_batch_matching(rides, candidate_map)

    # All 2 available drivers must be assigned without double-booking
    assigned_drivers = [d for d in proposals.values() if d is not None]
    assert len(set(assigned_drivers)) == 2
    assert len(assigned_drivers) == 2


def test_greedy_regret_fallback():
    rides = [
        {"id": "r1"},
        {"id": "r2"},
    ]
    candidate_map = {
        "r1": [("d1", 4.0), ("d2", 5.0)],
        "r2": [("d1", 6.0), ("d2", 18.0)],
    }

    # r2 regret is 18 - 6 = 12, r1 regret is 5 - 4 = 1
    # r2 must get d1, r1 must get d2
    proposals = solve_greedy_regret(rides, candidate_map)
    assert proposals["r2"] == "d1"
    assert proposals["r1"] == "d2"


def test_eta_location_freshness_penalties():
    # Fresh fix (10s) -> 0 age penalty
    eta_fresh = compute_cheap_eta_minutes(24.3, 92.1, 24.35, 92.15, driver_location_age_sec=10.0)
    # Stale fix (45s) -> 0.5 min penalty
    eta_stale_45 = compute_cheap_eta_minutes(24.3, 92.1, 24.35, 92.15, driver_location_age_sec=45.0)
    # Stale fix (60s) -> 1.0 min penalty
    eta_stale_60 = compute_cheap_eta_minutes(24.3, 92.1, 24.35, 92.15, driver_location_age_sec=60.0)

    assert eta_stale_45 > eta_fresh
    assert abs((eta_stale_45 - eta_fresh) - 0.5) < 0.05
    assert abs((eta_stale_60 - eta_fresh) - 1.0) < 0.05


def test_cost_model_aging_and_alpha():
    # Pure linear wait (alpha=1.0, gamma=0.0)
    cost1 = compute_pair_cost(10.0, waiting_minutes=5.0, alpha=1.0, gamma=0.0)
    assert cost1 == 10.0

    # Punish long single wait (alpha=1.5)
    cost_quad = compute_pair_cost(10.0, waiting_minutes=0.0, alpha=1.5, gamma=0.0)
    assert abs(cost_quad - (10.0 ** 1.5)) < 1e-4

    # Starvation prevention (gamma=0.1, 5 min waiting -> 1.5x multiplier)
    cost_aged = compute_pair_cost(10.0, waiting_minutes=5.0, alpha=1.0, gamma=0.1)
    assert abs(cost_aged - 15.0) < 1e-4
