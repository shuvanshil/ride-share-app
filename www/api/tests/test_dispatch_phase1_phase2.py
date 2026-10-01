from __future__ import annotations

import pytest
from api.core.dispatch_config import (
    DispatchConfig,
    load_dispatch_config,
    load_lla_config,
    load_zones_config,
)
from api.core.geo import (
    get_all_zone_ids,
    get_zone_neighbors,
    get_zone_ring,
    is_in_lla,
    is_point_in_polygon,
    point_to_zone,
)


def test_lla_config_structure():
    lla = load_lla_config()
    assert lla.get("version") in (1, 2)
    assert len(lla.get("vertices", [])) == 6
    assert "centroid" in lla
    assert "bounding_box" in lla


def test_lla_inside_outside_points():
    lla = load_lla_config()
    centroid = lla["centroid"]

    # Centroid must be inside
    assert is_in_lla(centroid[0], centroid[1], lla) is True

    # Inside Unakoti & North Tripura points (all recalled, unverified coordinates):
    inside_towns = [
        ("Kailashahar", 24.3314, 92.0084),
        ("Kumarghat", 24.1612, 92.0305),
        ("Dharmanagar", 24.3768, 92.1643),
        ("Panisagar", 24.2800, 92.1400),
        ("Kanchanpur", 23.9700, 92.2200),
        ("Churaibari", 24.4600, 92.2400),
        ("Pecharthal", 24.1200, 92.0800),
        ("Boulapassa", 24.3725, 92.0715),
        ("Kacharghat", 24.3210, 92.0250),
    ]

    # Test center point and a 3 km envelope (approx +/- 0.025 deg) around each inside town
    delta = 0.025  # ~2.75 km
    for name, lat, lng in inside_towns:
        assert is_in_lla(lat, lng, lla) is True, f"{name} center should be inside LLA"
        assert is_in_lla(lat + delta, lng, lla) is True, f"{name} +3km north should be inside LLA"
        assert is_in_lla(lat - delta, lng, lla) is True, f"{name} -3km south should be inside LLA"
        assert is_in_lla(lat, lng + delta, lla) is True, f"{name} +3km east should be inside LLA"
        assert is_in_lla(lat, lng - delta, lla) is True, f"{name} -3km west should be inside LLA"

    # Locations clearly outside LLA (recalled, unverified coordinates):
    outside_towns = [
        ("Agartala", 23.8315, 91.2868),
        ("Udaipur", 23.5336, 91.4817),
        ("Belonia", 23.2505, 91.4542),
        ("Teliamura", 23.8330, 91.6000),
        ("Khowai", 24.0625, 91.6042),
        ("Kolkata", 22.5726, 88.3639),
    ]

    for name, lat, lng in outside_towns:
        assert is_in_lla(lat, lng, lla) is False, f"{name} should be outside LLA"
        assert is_in_lla(lat + delta, lng, lla) is False, f"{name} +3km should be outside LLA"
        assert is_in_lla(lat - delta, lng, lla) is False, f"{name} -3km should be outside LLA"

    assert is_in_lla(0.0, 0.0, lla) is False


def test_lla_vertices_and_edges():
    lla = load_lla_config()
    vertices = lla["vertices"]

    # Each vertex should be on/inside the polygon or evaluated cleanly without error
    for v in vertices:
        # Check that raycasting executes cleanly
        res = is_point_in_polygon(v[0], v[1], vertices)
        assert isinstance(res, bool)

    # Empty / tiny polygon returns False
    assert is_point_in_polygon(24.0, 92.0, []) is False
    assert is_point_in_polygon(24.0, 92.0, [[24.0, 92.0], [24.1, 92.1]]) is False


def test_zones_config_structure():
    zones = load_zones_config()
    assert zones.get("version") in (1, 2)
    count = zones.get("zone_count")
    assert 10 <= count <= 12
    assert len(zones.get("cells", [])) == count
    assert "neighbors" in zones
    assert "rings" in zones


def test_zones_round_trip_cell_centers():
    zones = load_zones_config()
    cells = zones["cells"]

    for cell in cells:
        cid = cell["id"]
        center = cell["center"]
        mapped_zone = point_to_zone(center[0], center[1], zones)
        assert mapped_zone == cid, f"Cell center {center} mapped to {mapped_zone} instead of {cid}"


def test_zones_neighbor_symmetry():
    zones = load_zones_config()
    neighbors = zones["neighbors"]

    for zid, n_list in neighbors.items():
        for nid in n_list:
            assert zid in neighbors[nid], f"Adjacency asymmetry: {zid} -> {nid} but not {nid} -> {zid}"


def test_zones_rings_expansion():
    zones = load_zones_config()
    all_zone_ids = set(get_all_zone_ids(zones))

    for zid in all_zone_ids:
        ring0 = get_zone_ring(zid, ring_level=0, zones_config=zones)
        assert ring0 == [zid]

        ring1 = get_zone_ring(zid, ring_level=1, zones_config=zones)
        neighbors = get_zone_neighbors(zid, zones_config=zones)
        assert set(ring1) == set([zid, *neighbors])

        # Large ring covers all zones
        max_ring = get_zone_ring(zid, ring_level=10, zones_config=zones)
        assert set(max_ring) == all_zone_ids


def test_dispatch_config_validation():
    cfg = DispatchConfig()
    assert cfg.lla_enforce is False
    assert cfg.require_dropoff_inside is True
    assert cfg.offer_timeout_seconds == 15
    assert cfg.location_freshness_seconds == 60
    assert cfg.batch_hold_ms == 1500
    assert cfg.candidates_k == 8

    # Invalid values raise validation errors
    with pytest.raises(Exception):
        DispatchConfig(offer_timeout_seconds=2)
    with pytest.raises(Exception):
        DispatchConfig(candidates_k=0)
