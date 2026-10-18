from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from api.index import app
from api.routers.rides import current_user
from tests.test_live_ride_tracking_simulation import MockFirestoreDb


def test_driver_location_calculates_remaining_km_and_eta():
    db = MockFirestoreDb()
    driver_uid = "drv_test_eta_101"
    passenger_uid = "pass_test_eta_202"
    ride_id = "ride_test_eta_303"

    # Setup approved driver
    db.collection("users").document(driver_uid).set({
        "uid": driver_uid,
        "name": "Test Driver",
        "role": "driver",
        "verificationStatus": "approved",
        "desiredAvailability": "online",
        "driverAvailability": "busy",
    })

    # Setup active en_route ride
    pickup_lat, pickup_lng = 23.8320, 91.2800
    drop_lat, drop_lng = 23.8500, 91.3000
    db.collection("rides").document(ride_id).set({
        "ride_id": ride_id,
        "driver_id": driver_uid,
        "passenger_id": passenger_uid,
        "status": "en_route",
        "pinVerifiedAt": datetime.now(timezone.utc),
        "pickup_lat": pickup_lat,
        "pickup_lng": pickup_lng,
        "drop_lat": drop_lat,
        "drop_lng": drop_lng,
        "distance_km": 5.0,
        "duration_minutes": 15,
        "max_travelled_km": 1.5,
    })

    client = TestClient(app)
    app.dependency_overrides[current_user] = lambda: {"uid": driver_uid, "role": "driver"}

    with patch("api.routers.rides.fb_firestore.client", return_value=db), \
         patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

        # 1. Update location on /api/rides/driver-location with speed = 10 m/s (36 km/h)
        resp1 = client.post("/api/rides/driver-location", json={
            "lat": 23.8350,
            "lng": 91.2850,
            "rideId": ride_id,
            "driverHeading": 45.0,
            "driverSpeed": 10.0,
            "driverAccuracy": 5.0,
        })
        assert resp1.status_code == 200
        data1 = resp1.json()
        assert data1["ok"] is True
        assert data1["rideId"] == ride_id
        assert data1["remaining_km"] is not None
        assert data1["remaining_km"] == 3.5  # 5.0 planned - 1.5 travelled
        assert data1["eta_mins"] is not None
        # 3.5 km at 36 km/h -> 3.5 / 36 * 60 = 5.83 -> 6 mins
        assert data1["eta_mins"] == 6

        # 2. Test /api/rides/location-update route alias
        resp2 = client.post("/api/rides/location-update", json={
            "lat": 23.8350,
            "lng": 91.2850,
            "rideId": ride_id,
            "driverHeading": 45.0,
            "driverSpeed": 10.0,
            "driverAccuracy": 5.0,
        })
        assert resp2.status_code == 200
        data2 = resp2.json()
        assert data2["ok"] is True
        assert data2["remaining_km"] == 3.5
        assert data2["eta_mins"] == 6

        # 3. Test /api/v1/driver/location-update endpoint
        resp3 = client.post("/api/v1/driver/location-update", json={
            "lat": 23.8350,
            "lng": 91.2850,
            "rideId": ride_id,
            "driverHeading": 45.0,
            "driverSpeed": 10.0,
            "driverAccuracy": 5.0,
        })
        assert resp3.status_code == 200
        data3 = resp3.json()
        assert data3["ok"] is True
        assert data3["remaining_km"] == 3.5
        assert data3["eta_mins"] == 6

        # 4. Test arrival near destination (< 50m)
        db.collection("rides").document(ride_id).set({
            "max_travelled_km": 5.0,
        }, merge=True)
        resp_arrived = client.post("/api/rides/driver-location", json={
            "lat": drop_lat,
            "lng": drop_lng,
            "rideId": ride_id,
            "driverSpeed": 0.0,
        })
        assert resp_arrived.status_code == 200
        data_arr = resp_arrived.json()
        assert data_arr["remaining_km"] == 0.0
        assert data_arr["eta_mins"] == 0

        # 5. When no ride is active
        resp_no_ride = client.post("/api/rides/driver-location", json={
            "lat": 23.8320,
            "lng": 91.2800,
            "rideId": None,
        })
        assert resp_no_ride.status_code == 200
        data_no_ride = resp_no_ride.json()
        assert data_no_ride["ok"] is True
        assert data_no_ride["remaining_km"] is None
        assert data_no_ride["eta_mins"] is None

        # 6. Test 'accepted' state with camelCase pickupLat/pickupLng
        ride_accepted_id = "ride_test_accepted_404"
        db.collection("rides").document(ride_accepted_id).set({
            "ride_id": ride_accepted_id,
            "driver_id": driver_uid,
            "passenger_id": passenger_uid,
            "status": "accepted",
            "pickupLat": 23.8400,
            "pickupLng": 91.2900,
            "distanceKm": 4.0,
            "durationMinutes": 12,
        })
        resp_accepted = client.post("/api/rides/driver-location", json={
            "lat": 23.8350,
            "lng": 91.2850,
            "rideId": ride_accepted_id,
            "driverSpeed": 1.0,  # Below 2.0 m/s threshold -> uses planned duration ratio
        })
        assert resp_accepted.status_code == 200
        data_acc = resp_accepted.json()
        assert data_acc["ok"] is True
        assert data_acc["remaining_km"] is not None
        assert data_acc["remaining_km"] > 0
        assert data_acc["eta_mins"] is not None
        assert data_acc["eta_mins"] >= 1

        # 7. Test missing/zero coordinates do NOT calculate bogus 10,000+ km Null Island distance
        ride_no_coords_id = "ride_test_no_coords_505"
        db.collection("rides").document(ride_no_coords_id).set({
            "ride_id": ride_no_coords_id,
            "driver_id": driver_uid,
            "passenger_id": passenger_uid,
            "status": "en_route",
            "distance_km": 6.0,
            "duration_minutes": 18,
            "pickup_lat": 0.0,
            "pickup_lng": 0.0,
            "drop_lat": 0.0,
            "drop_lng": 0.0,
        })
        resp_no_coords = client.post("/api/rides/driver-location", json={
            "lat": 23.8350,
            "lng": 91.2850,
            "rideId": ride_no_coords_id,
            "driverSpeed": 8.0,
        })
        assert resp_no_coords.status_code == 200
        data_nc = resp_no_coords.json()
        assert data_nc["ok"] is True
        # Must fall back to planned distance (6.0), NOT Null Island distance (~10,000 km)
        assert data_nc["remaining_km"] == 6.0
        # 8. Test native background service aliases (heading/speed/accuracy) and leg-route separation
        ride_leg_id = "ride_test_leg_sep_606"
        planned_dest_poly = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
        pickup_approach_poly = "}_~iF~ps|U_c|A_c|A"
        db.collection("rides").document(ride_leg_id).set({
            "ride_id": ride_leg_id,
            "driver_id": driver_uid,
            "passenger_id": passenger_uid,
            "status": "accepted",
            "pickup_lat": 23.8400,
            "pickup_lng": 91.2900,
            "drop_lat": 23.8600,
            "drop_lng": 91.3100,
            "route_polyline": planned_dest_poly,
            "routePolyline": None,
            "routePolylineLeg": "pickup",
            "share_enabled": True,
            "distance_km": 4.0,
            "duration_minutes": 12,
        })
        resp_leg_pickup = client.post("/api/rides/driver-location", json={
            "lat": 23.8360,
            "lng": 91.2860,
            "rideId": ride_leg_id,
            "heading": 128.5,
            "speed": 7.5,
            "accuracy": 4.2,
            "routePolyline": pickup_approach_poly,
            "routePolylineLeg": "pickup",
        })
        assert resp_leg_pickup.status_code == 200
        ride_doc_pickup = db.collection("rides").document(ride_leg_id).get().to_dict()
        assert ride_doc_pickup["driverHeading"] == 128.5
        assert ride_doc_pickup["driverSpeed"] == 7.5
        assert ride_doc_pickup["driverAccuracy"] == 4.2
        assert ride_doc_pickup["routePolyline"] == pickup_approach_poly
        assert ride_doc_pickup["routePolylineLeg"] == "pickup"
        # Planned Pickup->Drop polyline MUST remain intact during approach leg
        assert ride_doc_pickup["route_polyline"] == planned_dest_poly

        share_doc_pickup = db.collection("tripShareView").document(ride_leg_id).get().to_dict()
        assert share_doc_pickup["driverHeading"] == 128.5
        assert share_doc_pickup["routePolyline"] == pickup_approach_poly
        assert share_doc_pickup["routePolylineLeg"] == "pickup"

        # Mismatched leg update (e.g., delayed 'pickup' polyline arriving after ride started) must be ignored
        db.collection("rides").document(ride_leg_id).set({
            "status": "en_route",
            "pinVerifiedAt": datetime.now(timezone.utc),
            "routePolyline": planned_dest_poly,
            "routePolylineLeg": "destination",
        }, merge=True)
        resp_leg_stale = client.post("/api/rides/driver-location", json={
            "lat": 23.8410,
            "lng": 91.2910,
            "rideId": ride_leg_id,
            "heading": 42.0,
            "speed": 9.0,
            "routePolyline": pickup_approach_poly,
            "routePolylineLeg": "pickup",
        })
        assert resp_leg_stale.status_code == 200
        ride_doc_dest = db.collection("rides").document(ride_leg_id).get().to_dict()
        assert ride_doc_dest["routePolyline"] == planned_dest_poly
        assert ride_doc_dest["routePolylineLeg"] == "destination"

    app.dependency_overrides.clear()


