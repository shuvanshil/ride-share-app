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
    along, so callers can fall back to straight-line distance.
    """
    if not route_points or len(route_points) < 2:
        return None

    point = (float(position["lat"]), float(position["lng"]))

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

    return best_cumulative_km
