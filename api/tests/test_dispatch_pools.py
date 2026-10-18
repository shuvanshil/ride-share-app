"""In-memory fake store and integration tests for dispatch pools, runner, sweeper, and fallback."""
from __future__ import annotations

import io
import sys
import time
import unittest
from typing import Any, Optional
from unittest.mock import patch

from ..dispatch.config import (
    COLLECTION_ASSIGNMENTS,
    COLLECTION_CONTROL,
    COLLECTION_DAP,
    COLLECTION_EVENTS,
    COLLECTION_NOTIFICATIONS,
    COLLECTION_RUNS,
    COLLECTION_WPP,
    MAX_CONSECUTIVE_ENGINE_ERRORS,
)
from ..dispatch.pools import DispatchPoolManager
from ..dispatch.queries import get_dispatch_status, get_recent_assignments, get_recent_runs
from ..dispatch.runner import (
    get_consecutive_errors,
    nudge_dispatch,
    reset_consecutive_errors,
    run_dispatch,
    set_custom_fallback_handler,
)
from ..dispatch.sweeper import (
    run_dispatch_sweeper,
    sweep_expired_offers,
    sweep_outbox_notifications,
    sweep_stale_drivers,
    sweep_stuck_locks,
)


class FakeDocSnapshot:
    def __init__(self, doc_id: str, data: Optional[dict[str, Any]], ref: Any = None):
        self.id = doc_id
        self._data = data
        self.reference = ref

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict[str, Any]:
        return dict(self._data or {})


class FakeDocRef:
    def __init__(self, col: FakeCollection, doc_id: str):
        self._col = col
        self.id = doc_id

    def get(self, transaction: Any = None) -> FakeDocSnapshot:
        data = self._col._docs.get(self.id)
        return FakeDocSnapshot(self.id, data, ref=self)

    def set(self, data: dict[str, Any], merge: bool = False) -> None:
        if merge and self.id in self._col._docs:
            self._col._docs[self.id].update(data)
        else:
            self._col._docs[self.id] = dict(data)

    def update(self, data: dict[str, Any]) -> None:
        if self.id in self._col._docs:
            self._col._docs[self.id].update(data)
        else:
            self._col._docs[self.id] = dict(data)

    def delete(self) -> None:
        self._col._docs.pop(self.id, None)


class FakeQuery:
    def __init__(self, col: FakeCollection, filters: list[tuple[str, str, Any]]):
        self._col = col
        self._filters = filters
        self._limit: Optional[int] = None
        self._order_by_field: Optional[str] = None
        self._direction = "ASCENDING"

    def where(self, field: str, op: str, val: Any) -> FakeQuery:
        new_filters = list(self._filters)
        new_filters.append((field, op, val))
        q = FakeQuery(self._col, new_filters)
        q._limit = self._limit
        q._order_by_field = self._order_by_field
        q._direction = self._direction
        return q

    def limit(self, count: int) -> FakeQuery:
        self._limit = count
        return self

    def order_by(self, field: str, direction: str = "ASCENDING") -> FakeQuery:
        self._order_by_field = field
        self._direction = direction
        return self

    def stream(self, transaction: Any = None):
        results = []
        for doc_id, data in list(self._col._docs.items()):
            match = True
            for f, op, val in self._filters:
                doc_val = data.get(f)
                if op == "==" and doc_val != val:
                    match = False
                    break
                elif op == "in" and doc_val not in val:
                    match = False
                    break
            if match:
                results.append(FakeDocSnapshot(doc_id, data, ref=self._col.document(doc_id)))

        if self._order_by_field:
            reverse = self._direction.upper() == "DESCENDING"
            results.sort(key=lambda d: d._data.get(self._order_by_field, 0), reverse=reverse)

        if self._limit is not None:
            results = results[:self._limit]
        return iter(results)


class FakeCollection:
    def __init__(self, name: str):
        self.name = name
        self._docs: dict[str, dict[str, Any]] = {}

    def document(self, doc_id: Optional[str] = None) -> FakeDocRef:
        if not doc_id:
            doc_id = f"gen_{len(self._docs) + 1}_{int(time.time() * 1000)}"
        return FakeDocRef(self, doc_id)

    def where(self, field: str, op: str, val: Any) -> FakeQuery:
        return FakeQuery(self, [(field, op, val)])

    def order_by(self, field: str, direction: str = "ASCENDING") -> FakeQuery:
        return FakeQuery(self, []).order_by(field, direction)

    def limit(self, count: int) -> FakeQuery:
        return FakeQuery(self, []).limit(count)

    def stream(self):
        return FakeQuery(self, []).stream()


class FakeTransaction:
    def __init__(self, db: FakeFirestore):
        self._db = db

    def get(self, ref: Any) -> Any:
        return ref.get(transaction=self)

    def update(self, ref: Any, data: dict[str, Any]) -> None:
        ref.update(data)

    def set(self, ref: Any, data: dict[str, Any], merge: bool = False) -> None:
        ref.set(data, merge=merge)

    def delete(self, ref: Any) -> None:
        ref.delete()


class FakeFirestore:
    def __init__(self):
        self._cols: dict[str, FakeCollection] = {}

    def collection(self, name: str) -> FakeCollection:
        if name not in self._cols:
            self._cols[name] = FakeCollection(name)
        return self._cols[name]

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)


class TestDispatchPoolsAndRunner(unittest.TestCase):
    def setUp(self):
        self.db = FakeFirestore()
        reset_consecutive_errors()

    def test_wpp_idempotence(self):
        """Verify WPP addition is idempotent, tracks versions, and removal is idempotent."""
        p_id = "pax_101"
        res1 = DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id=p_id,
            pickup={"lat": 23.83, "lng": 91.28, "name": "Battala"},
            drop={"lat": 23.85, "lng": 91.28, "name": "Airport"},
            fare=120.0,
            vehicle_type="auto",
        )
        self.assertEqual(res1["version"], 1)
        self.assertEqual(res1["state"], "WAITING")

        # Second sync on same ID increments version and preserves state
        res2 = DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id=p_id,
            pickup={"lat": 23.83, "lng": 91.28, "name": "Battala"},
            drop={"lat": 23.85, "lng": 91.28, "name": "Airport"},
            fare=120.0,
            vehicle_type="auto",
        )
        self.assertEqual(res2["version"], 2)
        self.assertEqual(res2["state"], "WAITING")

        # Idempotent removal
        ok1 = DispatchPoolManager.remove_passenger_wpp(self.db, p_id)
        self.assertTrue(ok1)
        self.assertNotIn(p_id, self.db.collection(COLLECTION_WPP)._docs)

        # Removing again does not throw
        ok2 = DispatchPoolManager.remove_passenger_wpp(self.db, p_id)
        self.assertTrue(ok2)

    def test_dap_state_transitions(self):
        """Verify DAP states for online, searching, offline, busy, and share-open."""
        d_id = "drv_201"
        # 1. Searching with no route -> IDLE
        d1 = DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id=d_id,
            loc={"lat": 23.832, "lng": 91.281},
            availability="searching",
            vehicle_type="auto",
        )
        self.assertEqual(d1["state"], "IDLE")
        self.assertTrue(d1["cell"] != "")

        # 2. Searching with active route and free seats -> SHARE_OPEN
        d2 = DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id=d_id,
            loc={"lat": 23.832, "lng": 91.281},
            availability="searching",
            vehicle_type="auto",
            seats_free=2,
            route=[{"stop": 1}],
        )
        self.assertEqual(d2["state"], "SHARE_OPEN")

        # 3. Offline -> OFFLINE
        d3 = DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id=d_id,
            loc={"lat": 23.832, "lng": 91.281},
            availability="offline",
        )
        self.assertEqual(d3["state"], "OFFLINE")

    def test_runner_lease_and_matching_cycle(self):
        """Verify lease-based runner matches waiting passenger with available driver."""
        now = time.time()
        # Create waiting passenger in WPP
        DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id="pax_test_1",
            pickup={"lat": 23.8300, "lng": 91.2800, "name": "Start"},
            drop={"lat": 23.8400, "lng": 91.2800, "name": "End"},
            fare=100.0,
            vehicle_type="auto",
            req_time=now,
        )

        # Create idle driver in DAP ~1 km away
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_test_1",
            loc={"lat": 23.8350, "lng": 91.2800},
            availability="searching",
            vehicle_type="auto",
        )

        # Execute dispatch runner
        res = run_dispatch(db=self.db, force=False)
        self.assertTrue(res["ok"])
        self.assertEqual(res["assignments_count"], 1)

        # Verify passenger and driver transitioned to OFFERED
        p_doc = self.db.collection(COLLECTION_WPP).document("pax_test_1").get().to_dict()
        d_doc = self.db.collection(COLLECTION_DAP).document("drv_test_1").get().to_dict()
        self.assertEqual(p_doc["state"], "OFFERED")
        self.assertEqual(p_doc["current_offer_driver_id"], "drv_test_1")
        self.assertEqual(d_doc["state"], "OFFERED")
        self.assertEqual(d_doc["current_offer_passenger_id"], "pax_test_1")

        # Verify notification queued in dispatchNotifications
        notifs = list(self.db.collection(COLLECTION_NOTIFICATIONS).stream())
        self.assertGreaterEqual(len(notifs), 1)
        self.assertEqual(notifs[0].to_dict()["recipient_id"], "drv_test_1")

    def test_sweeper_stale_and_expired_offers(self):
        """Verify sweeper demotes stale GPS drivers and reverts expired offers."""
        now = time.time()

        # 1. Driver stale > 45s
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_stale",
            loc={"lat": 23.83, "lng": 91.28},
            availability="searching",
        )
        # Manually backdate last_seen
        self.db.collection(COLLECTION_DAP).document("drv_stale").update({"last_seen": now - 60.0})

        # 2. Offered passenger whose offer expired
        DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id="pax_exp",
            pickup={"lat": 23.83, "lng": 91.28},
            drop={"lat": 23.84, "lng": 91.28},
            fare=80.0,
        )
        self.db.collection(COLLECTION_WPP).document("pax_exp").update({
            "state": "OFFERED",
            "current_offer_driver_id": "drv_unresponsive",
            "offer_expires_at": now - 10.0,
        })
        self.db.collection(COLLECTION_DAP).document("drv_unresponsive").set({
            "id": "drv_unresponsive",
            "state": "OFFERED",
            "offer_expires_at": now - 10.0,
            "last_seen": now,
        })

        # Run sweeper
        sweep_res = run_dispatch_sweeper(self.db)
        self.assertTrue(sweep_res["ok"])
        self.assertEqual(sweep_res["stale_drivers_demoted"], 1)
        self.assertGreaterEqual(sweep_res["expired_offers_reverted"], 1)

        # Check driver demoted to STALE
        d_stale_data = self.db.collection(COLLECTION_DAP).document("drv_stale").get().to_dict()
        self.assertEqual(d_stale_data["state"], "STALE")

        # Check passenger reverted to WAITING with driver banned
        p_exp_data = self.db.collection(COLLECTION_WPP).document("pax_exp").get().to_dict()
        self.assertEqual(p_exp_data["state"], "WAITING")
        self.assertIn("drv_unresponsive", p_exp_data["banned"])

    def test_consecutive_error_and_safe_fallback(self):
        """Verify that repeated consecutive engine errors trigger fallback with console logging."""
        now = time.time()
        # Seed entries
        DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id="pax_f1",
            pickup={"lat": 23.83, "lng": 91.28},
            drop={"lat": 23.84, "lng": 91.28},
        )
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_f1",
            loc={"lat": 23.83, "lng": 91.28},
            availability="searching",
        )

        fallback_called = []

        def mock_fallback(db_arg):
            fallback_called.append(True)
            return {"fallback_processed": True}

        set_custom_fallback_handler(mock_fallback)

        # Patch solve_dispatch to simulate crash in new engine
        captured_stderr = io.StringIO()
        with patch("api.dispatch.runner.solve_dispatch", side_effect=RuntimeError("Simulated algorithm bug")):
            with patch("sys.stderr", captured_stderr):
                # Run 1, 2, 3 failures
                for _ in range(MAX_CONSECUTIVE_ENGINE_ERRORS):
                    res = run_dispatch(self.db, force=True)
                    self.assertFalse(res["ok"])

                self.assertEqual(get_consecutive_errors(), MAX_CONSECUTIVE_ENGINE_ERRORS)

                # 4th run enters fallback mode and invokes fallback handler
                fb_res = run_dispatch(self.db, force=True)
                self.assertTrue(fb_res["ok"])
                self.assertEqual(fb_res["mode"], "fallback")
                self.assertTrue(len(fallback_called) >= 1)

        # Verify that fallback was explicitly logged to console/stderr
        stderr_output = captured_stderr.getvalue()
        self.assertIn("[DISPATCH_FALLBACK]", stderr_output)

        # Verify recovery resets consecutive errors to 0
        reset_consecutive_errors()
        self.assertEqual(get_consecutive_errors(), 0)

    def test_sweeper_scheduled_ride_release_and_timeout(self):
        """Verify sweeper releases due scheduled rides into WPP and marks unserved rides as timed out."""
        now = time.time()
        # 1. Scheduled ride due in 5 minutes (within 15 min lead window)
        sched_due_data = {
            "requestId": "sched_1",
            "passengerId": "pax_sched_due",
            "pickup": {"lat": 23.83, "lng": 91.28, "name": "Airport"},
            "drop": {"lat": 23.85, "lng": 91.28, "name": "City"},
            "fare": 150.0,
            "vehicleType": "auto",
            "activatesAt": now + 300.0,  # 5 min in future
            "status": "pending",
        }
        self.db.collection("dispatchScheduled").document("sched_1").set(sched_due_data)
        self.db.collection("pendingRideRequests").document("sched_1").set(sched_due_data)

        # 2. Scheduled ride that timed out (15 minutes past activation time)
        sched_past_data = {
            "requestId": "sched_past",
            "passengerId": "pax_sched_past",
            "pickup": {"lat": 23.83, "lng": 91.28, "name": "Station"},
            "drop": {"lat": 23.85, "lng": 91.28, "name": "City"},
            "fare": 120.0,
            "vehicleType": "auto",
            "activatesAt": now - 700.0,  # >10 min past
            "status": "pending",
        }
        self.db.collection("dispatchScheduled").document("sched_past").set(sched_past_data)
        self.db.collection("pendingRideRequests").document("sched_past").set(sched_past_data)

        res = run_dispatch_sweeper(self.db)
        self.assertTrue(res["ok"])
        self.assertGreaterEqual(res["scheduled_rides_handled"], 1)

        # Check due scheduled ride was released to WPP
        wpp_doc = self.db.collection(COLLECTION_WPP).document("pax_sched_due").get().to_dict()
        self.assertEqual(wpp_doc["state"], "WAITING")
        self.assertEqual(wpp_doc["pending_request_id"], "sched_1")

        # Check past scheduled ride was timed out
        past_doc = self.db.collection("dispatchScheduled").document("sched_past").get().to_dict()
        self.assertTrue(past_doc.get("scheduleTimedOut"))
        self.assertEqual(past_doc.get("status"), "schedule_timed_out")

    def test_sweeper_notify_me_proximity_alert_and_expiry(self):
        """Verify sweeper detects nearby drivers for notify-me requests and expires past-TTL items."""
        now = time.time()
        # 1. Notify-me request with driver nearby
        notify_data = {
            "requestId": "notify_1",
            "passengerId": "pax_notif_1",
            "pickup": {"lat": 23.8300, "lng": 91.2800, "name": "Central Park"},
            "searchRadius": 5000.0,
            "vehicleType": "auto",
            "status": "pending",
        }
        self.db.collection("dispatchNotifyMe").document("notify_1").set(notify_data)
        self.db.collection("pendingRideRequests").document("notify_1").set(notify_data)

        # Place nearby IDLE auto driver ~1 km away
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_nearby",
            loc={"lat": 23.8350, "lng": 91.2800},
            availability="searching",
            vehicle_type="auto",
        )

        # 2. Expired notify-me request
        expired_data = {
            "requestId": "notify_exp",
            "passengerId": "pax_notif_exp",
            "pickup": {"lat": 23.8300, "lng": 91.2800},
            "expiresAt": now - 100.0,
            "status": "pending",
        }
        self.db.collection("dispatchNotifyMe").document("notify_exp").set(expired_data)

        res = run_dispatch_sweeper(self.db)
        self.assertTrue(res["ok"])
        self.assertGreaterEqual(res["notify_me_handled"], 1)

        # Check notification was dispatched for notify_1
        notif_doc = self.db.collection("dispatchNotifyMe").document("notify_1").get().to_dict()
        self.assertIsNotNone(notif_doc.get("lastNotifiedAt"))

        notifs = [
            n.to_dict() for n in self.db.collection(COLLECTION_NOTIFICATIONS).stream()
            if n.to_dict().get("recipient_id") == "pax_notif_1"
        ]
        self.assertGreaterEqual(len(notifs), 1)
        self.assertEqual(notifs[0]["type"], "pending_driver_available")

        # Check expired doc is updated
        exp_doc = self.db.collection("dispatchNotifyMe").document("notify_exp").get().to_dict()
        self.assertEqual(exp_doc["status"], "expired")

    def test_pending_request_auto_materializes_rides_doc(self):
        """Verify runner creates concrete rides doc when matching pending request in auto mode."""
        now = time.time()
        pending_id = "req_auto_1"
        pending_data = {
            "requestId": pending_id,
            "passengerId": "pax_auto_1",
            "passengerName": "Alice Walker",
            "passengerPhone": "9876543210",
            "pickup": {"lat": 23.8300, "lng": 91.2800, "name": "Mall"},
            "drop": {"lat": 23.8400, "lng": 91.2800, "name": "Office", "address": "Office Rd"},
            "distanceKm": 2.5,
            "fare": 90.0,
            "vehicleType": "auto",
            "mode": "auto",
            "status": "pending",
            "createdAt": now,
        }
        self.db.collection("pendingRideRequests").document(pending_id).set(pending_data)

        # Sync to WPP without a pre-existing ride_id
        DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id="pax_auto_1",
            pickup=pending_data["pickup"],
            drop=pending_data["drop"],
            fare=90.0,
            vehicle_type="auto",
            mode="auto",
            pending_request_id=pending_id,
            ride_id=None,
            req_time=now,
        )

        # Add idle driver
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_auto_match",
            loc={"lat": 23.8320, "lng": 91.2800},
            availability="searching",
            vehicle_type="auto",
        )

        res = run_dispatch(self.db, force=False)
        self.assertTrue(res["ok"])
        self.assertEqual(res["assignments_count"], 1)

        # Confirm rides collection has new materialized ride document
        rides = list(self.db.collection("rides").stream())
        self.assertEqual(len(rides), 1)
        new_ride = rides[0].to_dict()
        self.assertEqual(new_ride["passenger_id"], "pax_auto_1")
        self.assertEqual(new_ride["current_offer_driver_id"], "drv_auto_match")
        self.assertEqual(new_ride["eligible_driver_ids"], ["drv_auto_match"])
        self.assertEqual(new_ride["status"], "pending")
        self.assertEqual(new_ride["pendingRequestId"], pending_id)

        # Confirm pendingRideRequests was linked to the new ride
        p_req_after = self.db.collection("pendingRideRequests").document(pending_id).get().to_dict()
        self.assertEqual(p_req_after["status"], "dispatching")
        self.assertEqual(p_req_after["rideId"], rides[0].id)
        self.assertEqual(p_req_after["lockedByDriverId"], "drv_auto_match")

    def test_reject_ride_retains_pending_and_offers_next_driver(self):
        """Verify that when driver rejects a pool ride, ride remains pending and matches next driver."""
        now = time.time()
        # Create passenger in WPP and rides collection
        ride_id = "ride_rej_test"
        self.db.collection("rides").document(ride_id).set({
            "passenger_id": "pax_rej_1",
            "status": "pending",
            "current_offer_driver_id": "drv_1",
            "eligible_driver_ids": ["drv_1"],
            "rejected_driver_ids": [],
            "search_status": "matched_offer_sent",
        })
        DispatchPoolManager.sync_passenger_wpp(
            db=self.db,
            passenger_id="pax_rej_1",
            pickup={"lat": 23.83, "lng": 91.28},
            drop={"lat": 23.85, "lng": 91.28},
            ride_id=ride_id,
            req_time=now,
        )
        self.db.collection(COLLECTION_WPP).document("pax_rej_1").update({
            "state": "OFFERED",
            "current_offer_driver_id": "drv_1",
        })

        # Add two drivers: drv_1 (who rejects) and drv_2 (available for next match)
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_1",
            loc={"lat": 23.831, "lng": 91.28},
            availability="searching",
        )
        DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id="drv_2",
            loc={"lat": 23.833, "lng": 91.28},
            availability="searching",
        )

        # Driver 1 declines: simulate reject logic
        # 1. Update rides document
        curr_ride = self.db.collection("rides").document(ride_id).get().to_dict()
        rejected = list(dict.fromkeys([*(curr_ride.get("rejected_driver_ids") or []), "drv_1"]))
        remaining = [d for d in curr_ride.get("eligible_driver_ids", []) if d not in rejected]
        is_pool_managed = bool(curr_ride.get("current_offer_driver_id") or curr_ride.get("search_status") == "matched_offer_sent")
        
        updates = {"rejected_driver_ids": rejected}
        if not remaining and not is_pool_managed:
            updates["status"] = "declined"
        elif is_pool_managed:
            updates["current_offer_driver_id"] = None
            updates["search_status"] = "searching_nearby_drivers"
        self.db.collection("rides").document(ride_id).update(updates)

        # Ride status MUST still be pending!
        ride_after_rej = self.db.collection("rides").document(ride_id).get().to_dict()
        self.assertEqual(ride_after_rej["status"], "pending")
        self.assertIn("drv_1", ride_after_rej["rejected_driver_ids"])

        # 2. Revert passenger in WPP with drv_1 banned
        wpp_doc = self.db.collection(COLLECTION_WPP).document("pax_rej_1").get().to_dict()
        banned = list(wpp_doc.get("banned") or [])
        banned.append("drv_1")
        self.db.collection(COLLECTION_WPP).document("pax_rej_1").update({
            "state": "WAITING",
            "banned": banned,
            "current_offer_driver_id": None,
        })

        # 3. Next dispatch run matches drv_2!
        run_res = run_dispatch(self.db, force=False)
        self.assertTrue(run_res["ok"])
        self.assertEqual(run_res["assignments_count"], 1)

        # Verify drv_2 is now assigned
        wpp_final = self.db.collection(COLLECTION_WPP).document("pax_rej_1").get().to_dict()
        self.assertEqual(wpp_final["state"], "OFFERED")
        self.assertEqual(wpp_final["current_offer_driver_id"], "drv_2")

        ride_final = self.db.collection("rides").document(ride_id).get().to_dict()
        self.assertEqual(ride_final["current_offer_driver_id"], "drv_2")
        self.assertEqual(ride_final["eligible_driver_ids"], ["drv_2"])

    def test_shared_ride_accept_preserves_share_open(self):
        """Verify that accepting a shared ride with remaining seats keeps driver in SHARE_OPEN."""
        now = time.time()
        d_id = "drv_share_1"
        # Shared driver initially searching
        dap = DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id=d_id,
            loc={"lat": 23.83, "lng": 91.28},
            availability="searching",
            vehicle_type="auto",
        )
        self.assertEqual(dap["state"], "IDLE")

        # Simulate shared ride accept with 1 out of 3 seats occupied
        trip_id = "trip_s1"
        self.db.collection("shareTrips").document(trip_id).set({
            "driverId": d_id,
            "seatsUsed": 1,
            "maxSeats": 3,
            "stopOrder": [{"stop": "pax1_drop"}],
        })

        # Driver accepts shared ride: free_seats = 3 - 1 = 2
        dap_after_accept = DispatchPoolManager.sync_driver_dap(
            db=self.db,
            driver_id=d_id,
            loc={"lat": 23.83, "lng": 91.28},
            availability="searching",
            vehicle_type="auto",
            seats_free=2,
            route=[{"stop": "pax1_drop"}],
        )
        self.assertEqual(dap_after_accept["state"], "SHARE_OPEN")
        self.assertEqual(dap_after_accept["seats_free"], 2)


if __name__ == "__main__":
    unittest.main()
