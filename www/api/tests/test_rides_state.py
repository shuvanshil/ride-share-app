from api.routers.rides import _build_driver_availability_updates


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
    assert presence_update["driverAvailability"] == "offline"
    assert map_presence_update["driverAvailability"] == "offline"
