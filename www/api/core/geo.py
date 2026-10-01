"""Geometry helpers shared by the rides router.

Two distinct notions of "distance" are used deliberately in this codebase:

- `haversine_km`: straight-line ("as the crow flies") distance between two
  GPS points. Fine for short local gaps (sorting nearby drivers, checking how
  far a driver is past the exact drop pin) but NOT a good stand-in for how
  far a vehicle has actually driven along a road.
- `road_distance_along_route_km`: distance travelled along an actual road
  route polyline (as returned by Google Routes). This is what should be used
  any time "how much of the trip has the driver actually completed" matters,
  because on a winding road the straight-line distance between two points is
  always shorter than the road distance driven between them -- using
  straight-line distance there systematically under-counts progress.
"""
from __future__ import annotations

import math

EARTH_RADIUS_METERS = 6371000.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    value = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return (EARTH_RADIUS_METERS / 1000.0) * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Decodes a Google encoded polyline string into a list of (lat, lng) points.

    Mirrors decodePolyline() in js/map.js -- keep both in sync if this ever
    changes, though the polyline format itself (Google's) is a stable spec.
    """
    if not encoded:
        return []

    index = 0
    lat = 0
    lng = 0
    coordinates: list[tuple[float, float]] = []
    length = len(encoded)

    while index < length:
        result = 0
        shift = 0
        while True:
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        lat += ~(result >> 1) if (result & 1) else (result >> 1)

        result = 0
        shift = 0
        while True:
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        lng += ~(result >> 1) if (result & 1) else (result >> 1)

        coordinates.append((lat / 1e5, lng / 1e5))

    return coordinates


def _project_onto_segment_fraction(
    point: tuple[float, float], seg_start: tuple[float, float], seg_end: tuple[float, float]
) -> float:
    """Returns how far along [seg_start, seg_end] (0..1) `point` projects to.

    Uses an equirectangular flat-plane approximation, which is accurate
    enough for the short (typically tens-of-metres) segments that make up a
    Google Routes polyline.
    """
    lat_scale = 1.0
    lng_scale = math.cos(math.radians(seg_start[0])) or 1e-9

    seg_vec = ((seg_end[0] - seg_start[0]) * lat_scale, (seg_end[1] - seg_start[1]) * lng_scale)
    point_vec = ((point[0] - seg_start[0]) * lat_scale, (point[1] - seg_start[1]) * lng_scale)

    seg_length_sq = seg_vec[0] ** 2 + seg_vec[1] ** 2
    if seg_length_sq <= 1e-18:
        return 0.0

    fraction = (point_vec[0] * seg_vec[0] + point_vec[1] * seg_vec[1]) / seg_length_sq
    return max(0.0, min(1.0, fraction))


def road_distance_along_route_km(route_points: list[tuple[float, float]], position: dict[str, float]) -> float | None:
    """Distance travelled along `route_points` from its start to the point on
    the route nearest `position`, following the road (not a straight line).

    Returns None if `route_points` doesn't have enough points to measure
    along or if the position is an extreme outlier, allowing safe fallback.
    """
    if not route_points or len(route_points) < 2:
        return None

    try:
        lat = float(position["lat"])
        lng = float(position["lng"])
    except (KeyError, TypeError, ValueError):
        return None

    if not (math.isfinite(lat) and math.isfinite(lng)):
        return None

    point = (lat, lng)

    cumulative_km = 0.0
    best_distance_km = math.inf
    best_cumulative_km = 0.0

    for i in range(len(route_points) - 1):
        seg_start = route_points[i]
        seg_end = route_points[i + 1]
        seg_length_km = haversine_km(seg_start[0], seg_start[1], seg_end[0], seg_end[1])

        fraction = _project_onto_segment_fraction(point, seg_start, seg_end)
        projected = (
            seg_start[0] + (seg_end[0] - seg_start[0]) * fraction,
            seg_start[1] + (seg_end[1] - seg_start[1]) * fraction,
        )
        distance_to_segment_km = haversine_km(point[0], point[1], projected[0], projected[1])

        if distance_to_segment_km < best_distance_km:
            best_distance_km = distance_to_segment_km
            best_cumulative_km = cumulative_km + (seg_length_km * fraction)

        cumulative_km += seg_length_km

    # If the closest segment is more than 2.0 km away from the GPS point, treat as outlier
    if best_distance_km > 2.0:
        return None

    return best_cumulative_km


def is_point_in_polygon(lat: float, lng: float, polygon: list[list[float]] | list[tuple[float, float]]) -> bool:
    if not polygon or len(polygon) < 3:
        return False
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][1], polygon[i][0]
        xj, yj = polygon[j][1], polygon[j][0]
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


_CACHED_LLA: dict | None = None
_CACHED_ZONES: dict | None = None


def get_cached_lla() -> dict:
    global _CACHED_LLA
    if _CACHED_LLA is None:
        from .dispatch_config import load_lla_config
        _CACHED_LLA = load_lla_config()
    return _CACHED_LLA


def get_cached_zones() -> dict:
    global _CACHED_ZONES
    if _CACHED_ZONES is None:
        from .dispatch_config import load_zones_config
        _CACHED_ZONES = load_zones_config()
    return _CACHED_ZONES


def is_in_lla(lat: float, lng: float, lla_config: dict | None = None) -> bool:
    cfg = lla_config if lla_config is not None else get_cached_lla()
    vertices = cfg.get("vertices")
    if not vertices:
        return True
    return is_point_in_polygon(lat, lng, vertices)


def _pixel_to_axial_hex(x: float, y: float, s: float, orientation: str = "pointy") -> tuple[int, int]:
    if orientation == "pointy":
        frac_q = (math.sqrt(3) / 3.0 * x - 1.0 / 3.0 * y) / s
        frac_r = (2.0 / 3.0 * y) / s
    else:
        frac_q = (2.0 / 3.0 * x) / s
        frac_r = (-1.0 / 3.0 * x + math.sqrt(3) / 3.0 * y) / s

    frac_s = -frac_q - frac_r
    q = round(frac_q)
    r = round(frac_r)
    sc = round(frac_s)

    q_diff = abs(q - frac_q)
    r_diff = abs(r - frac_r)
    s_diff = abs(sc - frac_s)

    if q_diff > r_diff and q_diff > s_diff:
        q = -r - sc
    elif r_diff > s_diff:
        r = -q - sc
    return int(q), int(r)


def point_to_zone(lat: float, lng: float, zones_config: dict | None = None) -> str:
    cfg = zones_config if zones_config is not None else get_cached_zones()
    cells = cfg.get("cells", [])
    if not cells:
        return "Z01"

    origin = cfg.get("origin", {})
    lat0 = float(origin.get("lat0", 24.23))
    lng0 = float(origin.get("lng0", 92.175833))
    ox = float(origin.get("offset_x_km", 0.0))
    oy = float(origin.get("offset_y_km", 0.0))
    s = float(cfg.get("size_km", 21.6))
    orientation = str(cfg.get("orientation", "pointy"))

    km_lat = 110.574
    km_lng = 111.320 * math.cos(math.radians(lat0))
    x = (lng - lng0) * km_lng - ox
    y = (lat - lat0) * km_lat - oy

    q, r = _pixel_to_axial_hex(x, y, s, orientation)

    for cell in cells:
        if cell.get("q") == q and cell.get("r") == r:
            return str(cell.get("id"))

    # Fallback to closest cell center
    best_id = str(cells[0].get("id"))
    min_dist = float("inf")
    for cell in cells:
        center = cell.get("center", [lat0, lng0])
        dist = haversine_km(lat, lng, center[0], center[1])
        if dist < min_dist:
            min_dist = dist
            best_id = str(cell.get("id"))
    return best_id


def get_zone_neighbors(zone_id: str, zones_config: dict | None = None) -> list[str]:
    cfg = zones_config if zones_config is not None else get_cached_zones()
    neighbors = cfg.get("neighbors", {})
    return list(neighbors.get(zone_id, []))


def get_zone_ring(zone_id: str, ring_level: int = 1, zones_config: dict | None = None) -> list[str]:
    cfg = zones_config if zones_config is not None else get_cached_zones()
    rings = cfg.get("rings", {})
    zone_rings = rings.get(zone_id, {})
    accumulated = set()
    for level in range(ring_level + 1):
        for zid in zone_rings.get(str(level), []):
            accumulated.add(zid)
    if not accumulated:
        accumulated.add(zone_id)
    return sorted(accumulated)


def get_all_zone_ids(zones_config: dict | None = None) -> list[str]:
    cfg = zones_config if zones_config is not None else get_cached_zones()
    return [c["id"] for c in cfg.get("cells", [])]

