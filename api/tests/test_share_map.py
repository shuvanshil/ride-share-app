from datetime import datetime, timezone
import pytest
from api.core.geo import decode_polyline, encode_polyline
from api.core.share_routing import recompute_shared_info_and_stops


def test_encode_and_decode_polyline() -> None:
    points = [(23.8315, 91.2868), (23.8350, 91.2900), (23.8400, 91.2950)]
    encoded = encode_polyline(points)
    assert isinstance(encoded, str)
    assert len(encoded) > 0
    decoded = decode_polyline(encoded)
    assert len(decoded) == 3
    for orig, dec in zip(points, decoded):
        assert abs(orig[0] - dec[0]) < 1e-4
        assert abs(orig[1] - dec[1]) < 1e-4


def test_shared_info_privacy_sanitization() -> None:
    driver_pos = (23.8300, 91.2800)
    now = datetime(2026, 10, 2, 10, 0, 0, tzinfo=timezone.utc)
    
    parent_trip = {
        "tripId": "trip_share_999",
        "driverId": "driver_1",
        "seatsUsed": 2,
        "remoteOnBoard": 0,
        "stopOrder": [
            {
                "kind": "pickup",
                "rideId": "ride_p1",
                "lat": 23.8320,
                "lng": 91.2820,
                "name": "Secret Passenger 1",
                "fare": 150,
                "photo": "https://secret.photo/p1.jpg",
                "status": "pending",
                "seatOrder": 1,
            },
            {
                "kind": "pickup",
                "rideId": "ride_p2",
                "lat": 23.8340,
                "lng": 91.2840,
                "name": "Secret Passenger 2",
                "fare": 200,
                "photo": "https://secret.photo/p2.jpg",
                "status": "pending",
                "seatOrder": 2,
            },
            {
                "kind": "drop",
                "rideId": "ride_p1",
                "lat": 23.8400,
                "lng": 91.2900,
                "name": "Secret Destination 1",
                "status": "pending",
                "seatOrder": 1,
            },
            {
                "kind": "drop",
                "rideId": "ride_p2",
                "lat": 23.8450,
                "lng": 91.2950,
                "name": "Secret Destination 2",
                "status": "pending",
                "seatOrder": 2,
            },
        ],
    }

    child_rides = [
        {
            "ride_id": "ride_p1",
            "status": "accepted",
            "passenger_name": "Secret Passenger 1",
            "fare": 150,
            "drop_lat": 23.8400,
            "drop_lng": 91.2900,
            "seatOrder": 1,
            "baselineEtaIso": now.isoformat(),
        },
        {
            "ride_id": "ride_p2",
            "status": "accepted",
            "passenger_name": "Secret Passenger 2",
            "fare": 200,
            "drop_lat": 23.8450,
            "drop_lng": 91.2950,
            "seatOrder": 2,
            "baselineEtaIso": now.isoformat(),
        },
    ]

    full_stops, shared_info = recompute_shared_info_and_stops(driver_pos, parent_trip, child_rides, start_time=now)

    p1_shared = shared_info["ride_p1"]
    p2_shared = shared_info["ride_p2"]

    assert "Secret Passenger 2" not in str(p1_shared)
    assert "Secret Destination 2" not in str(p1_shared)
    assert "https://secret.photo/p2.jpg" not in str(p1_shared)
    assert 200 not in p1_shared.values()

    assert "Secret Passenger 1" not in str(p2_shared)
    assert "Secret Destination 1" not in str(p2_shared)
    assert "https://secret.photo/p1.jpg" not in str(p2_shared)
    assert 150 not in p2_shared.values()

    assert "routePolyline" in p1_shared
    assert isinstance(p1_shared["routePolyline"], str)
    assert len(p1_shared["routePolyline"]) > 0

    assert "stopsBeforeYou" in p1_shared
    assert isinstance(p1_shared["stopsBeforeYou"], int)


def test_next_pickup_lifecycle_and_clearing() -> None:
    driver_pos = (23.8300, 91.2800)
    now = datetime(2026, 10, 2, 10, 0, 0, tzinfo=timezone.utc)
    
    parent_trip = {
        "tripId": "trip_share_999",
        "driverId": "driver_1",
        "seatsUsed": 2,
        "remoteOnBoard": 0,
        "stopOrder": [
            {
                "kind": "pickup",
                "rideId": "ride_p1",
                "lat": 23.8320,
                "lng": 91.2820,
                "status": "completed",
                "seatOrder": 1,
            },
            {
                "kind": "pickup",
                "rideId": "ride_p2",
                "lat": 23.8340,
                "lng": 91.2840,
                "status": "pending",
                "seatOrder": 2,
            },
            {
                "kind": "drop",
                "rideId": "ride_p1",
                "lat": 23.8400,
                "lng": 91.2900,
                "status": "pending",
                "seatOrder": 1,
            },
            {
                "kind": "drop",
                "rideId": "ride_p2",
                "lat": 23.8450,
                "lng": 91.2950,
                "status": "pending",
                "seatOrder": 2,
            },
        ],
    }

    child_rides_stage1 = [
        {
            "ride_id": "ride_p1",
            "status": "en_route",
            "pinVerifiedAt": "2026-10-02T10:05:00Z",
            "seatOrder": 1,
            "baselineEtaIso": now.isoformat(),
        },
        {
            "ride_id": "ride_p2",
            "status": "accepted",
            "seatOrder": 2,
            "baselineEtaIso": now.isoformat(),
        },
    ]

    _, shared_info_stage1 = recompute_shared_info_and_stops(driver_pos, parent_trip, child_rides_stage1, start_time=now)
    
    p1_shared_stage1 = shared_info_stage1["ride_p1"]
    assert p1_shared_stage1["nextPickup"] is not None
    assert p1_shared_stage1["nextPickup"]["lat"] == 23.8340
    assert p1_shared_stage1["nextPickup"]["lng"] == 91.2840

    parent_trip_stage2 = {
        "tripId": "trip_share_999",
        "driverId": "driver_1",
        "seatsUsed": 2,
        "remoteOnBoard": 0,
        "stopOrder": [
            {
                "kind": "pickup",
                "rideId": "ride_p1",
                "lat": 23.8320,
                "lng": 91.2820,
                "status": "completed",
                "seatOrder": 1,
            },
            {
                "kind": "pickup",
                "rideId": "ride_p2",
                "lat": 23.8340,
                "lng": 91.2840,
                "status": "completed",
                "seatOrder": 2,
            },
            {
                "kind": "drop",
                "rideId": "ride_p1",
                "lat": 23.8400,
                "lng": 91.2900,
                "status": "pending",
                "seatOrder": 1,
            },
            {
                "kind": "drop",
                "rideId": "ride_p2",
                "lat": 23.8450,
                "lng": 91.2950,
                "status": "pending",
                "seatOrder": 2,
            },
        ],
    }

    child_rides_stage2 = [
        {
            "ride_id": "ride_p1",
            "status": "en_route",
            "pinVerifiedAt": "2026-10-02T10:05:00Z",
            "seatOrder": 1,
            "baselineEtaIso": now.isoformat(),
        },
        {
            "ride_id": "ride_p2",
            "status": "en_route",
            "pinVerifiedAt": "2026-10-02T10:10:00Z",
            "seatOrder": 2,
            "baselineEtaIso": now.isoformat(),
        },
    ]

    _, shared_info_stage2 = recompute_shared_info_and_stops(driver_pos, parent_trip_stage2, child_rides_stage2, start_time=now)

    p1_shared_stage2 = shared_info_stage2["ride_p1"]
    assert p1_shared_stage2["nextPickup"] is None


def test_route_polyline_regenerated_on_lifecycle_event() -> None:
    driver_pos1 = (23.8300, 91.2800)
    now = datetime(2026, 10, 2, 10, 0, 0, tzinfo=timezone.utc)
    
    parent_trip = {
        "tripId": "trip_share_1",
        "seatsUsed": 1,
        "remoteOnBoard": 0,
        "stopOrder": [
            {"kind": "pickup", "rideId": "r1", "lat": 23.8320, "lng": 91.2820, "status": "pending", "seatOrder": 1},
            {"kind": "drop", "rideId": "r1", "lat": 23.8400, "lng": 91.2900, "status": "pending", "seatOrder": 1},
        ],
    }
    child_rides = [{"ride_id": "r1", "status": "accepted", "seatOrder": 1, "baselineEtaIso": now.isoformat()}]

    _, info1 = recompute_shared_info_and_stops(driver_pos1, parent_trip, child_rides, start_time=now)
    poly1 = info1["r1"]["routePolyline"]
    assert len(poly1) > 0
    decoded1 = decode_polyline(poly1)
    assert len(decoded1) >= 2

    driver_pos2 = (23.8320, 91.2820)
    parent_trip["stopOrder"][0]["status"] = "completed"
    child_rides[0]["status"] = "en_route"
    child_rides[0]["pinVerifiedAt"] = now.isoformat()

    _, info2 = recompute_shared_info_and_stops(driver_pos2, parent_trip, child_rides, start_time=now)
    poly2 = info2["r1"]["routePolyline"]
    assert len(poly2) > 0
    assert poly2 != poly1
    decoded2 = decode_polyline(poly2)
    assert abs(decoded2[0][0] - driver_pos2[0]) < 1e-4
    assert abs(decoded2[0][1] - driver_pos2[1]) < 1e-4
