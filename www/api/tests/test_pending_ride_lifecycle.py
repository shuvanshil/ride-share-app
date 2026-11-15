"""Tests for Passenger Pending Ride Requests ('Notify Me When Available', 'Schedule for Later', and Cancellation)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from unittest.mock import patch

import pytest

from api.routers.rides import (
    PassengerRideCancelBody,
    PendingRideCancelBody,
    PendingRideRequestBody,
    cancel_passenger_ride,
    cancel_pending_request,
    check_and_notify_pending_passengers,
    create_pending_request,
    get_active_pending_request,
)


class FakeDocRef:
    def __init__(self, coll_name: str, doc_id: str, store: dict[str, dict[str, Any]]):
        self.coll_name = coll_name
        self.id = doc_id
        self.store = store

    def get(self, transaction: Any = None) -> "FakeSnap":
        data = self.store.get(self.coll_name, {}).get(self.id)
        return FakeSnap(self.coll_name, self.id, data, self.store)

    def set(self, data: dict[str, Any], merge: bool = False) -> None:
        if self.coll_name not in self.store:
            self.store[self.coll_name] = {}
        if merge and self.id in self.store[self.coll_name]:
            merged = dict(self.store[self.coll_name][self.id])
            merged.update(data)
            self.store[self.coll_name][self.id] = merged
        else:
            self.store[self.coll_name][self.id] = dict(data)

    def update(self, data: dict[str, Any]) -> None:
        if self.coll_name not in self.store or self.id not in self.store[self.coll_name]:
            raise ValueError(f"Document {self.coll_name}/{self.id} does not exist")
        self.store[self.coll_name][self.id].update(data)

    def delete(self) -> None:
        if self.coll_name in self.store and self.id in self.store[self.coll_name]:
            del self.store[self.coll_name][self.id]


class FakeSnap:
    def __init__(self, coll_name: str, doc_id: str, data: Optional[dict[str, Any]], store: dict[str, dict[str, Any]]):
        self.coll_name = coll_name
        self.id = doc_id
        self._data = data
        self.store = store
        self.reference = FakeDocRef(coll_name, doc_id, store)

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict[str, Any]:
        return dict(self._data or {})


class FakeQuery:
    def __init__(
        self,
        coll_name: str,
        store: dict[str, dict[str, Any]],
        filters: Optional[list[tuple[str, str, Any]]] = None,
        limit_val: Optional[int] = None,
    ):
        self.coll_name = coll_name
        self.store = store
        self.filters = filters or []
        self.limit_val = limit_val

    def where(self, field: str, op: str, val: Any) -> "FakeQuery":
        return FakeQuery(self.coll_name, self.store, [*self.filters, (field, op, val)], self.limit_val)

    def limit(self, count: int) -> "FakeQuery":
        return FakeQuery(self.coll_name, self.store, self.filters, count)

    def order_by(self, field: str, direction: str = "ASCENDING") -> "FakeQuery":
        return self

    def stream(self, transaction: Any = None) -> list[FakeSnap]:
        docs = self.store.get(self.coll_name, {})
        out: list[FakeSnap] = []
        for doc_id, data in list(docs.items()):
            matched = True
            for field, op, val in self.filters:
                actual = data.get(field)
                if op == "==" and actual != val:
                    matched = False
                    break
                if op == "in" and actual not in val:
                    matched = False
                    break
            if matched:
                out.append(FakeSnap(self.coll_name, doc_id, data, self.store))
                if self.limit_val and len(out) >= self.limit_val:
                    break
        return out

    def get(self, transaction: Any = None) -> list[FakeSnap]:
        return self.stream(transaction=transaction)


class FakeCollection:
    def __init__(self, coll_name: str, store: dict[str, dict[str, Any]], counter: list[int]):
        self.coll_name = coll_name
        self.store = store
        self.counter = counter

    def document(self, doc_id: Optional[str] = None) -> FakeDocRef:
        if not doc_id:
            self.counter[0] += 1
            doc_id = f"doc_{self.counter[0]}"
        return FakeDocRef(self.coll_name, doc_id, self.store)

    def where(self, field: str, op: str, val: Any) -> FakeQuery:
        return FakeQuery(self.coll_name, self.store, [(field, op, val)])

    def limit(self, count: int) -> FakeQuery:
        return FakeQuery(self.coll_name, self.store, [], count)

    def stream(self) -> list[FakeSnap]:
        return FakeQuery(self.coll_name, self.store).stream()


class FakeTransaction:
    def update(self, ref: FakeDocRef, data: dict[str, Any]) -> None:
        ref.update(data)

    def set(self, ref: FakeDocRef, data: dict[str, Any], merge: bool = False) -> None:
        ref.set(data, merge=merge)


class FakeFirestore:
    def __init__(self):
        self.store: dict[str, dict[str, Any]] = {}
        self.counter = [0]

    def collection(self, name: str) -> FakeCollection:
        return FakeCollection(name, self.store, self.counter)

    def transaction(self) -> FakeTransaction:
        return FakeTransaction()


def test_notify_me_supersedes_live_ride_and_survives_silent_cancel():
    """
    Bug 1 verification:
    When a passenger is searching on a live ride (`ride_1`) and clicks 'Notify Me When Available':
    1. `create_pending_request` atomically supersedes `ride_1` (`cancelled_by_passenger`, `switched_to_pending_request`).
    2. `pendingRideRequests/{reqId}` is created in `status == "pending"`.
    3. Calling `cancel_passenger_ride("ride_1", keepPendingRequest=True)` does NOT cancel the pending request!
    4. Drivers who already ignored `ride_1` do not falsely trigger `driverAvailableImmediately`.
    5. When a new driver comes online nearby, `check_and_notify_pending_passengers` sets `lastNotifiedAt`.
    """
    fake_db = FakeFirestore()
    uid = "pass_101"
    fake_db.collection("users").document(uid).set({
        "uid": uid,
        "role": "passenger",
        "name": "Aarav",
        "phone": "9876543210",
    })
    # Live ride currently searching, where drv_ignored was already notified
    fake_db.collection("rides").document("ride_1").set({
        "passenger_id": uid,
        "status": "pending",
        "notified_driver_ids": ["drv_ignored"],
        "rejected_driver_ids": [],
        "pendingRequestId": "req_existing",
    })
    # drv_ignored is in DAP, but was already notified on ride_1
    fake_db.collection("dispatchAvailablePool").document("drv_ignored").set({
        "state": "IDLE",
        "vehicle_type": "auto",
        "loc": {"lat": 22.5726, "lng": 88.3639},
        "last_seen_at": datetime.now(timezone.utc).timestamp(),
    })

    with patch("api.routers.rides.fb_firestore.client", return_value=fake_db), \
         patch("api.routers.rides.get_admin_app", return_value=object()), \
         patch("api.routers.rides.nudge_dispatch"), \
         patch("api.routers.rides._send_passenger_push_and_inapp"):

        body = PendingRideRequestBody(
            pickupName="Park Street",
            dropName="Howrah Station",
            pickupLat=22.5726,
            pickupLng=88.3639,
            dropLat=22.5850,
            dropLng=88.3426,
            vehicleType="auto",
            searchRadius=5000.0,
            mode="notify_only",
            fareEstimate={"fare": 95, "distance_km": 4.5},
        )
        res = asyncio.run(create_pending_request(body=body, user={"uid": uid}))
        assert res["ok"] is True
        req_id = res["requestId"]
        # drv_ignored was already notified on ride_1, so should NOT falsely trigger immediate notification
        assert res["driverAvailableImmediately"] is False

        # Old live ride was atomically superseded
        ride_doc = fake_db.collection("rides").document("ride_1").get().to_dict()
        assert ride_doc["status"] == "cancelled_by_passenger"
        assert ride_doc["cancelReason"] == "switched_to_pending_request"

        # Now frontend calls cancelActiveRideSilently("ride_1", keepPendingRequest=True)
        cancel_res = cancel_passenger_ride(
            ride_id="ride_1",
            body=PassengerRideCancelBody(reason="switched_to_pending_request", keepPendingRequest=True),
            user={"uid": uid},
        )
        assert cancel_res["ok"] is True

        # Pending request MUST still be active in status == "pending"!
        active_res = get_active_pending_request(user={"uid": uid})
        assert active_res["hasActivePending"] is True
        assert active_res["pendingRequest"]["requestId"] == req_id
        assert active_res["pendingRequest"]["status"] == "pending"

        # Now a new driver (drv_new) comes online nearby
        notified = check_and_notify_pending_passengers(
            fake_db,
            driver_uid="drv_new",
            driver_loc={"lat": 22.5730, "lng": 88.3640},
            driver_vehicle_type="auto",
        )
        assert notified == 1
        updated_pending = fake_db.collection("pendingRideRequests").document(req_id).get().to_dict()
        assert updated_pending.get("lastNotifiedAt") is not None
        assert updated_pending.get("matchedDriverId") == "drv_new"


def test_schedule_for_later_does_not_trigger_immediate_driver_and_clears_stale_fields():
    """
    When scheduling a ride for 30 minutes in the future:
    1. Reusing an existing pendingRideRequests doc clears any stale `lastNotifiedAt` / `scheduleTimedOut`.
    2. Even if a driver is online right now, `driverAvailableImmediately` is False for a future scheduled ride.
    """
    fake_db = FakeFirestore()
    uid = "pass_202"
    fake_db.collection("users").document(uid).set({
        "uid": uid,
        "role": "passenger",
        "name": "Priya",
    })
    # Existing pending doc with stale lastNotifiedAt
    fake_db.collection("pendingRideRequests").document("req_stale").set({
        "requestId": "req_stale",
        "passengerId": uid,
        "status": "pending",
        "mode": "notify_only",
        "lastNotifiedAt": datetime.now(timezone.utc),
        "matchedDriverId": "old_drv",
        "scheduleTimedOut": True,
    })
    # Driver online right now
    fake_db.collection("dispatchAvailablePool").document("drv_online").set({
        "state": "IDLE",
        "vehicle_type": "auto",
        "loc": {"lat": 22.5726, "lng": 88.3639},
        "last_seen_at": datetime.now(timezone.utc).timestamp(),
    })

    future_iso = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()

    with patch("api.routers.rides.fb_firestore.client", return_value=fake_db), \
         patch("api.routers.rides.get_admin_app", return_value=object()), \
         patch("api.routers.rides.nudge_dispatch"), \
         patch("api.routers.rides._send_passenger_push_and_inapp"):

        body = PendingRideRequestBody(
            pickupName="Salt Lake",
            dropName="Airport",
            pickupLat=22.5726,
            pickupLng=88.3639,
            dropLat=22.6520,
            dropLng=88.4463,
            vehicleType="auto",
            searchRadius=5000.0,
            mode="schedule",
            activatesAt=future_iso,
            fareEstimate={"fare": 180, "distance_km": 9.2},
        )
        res = asyncio.run(create_pending_request(body=body, user={"uid": uid}))
        assert res["ok"] is True
        assert res["requestId"] == "req_stale"
        assert res["driverAvailableImmediately"] is False

        doc_data = fake_db.collection("pendingRideRequests").document("req_stale").get().to_dict()
        assert doc_data["mode"] == "schedule"
        assert doc_data["lastNotifiedAt"] is None
        assert doc_data["matchedDriverId"] is None
        assert doc_data["scheduleTimedOut"] is False


def test_cancel_passenger_ride_cancels_orphaned_pending_requests():
    """
    Bug 2 verification:
    When a passenger cancels their ride request (with keepPendingRequest=False),
    any active `pendingRideRequests` document for that passenger is ALSO cancelled
    so that after page reload (`GET /api/rides/pending-request/active`), nothing pops up!
    """
    fake_db = FakeFirestore()
    uid = "pass_303"
    fake_db.collection("users").document(uid).set({
        "uid": uid,
        "role": "passenger",
        "name": "Rohan",
    })
    fake_db.collection("rides").document("ride_active").set({
        "passenger_id": uid,
        "status": "pending",
        "distance_km": 3.0,
    })
    # Unlinked pendingRideRequests doc that had lastNotifiedAt set
    fake_db.collection("pendingRideRequests").document("pending_orphan").set({
        "requestId": "pending_orphan",
        "passengerId": uid,
        "status": "pending",
        "mode": "notify_only",
        "lastNotifiedAt": datetime.now(timezone.utc),
    })

    with patch("api.routers.rides.fb_firestore.client", return_value=fake_db), \
         patch("api.routers.rides.get_admin_app", return_value=object()), \
         patch("api.routers.rides.fb_firestore.transactional", side_effect=lambda fn: fn):

        res = cancel_passenger_ride(
            ride_id="ride_active",
            body=PassengerRideCancelBody(reason="cancelled_by_passenger", keepPendingRequest=False),
            user={"uid": uid},
        )
        assert res["ok"] is True

        # Both the ride AND the pending request must be cancelled
        ride_data = fake_db.collection("rides").document("ride_active").get().to_dict()
        assert ride_data["status"] == "cancelled_by_passenger"

        pending_data = fake_db.collection("pendingRideRequests").document("pending_orphan").get().to_dict()
        assert pending_data["status"] == "cancelled"

        # On page reload, GET /api/rides/pending-request/active must return hasActivePending=False
        active_check = get_active_pending_request(user={"uid": uid})
        assert active_check["hasActivePending"] is False
        assert active_check["pendingRequest"] is None
