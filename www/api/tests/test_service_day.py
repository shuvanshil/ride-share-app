"""Unit tests for service_day module: 8:00 PM IST boundaries, week IDs, deadlines, and fee math."""
from __future__ import annotations

import datetime
import pytest

from api.core.service_day import (
    IST,
    service_date,
    service_date_str,
    day_start,
    day_close,
    is_service_day_closed,
    week_id,
    fee_due_at,
    calculate_paise_for_distance,
    paise_to_rupees_float,
)


def test_service_date_boundaries_19_59_vs_20_00():
    # Monday 19:59:59 IST belongs to Monday
    mon_19_59 = datetime.datetime(2026, 10, 19, 19, 59, 59, 999999, tzinfo=IST)
    assert service_date(mon_19_59) == datetime.date(2026, 10, 19)
    assert service_date_str(mon_19_59) == "2026-10-19"

    # Monday 20:00:00 IST belongs to Tuesday's service day
    mon_20_00 = datetime.datetime(2026, 10, 19, 20, 0, 0, 0, tzinfo=IST)
    assert service_date(mon_20_00) == datetime.date(2026, 10, 20)
    assert service_date_str(mon_20_00) == "2026-10-20"

    # Tuesday 19:59:59 IST belongs to Tuesday
    tue_19_59 = datetime.datetime(2026, 10, 20, 19, 59, 59, tzinfo=IST)
    assert service_date(tue_19_59) == datetime.date(2026, 10, 20)

    # Tuesday 20:00:00 IST belongs to Wednesday
    tue_20_00 = datetime.datetime(2026, 10, 20, 20, 0, 0, tzinfo=IST)
    assert service_date(tue_20_00) == datetime.date(2026, 10, 21)


def test_service_date_month_and_year_ends():
    # End of month: Oct 31, 2026 at 20:00:00 IST rolls into Nov 1, 2026
    oct31_2000 = datetime.datetime(2026, 10, 31, 20, 0, 0, tzinfo=IST)
    assert service_date(oct31_2000) == datetime.date(2026, 11, 1)

    # End of year: Dec 31, 2026 at 20:00:00 IST rolls into Jan 1, 2027
    dec31_2000 = datetime.datetime(2026, 12, 31, 20, 0, 0, tzinfo=IST)
    assert service_date(dec31_2000) == datetime.date(2027, 1, 1)

    # Leap year boundary or Feb end: Feb 28, 2026 at 20:00:00 IST rolls into Mar 1, 2026
    feb28_2000 = datetime.datetime(2026, 2, 28, 20, 0, 0, tzinfo=IST)
    assert service_date(feb28_2000) == datetime.date(2026, 3, 1)


def test_sunday_evening_transition():
    # Sunday 2026-10-25 at 19:59:59 IST is Sunday's service day
    sun_19_59 = datetime.datetime(2026, 10, 25, 19, 59, 59, tzinfo=IST)
    assert service_date(sun_19_59) == datetime.date(2026, 10, 25)
    assert week_id("2026-10-25") == "2026-W43"

    # Sunday 2026-10-25 at 20:00:00 IST is Monday's service day (starts new ISO week!)
    sun_20_00 = datetime.datetime(2026, 10, 25, 20, 0, 0, tzinfo=IST)
    assert service_date(sun_20_00) == datetime.date(2026, 10, 26)
    assert week_id(service_date(sun_20_00)) == "2026-W44"


def test_every_weekday_and_week_ids():
    # Monday 2026-10-19 through Sunday 2026-10-25 are ISO week 2026-W43
    for day_offset in range(7):
        d = datetime.date(2026, 10, 19) + datetime.timedelta(days=day_offset)
        assert week_id(d) == "2026-W43"


def test_day_start_and_day_close():
    # For service date Tuesday 2026-10-20:
    # Starts Monday 2026-10-19 20:00:00 IST
    # Closes Tuesday 2026-10-20 20:00:00 IST
    start_dt = day_start("2026-10-20")
    close_dt = day_close("2026-10-20")

    assert start_dt == datetime.datetime(2026, 10, 19, 20, 0, 0, tzinfo=IST)
    assert close_dt == datetime.datetime(2026, 10, 20, 20, 0, 0, tzinfo=IST)

    # is_service_day_closed check
    before_close = datetime.datetime(2026, 10, 20, 19, 59, 59, tzinfo=IST)
    at_close = datetime.datetime(2026, 10, 20, 20, 0, 0, tzinfo=IST)
    after_close = datetime.datetime(2026, 10, 20, 20, 0, 1, tzinfo=IST)

    assert is_service_day_closed("2026-10-20", before_close) is False
    assert is_service_day_closed("2026-10-20", at_close) is True
    assert is_service_day_closed("2026-10-20", after_close) is True


def test_fee_deadlines_and_sunday_exception():
    # Monday 2026-10-19: due Sunday 2026-10-25 23:59:59 IST
    mon_due = fee_due_at("2026-10-19")
    assert mon_due == datetime.datetime(2026, 10, 25, 23, 59, 59, tzinfo=IST)

    # Saturday 2026-10-24: due Sunday 2026-10-25 23:59:59 IST
    sat_due = fee_due_at("2026-10-24")
    assert sat_due == datetime.datetime(2026, 10, 25, 23, 59, 59, tzinfo=IST)

    # Sunday 2026-10-25 (SUNDAY EXCEPTION):
    # Its service day closes 20:00 Sunday, too close to 23:59:59.
    # Carried forward to FOLLOWING Sunday: 2026-11-01 23:59:59 IST!
    sun_due = fee_due_at("2026-10-25")
    assert sun_due == datetime.datetime(2026, 11, 1, 23, 59, 59, tzinfo=IST)


def test_fee_calculation_paise_formula():
    # Prompt C1 examples:
    # 100 m = 10 paise
    assert calculate_paise_for_distance(0.1) == 10
    # 1600 m = 160 paise
    assert calculate_paise_for_distance(1.6) == 160
    # 8250 m = 825 paise
    assert calculate_paise_for_distance(8.25) == 825
    # 25400 m = 2540 paise
    assert calculate_paise_for_distance(25.4) == 2540

    # Half-up rounding boundary:
    # 4 metres -> (4+5)//10 = 0 paise
    assert calculate_paise_for_distance(0.004) == 0
    # 5 metres -> (5+5)//10 = 1 paise
    assert calculate_paise_for_distance(0.005) == 1
    # 14 metres -> (14+5)//10 = 1 paise
    assert calculate_paise_for_distance(0.014) == 1
    # 15 metres -> (15+5)//10 = 2 paise
    assert calculate_paise_for_distance(0.015) == 2

    # Zero and negative
    assert calculate_paise_for_distance(0) == 0
    assert calculate_paise_for_distance(-1.5) == 0

    # Rupee float converter
    assert paise_to_rupees_float(2540) == 25.40
    assert paise_to_rupees_float(825) == 8.25
    assert paise_to_rupees_float(0) == 0.0
