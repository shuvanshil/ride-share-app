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


def test_accumulate_online_seconds_updates_stats_and_profile() -> None:
    calls = []

    class FakeDocRef:
        def __init__(self, path):
            self.path = path
        def set(self, data, merge=False):
            calls.append((self.path, data, merge))

    class FakeDb:
        def collection(self, name):
            return FakeColl(name)

    class FakeColl:
        def __init__(self, coll_name):
            self.coll_name = coll_name
        def document(self, doc_id):
            return FakeDocRef(f"{self.coll_name}/{doc_id}")

    valid_prev = datetime.now(timezone.utc) - timedelta(seconds=60)
    _accumulate_online_seconds(FakeDb(), "driver_test", valid_prev, still_online=True)
    assert any("users/driver_test" in c[0] for c in calls)


def test_get_driver_dashboard_structure(monkeypatch) -> None:
    from api.routers.rides import get_driver_dashboard

    class FakeDocSnap:
        def __init__(self, data=None, exists=True, doc_id="id"):
            self._data = data or {}
            self.exists = exists
            self.id = doc_id
        def to_dict(self):
            return self._data

    class FakeQuery:
        def where(self, *args, **kwargs):
            return self
        def limit(self, *args, **kwargs):
            return self
        def stream(self):
            return iter([])

    class FakeDocRef:
        def __init__(self, path):
            self.path = path
        def get(self):
            if "users/" in self.path:
                return FakeDocSnap({"role": "driver", "verificationStatus": "approved", "total_completed_trips": 5})
            return FakeDocSnap({"completed_rides": 2, "earnings": 250.0, "online_seconds": 3600})

    class FakeColl:
        def __init__(self, coll_name):
            self.coll_name = coll_name
        def document(self, doc_id):
            return FakeDocRef(f"{self.coll_name}/{doc_id}")
        def where(self, *args, **kwargs):
            return FakeQuery()

    class FakeDb:
        def collection(self, name):
            return FakeColl(name)
        def get_all(self, refs):
            return [FakeDocSnap({"completed_rides": 1, "earnings": 100.0, "online_seconds": 1800}, exists=True, doc_id="d1")]

    monkeypatch.setattr("api.routers.rides.fb_firestore.client", lambda app: FakeDb())
    monkeypatch.setattr("api.routers.rides.get_admin_app", lambda: None)

    res = get_driver_dashboard(user={"uid": "test_driver_123"})
    assert res["ok"] is True
    assert "week" in res
    assert "month" in res
    assert "lifetime" in res
    assert res["today"]["completedRides"] == 2
    assert res["today"]["earnings"] == 250.0
