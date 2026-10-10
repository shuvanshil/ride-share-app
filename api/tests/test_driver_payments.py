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
    week_info = get_payment_week_info()
    store[("users", "driver_abc")] = {
        "role": "driver",
        "name": "Arjun Das",
        "phone": "+919876543210",
        "createdAt": week_info["mondayStart"],
    }

    auth_driver = {"uid": "driver_abc", "name": "Arjun Das"}
    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in"}

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db), \
         patch("api.routers.driver_payments._send_payment_notification"):

        # 1. First submission
        req1 = SubmitPaymentRequest(
            amount=140.0,
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
            amount=140.0,
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


def test_multi_week_split_instances_and_independent_admin_actions():
    from api.routers.driver_payments import (
        submit_weekly_payment,
        admin_approve_driver_payment,
        admin_decline_driver_payment,
        get_driver_payment_status,
        SubmitPaymentRequest,
        AdminDeclineRequest,
    )
    from api.core.payment_schedule import get_payment_week_info, DEFAULT_WEEKLY_FEE
    import datetime

    store = {}

    class DocRef:
        def __init__(self, coll, doc_id):
            self.coll = coll
            self.id = doc_id
        def get(self):
            class Snap:
                def __init__(self, data, doc_id):
                    self._data = data
                    self.id = doc_id
                    self.exists = data is not None
                def to_dict(self):
                    return dict(self._data) if self._data else {}
            return Snap(store.get((self.coll, self.id)), self.id)
        def set(self, data, merge=False):
            if merge and (self.coll, self.id) in store:
                store[(self.coll, self.id)].update(data)
            else:
                store[(self.coll, self.id)] = dict(data)
        def update(self, data):
            if (self.coll, self.id) in store:
                store[(self.coll, self.id)].update(data)

    class Query:
        def __init__(self, coll, filters=None):
            self.coll = coll
            self.filters = filters or []
        def where(self, field, op, val):
            return Query(self.coll, self.filters + [(field, op, val)])
        def stream(self):
            results = []
            for (c, doc_id), data in list(store.items()):
                if c == self.coll:
                    match = True
                    for f, op, val in self.filters:
                        if op == "==" and data.get(f) != val:
                            match = False
                            break
                    if match:
                        snap = DocRef(c, doc_id).get()
                        results.append(snap)
            return results

    class Coll:
        def __init__(self, name):
            self.name = name
        def document(self, doc_id=None):
            if not doc_id:
                doc_id = f"auto_{len(store)}"
            return DocRef(self.name, doc_id)
        def where(self, field, op, val):
            return Query(self.name).where(field, op, val)
        def stream(self):
            return Query(self.name).stream()

    class MockDb:
        def collection(self, name):
            return Coll(name)

    mock_db = MockDb()

    week_info = get_payment_week_info()
    monday_dt = datetime.datetime.fromisoformat(week_info["mondayStart"])
    driver_created = (monday_dt - datetime.timedelta(days=7 * 2)).isoformat()  # 2 overdue weeks

    store[("users", "driver_multi")] = {
        "role": "driver",
        "name": "Multi Week Driver",
        "phone": "+919999999999",
        "createdAt": driver_created,
    }

    auth_driver = {"uid": "driver_multi", "name": "Multi Week Driver"}
    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in"}

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db), \
         patch("api.routers.driver_payments._send_payment_notification"):

        # 1. Driver pays ₹420 (covering 2 overdue weeks + current week = 3 weeks)
        req = SubmitPaymentRequest(
            amount=420.0,
            paymentReference="UPI_420_FULL",
            proofStoragePath="payment-proofs/driver_multi/sub_1/proof.jpg",
            proofDownloadUrl="https://storage.googleapis.com/.../proof.jpg"
        )
        res = submit_weekly_payment(body=req, auth_user=auth_driver)
        assert res["ok"] is True
        payments = res["payments"]
        assert len(payments) == 3

        # Every instance is strictly ₹140
        for idx, p in enumerate(payments, 1):
            assert p["amount"] == 140.0
            assert p["status"] == "submitted"
            assert p["instanceCount"] == 3
            assert p["instanceIndex"] == idx
            assert p["submissionTotalAmount"] == 420.0
            assert p["proofStoragePath"] == "payment-proofs/driver_multi/sub_1/proof.jpg"

        p1_id = payments[0]["paymentId"]
        p2_id = payments[1]["paymentId"]
        p3_id = payments[2]["paymentId"]

        # Driver status while all under review
        status_res = get_driver_payment_status(auth_user=auth_driver)
        assert status_res["currentStatus"] == "submitted"
        assert status_res["currentStatusLabel"] == "Under Review"

        # Scenario B: Admin verifies Row 1 & Row 2, declines Row 3
        admin_approve_driver_payment(payment_id=p1_id, admin_user=admin_user)
        admin_approve_driver_payment(payment_id=p2_id, admin_user=admin_user)
        dec_req = AdminDeclineRequest(declineReason="UPI screenshot reference invalid for 3rd week")
        admin_decline_driver_payment(payment_id=p3_id, body=dec_req, admin_user=admin_user)

        # Check driver state after Scenario B:
        # Row 1 & 2 are approved (₹280 cleared)
        # Row 3 is declined (₹140 due)
        status_b = get_driver_payment_status(auth_user=auth_driver)
        assert status_b["currentStatus"] == "declined"
        assert status_b["duesSummary"]["totalAmountToBePaid"] == 140.0
        assert status_b["activeSubmission"]["declineReason"] == "UPI screenshot reference invalid for 3rd week"

        # Driver now re-pays the remaining ₹140
        req_single = SubmitPaymentRequest(
            amount=140.0,
            paymentReference="UPI_140_FIX",
            proofStoragePath="payment-proofs/driver_multi/sub_2/proof.jpg",
            proofDownloadUrl="https://storage.googleapis.com/.../proof.jpg"
        )
        res_single = submit_weekly_payment(body=req_single, auth_user=auth_driver)
        assert res_single["ok"] is True
        assert len(res_single["payments"]) == 1
        p4_id = res_single["payments"][0]["paymentId"]

        # Now status is under review again
        status_c = get_driver_payment_status(auth_user=auth_driver)
        assert status_c["currentStatus"] == "submitted"

        # Admin approves the re-submitted week
        admin_approve_driver_payment(payment_id=p4_id, admin_user=admin_user)

        # Driver is now all set!
        status_all_set = get_driver_payment_status(auth_user=auth_driver)
        assert status_all_set["currentStatus"] == "approved"
        assert status_all_set["duesSummary"]["totalAmountToBePaid"] == 0


def test_admin_cleanup_storage_endpoint_and_deduplication():
    from api.routers.driver_payments import (
        admin_cleanup_payment_storage,
        AdminCleanupStorageRequest
    )

    store = {}
    class DocRef:
        def __init__(self, coll, doc_id):
            self.coll = coll
            self.id = doc_id
        def update(self, data):
            if (self.coll, self.id) in store:
                store[(self.coll, self.id)].update(data)

    class Snap:
        def __init__(self, doc_id, data):
            self.id = doc_id
            self._data = data
            self.reference = DocRef("driverPayments", doc_id)
        def to_dict(self):
            return dict(self._data)

    # 3 payment instances sharing the SAME screenshot file path
    shared_path = "payment-proofs/drv_test/screenshot.jpg"
    for i in range(1, 4):
        store[("driverPayments", f"doc_{i}")] = {
            "driverId": "drv_test",
            "proofStoragePath": shared_path,
            "submittedAt": "2026-08-15T12:00:00+05:30",
        }

    mock_db = MagicMock()
    mock_db.collection().stream.return_value = [
        Snap(f"doc_{i}", store[("driverPayments", f"doc_{i}")]) for i in range(1, 4)
    ]

    mock_blob = MagicMock()
    mock_blob.name = shared_path
    mock_blob.size = 10240
    mock_blob.time_created = datetime.datetime(2026, 8, 15, 12, 0, 0, tzinfo=datetime.timezone.utc)
    mock_blob.exists.return_value = True
    mock_bucket = MagicMock()
    mock_bucket.list_blobs.return_value = [mock_blob]
    mock_bucket.blob.return_value = mock_blob

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in"}
    req = AdminCleanupStorageRequest(startDate="2026-08-01", endDate="2026-08-31", dryRun=False)

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db), \
         patch("api.routers.driver_payments.get_storage_bucket", return_value=mock_bucket), \
         patch("api.routers.driver_payments.write_audit_log"):

        res = admin_cleanup_payment_storage(body=req, admin_user=admin_user)
        assert res["ok"] is True
        # Blob delete was called exactly once despite 3 instances sharing the file
        assert mock_blob.delete.call_count == 1
        assert res["deletedCount"] == 1
        # All 3 documents in database were updated with proofDeleted: True
        for i in range(1, 4):
            assert store[("driverPayments", f"doc_{i}")]["proofDeleted"] is True
            assert store[("driverPayments", f"doc_{i}")]["proofStoragePath"] is None


def test_admin_reset_all_driver_payments_clears_all_overdues():
    from api.routers.driver_payments import (
        admin_reset_all_driver_payments,
        get_driver_payment_status,
    )
    from api.core.payment_schedule import get_payment_week_info
    import datetime

    store = {}

    class DocRef:
        def __init__(self, coll, doc_id):
            self.coll = coll
            self.id = doc_id
        def get(self):
            class Snap:
                def __init__(self, data, doc_id):
                    self._data = data
                    self.id = doc_id
                    self.exists = data is not None
                def to_dict(self):
                    return dict(self._data) if self._data else {}
            return Snap(store.get((self.coll, self.id)), self.id)
        def set(self, data, merge=False):
            if merge and (self.coll, self.id) in store:
                store[(self.coll, self.id)].update(data)
            else:
                store[(self.coll, self.id)] = dict(data)
        def delete(self):
            store.pop((self.coll, self.id), None)

    class Query:
        def __init__(self, coll, filters=None):
            self.coll = coll
            self.filters = filters or []
        def where(self, field, op, val):
            return Query(self.coll, self.filters + [(field, op, val)])
        def stream(self):
            results = []
            for (c, doc_id), data in list(store.items()):
                if c == self.coll:
                    match = True
                    for f, op, val in self.filters:
                        if op == "==" and data.get(f) != val:
                            match = False
                            break
                    if match:
                        snap = DocRef(c, doc_id).get()
                        snap.reference = DocRef(c, doc_id)
                        results.append(snap)
            return results

    class Coll:
        def __init__(self, name):
            self.name = name
        def document(self, doc_id=None):
            if not doc_id:
                doc_id = f"auto_{len(store)}"
            return DocRef(self.name, doc_id)
        def where(self, field, op, val):
            return Query(self.name).where(field, op, val)
        def stream(self):
            return Query(self.name).stream()

    class MockDb:
        def collection(self, name):
            return Coll(name)

    mock_db = MockDb()

    week_info = get_payment_week_info()
    monday_dt = datetime.datetime.fromisoformat(week_info["mondayStart"])
    # Driver created 20 weeks ago!
    driver_created = (monday_dt - datetime.timedelta(days=7 * 20)).isoformat()

    store[("users", "driver_old")] = {
        "role": "driver",
        "name": "Veteran Driver",
        "phone": "+919876500000",
        "createdAt": driver_created,
    }

    # Old payments in database
    store[("driverPayments", "pymt_old_1")] = {
        "driverId": "driver_old",
        "weekId": "2026-W01",
        "status": "approved",
    }

    auth_driver = {"uid": "driver_old", "name": "Veteran Driver"}
    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in"}

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db), \
         patch("api.routers.driver_payments.write_audit_log"):

        # Execute Admin Reset All
        reset_res = admin_reset_all_driver_payments(admin_user=admin_user)
        assert reset_res["ok"] is True
        assert reset_res["deletedCount"] == 1
        assert reset_res["resetWeekId"] == week_info["weekId"]

        # Verify systemSettings doc persisted with baseWeekId
        reset_doc = store.get(("systemSettings", "driverPaymentReset"))
        assert reset_doc is not None
        assert reset_doc["baseWeekId"] == week_info["weekId"]
        assert reset_doc["resetWeekId"] == week_info["weekId"]

        # Now driver checks payment status
        status = get_driver_payment_status(auth_user=auth_driver)
        # MUST start fresh with 0 previous dues!
        assert status["duesSummary"]["previousDuesCount"] == 0
        assert status["duesSummary"]["previousDuesAmount"] == 0
        assert status["duesSummary"]["totalAmountToBePaid"] == 140
        assert status["isAccountOnHold"] is False
        assert status["currentStatus"] == "due"

        # Verify that if 2 weeks pass, calculation stops at baseWeekId (not going back to createdAt 20 weeks ago)
        from api.core.payment_schedule import calculate_dues_and_upcoming
        # Simulate current week being 2 weeks ahead
        future_dt = monday_dt + datetime.timedelta(days=14)
        future_week_info = get_payment_week_info(future_dt)
        future_dues = calculate_dues_and_upcoming(
            payment_history=[],
            current_week_info=future_week_info,
            current_status="due",
            driver_created_at=driver_created,
            base_week_id=reset_doc["baseWeekId"],
        )
        # Dues should be exactly 2 unpaid weeks (the reset week and the 1 week after), NOT 22 weeks!
        assert future_dues["previousDuesCount"] == 2
        for wid in future_dues["previousUnpaidWeeks"]:
            assert wid >= reset_doc["baseWeekId"]


def test_payment_reminder_eligibility_scenarios():
    from api.core.payment_schedule import check_payment_reminder_eligibility, get_payment_week_info, IST

    # Base week: Mon 17 Aug 2026 to Sun 23 Aug 2026
    # Sunday end: 23 Aug 2026 23:59:59 IST
    mon_dt = datetime.datetime(2026, 8, 17, 10, 0, 0, tzinfo=IST)
    week_info = get_payment_week_info(mon_dt)

    dues_curr_unpaid = {
        "totalAmountToBePaid": 140,
        "isCurrentWeekUnpaid": True,
        "previousUnpaidWeeks": [],
    }

    # Scenario 1: Unpaid, but required overdue threshold has not yet passed
    # Mid-week Wednesday 19 Aug 2026
    wed_dt = datetime.datetime(2026, 8, 19, 12, 0, 0, tzinfo=IST)
    res_wed = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_curr_unpaid,
        week_info=week_info,
        target_dt=wed_dt,
        overdue_threshold_hours=24,
    )
    assert res_wed["eligible"] is False
    assert res_wed["reason"] == "threshold_not_passed"

    # Monday morning 24 Aug 2026 (weekend just ended at 23:59:59 last night, only 10h passed)
    mon_next = datetime.datetime(2026, 8, 24, 10, 0, 0, tzinfo=IST)
    res_mon = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_curr_unpaid,
        week_info=week_info,
        target_dt=mon_next,
        overdue_threshold_hours=24,
    )
    assert res_mon["eligible"] is False
    assert res_mon["reason"] == "threshold_not_passed"

    # Scenario 2: The relevant weekend has ended and 24-hour threshold has passed (Tuesday 25 Aug 2026)
    tue_next = datetime.datetime(2026, 8, 25, 0, 1, 0, tzinfo=IST)
    res_tue = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_curr_unpaid,
        week_info=week_info,
        target_dt=tue_next,
        overdue_threshold_hours=24,
    )
    assert res_tue["eligible"] is True
    assert res_tue["type"] == "overdue"
    assert res_tue["overdueThresholdPassed"] is True

    # Scenario 2b: Driver has previous overdue unpaid weeks
    dues_with_prev = {
        "totalAmountToBePaid": 280,
        "isCurrentWeekUnpaid": True,
        "previousUnpaidWeeks": ["2026-W33"],
    }
    res_prev = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_with_prev,
        week_info=week_info,
        target_dt=wed_dt,
    )
    assert res_prev["eligible"] is True
    assert res_prev["type"] == "overdue"

    # Scenario 7: Payment is submitted and under review -> suppressed
    res_sub = check_payment_reminder_eligibility(
        current_status="submitted",
        dues_info=dues_with_prev,
        week_info=week_info,
        target_dt=tue_next,
    )
    assert res_sub["eligible"] is False
    assert res_sub["reason"] == "under_review"

    # Scenario 11: Payment verified / no dues -> suppressed
    dues_paid = {
        "totalAmountToBePaid": 0,
        "isCurrentWeekUnpaid": False,
        "previousUnpaidWeeks": [],
    }
    res_paid = check_payment_reminder_eligibility(
        current_status="approved",
        dues_info=dues_paid,
        week_info=week_info,
        target_dt=tue_next,
    )
    assert res_paid["eligible"] is False
    assert res_paid["reason"] == "no_dues"

    # Payments paused -> suppressed
    res_paused = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_with_prev,
        week_info=week_info,
        target_dt=tue_next,
        is_paused=True,
    )
    assert res_paused["eligible"] is False
    assert res_paused["reason"] == "payments_paused"

    # Scenario 8: Declined payment takes Priority 1
    declined_sub = {
        "paymentId": "pymt_dec_1",
        "status": "declined",
        "declineReason": "Screenshot blurred. Please re-upload.",
    }
    res_declined = check_payment_reminder_eligibility(
        current_status="declined",
        dues_info=dues_with_prev,
        week_info=week_info,
        active_submission=declined_sub,
        target_dt=wed_dt,
    )
    assert res_declined["eligible"] is True
    assert res_declined["type"] == "declined"
    assert res_declined["declineReason"] == "Screenshot blurred. Please re-upload."

    # Scenario 3: Driver taps "Remind me later" (snooze 4 hours)
    snooze_overdue = {
        "overdueSnoozedUntil": (tue_next + datetime.timedelta(hours=4)).isoformat(),
        "snoozedAt": tue_next.isoformat(),
    }
    # Within 4 hours (e.g. 2 hours later) -> suppressed
    during_snooze_dt = tue_next + datetime.timedelta(hours=2)
    res_snoozed = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_curr_unpaid,
        week_info=week_info,
        snooze_config=snooze_overdue,
        target_dt=during_snooze_dt,
    )
    assert res_snoozed["eligible"] is False
    assert res_snoozed["isSnoozed"] is True

    # Scenario 4 & 5: After 4 hours elapsed -> eligible again
    after_snooze_dt = tue_next + datetime.timedelta(hours=4, minutes=5)
    res_after = check_payment_reminder_eligibility(
        current_status="due",
        dues_info=dues_curr_unpaid,
        week_info=week_info,
        snooze_config=snooze_overdue,
        target_dt=after_snooze_dt,
    )
    assert res_after["eligible"] is True
    assert res_after["type"] == "overdue"

    # Scenario 9: Driver snoozes declined payment notice
    snooze_declined = {
        "declineSnoozedUntil": (wed_dt + datetime.timedelta(hours=4)).isoformat(),
        "declinedPaymentId": "pymt_dec_1",
        "snoozedAt": wed_dt.isoformat(),
    }
    res_dec_snoozed = check_payment_reminder_eligibility(
        current_status="declined",
        dues_info=dues_with_prev,
        week_info=week_info,
        active_submission=declined_sub,
        snooze_config=snooze_declined,
        target_dt=wed_dt + datetime.timedelta(hours=2),
    )
    assert res_dec_snoozed["eligible"] is False
    assert res_dec_snoozed["isSnoozed"] is True

    # Genuinely new decline detected with different paymentId -> snooze superseded!
    declined_new_sub = {
        "paymentId": "pymt_dec_2",
        "status": "declined",
        "declineReason": "Amount mismatch. Need ₹140.",
    }
    res_dec_new = check_payment_reminder_eligibility(
        current_status="declined",
        dues_info=dues_with_prev,
        week_info=week_info,
        active_submission=declined_new_sub,
        snooze_config=snooze_declined,
        target_dt=wed_dt + datetime.timedelta(hours=2),
    )
    assert res_dec_new["eligible"] is True
    assert res_dec_new["type"] == "declined"
    assert res_dec_new["declineReason"] == "Amount mismatch. Need ₹140."


def test_snooze_reminder_endpoint_mock():
    from api.routers.driver_payments import snooze_driver_payment_reminder, SnoozeReminderRequest

    mock_db = MagicMock()
    mock_user_doc = MagicMock()
    mock_user_doc.exists = True
    mock_user_doc.to_dict.return_value = {
        "role": "driver",
        "verificationStatus": "approved",
        "paymentReminderSnooze": {}
    }
    mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc

    with patch("api.routers.driver_payments.get_firestore", return_value=mock_db):
        req = SnoozeReminderRequest(reminderType="overdue", snoozeHours=4.0)
        res = snooze_driver_payment_reminder(body=req, auth_user={"uid": "test_drv_1"})
        assert res["ok"] is True
        assert res["reminderType"] == "overdue"
        assert res["snoozeHours"] == 4.0
        assert "snoozedUntil" in res

        # Verify firestore update was called
        mock_db.collection("users").document("test_drv_1").update.assert_called_once()
        call_args = mock_db.collection("users").document("test_drv_1").update.call_args[0][0]
        assert "paymentReminderSnooze" in call_args
        assert "overdueSnoozedUntil" in call_args["paymentReminderSnooze"]

