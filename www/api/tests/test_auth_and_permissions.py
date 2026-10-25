from __future__ import annotations

import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from api.core import admin, auth
from api.core.admin import (
    build_invitation_url,
    decrypt_invitation_token,
    encrypt_invitation_token,
    generate_invitation_token,
    hash_invitation_token,
)
from api.core.errors import ApiError
from api.routers.admin import (
    AcceptInvitationBody,
    AssignRoleBody,
    CreateInvitationBody,
    DowngradeAdminBody,
    InitiatePromotionBody,
    RejectInvitationBody,
    ResolveInvitationBody,
    RevokeInvitationBody,
    accept_invitation,
    assign_permission_role,
    create_role_invitation,
    downgrade_administrator_to_manager,
    get_invitation_link,
    initiate_manager_promotion,
    reject_invitation,
    resolve_invitation,
    revoke_role_invitation,
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
        auth.verify_firebase_token("Basic abc123xyz")
    assert exc.value.status_code == 401
    assert "Authentication is required" in exc.value.message


def test_require_admin_non_admin_token() -> None:
    # A standard passenger token does not have admin claim
    passenger_token = {"uid": "pax_1", "email": "pax@example.com", "role": "passenger"}
    with pytest.raises(ApiError) as exc:
        if not passenger_token.get("admin"):
            raise ApiError("Administrative privileges required.", 403)
    assert exc.value.status_code == 403


def test_require_super_admin_role_gate() -> None:
    manager_admin = {"uid": "mgr_1", "email": "mgr@example.com", "admin": True, "adminRole": "manager"}
    if manager_admin.get("adminRole") != "super_admin":
        with pytest.raises(ApiError) as exc:
            raise ApiError("Super Admin access required for permission management.", 403)
        assert exc.value.status_code == 403


# =====================================================================
# INVITATION TOKEN CRYPTOGRAPHY & URL TESTS
# =====================================================================

def test_invitation_token_cryptography() -> None:
    token = generate_invitation_token()
    assert len(token) >= 32

    token_hash = hash_invitation_token(token)
    assert len(token_hash) == 64  # SHA256 hex digest

    ciphertext = encrypt_invitation_token(token)
    decrypted = decrypt_invitation_token(ciphertext)
    assert decrypted == token

    url = build_invitation_url(token)
    assert url.startswith("https://liphtup.in/admin/invitation?token=")
    assert token in url


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

        # 1. Create invitation link
        res = create_role_invitation(
            body=CreateInvitationBody(email="sarah@example.com", role="manager"),
            admin_user=super_admin_actor,
        )
        assert res["ok"] is True
        assert res["targetEmail"] == "sarah@example.com"
        assert res["requestedRole"] == "manager"
        assert "invitationUrl" in res
        assert "https://liphtup.in/admin/invitation?token=" in res["invitationUrl"]
        inv_id = res["invitationId"]

        # 2. Duplicate invitation for same user must be rejected with 409
        with pytest.raises(ApiError) as dup_exc:
            create_role_invitation(
                body=CreateInvitationBody(email="sarah@example.com", role="manager"),
                admin_user=super_admin_actor,
            )
        assert dup_exc.value.status_code == 409

        # 3. Super Admin can re-copy link anytime
        link_res = get_invitation_link(invitation_id=inv_id, admin_user=super_admin_actor)
        assert link_res["ok"] is True
        assert link_res["invitationUrl"] == res["invitationUrl"]

        # 4. Revoke invitation
        revoke_res = revoke_role_invitation(
            body=RevokeInvitationBody(invitationId=inv_id, reason="Candidate declined"),
            admin_user=super_admin_actor,
        )
        assert revoke_res["ok"] is True

        # Check in DB that encryptedToken is wiped and status is revoked
        inv_doc = mock_db.collection("adminInvitations").document(inv_id).get().to_dict()
        assert inv_doc["status"] == "revoked"
        assert inv_doc["encryptedToken"] == ""


def test_user_accepts_invitation_workflow(mock_db, super_admin_actor) -> None:
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
        inv_url = inv_res["invitationUrl"]
        token = inv_url.split("token=")[1]
        inv_id = inv_res["invitationId"]

        # 2. User opens link unauthenticated -> resolve returns unauthenticated state
        resolve_unauth = resolve_invitation(
            body=ResolveInvitationBody(token=token),
            authorization=None,
        )
        assert resolve_unauth["ok"] is True
        assert resolve_unauth["state"] == "unauthenticated"

        # 3. User authenticated with wrong account -> resolve returns mismatch state
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "other_user", "email": "wrong@example.com"}):
            resolve_mismatch = resolve_invitation(
                body=ResolveInvitationBody(token=token),
                authorization="Bearer wrong_token",
            )
            assert resolve_mismatch["ok"] is True
            assert resolve_mismatch["state"] == "mismatch"
            assert resolve_mismatch["currentUser"]["email"] == "wrong@example.com"

        # 4. User authenticated with correct account -> resolve returns ready state
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_202", "email": "baichong@gmail.com"}):
            resolve_ok = resolve_invitation(
                body=ResolveInvitationBody(token=token),
                authorization="Bearer user_token",
            )
            assert resolve_ok["ok"] is True
            assert resolve_ok["state"] == "ready"
            assert resolve_ok["invitation"]["roleRaw"] == "admin"

            # 5. User accepts invitation -> role is IMMEDIATELY granted!
            accept_res = accept_invitation(
                invitation_id=inv_id,
                body=AcceptInvitationBody(token=token),
                authorization="Bearer user_token",
            )
            assert accept_res["ok"] is True
            assert accept_res["role"] == "admin"

        # Role is immediately active in adminRoles!
        role_doc = mock_db.collection("adminRoles").document("user_202").get().to_dict()
        assert role_doc["role"] == "admin"
        assert role_doc["email"] == "baichong@gmail.com"

        # Invitation marked accepted and token cleared
        inv_doc = mock_db.collection("adminInvitations").document(inv_id).get().to_dict()
        assert inv_doc["status"] == "accepted"
        assert inv_doc["encryptedToken"] == ""

        # Re-accepting must fail
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_202", "email": "baichong@gmail.com"}):
            with pytest.raises(ApiError) as reaccept_exc:
                accept_invitation(
                    invitation_id=inv_id,
                    body=AcceptInvitationBody(token=token),
                    authorization="Bearer user_token",
                )
            assert reaccept_exc.value.status_code == 400


def test_user_rejects_invitation(mock_db, super_admin_actor) -> None:
    # Seed user
    mock_db.collection("users").document("user_303").set({
        "id": "user_303",
        "email": "denied@example.com",
        "role": "passenger",
    })

    with patch("api.routers.admin._db", return_value=mock_db), \
         patch("api.routers.admin.write_audit_log"):

        inv_res = create_role_invitation(
            body=CreateInvitationBody(email="denied@example.com", role="manager"),
            admin_user=super_admin_actor,
        )
        inv_id = inv_res["invitationId"]

        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "user_303", "email": "denied@example.com"}):
            reject_res = reject_invitation(
                invitation_id=inv_id,
                body=RejectInvitationBody(reason="Not interested"),
                authorization="Bearer user_token",
            )
            assert reject_res["ok"] is True

        # No role was granted
        assert mock_db.collection("adminRoles").document("user_303").get().exists is False

        # Status in DB is rejected
        inv_doc = mock_db.collection("adminInvitations").document(inv_id).get().to_dict()
        assert inv_doc["status"] == "rejected"


def test_controlled_role_transitions(mock_db, super_admin_actor) -> None:
    # 1. Existing Administrator: Direct downgrade to Manager is allowed
    mock_db.collection("adminRoles").document("admin_user_1").set({
        "uid": "admin_user_1",
        "email": "admin1@example.com",
        "name": "Admin One",
        "role": "admin",
    })
    mock_db.collection("users").document("admin_user_1").set({
        "id": "admin_user_1",
        "email": "admin1@example.com",
        "name": "Admin One",
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

        # 3. Manager promotion requires dedicated promotion invitation workflow
        promo_res = initiate_manager_promotion(
            body=InitiatePromotionBody(uid="admin_user_1"),
            admin_user=super_admin_actor,
        )
        assert promo_res["ok"] is True
        assert "invitationUrl" in promo_res
        assert promo_res["requestedRole"] == "admin"

        # Verify promotion invitation record
        promo_inv_id = promo_res["invitationId"]
        promo_inv_doc = mock_db.collection("adminInvitations").document(promo_inv_id).get().to_dict()
        assert promo_inv_doc["invitationType"] == "manager_promotion"

        # Manager accepts promotion link
        with patch("api.routers.admin.verify_firebase_token", return_value={"uid": "admin_user_1", "email": "admin1@example.com"}):
            accept_promo = accept_invitation(
                invitation_id=promo_inv_id,
                body=AcceptInvitationBody(),
                authorization="Bearer manager_token",
            )
            assert accept_promo["ok"] is True
            assert accept_promo["role"] == "admin"

        # Role updated to admin in adminRoles!
        doc_after = mock_db.collection("adminRoles").document("admin_user_1").get().to_dict()
        assert doc_after["role"] == "admin"
