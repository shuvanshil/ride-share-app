from __future__ import annotations

from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from api.core.share_config import (
    SHARE_BASE_METERS,
    SHARE_FARE_BASE,
    SHARE_MAX_DETOUR_MIN,
    SHARE_MAX_SEATS,
    SHARE_STEP_FARE,
    SHARE_STEP_METERS,
    calculate_share_fare,
    get_share_config_dict,
)
from api.index import app
from api.routers.rides import _driver_fare_adjustment


def test_calculate_share_fare_boundaries() -> None:
    assert calculate_share_fare(-100) == 10
    assert calculate_share_fare(0) == 10
    assert calculate_share_fare(500) == 10
    assert calculate_share_fare(1000) == 10
    assert calculate_share_fare(1001) == 15
    assert calculate_share_fare(1300) == 15
    assert calculate_share_fare(1301) == 20
    assert calculate_share_fare(1600) == 20
    assert calculate_share_fare(1601) == 25
    assert calculate_share_fare(2000) == 30
    assert calculate_share_fare(5000) == 80


def test_share_config_dict() -> None:
    config = get_share_config_dict()
    assert config["SHARE_FARE_BASE"] == SHARE_FARE_BASE
    assert config["SHARE_MAX_SEATS"] == SHARE_MAX_SEATS
    assert config["SHARE_BASE_METERS"] == SHARE_BASE_METERS
    assert config["SHARE_STEP_METERS"] == SHARE_STEP_METERS
    assert config["SHARE_STEP_FARE"] == SHARE_STEP_FARE
    assert config["SHARE_MAX_DETOUR_MIN"] == SHARE_MAX_DETOUR_MIN


def test_share_config_endpoint() -> None:
    client = TestClient(app)
    response = client.get("/api/share/config")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["config"]["SHARE_FARE_BASE"] == 10
    assert data["config"]["SHARE_MAX_SEATS"] == 3
    assert data["config"]["SHARE_MAX_DETOUR_MIN"] == 8


def test_share_quote_endpoint_with_km() -> None:
    client = TestClient(app)
    response = client.get("/api/share/quote?distanceKm=2.0")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["distanceMeters"] == 2000
    assert data["distanceKm"] == 2.0
    assert data["shareFare"] == 30
    assert data["normalFare"] >= 10


def test_share_quote_endpoint_with_meters() -> None:
    client = TestClient(app)
    response = client.get("/api/share/quote?distanceMeters=1300")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["distanceMeters"] == 1300
    assert data["shareFare"] == 15


def test_share_quote_endpoint_empty() -> None:
    client = TestClient(app)
    response = client.get("/api/share/quote")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["distanceMeters"] == 0
    assert data["shareFare"] == 10


def test_share_ride_fare_adjustment() -> None:
    ride = {
        "status": "started",
        "pickup_lat": 23.8315,
        "pickup_lng": 91.2868,
        "drop_lat": 23.9000,
        "drop_lng": 91.3500,
        "driverLocation": {"lat": 23.9000, "lng": 91.3500},
        "distance_km": 5.0,
        "fare": 80,
        "fareLocked": 80,
        "fare_base": 80,
        "fare_per_km": 0,
        "fare_min": 80,
        "rideType": "share",
        "vehicle_type": "auto",
        "service_name": "Shared Ride",
        "max_travelled_km": 5.0,
        "max_progress_ratio": 1.0,
        "pinVerifiedAt": "2026-10-02T12:00:00Z",
    }
    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["final_fare"] == 80
