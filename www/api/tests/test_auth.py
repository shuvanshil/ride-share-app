import asyncio
import json

from api.core.auth import extract_bearer_token
from fastapi.testclient import TestClient

from api.index import app, unhandled_error_handler


def test_extract_bearer_token_accepts_case_insensitive_scheme() -> None:
    assert extract_bearer_token("bearer abc123") == "abc123"


def test_extract_bearer_token_rejects_malformed_header() -> None:
    assert extract_bearer_token(None) == ""
    assert extract_bearer_token("Basic abc123") == ""
    assert extract_bearer_token("Bearer") == ""


def test_profile_endpoint_requires_authentication() -> None:
    response = TestClient(app).get("/api/profile")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_cancellation_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/cancel")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_creation_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides",
        json={
            "pickupName": "Pickup",
            "dropName": "Drop",
            "pickupLat": 23.83,
            "pickupLng": 91.98,
            "dropLat": 23.84,
            "dropLng": 91.99,
            "vehicleType": "bike",
        },
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_acceptance_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/accept")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_transition_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/example-ride/transition",
        json={"action": "complete"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_dispatch_expansion_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/dispatch")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_availability_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-availability",
        json={"status": "searching"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_location_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-location",
        json={"lat": 23.83, "lng": 91.98},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_push_token_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-push-token",
        json={"token": "x" * 20, "permission": "granted"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_unhandled_errors_do_not_expose_exception_details() -> None:
    response = asyncio.run(unhandled_error_handler(None, RuntimeError("secret provider detail")))
    assert response.status_code == 500
    assert json.loads(response.body) == {"error": "Internal server error"}
