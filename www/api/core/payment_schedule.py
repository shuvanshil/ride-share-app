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


def calculate_dues_and_upcoming(
    payment_history: List[Dict[str, Any]],
    current_week_info: Dict[str, Any],
    current_status: str = "due",
    driver_created_at: Optional[Any] = None
) -> Dict[str, Any]:
    """Calculate previous dues, total amount to be paid, consecutive unpaid weeks, and account hold status.
    
    Dues start counting ONLY AFTER the driver's first approved/verified payment week.
    If the driver has no approved payments yet, there are NO previous due weeks.
    """
    current_week_id = current_week_info["weekId"]
    monday_dt = datetime.datetime.fromisoformat(current_week_info["mondayStart"])

    approved_weeks = set()
    earliest_approved_dt = None

    for item in payment_history:
        w_id = item.get("weekId")
        st = item.get("status")
        if w_id and st in ("approved", "verified", "paused"):
            approved_weeks.add(w_id)
            sub_at = item.get("submittedAt") or item.get("verifiedAt")
            if sub_at:
                try:
                    if hasattr(sub_at, "astimezone"):
                        dt = sub_at.astimezone(IST)
                    elif isinstance(sub_at, str):
                        dt = datetime.datetime.fromisoformat(sub_at.replace("Z", "+00:00")).astimezone(IST)
                    elif isinstance(sub_at, (int, float)):
                        dt = datetime.datetime.fromtimestamp(sub_at / 1000.0, IST)
                    else:
                        dt = None
                    if dt and (not earliest_approved_dt or dt < earliest_approved_dt):
                        earliest_approved_dt = dt
                except Exception:
                    pass

    current_is_approved = (current_status in ("approved", "verified")) or (current_week_id in approved_weeks)

    # Requisition: The due date calculation MUST, and always, start AFTER the very first payment of the driver.
    # Means if a driver has not made any first payment yet, there shall be no due amount pending.
    if not approved_weeks:
        next_monday = monday_dt + datetime.timedelta(days=7)
        next_sunday = next_monday + datetime.timedelta(days=6)
        return {
            "previousDuesIncluded": False,
            "previousDuesCount": 0,
            "previousDuesAmount": 0,
            "previousDuesText": "No previous dues",
            "totalAmountToBePaid": DEFAULT_WEEKLY_FEE,
            "consecutiveUnpaidWeeks": 0,
            "isAccountOnHold": False,
            "holdLimitWeeks": 10,
            "upcomingWeek": {
                "dueDateLabel": next_sunday.strftime("%d %b %Y (Sun)"),
                "amount": DEFAULT_WEEKLY_FEE,
                "currency": "INR"
            }
        }

    anchor_dt = earliest_approved_dt
    if not anchor_dt:
        earliest_w = sorted(list(approved_weeks))[0]
        try:
            year, week_num = map(int, earliest_w.split("-W"))
            anchor_dt = datetime.datetime.fromisocalendar(year, week_num, 1).replace(tzinfo=IST)
        except Exception:
            anchor_dt = monday_dt

    anchor_weekday = anchor_dt.weekday()
    anchor_monday = (anchor_dt - datetime.timedelta(days=anchor_weekday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    previous_unpaid_weeks = []
    consecutive_count = 0 if current_is_approved else 1
    counting_consecutive = not current_is_approved

    max_weeks_back = max(0, int((monday_dt - anchor_monday).days // 7))

    for i in range(1, max_weeks_back + 1):
        prev_monday = monday_dt - datetime.timedelta(days=7 * i)
        if prev_monday < anchor_monday:
            break
        iso_year, iso_week, _ = prev_monday.isocalendar()
        prev_week_id = f"{iso_year}-W{iso_week:02d}"

        if prev_week_id not in approved_weeks:
            previous_unpaid_weeks.append(prev_week_id)
            if counting_consecutive:
                consecutive_count += 1
        else:
            counting_consecutive = False

    previous_dues_count = len(previous_unpaid_weeks)
    previous_dues_amount = previous_dues_count * DEFAULT_WEEKLY_FEE

    total_amount = DEFAULT_WEEKLY_FEE + previous_dues_amount
    is_account_on_hold = (consecutive_count >= 10) and (not current_is_approved)

    next_monday = monday_dt + datetime.timedelta(days=7)
    next_sunday = next_monday + datetime.timedelta(days=6)
    upcoming_due_label = next_sunday.strftime("%d %b %Y (Sun)")

    return {
        "previousDuesIncluded": previous_dues_count > 0,
        "previousDuesCount": previous_dues_count,
        "previousDuesAmount": previous_dues_amount,
        "previousDuesText": f"₹{previous_dues_amount} ({previous_dues_count} week{'s' if previous_dues_count > 1 else ''} overdue)" if previous_dues_count > 0 else "No previous dues",
        "totalAmountToBePaid": total_amount,
        "consecutiveUnpaidWeeks": consecutive_count,
        "isAccountOnHold": is_account_on_hold,
        "holdLimitWeeks": 10,
        "upcomingWeek": {
            "dueDateLabel": upcoming_due_label,
            "amount": DEFAULT_WEEKLY_FEE,
            "currency": "INR"
        }
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

