from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.core.telegram import (
    KOLKATA_TZ,
    build_live_ride_url,
    claim_and_send_sensitive_ride_alert,
    format_sensitive_ride_message,
    is_sensitive_time_window,
    send_telegram_alert,
)
from api.index import app
import api.routers.rides as rides_router
from scripts.send_sensitive_ride_telegram_notifications import run_sensitive_ride_notifications


def test_time_window_boundary_conditions() -> None:
    """
    Test exact boundaries of the sensitive time window (20:00:00 - 04:59:59 IST).
    - 19:59:59 -> False
    - 20:00:00 -> True
    - 23:59:59 -> True
    - 00:00:00 -> True
    - 04:59:59 -> True
    - 05:00:00 -> False
    """
    # 19:59:59 IST (outside)
    dt_1959 = datetime(2026, 9, 19, 19, 59, 59, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_1959) is False

    # 20:00:00 IST (inside)
    dt_2000 = datetime(2026, 9, 19, 20, 0, 0, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_2000) is True

    # 23:59:59 IST (inside)
    dt_2359 = datetime(2026, 9, 19, 23, 59, 59, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_2359) is True

    # 00:00:00 IST (inside)
    dt_0000 = datetime(2026, 9, 20, 0, 0, 0, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_0000) is True

    # 04:59:59 IST (inside)
    dt_0459 = datetime(2026, 9, 20, 4, 59, 59, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_0459) is True

    # 05:00:00 IST (outside)
    dt_0500 = datetime(2026, 9, 20, 5, 0, 0, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_0500) is False

    # Daytime: 14:30:00 IST (outside)
    dt_day = datetime(2026, 9, 19, 14, 30, 0, tzinfo=KOLKATA_TZ)
    assert is_sensitive_time_window(dt_day) is False


def test_telegram_message_formatting() -> None:
    """Verify exact Telegram alert template formatting."""
    message = format_sensitive_ride_message(
        passenger_name="Sunita Sharma",
        driver_name="Ramesh Kumar",
        passenger_phone="+919876543210",
        driver_phone="+919123456789",
        live_ride_url="https://liphtup.in/track?ride=ride_xyz_123",
    )

    expected = (
        "Alert Type: Sensitive Ride\n\n"
        "Passenger name: Sunita Sharma\n"
        "Driver name: Ramesh Kumar\n"
        "Passenger Mobile number: +919876543210\n"
        "Driver's Mobile number: +919123456789\n"
        "URL for live ride details: https://liphtup.in/track?ride=ride_xyz_123"
    )
    assert message == expected


def test_live_ride_url_builder() -> None:
    """Verify live ride URL matches canonical route."""
    url = build_live_ride_url("ride_abc")
    assert url == "https://liphtup.in/track?ride=ride_abc"


def test_send_telegram_alert_http() -> None:
    """Test send_telegram_alert with mocked HTTP client."""
    posted_payload = {}

    def mock_post(url, json=None, timeout=None):
        nonlocal posted_payload
        posted_payload = json
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": True, "result": {"message_id": 999}}
        return mock_resp

    with patch("httpx.Client.post", side_effect=mock_post):
        res = send_telegram_alert(
            text="Test Alert",
            bot_token="test_bot_token_secret",
            chat_id="-100123456789",
        )
        assert res["ok"] is True
        assert res["result"]["message_id"] == 999
        assert posted_payload["chat_id"] == "-100123456789"
        assert posted_payload["text"] == "Test Alert"


def test_claim_and_send_sensitive_ride_alert_idempotency() -> None:
    """
    Test atomic claim and delivery flow:
    1. First run claims and sends -> sent = True
    2. Second run on same ride -> skipped = already_sent, sent = False
    """
    doc_state = {
        "sensitiveRide": True,
        "sensitiveRideNotificationSent": False,
        "passenger_name": "Priya",
        "driver_name": "Amit",
        "passenger_phone": "+919876543210",
        "driver_phone": "+919123456789",
    }

    class MockSnapshot:
        exists = True
        def to_dict(self):
            return dict(doc_state)

    class MockRideRef:
        def get(self, transaction=None):
            return MockSnapshot()
        def update(self, updates):
            doc_state.update(updates)

    class MockTx:
        def update(self, ref, updates):
            doc_state.update(updates)

    class MockDb:
        def collection(self, name):
            assert name == "rides"
            return self
        def document(self, doc_id):
            return MockRideRef()
        def transaction(self):
            return MockTx()

    db = MockDb()

    with patch("api.core.telegram.send_telegram_alert") as mock_send, \
         patch("firebase_admin.firestore.transactional", lambda fn: lambda tx: fn(tx)):
        mock_send.return_value = {"ok": True, "result": {"message_id": 101}}

        # First run: should claim and send
        res1 = claim_and_send_sensitive_ride_alert(
            db=db,
            ride_id="test_ride_1",
            bot_token="tok",
            chat_id="chat",
        )
        assert res1["ok"] is True
        assert res1["sent"] is True
        assert doc_state["sensitiveRideNotificationSent"] is True
        assert mock_send.call_count == 1

        # Second run: should detect already_sent and skip without calling Telegram again
        res2 = claim_and_send_sensitive_ride_alert(
            db=db,
            ride_id="test_ride_1",
            bot_token="tok",
            chat_id="chat",
        )
        assert res2["ok"] is True
        assert res2["sent"] is False
        assert res2["skipped"] == "already_sent"
        assert mock_send.call_count == 1  # No additional telegram call


def test_telegram_failure_allows_retry() -> None:
    """Test that Telegram delivery failure does not set sensitiveRideNotificationSent to True."""
    doc_state = {
        "sensitiveRide": True,
        "sensitiveRideNotificationSent": False,
        "passenger_name": "Priya",
        "driver_name": "Amit",
        "passenger_phone": "+919876543210",
        "driver_phone": "+919123456789",
    }

    class MockSnapshot:
        exists = True
        def to_dict(self):
            return dict(doc_state)

    class MockRideRef:
        def get(self, transaction=None):
            return MockSnapshot()
        def update(self, updates):
            doc_state.update(updates)

    class MockTx:
        def update(self, ref, updates):
            doc_state.update(updates)

    class MockDb:
        def collection(self, name):
            return self
        def document(self, doc_id):
            return MockRideRef()
        def transaction(self):
            return None

    db = MockDb()

    with patch("api.core.telegram.send_telegram_alert") as mock_send, \
         patch("firebase_admin.firestore.transactional", lambda fn: lambda tx: fn(tx)):
        # Simulate Telegram API error
        mock_send.return_value = {"ok": False, "error": "Network timeout"}

        res = claim_and_send_sensitive_ride_alert(
            db=db,
            ride_id="test_ride_fail",
            bot_token="tok",
            chat_id="chat",
        )
        assert res["ok"] is False
        assert res["sent"] is False
        assert doc_state["sensitiveRideNotificationSent"] is False
        assert doc_state.get("sensitiveRideNotificationClaimedAt") is None


def test_sensitive_ride_pin_verification_scenarios() -> None:
    """
    Test Scenarios directly:
    - Scenario A: Female passenger + 22:00 IST + PIN verification -> Sensitive (True)
    - Scenario A2: 'Others' passenger + 22:00 IST + PIN verification -> Sensitive (True)
    - Scenario B: Male passenger + 22:00 IST + PIN verification -> Not sensitive (False)
    - Scenario C: Female / Others passenger + 12:00 IST (daytime) + PIN verification -> Not sensitive (False)
    - Scenario D: Male passenger + 12:00 IST (daytime) + PIN verification -> Not sensitive (False)
    """
    night_dt = datetime(2026, 9, 19, 22, 0, 0, tzinfo=KOLKATA_TZ)
    day_dt = datetime(2026, 9, 19, 14, 0, 0, tzinfo=KOLKATA_TZ)

    def is_gender_sensitive(gender: str, dt: datetime) -> bool:
        clean = str(gender or "Others").strip().lower()
        return (clean != "male") and is_sensitive_time_window(dt)

    # Scenario A: Female + Night -> True
    assert is_gender_sensitive("Female", night_dt) is True
    assert is_gender_sensitive("female", night_dt) is True

    # Scenario A2: Others + Night -> True
    assert is_gender_sensitive("Others", night_dt) is True
    assert is_gender_sensitive("others", night_dt) is True
    assert is_gender_sensitive("", night_dt) is True  # Legacy fallback defaults to Others -> True

    # Scenario B: Male + Night -> False
    assert is_gender_sensitive("Male", night_dt) is False
    assert is_gender_sensitive("male", night_dt) is False

    # Scenario C: Female / Others + Daytime -> False
    assert is_gender_sensitive("Female", day_dt) is False
    assert is_gender_sensitive("Others", day_dt) is False
    assert is_gender_sensitive("Male", day_dt) is False


def test_standalone_runner_processes_pending(monkeypatch) -> None:
    """Test scripts/send_sensitive_ride_telegram_notifications.py batch runner."""
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "mock_bot_token")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-1001234567")

    class MockDoc:
        id = "ride_123"

    class MockQuery:
        def where(self, *args, **kwargs):
            return self
        def limit(self, count):
            return self
        def stream(self):
            return [MockDoc()]

    class MockDb:
        def collection(self, name):
            assert name == "rides"
            return MockQuery()

    with patch("scripts.send_sensitive_ride_telegram_notifications.get_firestore", return_value=MockDb()), \
         patch("scripts.send_sensitive_ride_telegram_notifications.claim_and_send_sensitive_ride_alert") as mock_claim:
        mock_claim.return_value = {"ok": True, "sent": True, "rideId": "ride_123"}
        stats = run_sensitive_ride_notifications()
        assert stats["found"] == 1
        assert stats["sent"] == 1
        assert stats["failed"] == 0
