from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from api.core.errors import ApiError
from api.routers import admin


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None))

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
    def __init__(self, collection_name: str, store: dict, filters: list = None, order_by_field: str = None, order_dir = None):
        self.collection_name = collection_name
        self.store = store
        self.filters = filters or []
        self.order_by_field = order_by_field
        self.order_dir = order_dir

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return MockQuery(self.collection_name, self.store, new_filters, self.order_by_field, self.order_dir)

    def order_by(self, field, direction=None):
        return MockQuery(self.collection_name, self.store, self.filters, field, direction)

    def limit(self, count):
        return self

    def start_after(self, cursor_snap):
        return self

    def get(self, transaction=None):
        return self.stream()

    def stream(self, transaction=None):
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
                matches.append(MockDocSnapshot(doc_id, data, exists=True))
        return matches


class MockBatch:
    def __init__(self, store: dict):
        self.store = store
        self.ops = []

    def set(self, doc_ref, data, merge=False):
        self.ops.append(("set", doc_ref, data, merge))

    def delete(self, doc_ref):
        self.ops.append(("delete", doc_ref))

    def commit(self):
        for op in self.ops:
            if op[0] == "set":
                op[1].set(op[2], merge=op[3])
            elif op[0] == "delete":
                op[1].delete()


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
        return MockQuery(self.collection_name, self.store, [], field, direction)

    def stream(self):
        return MockQuery(self.collection_name, self.store).stream()

    def get(self, transaction=None):
        return self.stream()


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def batch(self):
        return MockBatch(self.store)


@patch("api.routers.admin._db")
def test_list_failure_reports(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("failureReports").document("fail_1").set({
        "failureId": "fail_1",
        "service": "wallet",
        "operation": "transfer_ride_fare",
        "severity": "HIGH",
        "status": "open",
        "lastSeenAt": "2026-08-31T22:00:00Z",
    })
    db.collection("failureReports").document("fail_2").set({
        "failureId": "fail_2",
        "service": "rides",
        "operation": "cancel_passenger_ride",
        "severity": "CRITICAL",
        "status": "resolved",
        "lastSeenAt": "2026-08-31T21:00:00Z",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Query all
    res = admin.list_failure_reports(admin_user=admin_user, status=None, severity=None)
    assert res["ok"] is True
    assert len(res["reports"]) == 2
    assert res["openCount"] == 1

    # Query open only
    res_open = admin.list_failure_reports(admin_user=admin_user, status="open", severity=None)
    assert res_open["ok"] is True
    assert len(res_open["reports"]) == 1
    assert res_open["reports"][0]["failureId"] == "fail_1"


@patch("api.routers.admin._db")
def test_update_and_delete_failure_report(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    db.collection("failureReports").document("fail_10").set({
        "failureId": "fail_10",
        "status": "open",
        "service": "coupons",
        "errorMessage": "Driver push error",
    })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Resolve report
    body = admin.FailureActionBody(action="resolve", notes="FCM configuration corrected")
    res = admin.update_failure_report(failure_id="fail_10", body=body, admin_user=admin_user)
    assert res["ok"] is True
    assert res["report"]["status"] == "resolved"
    assert res["report"]["reviewedBy"] == "admin@liphtup.in"

    # Delete report
    del_res = admin.delete_failure_report(failure_id="fail_10", admin_user=admin_user)
    assert del_res["ok"] is True
    assert not db.collection("failureReports").document("fail_10").get().exists


@patch("api.routers.admin._db")
def test_bulk_failure_actions(mock_db_fn) -> None:
    db = MockFirestoreClient()
    mock_db_fn.return_value = db

    for i in range(1, 4):
        db.collection("failureReports").document(f"fail_bulk_{i}").set({
            "failureId": f"fail_bulk_{i}",
            "status": "open",
        })

    admin_user = {"uid": "admin_1", "email": "admin@liphtup.in", "admin": True, "adminRole": "admin"}

    # Bulk resolve
    bulk_resolve_body = admin.BulkFailureActionBody(action="resolve", failureIds=["fail_bulk_1", "fail_bulk_2"])
    res = admin.bulk_failure_action(body=bulk_resolve_body, admin_user=admin_user)
    assert res["ok"] is True
    assert res["count"] == 2

    assert db.collection("failureReports").document("fail_bulk_1").get().to_dict()["status"] == "resolved"
    assert db.collection("failureReports").document("fail_bulk_2").get().to_dict()["status"] == "resolved"
    assert db.collection("failureReports").document("fail_bulk_3").get().to_dict()["status"] == "open"

    # Bulk delete
    bulk_del_body = admin.BulkFailureActionBody(action="delete", failureIds=["fail_bulk_1", "fail_bulk_2", "fail_bulk_3"])
    del_res = admin.bulk_failure_action(body=bulk_del_body, admin_user=admin_user)
    assert del_res["ok"] is True
    assert del_res["count"] == 3
    assert not db.collection("failureReports").document("fail_bulk_1").get().exists
    assert not db.collection("failureReports").document("fail_bulk_3").get().exists
