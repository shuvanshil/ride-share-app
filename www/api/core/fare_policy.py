"""
Server-side fare policy -- the authoritative fare that is actually charged.

Single source of truth: this module and js/fare-policy.js both load the exact
same file, /fare-policy.config.json, at runtime, instead of each hard-coding
its own copy of the rate card. To change pricing (base fare, per-km rate,
service area, etc.) edit fare-policy.config.json only; no Python or JS code
needs to change, and the quoted (browser) and charged (server) fare can never
silently drift apart.

Fare formula (kept identical to js/fare-policy.js):
    fare = base_fare + (full_distance_to_destination_km * per_km_rate)
    fare = max(round(fare), min_fare)
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# www/api/core/fare_policy.py -> parents[2] is www/, where the shared config
# and the js/ folder both live.
_CONFIG_PATH = Path(__file__).resolve().parents[2] / "fare-policy.config.json"


def _load_config() -> dict[str, Any]:
    with _CONFIG_PATH.open("r", encoding="utf-8") as config_file:
        return json.load(config_file)


_CONFIG = _load_config()
_NIGHT_FARE_CONFIG = _CONFIG.get("nightFare") or {}

# Distance is always in kilometers (km) and money is always in INR (rupees)
# unless a field name says otherwise -- see fare-policy.config.json's "_docs"
# for the full description, accepted units, and example value of each field.
MAX_SERVICEABLE_DISTANCE_KM: float = float(_CONFIG["maxServiceableDistanceKm"])
FULL_FARE_PROGRESS_RATIO: float = float(_CONFIG["fullFareProgressRatio"])
FREE_DROPOFF_EXTRA_KM: float = float(_CONFIG["freeDropoffExtraKmKm"])
ZERO_TRAVEL_THRESHOLD_KM: float = float(_CONFIG["zeroTravelThresholdKm"])


def _fare_timezone():
    timezone_name = str(_NIGHT_FARE_CONFIG.get("timezone") or "Asia/Kolkata")
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        if timezone_name == "Asia/Kolkata":
            return timezone(timedelta(hours=5, minutes=30))
        return timezone.utc


FARE_TIMEZONE = _fare_timezone()


def _parse_clock_minutes(value: Any, fallback: int) -> int:
    try:
        hours_text, minutes_text = str(value or "").split(":", 1)
        hours = int(hours_text)
        minutes = int(minutes_text)
    except (TypeError, ValueError):
        return fallback
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        return fallback
    return (hours * 60) + minutes


NIGHT_FARE_START_MINUTES = _parse_clock_minutes(_NIGHT_FARE_CONFIG.get("start"), 22 * 60)
NIGHT_FARE_END_MINUTES = _parse_clock_minutes(_NIGHT_FARE_CONFIG.get("end"), (4 * 60) + 30)

# Keyed by lowercase vehicleType (e.g. "bike", "auto"), matching the frontend.
RIDE_SERVICES: dict[str, dict[str, Any]] = {
    service_id: {
        "name": service["name"],
        "shortName": service.get("shortName", service["name"]),
        "capacity": service.get("capacity", 1),
        "base": float(service["baseFare"]),
        "per_km": float(service["perKmRate"]),
        "normal_per_km": float(service["perKmRate"]),
        "night_per_km": float(service.get("nightPerKmRate", service["perKmRate"])),
        "min_fare": float(service["minFare"]),
    }
    for service_id, service in _CONFIG["services"].items()
}


def get_ride_service(vehicle_type: str) -> dict[str, Any] | None:
    return RIDE_SERVICES.get(str(vehicle_type or "").strip().lower())


def is_night_fare_time(requested_at: datetime | None = None) -> bool:
    request_time = requested_at or datetime.now(FARE_TIMEZONE)
    if request_time.tzinfo is None:
        request_time = request_time.replace(tzinfo=FARE_TIMEZONE)
    else:
        request_time = request_time.astimezone(FARE_TIMEZONE)

    request_minutes = (request_time.hour * 60) + request_time.minute
    if NIGHT_FARE_START_MINUTES <= NIGHT_FARE_END_MINUTES:
        return NIGHT_FARE_START_MINUTES <= request_minutes < NIGHT_FARE_END_MINUTES
    return request_minutes >= NIGHT_FARE_START_MINUTES or request_minutes < NIGHT_FARE_END_MINUTES


def get_service_fare_policy(vehicle_type: str, requested_at: datetime | None = None) -> dict[str, Any] | None:
    service = get_ride_service(vehicle_type)
    if not service:
        return None

    night_fare = is_night_fare_time(requested_at)
    return {
        **service,
        "per_km": service["night_per_km"] if night_fare else service["normal_per_km"],
        "is_night_fare": night_fare,
    }


def is_distance_serviceable(distance_km: float) -> bool:
    try:
        distance = float(distance_km)
    except (TypeError, ValueError):
        return False
    return distance == distance and 0 <= distance <= MAX_SERVICEABLE_DISTANCE_KM  # noqa: PLR0124 (NaN guard)


def calculate_fare(service: dict[str, Any], distance_km: float) -> int:
    """fare = base_fare + (full distance_km * per_km_rate), floored at min_fare."""
    distance = max(0.0, float(distance_km))
    fare = service["base"] + (distance * service["per_km"])
    return max(round(fare), round(service["min_fare"]))
