import json
import math
from api.core.geo import is_in_lla, is_point_in_polygon

with open('config/lla.json') as f:
    lla = json.load(f)

with open('config/zones.json') as f:
    zones = json.load(f)

from scripts.generate_lla import DENSE_DISTRICT_OUTLINE, KM_PER_LAT, km_per_lng, project_to_xy

pts_inside = {
    'Kailashahar': (24.3314, 92.0084),
    'Kumarghat': (24.1612, 92.0305),
    'Dharmanagar': (24.3768, 92.1643),
    'Panisagar': (24.2800, 92.1400),
    'Boulapassa': (24.3725, 92.0715),
    'Kacharghat': (24.3210, 92.0250),
    'Kanchanpur': (23.9700, 92.2200),
    'Churaibari': (24.4600, 92.2400),
    'Pecharthal': (24.1200, 92.0800),
}
pts_outside = {
    'Agartala': (23.8315, 91.2868),
    'Udaipur': (23.5336, 91.4817),
    'Belonia': (23.2505, 91.4542),
    'Teliamura': (23.8330, 91.6000),
    'Khowai': (24.0625, 91.6042),
}

print('=== INSIDE CHECKS ===')
for name, (lat, lng) in pts_inside.items():
    res = is_in_lla(lat, lng, lla)
    print(f'{name} ({lat}, {lng}): {"INSIDE (PASS)" if res else "OUTSIDE (FAIL)"}')

print('\n=== OUTSIDE CHECKS ===')
for name, (lat, lng) in pts_outside.items():
    res = is_in_lla(lat, lng, lla)
    print(f'{name} ({lat}, {lng}): {"OUTSIDE (PASS)" if not res else "INSIDE (FAIL)"}')

lat0, lng0 = lla["centroid"]

def to_xy(lat, lng):
    return (lng - lng0) * km_per_lng(lat0), (lat - lat0) * KM_PER_LAT

district_xy = [to_xy(p[0], p[1]) for p in DENSE_DISTRICT_OUTLINE]
lla_verts_xy = [to_xy(v[0], v[1]) for v in lla["vertices"]]
n_lla = len(lla_verts_xy)
n_dist = len(district_xy)

lla_area = 0.5 * abs(sum(lla_verts_xy[i][0] * lla_verts_xy[(i+1)%n_lla][1] - lla_verts_xy[(i+1)%n_lla][0] * lla_verts_xy[i][1] for i in range(n_lla)))
dist_area = 0.5 * abs(sum(district_xy[i][0] * district_xy[(i+1)%n_dist][1] - district_xy[(i+1)%n_dist][0] * district_xy[i][1] for i in range(n_dist)))

print(f'\nTotal LLA Area: {lla_area:.2f} km^2')
print(f'District Outline Area: {dist_area:.2f} km^2')
print(f'Minimum Buffer: {lla.get("min_buffer_km")} km')
print(f'Maximum Distance: {lla.get("max_distance_km")} km')

s = zones["size_km"]
cell_area = (3.0 * math.sqrt(3) / 2.0) * (s ** 2)
print(f'Single Cell Area (s={s}km): {cell_area:.2f} km^2')

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

# Dense grid sampling to compute area intersections
print('\n=== PER-ZONE METRICS ===')
for cell in zones["cells"]:
    c_verts_xy = [to_xy(v[0], v[1]) for v in cell["vertices"]]
    min_x = min(p[0] for p in c_verts_xy)
    max_x = max(p[0] for p in c_verts_xy)
    min_y = min(p[1] for p in c_verts_xy)
    max_y = max(p[1] for p in c_verts_xy)

    samples_cell = 0
    samples_lla = 0
    samples_district = 0
    steps = 80
    for ix in range(steps):
        px = min_x + (max_x - min_x) * (ix / (steps - 1))
        for iy in range(steps):
            py = min_y + (max_y - min_y) * (iy / (steps - 1))
            if point_in_polygon_2d(px, py, c_verts_xy):
                samples_cell += 1
                if point_in_polygon_2d(px, py, lla_verts_xy):
                    samples_lla += 1
                if point_in_polygon_2d(px, py, district_xy):
                    samples_district += 1

    pct_inside_lla = (samples_lla / max(1, samples_cell)) * 100.0
    # Percentage of district outline area inside this cell
    pct_of_district = ((samples_district / max(1, samples_cell)) * cell_area / dist_area) * 100.0
    print(f'Zone {cell["id"]} (q={cell["q"]:>2}, r={cell["r"]:>2}): {pct_inside_lla:>5.1f}% inside LLA | {pct_of_district:>5.1f}% of district outline')
