from api.routers.rides import _availability_for_location_update


def test_location_update_sets_searching_for_online_driver_without_ride() -> None:
    profile = {
        "driverAvailability": "busy",
        "desiredAvailability": "online",
        "verificationStatus": "approved",
    }

    availability, desired = _availability_for_location_update(profile, "")

    assert availability == "searching"
    assert desired == "online"


def test_location_update_preserves_offline_intent() -> None:
    profile = {
        "driverAvailability": "busy",
        "desiredAvailability": "offline",
        "verificationStatus": "approved",
    }

    availability, desired = _availability_for_location_update(profile, "")

    assert availability == "offline"
    assert desired == "offline"


def test_location_update_sets_busy_when_ride_active() -> None:
    profile = {
        "driverAvailability": "searching",
        "desiredAvailability": "online",
        "verificationStatus": "approved",
    }

    availability, desired = _availability_for_location_update(profile, "ride_123")

    assert availability == "busy"
    assert desired == "online"
