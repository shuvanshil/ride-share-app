"""Comprehensive Backend Test Suite for Vehicle Tracking, Map Synchronisation & Destination Handling Audit."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.index import app
from api.routers.rides import current_user
from api.core.distance_reconciliation import (
    STATUS_AUTO_ACCEPTED,
    STATUS_AUTO_RESOLVED,
    reconcile_ride_distance,
)
from api.core.fare_policy import (
    FREE_DROPOFF_EXTRA_KM,
    FULL_FARE_PROGRESS_RATIO,
    ZERO_TRAVEL_THRESHOLD_KM,
    calculate_fare,
    get_service_fare_policy,
)
from api.core.geo import decode_polyline, encode_polyline, haversine_km, road_distance_along_route_km
from api.routers.rides import _driver_fare_adjustment


class FakeDocSnapshot:
    def __init__(self, doc_id: str, data: dict | None):
        self.id = doc_id
        self._data = dict(data) if data is not None else None
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class FakeDocRef:
    def __init__(self, collection_store: dict, doc_id: str):
        self._store = collection_store
        self.id = doc_id

    def get(self, transaction=None):
        return FakeDocSnapshot(self.id, self._store.get(self.id))

    def set(self, data: dict, merge: bool = False):
        resolved = self._resolve_transforms(self._store.get(self.id) or {}, data)
        if merge and self.id in self._store:
            merged = dict(self._store[self.id])
            merged.update(resolved)
            self._store[self.id] = merged
        else:
            self._store[self.id] = dict(resolved)

    def update(self, data: dict):
        cur = dict(self._store.get(self.id) or {})
        resolved = self._resolve_transforms(cur, data)
        cur.update(resolved)
        self._store[self.id] = cur

    def delete(self):
        self._store.pop(self.id, None)

    @staticmethod
    def _resolve_transforms(existing: dict, updates: dict) -> dict:
        out = {}
        for k, v in updates.items():
            cls_name = type(v).__name__
            if cls_name == "Increment":
                inc_val = getattr(v, "value", getattr(v, "_value", 0))
                out[k] = float(existing.get(k) or 0) + float(inc_val)
            elif " Sentinel" in str(v) or cls_name == "Sentinel" or "SERVER_TIMESTAMP" in str(v):
                out[k] = datetime.now(timezone.utc)
            else:
                out[k] = v
        return out


class FakeBatch:
    def __init__(self):
        self._ops = []

    def set(self, ref: FakeDocRef, data: dict, merge: bool = False):
        self._ops.append(("set", ref, data, merge))

    def update(self, ref: FakeDocRef, data: dict):
        self._ops.append(("update", ref, data, False))

    def delete(self, ref: FakeDocRef):
        self._ops.append(("delete", ref, None, False))

    def commit(self):
        for op, ref, data, merge in self._ops:
            if op == "set":
                ref.set(data, merge=merge)
            elif op == "update":
                ref.update(data)
            elif op == "delete":
                ref.delete()


class FakeTransaction:
    def get(self, ref: FakeDocRef):
        return ref.get()

    def set(self, ref: FakeDocRef, data: dict, merge: bool = False):
        ref.set(data, merge=merge)

    def update(self, ref: FakeDocRef, data: dict):
        ref.update(data)

    def delete(self, ref: FakeDocRef):
        ref.delete()


class FakeQuery:
    def __init__(self, store: dict):
        self._store = store

    def where(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def stream(self):
        return [FakeDocSnapshot(k, v) for k, v in list(self._store.items())]


class FakeCollection:
    def __init__(self, store: dict):
        self._store = store

    def document(self, doc_id: str | None = None):
        if not doc_id:
            doc_id = f"doc_{len(self._store) + 1}"
        return FakeDocRef(self._store, doc_id)

    def where(self, *args, **kwargs):
        return FakeQuery(self._store)

    def stream(self):
        return [FakeDocSnapshot(k, v) for k, v in list(self._store.items())]


class FakeFirestoreDB:
    def __init__(self):
        self.collections: dict[str, dict] = {}

    def collection(self, name: str):
        if name not in self.collections:
            self.collections[name] = {}
        return FakeCollection(self.collections[name])

    def batch(self):
        return FakeBatch()

    def transaction(self):
        return FakeTransaction()


PICKUP = {"lat": 23.8315, "lng": 91.2868}
DROP = {"lat": 23.8515, "lng": 91.2968}


def build_route_points(start: dict, end: dict, steps: int = 10) -> list[tuple[float, float]]:
    return [
        (
            round(start["lat"] + (end["lat"] - start["lat"]) * (i / steps), 6),
            round(start["lng"] + (end["lng"] - start["lng"]) * (i / steps), 6),
        )
        for i in range(steps + 1)
    ]


@pytest.fixture
def audit_env():
    db = FakeFirestoreDB()
    driver_uid = "drv_audit_1"
    passenger_uid = "pas_audit_1"
    db.collection("users").document(driver_uid).set({
        "uid": driver_uid,
        "role": "driver",
        "verificationStatus": "approved",
        "name": "Audit Driver",
        "vehicle_type": "auto",
        "vehicle_model": "Bajaj RE",
        "vehicle_number": "TR01AB1234",
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "lifetime_distance_km": 10.0,
        "lifetime_earnings": 500.0,
        "total_completed_trips": 5,
    })
    db.collection("users").document(passenger_uid).set({
        "uid": passenger_uid,
        "role": "passenger",
        "name": "Audit Passenger",
        "gender": "male",
    })
    pts = build_route_points(PICKUP, DROP, steps=10)
    poly = encode_polyline(pts)
    planned_km = sum(
        haversine_km(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        for i in range(len(pts) - 1)
    )
    return {
        "db": db,
        "driver_uid": driver_uid,
        "passenger_uid": passenger_uid,
        "driver_auth": {"uid": driver_uid, "role": "driver"},
        "pts": pts,
        "poly": poly,
        "planned_km": round(planned_km, 2),
    }


def test_unit_geo_and_road_distance_along_curved_route():
    """Unit test: Polyline encoding/decoding and cumulative road distance on a multi-segment curved route."""
    curved = [
        (23.8300, 91.2800),
        (23.8350, 91.2800),
        (23.8380, 91.2840),
        (23.8420, 91.2890),
        (23.8460, 91.2950),
    ]
    encoded = encode_polyline(curved)
    decoded = decode_polyline(encoded)
    assert len(decoded) == len(curved)
    for (lat1, lng1), (lat2, lng2) in zip(curved, decoded):
        assert abs(lat1 - lat2) < 1e-4
        assert abs(lng1 - lng2) < 1e-4

    # At start of route -> ~0 km
    d_start = road_distance_along_route_km(decoded, {"lat": 23.8300, "lng": 91.2800})
    assert d_start is not None and d_start < 0.01

    # At end of route -> equals total polyline length (> straight-line distance)
    d_end = road_distance_along_route_km(decoded, {"lat": 23.8460, "lng": 91.2950})
    straight = haversine_km(23.8300, 91.2800, 23.8460, 91.2950)
    assert d_end is not None
    assert d_end > straight


def test_out_of_order_client_timestamp_rejected_on_backend(audit_env):
    """Part A: Out-of-order / delayed location updates with older clientTimestampMs are skipped without moving marker backward."""
    db = audit_env["db"]
    ride_id = "ride_out_of_order"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": audit_env["driver_uid"],
        "passenger_id": audit_env["passenger_uid"],
        "status": "en_route",
        "pickup_lat": PICKUP["lat"],
        "pickup_lng": PICKUP["lng"],
        "drop_lat": DROP["lat"],
        "drop_lng": DROP["lng"],
        "distance_km": audit_env["planned_km"],
        "fare": 60.0,
        "route_polyline": audit_env["poly"],
        "pinVerifiedAt": datetime.now(timezone.utc) - timedelta(minutes=3),
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: audit_env["driver_auth"]
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=db), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()):
            pt_newer = audit_env["pts"][5]
            pt_older = audit_env["pts"][2]

            # 1. Newer update arrives first (clientTimestampMs = 2000)
            r1 = client.post("/api/rides/driver-location", json={
                "lat": pt_newer[0],
                "lng": pt_newer[1],
                "rideId": ride_id,
                "driverHeading": 28.0,
                "driverSpeed": 9.0,
                "driverAccuracy": 5.0,
                "clientTimestampMs": 1700000002000,
            })
            assert r1.status_code == 200
            assert not r1.json().get("staleSkipped")

            # 2. Delayed older update arrives second (clientTimestampMs = 1000)
            r2 = client.post("/api/rides/driver-location", json={
                "lat": pt_older[0],
                "lng": pt_older[1],
                "rideId": ride_id,
                "driverHeading": 195.0,
                "driverSpeed": 4.0,
                "driverAccuracy": 8.0,
                "clientTimestampMs": 1700000001000,
            })
            assert r2.status_code == 200
            assert r2.json().get("staleSkipped") is True

            # Verify ride document retained the newer coordinates and heading
            ride_doc = db.collection("rides").document(ride_id).get().to_dict()
            assert ride_doc["driverLocation"]["lat"] == pt_newer[0]
            assert ride_doc["driverLocation"]["lng"] == pt_newer[1]
            assert ride_doc["driverHeading"] == 28.0
            assert ride_doc["lastClientTimestampMs"] == 1700000002000
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_coordinate_teleport_rejected_even_when_driver_speed_provided(audit_env):
    """Part A/D: Coordinate jump > 55 m/s over elapsed time is rejected even if body.driverSpeed looks normal."""
    db = audit_env["db"]
    ride_id = "ride_teleport_guard"
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": audit_env["driver_uid"],
        "passenger_id": audit_env["passenger_uid"],
        "status": "en_route",
        "pickup_lat": PICKUP["lat"],
        "pickup_lng": PICKUP["lng"],
        "drop_lat": DROP["lat"],
        "drop_lng": DROP["lng"],
        "distance_km": audit_env["planned_km"],
        "fare": 60.0,
        "driverLocation": {"lat": PICKUP["lat"], "lng": PICKUP["lng"]},
        "driverLocationUpdatedAt": datetime.now(timezone.utc) - timedelta(seconds=2),
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: audit_env["driver_auth"]
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=db), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()):
            # Jump ~5km in 2 seconds while claiming driverSpeed = 8.0 m/s
            resp = client.post("/api/rides/driver-location", json={
                "lat": PICKUP["lat"] + 0.045,
                "lng": PICKUP["lng"] + 0.045,
                "rideId": ride_id,
                "driverSpeed": 8.0,
                "driverAccuracy": 10.0,
            })
            assert resp.status_code == 400
            assert "Invalid GPS speed" in resp.json()["error"]
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_noisy_gps_spike_does_not_falsely_latch_destination_passed(audit_env):
    """Part D: A single noisy GPS spike (low accuracy or sudden step jump) past destination does not latch destinationPassed."""
    db = audit_env["db"]
    ride_id = "ride_noisy_dest_spike"
    mid_pt = audit_env["pts"][5]
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": audit_env["driver_uid"],
        "passenger_id": audit_env["passenger_uid"],
        "status": "en_route",
        "pickup_lat": PICKUP["lat"],
        "pickup_lng": PICKUP["lng"],
        "drop_lat": DROP["lat"],
        "drop_lng": DROP["lng"],
        "distance_km": audit_env["planned_km"],
        "fare": 60.0,
        "route_polyline": audit_env["poly"],
        "driverLocation": {"lat": mid_pt[0], "lng": mid_pt[1]},
        "max_travelled_km": round(audit_env["planned_km"] * 0.5, 3),
        "max_progress_ratio": 0.5,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: audit_env["driver_auth"]
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=db), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()):
            # Noisy cell-tower spike 300m past destination with poor accuracy (180m) while only 50% along route
            resp = client.post("/api/rides/driver-location", json={
                "lat": DROP["lat"] + 0.0025,
                "lng": DROP["lng"] + 0.0012,
                "rideId": ride_id,
                "driverSpeed": 10.0,
                "driverAccuracy": 180.0,
            })
            assert resp.status_code == 200
            ride_doc = db.collection("rides").document(ride_id).get().to_dict()
            assert not ride_doc.get("destinationPassed")
            assert ride_doc.get("extra_dropoff_distance_km") is None
            assert ride_doc["status"] == "en_route"
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_e2e_passing_destination_continued_tracking_and_completion_fare(audit_env):
    """Part D & E: Full E2E flow from accept -> arrive -> verify_pin -> reaching destination -> passing destination -> complete -> fare & post-completion guard."""
    db = audit_env["db"]
    ride_id = "ride_e2e_overshoot"
    service_policy = get_service_fare_policy("auto")
    quoted_fare = float(calculate_fare(service_policy, audit_env["planned_km"]))
    db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": audit_env["driver_uid"],
        "passenger_id": audit_env["passenger_uid"],
        "status": "accepted",
        "pickup_lat": PICKUP["lat"],
        "pickup_lng": PICKUP["lng"],
        "drop_lat": DROP["lat"],
        "drop_lng": DROP["lng"],
        "distance_km": audit_env["planned_km"],
        "duration_minutes": 8,
        "fare": quoted_fare,
        "quoted_fare": quoted_fare,
        "fare_original": quoted_fare,
        "fare_base": service_policy["base"],
        "fare_per_km": service_policy["per_km"],
        "fare_min": service_policy["min_fare"],
        "fare_is_night": service_policy["is_night_fare"],
        "vehicle_type": "auto",
        "verification_pin": "4321",
        "route_polyline": audit_env["poly"],
        "share_enabled": True,
        "createdAt": datetime.now(timezone.utc) - timedelta(minutes=10),
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: audit_env["driver_auth"]
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=db), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            # 1. Arrive at pickup
            r_arr = client.post(f"/api/rides/{ride_id}/transition", json={
                "action": "arrive", "lat": PICKUP["lat"], "lng": PICKUP["lng"]
            })
            assert r_arr.status_code == 200

            # 2. Verify PIN -> en_route
            r_pin = client.post(f"/api/rides/{ride_id}/transition", json={
                "action": "verify_pin", "pin": "4321", "lat": PICKUP["lat"], "lng": PICKUP["lng"]
            })
            assert r_pin.status_code == 200
            # Backdate pinVerifiedAt by 7 minutes so trip duration D (~7 min) matches planned duration PD (8 min)
            db.collection("rides").document(ride_id).update({
                "pinVerifiedAt": datetime.now(timezone.utc) - timedelta(minutes=7),
                "startedAt": datetime.now(timezone.utc) - timedelta(minutes=7),
            })

            # 3. Drive along route to destination (10 steps)
            base_ts = 1700000100000
            for idx, pt in enumerate(audit_env["pts"]):
                r_loc = client.post("/api/rides/driver-location", json={
                    "lat": pt[0],
                    "lng": pt[1],
                    "rideId": ride_id,
                    "driverHeading": 25.0,
                    "driverSpeed": 8.5,
                    "driverAccuracy": 6.0,
                    "clientTimestampMs": base_ts + idx * 3000,
                })
                assert r_loc.status_code == 200

            ride_at_dest = db.collection("rides").document(ride_id).get().to_dict()
            assert ride_at_dest["status"] == "en_route"  # Never prematurely completed
            assert abs(ride_at_dest["max_travelled_km"] - audit_env["planned_km"]) < 0.05
            assert ride_at_dest["breadcrumb_count"] == len(audit_env["pts"])

            # 4. Continue driving 450m PAST destination in 3 steps (~150m each)
            d_lat_step = (DROP["lat"] - PICKUP["lat"]) / 15.0
            d_lng_step = (DROP["lng"] - PICKUP["lng"]) / 15.0
            for step in range(1, 4):
                over_lat = round(DROP["lat"] + d_lat_step * step, 6)
                over_lng = round(DROP["lng"] + d_lng_step * step, 6)
                r_over = client.post("/api/rides/driver-location", json={
                    "lat": over_lat,
                    "lng": over_lng,
                    "rideId": ride_id,
                    "driverHeading": 25.0,
                    "driverSpeed": 8.0,
                    "driverAccuracy": 5.0,
                    "clientTimestampMs": base_ts + (len(audit_env["pts"]) + step) * 3000,
                })
                assert r_over.status_code == 200

            ride_past_dest = db.collection("rides").document(ride_id).get().to_dict()
            assert ride_past_dest["status"] == "en_route"  # Still active while moving past destination
            assert ride_past_dest["destinationPassed"] is True
            assert ride_past_dest["extra_dropoff_distance_km"] > FREE_DROPOFF_EXTRA_KM
            assert ride_past_dest["max_travelled_km"] > audit_env["planned_km"] + 0.35

            # 5. Complete trip past destination
            r_comp = client.post(f"/api/rides/{ride_id}/transition", json={
                "action": "complete"
            })
            assert r_comp.status_code == 200
            comp_data = r_comp.json()
            assert comp_data["status"] == "completed"

            final_ride = db.collection("rides").document(ride_id).get().to_dict()
            fare_adj = final_ride["fare_adjustment"]
            assert fare_adj["reason"] == "extra_after_drop"
            assert fare_adj["extra_dropoff_distance_km"] > FREE_DROPOFF_EXTRA_KM
            assert fare_adj["charged_distance_km"] > audit_env["planned_km"]
            assert fare_adj["final_fare"] > quoted_fare

            # 6. Duplicate completion request is idempotent (does not double-increment earnings or trips)
            earnings_after_first = db.collection("users").document(audit_env["driver_uid"]).get().to_dict()["lifetime_earnings"]
            trips_after_first = db.collection("users").document(audit_env["driver_uid"]).get().to_dict()["total_completed_trips"]
            r_comp_dup = client.post(f"/api/rides/{ride_id}/transition", json={"action": "complete"})
            assert r_comp_dup.status_code == 200
            assert db.collection("users").document(audit_env["driver_uid"]).get().to_dict()["lifetime_earnings"] == earnings_after_first
            assert db.collection("users").document(audit_env["driver_uid"]).get().to_dict()["total_completed_trips"] == trips_after_first

            # 7. Late location update after completion is rejected with 409
            r_late = client.post("/api/rides/driver-location", json={
                "lat": DROP["lat"] + 0.01,
                "lng": DROP["lng"] + 0.01,
                "rideId": ride_id,
                "driverHeading": 25.0,
            })
            assert r_late.status_code == 409
    finally:
        app.dependency_overrides.pop(current_user, None)
