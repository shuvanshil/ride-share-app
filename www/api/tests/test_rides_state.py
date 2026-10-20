from api.routers.rides import (
    _build_driver_availability_updates,
    _driver_fare_adjustment,
    _driver_history_update,
    _history_update,
    _safe_ride_dict,
)
from datetime import datetime, timezone


def test_build_driver_availability_updates_restores_searching_for_online_driver() -> None:
    profile = {
        "driverAvailability": "busy",
        "desiredAvailability": "online",
        "verificationStatus": "approved",
    }

    user_update, presence_update, map_presence_update = _build_driver_availability_updates("searching", profile)

    assert user_update["driverAvailability"] == "searching"
    assert user_update["desiredAvailability"] == "online"
    assert user_update["isConnected"] is True
    assert "notificationEligibleUntil" in user_update
    assert "notificationEligibleUntil" in presence_update
    assert presence_update["driverAvailability"] == "searching"
    assert map_presence_update["driverAvailability"] == "searching"


def test_build_driver_availability_updates_keeps_offline_for_offline_driver() -> None:
    profile = {
        "driverAvailability": "offline",
        "desiredAvailability": "offline",
        "verificationStatus": "approved",
    }

    user_update, presence_update, map_presence_update = _build_driver_availability_updates("offline", profile)

    assert user_update["driverAvailability"] == "offline"
    assert user_update["desiredAvailability"] == "offline"
    assert user_update["isConnected"] is False
    assert "notificationEligibleUntil" in user_update
    assert "notificationEligibleUntil" in presence_update
    assert presence_update["driverAvailability"] == "offline"
    assert map_presence_update["driverAvailability"] == "offline"


def test_ride_fare_adjustment_and_safe_dict_contract() -> None:
    ride = {
        "status": "en_route",
        "fare": 120.0,
        "farePaise": 12000,
        "walletPaidAmountPaise": 5000,
        "wallet_paid_amount": 50.0,
        "couponApplied": {
            "code": "WELCOME50",
            "discountAmount": 50.0,
            "discountPaise": 5000,
        },
        "distance_km": 5.2,
        "createdAt": datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc),
    }

    adjustment = _driver_fare_adjustment(ride, "complete")
    assert adjustment["final_fare"] == 120.0

    safe = _safe_ride_dict(ride)
    assert safe["fare"] == 120.0
    assert safe["farePaise"] == 12000
    assert safe["walletPaidAmountPaise"] == 5000
    assert safe["couponApplied"]["discountPaise"] == 5000
    assert isinstance(safe["createdAt"], str)
    assert "2026-08-31T12:00:00" in safe["createdAt"]


def test_driver_history_update_records_zero_distance_when_zero_travel() -> None:
    ride = {
        "distance_km": 10.5,
        "fare": 150.0,
        "fare_adjustment": {
            "charged_distance_km": 0.0,
            "planned_distance_km": 10.5,
            "travelled_after_pickup_km": 0.02,
            "reason": "zero_passenger_travel",
        },
    }
    history = _driver_history_update("ride123", ride, "completed")
    assert history["distance_km"] == 0.0
    assert history["planned_distance_km"] == 10.5
    assert history["actual_travelled_km"] == 0.02
    assert history["final_status"] == "completed"


def test_driver_history_update_records_extra_distance_when_driver_travels_further() -> None:
    ride = {
        "distance_km": 8.0,
        "fare": 120.0,
        "fare_adjustment": {
            "charged_distance_km": 9.5,
            "planned_distance_km": 8.0,
            "travelled_after_pickup_km": 9.5,
            "reason": "extra_after_drop",
        },
    }
    history = _driver_history_update("ride456", ride, "completed")
    assert history["distance_km"] == 9.5
    assert history["planned_distance_km"] == 8.0
    assert history["actual_travelled_km"] == 9.5


def test_driver_history_update_cancelled_records_zero_or_partial_distance() -> None:
    ride_cancelled_pre = {
        "distance_km": 12.0,
        "fare": 180.0,
        "fare_adjustment": {
            "charged_distance_km": 0.0,
            "planned_distance_km": 12.0,
            "travelled_after_pickup_km": 0.0,
            "reason": "not_picked_up",
        },
    }
    history_pre = _driver_history_update("ride789", ride_cancelled_pre, "cancelled_by_driver")
    assert history_pre["distance_km"] == 0.0
    assert history_pre["final_status"] == "cancelled"

    ride_cancelled_partial = {
        "distance_km": 12.0,
        "fare": 180.0,
        "fare_adjustment": {
            "charged_distance_km": 3.4,
            "planned_distance_km": 12.0,
            "travelled_after_pickup_km": 3.4,
            "reason": "partial_trip",
        },
    }
    history_partial = _driver_history_update("ride789b", ride_cancelled_partial, "cancelled_by_driver")
    assert history_partial["distance_km"] == 3.4
    assert history_partial["final_status"] == "cancelled"


def test_passenger_history_update_records_actual_distance() -> None:
    ride = {
        "distance_km": 5.0,
        "fare": 75.0,
        "fare_adjustment": {
            "charged_distance_km": 0.0,
            "planned_distance_km": 5.0,
            "travelled_after_pickup_km": 0.01,
            "reason": "zero_passenger_travel",
        },
    }
    history = _history_update("ride_p1", ride)
    assert history["distance_km"] == 0.0
    assert history["planned_distance_km"] == 5.0
    assert history["final_status"] == "cancelled"
