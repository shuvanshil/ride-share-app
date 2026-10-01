"""Generate LLA (Limited Lipht Area) strictly convex 6-vertex bounding hexagon.

Covers Unakoti District and North Tripura District plus minimum 5 km buffer.
Outputs config/lla.json, docs/lla-preview.geojson, and docs/lla-preview.svg.
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

# Dense, calibrated boundary polygon for Unakoti + North Tripura Districts (approximate boundary)
DENSE_DISTRICT_OUTLINE = [
    [24.485, 92.245],  # Churaibari North
    [24.475, 92.195],  # Kadamtala North
    [24.445, 92.155],  # Kurti / Tilbhum
    [24.385, 92.045],  # Kailashahar North / Irani
    [24.340, 91.980],  # Kailashahar West / Samrurpar
    [24.280, 91.970],  # Rangrung / Gournagar
    [24.200, 91.985],  # Fatikroy West
    [24.150, 92.010],  # Kumarghat South-West
    [24.100, 92.065],  # Pecharthal West
    [24.020, 92.110],  # Machmara / Dasda North-West
    [23.940, 92.140],  # Laljuri / Kanchanpur West
    [23.870, 92.180],  # Anandabazar West
    [23.800, 92.260],  # Phuldungsei South (Jampui Hills)
    [23.850, 92.290],  # Sabual East (Jampui Hills)
    [23.950, 92.315],  # Vanghmun East
    [24.050, 92.330],  # Tlangsang / Damcherra South
    [24.140, 92.340],  # Damcherra East / Mizoram Border
    [24.220, 92.290],  # Khedacherra East
    [24.290, 92.240],  # Panisagar East / Rowa
    [24.380, 92.235],  # Dharmanagar East / Sanicherra
    [24.440, 92.260],  # Shanicharra / Bagbassa
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


def min_dist_point_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return math.hypot(px - proj_x, py - proj_y)


def is_convex_polygon(vertices: list[tuple[float, float]]) -> bool:
    n = len(vertices)
    if n < 3:
        return False
    signs = []
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        x3, y3 = vertices[(i + 2) % n]
        cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2)
        if abs(cross) > 1e-7:
            signs.append(cross > 0)
    return len(set(signs)) <= 1


def find_optimal_convex_hexagon(district_xy: list[tuple[float, float]], min_buffer_km: float = 5.0) -> tuple[list[tuple[float, float]], dict[str, float]]:
    min_area = float("inf")
    best_res = None

    for a1_deg in range(0, 60, 2):
        for a2_deg in range(a1_deg + 30, a1_deg + 90, 2):
            for a3_deg in range(a2_deg + 30, a1_deg + 180, 2):
                dirs = [
                    (math.cos(math.radians(a1_deg)), math.sin(math.radians(a1_deg))),
                    (math.cos(math.radians(a2_deg)), math.sin(math.radians(a2_deg))),
                    (math.cos(math.radians(a3_deg)), math.sin(math.radians(a3_deg))),
                ]
                d1, d2, d3 = dirs[0], dirs[1], dirs[2]

                p1 = [p[0] * d1[0] + p[1] * d1[1] for p in district_xy]
                p2 = [p[0] * d2[0] + p[1] * d2[1] for p in district_xy]
                p3 = [p[0] * d3[0] + p[1] * d3[1] for p in district_xy]

                u_max = max(p1) + min_buffer_km + 0.2
                u_min = min(p1) - min_buffer_km - 0.2
                v_max = max(p2) + min_buffer_km + 0.2
                v_min = min(p2) - min_buffer_km - 0.2
                w_max = max(p3) + min_buffer_km + 0.2
                w_min = min(p3) - min_buffer_km - 0.2

                def inter(da, ca, db, cb):
                    det = da[0] * db[1] - da[1] * db[0]
                    if abs(det) < 1e-9:
                        return None
                    return ((ca * db[1] - cb * da[1]) / det, (da[0] * cb - db[0] * ca) / det)

                v1 = inter(d1, u_max, d2, v_max)
                v2 = inter(d2, v_max, d3, w_max)
                v3 = inter(d3, w_max, d1, u_min)
                v4 = inter(d1, u_min, d2, v_min)
                v5 = inter(d2, v_min, d3, w_min)
                v6 = inter(d3, w_min, d1, u_max)

                if None in (v1, v2, v3, v4, v5, v6):
                    continue
                verts = [v1, v2, v3, v4, v5, v6]
                if not is_convex_polygon(verts):
                    continue

                n = len(verts)
                area = 0.5 * abs(sum(verts[i][0] * verts[(i + 1) % n][1] - verts[(i + 1) % n][0] * verts[i][1] for i in range(n)))
                if area < min_area:
                    min_buf = min(
                        min(min_dist_point_to_segment(px, py, verts[k][0], verts[k][1], verts[(k + 1) % n][0], verts[(k + 1) % n][1]) for k in range(n))
                        for px, py in district_xy
                    )
                    max_dist = max(
                        min(min_dist_point_to_segment(px, py, verts[k][0], verts[k][1], verts[(k + 1) % n][0], verts[(k + 1) % n][1]) for k in range(n))
                        for px, py in district_xy
                    )
                    if min_buf >= min_buffer_km:
                        min_area = area
                        best_res = (verts, {
                            "area_km2": round(area, 2),
                            "min_buffer_km": round(min_buf, 2),
                            "max_distance_km": round(max_dist, 2),
                        })

    if not best_res:
        raise RuntimeError("Could not compute convex bounding hexagon!")
    return best_res


def generate_lla() -> dict[str, Any]:
    lat0 = sum(p[0] for p in DENSE_DISTRICT_OUTLINE) / len(DENSE_DISTRICT_OUTLINE)
    lng0 = sum(p[1] for p in DENSE_DISTRICT_OUTLINE) / len(DENSE_DISTRICT_OUTLINE)

    district_xy = [project_to_xy(p[0], p[1], lat0, lng0) for p in DENSE_DISTRICT_OUTLINE]
    hex_xy, stats = find_optimal_convex_hexagon(district_xy, min_buffer_km=5.0)

    vertices_latlng = [list(unproject_from_xy(hx, hy, lat0, lng0)) for hx, hy in hex_xy]
    centroid_latlng = [round(lat0, 6), round(lng0, 6)]

    lats = [v[0] for v in vertices_latlng]
    lngs = [v[1] for v in vertices_latlng]

    return {
        "version": 2,
        "name": "Limited Lipht Area (LLA)",
        "description": "Tightly fitted convex 6-vertex bounding hexagon covering Unakoti and North Tripura with min 5km buffer (approximate boundary)",
        "min_buffer_km": stats["min_buffer_km"],
        "max_distance_km": stats["max_distance_km"],
        "area_km2": stats["area_km2"],
        "centroid": centroid_latlng,
        "vertices": vertices_latlng,
        "bounding_box": {
            "min_lat": min(lats),
            "max_lat": max(lats),
            "min_lng": min(lngs),
            "max_lng": max(lngs),
        }
    }


def write_outputs(lla_data: dict[str, Any]):
    os.makedirs("config", exist_ok=True)
    os.makedirs("docs", exist_ok=True)

    with open("config/lla.json", "w", encoding="utf-8") as f:
        json.dump(lla_data, f, indent=2)

    vertices = lla_data["vertices"]
    geojson_polygon = [[v[1], v[0]] for v in vertices]
    geojson_polygon.append(geojson_polygon[0])

    district_pts = [[p[1], p[0]] for p in DENSE_DISTRICT_OUTLINE]
    district_pts.append(district_pts[0])

    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": "Unakoti & North Tripura Dense District Outline (Approximate)",
                    "note": "Calibrated from town and border coordinates"
                },
                "geometry": {"type": "Polygon", "coordinates": [district_pts]}
            },
            {
                "type": "Feature",
                "properties": {
                    "name": "LLA 6-Vertex Convex Bounding Hexagon",
                    "area_km2": lla_data["area_km2"],
                    "min_buffer_km": lla_data["min_buffer_km"]
                },
                "geometry": {"type": "Polygon", "coordinates": [geojson_polygon]}
            }
        ]
    }
    with open("docs/lla-preview.geojson", "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2)

    bbox = lla_data["bounding_box"]
    min_lat, max_lat = bbox["min_lat"] - 0.05, bbox["max_lat"] + 0.05
    min_lng, max_lng = bbox["min_lng"] - 0.05, bbox["max_lng"] + 0.05
    width, height = 700, 850

    def to_svg_xy(lat: float, lng: float) -> tuple[float, float]:
        sx = ((lng - min_lng) / (max_lng - min_lng)) * (width - 80) + 40
        sy = height - 40 - (((lat - min_lat) / (max_lat - min_lat)) * (height - 80))
        return sx, sy

    hex_svg_pts = " ".join(f"{to_svg_xy(v[0], v[1])[0]:.1f},{to_svg_xy(v[0], v[1])[1]:.1f}" for v in vertices)
    core_svg_pts = " ".join(f"{to_svg_xy(p[0], p[1])[0]:.1f},{to_svg_xy(p[0], p[1])[1]:.1f}" for p in DENSE_DISTRICT_OUTLINE)

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0f172a; font-family:sans-serif;">
  <defs>
    <linearGradient id="llaGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0.10"/>
    </linearGradient>
  </defs>

  <text x="40" y="45" fill="#f8fafc" font-size="22" font-weight="bold">LiphtUp Tight Convex LLA Preview</text>
  <text x="40" y="70" fill="#94a3b8" font-size="14">Unakoti &amp; North Tripura (Area: {lla_data['area_km2']} km², Min Buffer: {lla_data['min_buffer_km']} km)</text>

  <!-- LLA Hexagon -->
  <polygon points="{hex_svg_pts}" fill="url(#llaGrad)" stroke="#38bdf8" stroke-width="3"/>

  <!-- Core District Outline -->
  <polygon points="{core_svg_pts}" fill="#22c55e" fill-opacity="0.25" stroke="#22c55e" stroke-width="2"/>

  <!-- Vertices -->
"""
    for i, v in enumerate(vertices):
        vx, vy = to_svg_xy(v[0], v[1])
        svg += f'  <circle cx="{vx:.1f}" cy="{vy:.1f}" r="5" fill="#38bdf8"/>\n'
        svg += f'  <text x="{vx+8:.1f}" y="{vy+4:.1f}" fill="#bae6fd" font-size="11">V{i+1} ({v[0]:.2f}, {v[1]:.2f})</text>\n'

    svg += f"""
  <g transform="translate(40, {height - 90})">
    <rect width="360" height="65" rx="8" fill="#1e293b" stroke="#334155"/>
    <circle cx="20" cy="20" r="5" fill="#22c55e"/>
    <text x="35" y="24" fill="#e2e8f0" font-size="12">Dense District Boundary (Approximate)</text>
    <line x1="15" y1="45" x2="25" y2="45" stroke="#38bdf8" stroke-width="3"/>
    <text x="35" y="49" fill="#e2e8f0" font-size="12">Tight Convex LLA Hexagon (Min Buffer: 5km)</text>
  </g>
</svg>"""

    with open("docs/lla-preview.svg", "w", encoding="utf-8") as f:
        f.write(svg)


if __name__ == "__main__":
    lla = generate_lla()
    write_outputs(lla)
    print(f"Generated Tight Convex LLA:")
    print(f"  Area: {lla['area_km2']} km^2 (Target: < 5000 km^2)")
    print(f"  Min Buffer: {lla['min_buffer_km']} km")
    print(f"  Max Distance: {lla['max_distance_km']} km")
    print(f"  Vertices: {lla['vertices']}")
