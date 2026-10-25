from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from api.core.errors import ApiError
from api.routers.admin import (
    CreateGlobalNoticeBody,
    UpdateGlobalNoticeBody,
    create_global_notice,
    update_global_notice,
    list_global_notices,
    get_global_notice,
    stop_global_notice,
    delete_global_notice,
    get_active_notice_for_client,
    _compute_notice_status,
    _check_notice_overlap,
)


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True, reference: Any = None):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists
        self.reference = reference

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None), reference=self)

    def set(self, data, merge=False):
        key = (self.collection_name, self.id)
        if merge and key in self._store:
            self._store[key].update(data)
        else:
            self._store[key] = dict(data)

    def update(self, data):
        key = (self.collection_name, self.id)
        if key not in self._store:
            self._store[key] = {}
        self._store[key].update(data)

    def delete(self):
        self._store.pop((self.collection_name, self.id), None)


class MockQuery:
    def __init__(self, collection_name: str, store: dict, filters: list = None):
        self.collection_name = collection_name
        self.store = store
        self.filters = filters or []

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return MockQuery(self.collection_name, self.store, new_filters)

    def order_by(self, field, direction=None):
        return self

    def limit(self, count):
        return self

    def get(self, transaction=None):
        return self.stream()

    def stream(self):
        matches = []
        for (col, doc_id), data in self.store.items():
            if col != self.collection_name:
                continue
            matched = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    matched = False
                    break
                elif op == "in" and doc_val not in val:
                    matched = False
                    break
            if matched:
                matches.append(MockDocSnapshot(doc_id, data, exists=True, reference=MockDocReference(col, doc_id, self.store)))
        return matches


class MockCollection:
    def __init__(self, collection_name: str, store: dict):
        self.collection_name = collection_name
        self.store = store

    def document(self, doc_id: str = None):
        if not doc_id:
            import uuid
            doc_id = f"auto_{uuid.uuid4().hex[:12]}"
        return MockDocReference(self.collection_name, doc_id, self.store)

    def where(self, field, op, val):
        return MockQuery(self.collection_name, self.store, [(field, op, val)])

    def order_by(self, field, direction=None):
        return MockQuery(self.collection_name, self.store, [])

    def limit(self, count):
        return MockQuery(self.collection_name, self.store, [])

    def stream(self):
        return MockQuery(self.collection_name, self.store, []).stream()


class MockFirestore:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)


@pytest.fixture
def mock_db():
    return MockFirestore()


@pytest.fixture
def admin_actor():
    return {
        "uid": "admin_test_1",
        "email": "admin@liphtup.in",
        "name": "Admin Tester",
        "adminRole": "admin",
    }


# =====================================================================
# SCHEDULE AND STATUS COMPUTATION TESTS
# =====================================================================

def test_compute_notice_status() -> None:
    now = datetime.now(timezone.utc)
    t_minus_2h = (now - timedelta(hours=2)).isoformat()
    t_minus_1h = (now - timedelta(hours=1)).isoformat()
    t_plus_1h = (now + timedelta(hours=1)).isoformat()
    t_plus_2h = (now + timedelta(hours=2)).isoformat()

    # 1. Scheduled (starts in future)
    doc_sched = {"startsAt": t_plus_1h, "endsAt": t_plus_2h, "state": "enabled"}
    assert _compute_notice_status(doc_sched, now) == "scheduled"

    # 2. Active (current time between start and end)
    doc_act = {"startsAt": t_minus_1h, "endsAt": t_plus_1h, "state": "enabled"}
    assert _compute_notice_status(doc_act, now) == "active"

    # 3. Ended (current time past end)
    doc_ended = {"startsAt": t_minus_2h, "endsAt": t_minus_1h, "state": "enabled"}
    assert _compute_notice_status(doc_ended, now) == "ended"

    # 4. Stopped
    doc_stopped = {"startsAt": t_minus_1h, "endsAt": t_plus_1h, "state": "stopped"}
    assert _compute_notice_status(doc_stopped, now) == "stopped"

    # 5. Deleted
    doc_del = {"startsAt": t_minus_1h, "endsAt": t_plus_1h, "state": "deleted"}
    assert _compute_notice_status(doc_del, now) == "deleted"


# =====================================================================
# OVERLAP CONSTRAINT ENFORCEMENT TESTS
# =====================================================================

def test_notice_overlap_prevention(mock_db, admin_actor) -> None:
    now = datetime.now(timezone.utc)
    t1 = now + timedelta(hours=2)
    t2 = now + timedelta(hours=6)
    t3 = now + timedelta(hours=10)

    # Seed existing enabled notice from t1 to t2 for audience 'both'
    mock_db.collection("globalNotices").document("notice_base").set({
        "noticeId": "notice_base",
        "title": "Base Notice",
        "startsAt": t1.isoformat(),
        "endsAt": t2.isoformat(),
        "audience": "both",
        "state": "enabled",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"):

        # 1. Overlapping notice for same audience ('both') -> REJECTED (409)
        with pytest.raises(ApiError) as exc_overlap:
            create_global_notice(
                body=CreateGlobalNoticeBody(
                    title="Overlapping Notice",
                    description="This should fail",
                    startsAt=(t1 + timedelta(hours=1)).isoformat(),
                    endsAt=(t2 + timedelta(hours=1)).isoformat(),
                    audience="both",
                ),
                admin_user=admin_actor,
            )
        assert exc_overlap.value.status_code == 409
        assert "Overlapping notices are not allowed" in exc_overlap.value.message

        # 2. Overlapping notice for 'drivers' while 'both' is active -> REJECTED (409)
        with pytest.raises(ApiError) as exc_drv:
            create_global_notice(
                body=CreateGlobalNoticeBody(
                    title="Driver Overlap",
                    description="This should fail",
                    startsAt=(t1 + timedelta(minutes=30)).isoformat(),
                    endsAt=(t1 + timedelta(hours=2)).isoformat(),
                    audience="drivers",
                ),
                admin_user=admin_actor,
            )
        assert exc_drv.value.status_code == 409

        # 3. Non-overlapping notice that starts at or after existing ends (t2 to t3) -> ALLOWED
        res_after = create_global_notice(
            body=CreateGlobalNoticeBody(
                title="After Notice",
                description="This should succeed",
                startsAt=t2.isoformat(),
                endsAt=t3.isoformat(),
                audience="both",
            ),
            admin_user=admin_actor,
        )
        assert res_after["ok"] is True
        assert res_after["notice"]["title"] == "After Notice"

        # 4. Independent audience concurrency: driver notice and passenger notice can overlap each other
        t_drv_start = now + timedelta(hours=12)
        t_drv_end = now + timedelta(hours=15)
        # Create driver notice
        res_drv = create_global_notice(
            body=CreateGlobalNoticeBody(
                title="Driver Alert",
                description="For drivers",
                startsAt=t_drv_start.isoformat(),
                endsAt=t_drv_end.isoformat(),
                audience="drivers",
            ),
            admin_user=admin_actor,
        )
        assert res_drv["ok"] is True

        # Create passenger notice for same time window -> ALLOWED!
        res_pax = create_global_notice(
            body=CreateGlobalNoticeBody(
                title="Passenger Promo",
                description="For passengers",
                startsAt=t_drv_start.isoformat(),
                endsAt=t_drv_end.isoformat(),
                audience="passengers",
            ),
            admin_user=admin_actor,
        )
        assert res_pax["ok"] is True


# =====================================================================
# NOTICE CRUD & AUDIT TESTS
# =====================================================================

def test_notice_lifecycle_crud(mock_db, admin_actor) -> None:
    now = datetime.now(timezone.utc)
    t_start = now + timedelta(hours=1)
    t_end = now + timedelta(hours=5)

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log") as mock_audit:

        # 1. Create notice with driver-specific content enabled
        create_res = create_global_notice(
            body=CreateGlobalNoticeBody(
                title="Public Update",
                description="Default description for riders",
                callout="Valued community member",
                audience="both",
                closable=True,
                driverContentEnabled=True,
                driverTitle="Captain Advisory",
                driverDescription="Driver-specific operational guidance",
                driverCallout="Stay safe and drive compliant",
                startsAt=t_start.isoformat(),
                endsAt=t_end.isoformat(),
            ),
            admin_user=admin_actor,
        )
        assert create_res["ok"] is True
        notice_id = create_res["notice"]["noticeId"]
        assert create_res["notice"]["version"] == 1
        assert create_res["notice"]["state"] == "enabled"
        assert create_res["notice"]["driverContentEnabled"] is True
        mock_audit.assert_called()

        # 2. Get notice by ID
        get_res = get_global_notice(notice_id=notice_id, admin_user=admin_actor)
        assert get_res["ok"] is True
        assert get_res["notice"]["title"] == "Public Update"
        assert get_res["notice"]["driverTitle"] == "Captain Advisory"

        # 3. Update notice
        new_desc = "Updated description for riders"
        update_res = update_global_notice(
            notice_id=notice_id,
            body=UpdateGlobalNoticeBody(
                description=new_desc,
            ),
            admin_user=admin_actor,
        )
        assert update_res["ok"] is True
        assert update_res["notice"]["version"] == 2
        assert update_res["notice"]["description"] == new_desc

        # 4. Stop notice
        stop_res = stop_global_notice(notice_id=notice_id, admin_user=admin_actor)
        assert stop_res["ok"] is True
        doc_after_stop = mock_db.collection("globalNotices").document(notice_id).get().to_dict()
        assert doc_after_stop["state"] == "stopped"
        assert doc_after_stop["version"] == 3

        # 5. Delete notice (soft delete)
        del_res = delete_global_notice(notice_id=notice_id, admin_user=admin_actor)
        assert del_res["ok"] is True
        doc_after_del = mock_db.collection("globalNotices").document(notice_id).get().to_dict()
        assert doc_after_del["state"] == "deleted"

        # 6. List notices: deleted notice is not listed
        list_res = list_global_notices(admin_user=admin_actor)
        assert list_res["ok"] is True
        ids = [n.get("noticeId") for n in list_res["notices"]]
        assert notice_id not in ids


# =====================================================================
# USER-FACING ACTIVE NOTICE ENDPOINT TESTS
# =====================================================================

def test_user_active_notice_delivery(mock_db) -> None:
    now = datetime.now(timezone.utc)
    # Active notice: started 1 hour ago, ends in 2 hours
    t_start = (now - timedelta(hours=1)).isoformat()
    t_end = (now + timedelta(hours=2)).isoformat()

    # Seed users
    mock_db.collection("users").document("user_pax_1").set({
        "id": "user_pax_1",
        "role": "passenger",
    })
    mock_db.collection("users").document("user_drv_1").set({
        "id": "user_drv_1",
        "role": "driver",
    })

    # Seed active notice with separate driver content
    mock_db.collection("globalNotices").document("gn_active_1").set({
        "noticeId": "gn_active_1",
        "title": "Welcome Passenger",
        "description": "Passenger news",
        "callout": "Enjoy your ride",
        "audience": "both",
        "closable": False,  # Non-closable
        "driverContentEnabled": True,
        "driverTitle": "Driver Alert Notice",
        "driverDescription": "Driver news",
        "driverCallout": "Earn more bonus",
        "startsAt": t_start,
        "endsAt": t_end,
        "state": "enabled",
        "version": 1,
    })

    with patch("api.routers.admin._db", return_value=mock_db):

        # 1. Unauthenticated request -> 401
        with pytest.raises(ApiError) as exc_unauth:
            get_active_notice_for_client(authorization=None)
        assert exc_unauth.value.status_code == 401

        # 2. Passenger receives default content
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_pax_1"}):
            res_pax = get_active_notice_for_client(authorization="Bearer pax_token")
            assert res_pax["ok"] is True
            assert res_pax["active"] is True
            notice_pax = res_pax["notice"]
            assert notice_pax["title"] == "Welcome Passenger"
            assert notice_pax["description"] == "Passenger news"
            assert notice_pax["closable"] is False

        # 3. Driver receives driver-specific content
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_drv_1"}):
            res_drv = get_active_notice_for_client(authorization="Bearer drv_token")
            assert res_drv["ok"] is True
            assert res_drv["active"] is True
            notice_drv = res_drv["notice"]
            assert notice_drv["title"] == "Driver Alert Notice"
            assert notice_drv["description"] == "Driver news"
            assert notice_drv["callout"] == "Earn more bonus"

        # 4. If notice is stopped, active returns False
        mock_db.collection("globalNotices").document("gn_active_1").update({"state": "stopped"})
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_pax_1"}):
            res_stopped = get_active_notice_for_client(authorization="Bearer pax_token")
            assert res_stopped["ok"] is True
            assert res_stopped["active"] is False
            assert res_stopped["notice"] is None
