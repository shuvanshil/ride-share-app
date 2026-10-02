from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from api.core.share_config import (
    SHARE_DETOUR_ROAD_FACTOR,
    SHARE_FALLBACK_SPEED_KMH,
    SHARE_MAX_DETOUR_MIN,
    SHARE_MAX_SEATS,
    SHARE_ZONE_RADIUS_M,
)
from api.core.share_routing import (
    compute_leg_travel_time,
    evaluate_route,
    find_optimal_share_route,
    generate_valid_stop_permutations,
    is_valid_permutation,
    recompute_shared_info_and_stops,
)
from api.core.auth import current_user
from api.index import app


def test_compute_leg_travel_time() -> None:
    origin = (23.8315, 91.2868)
    dest = (23.8500, 91.3000)
    dist, dur = compute_leg_travel_time(origin, dest)
    assert dist > 0
    expected_dur = (dist / SHARE_FALLBACK_SPEED_KMH) * 60.0
    assert abs(dur - expected_dur) < 1e-4


def test_is_valid_permutation_rules() -> None:
    valid_stops = [
        {"rideId": "r1", "kind": "pickup"},
        {"rideId": "r2", "kind": "pickup"},
        {"rideId": "r1", "kind": "drop"},
        {"rideId": "r2", "kind": "drop"},
    ]
    assert is_valid_permutation(valid_stops) is True

    invalid_stops = [
        {"rideId": "r1", "kind": "drop"},
        {"rideId": "r1", "kind": "pickup"},
    ]
    assert is_valid_permutation(invalid_stops) is False

    onboard_drop_only = [
        {"rideId": "r_onboard", "kind": "drop"},
        {"rideId": "r_new", "kind": "pickup"},
        {"rideId": "r_new", "kind": "drop"},
    ]
    assert is_valid_permutation(onboard_drop_only) is True


def test_generate_valid_stop_permutations() -> None:
    stops = [
        {"rideId": "r1", "kind": "pickup"},
        {"rideId": "r1", "kind": "drop"},
        {"rideId": "r2", "kind": "drop"},
    ]
    perms = generate_valid_stop_permutations(stops)
    assert len(perms) == 3
    for p in perms:
        r1_pickup_idx = next(i for i, s in enumerate(p) if s["rideId"] == "r1" and s["kind"] == "pickup")
        r1_drop_idx = next(i for i, s in enumerate(p) if s["rideId"] == "r1" and s["kind"] == "drop")
        assert r1_pickup_idx < r1_drop_idx


def test_evaluate_route_and_detour_cap() -> None:
    driver_pos = (23.8000, 91.2000)
    now = datetime(2026, 10, 2, 12, 0, 0, tzinfo=timezone.utc)
    baseline_eta = (now + timedelta(minutes=10)).isoformat()

    stops_within_cap = [
        {"rideId": "r1", "kind": "drop", "lat": 23.8050, "lng": 91.2050},
    ]
    res = evaluate_route(driver_pos, stops_within_cap, {"r1": baseline_eta}, start_time=now)
    assert res["valid"] is True
    assert res["max_delay_min"] <= SHARE_MAX_DETOUR_MIN

    stops_exceeding_cap = [
        {"rideId": "r2", "kind": "pickup", "lat": 23.9500, "lng": 91.3500},
        {"rideId": "r2", "kind": "drop", "lat": 24.1000, "lng": 91.5000},
        {"rideId": "r1", "kind": "drop", "lat": 23.8050, "lng": 91.2050},
    ]
    tight_baseline = (now + timedelta(minutes=2)).isoformat()
    res_exceeded = evaluate_route(driver_pos, stops_exceeding_cap, {"r1": tight_baseline}, start_time=now)
    assert res_exceeded["valid"] is False
    assert res_exceeded["max_delay_min"] > SHARE_MAX_DETOUR_MIN


def test_find_optimal_share_route_selection() -> None:
    driver_pos = (23.8000, 91.2000)
    now = datetime(2026, 10, 2, 12, 0, 0, tzinfo=timezone.utc)
    pending_stops = [
        {"rideId": "r1", "kind": "drop", "lat": 23.8200, "lng": 91.2200, "status": "pending"},
    ]
    cand_pickup = {"rideId": "r2", "kind": "pickup", "lat": 23.8100, "lng": 91.2100, "status": "pending"}
    cand_drop = {"rideId": "r2", "kind": "drop", "lat": 23.8300, "lng": 91.2300, "status": "pending"}

    baseline_etas = {
        "r1": (now + timedelta(minutes=15)).isoformat(),
    }

    opt = find_optimal_share_route(
        driver_pos, pending_stops, baseline_etas, candidate_stops=[cand_pickup, cand_drop], start_time=now
    )
    assert opt is not None
    assert opt["valid"] is True
    assert len(opt["stops"]) == 3
    assert opt["stops"][0]["kind"] == "pickup"


def test_recompute_shared_info_and_stops() -> None:
    driver_pos = (23.8000, 91.2000)
    now = datetime(2026, 10, 2, 12, 0, 0, tzinfo=timezone.utc)
    parent_trip = {
        "tripId": "trip_1",
        "seatsUsed": 2,
        "remoteOnBoard": 0,
        "stopOrder": [
            {"rideId": "r1", "kind": "pickup", "lat": 23.8000, "lng": 91.2000, "status": "completed"},
            {"rideId": "r1", "kind": "drop", "lat": 23.8500, "lng": 91.2500, "status": "pending"},
            {"rideId": "r2", "kind": "pickup", "lat": 23.8100, "lng": 91.2100, "status": "pending"},
            {"rideId": "r2", "kind": "drop", "lat": 23.8600, "lng": 91.2600, "status": "pending"},
        ],
    }
    child_rides = [
        {
            "ride_id": "r1",
            "status": "started",
            "pinVerifiedAt": now.isoformat(),
            "baselineEtaIso": (now + timedelta(minutes=20)).isoformat(),
            "seatOrder": 1,
        },
        {
            "ride_id": "r2",
            "status": "accepted",
            "baselineEtaIso": (now + timedelta(minutes=25)).isoformat(),
            "seatOrder": 2,
        },
    ]

    full_stops, shared_info = recompute_shared_info_and_stops(driver_pos, parent_trip, child_rides, start_time=now)
    assert len(full_stops) == 4
    assert "r1" in shared_info
    assert "r2" in shared_info
    assert shared_info["r1"]["ridersOnboard"] == 1
    assert shared_info["r1"]["newRiderJoining"] is True
    assert shared_info["r1"]["seatsOccupied"] == 2


def test_accept_share_offer_endpoint() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_123", "name": "Driver One", "phone": "+919876543210"}
    mock_db = MagicMock()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "status": "pending",
        "passenger_id": "p_1",
        "passenger_name": "Rider Two",
        "pickup_name": "Agartala",
        "drop_name": "Airport",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "drop_lat": 23.88,
        "drop_lng": 91.30,
        "fare": 30,
    }

    mock_parent_doc = MagicMock()
    mock_parent_doc.id = "parent_trip_1"
    mock_parent_doc.to_dict.return_value = {
        "tripId": "parent_trip_1",
        "driverId": "driver_123",
        "status": "active",
        "seatsUsed": 1,
        "childRideIds": ["ride_1"],
        "stopOrder": [
            {"rideId": "ride_1", "kind": "drop", "lat": 23.89, "lng": 91.31, "status": "pending"},
        ],
    }

    now_iso = datetime.now(timezone.utc).isoformat()
    future_iso = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    mock_existing_child = MagicMock()
    mock_existing_child.exists = True
    mock_existing_child.to_dict.return_value = {
        "passenger_id": "p_0",
        "status": "started",
        "pinVerifiedAt": now_iso,
        "baselineEtaIso": future_iso,
    }

    mock_user_doc = MagicMock()
    mock_user_doc.exists = True
    mock_user_doc.to_dict.return_value = {
        "name": "Driver One",
        "phone": "+919876543210",
        "vehicle_model": "Bajaj Auto",
        "vehicle_number": "TR01A1234",
    }

    mock_db.collection.return_value.document.return_value.get.side_effect = [
        mock_ride_doc,
        mock_user_doc,
        MagicMock(exists=False),
        mock_existing_child,
    ]
    mock_db.collection.return_value.where.return_value.where.return_value.limit.return_value.stream.return_value = [
        mock_parent_doc
    ]

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            response = client.post("/api/share/offers/ride_new/accept", headers={"Authorization": "Bearer test"})
            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["rideId"] == "ride_new"
            assert data["parentTripId"] == "parent_trip_1"
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_decline_share_offer_endpoint() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_123"}
    mock_db = MagicMock()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "status": "pending",
        "rejected_driver_ids": [],
        "priority_driver_ids": ["driver_123", "driver_456"],
        "pickup_name": "Agartala",
        "drop_name": "Airport",
        "fare": 30,
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_ride_doc

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            response = client.post("/api/share/offers/ride_123/decline", headers={"Authorization": "Bearer test"})
            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["declined"] is True
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_remote_passenger_add_and_drop_endpoints() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_123"}
    mock_db = MagicMock()

    mock_trip_doc = MagicMock()
    mock_trip_doc.exists = True
    mock_trip_doc.to_dict.return_value = {
        "tripId": "parent_trip_1",
        "driverId": "driver_123",
        "status": "active",
        "seatsUsed": 1,
        "remoteOnBoard": 0,
        "remoteSeq": 0,
        "childRideIds": ["ride_1"],
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_trip_doc

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
        ):
            add_res = client.post("/api/share/trips/parent_trip_1/remote/add", headers={"Authorization": "Bearer test"})
            assert add_res.status_code == 200
            add_data = add_res.json()
            assert add_data["ok"] is True
            assert add_data["label"] == "Remote passenger 1"
            assert add_data["seatsUsed"] == 2
            assert add_data["remoteOnBoard"] == 1

            mock_trip_doc.to_dict.return_value = {
                "tripId": "parent_trip_1",
                "driverId": "driver_123",
                "status": "active",
                "seatsUsed": 2,
                "remoteOnBoard": 1,
                "childRideIds": ["ride_1"],
            }
            drop_res = client.post("/api/share/trips/parent_trip_1/remote/drop", headers={"Authorization": "Bearer test"})
            assert drop_res.status_code == 200
            drop_data = drop_res.json()
            assert drop_data["ok"] is True
            assert drop_data["seatsUsed"] == 1
            assert drop_data["remoteOnBoard"] == 0
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_evaluate_route_naive_datetimes() -> None:
    driver_pos = (23.8000, 91.2000)
    now = datetime(2026, 10, 2, 12, 0, 0)
    baseline_eta_naive = "2026-10-02T12:15:00"
    stops = [
        {"rideId": "r1", "kind": "drop", "lat": 23.8050, "lng": 91.2050},
    ]
    res = evaluate_route(driver_pos, stops, {"r1": baseline_eta_naive}, start_time=now)
    assert res["valid"] is True
    assert "r1" in res["delays"]


def test_decline_share_offer_fallback_to_auto_dispatch() -> None:
    client = TestClient(app)
    mock_user = {"uid": "driver_456"}
    mock_db = MagicMock()

    mock_ride_doc = MagicMock()
    mock_ride_doc.exists = True
    mock_ride_doc.to_dict.return_value = {
        "status": "pending",
        "rejected_driver_ids": ["driver_123"],
        "priority_driver_ids": ["driver_123", "driver_456"],
        "pickup_name": "Agartala",
        "drop_name": "Airport",
        "pickup_lat": 23.83,
        "pickup_lng": 91.28,
        "fare": 30,
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_ride_doc

    app.dependency_overrides[current_user] = lambda: mock_user
    try:
        with (
            patch("api.routers.share.get_admin_app"),
            patch("api.routers.share.fb_firestore.client", return_value=mock_db),
            patch("api.routers.rides._available_drivers", return_value=[{"uid": "driver_auto_1"}]),
        ):
            response = client.post("/api/share/offers/ride_123/decline", headers={"Authorization": "Bearer test"})
            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["declined"] is True
            doc_ref = mock_db.collection.return_value.document.return_value
            doc_ref.update.assert_called_once()
            call_kwargs = doc_ref.update.call_args[0][0]
            assert call_kwargs["dispatch_mode"] == "auto_share"
            assert call_kwargs["current_offer_driver_id"] is None
            assert "driver_auto_1" in call_kwargs["eligible_driver_ids"]
    finally:
        app.dependency_overrides.pop(current_user, None)

