"""Dynamic radius expansion and maximum ETA threshold calculation."""
from __future__ import annotations

from ..config import (
    AVERAGE_SPEED_KMH,
    BASE_MAX_ETA_MIN,
    CAP_MAX_ETA_MIN,
    MAX_ETA_GROWTH_RATE,
    MAX_SERVICEABLE_RADIUS_KM,
)


def max_eta_minutes(
    wait_minutes: float,
    base_max_eta: float = BASE_MAX_ETA_MIN,
    growth_rate: float = MAX_ETA_GROWTH_RATE,
    cap_eta: float = CAP_MAX_ETA_MIN,
) -> float:
    """Calculate maximum acceptable driver pickup ETA, expanding as the passenger waits.
    
    Formula: min(cap_eta, base_max_eta + growth_rate * max(0, wait_minutes))
    """
    safe_wait = max(0.0, float(wait_minutes))
    allowed = base_max_eta + (growth_rate * safe_wait)
    return min(cap_eta, allowed)


def max_search_radius_km(
    wait_minutes: float,
    avg_speed_kmh: float = AVERAGE_SPEED_KMH,
) -> float:
    """Derive spatial search radius in km from expanding ETA threshold."""
    m_eta = max_eta_minutes(wait_minutes)
    radius_km = (m_eta / 60.0) * avg_speed_kmh
    return min(MAX_SERVICEABLE_RADIUS_KM, radius_km)


def is_eta_eligible(eta_minutes: float, wait_minutes: float) -> bool:
    """Check whether candidate pickup ETA is within the expanding threshold."""
    return float(eta_minutes) <= max_eta_minutes(wait_minutes)
