"""Tool to check LLA boundary coverage and buffer against real district GeoJSON."""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any

CONFIG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config"))
DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def is_in_polygon(lat: float, lng: float, polygon: list[list[float]]) -> bool:
    inside = False
    n = len(polygon)
    for i in range(n):
        p1 = polygon[i]
        p2 = polygon[(i + 1) % n]
        if ((p1[1] > lng) != (p2[1] > lng)) and (lat < (p2[0] - p1[0]) * (lng - p1[1]) / (p2[1] - p1[1]) + p1[0]):
            inside = not inside
    return inside


def point_to_segment_dist_km(lat: float, lng: float, a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    # Project onto segment AB in local equirectangular approximation
    cos_lat = math.cos(math.radians(lat))
    px = (lng - a_lng) * 111.320 * cos_lat
    py = (lat - a_lat) * 110.574
    dx = (b_lng - a_lng) * 111.320 * cos_lat
    dy = (b_lat - a_lat) * 110.574
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq <= 1e-12:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * dx + py * dy) / seg_len_sq))
    proj_x = t * dx
    proj_y = t * dy
    return math.hypot(px - proj_x, py - proj_y)


def min_dist_to_polygon_boundary_km(lat: float, lng: float, polygon: list[list[float]]) -> float:
    min_d = float("inf")
    n = len(polygon)
    for i in range(n):
        p1 = polygon[i]
        p2 = polygon[(i + 1) % n]
        d = point_to_segment_dist_km(lat, lng, p1[0], p1[1], p2[0], p2[1])
        if d < min_d:
            min_d = d
    return min_d


def extract_coordinates(geojson_data: dict[str, Any]) -> list[list[float]]:
    points = []

    def _recurse(coords):
        if not coords:
            return
        if isinstance(coords[0], (int, float)):
            # [lng, lat]
            points.append([coords[1], coords[0]])
        else:
            for item in coords:
                _recurse(item)

    if geojson_data.get("type") == "FeatureCollection":
        for feature in geojson_data.get("features", []):
            geom = feature.get("geometry") or {}
            _recurse(geom.get("coordinates", []))
    elif geojson_data.get("type") == "Feature":
        geom = geojson_data.get("geometry") or {}
        _recurse(geom.get("coordinates", []))
    elif "coordinates" in geojson_data:
        _recurse(geojson_data.get("coordinates", []))

    return points


def main():
    parser = argparse.ArgumentParser(description="Check LLA boundary against real district GeoJSON")
    parser.add_argument(
        "--geojson",
        default=os.path.join(DATA_DIR, "districts.geojson"),
        help="Path to real district GeoJSON file",
    )
    parser.add_argument(
        "--lla",
        default=os.path.join(CONFIG_DIR, "lla.json"),
        help="Path to LLA configuration JSON file",
    )
    parser.add_argument(
        "--min-buffer",
        type=float,
        default=5.0,
        help="Minimum required buffer in km (default: 5.0 km)",
    )
    args = parser.parse_args()

    lla_path = os.path.abspath(args.lla)
    if not os.path.isfile(lla_path):
        print(f"ERROR: LLA configuration file not found at {lla_path}")
        sys.exit(1)

    with open(lla_path, "r", encoding="utf-8") as f:
        lla_config = json.load(f)

    lla_polygon = lla_config.get("vertices") or lla_config.get("polygon")
    if not lla_polygon:
        print("ERROR: Invalid LLA configuration: missing 'vertices' or 'polygon' array.")
        sys.exit(1)

    geojson_path = os.path.abspath(args.geojson)
    if not os.path.isfile(geojson_path):
        print("================================================================================")
        print("                   LIPHTUP LLA BOUNDARY VERIFICATION TOOL                       ")
        print("================================================================================")
        print(f"NOTICE: Real district boundary file not found at:\n  {geojson_path}\n")
        print("HOW TO SUPPLY REAL DISTRICT BOUNDARY DATA:")
        print("1. Download Unakoti and North Tripura district boundaries in GeoJSON format from:")
        print("   - OpenStreetMap (via Overpass Turbo or export)")
        print("   - Survey of India / Datameet India GIS repository (unakoti_north_tripura.geojson)")
        print("2. Save the GeoJSON file to:")
        print(f"   {geojson_path}")
        print("3. Re-run this check tool:")
        print("   python scripts/check_boundary.py")
        print("================================================================================")
        sys.exit(0)

    with open(geojson_path, "r", encoding="utf-8") as f:
        district_data = json.load(f)

    boundary_points = extract_coordinates(district_data)
    if not boundary_points:
        print(f"ERROR: No valid coordinate vertices extracted from {geojson_path}")
        sys.exit(1)

    outside_points = []
    distances = []

    for lat, lng in boundary_points:
        inside = is_in_polygon(lat, lng, lla_polygon)
        d_edge = min_dist_to_polygon_boundary_km(lat, lng, lla_polygon)
        distances.append(d_edge)
        if not inside:
            outside_points.append((lat, lng, d_edge))

    total_vertices = len(boundary_points)
    outside_count = len(outside_points)
    outside_pct = (outside_count / total_vertices) * 100.0
    min_buffer_actual = min(distances) if distances else 0.0
    max_dist_to_edge = max(distances) if distances else 0.0

    passed = outside_count == 0 and min_buffer_actual >= args.min_buffer

    print("================================================================================")
    print("                   LIPHTUP LLA BOUNDARY VERIFICATION REPORT                     ")
    print("================================================================================")
    print(f"LLA Area:                 {lla_config.get('area_km2') or lla_config.get('area_sqkm', 'N/A')} km2")
    print(f"LLA Vertices:             {len(lla_polygon)}")
    print(f"Evaluated Real Vertices:  {total_vertices}")
    print(f"Real Area/Vertices Outside: {outside_pct:.2f}% ({outside_count}/{total_vertices})")
    print(f"Minimum Buffer Distance:  {min_buffer_actual:.2f} km (Required: >= {args.min_buffer:.2f} km)")
    print(f"Farthest Outline to Edge: {max_dist_to_edge:.2f} km")
    print("--------------------------------------------------------------------------------")
    if passed:
        print(f"RESULT: PASS - All district vertices are inside LLA with >= {args.min_buffer:.2f} km buffer.")
    else:
        print(f"RESULT: FAIL - LLA does not meet the >= {args.min_buffer:.2f} km buffer on all vertices.")
        if outside_count > 0:
            print(f"  * {outside_count} vertices fall outside the LLA polygon.")
        if min_buffer_actual < args.min_buffer:
            print(f"  * Minimum buffer {min_buffer_actual:.2f} km is below required {args.min_buffer:.2f} km.")
        print("\nREMEDIATION:")
        print("  1. Regenerate LLA using: python scripts/generate_lla.py --input-boundary " + geojson_path)
        print("  2. Verify preview in docs/lla-preview.svg and rerun pytest.")
    print("================================================================================")

    if not passed:
        sys.exit(2)


if __name__ == "__main__":
    main()
