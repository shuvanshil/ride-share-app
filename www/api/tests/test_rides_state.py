from api.routers.rides import _build_driver_availability_updates, _driver_fare_adjustment, _safe_ride_dict
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
