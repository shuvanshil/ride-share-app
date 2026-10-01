"""Generate LLA (Limited Lipht Area) 6-vertex bounding hexagon.

Covers Unakoti District and North Tripura District plus 5-10 km buffer.
Outputs config/lla.json, docs/lla-preview.geojson, and docs/lla-preview.svg.
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

# Representative boundary outline for Unakoti + North Tripura Districts
DEFAULT_DISTRICT_POINTS = [
    [24.56, 92.22],  # Kadamtala / Churaibari (North)
    [24.54, 92.10],  # Dharmanagar West / Bangladesh border
    [24.49, 92.00],  # Kailashahar border
    [24.35, 91.94],  # Kumarghat / Manu River border
    [24.18, 91.95],  # Pecharthal / Machmara
    [24.00, 92.08],  # Kanchanpur North-West
    [23.88, 92.18],  # Kanchanpur South-West
    [23.83, 92.28],  # Jampui Hills South / Vanghmun
    [23.88, 92.38],  # Jampui Hills East / Mizoram border
    [24.15, 92.35],  # Damcherra / Mizoram border
    [24.38, 92.33],  # Panisagar / Assam border
    [24.52, 92.30],  # Dharmanagar East / Assam border
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


def buffer_polygon_xy(points_xy: list[tuple[float, float]], buffer_km: float) -> list[tuple[float, float]]:
    """Expand 2D polygon outward by buffer_km."""
    buffered = []
    n = len(points_xy)
    for i in range(n):
        p_prev = points_xy[(i - 1) % n]
        p_curr = points_xy[i]
        p_next = points_xy[(i + 1) % n]

        # Normal vector to incoming and outgoing edges
        d1x, d1y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        l1 = math.hypot(d1x, d1y) or 1e-6
        n1x, n1y = d1y / l1, -d1x / l1

        d2x, d2y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        l2 = math.hypot(d2x, d2y) or 1e-6
        n2x, n2y = d2y / l2, -d2x / l2

        # Average normal
        nx, ny = (n1x + n2x) / 2.0, (n1y + n2y) / 2.0
        ln = math.hypot(nx, ny) or 1e-6
        buffered.append((p_curr[0] + (nx / ln) * buffer_km, p_curr[1] + (ny / ln) * buffer_km))
    return buffered


def compute_bounding_hexagon(points_xy: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Fit a minimum enclosing regular/stretched hexagon around points_xy."""
    cx = sum(p[0] for p in points_xy) / len(points_xy)
    cy = sum(p[1] for p in points_xy) / len(points_xy)

    best_hex: list[tuple[float, float]] = []
    min_area = float("inf")

    # Search rotations at 1 degree steps
    for angle_deg in range(0, 60, 1):
        angle = math.radians(angle_deg)
        # Unit directions for 3 pairs of parallel bounding planes spaced at 60 deg
        dirs = [
            (math.cos(angle), math.sin(angle)),
            (math.cos(angle + math.pi / 3), math.sin(angle + math.pi / 3)),
            (math.cos(angle + 2 * math.pi / 3), math.sin(angle + 2 * math.pi / 3)),
        ]

        # Compute min and max projections along the 3 axes
        proj_ranges = []
        for dx, dy in dirs:
            projs = [p[0] * dx + p[1] * dy for p in points_xy]
            min_p, max_p = min(projs), max(projs)
            proj_ranges.append((min_p, max_p))

        # The intersection of 3 symmetric strip pairs forms a hexagon
        # Half-widths along the 3 axes:
        u_min, u_max = proj_ranges[0]
        v_min, v_max = proj_ranges[1]
        w_min, w_max = proj_ranges[2]

        # Hexagon vertices are intersections of adjacent boundary lines
        # Line 1: x*dx1 + y*dy1 = C1
        # Line 2: x*dx2 + y*dy2 = C2
        def intersect_lines(d1: tuple[float, float], c1: float, d2: tuple[float, float], c2: float) -> tuple[float, float]:
            denom = d1[0] * d2[1] - d1[1] * d2[0]
            if abs(denom) < 1e-9:
                return (cx, cy)
            ix = (c1 * d2[1] - c2 * d1[1]) / denom
            iy = (d1[0] * c2 - d2[0] * c1) / denom
            return (ix, iy)

        d1, d2, d3 = dirs[0], dirs[1], dirs[2]
        vertices = [
            intersect_lines(d1, u_max, d2, v_max),
            intersect_lines(d2, v_max, d3, w_min),
            intersect_lines(d3, w_min, d1, u_min),
            intersect_lines(d1, u_min, d2, v_min),
            intersect_lines(d2, v_min, d3, w_max),
            intersect_lines(d3, w_max, d1, u_max),
        ]

        # Compute polygon area
        area = 0.5 * abs(sum(
            vertices[i][0] * vertices[(i + 1) % 6][1] - vertices[(i + 1) % 6][0] * vertices[i][1]
            for i in range(6)
        ))

        # Check if all points are enclosed
        enclosed = True
        for px, py in points_xy:
            p1 = px * d1[0] + py * d1[1]
            p2 = px * d2[0] + py * d2[1]
            p3 = px * d3[0] + py * d3[1]
            if not (u_min - 1e-5 <= p1 <= u_max + 1e-5 and
                    v_min - 1e-5 <= p2 <= v_max + 1e-5 and
                    w_min - 1e-5 <= p3 <= w_max + 1e-5):
                enclosed = False
                break

        if enclosed and area < min_area:
            min_area = area
            best_hex = vertices

    return best_hex


def generate_lla(buffer_km: float = 7.5, geojson_path: str | None = None) -> dict[str, Any]:
    points = DEFAULT_DISTRICT_POINTS
    if geojson_path and os.path.isfile(geojson_path):
        with open(geojson_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            # Extract coordinates if valid feature
            features = data.get("features", [])
            extracted = []
            for feat in features:
                geom = feat.get("geometry", {})
                coords = geom.get("coordinates", [])
                if geom.get("type") == "Polygon":
                    for ring in coords:
                        for pt in ring:
                            extracted.append([pt[1], pt[0]])
                elif geom.get("type") == "MultiPolygon":
                    for poly in coords:
                        for ring in poly:
                            for pt in ring:
                                extracted.append([pt[1], pt[0]])
            if extracted:
                points = extracted

    lat0 = sum(p[0] for p in points) / len(points)
    lng0 = sum(p[1] for p in points) / len(points)

    points_xy = [project_to_xy(p[0], p[1], lat0, lng0) for p in points]
    buffered_xy = buffer_polygon_xy(points_xy, buffer_km)
    hex_xy = compute_bounding_hexagon(buffered_xy)

    vertices_latlng = [list(unproject_from_xy(hx, hy, lat0, lng0)) for hx, hy in hex_xy]
    centroid_latlng = [round(lat0, 6), round(lng0, 6)]

    lats = [v[0] for v in vertices_latlng]
    lngs = [v[1] for v in vertices_latlng]

    return {
        "version": 1,
        "name": "Limited Lipht Area (LLA)",
        "description": "Authoritative 6-vertex bounding hexagon covering Unakoti and North Tripura with buffer",
        "buffer_km": buffer_km,
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

    # 1. config/lla.json
    with open("config/lla.json", "w", encoding="utf-8") as f:
        json.dump(lla_data, f, indent=2)

    # 2. docs/lla-preview.geojson
    vertices = lla_data["vertices"]
    geojson_polygon = [[v[1], v[0]] for v in vertices]
    geojson_polygon.append(geojson_polygon[0])  # close ring

    district_pts = [[p[1], p[0]] for p in DEFAULT_DISTRICT_POINTS]
    district_pts.append(district_pts[0])

    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Unakoti & North Tripura Core District Outline"},
                "geometry": {"type": "Polygon", "coordinates": [district_pts]}
            },
            {
                "type": "Feature",
                "properties": {"name": "LLA 6-Vertex Bounding Hexagon (with buffer)"},
                "geometry": {"type": "Polygon", "coordinates": [geojson_polygon]}
            }
        ]
    }
    with open("docs/lla-preview.geojson", "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2)

    # 3. docs/lla-preview.svg
    bbox = lla_data["bounding_box"]
    min_lat, max_lat = bbox["min_lat"] - 0.05, bbox["max_lat"] + 0.05
    min_lng, max_lng = bbox["min_lng"] - 0.05, bbox["max_lng"] + 0.05

    width, height = 700, 800

    def to_svg_xy(lat: float, lng: float) -> tuple[float, float]:
        sx = ((lng - min_lng) / (max_lng - min_lng)) * (width - 80) + 40
        sy = height - 40 - (((lat - min_lat) / (max_lat - min_lat)) * (height - 80))
        return sx, sy

    hex_svg_pts = " ".join(f"{to_svg_xy(v[0], v[1])[0]:.1f},{to_svg_xy(v[0], v[1])[1]:.1f}" for v in vertices)
    core_svg_pts = " ".join(f"{to_svg_xy(p[0], p[1])[0]:.1f},{to_svg_xy(p[0], p[1])[1]:.1f}" for p in DEFAULT_DISTRICT_POINTS)

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" style="background:#0f172a; font-family:sans-serif;">
  <defs>
    <linearGradient id="llaGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0.10"/>
    </linearGradient>
  </defs>

  <text x="40" y="45" fill="#f8fafc" font-size="22" font-weight="bold">LiphtUp LLA Geofence Preview</text>
  <text x="40" y="70" fill="#94a3b8" font-size="14">Unakoti &amp; North Tripura Districts + 7.5km Buffer (6-Vertex Hexagon)</text>

  <!-- LLA Hexagon -->
  <polygon points="{hex_svg_pts}" fill="url(#llaGrad)" stroke="#38bdf8" stroke-width="3" stroke-dasharray="8,4"/>

  <!-- Core District Outline -->
  <polygon points="{core_svg_pts}" fill="#22c55e" fill-opacity="0.2" stroke="#22c55e" stroke-width="2"/>

  <!-- Vertices -->
"""
    for i, v in enumerate(vertices):
        vx, vy = to_svg_xy(v[0], v[1])
        svg += f'  <circle cx="{vx:.1f}" cy="{vy:.1f}" r="5" fill="#38bdf8"/>\n'
        svg += f'  <text x="{vx+8:.1f}" y="{vy+4:.1f}" fill="#bae6fd" font-size="11">V{i+1} ({v[0]:.2f}, {v[1]:.2f})</text>\n'

    # Legend
    svg += f"""
  <g transform="translate(40, {height - 90})">
    <rect width="320" height="65" rx="8" fill="#1e293b" stroke="#334155"/>
    <circle cx="20" cy="20" r="5" fill="#22c55e"/>
    <text x="35" y="24" fill="#e2e8f0" font-size="12">Core District Territory (Unakoti + N. Tripura)</text>
    <line x1="15" y1="45" x2="25" y2="45" stroke="#38bdf8" stroke-width="3" stroke-dasharray="4,2"/>
    <text x="35" y="49" fill="#e2e8f0" font-size="12">Authoritative LLA Hexagon (Buffer: 7.5km)</text>
  </g>
</svg>"""

    with open("docs/lla-preview.svg", "w", encoding="utf-8") as f:
        f.write(svg)


if __name__ == "__main__":
    lla = generate_lla(buffer_km=7.5)
    write_outputs(lla)
    print(f"Generated LLA with {len(lla['vertices'])} vertices.")
    print(f"Centroid: {lla['centroid']}")
    print(f"Vertices: {lla['vertices']}")
