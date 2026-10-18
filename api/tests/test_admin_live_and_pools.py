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

    # Verify unused /live-map endpoint is removed and waiting pools endpoint works
    assert not hasattr(admin, "get_live_fleet_map")
    pools_res = admin.list_waiting_pools(admin_user=admin_user)
    assert pools_res["ok"] is True
    assert len(pools_res["passengers"]) == 1
    assert len(pools_res["drivers"]) == 1

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


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_safety_sos_and_report_enrichment_and_deletion(mock_db_fn, mock_audit) -> None:
    from api.core.errors import ApiError
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("users").document("pax_sos_1").set({
        "name": "Rina Debbarma",
        "phone": "+91 94360 11111",
        "email": "rina@example.com",
        "role": "passenger",
    })
    db.collection("users").document("drv_sos_1").set({
        "name": "Bikramjit Saha",
        "phone": "+91 94360 22222",
        "role": "driver",
        "vehicleType": "auto",
        "vehicleNumber": "TR01AA7788",
        "vehicleModel": "Bajaj RE",
    })
    db.collection("emergencyContacts").document("pax_sos_1").set({
        "contacts": [{"name": "Suman Debbarma", "phone": "+91 94360 99999", "relation": "Brother"}],
    })
    db.collection("rides").document("ride_sos_1").set({
        "id": "ride_sos_1",
        "passenger_id": "pax_sos_1",
        "driver_id": "drv_sos_1",
        "status": "started",
        "pin_verified": True,
        "fare": 85,
        "pickup_name": "Ujjayanta Palace",
        "drop_name": "GB Hospital",
        "pickup_lat": 23.8330,
        "pickup_lng": 91.2820,
        "drop_lat": 23.8570,
        "drop_lng": 91.2910,
        "driver_lat": 23.8410,
        "driver_lng": 91.2850,
    })

    # Seed an open SOS alert with minimal fields (to verify enrichment from ride + users + emergencyContacts)
    db.collection("sosAlerts").document("sos_open_1").set({
        "ride_id": "ride_sos_1",
        "reporter_id": "pax_sos_1",
        "status": "open",
        "createdAt": 1700005000.0,
    })
    # Seed a resolved SOS alert
    db.collection("sosAlerts").document("sos_resolved_1").set({
        "ride_id": "ride_sos_1",
        "reporter_id": "pax_sos_1",
        "status": "resolved",
        "createdAt": 1700004000.0,
    })

    # Seed an open safety report and a resolved safety report
    db.collection("safetyReports").document("rep_open_1").set({
        "ride_id": "ride_sos_1",
        "reporter_id": "pax_sos_1",
        "category": "rash_driving",
        "details": "Driver was speeding near palace gate.",
        "status": "open",
        "createdAt": 1700005500.0,
    })
    db.collection("safetyReports").document("rep_resolved_1").set({
        "ride_id": "ride_sos_1",
        "reporter_id": "pax_sos_1",
        "category": "route_deviation",
        "details": "Took longer road.",
        "status": "resolved",
        "createdAt": 1700003500.0,
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Verify SOS detail enrichment
    sos_detail = admin.get_sos_alert("sos_open_1", admin_user=admin_user)
    assert sos_detail["ok"] is True
    alert = sos_detail["alert"]
    assert alert["passenger_name"] == "Rina Debbarma"
    assert alert["driver_name"] == "Bikramjit Saha"
    assert alert["vehicle_number"] == "TR01AA7788"
    assert alert["pickup_name"] == "Ujjayanta Palace"
    assert alert["drop_name"] == "GB Hospital"
    assert len(alert["emergency_contacts"]) == 1
    assert alert["location_snapshot"]["pickup_lat"] == 23.8330
    assert alert["location_snapshot"]["drop_lat"] == 23.8570

    # Verify Safety Report detail enrichment
    rep_detail = admin.get_safety_report("rep_open_1", admin_user=admin_user)
    assert rep_detail["ok"] is True
    report = rep_detail["report"]
    assert report["reporter_name"] == "Rina Debbarma"
    assert report["driver_name"] == "Bikramjit Saha"
    assert report["vehicle_number"] == "TR01AA7788"

    # Attempt to delete an OPEN SOS alert -> must fail with 400
    with pytest.raises(ApiError) as exc_info:
        admin.delete_sos_alert("sos_open_1", admin_user=admin_user)
    assert exc_info.value.status_code == 400

    # Attempt to delete an OPEN safety report -> must fail with 400
    with pytest.raises(ApiError) as exc_info:
        admin.delete_safety_report("rep_open_1", admin_user=admin_user)
    assert exc_info.value.status_code == 400

    # Bulk delete mixing open and resolved -> deletes only resolved, skips open
    bulk_sos = admin.bulk_delete_sos_alerts(
        admin.BulkSafetyDeleteBody(ids=["sos_open_1", "sos_resolved_1"]),
        admin_user=admin_user,
    )
    assert bulk_sos["deletedCount"] == 1
    assert "sos_open_1" in bulk_sos["skippedOpenIds"]
    assert db.collection("sosAlerts").document("sos_open_1").get().exists
    assert not db.collection("sosAlerts").document("sos_resolved_1").get().exists

    # Individual delete of resolved safety report succeeds
    del_rep = admin.delete_safety_report("rep_resolved_1", admin_user=admin_user)
    assert del_rep["ok"] is True
    assert not db.collection("safetyReports").document("rep_resolved_1").get().exists

    # End-to-end test of rides.trigger_ride_sos and rides.submit_safety_report snapshot capture
    from api.routers import rides as rides_router
    with patch("api.routers.rides.fb_firestore.client", return_value=db), patch("api.routers.rides.get_admin_app"):
        sos_created = rides_router.trigger_ride_sos(
            "ride_sos_1",
            rides_router.SosBody(lat=23.8425, lng=91.2865, note="Need immediate help"),
            user={"uid": "pax_sos_1"},
        )
        assert sos_created["ok"] is True
        created_sos_detail = admin.get_sos_alert(sos_created["alertId"], admin_user=admin_user)
        assert created_sos_detail["alert"]["location_snapshot"]["incident_lat"] == 23.8425
        assert created_sos_detail["alert"]["location_snapshot"]["captured_at"]

        rep_created = rides_router.submit_safety_report(
            rides_router.SafetyReportBody(rideId="ride_sos_1", category="unsafe_driving", description="Ran a red light"),
            user={"uid": "pax_sos_1"},
        )
        assert rep_created["ok"] is True
        created_rep_detail = admin.get_safety_report(rep_created["reportId"], admin_user=admin_user)
        assert created_rep_detail["report"]["location_snapshot"]["captured_at"]
        assert created_rep_detail["report"]["driver_name"] == "Bikramjit Saha"


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_broadcast_deletion_ride_history_backfill_and_activity_feed(mock_db_fn, mock_audit) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # 1. Broadcast individual and bulk deletion
    db.collection("adminBroadcasts").document("bc_1").set({"title": "T1", "body": "B1", "createdAt": 1700001000.0})
    db.collection("adminBroadcasts").document("bc_2").set({"title": "T2", "body": "B2", "createdAt": 1700002000.0})
    db.collection("adminBroadcasts").document("bc_3").set({"title": "T3", "body": "B3", "createdAt": 1700003000.0})

    del_one = admin.delete_notification_broadcast("bc_1", admin_user=admin_user)
    assert del_one["ok"] is True
    assert not db.collection("adminBroadcasts").document("bc_1").get().exists

    del_bulk = admin.bulk_delete_notification_broadcasts(
        admin.BulkBroadcastDeleteBody(ids=["bc_2", "bc_3"]),
        admin_user=admin_user,
    )
    assert del_bulk["deletedCount"] == 2
    assert not db.collection("adminBroadcasts").document("bc_2").get().exists

    # 2. Ride history backfill (resolving passenger name & shareTrip driver) + 10-ride limit on drawers
    db.collection("users").document("pax_hist_1").set({
        "name": "Kabir Deb",
        "phone": "+91 98620 12345",
        "role": "passenger",
    })
    db.collection("users").document("drv_hist_1").set({
        "name": "Manik Sarkar",
        "phone": "+91 98620 54321",
        "role": "driver",
        "vehicleType": "auto",
        "vehicleNumber": "TR01X5555",
    })
    db.collection("shareTrips").document("st_hist_1").set({
        "id": "st_hist_1",
        "driverId": "drv_hist_1",
        "driverName": "Manik Sarkar",
    })

    # Create 14 rides for pax_hist_1 and drv_hist_1
    for i in range(14):
        db.collection("rides").document(f"ride_hist_{i}").set({
            "id": f"ride_hist_{i}",
            "passenger_id": "pax_hist_1",
            "parentTripId": "st_hist_1" if i == 0 else None,
            "driver_id": None if i == 0 else "drv_hist_1",
            "status": "completed",
            "pickup_name": "Stop A",
            "drop_name": "Stop B",
            "fare": 50 + i,
            "createdAt": 1700010000.0 + i * 60,
        })

    hist = admin.list_ride_history(
        status="all",
        vehicleType=None,
        rideType=None,
        hasFeedback=None,
        dateFrom=None,
        dateTo=None,
        q=None,
        limit=20,
        cursor=None,
        admin_user=admin_user,
    )
    assert hist["ok"] is True
    share_child = next(r for r in hist["rides"] if r["id"] == "ride_hist_0")
    assert share_child["passenger_name"] == "Kabir Deb"
    assert share_child["driver_id"] == "drv_hist_1"
    assert share_child["driver_name"] == "Manik Sarkar"

    # Verify 10-ride limit on driver and passenger drawers
    drv_drawer = admin.get_driver("drv_hist_1", admin_user=admin_user)
    assert len(drv_drawer["recentRides"]) == 10
    pax_drawer = admin.get_passenger("pax_hist_1", admin_user=admin_user)
    assert len(pax_drawer["recentRides"]) == 10

    # 3. Verify expanded activity feed chronological order & categories
    db.collection("coupons").document("WELCOME50").set({
        "code": "WELCOME50",
        "amount": 50,
        "createdAt": 1700020000.0,
    })
    db.collection("driverPayments").document("pay_1").set({
        "driverId": "drv_hist_1",
        "driverName": "Manik Sarkar",
        "amount": 300,
        "status": "verified",
        "createdAt": 1700030000.0,
    })
    feed_res = admin.get_activity_feed(limit=25, category=None, admin_user=admin_user)
    assert feed_res["ok"] is True
    items = feed_res["activities"]
    assert len(items) >= 3
    # Verify strictly non-increasing timestampMs order
    timestamps = [it["timestampMs"] for it in items]
    assert timestamps == sorted(timestamps, reverse=True)
    categories = {it["category"] for it in items}
    assert "ride" in categories
    assert "coupon" in categories
    assert "payment" in categories


@patch("api.routers.admin._db")
def test_backfill_driver_and_passenger_names_rejects_raw_uids(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("users").document("pax_uid_1").set({
        "name": "Ananya Roy",
        "phone": "9888877777",
        "role": "passenger",
    })
    db.collection("users").document("drv_uid_1").set({
        "name": "Bikramjit Das",
        "phone": "9777766666",
        "vehicleType": "auto",
        "vehicleNumber": "TR01AB1234",
        "role": "driver",
    })

    rides = [
        {
            "id": "r_uid_as_name",
            "passenger_id": "pax_uid_1",
            "passenger_name": "pax_uid_1",  # Raw UID stored as name
            "assignedDriverId": "drv_uid_1",
            "driver_name": "drv_uid_1",     # Raw UID stored as name
        },
        {
            "id": "r_missing_user_doc",
            "passenger_id": "pax_missing_99",
            "passenger_name": "pax_missing_99",
            "driver": {"id": "drv_missing_99", "name": "drv_missing_99"},
        },
    ]

    enriched = admin._backfill_driver_names(rides)
    assert enriched[0]["passenger_name"] == "Ananya Roy"
    assert enriched[0]["driver_name"] == "Bikramjit Das"
    assert enriched[0]["driver_assignment_status"] == "assigned"

    # When user doc doesn't exist and stored name was just the raw UID, fallback must be used
    assert enriched[1]["passenger_name"] == "Passenger details unavailable"
    assert enriched[1]["driver_name"] == "Driver details unavailable"
    assert enriched[1]["driver_assignment_status"] == "unavailable"

    # Also verify _build_live_hierarchy preserves rawStatus, pin_verified, isShareTripDoc and strips raw UIDs
    db.collection("shareTrips").document("st_uid_test").set({
        "id": "st_uid_test",
        "status": "to_pickup",
        "driverId": "drv_uid_1",
        "driverName": "drv_uid_1",  # Raw UID stored on shareTrip
    })
    hierarchy, _ = admin._build_live_hierarchy(db, [
        {
            "id": "r_pre_pickup_1",
            "status": "accepted",
            "rideType": "single",
            "passenger_id": "pax_uid_1",
            "passenger_name": "pax_uid_1",
            "driver_id": "drv_uid_1",
            "driver_name": "drv_uid_1",
            "createdAt": 1700000000.0,
        },
        {
            "id": "r_share_child_pre",
            "parentTripId": "st_uid_test",
            "status": "accepted",
            "rideType": "share",
            "passenger_id": "pax_uid_1",
            "passenger_name": "pax_uid_1",
            "driver_id": "drv_uid_1",
            "driver_name": "drv_uid_1",
            "createdAt": 1700000000.0,
        },
    ])
    single_h = next(h for h in hierarchy if h["id"] == "r_pre_pickup_1")
    assert single_h["isShareTripDoc"] is False
    assert single_h["rawStatus"] == "accepted"
    assert single_h["pin_verified"] is False
    assert single_h["driver"]["name"] == "Bikramjit Das"
    assert single_h["childRides"][0]["passenger"]["name"] == "Ananya Roy"

    share_h = next(h for h in hierarchy if h["id"] == "st_uid_test")
    assert share_h["isShareTripDoc"] is True
    assert share_h["rawStatus"] == "to_pickup"
    assert share_h["pin_verified"] is False
    assert share_h["driver"]["name"] == "Bikramjit Das"

    # Also verify _enrich_safety_records strips raw UIDs from passenger_name, driver_name, and reporter_name
    safety_enriched = admin._enrich_safety_records(db, [{
        "id": "sos_uid_1",
        "reporter_id": "pax_uid_1",
        "reporter_name": "pax_uid_1",
        "reporter_role": "passenger",
        "passenger_id": "pax_uid_1",
        "passenger_name": "pax_uid_1",
        "driver_id": "drv_uid_1",
        "driver_name": "drv_uid_1",
        "status": "open",
    }], kind="sos")
    assert safety_enriched[0]["passenger_name"] == "Ananya Roy"
    assert safety_enriched[0]["driver_name"] == "Bikramjit Das"
    assert safety_enriched[0]["reporter_name"] == "Ananya Roy"


@patch("api.routers.admin.write_audit_log")
@patch("api.routers.admin._db")
def test_failure_report_delete_requires_resolved_status(mock_db_fn, mock_audit) -> None:
    import pytest
    ApiError = admin.ApiError

    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("failureReports").document("fail_open_1").set({
        "failureId": "fail_open_1",
        "status": "open",
        "severity": "HIGH",
        "service": "dispatch",
    })
    db.collection("failureReports").document("fail_resolved_1").set({
        "failureId": "fail_resolved_1",
        "status": "resolved",
        "severity": "MEDIUM",
        "service": "rides",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Single delete on open report must fail with 400
    with pytest.raises(ApiError) as exc_info:
        admin.delete_failure_report("fail_open_1", admin_user=admin_user)
    assert exc_info.value.status_code == 400
    assert db.collection("failureReports").document("fail_open_1").get().exists

    # Bulk delete with only open reports must fail with 400
    with pytest.raises(ApiError) as bulk_exc:
        admin.bulk_failure_action(
            admin.BulkFailureActionBody(action="delete", failureIds=["fail_open_1"]),
            admin_user=admin_user,
        )
    assert bulk_exc.value.status_code == 400
    assert db.collection("failureReports").document("fail_open_1").get().exists

    # Bulk delete with mixed open + resolved deletes only resolved and skips open
    mixed_res = admin.bulk_failure_action(
        admin.BulkFailureActionBody(action="delete", failureIds=["fail_open_1", "fail_resolved_1"]),
        admin_user=admin_user,
    )
    assert mixed_res["ok"] is True
    assert mixed_res["count"] == 1
    assert mixed_res["skippedOpenIds"] == ["fail_open_1"]
    assert db.collection("failureReports").document("fail_open_1").get().exists
    assert not db.collection("failureReports").document("fail_resolved_1").get().exists

    # After resolving fail_open_1, single delete succeeds
    admin.update_failure_report(
        "fail_open_1",
        admin.FailureActionBody(action="resolve"),
        admin_user=admin_user,
    )
    del_res = admin.delete_failure_report("fail_open_1", admin_user=admin_user)
    assert del_res["ok"] is True
    assert not db.collection("failureReports").document("fail_open_1").get().exists
