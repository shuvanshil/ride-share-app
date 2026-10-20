"""Service day and billing time calculations for LiphtUp.

A service day runs from 20:00:00 IST on the previous calendar day (inclusive)
up to 20:00:00 IST on the service date (exclusive).
The service date is the IST calendar date on which the service day closes.

Example:
    Monday 20:00:00 IST to Tuesday 19:59:59.999999 IST belongs to Tuesday's service day (service date = Tuesday).
    Monday 19:59:59.999999 IST belongs to Monday's service day.
"""
from __future__ import annotations

import datetime
from typing import Optional, Union

# Asia/Kolkata is UTC+05:30
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def get_ist_now() -> datetime.datetime:
    """Return current datetime in Asia/Kolkata timezone."""
    return datetime.datetime.now(IST)


def _to_ist_datetime(moment: Optional[Union[datetime.datetime, datetime.date, str, int, float]] = None) -> datetime.datetime:
    """Safely convert any moment representation to timezone-aware IST datetime."""
    if moment is None:
        return get_ist_now()
    if isinstance(moment, datetime.datetime):
        if moment.tzinfo is None:
            # Naive datetime: assume UTC
            return moment.replace(tzinfo=datetime.timezone.utc).astimezone(IST)
        return moment.astimezone(IST)
    if isinstance(moment, datetime.date):
        return datetime.datetime.combine(moment, datetime.time(0, 0, 0), tzinfo=IST)
    if isinstance(moment, (int, float)):
        # Timestamp (support ms or sec)
        ts = moment / 1000.0 if moment > 1e11 else float(moment)
        return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).astimezone(IST)
    if isinstance(moment, str):
        cleaned = moment.strip()
        if len(cleaned) == 10 and cleaned.count("-") == 2:
            y, m, d = map(int, cleaned.split("-"))
            return datetime.datetime(y, m, d, 0, 0, 0, tzinfo=IST)
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        dt = datetime.datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=datetime.timezone.utc).astimezone(IST)
        return dt.astimezone(IST)
    return get_ist_now()


def _to_date(val: Union[datetime.date, datetime.datetime, str]) -> datetime.date:
    """Normalize input into a datetime.date."""
    if isinstance(val, datetime.datetime):
        return val.astimezone(IST).date()
    if isinstance(val, datetime.date):
        return val
    if isinstance(val, str):
        cleaned = val.strip()[:10]
        return datetime.datetime.strptime(cleaned, "%Y-%m-%d").date()
    raise ValueError(f"Cannot convert {val!r} to datetime.date")


def service_date(instant: Optional[Union[datetime.datetime, str, int, float]] = None) -> datetime.date:
    """Return the service date on which the service day closes.

    A service day runs from 20:00 IST on previous calendar day up to 20:00 IST on service date.
    If IST hour >= 20: closes on NEXT calendar day.
    If IST hour < 20: closes on TODAY's calendar day.
    """
    dt = _to_ist_datetime(instant)
    if dt.hour >= 20:
        return dt.date() + datetime.timedelta(days=1)
    return dt.date()


def service_date_str(instant: Optional[Union[datetime.datetime, str, int, float]] = None) -> str:
    """Return ISO format YYYY-MM-DD string of the service date."""
    return service_date(instant).strftime("%Y-%m-%d")


def day_start(date_val: Union[datetime.date, datetime.datetime, str]) -> datetime.datetime:
    """Return the start instant (inclusive) of the service day: 20:00:00 IST on previous calendar day."""
    d = _to_date(date_val)
    prev_d = d - datetime.timedelta(days=1)
    return datetime.datetime(prev_d.year, prev_d.month, prev_d.day, 20, 0, 0, 0, tzinfo=IST)


def day_close(date_val: Union[datetime.date, datetime.datetime, str]) -> datetime.datetime:
    """Return the close instant (exclusive) of the service day: 20:00:00 IST on service date."""
    d = _to_date(date_val)
    return datetime.datetime(d.year, d.month, d.day, 20, 0, 0, 0, tzinfo=IST)


def is_service_day_closed(date_val: Union[datetime.date, datetime.datetime, str], now: Optional[datetime.datetime] = None) -> bool:
    """Return True if the service day has closed (now >= day_close)."""
    close_dt = day_close(date_val)
    curr = _to_ist_datetime(now)
    return curr >= close_dt


def week_id(date_val: Union[datetime.date, datetime.datetime, str]) -> str:
    """Return ISO week identifier of the service date (weeks Monday–Sunday), e.g. '2026-W43'."""
    d = _to_date(date_val)
    iso_year, iso_week, _ = d.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def fee_due_at(date_val: Union[datetime.date, datetime.datetime, str]) -> datetime.datetime:
    """Calculate the payment due deadline for a service date.

    Weekly deadline = Sunday 23:59:59 IST.
    - Monday–Saturday service dates (weekday 0..5): due at Sunday 23:59:59 of their own ISO week.
    - Sunday service dates (weekday 6): Sunday-only exception -> carried forward to FOLLOWING Sunday 23:59:59 IST.
    """
    d = _to_date(date_val)
    weekday = d.weekday()  # Monday is 0, Sunday is 6
    if weekday == 6:
        # Sunday exception: carried forward to next Sunday 23:59:59 IST
        target_sunday = d + datetime.timedelta(days=7)
    else:
        # Monday to Saturday: Sunday of current week
        days_until_sunday = 6 - weekday
        target_sunday = d + datetime.timedelta(days=days_until_sunday)

    return datetime.datetime(
        target_sunday.year,
        target_sunday.month,
        target_sunday.day,
        23,
        59,
        59,
        0,
        tzinfo=IST,
    )


def week_deadline(date_val: Union[datetime.date, datetime.datetime, str]) -> datetime.datetime:
    """Alias for fee_due_at."""
    return fee_due_at(date_val)


def calculate_paise_for_distance(distance_km: float) -> int:
    """Convert distance in km to fee in paise at ₹1/km.

    Formula:
        metres = round(distance_km * 1000)
        fee_paise = (metres + 5) // 10  (integer half-up)

    Examples:
        100 m = 10 paise
        1600 m = 160 paise
        8250 m = 825 paise
        25400 m = 2540 paise
    """
    if not distance_km or distance_km <= 0:
        return 0
    metres = int(round(float(distance_km) * 1000.0))
    if metres <= 0:
        return 0
    return (metres + 5) // 10


def paise_to_rupees_float(paise: int) -> float:
    """Convert paise to rupee float formatted to 2 decimals."""
    if not paise or paise <= 0:
        return 0.0
    return round(paise / 100.0, 2)
