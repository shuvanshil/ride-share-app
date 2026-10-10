import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from api.index import app
from api.core.notifications import (
    NotificationEvent,
    build_deep_link,
    collect_tokens,
    create_fcm_multicast_message,
    dispatch_push_notification,
    send_user_notification,
    cleanup_invalid_tokens,
    _check_idempotency,
    CHANNEL_RIDE_REQUESTS,
    CHANNEL_WALLET,
)

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


def test_collect_tokens():
    doc1 = {"fcmToken": "token1", "pushTokens": ["token2", "token3"], "pushTokenDetails": [{"token": "token4"}]}
    tokens = collect_tokens(doc1)
    assert set(tokens) == {"token1", "token2", "token3", "token4"}

    doc2 = {"pushTokens": ["dup", "dup"], "fcmToken": "dup"}
    assert collect_tokens(doc2) == ["dup"]


def test_build_deep_link():
    url = build_deep_link("/driver-service.html", {"rideId": "ride123", "from": "push"})
    assert "driver-service?rideId=ride123&from=push" in url
    assert not url.endswith(".html")


def test_create_fcm_multicast_message():
    tokens = ["token_a", "token_b"]
    msg = create_fcm_multicast_message(
        tokens=tokens,
        event_type=NotificationEvent.RIDE_REQUEST,
        title="New Ride",
        body="Pickup: Station",
        url="https://liphtup.in/driver-service?rideId=1",
        channel_id=CHANNEL_RIDE_REQUESTS,
        tag="liphtup-ride-1",
        extra_data={"rideId": "1"},
    )
    assert msg.tokens == tokens
    assert msg.notification.title == "New Ride"
    assert msg.data["rideId"] == "1"
    assert msg.data["channel_id"] == CHANNEL_RIDE_REQUESTS
    assert msg.data["tag"] == "liphtup-ride-1"
    assert msg.android.notification.channel_id == CHANNEL_RIDE_REQUESTS
    assert msg.android.notification.tag == "liphtup-ride-1"
    assert msg.webpush.notification.tag == "liphtup-ride-1"


def test_dispatch_push_notification_success():
    with patch("api.core.notifications.fb_messaging.send_each_for_multicast") as mock_send, \
         patch("api.core.notifications.get_admin_app", return_value=MagicMock()):
        mock_send.return_value = MagicMock(success_count=2, failure_count=0, responses=[])
        res = dispatch_push_notification(
            tokens=["tok1", "tok2"],
            event_type="test_event",
            title="Hello",
            body="World",
            url="https://liphtup.in/services",
        )
        assert res["ok"] is True
        assert res["sent"] == 2
        assert res["failed"] == 0


def test_dispatch_push_notification_cleans_invalid_tokens():
    with patch("api.core.notifications.fb_messaging.send_each_for_multicast") as mock_send, \
         patch("api.core.notifications.get_admin_app", return_value=MagicMock()), \
         patch("api.core.notifications.cleanup_invalid_tokens") as mock_cleanup:
        
        bad_resp = MagicMock(success=False, exception=RuntimeError("Requested entity was not found: unregistered"))
        good_resp = MagicMock(success=True, exception=None)
        mock_send.return_value = MagicMock(success_count=1, failure_count=1, responses=[good_resp, bad_resp])
        
        mock_db = MagicMock()
        res = dispatch_push_notification(
            tokens=["tok_good", "tok_bad"],
            event_type="test_event",
            title="Hello",
            body="World",
            url="https://liphtup.in/services",
            db=mock_db,
        )
        assert res["ok"] is True
        assert res["sent"] == 1
        assert res["failed"] == 1
        assert mock_cleanup.called
        assert mock_cleanup.call_args[0][1] == ["tok_bad"]


def test_send_user_notification_idempotency():
    mock_db = MagicMock()
    mock_db.collection.return_value.document.return_value.get.return_value = FakeDoc(
        exists=True,
        data={"pushTokens": ["user_tok"]}
    )

    with patch("api.core.notifications.dispatch_push_notification", return_value={"ok": True, "sent": 1}) as mock_dispatch:
        # First call passes
        res1 = send_user_notification(
            db=mock_db,
            user_id="user_unique_123",
            event_type="status_change",
            title="Updated",
            body="Ride updated",
            url="https://liphtup.in/services",
            extra_data={"rideId": "unique_ride_123"},
        )
        assert res1["ok"] is True
        assert mock_dispatch.call_count == 1

        # Rapid repeated call within 5 seconds is suppressed
        res2 = send_user_notification(
            db=mock_db,
            user_id="user_unique_123",
            event_type="status_change",
            title="Updated",
            body="Ride updated",
            url="https://liphtup.in/services",
            extra_data={"rideId": "unique_ride_123"},
        )
        assert res2["ok"] is True
        assert res2.get("skipped") == "duplicate_idempotent"
        assert mock_dispatch.call_count == 1  # Not dispatched again


def test_device_unregister_endpoint():
    mock_db = MagicMock()
    user_doc = FakeDoc(exists=True, data={"fcmToken": "t1", "pushTokens": ["t1", "t2"]}, doc_id="usr_1")
    presence_doc = FakeDoc(exists=True, data={"fcmToken": "t1", "pushTokens": ["t1"]}, doc_id="usr_1")
    
    mock_db.collection.return_value.document.side_effect = lambda uid: (
        MagicMock(get=MagicMock(return_value=user_doc), set=MagicMock()) if uid == "usr_1" else MagicMock()
    )

    from api.core.auth import current_user
    app.dependency_overrides[current_user] = lambda: {"uid": "usr_1"}

    try:
        with patch("api.routers.rides.fb_firestore.client", return_value=mock_db), \
             patch("api.routers.rides.get_admin_app", return_value=MagicMock()):

            resp = client.post(
                "/api/rides/device/unregister",
                json={"token": "token_valid_123"},
                headers={"Authorization": "Bearer valid"},
            )
            assert resp.status_code == 200
            assert resp.json().get("ok") is True
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_payment_notifications_deep_links_and_channels():
    from api.routers.driver_payments import _send_payment_notification
    mock_db = MagicMock()
    mock_user_doc = FakeDoc(exists=True, data={"pushTokens": ["drv_token_1"]}, doc_id="drv_99")
    mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc
    mock_inapp_ref = MagicMock()
    mock_db.collection.return_value.document.return_value.collection.return_value.document.return_value = mock_inapp_ref

    mock_messaging = MagicMock()
    mock_app = MagicMock()

    with patch("api.routers.driver_payments.get_messaging", return_value=mock_messaging), \
         patch("api.routers.driver_payments.get_admin_app", return_value=mock_app):
        # 1. Weekly payment due
        _send_payment_notification(mock_db, "drv_99", "due", 140)
        assert mock_messaging.send.called
        msg = mock_messaging.Message.call_args[1]
        assert msg["data"]["channel_id"] == "liphtup_wallet_channel"
        assert "/driver-payments" in msg["data"]["url"]
        assert msg["data"]["type"] == "payment_due"
        assert mock_messaging.AndroidNotification.call_args[1]["channel_id"] == "liphtup_wallet_channel"
        assert mock_messaging.WebpushFCMOptions.call_args[1]["link"].endswith("/driver-payments")

        # 2. Action required
        _send_payment_notification(mock_db, "drv_99", "action_required", 140)
        msg2 = mock_messaging.Message.call_args[1]
        assert msg2["data"]["type"] == "payment_action_required"
        assert "/driver-payments" in msg2["data"]["url"]

        # 3. Verified
        _send_payment_notification(mock_db, "drv_99", "verified", 140)
        msg3 = mock_messaging.Message.call_args[1]
        assert msg3["data"]["type"] == "payment_verified"


