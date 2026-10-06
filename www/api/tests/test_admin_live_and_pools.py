from __future__ import annotations

from unittest.mock import patch
import pytest

from api.routers import admin
from api.routers.admin import RideActionBody


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists
        self.reference = MockDocReference("", doc_id, {})

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
    def __init__(self, collection_name: str, store: dict, filters: list = None, order_by_field: str = None, order_dir = None):
        self.collection_name = collection_name
        self.store = store
        self.filters = filters or []
        self.order_by_field = order_by_field
        self.order_dir = order_dir

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return MockQuery(self.collection_name, self.store, new_filters, self.order_by_field, self.order_dir)

    def order_by(self, field, direction=None):
        return MockQuery(self.collection_name, self.store, self.filters, field, direction)

    def limit(self, count):
        return self

    def start_after(self, cursor_snap):
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
                snap = MockDocSnapshot(doc_id, data, exists=True)
                snap.reference = MockDocReference(self.collection_name, doc_id, self.store)
                matches.append(snap)
        return matches


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        class MockCol:
            def __init__(self, coll_name, s):
                self.coll_name = coll_name
                self.s = s

            def document(self, doc_id=None):
                return MockDocReference(self.coll_name, doc_id or "auto_id", self.s)

            def where(self, field, op, val):
                return MockQuery(self.coll_name, self.s, [(field, op, val)])

            def order_by(self, field, direction=None):
                return MockQuery(self.coll_name, self.s, [], field, direction)

            def stream(self):
                return MockQuery(self.coll_name, self.s).stream()

            def limit(self, n):
                return MockQuery(self.coll_name, self.s)

        return MockCol(name, self.store)


@patch("api.routers.admin._db")
def test_live_rides_hierarchy(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    # 1. Share trip with 2 child rides
    db.collection("shareTrips").document("trip_784512").set({
        "id": "trip_784512",
        "status": "active",
        "maxSeats": 3,
        "seatsUsed": 2,
        "driverId": "drv_1",
        "driverName": "Rakesh Kumar",
        "pickup_name": "Ramakrishna palli",
        "drop_name": "Battala, Agartala",
        "childRideIds": ["ride_child_1", "ride_child_2"],
    })
    db.collection("rides").document("ride_child_1").set({
        "id": "ride_child_1",
        "parentTripId": "trip_784512",
        "status": "en_route",
        "rideType": "share",
        "vehicle_type": "auto",
        "driver_id": "drv_1",
        "driver_name": "Rakesh Kumar",
        "passenger_id": "pax_1",
        "passenger_name": "Amit Das",
        "passenger_phone": "+91 91234 56789",
        "pickup_name": "Ramakrishna palli",
        "drop_name": "Battala, Agartala",
        "createdAt": 1700000000.0,
    })
    db.collection("rides").document("ride_child_2").set({
        "id": "ride_child_2",
        "parentTripId": "trip_784512",
        "status": "en_route",
        "rideType": "share",
        "vehicle_type": "auto",
        "driver_id": "drv_1",
        "driver_name": "Rakesh Kumar",
        "passenger_id": "pax_2",
        "passenger_name": "Priya Saha",
        "passenger_phone": "+91 98765 67890",
        "pickup_name": "Ramakrishna palli",
        "drop_name": "Battala, Agartala",
        "createdAt": 1700000100.0,
    })

    # 2. Single regular ride (Auto)
    db.collection("rides").document("ride_784513").set({
        "id": "ride_784513",
        "status": "started",
        "rideType": "single",
        "vehicle_type": "auto",
        "driver_id": "drv_2",
        "driver_name": "Sanjay Mohanty",
        "driver_phone": "+91 87654 32109",
        "passenger_id": "pax_3",
        "passenger_name": "Deepak Roy",
        "passenger_phone": "+91 98623 00000",
        "pickup_name": "Kunjaban",
        "drop_name": "Agartala Railway Station",
        "createdAt": 1700000200.0,
    })

    # Users collection for backfilling vehicle numbers
    db.collection("users").document("drv_1").set({
        "name": "Rakesh Kumar",
        "phone": "+91 98765 43210",
        "vehicleNumber": "TR 01 AB 1234",
        "role": "driver",
    })
    db.collection("users").document("drv_2").set({
        "name": "Sanjay Mohanty",
        "phone": "+91 87654 32109",
        "vehicleNumber": "TR 01 AC 5678",
        "role": "driver",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    res = admin.list_live_rides(admin_user=admin_user)

    assert res["ok"] is True
    assert "hierarchy" in res
    assert "counts" in res
    assert res["counts"]["share"] >= 1
    assert res["counts"]["single"] >= 1
    assert res["counts"]["child"] >= 3

    # Check share trip row
    share_row = next(h for h in res["hierarchy"] if h["id"] == "trip_784512")
    assert share_row["isParent"] is True
    assert share_row["passengers"]["label"] == "2 / 3"
    assert len(share_row["childRides"]) == 2
    assert share_row["childRides"][0]["passenger"]["name"] == "Amit Das"
    assert share_row["childRides"][1]["passenger"]["name"] == "Priya Saha"

    # Check single ride row
    single_row = next(h for h in res["hierarchy"] if h["id"] == "ride_784513")
    assert single_row["isParent"] is True
    assert len(single_row["childRides"]) == 1
    assert single_row["childRides"][0]["passenger"]["name"] == "Deepak Roy"


@patch("api.routers.admin._db")
def test_waiting_pools_endpoint(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    # Add passenger pool doc
    db.collection("dispatchWPP").document("pax_wait_1").set({
        "id": "pax_wait_1",
        "passenger_id": "pax_wait_1",
        "pickup": {"name": "Ramakrishna palli, West Tripura", "lat": 23.83, "lng": 91.28},
        "drop": {"name": "Battala", "lat": 23.82, "lng": 91.27},
        "vehicle_type": "share",
        "wants_share": True,
        "created_at": 1700000000.0,
        "state": "WAITING",
    })
    db.collection("users").document("pax_wait_1").set({
        "name": "Amit Das",
        "phone": "+91 91234 56789",
        "role": "passenger",
    })

    # Add driver pool doc
    db.collection("dispatchDAP").document("drv_avail_1").set({
        "id": "drv_avail_1",
        "driver_id": "drv_avail_1",
        "state": "IDLE",
        "idle_since": 1700000000.0,
        "loc": {"lat": 23.83, "lng": 91.28},
        "vehicleType": "auto",
    })
    db.collection("users").document("drv_avail_1").set({
        "name": "Rakesh Kumar",
        "phone": "+91 98765 43210",
        "vehicleNumber": "TR 01 AB 1234",
        "vehicleType": "auto",
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "online",
        "locationName": "Ramakrishna palli, West Tripura",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    res = admin.list_waiting_pools(admin_user=admin_user)

    assert res["ok"] is True
    assert len(res["passengers"]) >= 1
    assert res["passengers"][0]["name"] == "Amit Das"
    assert res["passengers"][0]["type"] == "Share"
    assert res["passengers"][0]["pickupLocation"] == "Ramakrishna palli, West Tripura"

    assert len(res["drivers"]) >= 1
    assert res["drivers"][0]["name"] == "Rakesh Kumar"
    assert res["drivers"][0]["plate"] == "TR 01 AB 1234"
    assert res["drivers"][0]["vehicleType"] == "Auto"
    assert res["counts"]["total"] >= 2


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_admin_cancel_hierarchical_ride(mock_db_fn, mock_audit) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    # Parent share trip with 2 children and assigned driver
    db.collection("users").document("drv_test_cancel").set({
        "name": "Test Driver",
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "on_ride",
        "desiredAvailability": "online",
    })
    db.collection("shareTrips").document("trip_cancel_test").set({
        "id": "trip_cancel_test",
        "status": "active",
        "seatsUsed": 2,
        "driverId": "drv_test_cancel",
        "childRideIds": ["c_1", "c_2"],
    })
    db.collection("rides").document("c_1").set({
        "id": "c_1",
        "parentTripId": "trip_cancel_test",
        "driver_id": "drv_test_cancel",
        "status": "started",
    })
    db.collection("rides").document("c_2").set({
        "id": "c_2",
        "parentTripId": "trip_cancel_test",
        "driver_id": "drv_test_cancel",
        "status": "started",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # 1. Cancel just child 1
    body_single = RideActionBody(action="cancel", cancel_all_children=False)
    res1 = admin.update_ride("c_1", body_single, admin_user=admin_user)
    assert res1["ok"] is True
    assert res1["ride"]["status"] == "cancelled_by_passenger"
    # Child 2 remains active
    assert db.collection("rides").document("c_2").get().to_dict()["status"] == "started"

    # 2. Cancel parent trip directly
    body_parent = RideActionBody(action="cancel", cancel_all_children=True)
    res2 = admin.update_ride("trip_cancel_test", body_parent, admin_user=admin_user)
    assert res2["ok"] is True
    # Share trip status is cancelled
    assert db.collection("shareTrips").document("trip_cancel_test").get().to_dict()["status"] == "cancelled"
    # Child 2 is now cancelled
    assert db.collection("rides").document("c_2").get().to_dict()["status"] == "cancelled_by_passenger"
