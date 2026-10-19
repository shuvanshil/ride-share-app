"""Unit tests for pure distance disparity reconciliation engine."""
import pytest
from api.core.distance_reconciliation import (
    reconcile_ride_distance,
    STATUS_AUTO_ACCEPTED,
    STATUS_AUTO_RESOLVED,
    STATUS_UNDER_REVIEW,
)


def _good_data():
    return {
        "n_samples": 20,
        "coverage": 0.95,
        "max_gap_s": 30.0,
        "last_sample_age_s": 15.0,
    }


def test_rule_1_mock_location_forces_under_review():
    inputs = {
        "P": 10.0,
        "T": 10.0,
        "C0": 10.0,
        "mock_location": True,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_UNDER_REVIEW
    assert res.method == "MOCK_LOCATION"
    assert "MOCK_LOCATION" in res.reason_codes
    assert res.final_km is None
    assert res.provisional_km == 10.0


def test_rule_2_internal_error_forces_under_review():
    class BrokenDict:
        def __contains__(self, key):
            raise RuntimeError("Unexpected failure checking key")

        def get(self, key, default=None):
            raise RuntimeError("Unexpected failure reading key")

    res = reconcile_ride_distance(BrokenDict())
    assert res.status == STATUS_UNDER_REVIEW
    assert res.method == "INTERNAL_ERROR"
    assert res.final_km is None


def test_rule_3_green_band_auto_accepts():
    # GREEN: 0.90*P <= T <= P + 0.5 km
    inputs = {
        "P": 10.0,
        "T": 9.5,
        "C0": 10.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 10.0
    assert res.method == "GREEN_BAND"


def test_rule_3_green_band_boundary_lower():
    # 0.90 * 10 = 9.0
    inputs = {
        "P": 10.0,
        "T": 9.0,
        "C0": 10.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 10.0


def test_rule_3_green_band_boundary_upper():
    # 10 + 0.5 = 10.5
    inputs = {
        "P": 10.0,
        "T": 10.5,
        "C0": 10.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 10.0


def test_rule_4_zero_travel_with_good_data_auto_resolves_zero():
    inputs = {
        "P": 10.0,
        "T": 0.02, # <= 0.05 km
        "C0": 0.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_RESOLVED
    assert res.final_km == 0.0
    assert res.method == "ZERO_TRAVEL_CONFIRMED"


def test_rule_4_zero_travel_with_poor_data_goes_under_review():
    inputs = {
        "P": 10.0,
        "T": 0.01,
        "C0": 0.0,
        # missing / unknown quality -> counts as poor
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_UNDER_REVIEW
    assert res.final_km is None
    assert res.method == "NO_RELIABLE_TRACKING"


def test_rule_5_amber_under_with_good_data_and_plausible_speed_auto_accepts():
    # AMBER under: 0.60*P <= T < 0.90*P (e.g. P=10, T=8.0)
    # D = 20 min -> v = 8 / (20/60) = 24 km/h (plausible: 3..70)
    inputs = {
        "P": 10.0,
        "T": 8.0,
        "C0": 8.0,
        "D": 20.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 8.0
    assert res.method == "AMBER_BAND"


def test_rule_5_amber_over_with_good_data_and_plausible_speed_auto_accepts():
    # AMBER over: P + 0.5 < T <= P + max(2.0, 0.5*P) -> 10.5 < T <= 15.0
    inputs = {
        "P": 10.0,
        "T": 11.2,
        "C0": 11.2,
        "D": 30.0, # 11.2 / 0.5 = 22.4 km/h
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 11.2
    assert res.method == "AMBER_BAND"


def test_rule_6a_red_under_post_pickup_cancellation_auto_resolves():
    # T < 0.60 * P (e.g. P=10, T=3.0)
    # terminated_by is post-pickup cancellation, data not poor, plausible speed
    inputs = {
        "P": 10.0,
        "T": 3.0,
        "C0": 3.0,
        "D": 8.0, # 3.0 / (8/60) = 22.5 km/h
        "terminated_by": "passenger_cancel",
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_RESOLVED
    assert res.final_km == 3.0
    assert res.method == "EARLY_END_TRACKED"


def test_rule_6b_red_under_driver_complete_time_proximity_fill():
    # driver_complete, data poor, but reached within 300m and plausible time ratio
    # P = 10, PD = 30 min (or derived from 20 km/h = 30 min). D = 25 min (within 0.5x..2.5x of PD)
    inputs = {
        "P": 10.0,
        "T": 1.0, # GPS stopped updating early
        "C0": 1.0,
        "D": 25.0,
        "PD": 30.0,
        "terminated_by": "driver_complete",
        "final_dist_to_drop_m": 120.0, # <= 300
        # data poor: no samples or n_samples < 5
        "n_samples": 2,
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_RESOLVED
    assert res.final_km == 10.0 # final_km = P
    assert res.method == "TIME_PROXIMITY_FILL"


def test_rule_6c_red_under_uncorroborated_goes_under_review():
    # driver_complete, but dropped far away (e.g. 1500m)
    inputs = {
        "P": 10.0,
        "T": 1.0,
        "C0": 1.0,
        "D": 25.0,
        "PD": 30.0,
        "terminated_by": "driver_complete",
        "final_dist_to_drop_m": 1500.0, # > 300
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_UNDER_REVIEW
    assert res.final_km is None
    assert res.method == "UNDER_TRAVEL_UNCORROBORATED"


def test_rule_7_red_over_with_passenger_confirmation():
    # RED over: T > P + max(2.0, 0.5*P) -> T > 15.0 for P=10
    inputs = {
        "P": 10.0,
        "T": 16.5,
        "C0": 16.5,
        "D": 35.0, # 16.5 / (35/60) = 28.3 km/h
        "passenger_confirmed": True,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_RESOLVED
    assert res.final_km == 16.5
    assert res.method == "OVER_TRAVEL_PASSENGER_CONFIRMED"


def test_rule_7_red_over_without_passenger_confirmation_goes_under_review():
    inputs = {
        "P": 10.0,
        "T": 16.5,
        "C0": 16.5,
        "D": 35.0,
        "passenger_confirmed": False,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_UNDER_REVIEW
    assert res.final_km is None
    assert res.method == "OVER_TRAVEL_UNCORROBORATED"


def test_edge_case_zero_planned_distance():
    # P = 0, T = 0
    inputs = {
        "P": 0.0,
        "T": 0.0,
        "C0": 0.0,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_RESOLVED
    assert res.final_km == 0.0
    assert res.method == "ZERO_TRAVEL_CONFIRMED"


def test_edge_case_short_trip_under_1km():
    # P = 0.8 km, T = 0.75 km (0.75 / 0.8 = 93.75% -> GREEN band)
    inputs = {
        "P": 0.8,
        "T": 0.75,
        "C0": 0.8,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.final_km == 0.8


def test_edge_case_tiny_duration_speed_skips_when_tiny_t():
    # T < 0.2 km, D is tiny (0.1 min)
    inputs = {
        "P": 0.15,
        "T": 0.12,
        "C0": 0.15,
        "D": 0.05,
        **_good_data(),
    }
    res = reconcile_ride_distance(inputs)
    # GREEN band since 0.9*0.15 = 0.135; wait, T=0.12 < 0.135 -> AMBER under!
    # Since T < 0.2, speed plausible check is skipped (passes) -> AMBER_BAND auto accepts
    assert res.status == STATUS_AUTO_ACCEPTED
    assert res.method == "AMBER_BAND"
