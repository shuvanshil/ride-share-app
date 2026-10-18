"""Cost function formulation for passenger-driver bipartite matching."""
from __future__ import annotations

from ..config import AVERAGE_SPEED_KMH, WEIGHTS, DispatchWeights
from .geo import haversine_km
from .plan import DriverEntry, PassengerEntry


def compute_fare_per_minute(passenger: PassengerEntry, avg_speed_kmh: float = AVERAGE_SPEED_KMH) -> float:
    """Calculate expected fare rate per minute for passenger's planned trip."""
    if passenger.fare <= 0:
        return 0.0

    duration_min = passenger.metadata.get("duration_minutes")
    if duration_min is not None and float(duration_min) > 0:
        return round(float(passenger.fare) / float(duration_min), 3)

    trip_dist_km = haversine_km(
        passenger.pickup[0], passenger.pickup[1],
        passenger.drop[0], passenger.drop[1],
    )
    if trip_dist_km <= 0.01:
        return 0.0

    est_duration_min = (trip_dist_km / avg_speed_kmh) * 60.0
    return round(float(passenger.fare) / max(1.0, est_duration_min), 3)


def compute_pairing_cost(
    passenger: PassengerEntry,
    driver: DriverEntry,
    now: float,
    eta_minutes: float,
    detour_minutes: float = 0.0,
    weights: DispatchWeights = WEIGHTS,
) -> float:
    """Compute the objective pairing cost between passenger p and driver d.
    
    Formula:
      cost(p,d) = eta * (1 + W_URGENCY * waitP)
                - W_PAX_WAIT * waitP
                - W_DRIVER_IDLE * idleD
                - W_FARE * fare_per_minute(p,d)
                + detour_penalty(d,p)
                - W_SHARE_BONUS (if p.wants_share and d is share driver)
    """
    wait_p_min = max(0.0, (now - passenger.req_time) / 60.0)
    idle_d_min = max(0.0, (now - driver.idle_since) / 60.0) if driver.idle_since > 0 else 0.0
    fare_per_min = compute_fare_per_minute(passenger)

    urgency_mult = 1.0 + (weights.urgency * wait_p_min)
    base_eta_cost = eta_minutes * urgency_mult

    pax_wait_discount = weights.pax_wait * wait_p_min
    driver_idle_discount = weights.driver_idle * idle_d_min
    fare_discount = weights.fare * fare_per_min
    detour_cost = weights.detour_weight * detour_minutes

    share_bonus = (
        weights.share_bonus
        if (passenger.wants_share and driver.is_share)
        else 0.0
    )

    cost = (
        base_eta_cost
        - pax_wait_discount
        - driver_idle_discount
        - fare_discount
        + detour_cost
        - share_bonus
    )

    return round(cost, 4)
