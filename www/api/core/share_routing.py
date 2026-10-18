from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .geo import encode_polyline, haversine_km
from .share_config import (
    SHARE_DETOUR_ROAD_FACTOR,
    SHARE_FALLBACK_SPEED_KMH,
    SHARE_MAX_DETOUR_MIN,
    SHARE_MAX_SEATS,
)


def compute_leg_travel_time(
    origin: tuple[float, float], destination: tuple[float, float]
) -> tuple[float, float]:
    dist_km = haversine_km(origin[0], origin[1], destination[0], destination[1]) * SHARE_DETOUR_ROAD_FACTOR
    dur_min = (dist_km / SHARE_FALLBACK_SPEED_KMH) * 60.0
    return dist_km, dur_min


def is_valid_permutation(stops: list[dict[str, Any]]) -> bool:
    seen_pickups = set()
    for stop in stops:
        ride_id = stop.get("rideId")
        kind = stop.get("kind")
        if kind == "pickup":
            seen_pickups.add(ride_id)
        elif kind == "drop":
            has_pickup_in_list = any(
                s.get("rideId") == ride_id and s.get("kind") == "pickup" for s in stops
            )
            if has_pickup_in_list and ride_id not in seen_pickups:
                return False
    return True


def generate_valid_stop_permutations(
    stops: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    valid: list[list[dict[str, Any]]] = []
    for perm in itertools.permutations(stops):
        perm_list = list(perm)
        if is_valid_permutation(perm_list):
            valid.append(perm_list)
    return valid


def evaluate_route(
    driver_pos: tuple[float, float],
    stops: list[dict[str, Any]],
    baseline_etas: dict[str, datetime | str],
    start_time: Optional[datetime] = None,
) -> dict[str, Any]:
    now = start_time or datetime.now(timezone.utc)
    curr_pos = driver_pos
    curr_time = now
    total_dist = 0.0
    total_dur = 0.0
    stop_results: list[dict[str, Any]] = []
    drop_etas: dict[str, datetime] = {}

    for stop in stops:
        stop_lat = float(stop.get("lat") or 0.0)
        stop_lng = float(stop.get("lng") or 0.0)
        leg_dist, leg_dur = compute_leg_travel_time(curr_pos, (stop_lat, stop_lng))
        total_dist += leg_dist
        total_dur += leg_dur
        curr_time = curr_time + timedelta(minutes=leg_dur)
        curr_pos = (stop_lat, stop_lng)

        stop_dict = dict(stop)
        stop_dict["etaIso"] = curr_time.isoformat()
        stop_results.append(stop_dict)

        if stop.get("kind") == "drop":
            ride_id = stop.get("rideId")
            if ride_id:
                drop_etas[ride_id] = curr_time

    delays: dict[str, float] = {}
    max_delay = 0.0
    detour_cap_exceeded = False

    for ride_id, baseline in baseline_etas.items():
        if not baseline:
            continue
        if isinstance(baseline, datetime):
            b_dt = baseline
        else:
            b_dt = datetime.fromisoformat(str(baseline).replace("Z", "+00:00"))
        if b_dt.tzinfo is None:
            b_dt = b_dt.replace(tzinfo=timezone.utc)
        new_eta = drop_etas.get(ride_id)
        if new_eta:
            if new_eta.tzinfo is None:
                new_eta = new_eta.replace(tzinfo=timezone.utc)
            delay = (new_eta - b_dt).total_seconds() / 60.0
            delays[ride_id] = delay
            if delay > max_delay:
                max_delay = delay
            if delay > SHARE_MAX_DETOUR_MIN:
                detour_cap_exceeded = True

    return {
        "valid": not detour_cap_exceeded,
        "max_delay_min": max_delay,
        "total_duration_minutes": total_dur,
        "total_distance_km": total_dist,
        "stops": stop_results,
        "drop_etas": drop_etas,
        "delays": delays,
    }


def find_optimal_share_route(
    driver_pos: tuple[float, float],
    pending_stops: list[dict[str, Any]],
    baseline_etas: dict[str, datetime | str],
    candidate_stops: Optional[list[dict[str, Any]]] = None,
    start_time: Optional[datetime] = None,
) -> Optional[dict[str, Any]]:
    all_stops = list(pending_stops) + (list(candidate_stops) if candidate_stops else [])
    valid_perms = generate_valid_stop_permutations(all_stops)
    best_evaluation: Optional[dict[str, Any]] = None

    for perm in valid_perms:
        eval_res = evaluate_route(driver_pos, perm, baseline_etas, start_time)
        if not eval_res["valid"]:
            continue
        if best_evaluation is None:
            best_evaluation = eval_res
        else:
            if eval_res["max_delay_min"] < best_evaluation["max_delay_min"] - 1e-6:
                best_evaluation = eval_res
            elif abs(eval_res["max_delay_min"] - best_evaluation["max_delay_min"]) <= 1e-6:
                if eval_res["total_duration_minutes"] < best_evaluation["total_duration_minutes"]:
                    best_evaluation = eval_res

    return best_evaluation


def recompute_shared_info_and_stops(
    driver_pos: tuple[float, float],
    parent_trip: dict[str, Any],
    child_rides: list[dict[str, Any]],
    start_time: Optional[datetime] = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    existing_completed = [
        s for s in parent_trip.get("stopOrder", []) if s.get("status") == "completed"
    ]
    existing_pending = [
        s for s in parent_trip.get("stopOrder", []) if s.get("status") != "completed"
    ]

    baseline_etas: dict[str, str] = {}
    for cr in child_rides:
        r_id = cr.get("ride_id") or cr.get("id") or cr.get("clean_ride_id")
        b = cr.get("baselineEtaIso") or (cr.get("sharedInfo") or {}).get("baselineEtaIso")
        if r_id and b:
            baseline_etas[str(r_id)] = str(b)

    evaluated = find_optimal_share_route(
        driver_pos, existing_pending, baseline_etas, start_time=start_time
    )
    if evaluated is not None:
        new_pending_stops = evaluated["stops"]
        delays = evaluated["delays"]
        drop_etas = evaluated["drop_etas"]
    else:
        new_pending_stops = existing_pending
        delays = {}
        drop_etas = {}

    full_stops = existing_completed + new_pending_stops
    remote_count = int(parent_trip.get("remoteOnBoard") or 0)
    onboard_app_riders = [
        cr for cr in child_rides
        if (cr.get("status") in {"started", "en_route"} or bool(cr.get("pinVerifiedAt")))
        and cr.get("status") not in {"completed", "cancelled", "cancelled_by_passenger", "cancelled_by_driver"}
    ]
    unpicked_app_riders = [
        cr for cr in child_rides
        if cr.get("status") in {"pending", "accepted", "to_pickup", "arrived"}
        and not (cr.get("status") in {"started", "en_route"} or bool(cr.get("pinVerifiedAt")))
    ]
    riders_onboard_total = len(onboard_app_riders) + remote_count
    new_rider_joining = len(unpicked_app_riders) > 0

    shared_info_by_ride: dict[str, dict[str, Any]] = {}
    seats_used = int(parent_trip.get("seatsUsed") or (len(child_rides) + remote_count))

    for cr in child_rides:
        r_id = str(cr.get("ride_id") or cr.get("id") or cr.get("clean_ride_id") or "")
        if not r_id:
            continue
        drop_eta_dt = drop_etas.get(r_id)
        eta_iso = (
            drop_eta_dt.isoformat()
            if drop_eta_dt
            else (cr.get("baselineEtaIso") or (cr.get("sharedInfo") or {}).get("baselineEtaIso") or "")
        )
        delay_val = max(0, int(round(delays.get(r_id, 0.0))))
        other_riders = max(0, seats_used - 1)
        if delay_val > 0 and other_riders > 0:
            msg = f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''} • +{delay_val} min detour"
        elif other_riders > 0:
            msg = f"Sharing with {other_riders} other rider{'s' if other_riders > 1 else ''}"
        else:
            msg = "Direct route"

        is_picked_up = (
            cr.get("status") in {"started", "en_route"} or bool(cr.get("pinVerifiedAt"))
        ) and cr.get("status") not in {"completed", "cancelled", "cancelled_by_passenger", "cancelled_by_driver"}

        target_kind = "drop" if is_picked_up else "pickup"
        target_idx = -1
        for idx, st in enumerate(new_pending_stops):
            if str(st.get("rideId")) == r_id and st.get("kind") == target_kind:
                target_idx = idx
                break
        if target_idx < 0:
            for idx, st in enumerate(new_pending_stops):
                if str(st.get("rideId")) == r_id:
                    target_idx = idx
                    break

        if target_idx >= 0:
            stops_before_you = target_idx
            route_stops = new_pending_stops[:target_idx + 1]
            pts = [driver_pos] + [(float(s["lat"]), float(s["lng"])) for s in route_stops]
            route_polyline_encoded = encode_polyline(pts)
        else:
            stops_before_you = 0
            route_polyline_encoded = ""

        drop_idx = len(new_pending_stops)
        for idx, st in enumerate(new_pending_stops):
            if str(st.get("rideId")) == r_id and st.get("kind") == "drop":
                drop_idx = idx
                break

        next_pickup = None
        for st in new_pending_stops[:drop_idx]:
            if st.get("kind") == "pickup" and str(st.get("rideId")) != r_id:
                next_pickup = {
                    "lat": float(st.get("lat") or 0.0),
                    "lng": float(st.get("lng") or 0.0),
                    "etaIso": st.get("etaIso"),
                }
                break

        shared_info_by_ride[r_id] = {
            "parentTripId": parent_trip.get("tripId"),
            "seatOrder": cr.get("seatOrder") or (cr.get("sharedInfo") or {}).get("seatOrder", 1),
            "baselineEtaIso": cr.get("baselineEtaIso") or (cr.get("sharedInfo") or {}).get("baselineEtaIso") or eta_iso,
            "etaIso": eta_iso,
            "delayMin": delay_val,
            "ridersOnboard": riders_onboard_total,
            "newRiderJoining": new_rider_joining,
            "seatsOccupied": seats_used,
            "message": msg,
            "routePolyline": route_polyline_encoded,
            "nextPickup": next_pickup,
            "stopsBeforeYou": stops_before_you,
        }

    return full_stops, shared_info_by_ride

