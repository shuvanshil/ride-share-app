"""Unit tests for the pure dispatch matching engine."""
from __future__ import annotations

import itertools
import random
import unittest

from ..dispatch.config import BASE_MAX_ETA_MIN, WEIGHTS, DispatchWeights
from ..dispatch.engine.eligibility import check_eligibility
from ..dispatch.engine.eta import pickup_eta_minutes
from ..dispatch.engine.geo import haversine_km, lat_lon_to_cell
from ..dispatch.engine.hungarian import hungarian_min_cost
from ..dispatch.engine.plan import DriverEntry, PassengerEntry
from ..dispatch.engine.radius import max_eta_minutes
from ..dispatch.engine.solve import solve_dispatch


def _brute_force_assignment(matrix: list[list[float]]) -> tuple[list[int], float]:
    """Exhaustive search for minimal cost matching on n x m matrix."""
    n = len(matrix)
    m = len(matrix[0])
    if n <= m:
        best_cost = float("inf")
        best_assign: list[int] = []
        for p in itertools.permutations(range(m), n):
            c = sum(matrix[i][p[i]] for i in range(n))
            if c < best_cost:
                best_cost = c
                best_assign = list(p)
        return best_assign, best_cost
    else:
        best_cost = float("inf")
        best_assign = [-1] * n
        for p in itertools.permutations(range(n), m):
            c = sum(matrix[p[j]][j] for j in range(m))
            if c < best_cost:
                best_cost = c
                best_assign = [-1] * n
                for j in range(m):
                    best_assign[p[j]] = j
        return best_assign, best_cost


class TestDispatchEngine(unittest.TestCase):
    def test_hungarian_vs_brute_force_200_matrices(self):
        """Verify Hungarian assignment against brute force across 200 random matrices."""
        rng = random.Random(20261005)
        for trial in range(200):
            n = rng.randint(1, 4)
            m = rng.randint(1, 5)
            # Mix of negative, zero, positive, and large costs
            mat = [
                [round(rng.uniform(-20.0, 50.0), 2) for _ in range(m)]
                for _ in range(n)
            ]
            h_assign, h_cost = hungarian_min_cost(mat)
            _b_assign, b_cost = _brute_force_assignment(mat)
            self.assertAlmostEqual(
                h_cost,
                b_cost,
                places=4,
                msg=f"Trial {trial} failed on {n}x{m}: hungarian {h_cost} vs brute {b_cost}",
            )

    def test_example_1_13_min_total_pickup(self):
        """Example 1: Optimal bipartite matching produces 13 min total pickup ETA.
        
        Setup:
          D1 to P1 = 5.0 min, D1 to P2 = 9.0 min
          D2 to P1 = 7.0 min, D2 to P2 = 8.0 min
          Assignment (P1->D1 [5m], P2->D2 [8m]) gives total 13 min pickup ETA,
          superior to (P1->D2 [7m], P2->D1 [9m]) which gives 16 min.
        """
        now = 10000.0
        # Weights zeroing out other factors to isolate ETA
        eta_weights = DispatchWeights(
            urgency=0.0,
            pax_wait=0.0,
            driver_idle=0.0,
            fare=0.0,
            share_bonus=0.0,
            detour_weight=0.0,
        )

        # Place drivers and passengers so ETAs match desired matrix at 25 km/h:
        # D1 to P1 = ~5.0 min, D1 to P2 = ~9.0 min
        # D2 to P1 = ~7.0 min, D2 to P2 = ~8.0 min
        p1 = PassengerEntry(
            id="P1",
            pickup=(23.83, 91.28),
            drop=(23.84, 91.28),
            req_time=now - 180.0,
            vehicle_type="auto",
        )
        p2 = PassengerEntry(
            id="P2",
            pickup=(23.83, 91.310708),
            drop=(23.84, 91.31),
            req_time=now - 180.0,
            vehicle_type="auto",
        )

        d1 = DriverEntry(id="D1", loc=(23.848769, 91.28), state="IDLE", idle_since=now, vehicle_type="auto")
        d2 = DriverEntry(id="D2", loc=(23.854181, 91.291241), state="IDLE", idle_since=now, vehicle_type="auto")

        plan = solve_dispatch(
            passengers=[p1, p2],
            drivers=[d1, d2],
            now=now,
            weights=eta_weights,
        )

        self.assertEqual(len(plan.assignments), 2)
        assign_map = {a.passenger_id: (a.driver_id, a.eta_minutes) for a in plan.assignments}
        self.assertEqual(assign_map["P1"][0], "D1")
        self.assertEqual(assign_map["P2"][0], "D2")
        total_eta = sum(a.eta_minutes for a in plan.assignments)
        self.assertAlmostEqual(total_eta, 13.0, delta=0.2)

    def test_example_2_longest_waiting_and_idle(self):
        """Example 2: Prioritizes passenger who has waited longest and driver idling longest."""
        now = 10000.0

        # Passenger 1 requested 15 minutes ago; Passenger 2 requested just now
        p_long_wait = PassengerEntry(
            id="P_WAIT",
            pickup=(23.8310, 91.2800),
            drop=(23.8400, 91.2800),
            req_time=now - 900.0,  # 15 minutes ago
            vehicle_type="auto",
        )
        p_fresh = PassengerEntry(
            id="P_FRESH",
            pickup=(23.8310, 91.2800),
            drop=(23.8400, 91.2800),
            req_time=now - 10.0,   # 10 seconds ago
            vehicle_type="auto",
        )

        # Single driver available equidistant from both passengers
        d = DriverEntry(
            id="D1",
            loc=(23.8300, 91.2800),
            state="IDLE",
            idle_since=now - 300.0,
            vehicle_type="auto",
        )

        plan = solve_dispatch(
            passengers=[p_long_wait, p_fresh],
            drivers=[d],
            now=now,
        )

        self.assertEqual(len(plan.assignments), 1)
        self.assertEqual(plan.assignments[0].passenger_id, "P_WAIT")
        self.assertEqual(plan.assignments[0].driver_id, "D1")
        self.assertIn("P_FRESH", plan.unassigned_passengers)

        # Test driver idle prioritization
        d_long_idle = DriverEntry(
            id="D_IDLE",
            loc=(23.8300, 91.2800),
            state="IDLE",
            idle_since=now - 1800.0,  # 30 min idle
            vehicle_type="auto",
        )
        d_fresh_idle = DriverEntry(
            id="D_FRESH",
            loc=(23.8300, 91.2800),
            state="IDLE",
            idle_since=now - 60.0,    # 1 min idle
            vehicle_type="auto",
        )

        plan_driver = solve_dispatch(
            passengers=[p_fresh],
            drivers=[d_long_idle, d_fresh_idle],
            now=now,
        )
        self.assertEqual(len(plan_driver.assignments), 1)
        self.assertEqual(plan_driver.assignments[0].driver_id, "D_IDLE")

    def test_scarcity(self):
        """Test scarcity: More passengers than drivers, only best matched are assigned."""
        now = 10000.0
        passengers = [
            PassengerEntry(id=f"P{i}", pickup=(23.8300 + i * 0.005, 91.2800), drop=(23.84, 91.28), req_time=now)
            for i in range(5)
        ]
        drivers = [
            DriverEntry(id=f"D{j}", loc=(23.8300 + j * 0.005, 91.2800), state="IDLE", idle_since=now)
            for j in range(2)
        ]

        plan = solve_dispatch(passengers=passengers, drivers=drivers, now=now)
        self.assertEqual(len(plan.assignments), 2)
        self.assertEqual(len(plan.unassigned_passengers), 3)
        self.assertEqual(len(plan.unassigned_drivers), 0)

        # Check all assigned drivers and passengers are unique
        assigned_p = [a.passenger_id for a in plan.assignments]
        assigned_d = [a.driver_id for a in plan.assignments]
        self.assertEqual(len(set(assigned_p)), 2)
        self.assertEqual(len(set(assigned_d)), 2)

    def test_radius_expansion(self):
        """Test radius expansion: Passenger expands acceptable ETA as wait time increases."""
        now = 10000.0
        # Driver is ~11 minutes away at 25 km/h: distance ~4.58 km (~0.041 deg lat)
        d = DriverEntry(id="D1", loc=(23.8710, 91.2800), state="IDLE", idle_since=now)
        
        # At wait time = 0, maxETA = 8.0 min -> Driver is not eligible
        p_new = PassengerEntry(id="P1", pickup=(23.8300, 91.2800), drop=(23.84, 91.28), req_time=now)
        plan_new = solve_dispatch(passengers=[p_new], drivers=[d], now=now)
        self.assertEqual(len(plan_new.assignments), 0)
        self.assertIn("P1", plan_new.unassigned_passengers)

        # After waiting 10 minutes, maxETA = 8.0 + 0.5 * 10 = 13.0 min -> Driver is eligible
        p_waited = PassengerEntry(id="P1", pickup=(23.8300, 91.2800), drop=(23.84, 91.28), req_time=now - 600.0)
        plan_waited = solve_dispatch(passengers=[p_waited], drivers=[d], now=now)
        self.assertEqual(len(plan_waited.assignments), 1)
        self.assertEqual(plan_waited.assignments[0].driver_id, "D1")

    def test_banned_drivers(self):
        """Test banned drivers: Driver in passenger's banned set is never assigned."""
        now = 10000.0
        d_banned = DriverEntry(id="D_BAD", loc=(23.8301, 91.2800), state="IDLE", idle_since=now)
        d_clean = DriverEntry(id="D_GOOD", loc=(23.8350, 91.2800), state="IDLE", idle_since=now)

        p = PassengerEntry(
            id="P1",
            pickup=(23.8300, 91.2800),
            drop=(23.84, 91.28),
            req_time=now,
            banned={"D_BAD"},
        )

        plan = solve_dispatch(passengers=[p], drivers=[d_banned, d_clean], now=now)
        self.assertEqual(len(plan.assignments), 1)
        self.assertEqual(plan.assignments[0].driver_id, "D_GOOD")


if __name__ == "__main__":
    unittest.main()
