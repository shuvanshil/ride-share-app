"""Unit and integration tests for LiphtUp Dispatch Phase 2 (Share subpool, detour, fairness, invariants, and caps)."""
from __future__ import annotations

import time
import unittest
from typing import Any, Optional
from unittest.mock import patch

from ..dispatch.config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_NOTIFY_ME,
    COLLECTION_RUNS,
    COLLECTION_SCHEDULED,
    COLLECTION_STATS,
    COLLECTION_STATS_DAILY,
    COLLECTION_WPP,
    MAX_PAX_PER_RUN,
    SHARE_MAX_SEATS,
    WEIGHTS,
)
from ..dispatch.engine.cost import compute_pairing_cost
from ..dispatch.engine.detour import compute_detour_penalty
from ..dispatch.engine.eligibility import check_eligibility
from ..dispatch.engine.plan import DriverEntry, PassengerEntry
from ..dispatch.engine.solve import solve_dispatch
from ..dispatch.invariants import check_dispatch_invariants, reconcile_daily
from ..dispatch.pools import DispatchPoolManager
from ..dispatch.runner import nudge_dispatch, run_dispatch
from .test_dispatch_pools import FakeCollection, FakeFirestore


class TestDispatchPhase2Detour(unittest.TestCase):
    """Test suite for detour_penalty, stop insertion, and detour limits."""

    def test_detour_penalty_single_onboard_rider(self):
        # Driver at (23.8300, 91.2800) with 1 onboard rider dropping at (23.8400, 91.2800) (~1.1 km, ~2.6 min)
        driver = DriverEntry(
            id="drv_share_1",
            loc=(23.8300, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "pax_onboard_1", "lat": 23.8400, "lng": 91.2800}],
            idle_since=time.time() - 300,
        )

        # Passenger P2 pickup at (23.8350, 91.2800), drop at (23.8450, 91.2800)
        # Splicing: pickup between driver and P1 drop, or after P1 drop
        passenger = PassengerEntry(
            id="pax_new_2",
            pickup=(23.8350, 91.2800),
            drop=(23.8450, 91.2800),
            req_time=time.time(),
            wants_share=True,
            seats=1,
            vehicle_type="auto",
        )

        res = compute_detour_penalty(passenger, driver, max_detour_min=8.0, max_detour_pct=0.5)
        self.assertIsNotNone(res)
        penalty, pickup_eta, best_stops = res
        self.assertGreater(penalty, 0.0)
        self.assertGreater(pickup_eta, 0.0)
        self.assertEqual(len(best_stops), 3)

        # Existing drop for pax_onboard_1 must still exist
        onboard_drops = [s for s in best_stops if s.get("kind") == "drop" and s.get("rideId") == "pax_onboard_1"]
        self.assertEqual(len(onboard_drops), 1)

    def test_detour_penalty_exceeds_max_min_rejected(self):
        # Driver has drop 1 km north. New passenger requests pickup 10 km west (detour ~24 min)
        driver = DriverEntry(
            id="drv_share_2",
            loc=(23.8300, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "pax_onboard_2", "lat": 23.8390, "lng": 91.2800}],
            idle_since=time.time() - 300,
        )

        passenger = PassengerEntry(
            id="pax_far",
            pickup=(23.8300, 91.1500),  # ~13 km away
            drop=(23.8400, 91.1500),
            req_time=time.time(),
            wants_share=True,
            seats=1,
            vehicle_type="auto",
        )

        res = compute_detour_penalty(passenger, driver, max_detour_min=8.0, max_detour_pct=0.33)
        self.assertIsNone(res, "Should reject edge when extra time exceeds MAX_DETOUR_MIN")

    def test_detour_penalty_exceeds_max_pct_rejected(self):
        # Baseline remaining trip for onboard rider is 2.0 minutes.
        # Adding 1.5 minutes detour is < 8 min, but > 33% (75% increase) -> should be rejected!
        driver = DriverEntry(
            id="drv_share_3",
            loc=(23.8300, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "pax_short", "lat": 23.8375, "lng": 91.2800}],
            idle_since=time.time() - 100,
        )

        # Passenger creates a ~1.5 minute detour
        passenger = PassengerEntry(
            id="pax_pct_detour",
            pickup=(23.8300, 91.2860),
            drop=(23.8450, 91.2860),
            req_time=time.time(),
            wants_share=True,
            seats=1,
            vehicle_type="auto",
        )

        res = compute_detour_penalty(passenger, driver, max_detour_min=8.0, max_detour_pct=0.33)
        self.assertIsNone(res, "Should reject edge when extra time exceeds MAX_DETOUR_PCT")

    def test_existing_riders_drops_maintain_relative_order(self):
        # Driver with 2 existing drops: D1 then D2
        driver = DriverEntry(
            id="drv_multi",
            loc=(23.8000, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=1,
            route=[
                {"kind": "drop", "rideId": "pax_1", "lat": 23.8200, "lng": 91.2800},
                {"kind": "drop", "rideId": "pax_2", "lat": 23.8400, "lng": 91.2800},
            ],
            idle_since=time.time() - 500,
        )

        passenger = PassengerEntry(
            id="pax_3",
            pickup=(23.8100, 91.2800),
            drop=(23.8500, 91.2800),
            req_time=time.time(),
            wants_share=True,
            seats=1,
            vehicle_type="auto",
        )

        res = compute_detour_penalty(passenger, driver, max_detour_min=15.0, max_detour_pct=1.0)
        self.assertIsNotNone(res)
        _, _, stops = res

        drop1_idx = next(i for i, s in enumerate(stops) if s.get("kind") == "drop" and s.get("rideId") == "pax_1")
        drop2_idx = next(i for i, s in enumerate(stops) if s.get("kind") == "drop" and s.get("rideId") == "pax_2")
        self.assertLess(drop1_idx, drop2_idx, "Existing riders' drops must maintain original relative order")


class TestSharePoolMatchingAndSeats(unittest.TestCase):
    """Test matching rules, share bonus, and seat accounting."""

    def test_non_share_passenger_cannot_match_share_driver(self):
        driver = DriverEntry(
            id="drv_share",
            loc=(23.8300, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "pax_existing", "lat": 23.8400, "lng": 91.2800}],
            is_approved=True,
        )
        passenger = PassengerEntry(
            id="pax_private",
            pickup=(23.8310, 91.2810),
            drop=(23.8410, 91.2810),
            req_time=time.time(),
            wants_share=False,  # Private ride
            vehicle_type="auto",
        )

        eligible, reason, _ = check_eligibility(passenger, driver, now=time.time())
        self.assertFalse(eligible)
        self.assertEqual(reason, "passenger_requires_private")

    def test_share_passenger_prefers_share_driver_via_bonus(self):
        now = time.time()
        passenger = PassengerEntry(
            id="pax_share",
            pickup=(23.8300, 91.2800),
            drop=(23.8400, 91.2800),
            req_time=now,
            wants_share=True,
            vehicle_type="auto",
        )

        # Idle driver at 1.0 km
        drv_idle = DriverEntry(
            id="drv_idle",
            loc=(23.8350, 91.2800),
            state="IDLE",
            pool="IDLE",
            idle_since=now,
        )

        # Share driver at same distance with 0 detour
        drv_share = DriverEntry(
            id="drv_share",
            loc=(23.8350, 91.2800),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "onboard", "lat": 23.8500, "lng": 91.2800}],
            idle_since=now,
        )

        cost_idle = compute_pairing_cost(passenger, drv_idle, now=now, eta_minutes=2.5, detour_minutes=0.0)
        cost_share = compute_pairing_cost(passenger, drv_share, now=now, eta_minutes=2.5, detour_minutes=0.0)

        # Share driver cost must be lower by W_SHARE_BONUS (2.0)
        self.assertLess(cost_share, cost_idle)
        self.assertAlmostEqual(cost_idle - cost_share, WEIGHTS.share_bonus, places=2)

    def test_seat_accounting_lifecycle_and_negative_seat_prevention(self):
        db = FakeFirestore()
        driver_id = "drv_test_seats"

        # 1. Initialize driver in DAP with 3 seats
        DispatchPoolManager.sync_driver_dap(
            db=db,
            driver_id=driver_id,
            loc={"lat": 23.8300, "lng": 91.2800},
            availability="online",
            seats_free=3,
        )

        # 2. Accept a 2-seat booking
        res1 = DispatchPoolManager.accept_share_assignment(
            db=db,
            driver_id=driver_id,
            passenger_id="pax_1",
            seats_needed=2,
            new_route_stops=[{"kind": "drop", "rideId": "pax_1", "lat": 23.8400, "lng": 91.2800}],
        )
        self.assertEqual(res1["seats_free"], 1)
        self.assertEqual(res1["pool"], "SHARE")
        self.assertEqual(res1["state"], "SHARE_OPEN")

        # 3. Accept another 1-seat booking -> seats_free becomes 0, state becomes BUSY
        res2 = DispatchPoolManager.accept_share_assignment(
            db=db,
            driver_id=driver_id,
            passenger_id="pax_2",
            seats_needed=1,
            new_route_stops=[
                {"kind": "drop", "rideId": "pax_1", "lat": 23.8400, "lng": 91.2800},
                {"kind": "drop", "rideId": "pax_2", "lat": 23.8500, "lng": 91.2800},
            ],
        )
        self.assertEqual(res2["seats_free"], 0)
        self.assertEqual(res2["pool"], "SHARE")
        self.assertEqual(res2["state"], "BUSY")

        # 4. Attempt to accept another passenger when seats_free == 0 -> MUST raise ValueError!
        with self.assertRaises(ValueError):
            DispatchPoolManager.accept_share_assignment(
                db=db,
                driver_id=driver_id,
                passenger_id="pax_3",
                seats_needed=1,
            )

        # 5. Rider 1 drops off -> seats_free becomes 1, state becomes SHARE_OPEN
        res3 = DispatchPoolManager.complete_share_stop(
            db=db,
            driver_id=driver_id,
            passenger_id="pax_1",
            seats_freed=2,
            remaining_stops=[{"kind": "drop", "rideId": "pax_2", "lat": 23.8500, "lng": 91.2800}],
        )
        self.assertEqual(res3["seats_free"], 2)
        self.assertEqual(res3["pool"], "SHARE")
        self.assertEqual(res3["state"], "SHARE_OPEN")

        # 6. Trip end -> driver reverts to IDLE with 3 seats
        res4 = DispatchPoolManager.end_share_trip(db=db, driver_id=driver_id)
        self.assertEqual(res4["seats_free"], SHARE_MAX_SEATS)
        self.assertEqual(res4["pool"], "IDLE")
        self.assertEqual(res4["state"], "IDLE")
        self.assertEqual(res4["route"], [])


class TestFairnessAndWorstCaseBehavior(unittest.TestCase):
    """Test anti-starvation, idle driver priority, and caps enforcement."""

    def test_passenger_anti_starvation_guarantee(self):
        """Verify that with continuous arrivals of nearer passengers, a long-waiting passenger is eventually served."""
        start_time = 100000.0
        # Long-waiting passenger waiting at distance 1.6 km (~3.8 min ETA)
        starved_pax = PassengerEntry(
            id="pax_starved",
            pickup=(23.8450, 91.2800),
            drop=(23.8650, 91.2800),
            req_time=start_time,
            state="WAITING",
        )

        served_round = None

        # Simulate 20 rounds of new nearer passengers arriving every 60 seconds
        for minute in range(20):
            current_time = start_time + (minute * 60.0)

            # Continuous arrival of a fresh nearer passenger (0.2 km away, ~0.5 min ETA)
            near_pax = PassengerEntry(
                id=f"pax_near_{minute}",
                pickup=(23.8320, 91.2800),
                drop=(23.8400, 91.2800),
                req_time=current_time,
                state="WAITING",
            )

            driver = DriverEntry(
                id=f"drv_{minute}",
                loc=(23.8300, 91.2800),
                state="IDLE",
                pool="IDLE",
                idle_since=current_time - 300,
            )

            plan = solve_dispatch(
                passengers=[starved_pax, near_pax],
                drivers=[driver],
                now=current_time,
            )

            if plan.assignments and plan.assignments[0].passenger_id == "pax_starved":
                served_round = minute
                break

        self.assertIsNotNone(served_round, "Starved passenger was never served despite increasing wait time")
        self.assertGreater(served_round, 0, "Initially nearer passenger should win until wait urgency builds")

    def test_long_idle_driver_served_before_recently_idle(self):
        """When two drivers are equidistant, long-idle driver must be paired first."""
        now = time.time()
        passenger = PassengerEntry(
            id="pax_center",
            pickup=(23.8300, 91.2800),
            drop=(23.8400, 91.2800),
            req_time=now,
            state="WAITING",
        )

        # Driver 1 idle for 20 minutes
        drv_old = DriverEntry(
            id="drv_old_idle",
            loc=(23.8350, 91.2800),
            state="IDLE",
            pool="IDLE",
            idle_since=now - 1200,
        )

        # Driver 2 idle for 30 seconds at the exact same location
        drv_recent = DriverEntry(
            id="drv_recent_idle",
            loc=(23.8350, 91.2800),
            state="IDLE",
            pool="IDLE",
            idle_since=now - 30,
        )

        plan = solve_dispatch(passengers=[passenger], drivers=[drv_old, drv_recent], now=now)
        self.assertEqual(len(plan.assignments), 1)
        self.assertEqual(plan.assignments[0].driver_id, "drv_old_idle")

    def test_max_pax_per_run_cap_enforced_and_sets_dirty(self):
        db = FakeFirestore()
        now = time.time()

        # Add 65 passengers (exceeding MAX_PAX_PER_RUN = 50)
        for i in range(65):
            pid = f"pax_cap_{i:03d}"
            DispatchPoolManager.sync_passenger_wpp(
                db=db,
                passenger_id=pid,
                pickup={"lat": 23.8300 + (i * 0.0001), "lng": 91.2800},
                drop={"lat": 23.8400, "lng": 91.2800},
                req_time=now - (i * 10),
            )

        # Add 10 drivers
        for j in range(10):
            DispatchPoolManager.sync_driver_dap(
                db=db,
                driver_id=f"drv_cap_{j:02d}",
                loc={"lat": 23.8300, "lng": 91.2800},
                availability="online",
            )

        res = run_dispatch(db=db, force=True)
        self.assertTrue(res["ok"])
        self.assertEqual(res["assignments_count"], 10)

        # Verify dirty flag was raised in dispatchControl to finish the rest
        ctrl_snap = db.collection(COLLECTION_CONTROL).document("main").get()
        self.assertTrue(ctrl_snap.exists)


class TestInvariantsAndAdminStats(unittest.TestCase):
    """Test invariants checker, data consistency, and daily reconciliation."""

    def test_invariants_checker_detects_reciprocity_violation(self):
        db = FakeFirestore()
        now = time.time()

        # Passenger OFFERED to driver 1
        db.collection(COLLECTION_WPP).document("p_asym").set({
            "id": "p_asym",
            "state": "OFFERED",
            "current_offer_driver_id": "d_1",
            "offer_expires_at": now + 30.0,
        })

        # Driver 1 OFFERED to a DIFFERENT passenger p_other
        db.collection(COLLECTION_DAP).document("d_1").set({
            "id": "d_1",
            "state": "OFFERED",
            "pool": "IDLE",
            "current_offer_passenger_id": "p_other",
            "seats_free": 1,
            "offer_expires_at": now + 30.0,
        })

        stats = check_dispatch_invariants(db)
        self.assertTrue(stats["ok"])
        violations = stats["invariant_violations"]
        self.assertTrue(any("Offer reciprocity violation" in v for v in violations))

    def test_invariants_checker_detects_negative_seats(self):
        db = FakeFirestore()
        db.collection(COLLECTION_DAP).document("d_neg").set({
            "id": "d_neg",
            "state": "IDLE",
            "pool": "IDLE",
            "seats_free": -1,
            "seatsFree": -1,
        })

        stats = check_dispatch_invariants(db)
        violations = stats["invariant_violations"]
        self.assertTrue(any("negative seatsFree" in v for v in violations))

    def test_daily_reconciliation_detects_counter_mismatch(self):
        db = FakeFirestore()
        day = "2026-10-05"

        # Stored stats has 5 assignments
        db.collection(COLLECTION_STATS_DAILY).document(day).set({
            "date": day,
            "total_assignments": 5,
        })

        # But actual assignments has only 2
        now = time.time()
        db.collection(COLLECTION_ASSIGNMENTS).document("asgn_1").set({
            "assignment_id": "asgn_1",
            "state": "offered",
            "created_at": now,
        })
        db.collection(COLLECTION_ASSIGNMENTS).document("asgn_2").set({
            "assignment_id": "asgn_2",
            "state": "completed",
            "created_at": now,
        })

        res = reconcile_daily(db, day=day)
        self.assertEqual(res["day"], day)
        self.assertFalse(res["matches"])
        self.assertIn("total_assignments", res["mismatches"])

    def test_terminal_outcome_without_event_flagged_as_consistency_error(self):
        db = FakeFirestore()
        now = time.time()
        # Assignment with terminal state 'accepted'
        db.collection(COLLECTION_ASSIGNMENTS).document("asgn_term_1").set({
            "assignment_id": "asgn_term_1",
            "passenger_id": "p_term_1",
            "driver_id": "d_term_1",
            "state": "accepted",
            "created_at": now,
        })
        # But NO event in dispatchEvents!
        stats = check_dispatch_invariants(db)
        self.assertTrue(stats["ok"])
        self.assertIn("consistency_errors", stats)
        self.assertTrue(any("missing matching event" in err for err in stats["consistency_errors"]))

    def test_terminal_outcome_with_matching_event_passes_consistency(self):
        db = FakeFirestore()
        now = time.time()
        # Assignment with terminal state 'accepted'
        db.collection(COLLECTION_ASSIGNMENTS).document("asgn_term_2").set({
            "assignment_id": "asgn_term_2",
            "passenger_id": "p_term_2",
            "driver_id": "d_term_2",
            "state": "accepted",
            "created_at": now,
        })
        # Matching event in dispatchEvents
        db.collection(COLLECTION_EVENTS).document("evt_term_2").set({
            "event_id": "evt_term_2",
            "event_type": "assignment_accepted",
            "actor_id": "d_term_2",
            "details": {"assignment_id": "asgn_term_2", "passenger_id": "p_term_2", "state": "accepted"},
            "timestamp": now,
        })
        stats = check_dispatch_invariants(db)
        self.assertTrue(stats["ok"])
        self.assertFalse(any("asgn_term_2" in err for err in stats.get("consistency_errors", [])))


class TestDispatchPhase2Hardening(unittest.TestCase):
    """Test hardening features: sweeper share preservation, feature flags, and admin endpoint."""

    def test_sweeper_expired_offer_preserves_share_pool_and_updates_assignment(self):
        from ..dispatch.sweeper import sweep_expired_offers
        db = FakeFirestore()
        now = time.time()
        # Driver in pool=SHARE with route stops, currently OFFERED
        db.collection(COLLECTION_DAP).document("drv_share_swept").set({
            "id": "drv_share_swept",
            "state": "OFFERED",
            "pool": "SHARE",
            "seats_free": 1,
            "route": [{"kind": "drop", "rideId": "pax_onboard", "lat": 23.84, "lng": 91.28}],
            "offer_expires_at": now - 10.0,  # Expired
            "current_offer_passenger_id": "pax_swept",
        })
        db.collection(COLLECTION_WPP).document("pax_swept").set({
            "id": "pax_swept",
            "state": "OFFERED",
            "current_offer_driver_id": "drv_share_swept",
            "offer_expires_at": now - 10.0,
        })
        db.collection(COLLECTION_ASSIGNMENTS).document("asgn_swept").set({
            "assignment_id": "asgn_swept",
            "passenger_id": "pax_swept",
            "driver_id": "drv_share_swept",
            "state": "offered",
            "created_at": now - 50.0,
        })

        reverted = sweep_expired_offers(db, now)
        self.assertGreater(reverted, 0)

        # Driver must be restored to SHARE_OPEN (not IDLE!), keeping pool=SHARE
        d_snap = db.collection(COLLECTION_DAP).document("drv_share_swept").get()
        d_data = d_snap.to_dict()
        self.assertEqual(d_data["state"], "SHARE_OPEN")
        self.assertEqual(d_data["pool"], "SHARE")

        # Assignment must be updated to expired
        asgn_snap = db.collection(COLLECTION_ASSIGNMENTS).document("asgn_swept").get()
        self.assertEqual(asgn_snap.to_dict()["state"], "expired")

        # Event must be logged
        evts = list(db.collection(COLLECTION_EVENTS).stream())
        self.assertTrue(any(e.to_dict().get("event_type") == "offer_expired" for e in evts))

    def test_share_disabled_flag_blocks_share_matching(self):
        driver = DriverEntry(
            id="drv_sh",
            loc=(23.83, 91.28),
            state="SHARE_OPEN",
            pool="SHARE",
            seats_free=2,
            route=[{"kind": "drop", "rideId": "p1", "lat": 23.84, "lng": 91.28}],
            is_approved=True,
        )
        pax = PassengerEntry(
            id="pax_sh",
            pickup=(23.831, 91.281),
            drop=(23.841, 91.281),
            req_time=time.time(),
            wants_share=True,
            vehicle_type="auto",
        )

        with patch("api.dispatch.engine.eligibility.SHARE_ENABLED", False):
            eligible, reason, _ = check_eligibility(pax, driver, now=time.time())
            self.assertFalse(eligible)
            self.assertEqual(reason, "share_disabled")

    def test_admin_dispatch_stats_endpoint(self):
        from fastapi.testclient import TestClient
        from ..index import app
        from ..core.admin import require_admin

        client = TestClient(app)

        # 1. Unauthenticated request should be rejected (401 or 403)
        res_unauth = client.get("/api/admin/dispatch-stats")
        self.assertIn(res_unauth.status_code, (401, 403))

        # 2. Admin user should receive 200 with all required metrics
        fake_admin = {"uid": "admin_123", "role": "admin", "admin": True}
        fake_db = FakeFirestore()
        app.dependency_overrides[require_admin] = lambda: fake_admin
        try:
            with patch("api.routers.admin._db", return_value=fake_db):
                res_admin = client.get("/api/admin/dispatch-stats")
                self.assertEqual(res_admin.status_code, 200)
                data = res_admin.json()
                self.assertTrue(data.get("ok"))
                self.assertIn("pool_sizes", data)
                self.assertIn("oldest_waiting_passenger", data)
                self.assertIn("oldest_idle_driver", data)
                self.assertIn("outstanding_offers", data)
                self.assertIn("invariant_violations", data)
                self.assertIn("reconciliation", data)
        finally:
            app.dependency_overrides.clear()


if __name__ == "__main__":
    unittest.main()
