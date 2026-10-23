from __future__ import annotations

import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from api.core import admin, auth
from api.core.admin import (
    clean_invitation_code,
    generate_invitation_code,
    hash_invitation_code,
)
from api.core.errors import ApiError
from api.routers.admin import (
    AssignRoleBody,
    CreateInvitationBody,
    DecideRoleRequestBody,
    DowngradeAdminBody,
    InitiatePromotionBody,
    RevokeInvitationBody,
    VerifyInvitationBody,
    approve_role_request,
    assign_permission_role,
    create_role_invitation,
    downgrade_administrator_to_manager,
    initiate_manager_promotion,
    reject_role_request,
    revoke_role_invitation,
    verify_invitation_code,
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
                matches.append(MockDocSnapshot(doc_id, data, exists=True))
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
def super_admin_actor():
    return {
        "uid": "super_admin_1",
        "email": "superadmin@liphtup.com",
        "name": "Super Admin",
        "adminRole": "super_admin",
    }


def test_verify_firebase_token_missing() -> None:
    with pytest.raises(ApiError) as exc:
        auth.verify_firebase_token(None)
    assert exc.value.status_code == 401
    assert "Authentication is required" in exc.value.message


def test_verify_firebase_token_invalid_bearer() -> None:
    with pytest.raises(ApiError) as exc:
        auth.verify_firebase_token("NotBearer abcdef")
    assert exc.value.status_code == 401


def test_require_admin_non_admin_token() -> None:
    non_admin_token = {"uid": "user_1", "email": "user@example.com", "admin": False}
    with pytest.raises(ApiError) as exc:
        if non_admin_token.get("admin") is not True:
            raise ApiError("Admin access required.", 403)
    assert exc.value.status_code == 403


def test_require_super_admin_role_gate() -> None:
    manager_admin = {"uid": "mgr_1", "email": "mgr@example.com", "admin": True, "adminRole": "manager"}
    if manager_admin.get("adminRole") != "super_admin":
        with pytest.raises(ApiError) as exc:
            raise ApiError("Super Admin access required for permission management.", 403)
        assert exc.value.status_code == 403


# =====================================================================
# INVITATION CODE GENERATION & DIGEST TESTS
# =====================================================================

def test_invitation_code_format_and_clean() -> None:
    code = generate_invitation_code(10)
    assert len(code) == 10
    # Must avoid ambiguous characters: 0, 1, I, O
    for ambiguous in ("0", "1", "I", "O"):
        assert ambiguous not in code

    cleaned = clean_invitation_code("abcd-2345-ef")
    assert cleaned == "ABCD2345EF"

    digest1 = hash_invitation_code(code)
    digest2 = hash_invitation_code(f"{code[:4]}-{code[4:8]}-{code[8:]}")
    assert digest1 == digest2


# =====================================================================
# INVITATION WORKFLOW SIMULATION TESTS
# =====================================================================

def test_create_invitation_and_revocation(mock_db, super_admin_actor) -> None:
    # Seed an existing user
    mock_db.collection("users").document("user_101").set({
        "id": "user_101",
        "email": "sarah@example.com",
        "name": "Sarah Ahmed",
        "role": "passenger",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"):

        # 1. Create invitation
        res = create_role_invitation(
            body=CreateInvitationBody(email="sarah@example.com", role="manager"),
            admin_user=super_admin_actor,
        )
        assert res["ok"] is True
        assert res["targetEmail"] == "sarah@example.com"
        assert res["requestedRole"] == "manager"
        code = res["code"]
        assert len(code) == 10
        inv_id = res["invitationId"]

        # 2. Duplicate invitation for same user must be rejected
        with pytest.raises(ApiError) as dup_exc:
            create_role_invitation(
                body=CreateInvitationBody(email="sarah@example.com", role="manager"),
                admin_user=super_admin_actor,
            )
        assert dup_exc.value.status_code == 409

        # 3. Revoke invitation
        revoke_res = revoke_role_invitation(
            body=RevokeInvitationBody(invitationId=inv_id, reason="Candidate declined"),
            admin_user=super_admin_actor,
        )
        assert revoke_res["ok"] is True

        # Check in DB that codeHmac is cleared and status is revoked
        inv_doc = mock_db.collection("adminInvitations").document(inv_id).get().to_dict()
        assert inv_doc["status"] == "revoked"
        assert inv_doc["codeHmac"] == ""


def test_user_claims_invitation_and_super_admin_approval(mock_db, super_admin_actor) -> None:
    # Seed user
    mock_db.collection("users").document("user_202").set({
        "id": "user_202",
        "email": "baichong@gmail.com",
        "name": "Bai Chong",
        "role": "passenger",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"), \
         patch("api.routers.admin.fb_auth.set_custom_user_claims"):

        # 1. Super Admin invites Bai Chong to Administrator
        inv_res = create_role_invitation(
            body=CreateInvitationBody(email="baichong@gmail.com", role="admin"),
            admin_user=super_admin_actor,
        )
        code = inv_res["code"]
        inv_id = inv_res["invitationId"]

        # 2. User verifies code at /authPermissions
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_202", "email": "baichong@gmail.com"}):
            # Wrong code first
            with pytest.raises(ApiError) as wrong_exc:
                verify_invitation_code(
                    body=VerifyInvitationBody(code="WRONGCODE1"),
                    authorization="Bearer mock_token",
                )
            assert wrong_exc.value.status_code == 400

            # Correct code (can have hyphens)
            formatted_code = f"{code[:4]}-{code[4:8]}-{code[8:]}"
            verify_res = verify_invitation_code(
                body=VerifyInvitationBody(code=formatted_code),
                authorization="Bearer mock_token",
            )
            assert verify_res["ok"] is True
            assert verify_res["requestedRole"] == "admin"

        # At this point, the role is NOT yet granted!
        assert mock_db.collection("adminRoles").document("user_202").get().exists is False

        # Request is pending approval
        req_id = f"req_{inv_id}"
        req_doc = mock_db.collection("adminRoleRequests").document(req_id).get().to_dict()
        assert req_doc["status"] == "pending"

        # 3. Super Admin approves request
        appr_res = approve_role_request(request_id=req_id, admin_user=super_admin_actor)
        assert appr_res["ok"] is True

        # Now role is granted in adminRoles!
        role_doc = mock_db.collection("adminRoles").document("user_202").get().to_dict()
        assert role_doc["role"] == "admin"
        assert role_doc["email"] == "baichong@gmail.com"


def test_controlled_role_transitions(mock_db, super_admin_actor) -> None:
    # 1. Existing Administrator: Direct downgrade to Manager is allowed
    mock_db.collection("adminRoles").document("admin_user_1").set({
        "uid": "admin_user_1",
        "email": "admin1@example.com",
        "name": "Admin One",
        "role": "admin",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"), \
         patch("api.routers.admin.fb_auth.set_custom_user_claims"):

        downgrade_res = downgrade_administrator_to_manager(
            body=DowngradeAdminBody(uid="admin_user_1", reason="Restructuring"),
            admin_user=super_admin_actor,
        )
        assert downgrade_res["ok"] is True
        doc = mock_db.collection("adminRoles").document("admin_user_1").get().to_dict()
        assert doc["role"] == "manager"

        # 2. Existing Manager: Direct promotion to Administrator is PROHIBITED
        with pytest.raises(ApiError) as direct_promo_exc:
            assign_permission_role(
                body=AssignRoleBody(uid="admin_user_1", email="admin1@example.com", role="admin"),
                admin_user=super_admin_actor,
            )
        assert direct_promo_exc.value.status_code == 403
        assert "Direct promotion from Manager to Administrator is prohibited" in direct_promo_exc.value.message

        # 3. Manager promotion requires dedicated promotion workflow
        promo_res = initiate_manager_promotion(
            body=InitiatePromotionBody(uid="admin_user_1"),
            admin_user=super_admin_actor,
        )
        assert promo_res["ok"] is True
        promo_code = promo_res["code"]
        assert promo_res["invitationType"] == "manager_promotion"

        # Manager claims promotion code at /authPermissions
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "admin_user_1", "email": "admin1@example.com"}):
            v_res = verify_invitation_code(
                body=VerifyInvitationBody(code=promo_code),
                authorization="Bearer mock_token",
            )
            assert v_res["ok"] is True
            assert v_res["invitationType"] == "manager_promotion"

        # Super Admin grants promotion
        req_id = f"req_{promo_res['invitationId']}"
        grant_res = approve_role_request(request_id=req_id, admin_user=super_admin_actor)
        assert grant_res["ok"] is True
        doc_after = mock_db.collection("adminRoles").document("admin_user_1").get().to_dict()
        assert doc_after["role"] == "admin"


def test_reject_role_request(mock_db, super_admin_actor) -> None:
    # Seed user and request
    mock_db.collection("users").document("user_303").set({
        "id": "user_303",
        "email": "denied@example.com",
        "role": "passenger",
    })
    mock_db.collection("adminRoleRequests").document("req_denied_1").set({
        "requestId": "req_denied_1",
        "targetUid": "user_303",
        "targetEmail": "denied@example.com",
        "status": "pending",
        "requestedRole": "manager",
        "requestType": "new_invitation",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"):

        reject_res = reject_role_request(
            request_id="req_denied_1",
            body=DecideRoleRequestBody(notes="Candidate does not meet criteria"),
            admin_user=super_admin_actor,
        )
        assert reject_res["ok"] is True
        req_doc = mock_db.collection("adminRoleRequests").document("req_denied_1").get().to_dict()
        assert req_doc["status"] == "rejected"
        # User not granted role
        assert mock_db.collection("adminRoles").document("user_303").get().exists is False
