# LLA Boundary Verification Guide

This document explains how to verify the **Limited Lipht Area (LLA)** against authoritative district boundaries for Unakoti and North Tripura, and how to regenerate the geofence if the boundary check fails.

---

## 1. Overview

The LLA geofence is defined in [`config/lla.json`](file:///C:/Users/theto/.gemini/antigravity/worktrees/ride-share-app/pull_latest_main_branch/config/lla.json) as a convex 6-vertex polygon covering Unakoti and North Tripura districts with a minimum **5 km buffer** at every border vertex.

The verification tool (`scripts/check_boundary.py`) evaluates real boundary vertices against the LLA geometry to calculate:
- **Vertex Containment**: Percentage and count of district boundary points outside the LLA.
- **Minimum Buffer Distance**: Distance (km) from the closest boundary vertex to the LLA polygon edge.
- **Farthest Outline to Edge Distance**: Maximum distance (km) from any district vertex to the LLA edge.
- **Pass/Fail Status**: `PASS` if 100% of vertices are inside and minimum buffer $\ge 5.0\text{ km}$.

---

## 2. Supplying Real District GeoJSON

To verify with real OpenStreetMap (OSM) or Survey of India / Datameet boundaries:

1. Obtain the GeoJSON polygon/multipolygon for **Unakoti** and **North Tripura** districts from:
   - [OpenStreetMap Overpass Turbo](https://overpass-turbo.eu/) using query: `relation["admin_level"="5"]["name"~"Unakoti|North Tripura"]; out geom;`
   - [DataMeet India Maps Repository](https://github.com/datameet/maps/tree/master/Districts)
2. Save the file to the repository data directory:
   ```bash
   data/districts.geojson
   ```

---

## 3. Running the Verification Tool

Run the tool using Python:

```bash
python scripts/check_boundary.py
```

To run with a custom GeoJSON path or minimum buffer threshold:

```bash
python scripts/check_boundary.py --geojson path/to/custom_districts.geojson --min-buffer 5.0
```

### Expected Successful Output
```text
================================================================================
                   LIPHTUP LLA BOUNDARY VERIFICATION REPORT                     
================================================================================
LLA Area:                 3045.75 km2
LLA Vertices:             6
Evaluated Real Vertices:  184
Real Area/Vertices Outside: 0.00% (0/184)
Minimum Buffer Distance:  5.21 km (Required: >= 5.00 km)
Farthest Outline to Edge: 16.42 km
--------------------------------------------------------------------------------
RESULT: PASS - All district vertices are inside LLA with >= 5.00 km buffer.
================================================================================
```

---

## 4. Remediation If the Check Fails

If the check outputs `RESULT: FAIL` (e.g., real district coordinates extend beyond the provisional polygon or buffer $< 5.0\text{ km}$):

1. **Regenerate LLA and Zones**:
   Run the LLA generator script passing the real district GeoJSON:
   ```bash
   python scripts/generate_lla.py --input-boundary data/districts.geojson --min-buffer 5.0
   ```
2. **Review Geometry Previews**:
   - Inspect [`docs/lla-preview.svg`](file:///C:/Users/theto/.gemini/antigravity/worktrees/ride-share-app/pull_latest_main_branch/docs/lla-preview.svg) and [`docs/zones-preview.svg`](file:///C:/Users/theto/.gemini/antigravity/worktrees/ride-share-app/pull_latest_main_branch/docs/zones-preview.svg).
   - Ensure the new polygon is convex, 6 vertices, and area remains well under $5,000\text{ km}^2$.
3. **Re-run the Verification Tool**:
   ```bash
   python scripts/check_boundary.py
   ```
4. **Execute Full Test Suite**:
   ```bash
   python -m pytest
   ```
