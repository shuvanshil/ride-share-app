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

    def to_dict(self):
        return self._data

    @property
    def reference(self):
        ref = MagicMock()
        ref.update = MagicMock()
        ref.set = MagicMock()
        return ref


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
