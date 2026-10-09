"""Unit tests for Driver Weekly Payments API router & schedule calculations."""
from __future__ import annotations

import datetime
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from api.core.payment_schedule import get_payment_week_info, DEFAULT_WEEKLY_FEE, DEFAULT_PAYEE_UPI_ID
from api.index import app

client = TestClient(app)


def test_payment_schedule_calculation():
    # Test a Monday in 2026 (e.g. 17 Aug 2026 10:00:00 IST)
    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    mon_dt = datetime.datetime(2026, 8, 17, 10, 0, 0, tzinfo=ist)

    week_info = get_payment_week_info(mon_dt)
    assert week_info["amount"] == DEFAULT_WEEKLY_FEE
    assert week_info["payeeUpiId"] == DEFAULT_PAYEE_UPI_ID
    assert "2026-W" in week_info["weekId"]
    assert week_info["isPastDeadline"] is False

    # Test Sunday after 12:00 PM IST (e.g. 23 Aug 2026 14:00:00 IST)
    sun_afternoon = datetime.datetime(2026, 8, 23, 14, 0, 0, tzinfo=ist)
    sun_week_info = get_payment_week_info(sun_afternoon)
    assert sun_week_info["weekId"] == week_info["weekId"]
    assert sun_week_info["isPastDeadline"] is True
    assert sun_week_info["timeRemainingSeconds"] == 0


def test_pause_range_evaluation():
    from api.core.payment_schedule import is_date_in_pause_range
    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

    # Date within 1 Nov 2026 -> 30 Nov 2026
    dt_nov15 = datetime.datetime(2026, 11, 15, 12, 0, 0, tzinfo=ist)
    assert is_date_in_pause_range(dt_nov15, "2026-11-01", "2026-11-30", True) is True

    # Date outside pause range (e.g. 1 Dec 2026)
    dt_dec01 = datetime.datetime(2026, 12, 1, 10, 0, 0, tzinfo=ist)
    assert is_date_in_pause_range(dt_dec01, "2026-11-01", "2026-11-30", True) is False

    # Pause flag turned off
    assert is_date_in_pause_range(dt_nov15, "2026-11-01", "2026-11-30", False) is False


def test_submit_payment_request_model_with_proof():
    from api.routers.driver_payments import SubmitPaymentRequest
    req = SubmitPaymentRequest(
        paymentReference="UPI/REF/123456",
        paymentMethod="upi",
        proofStoragePath="payment-proofs/drv1/pymt1/screenshot.png",
        proofDownloadUrl="https://firebasestorage.googleapis.com/.../screenshot.png",
        proofFileName="screenshot.png",
        proofFileSize=1024500,
        proofContentType="image/png"
    )
    assert req.paymentReference == "UPI/REF/123456"
    assert req.proofFileName == "screenshot.png"
    assert req.proofFileSize == 1024500
    assert req.proofContentType == "image/png"


def test_admin_cleanup_storage_request_model():
    from api.routers.driver_payments import AdminCleanupStorageRequest
    req = AdminCleanupStorageRequest(startDate="2026-08-01", endDate="2026-08-31", dryRun=True)
    assert req.startDate == "2026-08-01"
    assert req.endDate == "2026-08-31"
    assert req.dryRun is True


def test_format_payment_doc_includes_proof_and_dues():
    from api.routers.driver_payments import _format_payment_doc
    data = {
        "driverId": "drv_123",
        "driverName": "Test Driver",
        "weekId": "2026-W34",
        "amount": 250,
        "baseFee": 200,
        "overdueAmount": 50,
        "status": "submitted",
        "proofStoragePath": "payment-proofs/drv_123/p1/shot.jpg",
        "proofDownloadUrl": "https://example.com/shot.jpg",
        "proofFileName": "shot.jpg",
        "proofFileSize": 2048,
        "proofContentType": "image/jpeg",
    }
    formatted = _format_payment_doc("doc_xyz", data)
    assert formatted["paymentId"] == "doc_xyz"
    assert formatted["amount"] == 250
    assert formatted["baseFee"] == 200
    assert formatted["overdueAmount"] == 50
    assert formatted["proofStoragePath"] == "payment-proofs/drv_123/p1/shot.jpg"
    assert formatted["proofDownloadUrl"] == "https://example.com/shot.jpg"
    assert formatted["proofFileName"] == "shot.jpg"
    assert formatted["proofFileSize"] == 2048
    assert formatted["proofContentType"] == "image/jpeg"


def test_send_payment_notification_fcm_with_admin_app():
    from api.routers.driver_payments import _send_payment_notification

    mock_db = MagicMock()
    mock_user_doc = MagicMock()
    mock_user_doc.exists = True
    mock_user_doc.to_dict.return_value = {"fcmToken": "fcm_test_token_123"}
    mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc

    mock_inapp_ref = MagicMock()
    mock_db.collection.return_value.document.return_value.collection.return_value.document.return_value = mock_inapp_ref

    mock_messaging = MagicMock()
    mock_app = MagicMock()

    with patch("api.routers.driver_payments.get_messaging", return_value=mock_messaging), \
         patch("api.routers.driver_payments.get_admin_app", return_value=mock_app):
        _send_payment_notification(mock_db, "drv_1", "submitted", 140)
        assert mock_messaging.send.called
        call_kwargs = mock_messaging.send.call_args[1]
        assert call_kwargs.get("app") == mock_app

        _send_payment_notification(mock_db, "drv_1", "approved", 140)
        assert mock_messaging.send.call_count == 2

        _send_payment_notification(mock_db, "drv_1", "declined", 140, reason="Blurry receipt")
        assert mock_messaging.send.call_count == 3


def test_payment_decline_and_resubmit_workflow():
    from api.routers.driver_payments import (
        submit_weekly_payment,
        admin_decline_driver_payment,
        SubmitPaymentRequest,
        AdminDeclineRequest,
        ApiError,
    )

    store = {}

    class DocRef:
        def __init__(self, coll, doc_id):
            self.coll = coll
            self.id = doc_id
        def get(self):
            data = store.get((self.coll, self.id))
            snap = MagicMock()
            snap.exists = data is not None
            snap.to_dict.return_value = dict(data) if data else {}
            snap.reference = self
            snap.id = self.id
            return snap
        def set(self, data, merge=False):
            key = (self.coll, self.id)
            if merge and key in store:
                store[key].update(data)
            else:
                store[key] = dict(data)
        def update(self, data):
            key = (self.coll, self.id)
            if key not in store:
                store[key] = {}
            store[key].update(data)
        def collection(self, name):
            return Coll(f"{self.coll}/{self.id}/{name}")

    class Coll:
        def __init__(self, name):
            self.name = name
        def document(self, doc_id=None):
            d_id = doc_id or f"autoid_{len(store)}"
            return DocRef(self.name, d_id)
        def where(self, field, op, val):
            return Query(self.name, [(field, op, val)])
        def stream(self):
            return Query(self.name, []).stream()

    class Query:
        def __init__(self, name, filters):
            self.name = name
            self.filters = filters
        def where(self, field, op, val):
            return Query(self.name, self.filters + [(field, op, val)])
        def stream(self):
            results = []
            for (c, d_id), data in list(store.items()):
                if c == self.name:
                    match = True
                    for f, o, v in self.filters:
                        if data.get(f) != v:
                            match = False
                            break
                    if match:
                        snap = MagicMock()
                        snap.id = d_id
                        snap.to_dict.return_value = dict(data)
                        snap.reference = DocRef(self.name, d_id)
                        results.append(snap)
            return results

    class MockDb:
        def collection(self, name):
            return Coll(name)

    mock_db = MockDb()

    # Seed driver profile
    store[("users", "driver_abc")] = {
        "role": "driver",
        "name": "Arjun Das",
        "phone": "+919876543210",
        "createdAt": "2026-01-01T00:00:00+05:30",
    }

    auth_driver = {"uid": "driver_abc", "name": "Arjun Das"}
    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in"}

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db), \
         patch("api.routers.driver_payments._send_payment_notification"):

        # 1. First submission
        req1 = SubmitPaymentRequest(
            paymentReference="UPI123",
            proofStoragePath="payment-proofs/driver_abc/p1/shot.jpg",
            proofDownloadUrl="https://example.com/p1.jpg"
        )
        res1 = submit_weekly_payment(body=req1, auth_user=auth_driver)
        assert res1["ok"] is True
        p1_id = res1["payment"]["paymentId"]
        assert res1["payment"]["status"] == "submitted"

        # 2. Cannot duplicate while submitted
        with pytest.raises(ApiError) as exc_info:
            submit_weekly_payment(body=req1, auth_user=auth_driver)
        assert exc_info.value.status_code == 409

        # 3. Admin declines the submission
        dec_req = AdminDeclineRequest(declineReason="Transaction ID illegible in screenshot")
        dec_res = admin_decline_driver_payment(payment_id=p1_id, body=dec_req, admin_user=admin_user)
        assert dec_res["ok"] is True
        assert dec_res["payment"]["status"] == "declined"
        assert dec_res["payment"]["declineReason"] == "Transaction ID illegible in screenshot"

        # 4. Driver can now submit a NEW proof for the week, preserving the old declined record
        req2 = SubmitPaymentRequest(
            paymentReference="UPI123_NEW",
            proofStoragePath="payment-proofs/driver_abc/p2/shot_clear.jpg",
            proofDownloadUrl="https://example.com/p2.jpg"
        )
        res2 = submit_weekly_payment(body=req2, auth_user=auth_driver)
        assert res2["ok"] is True
        p2_id = res2["payment"]["paymentId"]
        assert p2_id != p1_id
        assert res2["payment"]["status"] == "submitted"

        # Verify old declined record remains in database!
        old_declined_doc = DocRef("driverPayments", p1_id).get().to_dict()
        assert old_declined_doc["status"] == "declined"
        assert old_declined_doc["declineReason"] == "Transaction ID illegible in screenshot"

        # Verify new record is submitted
        new_doc = DocRef("driverPayments", p2_id).get().to_dict()
        assert new_doc["status"] == "submitted"


def test_calculate_dues_with_overdue_and_covered_weeks():
    from api.core.payment_schedule import calculate_dues_and_upcoming, get_payment_week_info, DEFAULT_WEEKLY_FEE
    import datetime

    week_info = get_payment_week_info()
    monday_dt = datetime.datetime.fromisoformat(week_info["mondayStart"])
    # Driver created 6 weeks ago
    driver_created = (monday_dt - datetime.timedelta(days=7 * 6)).isoformat()

    # 1. No payments yet: owes 6 overdue weeks (6 * 140 = 840) + this week (140) = 980
    dues = calculate_dues_and_upcoming([], week_info, current_status="due", driver_created_at=driver_created)
    assert dues["previousDuesCount"] == 6
    assert dues["previousDuesAmount"] == 6 * DEFAULT_WEEKLY_FEE
    assert dues["totalAmountToBePaid"] == 7 * DEFAULT_WEEKLY_FEE  # 980
    assert dues["previousDuesIncluded"] is True

    # 2. Driver paid 980 covering those 6 weeks + current week:
    covered_history = [{
        "weekId": week_info["weekId"],
        "status": "approved",
        "coveredWeeks": dues["previousUnpaidWeeks"] + [week_info["weekId"]]
    }]
    dues_after = calculate_dues_and_upcoming(covered_history, week_info, current_status="approved", driver_created_at=driver_created)
    assert dues_after["previousDuesCount"] == 0
    assert dues_after["previousDuesAmount"] == 0




