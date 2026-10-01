"""LiphtUp Centralized Dispatch Configuration.

All tunable parameters for the global bipartite matching engine live here.
No magic numbers exist elsewhere in the dispatch subsystem.
"""
from __future__ import annotations

import math
from typing import Final

# ---------------------------------------------------------------------------
# Spatial & Expansion Tiers
# ---------------------------------------------------------------------------
RADIUS_START_KM: Final[float] = 2.0
RADIUS_STEP_KM: Final[float] = 3.0
RADIUS_MAX_KM: Final[float] = 25.0  # Strict hard cap, never exceeded
TIER_DWELL_SECONDS: Final[float] = 15.0
GRID_SNAP_METERS: Final[float] = 250.0
SPATIAL_INDEX_CELL_KM: Final[float] = 1.0

# ---------------------------------------------------------------------------
# Speeds & ETA Estimation
# ---------------------------------------------------------------------------
DEFAULT_SPEED_KMH: Final[float] = 30.0
DETOUR_FACTOR: Final[float] = 1.3
HEARTBEAT_FRESHNESS_SECONDS: Final[float] = 90.0

# ---------------------------------------------------------------------------
# Timeouts & Lifecycles
# ---------------------------------------------------------------------------
OFFER_TIMEOUT_SECONDS: Final[float] = 20.0
TOTAL_SEARCH_TIMEOUT_SECONDS: Final[float] = 300.0  # 5 minutes
LEASE_DURATION_SECONDS: Final[float] = 5.0
DEBOUNCE_WINDOW_SECONDS: Final[float] = 1.5
MAX_DIRTY_PASS_ITERATIONS: Final[int] = 3
SCHEDULED_ACTIVATION_LEAD_MINUTES: Final[float] = 15.0
POOL_ENTRY_TTL_SECONDS: Final[float] = 600.0  # 10 minutes
SWEEPER_INTERVAL_SECONDS: Final[float] = 60.0

# ---------------------------------------------------------------------------
# Driver Location Throttling
# ---------------------------------------------------------------------------
DRIVER_POOL_LOCATION_UPDATE_INTERVAL_SECONDS: Final[float] = 15.0
DRIVER_POOL_MIN_DISTANCE_METERS: Final[float] = 50.0

# ---------------------------------------------------------------------------
# Cooldowns & Priority Adjustments
# ---------------------------------------------------------------------------
DRIVER_CANCEL_COOLDOWN_SECONDS: Final[float] = 300.0  # 5 minutes
DRIVER_DECLINE_COOLDOWN_SECONDS: Final[float] = 60.0   # 1 minute
PASSENGER_CANCEL_RECOVERY_PRIORITY_BOOST: Final[float] = 10.0
PASSENGER_SCHEDULED_PRIORITY_BOOST: Final[float] = 5.0

# ---------------------------------------------------------------------------
# Matching Optimization & Objective Function
# ---------------------------------------------------------------------------
ETA_COST_EXPONENT: Final[float] = 1.25

# Dynamically derive worst-case edge cost at max radius (25 km):
# worst_eta_min = (25 * 1.3) / (30 / 60) = 65.0 minutes
# worst_cost = 65.0 ^ 1.25 = 184.07
WORST_CASE_ETA_MINUTES: Final[float] = (RADIUS_MAX_KM * DETOUR_FACTOR) / (DEFAULT_SPEED_KMH / 60.0)
WORST_CASE_EDGE_COST: Final[float] = math.pow(WORST_CASE_ETA_MINUTES, ETA_COST_EXPONENT)

# Ensure unassigned penalty base is strictly higher than any possible edge cost:
UNASSIGNED_PENALTY_BASE: Final[float] = math.ceil(WORST_CASE_EDGE_COST) + 50.0  # e.g., 185 + 50 = 235.0
UNASSIGNED_PENALTY_PER_MINUTE: Final[float] = 5.0

DRIVER_IDLE_WEIGHT: Final[float] = 0.5
DRIVER_IDLE_CAP: Final[float] = 10.0
PASSENGER_WAIT_WEIGHT: Final[float] = 1.0
PASSENGER_WAIT_CAP: Final[float] = 15.0

MAX_COMPONENT_SIZE: Final[int] = 50
SWAP_PASS_LIMIT: Final[int] = 3

# Hard pickup-ETA ceiling per tier (minutes)
TIER_ETA_CEILINGS: Final[dict[int, float]] = {
    0: 10.0,   # 2 km -> ~5.2m ETA (ceiling 10m)
    1: 18.0,   # 5 km -> ~13m ETA (ceiling 18m)
    2: 28.0,   # 8 km -> ~20.8m ETA (ceiling 28m)
    3: 38.0,   # 11 km
    4: 48.0,   # 14 km
    5: 58.0,   # 17 km
    6: 68.0,   # 20 km
    7: 78.0,   # 23 km
    8: 85.0,   # 25 km hard cap
}


def get_tier_sequence() -> list[float]:
    """Generate the strict sequence of expansion radii clamped to RADIUS_MAX_KM."""
    tiers: list[float] = []
    current = RADIUS_START_KM
    while current < RADIUS_MAX_KM:
        tiers.append(round(current, 2))
        current += RADIUS_STEP_KM
    tiers.append(RADIUS_MAX_KM)
    return tiers


def get_radius_for_tier(tier_index: int) -> float:
    tiers = get_tier_sequence()
    if tier_index < 0:
        return tiers[0]
    if tier_index >= len(tiers):
        return tiers[-1]
    return tiers[tier_index]


def get_eta_ceiling_for_tier(tier_index: int) -> float:
    if tier_index in TIER_ETA_CEILINGS:
        return TIER_ETA_CEILINGS[tier_index]
    return TIER_ETA_CEILINGS.get(len(get_tier_sequence()) - 1, 90.0)
