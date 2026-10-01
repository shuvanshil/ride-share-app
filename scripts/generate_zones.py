"""Generate Hex Zone Grid (10-12 cells) covering the LLA.

Outputs config/zones.json, docs/zones-preview.geojson, and docs/zones-preview.svg.
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

# Dense, calibrated boundary polygon for Unakoti + North Tripura Districts (approximate boundary)
DENSE_DISTRICT_OUTLINE = [
    [24.485, 92.245], [24.475, 92.195], [24.445, 92.155], [24.385, 92.045],
    [24.340, 91.980], [24.280, 91.970], [24.200, 91.985], [24.150, 92.010],
    [24.100, 92.065], [24.020, 92.110], [23.940, 92.140], [23.870, 92.180],
    [23.800, 92.260], [23.850, 92.290], [23.950, 92.315], [24.050, 92.330],
    [24.140, 92.340], [24.220, 92.290], [24.290, 92.240], [24.380, 92.235],
    [24.440, 92.260],
]

KM_PER_LAT = 110.574


def km_per_lng(lat_deg: float) -> float:
    return 111.320 * math.cos(math.radians(lat_deg))


def project_to_xy(lat: float, lng: float, lat0: float, lng0: float) -> tuple[float, float]:
    x = (lng - lng0) * km_per_lng(lat0)
    y = (lat - lat0) * KM_PER_LAT
    return x, y


def unproject_from_xy(x: float, y: float, lat0: float, lng0: float) -> tuple[float, float]:
    lat = lat0 + (y / KM_PER_LAT)
    lng = lng0 + (x / km_per_lng(lat0))
    return round(lat, 6), round(lng, 6)


def point_in_polygon_2d(px: float, py: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def hex_cell_vertices_xy(cx: float, cy: float, s: float, orientation: str = "pointy") -> list[tuple[float, float]]:
    verts = []
    offset_deg = 30.0 if orientation == "pointy" else 0.0
    for i in range(6):
        angle = math.radians(offset_deg + i * 60.0)
        verts.append((cx + s * math.cos(angle), cy + s * math.sin(angle)))
    return verts


def hex_to_pixel(q: int, r: int, s: float, orientation: str = "pointy") -> tuple[float, float]:
    if orientation == "pointy":
        x = s * math.sqrt(3) * (q + r / 2.0)
        y = s * (3.0 / 2.0) * r
    else:
        x = s * (3.0 / 2.0) * q
        y = s * math.sqrt(3) * (r + q / 2.0)
    return x, y


def pixel_to_hex(x: float, y: float, s: float, orientation: str = "pointy") -> tuple[int, int]:
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


def hex_distance(q1: int, r1: int, q2: int, r2: int) -> int:
    return (abs(q1 - q2) + abs((q1 + r1) - (q2 + r2)) + abs(r1 - r2)) // 2


def polygons_intersect(poly1: list[tuple[float, float]], poly2: list[tuple[float, float]]) -> bool:
    for p in poly1:
        if point_in_polygon_2d(p[0], p[1], poly2):
            return True
    for p in poly2:
        if point_in_polygon_2d(p[0], p[1], poly1):
            return True

    def ccw(A, B, C):
        return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])

    def intersect_seg(A, B, C, D):
        return ccw(A, C, D) != ccw(B, C, D) and ccw(A, B, C) != ccw(A, B, D)

    n1, n2 = len(poly1), len(poly2)
    for i in range(n1):
        p1a, p1b = poly1[i], poly1[(i + 1) % n1]
        for j in range(n2):
            p2a, p2b = poly2[j], poly2[(j + 1) % n2]
            if intersect_seg(p1a, p1b, p2a, p2b):
                return True
    return False


def verify_coverage(lla_poly_xy: list[tuple[float, float]], cells: list[dict[str, Any]], s: float, orientation: str, origin_xy: tuple[float, float]) -> bool:
    ox, oy = origin_xy
    for vx, vy in lla_poly_xy:
        q, r = pixel_to_hex(vx - ox, vy - oy, s, orientation)
        if not any(c["q"] == q and c["r"] == r for c in cells):
            return False

    min_x = min(p[0] for p in lla_poly_xy)
    max_x = max(p[0] for p in lla_poly_xy)
    min_y = min(p[1] for p in lla_poly_xy)
    max_y = max(p[1] for p in lla_poly_xy)

    steps = 40
    for ix in range(steps):
        px = min_x + (max_x - min_x) * (ix / (steps - 1))
        for iy in range(steps):
            py = min_y + (max_y - min_y) * (iy / (steps - 1))
            if point_in_polygon_2d(px, py, lla_poly_xy):
                q, r = pixel_to_hex(px - ox, py - oy, s, orientation)
                if not any(c["q"] == q and c["r"] == r for c in cells):
                    return False
    return True


def find_optimal_zones(lla_data: dict[str, Any]) -> dict[str, Any]:
    lat0, lng0 = lla_data["centroid"]
    vertices_latlng = lla_data["vertices"]
    lla_xy = [project_to_xy(v[0], v[1], lat0, lng0) for v in vertices_latlng]
    district_xy = [project_to_xy(p[0], p[1], lat0, lng0) for p in DENSE_DISTRICT_OUTLINE]

    best_config = None
    best_score = -1

    # Search across pointy/flat and s in 11.0km to 20.0km
    for orientation in ["pointy", "flat"]:
        for s_int in range(120, 200, 2):
            s = s_int / 10.0
            for off_x_step in range(-5, 6, 2):
                for off_y_step in range(-5, 6, 2):
                    ox = (off_x_step / 10.0) * s
                    oy = (off_y_step / 10.0) * s

                    intersecting_cells = []
                    for q in range(-6, 7):
                        for r in range(-6, 7):
                            cx, cy = hex_to_pixel(q, r, s, orientation)
                            cx += ox
                            cy += oy
                            cell_verts = hex_cell_vertices_xy(cx, cy, s, orientation)
                            if polygons_intersect(cell_verts, lla_xy):
                                intersecting_cells.append({
                                    "q": q,
                                    "r": r,
                                    "cx": cx,
                                    "cy": cy,
                                    "verts": cell_verts,
                                })

                    count = len(intersecting_cells)
                    if 10 <= count <= 12 and verify_coverage(lla_xy, intersecting_cells, s, orientation, (ox, oy)):
                        # Score: reward configurations where all cells cover active district area
                        district_hits = [0] * count
                        for px, py in district_xy:
                            for idx, c in enumerate(intersecting_cells):
                                if point_in_polygon_2d(px, py, c["verts"]):
                                    district_hits[idx] += 1
                        non_zero = sum(1 for h in district_hits if h > 0)
                        min_hits = min(district_hits)
                        score = non_zero * 100 + min_hits * 10 - count

                        if score > best_score:
                            best_score = score
                            best_config = {
                                "orientation": orientation,
                                "size_km": s,
                                "origin_offset_xy": (ox, oy),
                                "cells": intersecting_cells,
                            }

    if not best_config:
        raise RuntimeError("Could not find a 10 to 12 cell valid covering grid for the LLA!")

    orientation = best_config["orientation"]
    s = best_config["size_km"]
    ox, oy = best_config["origin_offset_xy"]
    raw_cells = best_config["cells"]

    raw_cells.sort(key=lambda c: (c["r"], c["q"]))
    cell_list = []
    id_map = {}
    for idx, c in enumerate(raw_cells, start=1):
        cell_id = f"Z{idx:02d}"
        id_map[(c["q"], c["r"])] = cell_id
        clat, clng = unproject_from_xy(c["cx"], c["cy"], lat0, lng0)
        cell_verts_latlng = [list(unproject_from_xy(vx, vy, lat0, lng0)) for vx, vy in c["verts"]]
        cell_list.append({
            "id": cell_id,
            "q": c["q"],
            "r": c["r"],
            "center": [clat, clng],
            "vertices": cell_verts_latlng,
        })

    neighbors_dict: dict[str, list[str]] = {}
    rings_dict: dict[str, dict[str, list[str]]] = {}

    for c1 in cell_list:
        cid = c1["id"]
        q1, r1 = c1["q"], c1["r"]
        n_list = []
        ring_map: dict[str, list[str]] = {}

        for c2 in cell_list:
            dist = hex_distance(q1, r1, c2["q"], c2["r"])
            dist_str = str(dist)
            if dist_str not in ring_map:
                ring_map[dist_str] = []
            ring_map[dist_str].append(c2["id"])
            if dist == 1:
                n_list.append(c2["id"])

        neighbors_dict[cid] = sorted(n_list)
        rings_dict[cid] = {k: sorted(v) for k, v in sorted(ring_map.items(), key=lambda item: int(item[0]))}

    return {
        "version": 2,
        "name": "LiphtUp Hex Zone Grid",
        "zone_count": len(cell_list),
        "orientation": orientation,
        "size_km": s,
        "origin": {
            "lat0": lat0,
            "lng0": lng0,
            "offset_x_km": round(ox, 4),
            "offset_y_km": round(oy, 4),
        },
        "cells": cell_list,
        "neighbors": neighbors_dict,
        "rings": rings_dict,
    }


def write_zone_outputs(zones_data: dict[str, Any], lla_data: dict[str, Any]):
    with open("config/zones.json", "w", encoding="utf-8") as f:
        json.dump(zones_data, f, indent=2)

    features = []

    lla_pts = [[v[1], v[0]] for v in lla_data["vertices"]]
    lla_pts.append(lla_pts[0])
    features.append({
        "type": "Feature",
        "properties": {"name": "Tight LLA Geofence Boundary"},
        "geometry": {"type": "Polygon", "coordinates": [lla_pts]}
    })

    for cell in zones_data["cells"]:
        poly_pts = [[v[1], v[0]] for v in cell["vertices"]]
        poly_pts.append(poly_pts[0])
        features.append({
            "type": "Feature",
            "properties": {
                "id": cell["id"],
                "q": cell["q"],
                "r": cell["r"],
                "center": cell["center"],
                "name": f"Zone {cell['id']}"
            },
            "geometry": {"type": "Polygon", "coordinates": [poly_pts]}
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }
    with open("docs/zones-preview.geojson", "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2)

    bbox = lla_data["bounding_box"]
    min_lat, max_lat = bbox["min_lat"] - 0.10, bbox["max_lat"] + 0.10
    min_lng, max_lng = bbox["min_lng"] - 0.10, bbox["max_lng"] + 0.10

    width, height = 750, 850

    def to_svg_xy(lat: float, lng: float) -> tuple[float, float]:
        sx = ((lng - min_lng) / (max_lng - min_lng)) * (width - 80) + 40
        sy = height - 40 - (((lat - min_lat) / (max_lat - min_lat)) * (height - 80))
        return sx, sy

    lla_svg_pts = " ".join(f"{to_svg_xy(v[0], v[1])[0]:.1f},{to_svg_xy(v[0], v[1])[1]:.1f}" for v in lla_data["vertices"])

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0f172a; font-family:sans-serif;">
  <defs>
    <linearGradient id="cellGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#4338ca" stop-opacity="0.08"/>
    </linearGradient>
  </defs>

  <text x="40" y="45" fill="#f8fafc" font-size="22" font-weight="bold">LiphtUp Hex Zone Covering ({zones_data['zone_count']} Cells)</text>
  <text x="40" y="70" fill="#94a3b8" font-size="14">Tight Hex Grid covering Limited Lipht Area (Unakoti &amp; North Tripura)</text>

  <!-- LLA Boundary Background -->
  <polygon points="{lla_svg_pts}" fill="#38bdf8" fill-opacity="0.12" stroke="#38bdf8" stroke-width="3" stroke-dasharray="6,4"/>

  <!-- Hex Cells -->
"""
    for cell in zones_data["cells"]:
        cell_pts = " ".join(f"{to_svg_xy(v[0], v[1])[0]:.1f},{to_svg_xy(v[0], v[1])[1]:.1f}" for v in cell["vertices"])
        cx, cy = to_svg_xy(cell["center"][0], cell["center"][1])
        svg += f'  <polygon points="{cell_pts}" fill="url(#cellGrad)" stroke="#818cf8" stroke-width="1.8"/>\n'
        svg += f'  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="4" fill="#a5b4fc"/>\n'
        svg += f'  <text x="{cx:.1f}" y="{cy-8:.1f}" fill="#ffffff" font-size="13" font-weight="bold" text-anchor="middle">{cell["id"]}</text>\n'
        svg += f'  <text x="{cx:.1f}" y="{cy+14:.1f}" fill="#cbd5e1" font-size="10" text-anchor="middle">({cell["q"]},{cell["r"]})</text>\n'

    svg += f"""
  <g transform="translate(40, {height - 95})">
    <rect width="380" height="70" rx="8" fill="#1e293b" stroke="#334155"/>
    <line x1="15" y1="22" x2="30" y2="22" stroke="#38bdf8" stroke-width="3" stroke-dasharray="4,2"/>
    <text x="40" y="26" fill="#e2e8f0" font-size="12">Tight Convex LLA Boundary ({lla_data.get('area_km2')} km²)</text>
    <rect x="15" y="42" width="16" height="16" rx="3" fill="#6366f1" fill-opacity="0.3" stroke="#818cf8" stroke-width="1.5"/>
    <text x="40" y="55" fill="#e2e8f0" font-size="12">Covering Hex Zones ({zones_data['zone_count']} Cells, s={zones_data['size_km']}km)</text>
  </g>
</svg>"""

    with open("docs/zones-preview.svg", "w", encoding="utf-8") as f:
        f.write(svg)


if __name__ == "__main__":
    with open("config/lla.json", "r", encoding="utf-8") as f:
        lla = json.load(f)
    zones = find_optimal_zones(lla)
    write_zone_outputs(zones, lla)
    print(f"Generated {zones['zone_count']} zones successfully.")
    print(f"Orientation: {zones['orientation']}, Cell Radius: {zones['size_km']} km")
    print(f"Cell IDs: {[c['id'] for c in zones['cells']]}")
