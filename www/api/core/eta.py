"""Two-tier ETA provider for dispatch pre-ranking and shortlisted pairs."""
from __future__ import annotations

import math
import time
from typing import Any, Optional
import httpx

from .config import get_env
from .dispatch_config import DispatchConfig, load_dispatch_config
from .geo import haversine_km

# In-memory short-lived route cache: (round(lat1, 3), round(lng1, 3), round(lat2, 3), round(lng2, 3)) -> (eta_minutes, timestamp)
_ROUTE_CACHE: dict[tuple[float, float, float, float], tuple[float, float]] = {}
_ROUTE_CACHE_TTL = 60.0


def compute_cheap_eta_minutes(
    driver_lat: float,
    driver_lng: float,
    pickup_lat: float,
    pickup_lng: float,
    driver_location_age_sec: float = 0.0,
    notification_eligible_until_valid: bool = True,
    config: Optional[DispatchConfig] = None,
) -> float:
    """Compute Tier-1 cheap ETA with road factor and age penalty."""
    cfg = config or load_dispatch_config()
    dist_km = haversine_km(driver_lat, driver_lng, pickup_lat, pickup_lng)
    road_km = dist_km * cfg.cheap_road_factor
    travel_minutes = (road_km / cfg.cheap_speed_kmh) * 60.0

    # Age penalty:
    age_penalty = 0.0
    if 30.0 < driver_location_age_sec <= 60.0:
        age_penalty = (driver_location_age_sec - 30.0) / 30.0
    elif 60.0 < driver_location_age_sec <= cfg.max_location_age_seconds_with_push:
        if notification_eligible_until_valid:
            age_penalty = 5.0
        else:
            age_penalty = 15.0
    elif driver_location_age_sec > cfg.max_location_age_seconds_with_push:
        age_penalty = 999.0

    return max(1.0, travel_minutes + age_penalty)


async def compute_accurate_eta_minutes(
    driver_lat: float,
    driver_lng: float,
    pickup_lat: float,
    pickup_lng: float,
    timeout_ms: int = 300,
) -> Optional[float]:
    """Tier-2 high accuracy routing ETA with Google Routes API, caching, and fast fallback."""
    now = time.time()
    cache_key = (
        round(driver_lat, 3),
        round(driver_lng, 3),
        round(pickup_lat, 3),
        round(pickup_lng, 3),
    )

    cached = _ROUTE_CACHE.get(cache_key)
    if cached and (now - cached[1]) < _ROUTE_CACHE_TTL:
        return cached[0]

    key = get_env("GOOGLE_MAPS_SERVER_KEY")
    if not key:
        return None

    try:
        timeout_sec = timeout_ms / 1000.0
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_sec, connect=min(0.2, timeout_sec))) as client:
            resp = await client.post(
                "https://routes.googleapis.com/directions/v2:computeRoutes",
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": key,
                    "X-Goog-FieldMask": "routes.duration",
                },
                json={
                    "origin": {"location": {"latLng": {"latitude": driver_lat, "longitude": driver_lng}}},
                    "destination": {"location": {"latLng": {"latitude": pickup_lat, "longitude": pickup_lng}}},
                    "travelMode": "DRIVE",
                    "routingPreference": "TRAFFIC_UNAWARE",
                    "computeAlternativeRoutes": False,
                },
            )
            if resp.is_success:
                data = resp.json()
                routes = data.get("routes") or []
                if routes and routes[0].get("duration"):
                    dur_str = str(routes[0]["duration"]).rstrip("s")
                    dur_minutes = max(1.0, float(dur_str) / 60.0)
                    _ROUTE_CACHE[cache_key] = (dur_minutes, now)
                    return dur_minutes
    except Exception:
        pass

    return None
