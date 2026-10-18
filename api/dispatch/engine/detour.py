"""Detour penalty computation and stop insertion optimization for shared rides."""
from __future__ import annotations

from typing import Any, Optional

from ..config import (
    AVERAGE_SPEED_KMH,
    MAX_DETOUR_MIN,
    MAX_DETOUR_PCT,
    SHARE_MAX_SEATS,
)
from .eta import pickup_eta_minutes
from .plan import DriverEntry, PassengerEntry


def compute_detour_penalty(
    passenger: PassengerEntry,
    driver: DriverEntry,
    max_detour_min: float = MAX_DETOUR_MIN,
    max_detour_pct: float = MAX_DETOUR_PCT,
    avg_speed_kmh: float = AVERAGE_SPEED_KMH,
) -> Optional[tuple[float, float, list[dict[str, Any]]]]:
    """Compute detour penalty by inserting passenger p's pickup and drop into driver d's routeStops.
    
    Returns:
        (total_penalty_minutes, passenger_pickup_eta, best_new_stops) if valid,
        None if rejected due to detour limit violation or invalid configuration.
    """
    p_pickup = {
        "kind": "pickup",
        "rideId": passenger.id,
        "lat": passenger.pickup[0],
        "lng": passenger.pickup[1],
        "name": str(passenger.metadata.get("pickup_name") or "Pickup"),
    }
    p_drop = {
        "kind": "drop",
        "rideId": passenger.id,
        "lat": passenger.drop[0],
        "lng": passenger.drop[1],
        "name": str(passenger.metadata.get("drop_name") or "Drop"),
    }

    # If driver has no existing route stops (e.g. idle driver or empty share driver)
    existing_stops = list(driver.route) if driver.route else []
    k = len(existing_stops)

    if k == 0:
        # Direct route: driver -> passenger pickup -> passenger drop
        t_pickup = pickup_eta_minutes(
            driver.loc[0], driver.loc[1],
            p_pickup["lat"], p_pickup["lng"],
            avg_speed_kmh=avg_speed_kmh,
        )
        t_trip = pickup_eta_minutes(
            p_pickup["lat"], p_pickup["lng"],
            p_drop["lat"], p_drop["lng"],
            avg_speed_kmh=avg_speed_kmh,
        )
        driver_added = t_pickup + t_trip
        return (round(driver_added, 2), round(t_pickup, 2), [p_pickup, p_drop])

    # 1. Compute baseline arrival time for existing route stops from driver current location
    orig_arr: list[float] = [0.0] * k
    curr_loc = driver.loc
    accum = 0.0
    for idx in range(k):
        stop = existing_stops[idx]
        leg_time = pickup_eta_minutes(
            curr_loc[0], curr_loc[1],
            float(stop["lat"]), float(stop["lng"]),
            avg_speed_kmh=avg_speed_kmh,
        )
        accum += leg_time
        orig_arr[idx] = accum
        curr_loc = (float(stop["lat"]), float(stop["lng"]))
    orig_driver_duration = accum

    # Map existing onboard riders to their baseline remaining drop arrival time
    orig_drop_times: dict[str, float] = {}
    for idx in range(k):
        stop = existing_stops[idx]
        if stop.get("kind") == "drop" and stop.get("rideId"):
            orig_drop_times[str(stop["rideId"])] = orig_arr[idx]

    best_penalty: Optional[float] = None
    best_pickup_eta: float = 0.0
    best_stops: list[dict[str, Any]] = []

    # 2. Evaluate all insertion pairs (i, j) where 0 <= i < k and i <= j <= k
    # i is insertion index of pickup (must occur before at least the final drop to share the route)
    # j is insertion index of drop in original stops
    for i in range(k):
        for j in range(i, k + 1):
            candidate_stops = (
                existing_stops[:i]
                + [p_pickup]
                + existing_stops[i:j]
                + [p_drop]
                + existing_stops[j:]
            )

            # Compute new arrival times along candidate_stops
            new_arr: list[float] = [0.0] * len(candidate_stops)
            curr_loc = driver.loc
            accum_new = 0.0
            for idx, stop in enumerate(candidate_stops):
                leg_time = pickup_eta_minutes(
                    curr_loc[0], curr_loc[1],
                    float(stop["lat"]), float(stop["lng"]),
                    avg_speed_kmh=avg_speed_kmh,
                )
                accum_new += leg_time
                new_arr[idx] = accum_new
                curr_loc = (float(stop["lat"]), float(stop["lng"]))

            new_driver_duration = accum_new
            driver_added_minutes = max(0.0, new_driver_duration - orig_driver_duration)
            pax_pickup_eta = new_arr[i]

            # Verify detour constraints for each existing rider
            is_valid = True
            total_extra_existing = 0.0

            # Find each existing rider's drop in candidate_stops
            for r_id, orig_drop_t in orig_drop_times.items():
                # Locate drop index in candidate_stops
                new_drop_idx = None
                for idx, stop in enumerate(candidate_stops):
                    if stop.get("kind") == "drop" and str(stop.get("rideId")) == r_id:
                        new_drop_idx = idx
                        break

                if new_drop_idx is None:
                    continue

                new_drop_t = new_arr[new_drop_idx]
                extra_t = max(0.0, new_drop_t - orig_drop_t)

                # Reject if extra time exceeds MAX_DETOUR_MIN or MAX_DETOUR_PCT of remaining trip
                if extra_t > max_detour_min + 1e-4:
                    is_valid = False
                    break
                if orig_drop_t > 0.0 and (extra_t / orig_drop_t) > (max_detour_pct + 1e-4):
                    is_valid = False
                    break

                total_extra_existing += extra_t

            if not is_valid:
                continue

            penalty = total_extra_existing + driver_added_minutes
            if best_penalty is None or penalty < best_penalty:
                best_penalty = penalty
                best_pickup_eta = pax_pickup_eta
                best_stops = candidate_stops

    if best_penalty is None:
        return None

    return (round(best_penalty, 2), round(best_pickup_eta, 2), best_stops)
