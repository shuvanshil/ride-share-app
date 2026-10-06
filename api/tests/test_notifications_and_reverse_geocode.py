import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from api.index import app
from api.core.errors import ApiError

client = TestClient(app)

class FakeDoc:
    def __init__(self, exists=True, data=None, doc_id="test_id"):
        self.exists = exists
        self._data = data or {}
        self.id = doc_id
        self.reference = MagicMock()
        self.reference.id = doc_id

    def to_dict(self):
        return self._data


def test_notify_ride_request_fare_defined():
    """Verify notify_ride_request does not crash with NameError: fare is not defined."""
    from api.routers import notify as notify_module

    fake_ride = {
        "passenger_id": "passenger_123",
        "status": "pending",
        "eligible_driver_ids": ["driver_456"],
        "pickup_name": "Agartala Station",
        "drop_name": "Battala Market",
        "fare": 75.0,
    }

    fake_driver_presence = {
        "notificationEligibleUntil": "2030-01-01T00:00:00Z",
        "pushTokens": ["token_xyz"],
    }

    mock_db = MagicMock()
    mock_db.collection.return_value.document.return_value.get.side_effect = [
        FakeDoc(exists=True, data=fake_ride, doc_id="ride_123"),
        FakeDoc(exists=True, data=fake_driver_presence, doc_id="driver_456"),
    ]

    with patch.object(notify_module, "get_admin_app", return_value=MagicMock()), \
         patch.object(notify_module, "_verify_passenger", return_value={"uid": "passenger_123"}), \
         patch.object(notify_module.fb_firestore, "client", return_value=mock_db), \
         patch.object(notify_module.fb_messaging, "send_each_for_multicast") as mock_send:

        mock_send.return_value = MagicMock(success_count=1, failure_count=0)

        response = client.post(
            "/api/notify-ride-request",
            json={"rideId": "ride_123", "driverIds": ["driver_456"]},
            headers={"Authorization": "Bearer fake_token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data.get("ok") is True
        assert data.get("sent") == 1
        assert mock_send.called
        msg_arg = mock_send.call_args[0][0]
        assert "Fare: Rs 75" in msg_arg.notification.body


def test_notify_ride_request_exception_handled():
    """Verify notify_ride_request handles unexpected FCM errors gracefully without bubbling 500 unhandled."""
    from api.routers import notify as notify_module

    fake_ride = {
        "passenger_id": "passenger_123",
        "status": "pending",
        "eligible_driver_ids": ["driver_456"],
        "pickup_name": "Agartala Station",
        "drop_name": "Battala Market",
    }

    mock_db = MagicMock()
    mock_db.collection.return_value.document.return_value.get.side_effect = [
        FakeDoc(exists=True, data=fake_ride, doc_id="ride_123"),
        FakeDoc(exists=True, data={"pushTokens": ["token_1"], "notificationEligibleUntil": "2030-01-01T00:00:00Z"}, doc_id="driver_456"),
    ]

    with patch.object(notify_module, "get_admin_app", return_value=MagicMock()), \
         patch.object(notify_module, "_verify_passenger", return_value={"uid": "passenger_123"}), \
         patch.object(notify_module.fb_firestore, "client", return_value=mock_db), \
         patch.object(notify_module.fb_messaging, "send_each_for_multicast", side_effect=RuntimeError("FCM network error")):

        response = client.post(
            "/api/notify-ride-request",
            json={"rideId": "ride_123", "driverIds": ["driver_456"]},
            headers={"Authorization": "Bearer fake_token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data.get("ok") is False
        assert "Could not send ride notifications." in data.get("error", "")


def test_google_reverse_geocode_missing_lat_lng():
    """Verify google_reverse_geocode returns 400 when lat/lng missing."""
    response = client.get("/api/google-reverse-geocode")
    assert response.status_code == 400


def test_google_reverse_geocode_success():
    """Verify google_reverse_geocode returns correct structured address."""
    from api.routers import google as google_module

    fake_google_resp = {
        "status": "OK",
        "results": [
            {
                "formatted_address": "Battala Market, Agartala, Tripura 799001, India",
                "place_id": "ChIJ_test_place",
                "address_components": [
                    {"long_name": "Battala", "types": ["sublocality_level_1"]},
                    {"long_name": "Agartala", "types": ["locality"]},
                    {"long_name": "West Tripura", "types": ["administrative_area_level_2"]},
                    {"long_name": "Tripura", "types": ["administrative_area_level_1"]},
                    {"long_name": "799001", "types": ["postal_code"]},
                ],
            }
        ],
    }

    with patch.object(google_module, "enforce_rate_limit", return_value=None), \
         patch.object(google_module, "require_server_key", return_value="fake_key"), \
         patch.object(google_module, "fetch_json", return_value=fake_google_resp):

        response = client.get("/api/google-reverse-geocode?lat=23.83&lng=91.28")
        assert response.status_code == 200
        res = response.json().get("result", {})
        assert res.get("name") == "Battala, Agartala"
        assert res.get("city") == "Agartala"
        assert res.get("pinCode") == "799001"
        assert res.get("source") == "google"


def test_rate_limiting_fails_open_on_store_error():
    """Verify rate limit store failure does not raise 500 error."""
    from api.core.rate_limit import enforce_rate_limit
    from fastapi import Request

    req = MagicMock(spec=Request)
    req.headers = {}
    req.client = MagicMock(host="127.0.0.1")

    with patch("api.core.rate_limit.get_firestore", side_effect=Exception("Firestore connection error")):
        # Should not raise exception
        enforce_rate_limit(req, "test_scope", 10, 60)


def test_sweep_expired_offers_cleans_linked_rides_and_pending_requests():
    """Verify sweep_expired_offers cleans up rides and pendingRideRequests when offer expires."""
    from api.dispatch.sweeper import sweep_expired_offers

    now = 2000.0
    mock_db = MagicMock()

    # WPP entry in OFFERED state with expired offer
    wpp_doc = FakeDoc(
        exists=True,
        data={
            "state": "OFFERED",
            "current_offer_driver_id": "driver_expired",
            "offer_expires_at": 1900.0,
            "ride_id": "ride_active",
            "pending_request_id": "req_active",
        },
        doc_id="passenger_1",
    )

    # Linked ride document
    ride_doc = FakeDoc(
        exists=True,
        data={
            "status": "pending",
            "current_offer_driver_id": "driver_expired",
            "rejected_driver_ids": [],
        },
        doc_id="ride_active",
    )

    # Linked pendingRideRequest document
    req_doc = FakeDoc(
        exists=True,
        data={
            "status": "dispatching",
            "lockedByDriverId": "driver_expired",
            "rejected_driver_ids": [],
        },
        doc_id="req_active",
    )

    # Driver in DAP
    dap_doc = FakeDoc(
        exists=True,
        data={
            "state": "OFFERED",
            "pool": "IDLE",
            "offer_expires_at": 1900.0,
        },
        doc_id="driver_expired",
    )

    collections = {}
    def get_collection(name):
        if name not in collections:
            collections[name] = MagicMock()
        return collections[name]
    mock_db.collection.side_effect = get_collection

    mock_db.collection("dispatchWPP").where.return_value.stream.return_value = [wpp_doc]
    mock_db.collection("dispatchDAP").document.return_value = dap_doc.reference
    dap_doc.reference.get.return_value = dap_doc
    mock_db.collection("dispatchDAP").where.return_value.stream.return_value = []
    mock_db.collection("rides").document.return_value = ride_doc.reference
    ride_doc.reference.get.return_value = ride_doc
    mock_db.collection("pendingRideRequests").document.return_value = req_doc.reference
    req_doc.reference.get.return_value = req_doc

    expired_count = sweep_expired_offers(mock_db, now)
    assert expired_count == 1

    # Check WPP updated
    assert wpp_doc.reference.update.called
    wpp_updates = wpp_doc.reference.update.call_args[0][0]
    assert wpp_updates.get("state") == "WAITING"
    assert wpp_updates.get("current_offer_driver_id") is None

    # Check rides updated
    assert ride_doc.reference.update.called
    ride_updates = ride_doc.reference.update.call_args[0][0]
    assert ride_updates.get("current_offer_driver_id") is None
    assert ride_updates.get("search_status") == "searching_nearby_drivers"
    assert "driver_expired" in ride_updates.get("rejected_driver_ids", [])

    # Check pendingRideRequests updated
    assert req_doc.reference.update.called
    req_updates = req_doc.reference.update.call_args[0][0]
    assert req_updates.get("status") == "pending"
    assert req_updates.get("lockedByDriverId") is None
    assert "driver_expired" in req_updates.get("rejected_driver_ids", [])


def test_sweep_notify_me_fallback_and_deeplink_url():
    """Verify sweep_notify_me falls back to driverPresence and includes restorePending URL."""
    from api.dispatch.sweeper import sweep_notify_me

    now = 2000.0
    mock_db = MagicMock()
    collections = {}
    def get_collection(name):
        if name not in collections:
            collections[name] = MagicMock()
        return collections[name]
    mock_db.collection.side_effect = get_collection

    notify_doc = FakeDoc(
        exists=True,
        data={
            "status": "pending",
            "passengerId": "passenger_notify",
            "pickup": {"lat": 23.83, "lng": 91.28, "name": "Agartala Station"},
            "searchRadius": 5000.0,
            "vehicleType": "auto",
        },
        doc_id="notify_req_1",
    )

    # Empty DAP stream
    mock_db.collection("dispatchNotifyMe").where.return_value.stream.return_value = [notify_doc]
    mock_db.collection("dispatchDAP").where.return_value.stream.return_value = []

    # driverPresence has an active driver 1km away
    dp_driver = FakeDoc(
        exists=True,
        data={
            "driverAvailability": "searching",
            "driverLocation": {"lat": 23.835, "lng": 91.285},
            "vehicle_type": "auto",
        },
        doc_id="driver_nearby",
    )
    mock_db.collection("driverPresence").where.return_value.limit.return_value.stream.return_value = [dp_driver]
    mock_db.collection("pendingRideRequests").document.return_value = MagicMock()

    with patch("api.dispatch.pools.DispatchPoolManager.enqueue_notification") as mock_enqueue:
        handled = sweep_notify_me(mock_db, now)
        assert handled == 1
        assert notify_doc.reference.update.called
        assert mock_enqueue.called
        kwargs = mock_enqueue.call_args[1]
        assert kwargs["recipient_id"] == "passenger_notify"
        assert kwargs["notif_type"] == "pending_driver_available"
        data_payload = kwargs["data"]
        assert data_payload.get("driverId") == "driver_nearby"
        assert "restorePending=notify_req_1" in data_payload.get("url", "")


def test_notify_ride_request_token_fallback_to_users():
    """Verify notify_ride_request falls back to user document if driverPresence lacks tokens."""
    from api.routers import notify as notify_module

    fake_ride = {
        "passenger_id": "passenger_test",
        "status": "pending",
        "eligible_driver_ids": ["driver_only_in_users"],
        "pickup_name": "Station",
        "drop_name": "Market",
        "fare": 50.0,
    }

    mock_db = MagicMock()
    # 1. ride doc, 2. driverPresence doc (no tokens), 3. users doc (has pushTokens)
    mock_db.collection.return_value.document.return_value.get.side_effect = [
        FakeDoc(exists=True, data=fake_ride, doc_id="ride_test"),
        FakeDoc(exists=True, data={"notificationEligibleUntil": "2030-01-01T00:00:00Z"}, doc_id="driver_only_in_users"),
        FakeDoc(exists=True, data={"pushTokens": ["user_fallback_token"]}, doc_id="driver_only_in_users"),
    ]

    with patch.object(notify_module, "get_admin_app", return_value=MagicMock()), \
         patch.object(notify_module, "_verify_passenger", return_value={"uid": "passenger_test"}), \
         patch.object(notify_module.fb_firestore, "client", return_value=mock_db), \
         patch.object(notify_module.fb_messaging, "send_each_for_multicast") as mock_send:

        mock_send.return_value = MagicMock(success_count=1, failure_count=0)

        response = client.post(
            "/api/notify-ride-request",
            json={"rideId": "ride_test", "driverIds": ["driver_only_in_users"]},
            headers={"Authorization": "Bearer fake_token"},
        )

        assert response.status_code == 200
        assert response.json().get("ok") is True
        assert mock_send.called
        msg_arg = mock_send.call_args[0][0]
        assert "user_fallback_token" in msg_arg.tokens

