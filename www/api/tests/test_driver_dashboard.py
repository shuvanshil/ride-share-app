from datetime import datetime, timedelta, timezone

from api.routers.rides import (
    ONLINE_HEARTBEAT_MAX_GAP_SECONDS,
    SAFETY_REPORT_CATEGORIES,
    _accumulate_online_seconds,
    _kolkata_day_str,
)


def test_kolkata_day_str_shifts_utc_late_night_into_next_ist_day() -> None:
    # 19:00 UTC == 00:30 IST the next calendar day.
    utc_moment = datetime(2026, 1, 1, 19, 0, tzinfo=timezone.utc)
    assert _kolkata_day_str(utc_moment) == "2026-01-02"


def test_kolkata_day_str_keeps_same_day_for_ist_morning() -> None:
    utc_moment = datetime(2026, 1, 1, 3, 0, tzinfo=timezone.utc)  # 08:30 IST
    assert _kolkata_day_str(utc_moment) == "2026-01-01"


def test_accumulate_online_seconds_skips_when_offline() -> None:
    captured = []

    class FakeDb:
        def collection(self, name):  # pragma: no cover - should never be called
            captured.append(name)
            raise AssertionError("must not touch Firestore while offline")

    _accumulate_online_seconds(FakeDb(), "driver1", datetime.now(timezone.utc), still_online=False)
    assert captured == []


def test_accumulate_online_seconds_skips_missing_previous_heartbeat() -> None:
    class FakeDb:
        def collection(self, name):  # pragma: no cover
            raise AssertionError("must not touch Firestore with no previous heartbeat")

    _accumulate_online_seconds(FakeDb(), "driver1", None, still_online=True)


def test_accumulate_online_seconds_skips_stale_gap_beyond_threshold() -> None:
    class FakeDb:
        def collection(self, name):  # pragma: no cover
            raise AssertionError("a multi-hour gap must not be credited as online time")

    stale_moment = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_HEARTBEAT_MAX_GAP_SECONDS * 10)
    _accumulate_online_seconds(FakeDb(), "driver1", stale_moment, still_online=True)


def test_safety_report_categories_include_expected_values() -> None:
    assert "unsafe_driving" in SAFETY_REPORT_CATEGORIES
    assert "harassment" in SAFETY_REPORT_CATEGORIES
    assert "other" in SAFETY_REPORT_CATEGORIES
