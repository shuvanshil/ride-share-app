"""Spatial indexing, geometric grid hashing, and ETA estimation."""
from __future__ import annotations

import math
from typing import Any, Optional

from .dispatch_config import (
    DEFAULT_SPEED_KMH,
    DETOUR_FACTOR,
    GRID_SNAP_METERS,
    SPATIAL_INDEX_CELL_KM,
)


def haversine_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return r_km * c


def estimate_pickup_eta_minutes(
    driver_lat: float,
    driver_lng: float,
    pickup_lat: float,
    pickup_lng: float,
    detour_factor: float = DETOUR_FACTOR,
    speed_kmh: float = DEFAULT_SPEED_KMH,
) -> tuple[float, float]:
    """Returns (distance_km, eta_minutes)."""
    dist_km = haversine_distance_km(driver_lat, driver_lng, pickup_lat, pickup_lng)
    speed_kpm = speed_kmh / 60.0
    eta_min = (dist_km * detour_factor) / speed_kpm
    return dist_km, eta_min


def lat_lng_to_cell_id(lat: float, lng: float, cell_size_km: float = SPATIAL_INDEX_CELL_KM) -> str:
    lat_deg_step = cell_size_km / 111.32
    cx = int(math.floor(lat / lat_deg_step))
    cos_lat = max(0.01, math.cos(math.radians(cx * lat_deg_step)))
    lng_deg_step = cell_size_km / (111.32 * cos_lat)
    cy = int(math.floor(lng / lng_deg_step))
    return f"c_{cx}_{cy}"


def get_overlapping_cells_for_circle(
    center_lat: float,
    center_lng: float,
    radius_km: float,
    cell_size_km: float = SPATIAL_INDEX_CELL_KM,
) -> list[str]:
    lat_deg_step = cell_size_km / 111.32
    lat_delta = radius_km / 111.32

    min_lat, max_lat = center_lat - lat_delta, center_lat + lat_delta
    min_cx = int(math.floor(min_lat / lat_deg_step))
    max_cx = int(math.floor(max_lat / lat_deg_step))

    cells: list[str] = []
    for cx in range(min_cx - 1, max_cx + 2):
        cell_lat = cx * lat_deg_step
        cos_lat = max(0.01, math.cos(math.radians(cell_lat)))
        lng_deg_step = cell_size_km / (111.32 * cos_lat)
        lng_delta = radius_km / (111.32 * cos_lat)

        min_cy = int(math.floor((center_lng - lng_delta) / lng_deg_step))
        max_cy = int(math.floor((center_lng + lng_delta) / lng_deg_step))
        for cy in range(min_cy - 1, max_cy + 2):
            cells.append(f"c_{cx}_{cy}")
    return cells


def compute_zone_id(lat: float, lng: float, tier: int, grid_snap_meters: float = GRID_SNAP_METERS) -> str:
    lat_deg_step = grid_snap_meters / 111320.0
    lat_idx = int(round(lat / lat_deg_step))
    cos_lat = max(0.01, math.cos(math.radians(lat_idx * lat_deg_step)))
    lng_deg_step = grid_snap_meters / (111320.0 * cos_lat)
    lng_idx = int(round(lng / lng_deg_step))
    return f"z:{lat_idx}:{lng_idx}:t{tier}"


class SpatialGridIndex:
    """In-memory spatial hash index for fast candidate retrieval during matching passes."""

    def __init__(self, cell_size_km: float = SPATIAL_INDEX_CELL_KM):
        self.cell_size_km = cell_size_km
        self._grid: dict[str, list[dict[str, Any]]] = {}

    def insert(self, item_id: str, lat: float, lng: float, payload: dict[str, Any]) -> None:
        cell_id = lat_lng_to_cell_id(lat, lng, self.cell_size_km)
        record = {
            "id": item_id,
            "lat": lat,
            "lng": lng,
            "payload": payload,
        }
        self._grid.setdefault(cell_id, []).append(record)

    def query_radius(
        self,
        center_lat: float,
        center_lng: float,
        radius_km: float,
    ) -> list[dict[str, Any]]:
        eff_radius = radius_km + 0.05
        cells = get_overlapping_cells_for_circle(center_lat, center_lng, eff_radius, self.cell_size_km)
        lat_delta = eff_radius / 111.32
        cos_lat = max(0.01, math.cos(math.radians(center_lat)))
        lng_delta = eff_radius / (111.32 * cos_lat)

        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()
        for c in cells:
            for record in self._grid.get(c, []):
                rec_id = record["id"]
                if rec_id in seen:
                    continue
                seen.add(rec_id)
                if abs(record["lat"] - center_lat) > lat_delta:
                    continue
                if abs(record["lng"] - center_lng) > lng_delta:
                    continue
                dist = haversine_distance_km(center_lat, center_lng, record["lat"], record["lng"])
                if dist <= radius_km:
                    candidates.append({**record, "distance_km": dist})
        return candidates
