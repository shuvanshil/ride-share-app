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


def get_week_info_for_week_id(week_id: str) -> Dict[str, Any]:
    """Calculate date bounds and display labels for a given ISO weekId (e.g., '2026-W41')."""
    try:
        parts = week_id.split("-W")
        year = int(parts[0])
        week_num = int(parts[1])
        monday = datetime.datetime.fromisocalendar(year, week_num, 1).replace(
            hour=0, minute=0, second=0, microsecond=0, tzinfo=IST
        )
        sunday = (monday + datetime.timedelta(days=6)).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=IST
        )
        start_str = monday.strftime("%d %b %Y (Mon)")
        end_str = sunday.strftime("%d %b %Y (Sun)")
        week_label = f"{start_str} - {end_str}"
        short_label = f"{monday.strftime('%d %b')} - {sunday.strftime('%d %b %Y')}"
        return {
            "weekId": week_id,
            "weekLabel": week_label,
            "shortWeekLabel": short_label,
            "mondayStart": monday.isoformat(),
            "sundayEnd": sunday.isoformat(),
            "amount": DEFAULT_WEEKLY_FEE,
            "currency": "INR",
        }
    except Exception:
        return {
            "weekId": week_id,
            "weekLabel": f"Week {week_id}",
            "shortWeekLabel": week_id,
            "mondayStart": None,
            "sundayEnd": None,
            "amount": DEFAULT_WEEKLY_FEE,
            "currency": "INR",
        }


def allocate_payment_weeks(
    unpaid_overdue_weeks: List[str],
    current_week_id: str,
    is_current_week_unpaid: bool,
    num_weeks: int,
) -> List[str]:
    """
    Allocate a multi-instance weekly payment to exact unpaid weeks.
    Order of allocation:
    1. Chronological unpaid overdue weeks (oldest first).
    2. Current week (if unpaid or declined).
    3. Future consecutive weeks (if payment exceeds total outstanding dues).
    """
    allocated: List[str] = []

    # 1. Past unpaid weeks (oldest first)
    for wid in sorted(unpaid_overdue_weeks):
        if len(allocated) < num_weeks and wid not in allocated:
            allocated.append(wid)

    # 2. Current week
    if len(allocated) < num_weeks and is_current_week_unpaid and current_week_id not in allocated:
        allocated.append(current_week_id)

    # 3. Advance future weeks
    if len(allocated) < num_weeks:
        base_week = allocated[-1] if allocated else current_week_id
        try:
            y_str, w_str = base_week.split("-W")
            curr_y, curr_w = int(y_str), int(w_str)
            curr_monday = datetime.datetime.fromisocalendar(curr_y, curr_w, 1).replace(tzinfo=IST)
        except Exception:
            curr_monday = datetime.datetime.now(IST)

        step = 1
        while len(allocated) < num_weeks:
            next_m = curr_monday + datetime.timedelta(days=7 * step)
            iso_y, iso_w, _ = next_m.isocalendar()
            next_wid = f"{iso_y}-W{iso_w:02d}"
            if next_wid not in allocated:
                allocated.append(next_wid)
            step += 1

    return allocated


def calculate_dues_and_upcoming(
    payment_history: List[Dict[str, Any]],
    current_week_info: Dict[str, Any],
    current_status: str = "due",
    driver_created_at: Optional[Any] = None,
    reset_baseline_dt: Optional[Any] = None,
    base_week_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Calculate previous dues, total amount to be paid, consecutive unpaid weeks, and account hold status.
    
    Each weekly fee is ₹140. Tracks individual week statuses:
    - Paid: approved/verified
    - Under review: submitted/under_review
    - Unpaid / Due: declined or never submitted
    """
    current_week_id = current_week_info["weekId"]
    monday_dt = datetime.datetime.fromisoformat(current_week_info["mondayStart"])

    # Track latest submission record for each weekId
    latest_by_week: Dict[str, Dict[str, Any]] = {}
    approved_weeks = set()
    under_review_weeks = set()
    declined_weeks = set()
    earliest_recorded_dt = None
    earliest_approved_dt = None

    for item in sorted(payment_history, key=lambda x: str(x.get("submittedAt") or "")):
        wid = item.get("weekId")
        st = item.get("status")
        if wid:
            latest_by_week[wid] = item
            if st in ("approved", "verified", "paused"):
                approved_weeks.add(wid)
            elif st in ("submitted", "under_review"):
                under_review_weeks.add(wid)
            elif st == "declined":
                declined_weeks.add(wid)

        for cw in (item.get("coveredWeeks") or item.get("covered_weeks") or []):
            if st in ("approved", "verified", "paused"):
                approved_weeks.add(cw)
                latest_by_week[cw] = item
            elif st in ("submitted", "under_review"):
                under_review_weeks.add(cw)
                latest_by_week[cw] = item

        date_val = item.get("submittedAt") or item.get("verifiedAt")
        if date_val:
            try:
                if hasattr(date_val, "astimezone"):
                    dt = date_val.astimezone(IST)
                elif isinstance(date_val, str):
                    dt = datetime.datetime.fromisoformat(date_val.replace("Z", "+00:00")).astimezone(IST)
                elif isinstance(date_val, (int, float)):
                    dt = datetime.datetime.fromtimestamp(date_val / 1000.0, IST)
                else:
                    dt = None
                if dt:
                    if not earliest_recorded_dt or dt < earliest_recorded_dt:
                        earliest_recorded_dt = dt
                    if st in ("approved", "verified", "paused"):
                        if not earliest_approved_dt or dt < earliest_approved_dt:
                            earliest_approved_dt = dt
            except Exception:
                pass

    current_is_approved = (current_status in ("approved", "verified")) or (current_week_id in approved_weeks)
    current_is_under_review = (current_status in ("submitted", "under_review")) or (current_week_id in under_review_weeks)

    # Resolve driver creation / registration datetime
    created_dt = None
    if driver_created_at:
        try:
            if hasattr(driver_created_at, "astimezone"):
                created_dt = driver_created_at.astimezone(IST)
            elif isinstance(driver_created_at, str):
                created_dt = datetime.datetime.fromisoformat(driver_created_at.replace("Z", "+00:00")).astimezone(IST)
            elif isinstance(driver_created_at, (int, float)):
                created_dt = datetime.datetime.fromtimestamp(driver_created_at / 1000.0, IST)
        except Exception:
            pass

    candidates = [dt for dt in (created_dt, earliest_approved_dt, earliest_recorded_dt) if dt is not None]
    if candidates:
        anchor_dt = min(candidates)
    else:
        anchor_dt = monday_dt

    if reset_baseline_dt:
        try:
            if hasattr(reset_baseline_dt, "astimezone"):
                r_dt = reset_baseline_dt.astimezone(IST)
            elif isinstance(reset_baseline_dt, str):
                r_dt = datetime.datetime.fromisoformat(reset_baseline_dt.replace("Z", "+00:00")).astimezone(IST)
            elif isinstance(reset_baseline_dt, (int, float)):
                r_dt = datetime.datetime.fromtimestamp(reset_baseline_dt / 1000.0, IST)
            else:
                r_dt = None
            if r_dt and anchor_dt < r_dt:
                anchor_dt = r_dt
        except Exception:
            pass

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

        if base_week_id and prev_week_id < base_week_id:
            break

        week_record = latest_by_week.get(prev_week_id)
        week_status = week_record.get("status") if week_record else "due"

        if week_status not in ("approved", "verified", "paused", "submitted", "under_review"):
            # Week is unpaid (never submitted or declined)
            previous_unpaid_weeks.append(prev_week_id)
            if counting_consecutive:
                consecutive_count += 1
        else:
            counting_consecutive = False

    previous_unpaid_weeks = sorted(previous_unpaid_weeks)
    previous_dues_count = len(previous_unpaid_weeks)
    previous_dues_amount = previous_dues_count * DEFAULT_WEEKLY_FEE

    # Current week fee applies if current week is not approved and not under review
    current_fee = 0 if (current_is_approved or current_is_under_review) else DEFAULT_WEEKLY_FEE
    total_amount = current_fee + previous_dues_amount
    if total_amount == 0 and not current_is_approved and not current_is_under_review:
        total_amount = DEFAULT_WEEKLY_FEE

    is_account_on_hold = (consecutive_count >= 10) and (not current_is_approved)

    next_monday = monday_dt + datetime.timedelta(days=7)
    next_sunday = next_monday + datetime.timedelta(days=6)
    upcoming_due_label = next_sunday.strftime("%d %b %Y (Sun)")

    return {
        "previousDuesIncluded": previous_dues_count > 0,
        "previousDuesCount": previous_dues_count,
        "previousDuesAmount": previous_dues_amount,
        "previousDuesText": f"₹{previous_dues_amount} ({previous_dues_count} week{'s' if previous_dues_count > 1 else ''} overdue)" if previous_dues_count > 0 else "No previous dues",
        "previousUnpaidWeeks": previous_unpaid_weeks,
        "isCurrentWeekUnpaid": (not current_is_approved and not current_is_under_review),
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


def check_payment_reminder_eligibility(
    current_status: str,
    dues_info: Dict[str, Any],
    week_info: Dict[str, Any],
    active_submission: Optional[Dict[str, Any]] = None,
    snooze_config: Optional[Dict[str, Any]] = None,
    target_dt: Optional[datetime.datetime] = None,
    is_paused: bool = False,
    overdue_threshold_hours: int = 24,
) -> Dict[str, Any]:
    """Determine whether a driver is eligible for a payment reminder modal, and which notice to show.

    Modal priority:
    1. Declined notice (Priority 1):
       Displayed when latest relevant payment is declined and requires action, subject to its own snooze.
    2. Routine overdue reminder (Priority 2):
       Displayed when payment is unpaid ('due'), the relevant weekend has ended,
       and one full day (24 hours) has passed, subject to its own snooze.
    3. Suppressed if payment is submitted / under review.
    4. Suppressed if payment is verified / approved / no dues or if payments are paused.

    Never stacks or displays both notices simultaneously.
    """
    now = target_dt.astimezone(IST) if target_dt else get_ist_now()

    if is_paused:
        return {
            "eligible": False,
            "type": None,
            "reason": "payments_paused",
            "isSnoozed": False,
            "snoozedUntil": None,
        }

    total_due = dues_info.get("totalAmountToBePaid", 0)
    if current_status in ("approved", "verified") or total_due <= 0:
        return {
            "eligible": False,
            "type": None,
            "reason": "no_dues",
            "isSnoozed": False,
            "snoozedUntil": None,
        }

    # Priority 1: Declined notice
    if current_status == "declined":
        snooze = snooze_config or {}
        decline_snoozed_until = snooze.get("declineSnoozedUntil")
        snoozed_payment_id = snooze.get("declinedPaymentId")
        active_payment_id = active_submission.get("paymentId") if active_submission else None
        decline_reason = active_submission.get("declineReason") if active_submission else None

        is_snoozed = False
        snoozed_until_dt = None
        if decline_snoozed_until:
            try:
                if hasattr(decline_snoozed_until, "astimezone"):
                    snoozed_until_dt = decline_snoozed_until.astimezone(IST)
                elif isinstance(decline_snoozed_until, str):
                    snoozed_until_dt = datetime.datetime.fromisoformat(decline_snoozed_until.replace("Z", "+00:00")).astimezone(IST)
                elif isinstance(decline_snoozed_until, (int, float)):
                    snoozed_until_dt = datetime.datetime.fromtimestamp(decline_snoozed_until / 1000.0, IST)
            except Exception:
                snoozed_until_dt = None

        if snoozed_until_dt:
            if active_payment_id and snoozed_payment_id and active_payment_id != snoozed_payment_id:
                # Genuinely new decline detected; snooze superseded
                is_snoozed = False
            elif now < snoozed_until_dt:
                is_snoozed = True

        if is_snoozed:
            return {
                "eligible": False,
                "type": "declined",
                "paymentId": active_payment_id,
                "isSnoozed": True,
                "snoozedUntil": snoozed_until_dt.isoformat() if snoozed_until_dt else str(decline_snoozed_until),
                "reason": "declined_snoozed",
                "declineReason": decline_reason,
            }

        return {
            "eligible": True,
            "type": "declined",
            "paymentId": active_payment_id,
            "isSnoozed": False,
            "snoozedUntil": None,
            "reason": "action_required",
            "declineReason": decline_reason,
        }

    # Priority 3: Submitted / Under review (suppresses ordinary overdue reminder)
    if current_status in ("submitted", "under_review"):
        return {
            "eligible": False,
            "type": None,
            "reason": "under_review",
            "isSnoozed": False,
            "snoozedUntil": None,
        }

    # Priority 2: Unpaid and overdue reminder
    if current_status == "due":
        # Check all unpaid weeks: has at least one unpaid week passed the threshold (weekend end + 24 hours)?
        threshold_passed = False
        overdue_week_id = None

        for wid in dues_info.get("previousUnpaidWeeks", []):
            try:
                winfo = get_week_info_for_week_id(wid)
                if winfo.get("sundayEnd"):
                    w_sun_end = datetime.datetime.fromisoformat(str(winfo["sundayEnd"]).replace("Z", "+00:00")).astimezone(IST)
                    if now >= (w_sun_end + datetime.timedelta(hours=overdue_threshold_hours)):
                        threshold_passed = True
                        overdue_week_id = wid
                        break
            except Exception:
                pass

        if not threshold_passed and dues_info.get("isCurrentWeekUnpaid"):
            sunday_end_val = week_info.get("sundayEnd")
            if sunday_end_val:
                try:
                    sun_dt = datetime.datetime.fromisoformat(str(sunday_end_val).replace("Z", "+00:00")).astimezone(IST)
                    if now >= (sun_dt + datetime.timedelta(hours=overdue_threshold_hours)):
                        threshold_passed = True
                        overdue_week_id = week_info.get("weekId")
                except Exception:
                    pass

        if not threshold_passed:
            return {
                "eligible": False,
                "type": "overdue",
                "overdueThresholdPassed": False,
                "isSnoozed": False,
                "snoozedUntil": None,
                "reason": "threshold_not_passed",
            }

        snooze = snooze_config or {}
        overdue_snoozed_until = snooze.get("overdueSnoozedUntil")
        is_snoozed = False
        snoozed_until_dt = None
        if overdue_snoozed_until:
            try:
                if hasattr(overdue_snoozed_until, "astimezone"):
                    snoozed_until_dt = overdue_snoozed_until.astimezone(IST)
                elif isinstance(overdue_snoozed_until, str):
                    snoozed_until_dt = datetime.datetime.fromisoformat(overdue_snoozed_until.replace("Z", "+00:00")).astimezone(IST)
                elif isinstance(overdue_snoozed_until, (int, float)):
                    snoozed_until_dt = datetime.datetime.fromtimestamp(overdue_snoozed_until / 1000.0, IST)
            except Exception:
                snoozed_until_dt = None

            if snoozed_until_dt and now < snoozed_until_dt:
                is_snoozed = True

        if is_snoozed:
            return {
                "eligible": False,
                "type": "overdue",
                "weekId": overdue_week_id,
                "overdueThresholdPassed": True,
                "isSnoozed": True,
                "snoozedUntil": snoozed_until_dt.isoformat() if snoozed_until_dt else str(overdue_snoozed_until),
                "reason": "overdue_snoozed",
            }

        return {
            "eligible": True,
            "type": "overdue",
            "weekId": overdue_week_id,
            "overdueThresholdPassed": True,
            "isSnoozed": False,
            "snoozedUntil": None,
            "reason": "overdue_unpaid",
        }

    return {
        "eligible": False,
        "type": None,
        "reason": "not_applicable",
        "isSnoozed": False,
        "snoozedUntil": None,
    }


