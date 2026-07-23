import asyncio
import json

from api.core.auth import extract_bearer_token
from api.core.errors import ApiError
from fastapi.testclient import TestClient

from api.index import app, unhandled_error_handler
from api.routers.rides import _driver_fare_adjustment, _require_approved_driver, _require_role


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


def test_role_guard_rejects_the_wrong_account_role() -> None:
    _require_role({"role": "driver"}, "driver", "driver only")

    try:
        _require_role({"role": "passenger"}, "driver", "driver only")
    except ApiError as error:
        assert error.status_code == 403
        assert error.message == "driver only"
    else:
        raise AssertionError("Expected a passenger to be rejected by the driver guard")


def test_approved_driver_guard_rejects_unapproved_driver() -> None:
    _require_approved_driver({"role": "driver", "verificationStatus": "approved"}, "approved driver only")

    for profile in (
        {"role": "driver", "verificationStatus": "pending_review"},
        {"role": "driver", "verificationStatus": "suspended"},
        {"role": "passenger", "verificationStatus": "approved"},
    ):
        try:
            _require_approved_driver(profile, "approved driver only")
        except ApiError as error:
            assert error.status_code == 403
            assert error.message == "approved driver only"
        else:
            raise AssertionError("Expected a non-approved driver profile to be rejected")


def base_completed_ride(driver_lat: float, driver_lng: float) -> dict:
    return {
        "status": "en_route",
        "pinVerifiedAt": "2026-07-23T10:00:00+00:00",
        "pickup_lat": 0.0,
        "pickup_lng": 0.0,
        "drop_lat": 0.0,
        "drop_lng": 0.1,
        "driverLocation": {"lat": driver_lat, "lng": driver_lng},
        "distance_km": 11.12,
        "fare": 93,
        "quoted_fare": 93,
        "vehicle_type": "bike",
    }


def test_driver_fare_adjustment_zero_travel_after_pickup() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.0), "cancel")

    assert adjustment["final_fare"] == 0
    assert adjustment["reason"] == "zero_passenger_travel"


def test_driver_fare_adjustment_reduces_before_ninety_percent() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.05), "cancel")

    assert adjustment["reason"] == "partial_trip"
    assert adjustment["final_fare"] < adjustment["original_fare"]
    assert adjustment["progress_ratio"] < 0.9


def test_driver_fare_adjustment_keeps_full_fare_at_ninety_percent() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.091), "cancel")

    assert adjustment["reason"] == "full_trip_threshold"
    assert adjustment["final_fare"] == adjustment["original_fare"]


def test_driver_fare_adjustment_does_not_charge_extra_before_drop() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.095), "complete")

    assert adjustment["reason"] == "full_trip_threshold"
    assert adjustment["final_fare"] == adjustment["original_fare"]


def test_driver_fare_adjustment_adds_only_after_free_dropoff_buffer() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.102), "complete")

    assert adjustment["reason"] == "extra_after_drop"
    assert adjustment["final_fare"] > adjustment["original_fare"]
    assert adjustment["extra_dropoff_distance_km"] > 0.1
