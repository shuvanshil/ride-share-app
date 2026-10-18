from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from api.core.auth import current_user
from api.core.share_config import (
    SHARE_BASE_METERS,
    SHARE_FARE_BASE,
    SHARE_MAX_DETOUR_MIN,
    SHARE_MAX_SEATS,
    SHARE_PICKUP_WAIT_S,
    SHARE_STEP_FARE,
    SHARE_STEP_METERS,
    calculate_share_fare,
)
from api.index import app
from api.routers.share import finalize_trip_if_done


def test_fare_formula_exact_boundaries() -> None:
    assert calculate_share_fare(100) == 10
    assert calculate_share_fare(1000) == 10
    assert calculate_share_fare(1600) == 20
    assert calculate_share_fare(2500) == 35
    assert calculate_share_fare(3100) == 45


def test_parent_child_lifecycle_and_baseline_eta_preservation() -> None:
    client = TestClient(app)
    mock_driver = {
        "uid": "driver_lifecycle_1",
        "role": "driver",
        "status": "approved",
        "is_verified": True,
        "vehicle_type": "auto",
        "name": "Driver Lifecycle",
    }
    mock_db = MagicMock()

    now_dt = datetime.now(timezone.utc)
    baseline_iso = (now_dt + timedelta(minutes=15)).isoformat()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    ride_data = {
        "id": "ride_lc_1",
        "rideType": "share",
        "vehicle_type": "auto",
        "passenger_id": "pass_lc_1",
        "passenger_name": "Passenger One",
        "status": "pending",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "drop_lat": 23.85,
        "drop_lng": 91.30,
        "pickup_name": "Agartala Station",
        "drop_name": "City Center",
        "fare": 20,
        "duration_minutes": 15,
        "eligible_driver_ids": ["driver_lifecycle_1"],
        "rejected_driver_ids": [],
    }
    mock_ride_doc.to_dict.return_value = ride_data

    mock_parent_ref = MagicMock()
    mock_parent_ref.id = "parent_trip_lc_1"

    def col_side_effect(name):
        col = MagicMock()
        if name == "rides":
            col.document.return_value.get.return_value = mock_ride_doc
            col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        elif name == "users":
            u_doc = MagicMock()
            u_doc.exists = True
            u_doc.to_dict.return_value = mock_driver
            col.document.return_value.get.return_value = u_doc
        elif name == "shareTrips":
            col.document.return_value = mock_parent_ref
        return col

    mock_db.collection.side_effect = col_side_effect
    mock_db.transaction.return_value = MagicMock()

    app.dependency_overrides[current_user] = lambda: mock_driver
    try:
        with (
            patch("api.routers.rides.get_admin_app"),
            patch("api.routers.rides.fb_firestore.client", return_value=mock_db),
            patch("api.routers.rides._driver_type", return_value="auto"),
        ):
            res_accept = client.post("/api/rides/ride_lc_1/accept", headers={"Authorization": "Bearer test"})
            assert res_accept.status_code == 200
            data = res_accept.json()
            assert data["ok"] is True
            assert data["ride"]["parentTripId"] == "parent_trip_lc_1"
            assert data["ride"]["baselineEtaIso"] is not None
            assert data["ride"]["sharedInfo"]["parentTripId"] == "parent_trip_lc_1"
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_concurrent_accepts_at_seat_limit() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_full", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "status": "pending",
        "passenger_id": "p_full",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "drop_lat": 23.88,
        "drop_lng": 91.30,
        "seatsBooked": 1,
    }

    mock_parent_doc = MagicMock()
    mock_parent_doc.id = "trip_full"
    mock_parent_doc.to_dict.return_value = {
        "tripId": "trip_full",
        "driverId": "driver_full",
        "status": "active",
        "seatsUsed": 3,
        "childRideIds": ["r1", "r2", "r3"],
    }

    mock_db.collection.return_value.document.return_value.get.return_value = mock_ride_doc
    mock_db.collection.return_value.where.return_value.where.return_value.limit.return_value.stream.return_value = [
        mock_parent_doc
    ]

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res = client.post("/api/share/offers/ride_extra/accept", headers={"Authorization": "Bearer test"})
            assert res.status_code == 400
            err_msg = res.json().get("error") or res.json().get("detail") or ""
            assert "seats" in err_msg.lower() or "capacity" in err_msg.lower() or "full" in err_msg.lower()
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_idempotent_accept_handling() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_idem", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "status": "accepted",
        "passenger_id": "p_idem",
        "driver_id": "driver_idem",
        "parentTripId": "trip_idem",
        "seatsBooked": 1,
    }

    mock_parent_doc = MagicMock()
    mock_parent_doc.id = "trip_idem"
    mock_parent_doc.to_dict.return_value = {
        "tripId": "trip_idem",
        "driverId": "driver_idem",
        "status": "active",
        "seatsUsed": 1,
        "childRideIds": ["ride_idem"],
    }

    mock_db.collection.return_value.document.return_value.get.return_value = mock_ride_doc
    mock_db.collection.return_value.where.return_value.where.return_value.limit.return_value.stream.return_value = [
        mock_parent_doc
    ]

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res = client.post("/api/share/offers/ride_idem/accept", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200
            assert res.json()["ok"] is True
            assert res.json().get("alreadyAccepted") is True
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_remote_drop_frees_seat() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_rem", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    mock_trip_doc = MagicMock()
    mock_trip_doc.exists = True
    mock_trip_doc.to_dict.return_value = {
        "tripId": "trip_rem",
        "driverId": "driver_rem",
        "status": "active",
        "seatsUsed": 2,
        "remoteOnBoard": 2,
        "childRideIds": [],
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_trip_doc

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res = client.post("/api/share/trips/trip_rem/remote/drop", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200
            assert res.json()["ok"] is True
            assert res.json()["seatsUsed"] == 1
            assert res.json()["remoteOnBoard"] == 1
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_fallback_to_normal_dispatch_after_priority_window() -> None:
    client = TestClient(app)
    mock_user = {"uid": "pass_fb_1", "role": "passenger"}
    mock_db = MagicMock()

    mock_user_snap = MagicMock()
    mock_user_snap.exists = True
    mock_user_snap.to_dict.return_value = {"role": "passenger"}

    mock_ride_snap = MagicMock()
    mock_ride_snap.exists = True
    mock_ride_snap.to_dict.return_value = {
        "passenger_id": "pass_fb_1",
        "status": "pending",
        "driver_id": None,
        "rideType": "share",
        "vehicle_type": "auto",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "dispatch_mode": "priority_share",
        "current_offer_driver_id": "drv_p1",
        "eligible_driver_ids": ["drv_p1"],
        "notified_driver_ids": ["drv_p1"],
        "rejected_driver_ids": [],
    }

    mock_user_ref = MagicMock()
    mock_user_ref.get.return_value = mock_user_snap

    mock_ride_ref = MagicMock()
    mock_ride_ref.get.return_value = mock_ride_snap

    def col_side_effect(cname):
        col = MagicMock()
        if cname == "users":
            col.document.return_value = mock_user_ref
        elif cname == "rides":
            col.document.return_value = mock_ride_ref
        return col

    mock_db.collection.side_effect = col_side_effect

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.rides.get_admin_app"),
            patch("api.routers.rides.fb_firestore.client", return_value=mock_db),
            patch("api.routers.rides._available_drivers", return_value=[{"uid": "drv_auto_1", "distance": 1.2}]),
        ):
            res = client.post("/api/rides/ride_fb_1/dispatch", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200
            assert res.json()["ok"] is True
            update_call = mock_ride_ref.update.call_args[0][0]
            assert update_call.get("dispatch_mode") == "auto_share"
            assert update_call.get("current_offer_driver_id") is None
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_stale_trip_cleanup_on_driver_load() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_stale", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    mock_trip_ref = MagicMock()
    mock_trip_snap = MagicMock()
    mock_trip_snap.exists = True
    trip_data = {
        "tripId": "trip_stale_1",
        "driverId": "driver_stale",
        "status": "active",
        "remoteOnBoard": 0,
        "childRideIds": ["c_stale_1"],
    }
    mock_trip_snap.to_dict.return_value = trip_data
    mock_trip_ref.get.return_value = mock_trip_snap

    mock_child_ref = MagicMock()
    mock_child_snap = MagicMock()
    mock_child_snap.exists = True
    mock_child_snap.to_dict.return_value = {"id": "c_stale_1", "status": "completed"}
    mock_child_ref.get.return_value = mock_child_snap

    def doc_lookup(doc_id):
        if doc_id == "trip_stale_1":
            return mock_trip_ref
        elif doc_id == "c_stale_1":
            return mock_child_ref
        return MagicMock()

    mock_db.collection.return_value.document.side_effect = doc_lookup

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res = client.get("/api/share/trips/trip_stale_1", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200
            assert res.json()["ok"] is True
            mock_trip_ref.update.assert_called_once()
            call_payload = mock_trip_ref.update.call_args[0][0]
            assert call_payload["status"] == "completed"
            assert call_payload["seatsUsed"] == 0
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_server_no_show_threshold_enforcement() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_ns", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    now_dt = datetime.now(timezone.utc)
    recent_arrived = (now_dt - timedelta(seconds=60)).isoformat()
    past_arrived = (now_dt - timedelta(seconds=130)).isoformat()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "id": "c_ns",
        "driver_id": "driver_ns",
        "status": "arrived",
        "arrivedAt": recent_arrived,
        "parentTripId": "trip_ns",
    }

    mock_trip_doc = MagicMock()
    mock_trip_doc.exists = True
    mock_trip_doc.to_dict.return_value = {
        "tripId": "trip_ns",
        "driverId": "driver_ns",
        "status": "active",
        "childRideIds": ["c_ns"],
        "remoteOnBoard": 0,
        "seatsUsed": 1,
        "stopOrder": [],
    }

    def doc_side_effect(doc_id):
        m = MagicMock()
        if doc_id == "trip_ns":
            m.get.return_value = mock_trip_doc
        else:
            m.get.return_value = mock_ride_doc
        return m

    mock_db.collection.return_value.document.side_effect = doc_side_effect

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res_reject = client.post(
                "/api/share/rides/c_ns/skip",
                headers={"Authorization": "Bearer test"},
            )
            assert res_reject.status_code == 400
            err_msg = res_reject.json().get("error") or res_reject.json().get("detail") or ""
            assert "120" in err_msg

            mock_ride_doc.to_dict.return_value["arrivedAt"] = past_arrived
            res_accept = client.post(
                "/api/share/rides/c_ns/skip",
                headers={"Authorization": "Bearer test"},
            )
            assert res_accept.status_code == 200
            assert res_accept.json()["ok"] is True
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_driver_availability_gating_during_share_trip_and_remote_occupancy() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_gate", "role": "driver", "status": "approved"}
    mock_db = MagicMock()

    mock_driver_doc = MagicMock()
    mock_driver_doc.exists = True
    mock_driver_doc.to_dict.return_value = {
        "uid": "driver_gate",
        "role": "driver",
        "status": "approved",
        "driverAvailability": "searching",
    }

    mock_share_snap = MagicMock()
    mock_share_snap.to_dict.return_value = {
        "tripId": "trip_remote_only_1",
        "driverId": "driver_gate",
        "status": "active",
        "childRideIds": [],
        "remoteOnBoard": 1,
        "seatsUsed": 1,
    }

    mock_db.collection.return_value.document.return_value.get.return_value = mock_driver_doc
    mock_db.collection.return_value.where.return_value.where.return_value.limit.return_value.stream.return_value = [
        mock_share_snap
    ]
    mock_db.collection.return_value.where.return_value.stream.return_value = [mock_share_snap]

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.rides.get_admin_app"),
            patch("api.routers.rides.fb_firestore.client", return_value=mock_db),
        ):
            res = client.post(
                "/api/rides/driver-availability",
                json={"status": "offline"},
                headers={"Authorization": "Bearer test"},
            )
            assert res.status_code == 400
            err_msg = res.json().get("error") or res.json().get("detail") or ""
            assert "shared trip is active" in err_msg.lower() or "active share trip" in err_msg.lower()
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_zero_copassenger_data_leakage() -> None:
    client = TestClient(app)
    mock_user = {"uid": "pass_1", "role": "passenger"}
    mock_db = MagicMock()

    mock_trip_doc = MagicMock()
    mock_trip_doc.exists = True
    mock_trip_doc.to_dict.return_value = {
        "tripId": "trip_sec",
        "driverId": "driver_sec",
        "status": "active",
        "seatsUsed": 2,
        "childRideIds": ["r_pass_1", "r_pass_2"],
        "remoteOnBoard": 0,
        "stops": [],
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_trip_doc

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            res = client.get("/api/share/trips/trip_sec", headers={"Authorization": "Bearer test"})
            assert res.status_code == 200
            data = res.json()["trip"]
            for field in ["passenger_phone", "passenger_name", "passenger_email", "coPassengers"]:
                assert field not in data
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_finalize_trip_if_done_flow() -> None:
    mock_db = MagicMock()
    mock_trip_ref = MagicMock()
    mock_trip_snap = MagicMock()
    mock_trip_snap.exists = True
    mock_trip_snap.to_dict.return_value = {
        "tripId": "trip_final",
        "driverId": "driver_final",
        "status": "active",
        "remoteOnBoard": 0,
        "childRideIds": ["c1", "c2"],
    }
    mock_trip_ref.get.return_value = mock_trip_snap

    mock_c1_ref = MagicMock()
    mock_c1_snap = MagicMock()
    mock_c1_snap.exists = True
    mock_c1_snap.to_dict.return_value = {"id": "c1", "status": "completed"}
    mock_c1_ref.get.return_value = mock_c1_snap

    mock_c2_ref = MagicMock()
    mock_c2_snap = MagicMock()
    mock_c2_snap.exists = True
    mock_c2_snap.to_dict.return_value = {"id": "c2", "status": "cancelled"}
    mock_c2_ref.get.return_value = mock_c2_snap

    def doc_lookup(doc_id):
        if doc_id == "trip_final":
            return mock_trip_ref
        elif doc_id == "c1":
            return mock_c1_ref
        elif doc_id == "c2":
            return mock_c2_ref
        return MagicMock()

    mock_db.collection.return_value.document.side_effect = doc_lookup

    is_finalized = finalize_trip_if_done("trip_final", mock_db)
    assert is_finalized is True
    mock_trip_ref.update.assert_called_once()
    call_args = mock_trip_ref.update.call_args[0][0]
    assert call_args["status"] == "completed"
    assert call_args["seatsUsed"] == 0
    assert "endedAt" in call_args
