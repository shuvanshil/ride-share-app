from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
import pytest

from api.core.errors import ApiError
from api.services.db import (
    driver_has_other_active_rides,
    driver_has_open_share_trips,
    update_driver_presence_synchronized,
    sync_share_trip_passenger_ids,
    record_ride_audit,
    record_financial_ledger_entry,
)
from api.routers import rides, share


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True, reference=None):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists
        self.reference = reference

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None), reference=self)

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
                matches.append(MockDocSnapshot(doc_id, data, exists=True, reference=MockDocReference(col, doc_id, self.store)))
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
        self._read_only = False
        self._id = "mock_tx"

    def update(self, doc_ref, data):
        doc_ref.update(data)

    def set(self, doc_ref, data, merge=False):
        doc_ref.set(data, merge=merge)

    def delete(self, doc_ref):
        doc_ref.delete()


class MockBatch:
    def __init__(self, store: dict):
        self.store = store
        self.ops = []

    def set(self, doc_ref, data, merge=False):
        self.ops.append((doc_ref, data, merge))

    def update(self, doc_ref, data):
        self.ops.append((doc_ref, data, True))

    def delete(self, doc_ref):
        self.ops.append((doc_ref, None, None))

    def commit(self):
        for doc_ref, data, merge in self.ops:
            if data is None:
                doc_ref.delete()
            else:
                doc_ref.set(data, merge=merge)


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def transaction(self):
        return MockTransaction(self.store)

    def batch(self):
        return MockBatch(self.store)


def test_driver_has_other_active_rides_logic() -> None:
    db = MockFirestoreClient()
    # No active rides
    assert driver_has_other_active_rides(db, "drv_100") is False

    # Add a completed ride
    db.collection("rides").document("ride_1").set({
        "driver_id": "drv_100",
        "status": "completed",
    })
    assert driver_has_other_active_rides(db, "drv_100") is False

    # Add an active ride
    db.collection("rides").document("ride_2").set({
        "driver_id": "drv_100",
        "status": "en_route",
    })
    assert driver_has_other_active_rides(db, "drv_100") is True

    # Exclude ride_2
    assert driver_has_other_active_rides(db, "drv_100", exclude_ride_id="ride_2") is False


def test_driver_has_open_share_trips_logic() -> None:
    db = MockFirestoreClient()
    assert driver_has_open_share_trips(db, "drv_100") is False

    db.collection("shareTrips").document("trip_1").set({
        "driverId": "drv_100",
        "status": "completed",
    })
    assert driver_has_open_share_trips(db, "drv_100") is False

    db.collection("shareTrips").document("trip_2").set({
        "driverId": "drv_100",
        "status": "active",
    })
    assert driver_has_open_share_trips(db, "drv_100") is True

    # Exclude trip_2
    assert driver_has_open_share_trips(db, "drv_100", exclude_trip_id="trip_2") is False


def test_update_driver_presence_synchronized() -> None:
    db = MockFirestoreClient()
    update_driver_presence_synchronized(db, "drv_test", "busy")

    u_data = db.collection("users").document("drv_test").get().to_dict()
    dp_data = db.collection("driverPresence").document("drv_test").get().to_dict()
    dmp_data = db.collection("driverMapPresence").document("drv_test").get().to_dict()

    assert u_data["driverAvailability"] == "busy"
    assert dp_data["driverAvailability"] == "busy"
    assert dmp_data["driverAvailability"] == "busy"


def test_sync_share_trip_passenger_ids() -> None:
    db = MockFirestoreClient()
    db.collection("rides").document("child_1").set({"passenger_id": "p1"})
    db.collection("rides").document("child_2").set({"passengerId": "p2"})

    db.collection("shareTrips").document("trip_main").set({
        "childRideIds": ["child_1", "child_2"],
        "status": "active",
    })

    sync_share_trip_passenger_ids(db, "trip_main")
    trip_data = db.collection("shareTrips").document("trip_main").get().to_dict()
    assert set(trip_data["passenger_ids"]) == {"p1", "p2"}
    assert set(trip_data["passengerIds"]) == {"p1", "p2"}


def test_record_ride_audit_and_ledger() -> None:
    db = MockFirestoreClient()
    record_ride_audit(
        db,
        "ride_999",
        action="status_change",
        actor_id="admin_1",
        actor_role="admin",
        details={"from": "accepted", "to": "completed"},
    )
    audits = [snap.to_dict() for snap in db.collection("ride_audits").stream()]
    assert len(audits) == 1
    assert audits[0]["rideId"] == "ride_999"
    assert audits[0]["action"] == "status_change"
    assert audits[0]["actorId"] == "admin_1"
    assert audits[0]["actorRole"] == "admin"

    record_financial_ledger_entry(
        db,
        entry_id="ledger_999",
        amount_paise=15000,
        entry_type="fare_split",
        ride_id="ride_999",
        details={"driver_cut": 120.0},
    )
    ledgers = [snap.to_dict() for snap in db.collection("financialLedger").stream()]
    assert len(ledgers) == 1
    assert ledgers[0]["entryId"] == "ledger_999"
    assert ledgers[0]["entryType"] == "fare_split"
    assert ledgers[0]["amountPaise"] == 15000
    assert ledgers[0]["amountInr"] == 150.0


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_cancel_ride_unauthorized_user_forbidden(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("rides").document("ride_secure").set({
        "status": "accepted",
        "passenger_id": "legit_passenger",
        "driver_id": "drv_1",
        "createdAt": datetime.now(timezone.utc),
    })

    # Attacker tries to cancel
    attacker = {"uid": "attacker_user", "role": "passenger"}
    with pytest.raises(ApiError) as exc_info:
        rides.cancel_passenger_ride(ride_id="ride_secure", user=attacker)

    assert exc_info.value.status_code == 403
    assert "not authorized" in exc_info.value.message.lower() or "only cancel your own" in exc_info.value.message.lower()


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_cancel_ride_driver_not_released_if_having_other_rides(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    # Driver has another active ride
    db.collection("rides").document("ride_active_other").set({
        "status": "started",
        "driver_id": "drv_busy",
        "passenger_id": "other_pass",
    })
    db.collection("rides").document("ride_to_cancel").set({
        "status": "accepted",
        "passenger_id": "pass_cancel",
        "driver_id": "drv_busy",
        "createdAt": datetime.now(timezone.utc),
    })
    db.collection("users").document("drv_busy").set({
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "busy",
        "desiredAvailability": "online",
    })
    db.collection("driverPresence").document("drv_busy").set({
        "driverAvailability": "busy",
        "desiredAvailability": "online",
    })

    res = rides.cancel_passenger_ride(ride_id="ride_to_cancel", user={"uid": "pass_cancel", "role": "passenger"})
    assert res["ok"] is True

    # Driver presence should REMAIN busy because ride_active_other is still started!
    dp = db.collection("driverPresence").document("drv_busy").get().to_dict()
    assert dp["driverAvailability"] == "busy"


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_reject_driver_ride_keeps_pending_for_other_candidates(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    for drv_id in ["drv_1", "drv_2", "drv_3"]:
        db.collection("users").document(drv_id).set({
            "role": "driver",
            "verificationStatus": "approved",
            "name": f"Driver {drv_id}",
        })

    db.collection("rides").document("ride_multi").set({
        "status": "pending",
        "passenger_id": "pass_1",
        "eligible_driver_ids": ["drv_1", "drv_2", "drv_3"],
        "rejected_driver_ids": [],
        "createdAt": datetime.now(timezone.utc),
    })

    # Driver 1 rejects
    res1 = rides.reject_driver_ride(ride_id="ride_multi", user={"uid": "drv_1", "role": "driver"})
    assert res1["ok"] is True

    # Ride MUST still be pending because drv_2 and drv_3 are still eligible!
    ride_snap = db.collection("rides").document("ride_multi").get().to_dict()
    assert ride_snap["status"] == "pending"
    assert "drv_1" in ride_snap["rejected_driver_ids"]

    # Driver 2 rejects
    res2 = rides.reject_driver_ride(ride_id="ride_multi", user={"uid": "drv_2", "role": "driver"})
    assert res2["ok"] is True
    ride_snap = db.collection("rides").document("ride_multi").get().to_dict()
    assert ride_snap["status"] == "pending"
    assert "drv_2" in ride_snap["rejected_driver_ids"]

    # Driver 3 rejects (last eligible driver)
    res3 = rides.reject_driver_ride(ride_id="ride_multi", user={"uid": "drv_3", "role": "driver"})
    assert res3["ok"] is True
    ride_snap = db.collection("rides").document("ride_multi").get().to_dict()
    assert "drv_3" in ride_snap["rejected_driver_ids"]
    assert ride_snap.get("status") == "declined"


@patch("api.routers.share.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_share_trip_strips_pii_fields(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("shareTrips").document("trip_pii").set({
        "status": "open",
        "route_name": "Route A to B",
        "passenger_phone": "+919876543210",
        "passenger_name": "Secret Person",
        "passenger_email": "secret@example.com",
        "coPassengers": [{"name": "Private"}],
    })

    res = share.get_share_trip("trip_pii", user={"uid": "any_authenticated_user"})
    assert res["ok"] is True
    trip = res["trip"]
    assert "passenger_phone" not in trip
    assert "passenger_name" not in trip
    assert "passenger_email" not in trip
    assert "coPassengers" not in trip
    assert trip["route_name"] == "Route A to B"


def test_update_driver_presence_synchronized_batch_write() -> None:
    db = MockFirestoreClient()
    db.collection("users").document("drv_sync_1").set({
        "role": "driver",
        "verificationStatus": "approved",
        "name": "Sync Driver",
        "vehicle_type": "auto",
        "desiredAvailability": "online",
    })

    update_driver_presence_synchronized(
        db,
        "drv_sync_1",
        availability="busy",
        desired_availability="online",
        profile_data={"role": "driver", "verificationStatus": "approved", "name": "Sync Driver"},
    )

    u_snap = db.collection("users").document("drv_sync_1").get().to_dict()
    p_snap = db.collection("driverPresence").document("drv_sync_1").get().to_dict()
    m_snap = db.collection("driverMapPresence").document("drv_sync_1").get().to_dict()

    assert u_snap["driverAvailability"] == "busy"
    assert p_snap["driverAvailability"] == "busy"
    assert m_snap["driverAvailability"] == "busy"


def test_sync_share_trip_passenger_ids_preserves_existing_ids() -> None:
    db = MockFirestoreClient()
    db.collection("shareTrips").document("trip_sync_1").set({
        "status": "active",
        "childRideIds": ["ride_child_1", "ride_child_nonexistent"],
        "passenger_ids": ["existing_passenger_99"],
        "passengerIds": ["existing_passenger_99"],
    })
    db.collection("rides").document("ride_child_1").set({
        "passenger_id": "passenger_new_1",
    })

    synced = sync_share_trip_passenger_ids(db, "trip_sync_1")
    assert "existing_passenger_99" in synced
    assert "passenger_new_1" in synced

    trip_data = db.collection("shareTrips").document("trip_sync_1").get().to_dict()
    assert "existing_passenger_99" in trip_data["passenger_ids"]
    assert "passenger_new_1" in trip_data["passenger_ids"]


@patch("api.routers.admin._db")
@patch("api.routers.admin.require_admin", lambda: {"uid": "admin_1", "role": "admin"})
def test_admin_update_ride_cancel_cascades_to_share_trips(mock_admin_db) -> None:
    from api.routers import admin

    db = MockFirestoreClient()
    mock_admin_db.return_value = db

    db.collection("shareTrips").document("parent_share_1").set({
        "tripId": "parent_share_1",
        "driverId": "drv_share_admin",
        "status": "active",
        "seatsUsed": 2,
        "childRideIds": ["ride_sub_1", "ride_sub_2"],
        "stopOrder": [
            {"rideId": "ride_sub_1", "kind": "drop"},
            {"rideId": "ride_sub_2", "kind": "drop"},
        ],
    })
    db.collection("rides").document("ride_sub_1").set({
        "status": "accepted",
        "driver_id": "drv_share_admin",
        "parentTripId": "parent_share_1",
    })

    res = admin.update_ride("ride_sub_1", admin.RideActionBody(action="cancel"), admin_user={"uid": "admin_1", "role": "admin"})
    assert res["ok"] is True

    # Share trip childRideIds must be updated and seatsUsed decremented
    parent_snap = db.collection("shareTrips").document("parent_share_1").get().to_dict()
    assert parent_snap["childRideIds"] == ["ride_sub_2"]
    assert parent_snap["seatsUsed"] == 1
    assert len(parent_snap["stopOrder"]) == 1
    assert parent_snap["stopOrder"][0]["rideId"] == "ride_sub_2"


@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_match_pending_requests_skips_driver_with_active_rides(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    # Driver currently has an active normal ride
    db.collection("rides").document("ride_ongoing_1").set({
        "status": "started",
        "driver_id": "drv_busy_worker",
    })

    db.collection("pendingRideRequests").document("pending_req_1").set({
        "status": "pending",
        "mode": "auto",
        "pickup": {"lat": 23.83, "lng": 91.28, "name": "Start"},
        "drop": {"lat": 23.85, "lng": 91.30, "name": "End"},
        "createdAt": datetime.now(timezone.utc),
        "rejected_driver_ids": [],
    })

    matched = rides._match_pending_requests_for_driver(
        db,
        "drv_busy_worker",
        driver_profile={"role": "driver", "vehicle_type": "auto"},
        driver_location={"lat": 23.83, "lng": 91.28},
    )
    assert matched is None


def test_sweep_stale_drivers_purges_map_presence() -> None:
    from api.dispatch.sweeper import sweep_stale_drivers

    db = MockFirestoreClient()
    now = 5000.0
    # Add a driver with last_seen 4500 seconds ago (> DRIVER_STALE_TIMEOUT_SEC of 120s)
    db.collection("dispatchDAP").document("drv_stale_1").set({
        "state": "IDLE",
        "last_seen": 4500.0,
    })
    db.collection("driverMapPresence").document("drv_stale_1").set({
        "driverAvailability": "searching",
        "isConnected": True,
    })
    db.collection("driverPresence").document("drv_stale_1").set({
        "driverAvailability": "searching",
        "isConnected": True,
    })

    demoted = sweep_stale_drivers(db, now)
    assert demoted == 1

    dap_data = db.collection("dispatchDAP").document("drv_stale_1").get().to_dict()
    assert dap_data["state"] == "STALE"

    dmp_data = db.collection("driverMapPresence").document("drv_stale_1").get().to_dict()
    assert dmp_data["driverAvailability"] == "offline"
    assert dmp_data["isConnected"] is False

    dp_data = db.collection("driverPresence").document("drv_stale_1").get().to_dict()
    assert dp_data["driverAvailability"] == "offline"
    assert dp_data["isConnected"] is False

    u_data = db.collection("users").document("drv_stale_1").get().to_dict()
    assert u_data["driverAvailability"] == "offline"
    assert u_data["isConnected"] is False


@pytest.mark.anyio
@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides._send_driver_push_notification")
@patch("api.routers.rides._available_drivers")
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
async def test_create_passenger_ride_sends_notifications_for_standard_ride(
    mock_client, mock_app, mock_available_drivers, mock_send_push
) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()
    mock_available_drivers.return_value = [
        {"uid": "drv_push_target", "distance_km": 1.2, "name": "Target Driver"}
    ]
    db.collection("users").document("pass_creator").set({
        "role": "passenger",
        "name": "Passenger One",
    })

    body = rides.RideCreateBody(
        pickupName="Agartala Station",
        dropName="City Centre",
        pickupLat=23.83,
        pickupLng=91.28,
        dropLat=23.85,
        dropLng=91.30,
        vehicleType="auto",
    )
    user = {"uid": "pass_creator", "role": "passenger", "name": "Passenger One"}

    res = await rides.create_passenger_ride(body=body, user=user)
    assert res["ok"] is True
    assert "drv_push_target" in res["notifiedDriverIds"]
    mock_send_push.assert_called_once()
    call_args = mock_send_push.call_args[0]
    assert call_args[1] == "drv_push_target"
    assert call_args[4]["type"] == "NEW_PASSENGER_AVAILABLE"


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides._collect_tokens", lambda db, uids: {})
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_cancel_passenger_ride_cascades_to_pending_request(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("rides").document("ride_pending_cascade").set({
        "status": "pending",
        "passenger_id": "pass_cancel_1",
        "driver_id": None,
        "eligible_driver_ids": ["drv_target_1"],
        "pending_request_id": "req_cascade_1",
    })
    db.collection("pendingRideRequests").document("req_cascade_1").set({
        "status": "dispatching",
        "passengerId": "pass_cancel_1",
        "rideId": "ride_pending_cascade",
    })

    res = rides.cancel_passenger_ride("ride_pending_cascade", user={"uid": "pass_cancel_1", "role": "passenger"})
    assert res["ok"] is True

    req_snap = db.collection("pendingRideRequests").document("req_cascade_1").get().to_dict()
    assert req_snap["status"] == "cancelled"


@patch("api.routers.rides._collect_tokens", lambda db, uids: {})
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_cancel_pending_request_cascades_to_ride(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("pendingRideRequests").document("req_pending_1").set({
        "status": "dispatching",
        "passengerId": "pass_owner",
        "rideId": "ride_from_pending",
        "lockedByDriverId": "drv_locked",
    })
    db.collection("rides").document("ride_from_pending").set({
        "status": "pending",
        "passenger_id": "pass_owner",
    })

    res = rides.cancel_pending_request("req_pending_1", user={"uid": "pass_owner", "role": "passenger"})
    assert res["ok"] is True

    ride_snap = db.collection("rides").document("ride_from_pending").get().to_dict()
    assert ride_snap["status"] == "cancelled_by_passenger"


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_accept_driver_ride_populates_location_and_blocks_busy_driver(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("rides").document("ride_to_accept").set({
        "status": "pending",
        "passenger_id": "pass_user_1",
        "driver_id": None,
        "vehicle_type": "auto",
        "eligible_driver_ids": ["drv_accepting"],
    })
    db.collection("users").document("drv_accepting").set({
        "role": "driver",
        "verificationStatus": "approved",
        "name": "Accepting Driver",
        "vehicle_type": "auto",
    })
    db.collection("driverPresence").document("drv_accepting").set({
        "driverAvailability": "searching",
        "location": {"lat": 23.835, "lng": 91.285},
    })

    # Driver accepts successfully
    res = rides.accept_driver_ride("ride_to_accept", user={"uid": "drv_accepting", "role": "driver"})
    assert res["ok"] is True

    ride_snap = db.collection("rides").document("ride_to_accept").get().to_dict()
    assert ride_snap["status"] == "accepted"
    assert ride_snap["driver_id"] == "drv_accepting"
    assert ride_snap["driverLocation"] == {"lat": 23.835, "lng": 91.285}

    # If driver is now busy and tries to accept another ride, should be rejected with 409
    db.collection("rides").document("ride_second").set({
        "status": "pending",
        "passenger_id": "pass_user_2",
        "driver_id": None,
        "vehicle_type": "auto",
        "eligible_driver_ids": ["drv_accepting"],
    })
    with pytest.raises(ApiError) as exc_info:
        rides.accept_driver_ride("ride_second", user={"uid": "drv_accepting", "role": "driver"})
    assert exc_info.value.status_code == 409


@patch("api.routers.rides._send_driver_push_notification")
@patch("api.routers.rides._collect_tokens", lambda db, uids: {})
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_cancel_passenger_ride_notifies_all_eligible_drivers(mock_client, mock_app, mock_push) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("rides").document("ride_multi_driver").set({
        "status": "pending",
        "passenger_id": "pax_123",
        "driver_id": None,
        "eligible_driver_ids": ["drv_a", "drv_b", "drv_c"],
    })

    res = rides.cancel_passenger_ride("ride_multi_driver", user={"uid": "pax_123", "role": "passenger"})
    assert res["ok"] is True

    notified = {call.args[1] for call in mock_push.call_args_list}
    assert {"drv_a", "drv_b", "drv_c"}.issubset(notified)
    for call in mock_push.call_args_list:
        assert call.args[4]["type"] == "RIDE_CANCELLED"


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
@patch("api.routers.rides._send_driver_push_notification")
@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_reject_driver_ride_pool_managed_notifies_next_candidate(mock_client, mock_app, mock_push) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("rides").document("ride_pool_seq").set({
        "status": "pending",
        "passenger_id": "pax_seq_1",
        "driver_id": None,
        "vehicle_type": "auto",
        "current_offer_driver_id": "drv_1",
        "eligible_driver_ids": ["drv_1", "drv_2"],
        "notified_driver_ids": ["drv_1"],
        "rejected_driver_ids": [],
    })
    db.collection("users").document("drv_1").set({
        "role": "driver",
        "verificationStatus": "approved",
        "vehicle_type": "auto",
    })

    res = rides.reject_driver_ride("ride_pool_seq", user={"uid": "drv_1", "role": "driver"})
    assert res["ok"] is True

    ride_snap = db.collection("rides").document("ride_pool_seq").get().to_dict()
    assert ride_snap["current_offer_driver_id"] == "drv_2"
    assert "drv_1" in ride_snap["rejected_driver_ids"]
    assert "drv_2" in ride_snap["notified_driver_ids"]

    # drv_2 must have received push notification
    notified = [call.args[1] for call in mock_push.call_args_list]
    assert "drv_2" in notified


@patch("api.routers.rides.get_admin_app")
@patch("firebase_admin.firestore.client")
def test_update_driver_location_offline_sets_is_connected_false(mock_client, mock_app) -> None:
    db = MockFirestoreClient()
    mock_client.return_value = db
    mock_app.return_value = MagicMock()

    db.collection("users").document("drv_offline_gps").set({
        "role": "driver",
        "verificationStatus": "approved",
        "vehicle_type": "auto",
        "desiredAvailability": "offline",
    })

    body = rides.DriverLocationBody(lat=23.83, lng=91.28)
    res = rides.update_driver_location(body=body, user={"uid": "drv_offline_gps", "role": "driver"})
    assert res["ok"] is True
    assert res["status"] == "offline"

    dmp = db.collection("driverMapPresence").document("drv_offline_gps").get().to_dict()
    assert dmp["isConnected"] is False
    assert dmp["driverAvailability"] == "offline"

    dp = db.collection("driverPresence").document("drv_offline_gps").get().to_dict()
    assert dp["isConnected"] is False
    assert dp["driverAvailability"] == "offline"



