"""Eligibility and hard constraint filters for passenger-driver matching."""
from __future__ import annotations

from typing import Optional
from ..config import BASE_MAX_ETA_MIN, CAP_MAX_ETA_MIN, MAX_ETA_GROWTH_RATE, SHARE_ENABLED
from .eta import pickup_eta_minutes
from .plan import DriverEntry, PassengerEntry
from .radius import max_eta_minutes


def check_eligibility(
    passenger: PassengerEntry,
    driver: DriverEntry,
    now: float,
    detour_minutes: float = 0.0,
    max_eta_cap: Optional[float] = None,
    pickup_eta: Optional[float] = None,
) -> tuple[bool, str, float]:
    """Evaluate whether driver d is eligible to serve passenger p.
    
    Returns:
        (is_eligible: bool, reason: str, pickup_eta: float)
    """
    # 0. Feature flag check
    if (passenger.wants_share or driver.is_share) and not SHARE_ENABLED:
        if driver.is_share or (passenger.wants_share and passenger.vehicle_type == "share"):
            return False, "share_disabled", 0.0

    # 1. Banned driver check
    if driver.id in passenger.banned:
        return False, "banned_driver", 0.0

    # 2. Driver approval check
    if not driver.is_approved:
        return False, "driver_not_approved", 0.0

    # 3. State checks: Only WAITING passengers and IDLE / SHARE_OPEN / SHARE drivers are visible
    if passenger.state != "WAITING":
        return False, f"passenger_not_waiting_{passenger.state}", 0.0

    is_driver_avail = driver.state in ("IDLE", "SHARE_OPEN", "SHARE") or driver.pool in ("IDLE", "SHARE")
    if not is_driver_avail:
        return False, f"driver_not_available_{driver.state}", 0.0

    # 4. Vehicle type compatibility
    p_veh = (passenger.vehicle_type or "auto").strip().lower()
    d_veh = (driver.vehicle_type or "auto").strip().lower()
    wants_share = bool(passenger.wants_share or p_veh == "share")
    if p_veh == "share":
        p_veh = "auto"

    if wants_share:
        # Share rides require auto
        if d_veh != "auto":
            return False, "share_requires_auto", 0.0
    elif p_veh != "any" and p_veh != d_veh:
        return False, "vehicle_type_mismatch", 0.0

    # 5. Shared ride capacity constraints
    if driver.is_share:
        if not passenger.wants_share:
            # Non-share passenger cannot be assigned to an active shared driver
            return False, "passenger_requires_private", 0.0
        if driver.seats_free < passenger.seats:
            return False, "insufficient_seats", 0.0

    # 6. Pickup ETA and dynamic radius limit
    wait_min = max(0.0, (now - passenger.req_time) / 60.0)
    eta = pickup_eta if (pickup_eta is not None and pickup_eta > 0) else pickup_eta_minutes(driver.loc[0], driver.loc[1], passenger.pickup[0], passenger.pickup[1])
    
    max_eta = max_eta_minutes(wait_min)
    if max_eta_cap is not None:
        max_eta = min(max_eta, max_eta_cap)

    if eta > max_eta:
        return False, f"eta_exceeded_{eta:.1f}_gt_{max_eta:.1f}", eta

    return True, "eligible", eta
