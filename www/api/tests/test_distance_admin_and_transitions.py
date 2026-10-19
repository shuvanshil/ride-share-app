from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from api.index import app
from api.core.admin import require_admin
from api.routers.rides import current_user, _kolkata_day_str


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists
        self.reference = None

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, path: str, store: dict):
        self.path = path
        parts = path.strip("/").split("/")
        self.collection_name = parts[0]
        self.id = parts[-1]
        self._parts = parts
        self._store = store

    def get(self, transaction=None):
        data = self._store.get(self.path)
        snap = MockDocSnapshot(self.id, data, exists=(data is not None))
        snap.reference = self
        return snap

    def set(self, data, merge=False):
        if not merge or self.path not in self._store:
            self._store[self.path] = {}
        for k, v in data.items():
            if hasattr(v, "_increment_val"):
                self._store[self.path][k] = self._store[self.path].get(k, 0) + v._increment_val
            else:
                self._store[self.path][k] = v

    def delete(self):
        if self.path in self._store:
            del self._store[self.path]

    def update(self, data):
        if self.path not in self._store:
            self._store[self.path] = {}
        for k, v in data.items():
            # Handle Increment if mocked
            if hasattr(v, "_increment_val"):
                self._store[self.path][k] = self._store[self.path].get(k, 0) + v._increment_val
            else:
                self._store[self.path][k] = v

    def collection(self, name):
        return MockCollectionReference(f"{self.path}/{name}", self._store)


class MockCollectionReference:
    def __init__(self, path: str, store: dict):
        self.path = path
        self.store = store
        self.filters = []
        self.order_by_field = None
        self.order_dir = None
        self._limit = None

    def document(self, doc_id: str = None):
        if not doc_id:
            import uuid
            doc_id = f"auto_{uuid.uuid4().hex[:8]}"
        return MockDocReference(f"{self.path}/{doc_id}", self.store)

    def where(self, field, op, val):
        q = MockCollectionReference(self.path, self.store)
        q.filters = list(self.filters) + [(field, op, val)]
        q.order_by_field = self.order_by_field
        q.order_dir = self.order_dir
        q._limit = self._limit
        return q

    def order_by(self, field, direction=None):
        q = MockCollectionReference(self.path, self.store)
        q.filters = list(self.filters)
        q.order_by_field = field
        q.order_dir = direction
        q._limit = self._limit
        return q

    def limit(self, count):
        q = MockCollectionReference(self.path, self.store)
        q.filters = list(self.filters)
        q.order_by_field = self.order_by_field
        q.order_dir = self.order_dir
        q._limit = count
        return q

    def stream(self, transaction=None):
        matches = []
        prefix = self.path + "/"
        for p, data in self.store.items():
            if not p.startswith(prefix):
                continue
            # Must be a direct child (same number of slashes)
            remainder = p[len(prefix):]
            if "/" in remainder:
                continue
            doc_id = remainder
            matched = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    matched = False
                    break
            if matched:
                snap = MockDocSnapshot(doc_id, data, exists=True)
                snap.reference = MockDocReference(p, self.store)
                matches.append(snap)
        if self._limit is not None:
            matches = matches[:self._limit]
        return matches

    def get(self, transaction=None):
        return self.stream(transaction=transaction)


class MockTransaction:
    def __init__(self, store):
        self.store = store
        self._read_only = False

    def get(self, ref):
        return ref.get(transaction=self)

    def set(self, ref, data, merge=False):
        ref.set(data, merge=merge)

    def update(self, ref, data):
        ref.update(data)

    def delete(self, ref):
        ref.delete()


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name):
        return MockCollectionReference(name, self.store)

    def transaction(self):
        return MockTransaction(self.store)


class FakeIncrement:
    def __init__(self, val):
        self._increment_val = val


@pytest.fixture
def mock_db():
    db = MockFirestoreClient()
    return db


@pytest.fixture
def test_client():
    return TestClient(app)


def test_admin_get_distance_reviews_empty_and_list(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()):
            # 1. Empty list
            resp = test_client.get("/api/admin/distance-reviews")
            assert resp.status_code == 200
            data = resp.json()
            assert data["items"] == []
            assert data["ok"] is True

            # 2. Add sample reviews
            mock_db.collection("distanceReviews").document("ride_1").set({
                "rideId": "ride_1",
                "driverId": "drv_1",
                "status": "PENDING",
                "disparity_ratio": 1.45,
                "disparity_delta_km": 4.5,
                "driver_reported_km": 14.5,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            mock_db.collection("distanceReviews").document("ride_2").set({
                "rideId": "ride_2",
                "driverId": "drv_2",
                "status": "APPROVED",
                "disparity_ratio": 1.15,
                "disparity_delta_km": 1.5,
                "driver_reported_km": 11.5,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })

            # List all
            resp = test_client.get("/api/admin/distance-reviews")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data["items"]) == 2

            # Filter pending
            resp = test_client.get("/api/admin/distance-reviews?status=PENDING")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data["items"]) == 1
            assert data["items"][0]["rideId"] == "ride_1"

            # Filter driver_id
            resp = test_client.get("/api/admin/distance-reviews?driver_id=drv_2")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data["items"]) == 1
            assert data["items"][0]["rideId"] == "ride_2"
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_get_distance_review_by_id(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()):
            # 404
            resp = test_client.get("/api/admin/distance-reviews/nonexistent_ride")
            assert resp.status_code == 404

            # Exists
            mock_db.collection("distanceReviews").document("ride_detail").set({
                "rideId": "ride_detail",
                "driverId": "drv_1",
                "status": "PENDING",
                "suggested_km": 8.0,
                "driver_reported_km": 12.0,
            })
            resp = test_client.get("/api/admin/distance-reviews/ride_detail")
            assert resp.status_code == 200
            assert resp.json()["review"]["rideId"] == "ride_detail"
            assert resp.json()["review"]["suggested_km"] == 8.0
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_distance_review_decision_validations(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    mock_db.collection("distanceReviews").document("ride_val").set({
        "rideId": "ride_val",
        "driverId": "drv_val",
        "dayKey": _kolkata_day_str(),
        "status": "PENDING",
        "planned_km": 10.0,
        "provisional_km": 10.0,
    })
    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.admin.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):
            # Missing / empty note
            resp = test_client.post("/api/admin/distance-reviews/ride_val/decision", json={
                "decision": "approve",
                "note": "",
            })
            assert resp.status_code == 422

            # Invalid decision
            resp = test_client.post("/api/admin/distance-reviews/ride_val/decision", json={
                "decision": "maybe",
                "note": "valid note",
            })
            assert resp.status_code == 422

            # Negative approved_km
            resp = test_client.post("/api/admin/distance-reviews/ride_val/decision", json={
                "decision": "approve",
                "approved_km": -5.0,
                "note": "negative distance not allowed",
            })
            assert resp.status_code == 422

            # Approved km > max_allowed (P=10 -> max 30 km)
            resp = test_client.post("/api/admin/distance-reviews/ride_val/decision", json={
                "decision": "approve",
                "approved_km": 35.0,
                "note": "exceeds allowed limit",
            })
            assert resp.status_code == 422
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_distance_review_decision_approve_flow(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    ride_id = "ride_appr_1"
    driver_id = "drv_appr_1"
    day_str = _kolkata_day_str()

    mock_db.collection("distanceReviews").document(ride_id).set({
        "rideId": ride_id,
        "driverId": driver_id,
        "dayKey": day_str,
        "status": "PENDING",
        "planned_km": 10.0,
        "provisional_km": 10.0,
        "suggested_km": 10.0,
        "driver_reported_km": 15.0,
    })
    mock_db.collection("driverDailyStats").document(f"{driver_id}_{day_str}").set({
        "driver_id": driver_id,
        "date": day_str,
        "distance_km": 5.0,
        "under_review_km": 15.0,
        "under_review_count": 1,
    })
    mock_db.collection("users").document(driver_id).set({
        "role": "driver",
        "lifetime_distance_km": 50.0,
    })

    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.admin.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            # Approve with explicit approved_km = 9.5
            resp = test_client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={
                "decision": "approve",
                "approved_km": 9.5,
                "note": "Adjusted to 9.5 km after GPS verification",
            })
            assert resp.status_code == 200
            res = resp.json()
            assert res["status"] == "APPROVED"
            assert res["decided_km"] == 9.5

            # Verify review doc in DB
            rev_doc = mock_db.collection("distanceReviews").document(ride_id).get().to_dict()
            assert rev_doc["status"] == "APPROVED"
            assert rev_doc["decided_km"] == 9.5
            assert "admin_test" in rev_doc["decided_by"]

            # Verify daily stats: distance_km should have increased by 9.5 (5.0 + 9.5 = 14.5)
            # and under_review_km should have decremented by provisional_km (10.0), count by 1
            daily = mock_db.collection("driverDailyStats").document(f"{driver_id}_{day_str}").get().to_dict()
            assert daily["distance_km"] == 14.5
            assert daily["under_review_km"] == 5.0
            assert daily["under_review_count"] == 0

            # Verify lifetime distance on users
            user = mock_db.collection("users").document(driver_id).get().to_dict()
            assert user["lifetime_distance_km"] == 59.5

            # Idempotent re-submission with same payload should succeed with 200
            resp2 = test_client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={
                "decision": "approve",
                "approved_km": 9.5,
                "note": "Adjusted to 9.5 km after GPS verification",
            })
            assert resp2.status_code == 200
            assert resp2.json()["message"] == "Decision already applied."

            # Conflicting re-submission with different payload should return 409
            resp3 = test_client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={
                "decision": "decline",
                "note": "Wait changing mind",
            })
            assert resp3.status_code == 409
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_distance_review_decision_decline_flow(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    ride_id = "ride_dec_1"
    driver_id = "drv_dec_1"
    day_str = _kolkata_day_str()

    mock_db.collection("distanceReviews").document(ride_id).set({
        "rideId": ride_id,
        "driverId": driver_id,
        "dayKey": day_str,
        "status": "PENDING",
        "planned_km": 10.0,
        "provisional_km": 10.0,
        "suggested_km": 10.0,
        "driver_reported_km": 15.0,
    })
    mock_db.collection("driverDailyStats").document(f"{driver_id}_{day_str}").set({
        "driver_id": driver_id,
        "date": day_str,
        "distance_km": 20.0,
        "under_review_km": 10.0,
        "under_review_count": 1,
    })
    mock_db.collection("users").document(driver_id).set({
        "role": "driver",
        "lifetime_distance_km": 100.0,
    })

    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.admin.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            resp = test_client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={
                "decision": "decline",
                "note": "Spoofed location rejected",
            })
            assert resp.status_code == 200
            res = resp.json()
            assert res["status"] == "DECLINED"
            assert res["decided_km"] == 0.0

            daily = mock_db.collection("driverDailyStats").document(f"{driver_id}_{day_str}").get().to_dict()
            # distance_km should remain unchanged at 20.0
            assert daily["distance_km"] == 20.0
            # under_review should be cleared
            assert daily["under_review_km"] == 0.0
            assert daily["under_review_count"] == 0

            # lifetime should remain 100.0
            user = mock_db.collection("users").document(driver_id).get().to_dict()
            assert user["lifetime_distance_km"] == 100.0
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_distance_review_after_day_close_adjustment(test_client, mock_db):
    app.dependency_overrides[require_admin] = lambda: {"uid": "admin_test", "role": "admin"}
    ride_id = "ride_past_1"
    driver_id = "drv_past_1"
    yesterday_str = "2026-01-01"

    mock_db.collection("distanceReviews").document(ride_id).set({
        "rideId": ride_id,
        "driverId": driver_id,
        "dayKey": yesterday_str,
        "status": "PENDING",
        "planned_km": 12.0,
        "provisional_km": 12.0,
        "suggested_km": 12.0,
        "driver_reported_km": 12.0,
    })
    mock_db.collection("driverDailyStats").document(f"{driver_id}_{yesterday_str}").set({
        "driver_id": driver_id,
        "date": yesterday_str,
        "distance_km": 30.0,
        "under_review_km": 12.0,
        "under_review_count": 1,
    })
    mock_db.collection("users").document(driver_id).set({
        "role": "driver",
        "lifetime_distance_km": 200.0,
    })

    try:
        with patch("api.routers.admin.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.admin.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.admin.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.admin.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            resp = test_client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={
                "decision": "approve",
                "approved_km": 12.0,
                "note": "Past day resolved",
            })
            assert resp.status_code == 200

            # Check adjustment record was written
            adj_docs = [p for p in mock_db.store.keys() if f"driverDailyStats/{driver_id}_{yesterday_str}/adjustments" in p]
            assert len(adj_docs) == 1
            adj_data = mock_db.store[adj_docs[0]]
            assert adj_data["after_day_close"] is True
            assert adj_data["decided_km"] == 12.0
            assert adj_data["rideId"] == ride_id
    finally:
        app.dependency_overrides.pop(require_admin, None)


def test_admin_distance_review_non_admin_forbidden(test_client, mock_db):
    # Without require_admin override or non-admin user
    resp = test_client.get("/api/admin/distance-reviews")
    assert resp.status_code in (401, 403)

    resp = test_client.post("/api/admin/distance-reviews/some_ride/decision", json={
        "decision": "approve",
        "note": "attempt",
    })
    assert resp.status_code in (401, 403)


def test_passenger_cancel_before_pickup_no_counters(test_client, mock_db):
    pax_uid = "pax_test_1"
    driver_uid = "drv_test_1"
    ride_id = "ride_cancel_pre"
    day_str = _kolkata_day_str()

    mock_db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "passenger_id": pax_uid,
        "driver_id": driver_uid,
        "status": "accepted",
        "distance_km": 8.0,
        "fare": 120.0,
    })
    mock_db.collection("users").document(pax_uid).set({"role": "passenger"})
    mock_db.collection("users").document(driver_uid).set({"role": "driver", "lifetime_distance_km": 0.0})

    app.dependency_overrides[current_user] = lambda: {"uid": pax_uid, "role": "passenger"}
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.rides.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            resp = test_client.post(f"/api/rides/{ride_id}/cancel")
            assert resp.status_code == 200
            assert resp.json()["status"] == "cancelled_by_passenger"

            # Check ride document in DB
            ride_data = mock_db.store.get(f"rides/{ride_id}") or {}
            assert ride_data["status"] == "cancelled_by_passenger"
            assert ride_data["distance_status"] == "zero"
            assert ride_data["counted_distance_km"] == 0.0

            # Daily stats doc should not have distance increment
            daily_data = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}")
            assert daily_data is None or daily_data.get("distance_km", 0.0) == 0.0

            # Driver lifetime distance should be unchanged
            drv_user = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user.get("lifetime_distance_km", 0.0) == 0.0
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_passenger_cancel_after_pickup_travel_counted_and_idempotent(test_client, mock_db):
    pax_uid = "pax_test_2"
    driver_uid = "drv_test_2"
    ride_id = "ride_cancel_post"
    day_str = _kolkata_day_str()

    now_dt = datetime.now(timezone.utc)
    mock_db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "passenger_id": pax_uid,
        "driver_id": driver_uid,
        "status": "started",
        "pinVerifiedAt": (now_dt - timedelta(minutes=10)).isoformat(),
        "startedAt": (now_dt - timedelta(minutes=10)).isoformat(),
        "lastLocationAt": (now_dt - timedelta(seconds=15)).isoformat(),
        "distance_km": 10.0,
        "fare": 150.0,
        "breadcrumb_count": 10,
        "coverage": 0.9,
        "max_gap_s": 20.0,
    })
    mock_db.collection("users").document(pax_uid).set({"role": "passenger"})
    mock_db.collection("users").document(driver_uid).set({"role": "driver", "lifetime_distance_km": 20.0})

    fake_fare_adj = {
        "final_fare": 60.0,
        "original_fare": 150.0,
        "planned_distance_km": 10.0,
        "travelled_after_pickup_km": 3.5,
        "charged_distance_km": 3.5,
        "distance_to_drop_km": 6.5,
        "extra_dropoff_distance_km": 0.0,
        "progress_ratio": 0.35,
        "reason": "partial_trip",
        "message": "Cancelled after pickup",
    }

    app.dependency_overrides[current_user] = lambda: {"uid": pax_uid, "role": "passenger"}
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.rides.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.rides._driver_fare_adjustment", return_value=fake_fare_adj), \
             patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            # 1. First cancel call
            resp = test_client.post(f"/api/rides/{ride_id}/cancel")
            assert resp.status_code == 200
            assert resp.json()["status"] == "cancelled_by_passenger"

            # Verify counted distance applied
            ride_data = mock_db.store.get(f"rides/{ride_id}") or {}
            assert ride_data["distance_status"] == "counted"
            assert ride_data["counted_distance_km"] == 3.5

            daily_data = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}") or {}
            assert daily_data.get("distance_km") == 3.5

            drv_user = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user.get("lifetime_distance_km") == 23.5

            hist_data = mock_db.store.get(f"tripHistory/{ride_id}") or {}
            assert hist_data.get("distance_status") == "counted"
            assert hist_data.get("counted_distance_km") == 3.5

            # 2. Duplicate / retry cancel call -> must NOT double count
            resp2 = test_client.post(f"/api/rides/{ride_id}/cancel")
            assert resp2.status_code == 200

            daily_data2 = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}") or {}
            assert daily_data2.get("distance_km") == 3.5  # STILL 3.5, NOT 7.0!

            drv_user2 = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user2.get("lifetime_distance_km") == 23.5  # STILL 23.5!
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_driver_complete_duplicate_retry_no_double_increment(test_client, mock_db):
    driver_uid = "drv_test_comp"
    ride_id = "ride_complete_dup"
    day_str = _kolkata_day_str()

    mock_db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": driver_uid,
        "passenger_id": "pax_test_comp",
        "status": "en_route",
        "pinVerifiedAt": datetime.now(timezone.utc).isoformat(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "distance_km": 10.0,
        "fare": 150.0,
        "breadcrumb_count": 25,
        "coverage": 0.95,
        "max_gap_s": 15.0,
        "lastLocationAt": datetime.now(timezone.utc).isoformat(),
    })
    mock_db.collection("users").document(driver_uid).set({
        "role": "driver",
        "verificationStatus": "approved",
        "lifetime_distance_km": 50.0,
        "total_completed_trips": 5,
        "lifetime_earnings": 500.0,
    })

    fake_fare_adj = {
        "final_fare": 150.0,
        "original_fare": 150.0,
        "planned_distance_km": 10.0,
        "travelled_after_pickup_km": 9.8,
        "charged_distance_km": 10.0,
        "distance_to_drop_km": 0.05,
        "extra_dropoff_distance_km": 0.0,
        "progress_ratio": 0.98,
        "reason": "full_trip",
        "message": "Ride completed successfully",
    }

    app.dependency_overrides[current_user] = lambda: {"uid": driver_uid, "role": "driver"}
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.rides.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.rides._driver_fare_adjustment", return_value=fake_fare_adj), \
             patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            # 1. Complete ride
            resp = test_client.post(f"/api/rides/{ride_id}/transition", json={"action": "complete"})
            assert resp.status_code == 200

            # Counters incremented once
            daily_data = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}") or {}
            assert daily_data.get("distance_km") == 10.0

            drv_user = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user.get("lifetime_distance_km") == 60.0

            # 2. Duplicate completion call -> must be idempotent
            resp2 = test_client.post(f"/api/rides/{ride_id}/transition", json={"action": "complete"})
            assert resp2.status_code == 200

            daily_data2 = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}") or {}
            assert daily_data2.get("distance_km") == 10.0  # Unchanged!

            drv_user2 = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user2.get("lifetime_distance_km") == 60.0  # Unchanged!
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_driver_complete_zero_travel_does_not_increment(test_client, mock_db):
    driver_uid = "drv_test_zero"
    ride_id = "ride_complete_zero"
    day_str = _kolkata_day_str()

    mock_db.collection("rides").document(ride_id).set({
        "id": ride_id,
        "driver_id": driver_uid,
        "passenger_id": "pax_test_zero",
        "status": "en_route",
        "pinVerifiedAt": datetime.now(timezone.utc).isoformat(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "distance_km": 10.0,
        "fare": 150.0,
        "breadcrumb_count": 25,
        "coverage": 0.95,
        "max_gap_s": 15.0,
        "lastLocationAt": datetime.now(timezone.utc).isoformat(),
    })
    mock_db.collection("users").document(driver_uid).set({
        "role": "driver",
        "verificationStatus": "approved",
        "lifetime_distance_km": 50.0,
        "total_completed_trips": 5,
        "lifetime_earnings": 500.0,
    })

    fake_fare_adj = {
        "final_fare": 0.0,
        "original_fare": 150.0,
        "planned_distance_km": 10.0,
        "travelled_after_pickup_km": 0.02, # <= 0.05 km
        "charged_distance_km": 0.0,
        "distance_to_drop_km": 9.9,
        "extra_dropoff_distance_km": 0.0,
        "progress_ratio": 0.002,
        "reason": "zero_passenger_travel",
        "message": "Vehicle did not travel",
    }

    app.dependency_overrides[current_user] = lambda: {"uid": driver_uid, "role": "driver"}
    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.rides.fb_firestore.Increment", side_effect=FakeIncrement), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()), \
             patch("api.routers.rides._driver_fare_adjustment", return_value=fake_fare_adj), \
             patch("api.routers.rides.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):

            resp = test_client.post(f"/api/rides/{ride_id}/transition", json={"action": "complete"})
            assert resp.status_code == 200

            ride_data = mock_db.store.get(f"rides/{ride_id}") or {}
            assert ride_data.get("distance_status") == "zero"
            assert ride_data.get("counted_distance_km") == 0.0

            daily_data = mock_db.store.get(f"driverDailyStats/{driver_uid}_{day_str}")
            assert daily_data is None or daily_data.get("distance_km", 0.0) == 0.0

            drv_user = mock_db.store.get(f"users/{driver_uid}") or {}
            assert drv_user.get("lifetime_distance_km") == 50.0
    finally:
        app.dependency_overrides.pop(current_user, None)


