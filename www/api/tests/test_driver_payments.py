"""Unit tests for Driver Weekly Payments API router & schedule calculations."""
from __future__ import annotations

import datetime
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from api.core.payment_schedule import get_payment_week_info, DEFAULT_WEEKLY_FEE, DEFAULT_PAYEE_UPI_ID
from api.index import app

client = TestClient(app)


def test_payment_schedule_calculation():
    # Test a Monday in 2026 (e.g. 17 Aug 2026 10:00:00 IST)
    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    mon_dt = datetime.datetime(2026, 8, 17, 10, 0, 0, tzinfo=ist)

    week_info = get_payment_week_info(mon_dt)
    assert week_info["amount"] == DEFAULT_WEEKLY_FEE
    assert week_info["payeeUpiId"] == DEFAULT_PAYEE_UPI_ID
    assert "2026-W" in week_info["weekId"]
    assert week_info["isPastDeadline"] is False

    # Test Sunday after 12:00 PM IST (e.g. 23 Aug 2026 14:00:00 IST)
    sun_afternoon = datetime.datetime(2026, 8, 23, 14, 0, 0, tzinfo=ist)
    sun_week_info = get_payment_week_info(sun_afternoon)
    assert sun_week_info["weekId"] == week_info["weekId"]
    assert sun_week_info["isPastDeadline"] is True
    assert sun_week_info["timeRemainingSeconds"] == 0


def test_pause_range_evaluation():
    from api.core.payment_schedule import is_date_in_pause_range
    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

    # Date within 1 Nov 2026 -> 30 Nov 2026
    dt_nov15 = datetime.datetime(2026, 11, 15, 12, 0, 0, tzinfo=ist)
    assert is_date_in_pause_range(dt_nov15, "2026-11-01", "2026-11-30", True) is True

    # Date outside pause range (e.g. 1 Dec 2026)
    dt_dec01 = datetime.datetime(2026, 12, 1, 10, 0, 0, tzinfo=ist)
    assert is_date_in_pause_range(dt_dec01, "2026-11-01", "2026-11-30", True) is False

    # Pause flag turned off
    assert is_date_in_pause_range(dt_nov15, "2026-11-01", "2026-11-30", False) is False

