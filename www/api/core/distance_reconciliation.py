"""Distance disparity resolution and reconciliation engine.

Pure, side-effect-free distance reconciliation comparing planned distance (P),
GPS-travelled distance (T), and candidate charged distance (C0), guarded by
telemetry quality, plausible velocity, and proximity corroboration.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Optional, Sequence, Union

# Status Constants
STATUS_AUTO_ACCEPTED = "AUTO_ACCEPTED"
STATUS_AUTO_RESOLVED = "AUTO_RESOLVED"
STATUS_UNDER_REVIEW = "UNDER_REVIEW"

# Threshold Constants
GREEN_LOWER_RATIO: float = 0.90
GREEN_UPPER_DELTA_KM: float = 0.5

AMBER_UNDER_LOWER_RATIO: float = 0.60
AMBER_OVER_UPPER_BASE_KM: float = 2.0
AMBER_OVER_UPPER_RATIO: float = 0.5

RED_UNDER_RATIO: float = 0.60

ZERO_TRAVEL_THRESHOLD_KM: float = 0.05

POOR_DATA_MIN_SAMPLES: int = 5
POOR_DATA_MIN_COVERAGE: float = 0.60
POOR_DATA_MAX_GAP_S: float = 180.0
POOR_DATA_MAX_LAST_SAMPLE_AGE_S: float = 120.0

SPEED_MIN_KMH: float = 3.0
SPEED_MAX_KMH: float = 70.0
SPEED_SKIP_UNDER_T_KM: float = 0.2

PROXIMITY_MAX_DROP_M: float = 300.0

TIME_RATIO_MIN: float = 0.5
TIME_RATIO_MAX: float = 2.5
DEFAULT_SPEED_FOR_PD_KMH: float = 20.0

POST_PICKUP_CANCEL_ACTIONS = {
    "passenger_cancel",
    "driver_cancel",
    "cancelled_by_passenger",
    "cancelled_by_driver",
}


@dataclass(frozen=True)
class ReconciliationResult:
    status: str
    final_km: Optional[float]
    provisional_km: float
    method: str
    reason_codes: list[str]
    evidence: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)


def _safe_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _safe_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def reconcile_ride_distance(inputs: Union[Mapping[str, Any], Any]) -> ReconciliationResult:
    """Reconcile ride distance based on planned (P), travelled (T), and charged (C0).

    Pure, deterministic function with no side effects.
    """
    raw_inputs = inputs if hasattr(inputs, "get") else getattr(inputs, "__dict__", {})

    try:
        # Extract inputs
        raw_p = _safe_float(raw_inputs.get("P") if "P" in raw_inputs else raw_inputs.get("planned_km"))
        raw_t = _safe_float(raw_inputs.get("T") if "T" in raw_inputs else raw_inputs.get("travelled_km"))
        raw_c0 = _safe_float(raw_inputs.get("C0") if "C0" in raw_inputs else raw_inputs.get("provisional_km"))

        P = max(0.0, raw_p if raw_p is not None else 0.0)
        T = max(0.0, raw_t if raw_t is not None else 0.0)
        C0 = max(0.0, raw_c0 if raw_c0 is not None else 0.0)

        extra_past_drop_km = _safe_float(raw_inputs.get("extra_past_drop_km"))
        D = _safe_float(raw_inputs.get("D") if "D" in raw_inputs else raw_inputs.get("trip_minutes"))
        PD = _safe_float(raw_inputs.get("PD") if "PD" in raw_inputs else raw_inputs.get("planned_duration"))

        n_samples = _safe_int(raw_inputs.get("n_samples"))
        coverage = _safe_float(raw_inputs.get("coverage"))
        max_gap_s = _safe_float(raw_inputs.get("max_gap_s"))
        last_sample_age_s = _safe_float(raw_inputs.get("last_sample_age_s"))

        final_dist_to_drop_m = _safe_float(raw_inputs.get("final_dist_to_drop_m"))
        terminated_by = str(raw_inputs.get("terminated_by") or "").strip().lower() or None
        passenger_confirmed = raw_inputs.get("passenger_confirmed")
        if passenger_confirmed is not None:
            passenger_confirmed = bool(passenger_confirmed)
        mock_location = raw_inputs.get("mock_location")
        if mock_location is not None:
            mock_location = bool(mock_location)

        # Derived planned duration if unknown
        effective_pd = PD
        if effective_pd is None or effective_pd <= 0:
            if P > 0:
                effective_pd = (P / DEFAULT_SPEED_FOR_PD_KMH) * 60.0
            else:
                effective_pd = None

        # Data quality evaluation (UNKNOWN / None values count as poor)
        is_poor_data = (
            n_samples is None
            or coverage is None
            or max_gap_s is None
            or last_sample_age_s is None
            or n_samples < POOR_DATA_MIN_SAMPLES
            or coverage < POOR_DATA_MIN_COVERAGE
            or max_gap_s > POOR_DATA_MAX_GAP_S
            or last_sample_age_s > POOR_DATA_MAX_LAST_SAMPLE_AGE_S
        )

        # Plausible speed evaluation
        # Implied v = T / (D / 60) between 3 and 70 km/h (skip test when T < 0.2 km)
        speed_kmh: Optional[float] = None
        if D is not None and D > 0:
            speed_kmh = T / (D / 60.0)

        if T < SPEED_SKIP_UNDER_T_KM:
            speed_plausible = True
        elif speed_kmh is not None and SPEED_MIN_KMH <= speed_kmh <= SPEED_MAX_KMH:
            speed_plausible = True
        else:
            speed_plausible = False

        # Proximity check
        proximity_ok = (
            final_dist_to_drop_m is not None
            and final_dist_to_drop_m <= PROXIMITY_MAX_DROP_M
        )

        # Time ratio check: D within 0.5x to 2.5x of PD
        time_ratio_ok = False
        if D is not None and effective_pd is not None and effective_pd > 0:
            time_ratio_ok = (TIME_RATIO_MIN * effective_pd <= D <= TIME_RATIO_MAX * effective_pd)

        # Band identification
        amber_over_upper = P + max(AMBER_OVER_UPPER_BASE_KM, AMBER_OVER_UPPER_RATIO * P)
        is_green = (P > ZERO_TRAVEL_THRESHOLD_KM) and (GREEN_LOWER_RATIO * P <= T <= P + GREEN_UPPER_DELTA_KM)
        is_zero_travel = (T <= ZERO_TRAVEL_THRESHOLD_KM)
        is_amber_under = (not is_green) and (not is_zero_travel) and (AMBER_UNDER_LOWER_RATIO * P <= T < GREEN_LOWER_RATIO * P)
        is_amber_over = (not is_green) and (P + GREEN_UPPER_DELTA_KM < T <= amber_over_upper)
        is_red_under = (not is_zero_travel) and (T < RED_UNDER_RATIO * P)
        is_red_over = (T > amber_over_upper)

        band_name = "UNKNOWN"
        if is_zero_travel:
            band_name = "ZERO_TRAVEL"
        elif is_green:
            band_name = "GREEN"
        elif is_amber_under:
            band_name = "AMBER_UNDER"
        elif is_amber_over:
            band_name = "AMBER_OVER"
        elif is_red_under:
            band_name = "RED_UNDER"
        elif is_red_over:
            band_name = "RED_OVER"

        evidence = {
            "P": round(P, 3),
            "T": round(T, 3),
            "C0": round(C0, 3),
            "extra_past_drop_km": round(extra_past_drop_km, 3) if extra_past_drop_km is not None else None,
            "trip_minutes": round(D, 2) if D is not None else None,
            "planned_duration": round(PD, 2) if PD is not None else None,
            "effective_pd": round(effective_pd, 2) if effective_pd is not None else None,
            "n_samples": n_samples,
            "coverage": round(coverage, 3) if coverage is not None else None,
            "max_gap_s": round(max_gap_s, 1) if max_gap_s is not None else None,
            "last_sample_age_s": round(last_sample_age_s, 1) if last_sample_age_s is not None else None,
            "final_dist_to_drop_m": round(final_dist_to_drop_m, 1) if final_dist_to_drop_m is not None else None,
            "terminated_by": terminated_by,
            "passenger_confirmed": passenger_confirmed,
            "mock_location": mock_location,
            "is_poor_data": is_poor_data,
            "speed_kmh": round(speed_kmh, 2) if speed_kmh is not None else None,
            "speed_plausible": speed_plausible,
            "proximity_ok": proximity_ok,
            "time_ratio_ok": time_ratio_ok,
            "band": band_name,
        }

        # Rule 1: Mock-location flag true -> UNDER_REVIEW (MOCK_LOCATION)
        if mock_location is True:
            return ReconciliationResult(
                status=STATUS_UNDER_REVIEW,
                final_km=None,
                provisional_km=C0,
                method="MOCK_LOCATION",
                reason_codes=["MOCK_LOCATION"],
                evidence=evidence,
            )

        # Rule 3: GREEN band -> AUTO_ACCEPTED, final_km = C0
        if is_green:
            return ReconciliationResult(
                status=STATUS_AUTO_ACCEPTED,
                final_km=round(C0, 3),
                provisional_km=C0,
                method="GREEN_BAND",
                reason_codes=["GREEN_BAND"],
                evidence=evidence,
            )

        # Rule 4: ZERO_TRAVEL
        if is_zero_travel:
            if not is_poor_data:
                return ReconciliationResult(
                    status=STATUS_AUTO_RESOLVED,
                    final_km=0.0,
                    provisional_km=C0,
                    method="ZERO_TRAVEL_CONFIRMED",
                    reason_codes=["ZERO_TRAVEL_CONFIRMED"],
                    evidence=evidence,
                )
            return ReconciliationResult(
                status=STATUS_UNDER_REVIEW,
                final_km=None,
                provisional_km=C0,
                method="NO_RELIABLE_TRACKING",
                reason_codes=["NO_RELIABLE_TRACKING"],
                evidence=evidence,
            )

        # Rule 5: AMBER (under or over): if data not poor AND speed plausible -> AUTO_ACCEPTED, final_km = C0
        if is_amber_under or is_amber_over:
            if (not is_poor_data) and speed_plausible:
                return ReconciliationResult(
                    status=STATUS_AUTO_ACCEPTED,
                    final_km=round(C0, 3),
                    provisional_km=C0,
                    method="AMBER_BAND",
                    reason_codes=["AMBER_BAND"],
                    evidence=evidence,
                )
            # Otherwise treat as RED under or RED over respectively below

        # Rule 6: RED under (or AMBER failing step 5 with T < P)
        if is_red_under or (is_amber_under and ((is_poor_data) or not speed_plausible)):
            # 6a. post-pickup cancellation AND data not poor AND speed plausible -> AUTO_RESOLVED, final_km = T
            if terminated_by in POST_PICKUP_CANCEL_ACTIONS and (not is_poor_data) and speed_plausible:
                return ReconciliationResult(
                    status=STATUS_AUTO_RESOLVED,
                    final_km=round(T, 3),
                    provisional_km=C0,
                    method="EARLY_END_TRACKED",
                    reason_codes=["EARLY_END_TRACKED"],
                    evidence=evidence,
                )
            # 6b. driver_complete AND data poor AND ALL of (final_dist_to_drop_m <= 300, D within TIME_RATIO, no mock)
            if (
                terminated_by == "driver_complete"
                and is_poor_data
                and proximity_ok
                and time_ratio_ok
                and not mock_location
            ):
                return ReconciliationResult(
                    status=STATUS_AUTO_RESOLVED,
                    final_km=round(P, 3),
                    provisional_km=C0,
                    method="TIME_PROXIMITY_FILL",
                    reason_codes=["TIME_PROXIMITY_FILL"],
                    evidence=evidence,
                )
            # 6c. otherwise -> UNDER_REVIEW (UNDER_TRAVEL_UNCORROBORATED)
            return ReconciliationResult(
                status=STATUS_UNDER_REVIEW,
                final_km=None,
                provisional_km=C0,
                method="UNDER_TRAVEL_UNCORROBORATED",
                reason_codes=["UNDER_TRAVEL_UNCORROBORATED"],
                evidence=evidence,
            )

        # Rule 7: RED over (or AMBER over failing step 5)
        if is_red_over or (is_amber_over and ((is_poor_data) or not speed_plausible)):
            if (not is_poor_data) and speed_plausible and passenger_confirmed is True:
                return ReconciliationResult(
                    status=STATUS_AUTO_RESOLVED,
                    final_km=round(T, 3),
                    provisional_km=C0,
                    method="OVER_TRAVEL_PASSENGER_CONFIRMED",
                    reason_codes=["OVER_TRAVEL_PASSENGER_CONFIRMED"],
                    evidence=evidence,
                )
            return ReconciliationResult(
                status=STATUS_UNDER_REVIEW,
                final_km=None,
                provisional_km=C0,
                method="OVER_TRAVEL_UNCORROBORATED",
                reason_codes=["OVER_TRAVEL_UNCORROBORATED"],
                evidence=evidence,
            )

        # Fallback defensive under review
        return ReconciliationResult(
            status=STATUS_UNDER_REVIEW,
            final_km=None,
            provisional_km=C0,
            method="UNCORROBORATED_DISPARITY",
            reason_codes=["UNCORROBORATED_DISPARITY"],
            evidence=evidence,
        )

    except Exception as exc:  # noqa: BLE001
        # Rule 2: Any internal error/exception -> UNDER_REVIEW (INTERNAL_ERROR)
        fallback_c0 = 0.0
        try:
            raw_c0 = raw_inputs.get("C0") if "C0" in raw_inputs else raw_inputs.get("provisional_km")
            fallback_c0 = max(0.0, float(raw_c0 or 0.0))
        except Exception:
            pass

        safe_inputs = {k: str(v) for k, v in raw_inputs.items()} if hasattr(raw_inputs, "items") else {"repr": str(raw_inputs)}
        return ReconciliationResult(
            status=STATUS_UNDER_REVIEW,
            final_km=None,
            provisional_km=fallback_c0,
            method="INTERNAL_ERROR",
            reason_codes=["INTERNAL_ERROR"],
            evidence={"error": str(exc), "raw_inputs": safe_inputs},
        )
