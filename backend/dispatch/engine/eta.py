"""ETA estimation for dispatch pickup routing."""
from __future__ import annotations

from ..config import AVERAGE_SPEED_KMH
from .geo import haversine_km


def pickup_eta_minutes(
    driver_lat: float,
    driver_lon: float,
    pickup_lat: float,
    pickup_lon: float,
    avg_speed_kmh: float = AVERAGE_SPEED_KMH,
) -> float:
    """Estimate pickup arrival time in minutes using Haversine distance and regional average speed."""
    dist_km = haversine_km(driver_lat, driver_lon, pickup_lat, pickup_lon)
    if avg_speed_kmh <= 0:
        avg_speed_kmh = AVERAGE_SPEED_KMH
    eta = (dist_km / avg_speed_kmh) * 60.0
    return round(max(0.1, eta), 2)


def distance_and_eta(
    driver_loc: tuple[float, float],
    pickup_loc: tuple[float, float],
    avg_speed_kmh: float = AVERAGE_SPEED_KMH,
) -> tuple[float, float]:
    """Calculate both distance in km and ETA in minutes."""
    dist_km = haversine_km(driver_loc[0], driver_loc[1], pickup_loc[0], pickup_loc[1])
    if avg_speed_kmh <= 0:
        avg_speed_kmh = AVERAGE_SPEED_KMH
    eta = (dist_km / avg_speed_kmh) * 60.0
    return dist_km, round(max(0.1, eta), 2)
