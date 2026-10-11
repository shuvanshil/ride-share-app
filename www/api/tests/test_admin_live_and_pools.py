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
                elif op in (">=", ">", "<=", "<"):
                    if doc_val is None:
                        matched = False
                        break
                    dv = doc_val.timestamp() if hasattr(doc_val, "timestamp") else doc_val
                    tv = val.timestamp() if hasattr(val, "timestamp") else val
                    if isinstance(dv, (int, float)) and isinstance(tv, (int, float)):
                        if (op == ">=" and not (dv >= tv)) or (op == ">" and not (dv > tv)) or (op == "<=" and not (dv <= tv)) or (op == "<" and not (dv < tv)):
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
        self.get_all_calls = 0

    def get_all(self, refs):
        self.get_all_calls += 1
        return [ref.get() for ref in refs]

    def batch(self):
        class MockBatch:
            def __init__(self):
                self.ops = []

            def set(self, ref, data, merge=False):
                self.ops.append(("set", ref, data, merge))

            def update(self, ref, data):
                self.ops.append(("update", ref, data))

            def delete(self, ref):
                self.ops.append(("delete", ref, None, False))

            def commit(self):
                for kind, ref, data, merge in self.ops:
                    if kind == "set":
                        ref.set(data, merge=merge)
                    elif kind == "update":
                        ref.update(data)
                    elif kind == "delete":
                        ref.delete()
                self.ops.clear()

        return MockBatch()

    def collection(self, name: str):
        class MockCol:
            def __init__(self, coll_name, s):
                self.coll_name = coll_name
                self.s = s

            def document(self, doc_id=None):
                if not doc_id:
                    doc_id = f"auto_{len(self.s) + 1}"
                return MockDocReference(self.coll_name, doc_id, self.s)

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
    # Verify batch read was used
    assert db.get_all_calls >= 1

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


@patch("api.routers.admin._db")
def test_overview_real_ride_activity_and_deltas(mock_db_fn) -> None:
    from datetime import datetime, timezone
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    now_ts = datetime.now(timezone.utc).timestamp()
    db.collection("rides").document("r_today").set({
        "id": "r_today",
        "status": "completed",
        "passenger_id": "p_today",
        "driver_id": "d_today",
        "fare": 120,
        "createdAt": now_ts,
        "completedAt": now_ts,
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    res = admin.get_overview(admin_user=admin_user)
    assert res["ok"] is True
    assert "daily7d" in res["rideActivity"]
    assert "daily30d" in res["rideActivity"]
    assert len(res["rideActivity"]["daily7d"]) == 7
    assert len(res["rideActivity"]["daily30d"]) == 30
    # Ensure vsYesterdayPercent is computed (100.0 when today > 0 and yesterday == 0, not hardcoded 8.2 or 12.4)
    assert res["today"]["vsYesterdayPercent"] == 100.0
    assert res["activeUsers"]["vsYesterdayPercent"] == 100.0


@patch("api.routers.admin._db")
def test_pre_pagination_search_drivers_and_passengers(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    for i in range(5):
        db.collection("users").document(f"drv_{i}").set({
            "name": f"Driver {i}" if i != 4 else "Target Zorro",
            "phone": f"900000000{i}",
            "role": "driver",
            "verificationStatus": "approved",
        })
        db.collection("users").document(f"pax_{i}").set({
            "name": f"Passenger {i}" if i != 4 else "Unique Alice",
            "phone": f"800000000{i}",
            "role": "passenger",
            "accountStatus": "active",
        })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    # Request with limit=2 and q="Zorro": even though Zorro is the 5th doc, pre-pagination search finds it
    drv_res = admin.list_drivers(status=None, availability=None, q="Zorro", limit=2, cursor=None, admin_user=admin_user)
    assert len(drv_res["drivers"]) == 1
    assert drv_res["drivers"][0]["name"] == "Target Zorro"

    pax_res = admin.list_passengers(status="active", q="Alice", limit=2, cursor=None, admin_user=admin_user)
    assert len(pax_res["passengers"]) == 1
    assert pax_res["passengers"][0]["name"] == "Unique Alice"


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_driver_rating_summary_and_passenger_drawer(mock_db_fn, mock_audit) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("users").document("drv_rated").set({
        "name": "Rated Driver",
        "role": "driver",
        "verificationStatus": "approved",
        "drivingLicenseNumber": "DL-TR-998877",
        "licensePhotoUrl": "https://example.com/license.jpg",
    })
    db.collection("rides").document("r_fb_1").set({
        "id": "r_fb_1",
        "driver_id": "drv_rated",
        "passenger_id": "pax_profile_1",
        "status": "completed",
        "fare": 150,
        "feedback": {"submitted": True, "experience": "loved", "reasons": ["polite_driver", "clean_vehicle"]},
    })
    db.collection("rides").document("r_fb_2").set({
        "id": "r_fb_2",
        "driver_id": "drv_rated",
        "passenger_id": "pax_profile_1",
        "status": "completed",
        "fare": 100,
        "feedback": {"submitted": True, "experience": "good", "reasons": ["polite_driver"]},
    })
    db.collection("users").document("pax_profile_1").set({
        "name": "Profile Passenger",
        "phone": "+91 9998887776",
        "role": "passenger",
        "accountStatus": "active",
        "walletBalance": 250,
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    drv_detail = admin.get_driver("drv_rated", admin_user=admin_user)
    assert drv_detail["ok"] is True
    assert drv_detail["ratingSummary"]["totalFeedbackCount"] == 2
    assert drv_detail["ratingSummary"]["averageRating"] == 4.5
    assert drv_detail["driver"]["licensePhotoUrl"] == "https://example.com/license.jpg"

    # Seed walletTransactions with amountPaise + direction and safetyReports with reporter_id
    db.collection("walletTransactions").document("tx_1").set({
        "userId": "pax_profile_1",
        "type": "ADMIN_CREDIT",
        "direction": "credit",
        "amountPaise": 7500,
        "description": "Promo credit",
        "createdAt": "2026-04-01T10:00:00Z",
    })
    db.collection("walletTransactions").document("tx_2").set({
        "userId": "pax_profile_1",
        "type": "RIDE_PAYMENT",
        "direction": "debit",
        "amountPaise": 2500,
        "description": "Ride fare",
        "createdAt": "2026-04-01T11:00:00Z",
    })
    db.collection("sosAlerts").document("sos_1").set({
        "reporter_id": "pax_profile_1",
        "status": "open",
        "createdAt": "2026-04-01T12:00:00Z",
    })

    # Passenger detail + add_note
    pax_detail = admin.get_passenger("pax_profile_1", admin_user=admin_user)
    assert pax_detail["ok"] is True
    assert pax_detail["rideStats"]["completedRides"] == 2
    assert pax_detail["rideStats"]["totalSpent"] == 250.0
    assert pax_detail["wallet"]["balance"] == 250.0
    assert len(pax_detail["wallet"]["transactions"]) == 2
    assert len(pax_detail["wallet"]["recentTransactions"]) == 2
    amounts = {tx["id"]: tx["amount"] for tx in pax_detail["wallet"]["recentTransactions"]}
    assert amounts["tx_1"] == 75.0
    assert amounts["tx_2"] == -25.0
    assert len(pax_detail["safetyEvents"]) == 1

    note_res = admin.update_passenger(
        "pax_profile_1",
        admin.PassengerActionBody(action="add_note", notes="VIP commuter"),
        admin_user=admin_user,
    )
    assert note_res["ok"] is True
    assert len(note_res["passenger"]["adminNotes"]) == 1


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_waiting_pool_manual_assign_remove_and_live_map(mock_db_fn, mock_audit) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("users").document("pax_w1").set({"name": "Wait Pax", "phone": "9111111111", "role": "passenger"})
    db.collection("users").document("drv_w1").set({
        "name": "Avail Driver",
        "phone": "9222222222",
        "role": "driver",
        "verificationStatus": "approved",
        "driverAvailability": "online",
        "vehicleType": "auto",
        "vehicleNumber": "TR01Z9999",
        "currentLocation": {"lat": 23.8315, "lng": 91.2868},
    })
    db.collection("rides").document("ride_w1").set({
        "id": "ride_w1",
        "passenger_id": "pax_w1",
        "status": "searching",
        "pickup_lat": 23.831,
        "pickup_lng": 91.286,
        "drop_lat": 23.840,
        "drop_lng": 91.295,
    })
    db.collection("dispatchWPP").document("pax_w1").set({
        "passenger_id": "pax_w1",
        "ride_id": "ride_w1",
        "state": "WAITING",
        "pickup": {"lat": 23.831, "lng": 91.286, "name": "City Center"},
    })
    db.collection("dispatchDAP").document("drv_w1").set({
        "driver_id": "drv_w1",
        "state": "IDLE",
        "loc": {"lat": 23.8315, "lng": 91.2868},
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Check Live Map before assignment
    map_res = admin.get_live_fleet_map(admin_user=admin_user)
    assert map_res["ok"] is True
    assert len(map_res["waitingPassengers"]) == 1
    assert len(map_res["drivers"]) == 1

    # Assign driver to waiting passenger
    assign_res = admin.assign_waiting_pool_passenger(
        admin.WaitingPoolAssignBody(passenger_id="pax_w1", driver_id="drv_w1", ride_id="ride_w1"),
        admin_user=admin_user,
    )
    assert assign_res["ok"] is True
    assert db.collection("rides").document("ride_w1").get().to_dict()["status"] == "accepted"
    assert not db.collection("dispatchWPP").document("pax_w1").get().exists

    # Test remove waiting passenger on a second passenger
    db.collection("rides").document("ride_w2").set({"id": "ride_w2", "passenger_id": "pax_w2", "status": "searching"})
    db.collection("dispatchWPP").document("pax_w2").set({"passenger_id": "pax_w2", "ride_id": "ride_w2", "state": "WAITING"})
    rem_res = admin.remove_waiting_pool_passenger("pax_w2", admin_user=admin_user)
    assert rem_res["ok"] is True
    assert db.collection("rides").document("ride_w2").get().to_dict()["status"] == "cancelled_by_passenger"


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_analytics_breakdown_and_broadcast_notifications(mock_db_fn, mock_audit) -> None:
    from datetime import datetime, timezone
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    now_ts = datetime.now(timezone.utc).timestamp()
    db.collection("rides").document("r_an_1").set({
        "id": "r_an_1",
        "status": "completed",
        "fare": 120,
        "estimated_distance_km": 5.5,
        "vehicle_type": "auto",
        "rideType": "share",
        "createdAt": now_ts,
        "completedAt": now_ts,
    })
    db.collection("rides").document("r_an_2").set({
        "id": "r_an_2",
        "status": "cancelled_by_passenger",
        "cancellationReason": "Driver took too long",
        "vehicle_type": "bike",
        "rideType": "single",
        "createdAt": now_ts,
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}
    an_res = admin.rides_daily_analytics(days=7, admin_user=admin_user)
    assert an_res["ok"] is True
    assert an_res["summary"]["totalRides"] == 2
    assert an_res["summary"]["completedRides"] == 1
    assert an_res["summary"]["cancelledRides"] == 1
    assert an_res["cancellationBreakdown"]["byPassenger"] == 1
    assert an_res["vehicleSplit"]["byVehicle"]["auto"] == 1
    assert an_res["vehicleSplit"]["byVehicle"]["bike"] == 1
    assert an_res["vehicleSplit"]["byRideType"]["share"] == 1

    # Broadcast notifications (including FCM tokens + exception resilience + segments + userNotifications fan-out)
    db.collection("users").document("u_b1").set({
        "name": "User 1",
        "role": "passenger",
        "accountStatus": "active",
        "fcmToken": "tok_pax_1",
    })
    db.collection("users").document("drv_pending_1").set({
        "name": "Pending Driver",
        "role": "driver",
        "verificationStatus": "pending_review",
        "fcmToken": "tok_drv_pending",
    })
    db.collection("users").document("drv_overdue_1").set({
        "name": "Overdue Driver",
        "role": "driver",
        "verificationStatus": "approved",
        "overdueFee": True,
        "fcmToken": "tok_drv_overdue",
    })

    with patch("api.core.notifications.dispatch_push_notification", side_effect=RuntimeError("FCM simulated failure")):
        b_res = admin.send_admin_broadcast(
            admin.AdminBroadcastBody(target="all_passengers", title="Service Update", body="New autos added!"),
            admin_user=admin_user,
        )
    assert b_res["ok"] is True
    assert b_res["broadcast"]["recipientCount"] == 1
    assert b_res["broadcast"]["tokenCount"] == 1

    # Verify pending_drivers and overdue_drivers segments
    pend_res = admin.send_admin_broadcast(
        admin.AdminBroadcastBody(target="pending_drivers", title="Complete KYC", body="Upload your RC photo."),
        admin_user=admin_user,
    )
    assert pend_res["broadcast"]["recipientCount"] == 1

    over_res = admin.send_admin_broadcast(
        admin.AdminBroadcastBody(target="overdue_drivers", title="Fee Reminder", body="Please clear your daily fee."),
        admin_user=admin_user,
    )
    assert over_res["broadcast"]["recipientCount"] == 1

    # Verify userNotifications fan-out
    user_notifs = list(db.collection("userNotifications").stream())
    assert len(user_notifs) == 3

    hist_res = admin.list_broadcast_notifications(limit=10, admin_user=admin_user)
    assert hist_res["ok"] is True
    assert len(hist_res["broadcasts"]) == 3


