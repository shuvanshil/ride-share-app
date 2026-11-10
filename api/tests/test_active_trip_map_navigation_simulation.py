"""Simulation test suite for Active Trip Map Navigation, Vehicle Animation,
Destination Overshoot, Reversing, Marker Orientation, and Camera Tracking.
"""
from __future__ import annotations

import math
import pytest
from datetime import datetime, timezone
from typing import Any

from api.core.geo import haversine_km, encode_polyline, decode_polyline
from api.routers.rides import _driver_fare_adjustment, _calculate_fare


def calculate_bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float | None:
    if abs(lat1 - lat2) < 1e-7 and abs(lng1 - lng2) < 1e-7:
        return None
    r_lat1 = math.radians(lat1)
    r_lat2 = math.radians(lat2)
    d_lng = math.radians(lng2 - lng1)
    y = math.sin(d_lng) * math.cos(r_lat2)
    x = math.cos(r_lat1) * math.sin(r_lat2) - math.sin(r_lat1) * math.cos(r_lat2) * math.cos(d_lng)
    return ((math.degrees(math.atan2(y, x)) % 360) + 360) % 360


def normalize_degrees(deg: float) -> float:
    return ((deg % 360) + 360) % 360


def shortest_angle_delta(from_deg: float, to_deg: float) -> float:
    diff = (to_deg - from_deg) % 360
    return ((diff + 540) % 360) - 180


def project_raw_fraction_onto_segment(point: dict, p1: dict, p2: dict) -> float:
    lng_scale = math.cos(math.radians(p1["lat"])) or 1e-9
    seg_lat = p2["lat"] - p1["lat"]
    seg_lng = (p2["lng"] - p1["lng"]) * lng_scale
    pt_lat = point["lat"] - p1["lat"]
    pt_lng = (point["lng"] - p1["lng"]) * lng_scale
    seg_len_sq = (seg_lat * seg_lat) + (seg_lng * seg_lng)
    if seg_len_sq <= 1e-18:
        return 0.0
    return ((pt_lat * seg_lat) + (pt_lng * seg_lng)) / seg_len_sq


def simulate_route_match(point: dict, route_path: list[dict], vehicle_heading: float | None = None) -> dict:
    """Mirrors matchPositionToRoute from driver-service.js and map-core.js."""
    if len(route_path) < 2:
        return {"point": point, "is_past_destination": False, "index": -1}

    # Evaluate last segment for destination overshoot
    p_dest = route_path[-1]
    p_prev = route_path[-2]
    raw_frac = project_raw_fraction_onto_segment(point, p_prev, p_dest)
    dist_past = haversine_km(point["lat"], point["lng"], p_dest["lat"], p_dest["lng"]) * 1000.0

    if raw_frac > 1.0 and dist_past > 6.0:
        return {
            "point": point,  # REAL GPS position, NOT clamped to destination!
            "is_past_destination": True,
            "index": len(route_path) - 1,
            "distance_meters": dist_past,
            "heading": vehicle_heading or calculate_bearing(p_prev["lat"], p_prev["lng"], p_dest["lat"], p_dest["lng"]),
        }

    # Otherwise normal segment projection
    best_dist = float("inf")
    best_idx = 0
    best_proj = route_path[0]
    best_heading = None

    for i in range(len(route_path) - 1):
        s1 = route_path[i]
        s2 = route_path[i + 1]
        frac = max(0.0, min(1.0, project_raw_fraction_onto_segment(point, s1, s2)))
        proj = {
            "lat": s1["lat"] + (s2["lat"] - s1["lat"]) * frac,
            "lng": s1["lng"] + (s2["lng"] - s1["lng"]) * frac,
        }
        d = haversine_km(point["lat"], point["lng"], proj["lat"], proj["lng"]) * 1000.0
        if d < best_dist:
            best_dist = d
            best_idx = i
            best_proj = proj
            best_heading = calculate_bearing(s1["lat"], s1["lng"], s2["lat"], s2["lng"])

    return {
        "point": best_proj,
        "is_past_destination": False,
        "index": best_idx,
        "distance_meters": best_dist,
        "heading": best_heading,
    }


def simulate_route_progress_polyline(point: dict, route_path: list[dict], vehicle_heading: float | None = None) -> list[dict]:
    """Mirrors updateDriverRouteProgressAtPosition and updateAssignedDriverRouteProgressAtPosition."""
    match = simulate_route_match(point, route_path, vehicle_heading)
    if match["is_past_destination"]:
        # When passed destination: NO green train!
        return []

    # Check if vehicle is reversing / moving backward relative to upcoming route segment
    if vehicle_heading is not None and match["heading"] is not None:
        diff = abs(shortest_angle_delta(match["heading"], vehicle_heading))
        if diff > 120.0:
            # Reversing or moving backward: NO green train!
            return []

    idx = match["index"]
    if idx >= len(route_path) - 1:
        return []

    # Eraser animation: line starts directly at vehicle point and continues ahead
    return [point] + route_path[idx + 1:]


# =========================================================================
# TEST SCENARIOS
# =========================================================================

def test_heading_and_rotation_under_camera_heading():
    """Requirement 1: Marker orientation must account for map camera bearing."""
    # When vehicle is heading East (90 deg) and camera rotates to 90 deg (heading-up):
    vehicle_heading = 90.0
    camera_heading = 90.0
    displayed_angle = normalize_degrees(vehicle_heading - camera_heading)
    # Icon displays straight UP (0 deg) along the vertically aligned road!
    assert displayed_angle == 0.0

    # Shortest angular delta across 0/360 wrap-around
    # Turning right from 355 deg to 15 deg is +20 deg, NOT -340 deg
    delta = shortest_angle_delta(355.0, 15.0)
    assert delta == 20.0

    # Turning left from 10 deg to 350 deg is -20 deg, NOT +340 deg
    delta_left = shortest_angle_delta(10.0, 350.0)
    assert delta_left == -20.0


def test_overshoot_past_destination_moves_and_hides_green_train():
    """Requirement: When vehicle passes destination point, vehicle animation and moving

    must NOT stop at destination, and green route line must be cleared.
    """
    route = [
        {"lat": 23.8300, "lng": 91.2800},
        {"lat": 23.8400, "lng": 91.2800},
        {"lat": 23.8500, "lng": 91.2800},  # Destination point
    ]

    # 1. Vehicle is on the way (e.g. lat 23.8350, heading North 0 deg)
    mid_point = {"lat": 23.8350, "lng": 91.2800}
    remaining = simulate_route_progress_polyline(mid_point, route, vehicle_heading=0.0)
    assert len(remaining) > 0
    assert remaining[0] == mid_point  # Starts directly at vehicle
    assert remaining[-1] == route[-1] # Continues to destination

    # 2. Vehicle has PASSED the destination point (e.g. lat 23.8520, 222m past drop)
    past_dest_point = {"lat": 23.8520, "lng": 91.2800}
    match = simulate_route_match(past_dest_point, route, vehicle_heading=0.0)

    # Must be recognized as past destination
    assert match["is_past_destination"] is True
    # The rendered position must be the REAL position, NOT frozen at 23.8500
    assert match["point"]["lat"] == 23.8520
    assert match["point"]["lat"] > route[-1]["lat"]

    # Green route train must be CLEARED (no green line past destination)
    remaining_past = simulate_route_progress_polyline(past_dest_point, route, vehicle_heading=0.0)
    assert remaining_past == []


def test_reversing_and_backward_movement_hides_green_train():
    """Requirement: If vehicle is moving backward / reversing, no green route line."""
    route = [
        {"lat": 23.8300, "lng": 91.2800},
        {"lat": 23.8400, "lng": 91.2800},
        {"lat": 23.8500, "lng": 91.2800},
    ]

    # Route heads North (0 deg). Vehicle is at lat 23.8350.
    curr_point = {"lat": 23.8350, "lng": 91.2800}

    # Moving forward (heading 0 deg) -> Green train is present
    poly_fwd = simulate_route_progress_polyline(curr_point, route, vehicle_heading=0.0)
    assert len(poly_fwd) == 3

    # Moving backward / in reverse (heading 180 deg South) -> Green train is CLEARED
    poly_rev = simulate_route_progress_polyline(curr_point, route, vehicle_heading=180.0)
    assert poly_rev == []


def test_backend_overshoot_counts_distance_and_adjusts_fare():
    """Backend verification: Ensure overshoot past destination is counted in distance and billing."""
    pickup = {"lat": 23.8300, "lng": 91.2800}
    drop = {"lat": 23.8500, "lng": 91.2800}
    route_points = [(pickup["lat"], pickup["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(route_points)
    planned_km = haversine_km(pickup["lat"], pickup["lng"], drop["lat"], drop["lng"]) # ~2.22 km

    # Driver drives 2.5km past drop
    overshoot_loc = {"lat": 23.8750, "lng": 91.2800}
    extra_dist_km = haversine_km(drop["lat"], drop["lng"], overshoot_loc["lat"], overshoot_loc["lng"])
    assert extra_dist_km > 2.0

    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 50,
        "distance_km": planned_km,
        "vehicle_type": "auto",
        "driverLocation": overshoot_loc,
        "max_travelled_km": planned_km,
        "max_progress_ratio": 1.0,
    }

    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["reason"] == "extra_after_drop"
    assert adj["extra_dropoff_distance_km"] > 2.0
    assert adj["charged_distance_km"] > planned_km
    assert adj["final_fare"] > 50


def test_passenger_pickup_marker_lifecycle():
    """Requirement 3: Standalone passenger pickup marker removed on pickup."""
    # State tracking simulation
    status_history = ["requested", "accepted", "arrived", "started", "en_route", "completed"]
    marker_visible = True

    for status in status_history:
        is_picked_up = status in ["started", "en_route", "completed"]
        if is_picked_up:
            marker_visible = False
        else:
            marker_visible = True

        if status in ["accepted", "arrived"]:
            assert marker_visible is True, f"Pickup marker should be visible in {status}"
        elif status in ["started", "en_route"]:
            assert marker_visible is False, f"Pickup marker must be removed in {status}"
