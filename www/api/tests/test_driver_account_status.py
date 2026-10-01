"""
Unit tests for Driver Account-Status state machine, transitions,
reasons, acknowledge-approval, and re-apply endpoints.
"""
from __future__ import annotations

from typing import Any
import pytest

from api.core.errors import ApiError
from api.routers.rides import _require_approved_driver


class MockDocRef:
    def __init__(self, doc_id: str, data: dict[str, Any]):
        self.id = doc_id
        self._data = data

    def get(self):
        class Snap:
            def __init__(self, doc_id, data):
                self.id = doc_id
                self._data = data
                self.exists = bool(data)

            def to_dict(self):
                return dict(self._data)

        return Snap(self.id, self._data)

    def set(self, updates: dict[str, Any], merge: bool = True):
        if merge:
            self._data.update(updates)
        else:
            self._data = updates

    def update(self, updates: dict[str, Any]):
        self._data.update(updates)


class MockDb:
    def __init__(self):
        self.users: dict[str, dict[str, Any]] = {}
        self.presence: dict[str, dict[str, Any]] = {}
        self.map_presence: dict[str, dict[str, Any]] = {}

    def collection(self, name: str):
        class Collection:
            def __init__(self, outer, col_name):
                self.outer = outer
                self.col_name = col_name

            def document(self, doc_id: str):
                if self.col_name == "users":
                    self.outer.users.setdefault(doc_id, {})
                    return MockDocRef(doc_id, self.outer.users[doc_id])
                if self.col_name == "driverPresence":
                    self.outer.presence.setdefault(doc_id, {})
                    return MockDocRef(doc_id, self.outer.presence[doc_id])
                if self.col_name == "driverMapPresence":
                    self.outer.map_presence.setdefault(doc_id, {})
                    return MockDocRef(doc_id, self.outer.map_presence[doc_id])
                return MockDocRef(doc_id, {})

        return Collection(self, name)


def test_approved_driver_guard_strict():
    # Approved driver succeeds
    _require_approved_driver({"role": "driver", "verificationStatus": "approved"}, "approved only")

    # All unapproved or invalid states raise 403
    unapproved_states = [
        {"role": "driver", "verificationStatus": "pending_review"},
        {"role": "driver", "verificationStatus": "rejected"},
        {"role": "driver", "verificationStatus": "suspended"},
        {"role": "driver", "verificationStatus": "blocked"},
        {"role": "driver"},  # No verificationStatus
        {"role": "passenger", "verificationStatus": "approved"},
    ]
    for profile in unapproved_states:
        with pytest.raises(ApiError) as exc:
            _require_approved_driver(profile, "approved only")
        assert exc.value.status_code == 403


def test_admin_update_driver_state_machine_pending_to_approved(monkeypatch):
    import api.routers.admin as admin_module

    db = MockDb()
    db.users["drv1"] = {
        "id": "drv1",
        "uid": "drv1",
        "role": "driver",
        "name": "Test Driver",
        "verificationStatus": "pending_review",
        "driverAvailability": "offline",
    }
    monkeypatch.setattr(admin_module, "_db", lambda: db)
    monkeypatch.setattr(admin_module, "write_audit_log", lambda *a, **k: None)

    admin_user = {"uid": "admin1", "adminRole": "admin"}
    body = admin_module.DriverActionBody(action="approve")
    res = admin_module.update_driver("drv1", body, admin_user)

    assert res["ok"] is True
    assert res["driver"]["verificationStatus"] == "approved"
    assert res["driver"]["approvalAcknowledged"] is False
    assert db.users["drv1"]["verificationStatus"] == "approved"


def test_admin_update_driver_state_machine_pending_to_rejected(monkeypatch):
    import api.routers.admin as admin_module

    db = MockDb()
    db.users["drv2"] = {
        "id": "drv2",
        "uid": "drv2",
        "role": "driver",
        "name": "Test Driver 2",
        "verificationStatus": "pending_review",
        "driverAvailability": "searching",
    }
    monkeypatch.setattr(admin_module, "_db", lambda: db)
    monkeypatch.setattr(admin_module, "write_audit_log", lambda *a, **k: None)

    admin_user = {"uid": "admin1", "adminRole": "admin"}
    body = admin_module.DriverActionBody(action="reject", notes="Vehicle documents blurred")
    res = admin_module.update_driver("drv2", body, admin_user)

    assert res["ok"] is True
    assert res["driver"]["verificationStatus"] == "rejected"
    assert res["driver"]["rejectionReason"] == "Vehicle documents blurred"
    assert db.users["drv2"]["driverAvailability"] == "offline"


def test_admin_update_driver_state_machine_approved_to_suspended_and_unsuspend(monkeypatch):
    import api.routers.admin as admin_module

    db = MockDb()
    db.users["drv3"] = {
        "id": "drv3",
        "uid": "drv3",
        "role": "driver",
        "name": "Test Driver 3",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
    }
    monkeypatch.setattr(admin_module, "_db", lambda: db)
    monkeypatch.setattr(admin_module, "write_audit_log", lambda *a, **k: None)

    admin_user = {"uid": "admin1", "adminRole": "admin"}

    # 1. Suspend
    body_suspend = admin_module.DriverActionBody(action="suspend", notes="Pending traffic violation review")
    res = admin_module.update_driver("drv3", body_suspend, admin_user)
    assert res["driver"]["verificationStatus"] == "suspended"
    assert res["driver"]["suspensionReason"] == "Pending traffic violation review"
    assert db.users["drv3"]["driverAvailability"] == "offline"

    # 2. Cannot suspend again or approve while suspended
    with pytest.raises(ApiError) as exc:
        admin_module.update_driver("drv3", admin_module.DriverActionBody(action="suspend"), admin_user)
    assert exc.value.status_code == 400

    # 3. Unsuspend
    body_unsuspend = admin_module.DriverActionBody(action="unsuspend")
    res_un = admin_module.update_driver("drv3", body_unsuspend, admin_user)
    assert res_un["driver"]["verificationStatus"] == "approved"
    assert res_un["driver"]["suspensionReason"] is None


def test_admin_update_driver_state_machine_approved_to_blocked_and_unblock(monkeypatch):
    import api.routers.admin as admin_module

    db = MockDb()
    db.users["drv4"] = {
        "id": "drv4",
        "uid": "drv4",
        "role": "driver",
        "name": "Test Driver 4",
        "verificationStatus": "approved",
        "driverAvailability": "searching",
    }
    monkeypatch.setattr(admin_module, "_db", lambda: db)
    monkeypatch.setattr(admin_module, "write_audit_log", lambda *a, **k: None)

    admin_user = {"uid": "admin1", "adminRole": "admin"}

    # 1. Block
    body_block = admin_module.DriverActionBody(action="block", notes="Fraudulent ride manipulation")
    res = admin_module.update_driver("drv4", body_block, admin_user)
    assert res["driver"]["verificationStatus"] == "blocked"
    assert res["driver"]["blockingReason"] == "Fraudulent ride manipulation"
    assert db.users["drv4"]["driverAvailability"] == "offline"

    # 2. Cannot approve while blocked
    with pytest.raises(ApiError) as exc:
        admin_module.update_driver("drv4", admin_module.DriverActionBody(action="approve"), admin_user)
    assert exc.value.status_code == 400

    # 3. Unblock
    body_unblock = admin_module.DriverActionBody(action="unblock")
    res_un = admin_module.update_driver("drv4", body_unblock, admin_user)
    assert res_un["driver"]["verificationStatus"] == "approved"
    assert res_un["driver"]["blockingReason"] is None


def test_admin_update_driver_state_machine_rejected_cannot_be_approved_directly(monkeypatch):
    import api.routers.admin as admin_module

    db = MockDb()
    db.users["drv5"] = {
        "id": "drv5",
        "uid": "drv5",
        "role": "driver",
        "name": "Test Driver 5",
        "verificationStatus": "rejected",
    }
    monkeypatch.setattr(admin_module, "_db", lambda: db)
    monkeypatch.setattr(admin_module, "write_audit_log", lambda *a, **k: None)

    admin_user = {"uid": "admin1", "adminRole": "admin"}

    # Rejected driver cannot be directly approved, suspended, or blocked by admin
    for action in ("approve", "suspend", "block", "unsuspend", "unblock"):
        with pytest.raises(ApiError) as exc:
            admin_module.update_driver("drv5", admin_module.DriverActionBody(action=action), admin_user)
        assert exc.value.status_code == 400


def test_driver_reapply_and_acknowledge_endpoints(monkeypatch):
    import api.routers.account as account_module

    db = MockDb()
    db.users["drv6"] = {
        "id": "drv6",
        "uid": "drv6",
        "role": "driver",
        "name": "Test Driver 6",
        "verificationStatus": "rejected",
        "rejectionReason": "Expired license document",
        "approvalAcknowledged": False,
    }

    monkeypatch.setattr(account_module, "get_admin_app", lambda: None)
    monkeypatch.setattr(account_module.fb_firestore, "client", lambda app: db)

    # 1. Re-apply when rejected -> transitions to pending_review
    res_reapply = account_module.reapply_driver_registration(user={"uid": "drv6", "role": "driver"})
    assert res_reapply["ok"] is True
    assert res_reapply["profile"]["verificationStatus"] == "pending_review"
    assert res_reapply["profile"]["rejectionReason"] is None
    assert db.users["drv6"]["verificationStatus"] == "pending_review"

    # 2. Simulate Admin approving the driver
    db.users["drv6"]["verificationStatus"] = "approved"
    db.users["drv6"]["approvalAcknowledged"] = False

    # 3. Driver acknowledges approval
    res_ack = account_module.acknowledge_driver_approval(user={"uid": "drv6", "role": "driver"})
    assert res_ack["ok"] is True
    assert res_ack["profile"]["approvalAcknowledged"] is True
    assert db.users["drv6"]["approvalAcknowledged"] is True
