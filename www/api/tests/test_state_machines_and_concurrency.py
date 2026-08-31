from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from api.core.errors import ApiError
from api.routers import rides


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None))

    def set(self, data, merge=False):
        key = (self.collection_name, self.id)
        if merge and key in self._store:
            self._store[key].update(data)
        else:
            self._store[key] = dict(data)

    def update(self, data):
        key = (self.collection_name, self.id)
        if key not in self._store:
            self._store[key] = {}
        self._store[key].update(data)

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

    def get(self, transaction=None):
        return self.stream()

    def stream(self, transaction=None):
        matches = []
        for (col, doc_id), data in self.store.items():
            if col != self.collection_name:
                continue
            matched = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    matched = False
                    break
                elif op == "in" and doc_val not in val:
                    matched = False
                    break
            if matched:
                matches.append(MockDocSnapshot(doc_id, data, exists=True))
        return matches


class MockCollection:
    def __init__(self, collection_name: str, store: dict):
        self.collection_name = collection_name
        self.store = store

    def document(self, doc_id: str = None):
        if not doc_id:
            import uuid
            doc_id = f"auto_{uuid.uuid4().hex[:12]}"
        return MockDocReference(self.collection_name, doc_id, self.store)

    def where(self, field, op, val):
        return MockQuery(self.collection_name, self.store, [(field, op, val)])

    def stream(self):
        return MockQuery(self.collection_name, self.store).stream()

    def get(self, transaction=None):
        return self.stream()


class MockTransaction:
    def __init__(self, store: dict):
        self.store = store

    def update(self, doc_ref, data):
        doc_ref.update(data)

    def set(self, doc_ref, data, merge=False):
        doc_ref.set(data, merge=merge)

    def delete(self, doc_ref):
        doc_ref.delete()


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def transaction(self):
        return MockTransaction(self.store)


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_concurrency_race_two_drivers_accept_same_ride(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("users").document("drv_1").set({
        "role": "driver",
        "verificationStatus": "approved",
        "vehicle_type": "auto",
        "name": "Driver 1",
    })
    db.collection("users").document("drv_2").set({
        "role": "driver",
        "verificationStatus": "approved",
        "vehicle_type": "auto",
        "name": "Driver 2",
    })

    db.collection("rides").document("ride_100").set({
        "status": "pending",
        "passenger_id": "pass_1",
        "vehicle_type": "auto",
        "eligible_driver_ids": ["drv_1", "drv_2"],
        "rejected_driver_ids": [],
        "driver_id": None,
        "createdAt": datetime.now(timezone.utc),
    })

    user_drv1 = {"uid": "drv_1", "role": "driver"}
    res1 = rides.accept_driver_ride(ride_id="ride_100", user=user_drv1)
    assert res1["ok"] is True
    assert res1["ride"]["status"] == "accepted"
    assert res1["ride"]["driver_id"] == "drv_1"

    # Confirm ride document was updated in database
    saved_ride = db.collection("rides").document("ride_100").get().to_dict()
    assert saved_ride["status"] == "accepted"
    assert saved_ride["driver_id"] == "drv_1"

    user_drv2 = {"uid": "drv_2", "role": "driver"}
    with pytest.raises(ApiError) as exc_info:
        rides.accept_driver_ride(ride_id="ride_100", user=user_drv2)

    assert exc_info.value.status_code == 409
    assert "already accepted" in exc_info.value.message


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_passenger_cancellation_releases_driver_presence(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("users").document("drv_1").set({
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "busy",
        "desiredAvailability": "online",
    })
    db.collection("driverPresence").document("drv_1").set({
        "driverAvailability": "busy",
        "desiredAvailability": "online",
    })
    db.collection("driverMapPresence").document("drv_1").set({
        "driverAvailability": "busy",
    })

    db.collection("rides").document("ride_200").set({
        "status": "accepted",
        "passenger_id": "pass_1",
        "driver_id": "drv_1",
        "createdAt": datetime.now(timezone.utc),
    })

    user_pass = {"uid": "pass_1", "role": "passenger"}
    res = rides.cancel_passenger_ride(ride_id="ride_200", user=user_pass)
    assert res["ok"] is True
    assert res["status"] == "cancelled_by_passenger"

    drv_presence = db.collection("driverPresence").document("drv_1").get().to_dict()
    assert drv_presence["driverAvailability"] == "searching"

    map_presence = db.collection("driverMapPresence").document("drv_1").get().to_dict()
    assert map_presence["driverAvailability"] == "searching"


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_passenger_cancellation_mid_trip_calculates_partial_fare(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("users").document("drv_1").set({
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "busy",
        "desiredAvailability": "online",
    })

    db.collection("rides").document("ride_300").set({
        "status": "started",
        "passenger_id": "pass_1",
        "driver_id": "drv_1",
        "pinVerifiedAt": datetime.now(timezone.utc),
        "distance_km": 10.0,
        "fare": 150.0,
        "vehicle_type": "auto",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "drop_lat": 23.90,
        "drop_lng": 91.35,
        "max_travelled_km": 4.0,
        "max_progress_ratio": 0.4,
    })

    user_pass = {"uid": "pass_1", "role": "passenger"}
    res = rides.cancel_passenger_ride(ride_id="ride_300", user=user_pass)
    assert res["ok"] is True

    ride_doc = db.collection("rides").document("ride_300").get().to_dict()
    assert ride_doc["status"] == "cancelled_by_passenger"
    assert "fare_adjustment" in ride_doc
    assert ride_doc["fare"] <= 150.0
    assert ride_doc["fare_adjustment"]["reason"] == "partial_trip"
