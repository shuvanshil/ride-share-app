from datetime import datetime, timedelta, timezone

from api.core.fare_policy import calculate_fare, get_service_fare_policy, is_night_fare_time


FARE_TZ = timezone(timedelta(hours=5, minutes=30))


def fare_time(hour: int, minute: int) -> datetime:
    return datetime(2026, 7, 28, hour, minute, tzinfo=FARE_TZ)


def test_night_fare_boundaries_use_request_time() -> None:
    assert is_night_fare_time(fare_time(21, 59)) is False
    assert is_night_fare_time(fare_time(22, 0)) is True
    assert is_night_fare_time(fare_time(4, 29)) is True
    assert is_night_fare_time(fare_time(4, 30)) is False


def test_night_fare_rates_apply_to_auto_and_bike() -> None:
    auto = get_service_fare_policy("auto", fare_time(22, 0))
    bike = get_service_fare_policy("bike", fare_time(22, 0))

    assert auto["per_km"] == 20
    assert bike["per_km"] == 13
    assert calculate_fare(auto, 6) == 145
    assert calculate_fare(bike, 6) == 93


def test_normal_fare_rates_apply_after_night_window_ends() -> None:
    auto = get_service_fare_policy("auto", fare_time(4, 30))
    bike = get_service_fare_policy("bike", fare_time(4, 30))

    assert auto["per_km"] == 12.5
    assert bike["per_km"] == 7
    assert calculate_fare(auto, 6) == 100
    assert calculate_fare(bike, 6) == 57
