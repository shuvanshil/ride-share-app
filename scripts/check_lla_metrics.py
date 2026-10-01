import json
import math
from api.core.geo import is_in_lla, is_point_in_polygon

with open('config/lla.json') as f:
    lla = json.load(f)

with open('config/zones.json') as f:
    zones = json.load(f)

pts_inside = {
    'Kailashahar': (24.3314, 92.0084),
    'Kumarghat': (24.1612, 92.0305),
    'Dharmanagar': (24.3768, 92.1643),
    'Boulapassa': (24.3725, 92.0715),
    'Kacharghat': (24.3210, 92.0250)
}
pts_outside = {
    'Agartala': (23.8315, 91.2868),
    'Udaipur': (23.5336, 91.4817),
    'Belonia': (23.2505, 91.4542)
}

print('=== INSIDE CHECKS ===')
for name, (lat, lng) in pts_inside.items():
    res = is_in_lla(lat, lng, lla)
    print(f'{name}: {"INSIDE (PASS)" if res else "OUTSIDE (FAIL)"}')

print('=== OUTSIDE CHECKS ===')
for name, (lat, lng) in pts_outside.items():
    res = is_in_lla(lat, lng, lla)
    print(f'{name}: {"OUTSIDE (PASS)" if not res else "INSIDE (FAIL)"}')

# Calculate LLA Area
lat0, lng0 = lla["centroid"]
km_lat = 110.574
km_lng = 111.320 * math.cos(math.radians(lat0))

def to_xy(lat, lng):
    return (lng - lng0) * km_lng, (lat - lat0) * km_lat

lla_verts_xy = [to_xy(v[0], v[1]) for v in lla["vertices"]]
n = len(lla_verts_xy)
lla_area = 0.5 * abs(sum(lla_verts_xy[i][0] * lla_verts_xy[(i+1)%n][1] - lla_verts_xy[(i+1)%n][0] * lla_verts_xy[i][1] for i in range(n)))
print(f'\nTotal LLA Area: {lla_area:.2f} km^2')

s = zones["size_km"]
cell_area = (3.0 * math.sqrt(3) / 2.0) * (s ** 2)
print(f'Single Cell Area (s={s}km): {cell_area:.2f} km^2')

# Monte Carlo / dense grid sampling to calculate percentage of each cell inside LLA
print('\n=== CELL COVERAGE METRICS ===')
for cell in zones["cells"]:
    c_verts_xy = [to_xy(v[0], v[1]) for v in cell["vertices"]]
    min_x = min(p[0] for p in c_verts_xy)
    max_x = max(p[0] for p in c_verts_xy)
    min_y = min(p[1] for p in c_verts_xy)
    max_y = max(p[1] for p in c_verts_xy)
    
    samples_in_cell = 0
    samples_in_both = 0
    steps = 60
    for ix in range(steps):
        px = min_x + (max_x - min_x) * (ix / (steps - 1))
        for iy in range(steps):
            py = min_y + (max_y - min_y) * (iy / (steps - 1))
            
            # check if in cell
            # raycast
            inside_cell = False
            nc = len(c_verts_xy)
            jc = nc - 1
            for ic in range(nc):
                xic, yic = c_verts_xy[ic]
                xjc, yjc = c_verts_xy[jc]
                if ((yic > py) != (yjc > py)) and (px < (xjc - xic) * (py - yic) / (yjc - yic + 1e-12) + xic):
                    inside_cell = not inside_cell
                jc = ic
            
            if inside_cell:
                samples_in_cell += 1
                # check if inside lla
                inside_lla = False
                jl = n - 1
                for il in range(n):
                    xil, yil = lla_verts_xy[il]
                    xjl, yjl = lla_verts_xy[jl]
                    if ((yil > py) != (yjl > py)) and (px < (xjl - xil) * (py - yil) / (yjl - yil + 1e-12) + xil):
                        inside_lla = not inside_lla
                    jl = il
                if inside_lla:
                    samples_in_both += 1
                    
    pct = (samples_in_both / max(1, samples_in_cell)) * 100.0
    print(f'Zone {cell["id"]} (q={cell["q"]}, r={cell["r"]}): {pct:.1f}% inside LLA')
