"""Configuration constants and tuning parameters for LiphtUp Pool-Based Dispatch (Phase 1)."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class DispatchWeights:
    urgency: float = 0.05       # W_URGENCY: wait-time multiplier on ETA
    pax_wait: float = 0.5       # W_PAX_WAIT: direct discount for passenger waiting time
    driver_idle: float = 0.2    # W_DRIVER_IDLE: discount for driver idle time
    fare: float = 0.1           # W_FARE: weight for fare per minute
    share_bonus: float = 2.0    # W_SHARE_BONUS: bonus deduction when pairing with shared auto
    detour_weight: float = 1.0  # multiplier on detour penalty minutes


# Default weights instance
WEIGHTS = DispatchWeights(
    urgency=float(os.getenv("DISPATCH_W_URGENCY", "0.05")),
    pax_wait=float(os.getenv("DISPATCH_W_PAX_WAIT", "0.5")),
    driver_idle=float(os.getenv("DISPATCH_W_DRIVER_IDLE", "0.2")),
    fare=float(os.getenv("DISPATCH_W_FARE", "0.1")),
    share_bonus=float(os.getenv("DISPATCH_W_SHARE_BONUS", "2.0")),
    detour_weight=float(os.getenv("DISPATCH_W_DETOUR", "1.0")),
)

# Spatial & ETA constraints
AVERAGE_SPEED_KMH = float(os.getenv("DISPATCH_AVG_SPEED_KMH", "25.0"))
BASE_MAX_ETA_MIN = float(os.getenv("DISPATCH_BASE_MAX_ETA_MIN", "8.0"))
MAX_ETA_GROWTH_RATE = float(os.getenv("DISPATCH_MAX_ETA_GROWTH_RATE", "0.5"))
CAP_MAX_ETA_MIN = float(os.getenv("DISPATCH_CAP_MAX_ETA_MIN", "25.0"))

GRID_CELL_SIZE_DEG = float(os.getenv("DISPATCH_GRID_CELL_SIZE_DEG", "0.02"))  # ~2.2 km at equator
DEFAULT_SEARCH_RADIUS_KM = float(os.getenv("DISPATCH_DEFAULT_SEARCH_RADIUS_KM", "5.0"))
MAX_SERVICEABLE_RADIUS_KM = float(os.getenv("DISPATCH_MAX_RADIUS_KM", "15.0"))

# Lifecycle & Timers (seconds)
DRIVER_STALE_TIMEOUT_SEC = float(os.getenv("DISPATCH_DRIVER_STALE_SEC", "45.0"))
OFFER_TIMEOUT_SEC = float(os.getenv("DISPATCH_OFFER_TIMEOUT_SEC", "45.0"))
MAX_WAIT_PASSENGER_SEC = float(os.getenv("DISPATCH_MAX_WAIT_SEC", "1500.0"))  # 25 min
LEASE_DURATION_SEC = float(os.getenv("DISPATCH_LEASE_DURATION_SEC", "10.0"))
SWEEPER_INTERVAL_SEC = float(os.getenv("DISPATCH_SWEEPER_INTERVAL_SEC", "10.0"))
LOCK_REPAIR_TIMEOUT_SEC = float(os.getenv("DISPATCH_LOCK_REPAIR_SEC", "60.0"))

# Failure Tolerance & Fallback
MAX_CONSECUTIVE_ENGINE_ERRORS = int(os.getenv("DISPATCH_MAX_CONSECUTIVE_ERRORS", "3"))
FALLBACK_COOLDOWN_SEC = float(os.getenv("DISPATCH_FALLBACK_COOLDOWN_SEC", "30.0"))

# Assignment & Optimization
DUMMY_UNASSIGNED_COST_PENALTY = 1000.0  # Base cost added to dummy columns
MAX_BATCH_CANDIDATES = 100

# Phase 2: Share Sub-pool & Detour Limits
SHARE_MAX_SEATS = int(os.getenv("DISPATCH_SHARE_MAX_SEATS", "3"))
MAX_DETOUR_MIN = float(os.getenv("DISPATCH_MAX_DETOUR_MIN", "8.0"))
MAX_DETOUR_PCT = float(os.getenv("DISPATCH_MAX_DETOUR_PCT", "0.33"))
SHARE_ENABLED = os.getenv("DISPATCH_SHARE_ENABLED", "true").lower() in ("true", "1", "yes")

# Phase 2: Fairness, Caps & Execution Budgets
MAX_PAX_PER_RUN = int(os.getenv("DISPATCH_MAX_PAX_PER_RUN", "50"))
MAX_COMPONENT_PAX = int(os.getenv("DISPATCH_MAX_COMPONENT_PAX", "20"))
RUN_TIME_BUDGET_MS = float(os.getenv("DISPATCH_RUN_TIME_BUDGET_MS", "1000.0"))
SWEEPER_GRACE_PERIOD_SEC = float(os.getenv("DISPATCH_SWEEPER_GRACE_SEC", "15.0"))

# Firestore Collections
COLLECTION_WPP = "dispatchWPP"
COLLECTION_DAP = "dispatchDAP"
COLLECTION_CONTROL = "dispatchControl"
COLLECTION_SCHEDULED = "dispatchScheduled"
COLLECTION_NOTIFY_ME = "dispatchNotifyMe"
COLLECTION_EVENTS = "dispatchEvents"
COLLECTION_ASSIGNMENTS = "dispatchAssignments"
COLLECTION_RUNS = "dispatchRuns"
COLLECTION_STATS = "dispatchStats"
COLLECTION_STATS_DAILY = "dispatchStatsDaily"
COLLECTION_NOTIFICATIONS = "dispatchNotifications"
