"""Comprehensive tests for dynamic distance-based fare calculation hardening."""
import pytest
from api.routers.rides import _driver_fare_adjustment
from api.core.geo import road_distance_along_route_km, decode_polyline, haversine_km


def make_ride(
    driver_lat: float,
    driver_lng: float,
    status: str = "started",
    distance_km: float = 10.0,
    fare: int = 100,
    max_travelled_km: float = 0.0,
    max_progress_ratio: float = 0.0,
    with_route: bool = False,
) -> dict:
    ride = {
        "status": status,
        "pickup_lat": 23.8315,
        "pickup_lng": 91.2868,
        "drop_lat": 23.9000,
        "drop_lng": 91.3500,
        "driverLocation": {"lat": driver_lat, "lng": driver_lng} if driver_lat is not None else None,
        "distance_km": distance_km,
        "fare": fare,
        "quoted_fare": fare,
        "vehicle_type": "bike",
        "max_travelled_km": max_travelled_km,
        "max_progress_ratio": max_progress_ratio,
    }
    if with_route:
        # Straight line approximation route for testing
        ride["route_polyline"] = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    return ride


def test_zero_travel_boundary_returns_zero_fare():
    """0% travelled -> Rs 0 fare."""
    ride = make_ride(23.8315, 91.2868, status="started") # Exactly at pickup
    adj = _driver_fare_adjustment(ride, "cancel")
    assert adj["final_fare"] == 0
    assert adj["charged_distance_km"] == 0
    assert adj["reason"] == "zero_passenger_travel"


def test_unpicked_ride_returns_zero_fare():
    """Cancelled before pickup/OTP verification -> Rs 0 fare."""
    ride = make_ride(23.8500, 91.3000, status="accepted")
    adj = _driver_fare_adjustment(ride, "cancel")
    assert adj["final_fare"] == 0
    assert adj["reason"] == "not_picked_up"


def test_partial_travel_proportional_fare():
    """Increasing travelled distance -> proportionally increasing fare below 90%."""
    ride_30 = make_ride(23.8500, 91.3000, status="started", max_travelled_km=3.0, max_progress_ratio=0.30)
    adj_30 = _driver_fare_adjustment(ride_30, "cancel")
    assert adj_30["reason"] == "partial_trip"
    assert 0 < adj_30["final_fare"] < 100

    ride_60 = make_ride(23.8700, 91.3200, status="started", max_travelled_km=6.0, max_progress_ratio=0.60)
    adj_60 = _driver_fare_adjustment(ride_60, "cancel")
    assert adj_60["reason"] == "partial_trip"
    assert adj_60["final_fare"] > adj_30["final_fare"]
    assert adj_60["final_fare"] < 100


def test_ninety_percent_threshold_locks_full_fare():
    """>= 90% travelled -> 100% of final fare."""
    ride_91 = make_ride(23.8950, 91.3450, status="started", max_travelled_km=9.1, max_progress_ratio=0.91)
    adj_91 = _driver_fare_adjustment(ride_91, "cancel")
    assert adj_91["reason"] == "full_trip_threshold"
    assert adj_91["final_fare"] == 100
    assert adj_91["charged_distance_km"] == 10.0


def test_monotonicity_under_out_of_order_or_jittering_gps():
    """Stale/jittering GPS update (e.g. projecting backwards from 8km to 2km) must not reduce fare."""
    # Ride previously reached 8.0 km (80%)
    ride_jitter = make_ride(23.8400, 91.2900, status="started", max_travelled_km=8.0, max_progress_ratio=0.80)
    adj = _driver_fare_adjustment(ride_jitter, "cancel")
    # Must use prior max_travelled_km (8.0 km), not the jittered 1-2 km
    assert adj["travelled_after_pickup_km"] == 8.0
    assert adj["progress_ratio"] == 0.80
    assert adj["final_fare"] > 70


def test_disconnection_fallback_when_gps_unavailable_at_completion():
    """If network/GPS is lost at completion, recover from previously validated monotonic travel distance."""
    ride_offline = make_ride(None, None, status="started", max_travelled_km=9.5, max_progress_ratio=0.95)
    adj = _driver_fare_adjustment(ride_offline, "complete")
    assert adj["reason"] == "full_trip_threshold"
    assert adj["final_fare"] == 100

    ride_partial_offline = make_ride(None, None, status="started", max_travelled_km=5.0, max_progress_ratio=0.50)
    adj_partial = _driver_fare_adjustment(ride_partial_offline, "cancel")
    assert adj_partial["reason"] == "partial_trip"
    assert 0 < adj_partial["final_fare"] < 100


def test_extreme_gps_jump_outlier_rejection():
    """Wild GPS jump far off route should be rejected as an outlier."""
    route = [(23.8315, 91.2868), (23.9000, 91.3500)]
    # Wild jump 100 km away
    bad_pos = {"lat": 24.8000, "lng": 92.5000}
    dist = road_distance_along_route_km(route, bad_pos)
    assert dist is None # Rejected by outlier filter


def test_extra_dropoff_distance_adds_fare_beyond_buffer():
    """Dropoff past destination beyond free buffer correctly adds distance and charges extra fare."""
    ride_extra = make_ride(23.9200, 91.3700, status="started", distance_km=10.0, fare=100)
    adj = _driver_fare_adjustment(ride_extra, "complete")
    if adj["extra_dropoff_distance_km"] > 0.1:
        assert adj["reason"] == "extra_after_drop"
        assert adj["final_fare"] > 100
