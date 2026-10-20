from __future__ import annotations

import math
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.core.geo import encode_polyline, haversine_km
from api.index import app
from api.routers.rides import _driver_fare_adjustment, current_user


def test_scenario_1_leg_transition_target_markers():
    """Scenario 1: Leg transition correctly separates pickup approach vs destination route."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    drop = {"lat": 23.8580, "lng": 91.2980}
    pts = [(pickup["lat"], pickup["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(pts)

    ride = {
        "status": "accepted",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 55,
        "distance_km": 3.0,
        "vehicle_type": "auto",
        "driverLocation": {"lat": 23.8315, "lng": 91.2868}, # Driver at base
    }

    # Approach leg - passenger has not boarded yet
    adj_approach = _driver_fare_adjustment(ride, "cancel")
    assert adj_approach["reason"] == "not_picked_up"
    assert adj_approach["final_fare"] == 0

    # Boarding & start
    ride["status"] = "started"
    ride["driverLocation"] = {"lat": pickup["lat"], "lng": pickup["lng"]}
    adj_start = _driver_fare_adjustment(ride, "complete")
    assert adj_start["travelled_after_pickup_km"] <= 0.05


def test_scenario_2a_normal_arrival_charges_quoted_fare():
    """Scenario 2A: Arrival within 100m free buffer charges exactly quoted fare."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    drop = {"lat": 23.8580, "lng": 91.2980}
    pts = [(pickup["lat"], pickup["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(pts)

    # Driver completes 35m from drop pin
    driver_at_drop = {"lat": drop["lat"] + 0.0002, "lng": drop["lng"] + 0.0002}
    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 55,
        "distance_km": 2.94,
        "vehicle_type": "auto",
        "driverLocation": driver_at_drop,
        "max_travelled_km": 2.94,
        "max_progress_ratio": 1.0,
    }

    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["reason"] == "full_trip_threshold"
    assert adj["final_fare"] == 55
    assert adj["extra_dropoff_distance_km"] == 0.0


def test_scenario_2b_destination_overshoot_applies_surcharge():
    """Scenario 2B: Dropoff 780m past destination adds billable distance and overshoot surcharge."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    drop = {"lat": 23.8580, "lng": 91.2980}
    pts = [(pickup["lat"], pickup["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(pts)

    # Overshoot 780m past drop
    overshoot_loc = {"lat": drop["lat"] + 0.0060, "lng": drop["lng"] + 0.0040}
    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 55,
        "distance_km": 2.94,
        "vehicle_type": "auto",
        "driverLocation": overshoot_loc,
        "max_travelled_km": 2.94,
        "max_progress_ratio": 1.0,
    }

    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["reason"] == "extra_after_drop"
    assert adj["extra_dropoff_distance_km"] > 0.5
    assert adj["charged_distance_km"] > 2.94
    assert adj["final_fare"] > 55
    assert "Drop was" in adj["message"]


def test_scenario_2c_overshoot_loop_and_return_no_penalty():
    """Scenario 2C: Overshoot loop where driver returns and drops at destination charges quoted fare."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    drop = {"lat": 23.8580, "lng": 91.2980}
    pts = [(pickup["lat"], pickup["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(pts)

    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 55,
        "distance_km": 2.94,
        "vehicle_type": "auto",
        "driverLocation": drop,
        "max_travelled_km": 3.6, # Monotonic travel accumulated the loop
        "max_progress_ratio": 1.0,
    }

    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["reason"] == "full_trip_threshold"
    assert adj["final_fare"] == 55
    assert adj["extra_dropoff_distance_km"] == 0.0


def test_scenario_2d_fare_rounding_and_monotinicity():
    """Scenario 2D: Fare must always be an integer and never decrease on terminal complete."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    drop = {"lat": 23.8580, "lng": 91.2980}
    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "fare": 55,
        "distance_km": 2.94,
        "vehicle_type": "auto",
        "driverLocation": drop,
        "max_travelled_km": 2.94,
        "max_progress_ratio": 1.0,
    }
    adj = _driver_fare_adjustment(ride, "complete")
    assert isinstance(adj["final_fare"], int)
    assert adj["final_fare"] >= 55


def test_scenario_2e_curved_route_early_dropoff_no_overshoot_surcharge():
    """Scenario 2E: Dropping off early (e.g. 150m-400m before drop) on a curved route must NOT apply overshoot surcharge."""
    pickup = {"lat": 23.8360, "lng": 91.2820}
    intermediate = {"lat": 23.8500, "lng": 91.2950}
    drop = {"lat": 23.8450, "lng": 91.2900}
    pts = [(pickup["lat"], pickup["lng"]), (intermediate["lat"], intermediate["lng"]), (drop["lat"], drop["lng"])]
    poly = encode_polyline(pts)

    # Driver stops 150m BEFORE drop
    early_drop_loc = {"lat": 23.8460, "lng": 91.2910}
    ride = {
        "status": "started",
        "pickup_lat": pickup["lat"],
        "pickup_lng": pickup["lng"],
        "drop_lat": drop["lat"],
        "drop_lng": drop["lng"],
        "route_polyline": poly,
        "fare": 55,
        "distance_km": 3.0,
        "vehicle_type": "auto",
        "driverLocation": early_drop_loc,
        "max_travelled_km": 2.85,
        "max_progress_ratio": 0.95,
    }

    adj = _driver_fare_adjustment(ride, "complete")
    assert adj["reason"] == "full_trip_threshold"
    assert adj["final_fare"] == 55
    assert adj["extra_dropoff_distance_km"] == 0.0
    assert "Drop was" not in adj["message"]

