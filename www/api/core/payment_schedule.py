"""Weekly Payment Schedule & State Helpers for Driver Platform Fees.

Timezone-safe calculations for the Asia/Kolkata timezone:
- Week starts: Monday 00:00:00 IST
- Week ends: Sunday 23:59:59 IST
- Payment deadline: Sunday 12:00:00 PM IST (noon)
- Weekly fee: ₹140
"""
from __future__ import annotations

import datetime
from typing import Any, Optional, Dict

# Asia/Kolkata is UTC+05:30
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
DEFAULT_WEEKLY_FEE = 140
DEFAULT_PAYEE_UPI_ID = "shuvanshil@oksbi"
DEFAULT_PAYEE_NAME = "Ride Share Accounts"


def get_ist_now() -> datetime.datetime:
    """Return current datetime in Asia/Kolkata timezone."""
    return datetime.datetime.now(IST)


def get_payment_week_info(target_dt: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    """Calculate the payment week bounds, deadline, weekId, and status flags."""
    now = target_dt.astimezone(IST) if target_dt else get_ist_now()

    # Monday of the current week (weekday() returns 0 for Monday, 6 for Sunday)
    weekday = now.weekday()
    monday_start = (now - datetime.timedelta(days=weekday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    sunday_end = (monday_start + datetime.timedelta(days=6)).replace(
        hour=23, minute=59, second=59, microsecond=999999
    )
    sunday_deadline = (monday_start + datetime.timedelta(days=6)).replace(
        hour=12, minute=0, second=0, microsecond=0
    )
    next_monday_due = monday_start + datetime.timedelta(days=7)

    # ISO week identifier: e.g. 2026-W34
    iso_year, iso_week, _ = monday_start.isocalendar()
    week_id = f"{iso_year}-W{iso_week:02d}"

    # Human-readable format: "17 May 2026 (Mon) - 23 May 2026 (Sun)"
    start_str = monday_start.strftime("%d %b %Y (Mon)")
    end_str = sunday_end.strftime("%d %b %Y (Sun)")
    week_label = f"{start_str} - {end_str}"
    short_week_label = f"{monday_start.strftime('%d %b')} - {sunday_end.strftime('%d %b %Y')}"

    is_past_deadline = now > sunday_deadline

    # Remaining time calculation until deadline
    time_remaining_seconds = max(0, int((sunday_deadline - now).total_seconds()))
    days = time_remaining_seconds // 86400
    hours = (time_remaining_seconds % 86400) // 3600
    minutes = (time_remaining_seconds % 3600) // 60
    if time_remaining_seconds > 0:
        if days > 0:
            remaining_text = f"{days}d {hours}h {minutes}m"
        elif hours > 0:
            remaining_text = f"{hours}h {minutes}m"
        else:
            remaining_text = f"{minutes}m"
    else:
        remaining_text = "Deadline passed"

    return {
        "weekId": week_id,
        "weekLabel": week_label,
        "shortWeekLabel": short_week_label,
        "amount": DEFAULT_WEEKLY_FEE,
        "currency": "INR",
        "payeeUpiId": DEFAULT_PAYEE_UPI_ID,
        "payeeName": DEFAULT_PAYEE_NAME,
        "mondayStart": monday_start.isoformat(),
        "sundayEnd": sunday_end.isoformat(),
        "sundayDeadline": sunday_deadline.isoformat(),
        "deadlineFormatted": sunday_deadline.strftime("%d %B %Y, 12:00 PM"),
        "nextPaymentDueDate": next_monday_due.strftime("%d %B %Y"),
        "isPastDeadline": is_past_deadline,
        "timeRemainingSeconds": time_remaining_seconds,
        "timeRemainingFormatted": remaining_text,
    }


def is_date_in_pause_range(
    target_dt: Optional[datetime.datetime],
    start_date_str: Optional[str],
    end_date_str: Optional[str],
    is_paused_flag: bool = True
) -> bool:
    """Check whether a target datetime falls within an active payment pause range."""
    if not is_paused_flag:
        return False

    if not start_date_str or not end_date_str:
        return is_paused_flag

    dt = target_dt.astimezone(IST) if target_dt else get_ist_now()
    current_date = dt.date()

    try:
        start_d = datetime.datetime.strptime(start_date_str.strip(), "%Y-%m-%d").date()
        end_d = datetime.datetime.strptime(end_date_str.strip(), "%Y-%m-%d").date()
        return start_d <= current_date <= end_d
    except (ValueError, TypeError):
        return is_paused_flag

