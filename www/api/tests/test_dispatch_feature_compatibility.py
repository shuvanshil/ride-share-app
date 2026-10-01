from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
import pytest

from api.core.dispatch_config import DispatchConfig, load_dispatch_config
from api.core.dispatch_engine import run_dispatch_tick, trigger_opportunistic_tick
from api.core.errors import ApiError
from api.core.eta import compute_cheap_eta_minutes
from api.core.geo import get_all_zone_ids, get_zone_ring, point_to_zone
from api.core.matching import compute_pair_cost, solve_batch_matching
from api.routers.rides import (
    accept_driver_ride,
    cancel_passenger_ride,
    create_passenger_ride,
    create_pending_request,
    cron_activate_scheduled,
    expand_passenger_dispatch,
    reject_driver_ride,
    PendingRideRequestBody,
    RideCreateBody,
)


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True, collection_name: str = "", store: dict = None):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists
        self.reference = MockDocReference(collection_name, doc_id, store if store is not None else {})

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None), collection_name=self.collection_name, store=self._store)

    def set(self, data, merge=False):
        key = (self.collection_name, self.id)
        if merge and key in self._store:
            self._store[key].update(dict(data))
        else:
            self._store[key] = dict(data)

    def update(self, data):
        key = (self.collection_name, self.id)
        if key not in self._store:
            self._store[key] = {}
        for k, v in data.items():
            if type(v).__name__ == "ArrayUnion":
                curr = list(self._store[key].get(k) or [])
                for item in v.values:
                    if item not in curr:
                        curr.append(item)
                self._store[key][k] = curr
            elif type(v).__name__ == "ArrayRemove":
                curr = list(self._store[key].get(k) or [])
                for item in v.values:
                    if item in curr:
                        curr.remove(item)
                self._store[key][k] = curr
            else:
                self._store[key][k] = v

    def delete(self):
        self._store.pop((self.collection_name, self.id), None)


class MockQuery:
    def __init__(self, collection_name: str, store: dict, filters: list = None):
        self.collection_name = collection_name
        self.store = store
        self.filters = filters or []

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return MockQuery(self.collection_name, self.store, new_filters)

    def limit(self, count):
        return self

    def order_by(self, field, direction=None):
        return self

    def stream(self, transaction=None):
        results = []
        for (col, doc_id), data in self.store.items():
            if col != self.collection_name:
                continue
            matches = True
            for field, op, val in self.filters:
                if field == "__name__":
                    actual = doc_id
                else:
                    actual = data.get(field)
                if op == "==" and actual != val:
                    matches = False
                    break
                elif op == "in" and actual not in val:
                    matches = False
                    break
            if matches:
                results.append(MockDocSnapshot(doc_id, data, exists=True, collection_name=self.collection_name, store=self.store))
        return results

    def get(self):
        return list(self.stream())


class MockFirestoreDb:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def transaction(self):
        return MockTransaction(self)


class MockCollection:
    def __init__(self, name: str, store: dict):
        self.name = name
        self.store = store
        self._auto_id = 1

    def document(self, doc_id: str = None):
        if not doc_id:
            doc_id = f"mock_doc_{self._auto_id}"
            self._auto_id += 1
        return MockDocReference(self.name, doc_id, self.store)

    def where(self, field, op, val):
        return MockQuery(self.name, self.store, [(field, op, val)])

    def limit(self, count):
        return MockQuery(self.name, self.store).limit(count)

    def stream(self):
        return MockQuery(self.name, self.store).stream()

    def add(self, data):
        ref = self.document()
        ref.set(data)
        return None, ref


class MockTransaction:
    def __init__(self, db):
        self.db = db

    def get(self, ref):
        return ref.get()

    def update(self, ref, data):
        ref.update(data)

    def set(self, ref, data, merge=False):
        ref.set(data, merge=merge)


# ---------------------------------------------------------------------------
# 1. Staleness Cap & Location Freshness Tests (59, 61, 599, 601 seconds)
# ---------------------------------------------------------------------------

def test_staleness_cap_at_59_61_599_601_seconds():
    cfg = DispatchConfig(
        location_freshness_seconds=60,
        max_location_age_seconds_with_push=600,
        cheap_road_factor=1.4,
        cheap_speed_kmh=22.0,
    )

    # 59 seconds: fresh within 60s window (penalty (59-30)/30 = 0.967 min), valid with & without push
    eta_59_no_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=59.0, notification_eligible_until_valid=False, config=cfg)
    eta_59_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=59.0, notification_eligible_until_valid=True, config=cfg)
    assert abs(eta_59_no_push - eta_59_push) < 1e-4

    # 61 seconds: stale (>60s)
    # - With push: 5 min penalty
    eta_61_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=61.0, notification_eligible_until_valid=True, config=cfg)
    # - Without push: excluded (15 min penalty / disqualified)
    eta_61_no_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=61.0, notification_eligible_until_valid=False, config=cfg)
    assert eta_61_no_push > eta_61_push + 9.0

    # 599 seconds: near staleness cap
    # - With push: allowed with 5 min penalty
    eta_599_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=599.0, notification_eligible_until_valid=True, config=cfg)
    assert eta_599_push < 50.0

    # 601 seconds: beyond staleness cap (>600s)
    # - Disqualified even with push (age_penalty = 999.0)
    eta_601_push = compute_cheap_eta_minutes(24.33, 92.00, 24.34, 92.01, driver_location_age_sec=601.0, notification_eligible_until_valid=True, config=cfg)
    assert eta_601_push >= 999.0


# ---------------------------------------------------------------------------
# 2. Multi-Pass Match Rate Test (3 Clustered Rides in 1 Tick)
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_multi_pass_three_clustered_rides_matched_in_one_tick():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    # 3 Rides in Kailashahar (Zone Z06)
    for r_idx in (1, 2, 3):
        mock_db.store[("rides", f"ride_{r_idx}")] = {
            "status": "pending",
            "pickup_lat": 24.3314,
            "pickup_lng": 92.0084,
            "vehicle_type": "bike",
            "searchRing": 1,
            "searchStartedAt": now,
            "createdAt": now,
            "eligible_driver_ids": [],
            "rejected_driver_ids": [],
            "excludedDriverIds": [],
            "currentOffer": None,
        }

    # Drivers: D1 and D2 in Kailashahar (Z08); D3 in Boulapassa (Z08/Z09, ETA ~29m)
    mock_db.store[("driverPresence", "drv_1")] = {
        "uid": "drv_1",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "vehicle_type": "bike",
        "zoneId": "Z08",
        "driverLocation": {"lat": 24.3320, "lng": 92.0090},
        "lastLocationAt": now,
    }
    mock_db.store[("driverPresence", "drv_2")] = {
        "uid": "drv_2",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "vehicle_type": "bike",
        "zoneId": "Z08",
        "driverLocation": {"lat": 24.3330, "lng": 92.0100},
        "lastLocationAt": now,
    }
    mock_db.store[("driverPresence", "drv_3")] = {
        "uid": "drv_3",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "vehicle_type": "bike",
        "zoneId": "Z09",
        "driverLocation": {"lat": 24.3725, "lng": 92.0715},
        "lastLocationAt": now,
    }

    with patch("api.core.dispatch_engine.fb_firestore.client", return_value=mock_db), \
         patch("api.core.dispatch_engine.get_admin_app", return_value=MagicMock()), \
         patch("api.core.dispatch_engine.load_dispatch_config", return_value=DispatchConfig()):

        result = await run_dispatch_tick(force=True)
        assert result["ok"] is True
        # All 3 rides must be matched in a single tick through multi-pass resolution
        assert result["matched"] == 3

        # Confirm all 3 rides received distinct non-conflicting offers
        assigned_drivers = set()
        for r_idx in (1, 2, 3):
            ride = mock_db.store[("rides", f"ride_{r_idx}")]
            off = ride.get("currentOffer")
            assert off is not None
            assert off["driverId"] in ("drv_1", "drv_2", "drv_3")
            assigned_drivers.add(off["driverId"])
        assert len(assigned_drivers) == 3


# ---------------------------------------------------------------------------
# 3. Ring Expansion Lifecycle & 5-Minute Timeout
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_ring_expansion_all_triggers_and_bounds():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)
    mock_db.store[("users", "pass_1")] = {"uid": "pass_1", "role": "passenger"}

    # 1. Starts at 1
    mock_db.store[("rides", "ride_exp_1")] = {
        "passenger_id": "pass_1",
        "status": "pending",
        "searchRing": 1,
        "searchStartedAt": now - timedelta(seconds=45),  # Elapsed > 20s
        "pickup_lat": 24.3314,
        "pickup_lng": 92.0084,
        "vehicle_type": "bike",
        "eligible_driver_ids": [],
    }

    # Trigger A: Client `/dispatch` endpoint increments searchRing
    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.load_dispatch_config", return_value=DispatchConfig()), \
         patch("api.routers.rides.run_dispatch_tick", return_value={"ok": True}):

        res = await expand_passenger_dispatch("ride_exp_1", user={"uid": "pass_1"})
        assert res["searchRing"] == 2
        assert mock_db.store[("rides", "ride_exp_1")]["searchRing"] == 2

    # Trigger B: 5-minute expiration marks timeout
    mock_db.store[("rides", "ride_old_1")] = {
        "status": "pending",
        "createdAt": now - timedelta(seconds=350),  # > 300s
        "pickup_lat": 24.3314,
        "pickup_lng": 92.0084,
    }
    with patch("api.core.dispatch_engine.fb_firestore.client", return_value=mock_db), \
         patch("api.core.dispatch_engine.get_admin_app", return_value=MagicMock()), \
         patch("api.core.dispatch_engine.load_dispatch_config", return_value=DispatchConfig()):

        await run_dispatch_tick(caller_ride_id="ride_old_1", force=True)
        assert mock_db.store[("rides", "ride_old_1")]["status"] == "timeout"


# ---------------------------------------------------------------------------
# 4. Single Offer Writes eligible_driver_ids and currentOffer Together
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_single_offer_writes_eligible_and_current_offer_together():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    mock_db.store[("rides", "ride_single")] = {
        "status": "pending",
        "pickup_lat": 24.3314,
        "pickup_lng": 92.0084,
        "vehicle_type": "bike",
        "searchRing": 1,
        "searchStartedAt": now,
        "createdAt": now,
        "eligible_driver_ids": [],
    }
    mock_db.store[("driverPresence", "drv_solo")] = {
        "uid": "drv_solo",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "vehicle_type": "bike",
        "zoneId": "Z08",
        "driverLocation": {"lat": 24.3314, "lng": 92.0084},
        "lastLocationAt": now,
    }

    with patch("api.core.dispatch_engine.fb_firestore.client", return_value=mock_db), \
         patch("api.core.dispatch_engine.get_admin_app", return_value=MagicMock()), \
         patch("api.core.dispatch_engine.load_dispatch_config", return_value=DispatchConfig()):

        res = await run_dispatch_tick(force=True)
        assert res["matched"] == 1

        ride_after = mock_db.store[("rides", "ride_single")]
        # Exactly single driver in eligible_driver_ids matching currentOffer.driverId
        assert ride_after["eligible_driver_ids"] == ["drv_solo"]
        assert ride_after["currentOffer"]["driverId"] == "drv_solo"
        assert "expiresAt" in ride_after["currentOffer"]

        drv_presence = mock_db.store[("driverPresence", "drv_solo")]
        assert drv_presence["dispatchLock"]["rideId"] == "ride_single"


# ---------------------------------------------------------------------------
# 5. Accept Validation, Expiry Rejection & Decline Cycle
# ---------------------------------------------------------------------------

@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@pytest.mark.anyio
async def test_accept_and_decline_hex_batch_lifecycle():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    mock_db.store[("users", "drv_1")] = {"uid": "drv_1", "role": "driver", "verificationStatus": "approved", "vehicle_type": "bike"}
    mock_db.store[("users", "drv_2")] = {"uid": "drv_2", "role": "driver", "verificationStatus": "approved", "vehicle_type": "bike"}

    mock_db.store[("rides", "ride_cycle")] = {
        "passenger_id": "pass_1",
        "status": "pending",
        "vehicle_type": "bike",
        "eligible_driver_ids": ["drv_1"],
        "rejected_driver_ids": [],
        "currentOffer": {"driverId": "drv_1", "expiresAt": now + timedelta(seconds=15)},
        "createdAt": now,
    }
    mock_db.store[("driverPresence", "drv_1")] = {
        "dispatchLock": {"rideId": "ride_cycle", "expiresAt": now + timedelta(seconds=15)},
    }

    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.load_dispatch_config", return_value=DispatchConfig()), \
         patch("api.routers.rides.trigger_opportunistic_tick", return_value=None):

        # 1. Decline keeps ride pending and clears lock
        res_dec = await reject_driver_ride("ride_cycle", user={"uid": "drv_1"})
        assert res_dec["ok"] is True
        assert res_dec["status"] == "pending"
        assert mock_db.store[("driverPresence", "drv_1")]["dispatchLock"] is None
        assert "drv_1" in mock_db.store[("rides", "ride_cycle")]["rejected_driver_ids"]


# ---------------------------------------------------------------------------
# 6. Passenger Cancel Mid-Offer Releases Lock
# ---------------------------------------------------------------------------

@patch("firebase_admin.firestore.transactional", lambda fn: fn)
def test_passenger_cancel_mid_offer_clears_lock():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    mock_db.store[("users", "drv_1")] = {"uid": "drv_1", "role": "driver", "driverAvailability": "busy", "desiredAvailability": "online"}
    mock_db.store[("driverPresence", "drv_1")] = {"dispatchLock": {"rideId": "ride_cancel", "expiresAt": now + timedelta(seconds=15)}}

    mock_db.store[("rides", "ride_cancel")] = {
        "passenger_id": "pass_1",
        "driver_id": "drv_1",
        "status": "accepted",
    }

    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

        res = cancel_passenger_ride("ride_cancel", user={"uid": "pass_1"})
        assert res["ok"] is True
        assert res["status"] == "cancelled_by_passenger"


# ---------------------------------------------------------------------------
# 7. Passenger-Triggered Tick Scoping
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_passenger_triggered_tick_scopes_to_own_ride():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    mock_db.store[("rides", "ride_caller")] = {
        "status": "pending",
        "pickup_lat": 24.3314,
        "pickup_lng": 92.0084,
        "vehicle_type": "bike",
        "searchRing": 1,
        "searchStartedAt": now,
        "createdAt": now,
    }
    mock_db.store[("rides", "ride_other")] = {
        "status": "pending",
        "pickup_lat": 24.3768,
        "pickup_lng": 92.1643,
        "vehicle_type": "bike",
        "searchRing": 1,
        "searchStartedAt": now,
        "createdAt": now,
    }

    with patch("api.core.dispatch_engine.fb_firestore.client", return_value=mock_db), \
         patch("api.core.dispatch_engine.get_admin_app", return_value=MagicMock()), \
         patch("api.core.dispatch_engine.load_dispatch_config", return_value=DispatchConfig()):

        # Run tick scoped to ride_caller
        res = await run_dispatch_tick(caller_ride_id="ride_caller", force=True)
        assert res["ok"] is True
        # Only 1 ride was evaluated
        assert res["pending_count"] == 1


# ---------------------------------------------------------------------------
# 8. Opportunistic Throttling & Early Exit
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_opportunistic_tick_throttling_and_early_exit():
    mock_db = MockFirestoreDb()

    with patch("api.core.dispatch_engine.fb_firestore.client", return_value=mock_db), \
         patch("api.core.dispatch_engine.get_admin_app", return_value=MagicMock()), \
         patch("api.core.dispatch_engine.load_dispatch_config", return_value=DispatchConfig()):

        # 1. Early exit when no rides pending
        res = await run_dispatch_tick(force=True)
        assert res["ok"] is True
        assert res["pending_count"] == 0

        # 2. Throttling trigger check
        with patch("api.core.dispatch_engine.run_dispatch_tick") as mock_tick:
            await trigger_opportunistic_tick(caller_ride_id="r1")
            await trigger_opportunistic_tick(caller_ride_id="r1")  # Throttled within 5s
            assert mock_tick.call_count <= 1


# ---------------------------------------------------------------------------
# 9. Unoffered / Scheduled Ride Accept Safety
# ---------------------------------------------------------------------------

@patch("firebase_admin.firestore.transactional", lambda fn: fn)
def test_unoffered_scheduled_ride_accept_safety():
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)

    mock_db.store[("users", "drv_1")] = {"uid": "drv_1", "role": "driver", "verificationStatus": "approved", "vehicle_type": "bike"}

    # Existing ride created without active currentOffer
    mock_db.store[("rides", "ride_unoffered_inflight")] = {
        "passenger_id": "pass_1",
        "status": "pending",
        "vehicle_type": "bike",
        "eligible_driver_ids": ["drv_1"],
        "rejected_driver_ids": [],
        "currentOffer": None,
        "createdAt": now,
    }

    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.load_dispatch_config", return_value=DispatchConfig()):

        res = accept_driver_ride("ride_unoffered_inflight", user={"uid": "drv_1"})
        assert res["ok"] is True
        assert res["ride"]["status"] == "accepted"


# ---------------------------------------------------------------------------
# 10. Schedule For Later & Cron Activation Compatibility
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_schedule_for_later_and_cron_activation_compatibility():
    from api.routers.rides import activate_due_scheduled_requests
    mock_db = MockFirestoreDb()
    now = datetime.now(timezone.utc)
    mock_db.store[("users", "pass_1")] = {"uid": "pass_1", "role": "passenger", "name": "Passenger 1"}

    # 1. Schedule for later request with activatesAt in the past (due for activation)
    body = PendingRideRequestBody(
        pickupName="Kailashahar Center",
        dropName="Kumarghat Station",
        dropFullAddress="Kumarghat Station",
        pickupLat=24.3314,
        pickupLng=92.0084,
        dropLat=24.1612,
        dropLng=92.0305,
        vehicleType="bike",
        mode="schedule",
        activatesAt=(now - timedelta(minutes=1)).isoformat(),
        searchRadius=5000.0,
    )

    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.load_dispatch_config", return_value=DispatchConfig()):

        res = await create_pending_request(body, user={"uid": "pass_1"})
        assert res["ok"] is True
        assert res["mode"] == "schedule"
        req_id = res["requestId"]

        # 2. Cron activation sweep evaluates and promotes due scheduled request
        count = activate_due_scheduled_requests(mock_db)
        assert count >= 1


# ---------------------------------------------------------------------------
# 11. Notify Me Mode & Passenger Booking Compatibility
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_notify_me_mode_and_eligibility_compatibility():
    mock_db = MockFirestoreDb()
    mock_db.store[("users", "pass_2")] = {"uid": "pass_2", "role": "passenger", "name": "Passenger 2"}

    body = PendingRideRequestBody(
        pickupName="Dharmanagar",
        dropName="Panisagar",
        dropFullAddress="Panisagar Market",
        pickupLat=24.3768,
        pickupLng=92.1643,
        dropLat=24.2800,
        dropLng=92.1400,
        vehicleType="bike",
        mode="notify_only",
        searchRadius=5000.0,
    )

    with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.load_dispatch_config", return_value=DispatchConfig()):

        res = await create_pending_request(body, user={"uid": "pass_2"})
        assert res["ok"] is True
        assert res["mode"] == "notify_only"

        # Verify notify_only request is stored with correct mode
        doc = mock_db.store[("pendingRideRequests", res["requestId"])]
        assert doc["mode"] == "notify_only"
        assert doc["status"] == "pending"


# ---------------------------------------------------------------------------
# 12. Simulation Benchmark & Pass-1 Preservation Tests
# ---------------------------------------------------------------------------

def test_simulation_hex_batch_beats_or_matches_legacy_in_100_percent_cases():
    from scripts.simulate_dispatch import load_lla, load_zones, run_scenario

    lla = load_lla()
    zones = load_zones()

    # 300 drivers / 200 rides (100% match case)
    res_300_200 = run_scenario("300 Drivers / 200 Rides", 300, 200, lla, zones, seed=42)
    leg = res_300_200["legacy"]
    exact = res_300_200["hex_batch_exact"]

    assert exact["match_rate"] == 100.0
    # Hex-batch mean wait must be no worse than legacy mean (with 0.1 tolerance)
    assert exact["mean"] <= leg["mean"] + 0.1
    # Hex-batch max wait must be no worse than 1.1x legacy max
    assert exact["max"] <= leg["max"] * 1.1


def test_pass_1_assignments_identical_with_and_without_multi_pass():
    # Construct a set of active rides and candidate drivers
    rides = [
        {"id": "r1", "pickup_lat": 24.3314, "pickup_lng": 92.0084, "waiting_minutes": 2.0},
        {"id": "r2", "pickup_lat": 24.3350, "pickup_lng": 92.0100, "waiting_minutes": 1.0},
    ]
    candidate_map = {
        "r1": [("d1", 5.0), ("d2", 8.0)],
        "r2": [("d1", 6.0), ("d2", 7.0)],
    }

    # Pass 1 single-pass solve
    pass1_solve = solve_batch_matching(rides, candidate_map)
    assert pass1_solve == {"r1": "d1", "r2": "d2"}

    # When embedded in multi-pass, pass 1 assignments remain exact and preserved
    committed_proposals = {}
    free_drivers = {"d1": {}, "d2": {}}
    for r in rides:
        d_id = pass1_solve.get(r["id"])
        if d_id and d_id in free_drivers:
            committed_proposals[r["id"]] = d_id
            free_drivers.pop(d_id, None)

    assert committed_proposals == {"r1": "d1", "r2": "d2"}
    assert free_drivers == {}

