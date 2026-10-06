"""Spatial calculations and grid cell indexing for dispatch."""
from __future__ import annotations

import math
from ..config import GRID_CELL_SIZE_DEG


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great-circle distance between two GPS coordinates in kilometers."""
    r = 6371.0  # Earth radius in kilometers
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return round(r * c, 4)


def lat_lon_to_cell(lat: float, lon: float, cell_size_deg: float = GRID_CELL_SIZE_DEG) -> str:
    """Discretize latitude and longitude into uniform spatial grid cell key."""
    cell_y = int(math.floor(lat / cell_size_deg))
    cell_x = int(math.floor(lon / cell_size_deg))
    return f"{cell_y}:{cell_x}"


def cell_to_bounds(cell: str, cell_size_deg: float = GRID_CELL_SIZE_DEG) -> tuple[float, float, float, float]:
    """Return (min_lat, min_lon, max_lat, max_lon) for a given cell key."""
    parts = cell.split(":")
    cell_y, cell_x = int(parts[0]), int(parts[1])
    min_lat = cell_y * cell_size_deg
    min_lon = cell_x * cell_size_deg
    return min_lat, min_lon, min_lat + cell_size_deg, min_lon + cell_size_deg


def neighbor_cells(cell: str, ring: int = 1) -> set[str]:
    """Get all neighboring grid cell keys within Chebyshev distance `ring`."""
    parts = cell.split(":")
    cy, cx = int(parts[0]), int(parts[1])
    cells = set()
    for dy in range(-ring, ring + 1):
        for dx in range(-ring, ring + 1):
            cells.add(f"{cy + dy}:{cx + dx}")
    return cells


def cells_for_radius(
    lat: float,
    lon: float,
    radius_km: float,
    cell_size_deg: float = GRID_CELL_SIZE_DEG,
) -> set[str]:
    """Return the set of grid cells covering a bounding box around (lat, lon) with radius_km."""
    # Approx 1 deg latitude = 111.0 km, 1 deg longitude = 111.0 * cos(lat) km
    lat_delta = radius_km / 111.0
    lon_delta = radius_km / (111.0 * max(0.01, math.cos(math.radians(lat))))

    min_cy = int(math.floor((lat - lat_delta) / cell_size_deg))
    max_cy = int(math.floor((lat + lat_delta) / cell_size_deg))
    min_cx = int(math.floor((lon - lon_delta) / cell_size_deg))
    max_cx = int(math.floor((lon + lon_delta) / cell_size_deg))

    covered = set()
    for cy in range(min_cy, max_cy + 1):
        for cx in range(min_cx, max_cx + 1):
            covered.add(f"{cy}:{cx}")
    return covered
