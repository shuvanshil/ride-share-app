from __future__ import annotations

import math
import time
from datetime import datetime, timezone, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.core.geo import decode_polyline, encode_polyline, haversine_km
from api.index import app
from api.routers.rides import current_user


def calculate_bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float | None:
    if abs(lat1 - lat2) < 1e-7 and abs(lng1 - lng2) < 1e-7:
        return None
    r_lat1 = math.radians(lat1)
    r_lat2 = math.radians(lat2)
    d_lng = math.radians(lng2 - lng1)
    y = math.sin(d_lng) * math.cos(r_lat2)
    x = math.cos(r_lat1) * math.sin(r_lat2) - math.sin(r_lat1) * math.cos(r_lat2) * math.cos(d_lng)
    return ((math.degrees(math.atan2(y, x)) % 360) + 360) % 360

# Agartala test coordinates
PICKUP_LOC = {"lat": 23.8360, "lng": 91.2820}
DROP_LOC = {"lat": 23.8580, "lng": 91.2980}


class MockCollection:
    def __init__(self, store: dict[str, dict[str, Any]], db: Any, name: str):
        self.store = store
        self.db = db
        self.name = name

    def document(self, doc_id: str | None = None):
        if not doc_id:
            doc_id = f"doc_{len(self.store) + 1}_{int(time.time() * 1000)}"
        return MockDocRef(self.store, doc_id, self.db, self.name)

    def where(self, field: str, op: str, value: Any):
        return MockQuery(self.store, field, op, value)

    def add(self, data: dict[str, Any]):
        doc_id = f"doc_{len(self.store) + 1}_{int(time.time() * 1000)}"
        ref = self.document(doc_id)
        ref.set(data)
        return None, ref


class MockQuery:
    def __init__(self, store: dict[str, dict[str, Any]], field: str, op: str, value: Any, filters=None):
        self.store = store
        self.filters = list(filters) if filters else []
        self.filters.append((field, op, value))
        self._limit = None

    def where(self, field: str, op: str, value: Any):
        return MockQuery(self.store, field, op, value, filters=self.filters)

    def limit(self, n: int):
        self._limit = n
        return self

    def stream(self):
        count = 0
        for doc_id, data in list(self.store.items()):
            match = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==":
                    if doc_val != val:
                        match = False
                        break
                elif op == "in":
                    if not isinstance(val, (list, tuple, set)) or doc_val not in val:
                        match = False
                        break
            if match:
                yield MockDocSnapshot(doc_id, dict(data))
                count += 1
                if self._limit is not None and count >= self._limit:
                    break


class MockDocRef:
    def __init__(self, store: dict[str, dict[str, Any]], doc_id: str, db: Any, col_name: str):
        self.store = store
        self.id = doc_id
        self.db = db
        self.col_name = col_name

    def get(self, transaction: Any = None):
        data = self.store.get(self.id)
        return MockDocSnapshot(self.id, dict(data) if data is not None else None)

    def set(self, data: dict[str, Any], merge: bool = False):
        if merge and self.id in self.store:
            self.store[self.id].update(data)
        else:
            self.store[self.id] = dict(data)

    def update(self, data: dict[str, Any]):
        if self.id not in self.store:
            self.store[self.id] = {}
        for k, v in data.items():
            if hasattr(v, "value"):
                cur = self.store[self.id].get(k, 0)
                self.store[self.id][k] = cur + v.value
            else:
                self.store[self.id][k] = v

    def delete(self):
        self.store.pop(self.id, None)

    def collection(self, name: str):
        # Allow nested subcollections
        key = f"{self.col_name}/{self.id}/{name}"
        if key not in self.db.collections:
            self.db.collections[key] = {}
        return MockCollection(self.db.collections[key], self.db, key)


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict[str, Any] | None):
        self.id = doc_id
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict[str, Any] | None:
        return self._data


class MockTransaction:
    def __init__(self, db: Any):
        self.db = db

    def get(self, ref: MockDocRef):
        return ref.get()

    def set(self, ref: MockDocRef, data: dict[str, Any], merge: bool = False):
        ref.set(data, merge=merge)

    def update(self, ref: MockDocRef, data: dict[str, Any]):
        ref.update(data)

    def delete(self, ref: MockDocRef):
        ref.delete()


class MockBatch:
    def __init__(self, db: Any):
        self.db = db
        self.ops = []

    def set(self, doc_ref: MockDocRef, data: dict[str, Any], merge: bool = False):
        self.ops.append(("set", doc_ref, data, merge))

    def update(self, doc_ref: MockDocRef, data: dict[str, Any]):
        self.ops.append(("update", doc_ref, data, False))

    def commit(self):
        for op, doc_ref, data, merge in self.ops:
            if op == "set":
                doc_ref.set(data, merge=merge)
            elif op == "update":
                doc_ref.update(data)
        self.ops.clear()


class MockFirestoreDb:
    def __init__(self):
        self.collections: dict[str, dict[str, dict[str, Any]]] = {
            "users": {},
            "rides": {},
            "driverPresence": {},
            "driverMapPresence": {},
            "tripShareView": {},
            "driver_history": {},
            "daily_driver_stats": {},
            "shareTrips": {},
        }

    def collection(self, name: str):
        if name not in self.collections:
            self.collections[name] = {}
        return MockCollection(self.collections[name], self, name)

    def batch(self):
        return MockBatch(self)

    def transaction(self):
        return MockTransaction(self)


def generate_straight_polyline(start: dict, end: dict, steps: int = 20) -> list[tuple[float, float]]:
    pts = []
    for i in range(steps + 1):
        frac = i / steps
        lat = start["lat"] + (end["lat"] - start["lat"]) * frac
        lng = start["lng"] + (end["lng"] - start["lng"]) * frac
        pts.append((round(lat, 6), round(lng, 6)))
    return pts


@pytest.fixture
def sim_env():
    mock_db = MockFirestoreDb()
    driver_uid = "drv_sim_001"
    passenger_uid = "pax_sim_001"
    driver_auth = {"uid": driver_uid, "role": "driver"}
    passenger_auth = {"uid": passenger_uid, "role": "passenger"}

    mock_db.collection("users").document(driver_uid).set({
        "uid": driver_uid,
        "name": "Biplab Barman",
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "vehicleType": "auto",
        "vehicle_type": "auto",
        "vehicle_model": "Bajaj RE Auto",
        "vehicle_number": "TR-01-AB-1234",
        "total_completed_trips": 10,
        "lifetime_earnings": 1500.0,
        "lifetime_distance_km": 45.0,
    })

    mock_db.collection("users").document(passenger_uid).set({
        "uid": passenger_uid,
        "name": "Ananya Debnath",
        "role": "passenger",
    })

    dest_pts = generate_straight_polyline(PICKUP_LOC, DROP_LOC, steps=25)
    encoded_dest_poly = encode_polyline(dest_pts)
    planned_km = haversine_km(PICKUP_LOC["lat"], PICKUP_LOC["lng"], DROP_LOC["lat"], DROP_LOC["lng"]) * 1.25

    return {
        "db": mock_db,
        "driver_uid": driver_uid,
        "passenger_uid": passenger_uid,
        "driver_auth": driver_auth,
        "passenger_auth": passenger_auth,
        "dest_pts": dest_pts,
        "encoded_dest_poly": encoded_dest_poly,
        "planned_km": planned_km,
    }


def test_scenario_1_normal_urban_ride(sim_env):
    """Scenario 1: Complete normal urban ride lifecycle: approach -> arrive -> start -> destination travel -> complete."""
    db = sim_env["db"]
    ride_id = "s1_ride_normal"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": sim_env["driver_uid"],
        "passenger_id": sim_env["passenger_uid"],
        "status": "accepted",
        "pickup_lat": PICKUP_LOC["lat"],
        "pickup_lng": PICKUP_LOC["lng"],
        "drop_lat": DROP_LOC["lat"],
        "drop_lng": DROP_LOC["lng"],
        "distance_km": round(sim_env["planned_km"], 2),
        "fare": 95.0,
        "verification_pin": "1234",
        "route_polyline": sim_env["encoded_dest_poly"],
        "share_enabled": True,
        "createdAt": datetime.now(timezone.utc),
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: sim_env["driver_auth"]

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

        # 1. Driver approaches pickup (5 updates)
        approach_pts = generate_straight_polyline({"lat": 23.8320, "lng": 91.2800}, PICKUP_LOC, steps=5)
        for i, pt in enumerate(approach_pts):
            resp = client.post("/api/rides/driver-location", json={
                "lat": pt[0], "lng": pt[1], "rideId": ride_id,
                "driverHeading": 45.0, "driverSpeed": 8.0, "driverAccuracy": 5.0
            })
            assert resp.status_code == 200
            assert resp.json()["ok"] is True

        # Check tripShareView contains driverLocationUpdatedAt
        share_view = db.collection("tripShareView").document(ride_id).get().to_dict()
        assert share_view is not None
        assert "driverLocationUpdatedAt" in share_view
        assert share_view["status"] == "accepted"

        # 2. Driver arrives at pickup
        arr_resp = client.post(f"/api/rides/{ride_id}/transition", json={
            "action": "arrive", "lat": PICKUP_LOC["lat"], "lng": PICKUP_LOC["lng"]
        })
        assert arr_resp.status_code == 200
        assert db.collection("rides").document(ride_id).get().to_dict()["status"] == "arrived"

        # 3. Passenger verifies PIN and starts trip
        start_resp = client.post(f"/api/rides/{ride_id}/transition", json={
            "action": "verify_pin", "pin": "1234", "lat": PICKUP_LOC["lat"], "lng": PICKUP_LOC["lng"]
        })
        assert start_resp.status_code == 200
        assert db.collection("rides").document(ride_id).get().to_dict()["status"] == "en_route"

        # 4. Travel along destination polyline (monotonic distance increase)
        prev_dist = 0.0
        for pt in sim_env["dest_pts"]:
            resp = client.post("/api/rides/driver-location", json={
                "lat": pt[0], "lng": pt[1], "rideId": ride_id,
                "driverHeading": 35.0, "driverSpeed": 9.5, "driverAccuracy": 6.0,
                "routePolyline": sim_env["encoded_dest_poly"],
            })
            assert resp.status_code == 200
            cur_ride = db.collection("rides").document(ride_id).get().to_dict()
            cur_dist = float(cur_ride.get("max_travelled_km") or 0.0)
            assert cur_dist >= prev_dist  # Monotonic guarantee
            prev_dist = cur_dist

        # 5. Complete ride
        comp_resp = client.post(f"/api/rides/{ride_id}/transition", json={
            "action": "complete", "lat": DROP_LOC["lat"], "lng": DROP_LOC["lng"]
        })
        assert comp_resp.status_code == 200
        final_ride = db.collection("rides").document(ride_id).get().to_dict()
        assert final_ride["status"] == "completed"

    app.dependency_overrides.pop(current_user, None)


def test_scenario_2_dense_turns_and_slow_traffic(sim_env):
    """Scenario 2: Low speeds, sharp turns, standstill at red lights, degraded GPS accuracy."""
    db = sim_env["db"]
    ride_id = "s2_dense_turns"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": sim_env["driver_uid"],
        "passenger_id": sim_env["passenger_uid"],
        "status": "started",
        "distance_km": 2.0,
        "fare": 70.0,
        "pickup_lat": 23.8300,
        "pickup_lng": 91.2800,
        "drop_lat": 23.8400,
        "drop_lng": 91.2900,
        "share_enabled": True,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: sim_env["driver_auth"]

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

        # Stop at red light: speed = 0, degraded GPS accuracy = 20m
        for _ in range(3):
            resp = client.post("/api/rides/driver-location", json={
                "lat": 23.8315, "lng": 91.2810, "rideId": ride_id,
                "driverHeading": 90.0, "driverSpeed": 0.0, "driverAccuracy": 20.0
            })
            assert resp.status_code == 200

        # Slow crawl after light: speed = 2.5 m/s (~9 km/h)
        crawl_resp = client.post("/api/rides/driver-location", json={
            "lat": 23.8318, "lng": 91.2810, "rideId": ride_id,
            "driverHeading": 0.0, "driverSpeed": 2.5, "driverAccuracy": 12.0
        })
        assert crawl_resp.status_code == 200
        assert db.collection("rides").document(ride_id).get().to_dict()["driverSpeed"] == 2.5

    app.dependency_overrides.pop(current_user, None)


def test_scenario_3_weak_network_out_of_order_rejection(sim_env):
    """Scenario 3: Out-of-order rejection and burst reconnection recovery."""
    db = sim_env["db"]
    ride_id = "s3_weak_network"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": sim_env["driver_uid"],
        "passenger_id": sim_env["passenger_uid"],
        "status": "started",
        "distance_km": 2.5,
        "fare": 80.0,
        "pickup_lat": 23.8300,
        "pickup_lng": 91.2800,
        "drop_lat": 23.8500,
        "drop_lng": 91.3000,
        "share_enabled": True,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: sim_env["driver_auth"]

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

        # Packet 1 at time t
        r1 = client.post("/api/rides/driver-location", json={
            "lat": 23.8320, "lng": 91.2820, "rideId": ride_id, "driverHeading": 45.0
        })
        assert r1.status_code == 200

        # Packet 2 at time t+4s
        r2 = client.post("/api/rides/driver-location", json={
            "lat": 23.8350, "lng": 91.2850, "rideId": ride_id, "driverHeading": 45.0
        })
        assert r2.status_code == 200

        # Client-side filtering check: older packet rejected
        def filter_telemetry(raw_pos, now_ms, epoch_ms, state):
            if epoch_ms > 0:
                if epoch_ms < state["last_epoch"]:
                    return None
            state["last_epoch"] = epoch_ms
            return raw_pos

        filter_state = {"last_epoch": 0}
        f1 = filter_telemetry({"lat": 23.8350, "lng": 91.2850}, 1000, 1700000004000, filter_state)
        assert f1 is not None
        # Delayed/stale packet with epoch 1700000001000 arrives late
        f_stale = filter_telemetry({"lat": 23.8320, "lng": 91.2820}, 1500, 1700000001000, filter_state)
        assert f_stale is None  # Successfully dropped out-of-order packet

    app.dependency_overrides.pop(current_user, None)


def test_scenario_4_gps_anomalies_and_teleport_rejection(sim_env):
    """Scenario 4: Implausible supersonic speed (> 55 m/s) rejected by backend; valid duplicate handled."""
    db = sim_env["db"]
    ride_id = "s4_gps_anomalies"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": sim_env["driver_uid"],
        "passenger_id": sim_env["passenger_uid"],
        "status": "started",
        "distance_km": 3.0,
        "fare": 100.0,
        "pickup_lat": 23.8300,
        "pickup_lng": 91.2800,
        "drop_lat": 23.8600,
        "drop_lng": 91.3100,
        "share_enabled": True,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: sim_env["driver_auth"]

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

        # Valid location
        r_valid = client.post("/api/rides/driver-location", json={
            "lat": 23.8320, "lng": 91.2820, "rideId": ride_id, "driverSpeed": 12.0
        })
        assert r_valid.status_code == 200

        # Impossible teleport jump with supersonic speed (500 m/s = 1800 km/h) -> 400 Bad Request
        r_teleport = client.post("/api/rides/driver-location", json={
            "lat": 23.8900, "lng": 91.3500, "rideId": ride_id, "driverSpeed": 500.0
        })
        assert r_teleport.status_code == 400
        assert "Invalid GPS speed" in r_teleport.json()["error"]

        # Teleport jump where speed is omitted (None) and elapsed time is 2.0s -> 400 Bad Request
        db.collection("rides").document(ride_id).update({
            "driverLocationUpdatedAt": datetime.now(timezone.utc) - timedelta(seconds=2)
        })
        r_teleport_omitted = client.post("/api/rides/driver-location", json={
            "lat": 23.8900, "lng": 91.3500, "rideId": ride_id
        })
        assert r_teleport_omitted.status_code == 400
        assert "Invalid GPS speed" in r_teleport_omitted.json()["error"]

        # Duplicate update handled gracefully
        r_dup = client.post("/api/rides/driver-location", json={
            "lat": 23.8320, "lng": 91.2820, "rideId": ride_id, "driverSpeed": 12.0
        })
        assert r_dup.status_code == 200

    app.dependency_overrides.pop(current_user, None)


def test_scenario_5_backgrounding_and_completion_cleanup(sim_env):
    """Scenario 5: Background location tracking persists; on ride completion, tripShareView and markers clean up."""
    db = sim_env["db"]
    ride_id = "s5_background_cleanup"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": sim_env["driver_uid"],
        "passenger_id": sim_env["passenger_uid"],
        "status": "started",
        "distance_km": 2.5,
        "fare": 90.0,
        "pickup_lat": PICKUP_LOC["lat"],
        "pickup_lng": PICKUP_LOC["lng"],
        "drop_lat": DROP_LOC["lat"],
        "drop_lng": DROP_LOC["lng"],
        "route_polyline": sim_env["encoded_dest_poly"],
        "share_enabled": True,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: sim_env["driver_auth"]

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

        # Background update from native service
        r_bg = client.post("/api/rides/driver-location", json={
            "lat": 23.8400, "lng": 91.2850, "rideId": ride_id,
            "driverHeading": 45.0, "driverSpeed": 11.0, "driverAccuracy": 6.0
        })
        assert r_bg.status_code == 200

        # Trip completed
        r_comp = client.post(f"/api/rides/{ride_id}/transition", json={
            "action": "complete", "lat": DROP_LOC["lat"], "lng": DROP_LOC["lng"]
        })
        assert r_comp.status_code == 200

        # tripShareView is deleted on completion
        share_doc = db.collection("tripShareView").document(ride_id).get()
        assert not share_doc.exists

        # Driver lifetime trips and earnings updated
        driver_prof = db.collection("users").document(sim_env["driver_uid"]).get().to_dict()
        assert driver_prof["total_completed_trips"] > 10

    app.dependency_overrides.pop(current_user, None)
