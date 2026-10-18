import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock

from api.index import app
from api.core.otp import build_verification_token
from api.routers import account as account_router
from api.routers import otp as otp_router


@pytest.fixture(autouse=True)
def setup_env(monkeypatch):
    monkeypatch.setenv("OTP_SESSION_SECRET", "test-secret-key-32-characters-123456")


def test_send_otp_driver_register_blocks_existing_driver(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "get_user_phone_role", lambda phone: "driver")

    client = TestClient(app)
    response = client.post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "driver_register"},
    )
    assert response.status_code == 409
    assert "already exists" in response.json().get("error", "").lower()


def test_send_otp_driver_register_allows_existing_passenger(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "get_user_phone_role", lambda phone: "passenger")
    monkeypatch.setattr(otp_router, "reserve_otp_send", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "record_otp_session", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "require_env", lambda _name: "test-secret")

    async def mock_2factor_send(*_args, **_kwargs):
        return {"Status": "Success", "Details": "session-123"}

    monkeypatch.setattr(otp_router, "fetch_two_factor_json", mock_2factor_send)

    client = TestClient(app)
    response = client.post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "driver_register"},
    )
    assert response.status_code == 200
    assert response.json().get("ok") is True


def test_send_otp_driver_register_allows_new_user(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "get_user_phone_role", lambda phone: None)
    monkeypatch.setattr(otp_router, "reserve_otp_send", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "record_otp_session", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "require_env", lambda _name: "test-secret")

    async def mock_2factor_send(*_args, **_kwargs):
        return {"Status": "Success", "Details": "session-456"}

    monkeypatch.setattr(otp_router, "fetch_two_factor_json", mock_2factor_send)

    client = TestClient(app)
    response = client.post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "driver_register"},
    )
    assert response.status_code == 200
    assert response.json().get("ok") is True


def test_register_account_strictly_enforces_passenger_role(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "register")

    created_docs = {}

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def set(self, data, merge=False):
            created_docs[(self.col, self.doc_id)] = data

        def get(self):
            doc = MagicMock()
            doc.exists = False
            return doc

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

        def where(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def get(self):
            return []

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    class MockAuthClient:
        def __init__(self, app):
            pass

        def get_user_by_phone_number(self, p):
            raise Exception("not found")

        def create_user(self, **kwargs):
            record = MagicMock()
            record.uid = "new-passenger-uid"
            return record

        def create_custom_token(self, uid):
            return b"custom-token-bytes"

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", MockAuthClient)

    client = TestClient(app)
    # Attempt privilege escalation: client specifies role: "driver"
    response = client.post(
        "/api/register-account",
        json={
            "verificationToken": token,
            "password": "securepassword123",
            "profile": {
                "name": "Sneaky Passenger",
                "email": "passenger@example.com",
                "role": "driver",
                "gender": "Male",
            },
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["profile"]["role"] == "passenger"

    # Verify Firestore document was written with passenger role
    user_doc = created_docs.get(("users", "new-passenger-uid"))
    assert user_doc is not None
    assert user_doc["role"] == "passenger"

    # Verify phoneLoginIndex was written with passenger role
    index_doc = created_docs.get(("phoneLoginIndex", phone))
    assert index_doc is not None
    assert index_doc["role"] == "passenger"


def test_register_driver_requires_valid_token() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": "invalid.token",
            "password": "password123",
            "profile": {"name": "Test Driver"},
        },
    )
    assert response.status_code == 400


def test_register_driver_rejects_token_with_wrong_purpose() -> None:
    token = build_verification_token("+919436332301", "reset")
    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {"name": "Test Driver"},
        },
    )
    assert response.status_code == 400


def test_register_driver_validates_required_fields(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")
    client = TestClient(app)

    # Short name
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {"name": "A"},
        },
    )
    assert r.status_code == 400
    assert "full name" in r.json()["error"].lower()

    # Invalid vehicle type
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Valid Name",
                "vehicleType": "truck",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "test@upi",
                "termsAccepted": True,
            },
        },
    )
    assert r.status_code == 400
    assert "bike" in r.json()["error"].lower() or "auto" in r.json()["error"].lower()

    # Invalid vehicle number
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Valid Name",
                "vehicleType": "bike",
                "vehicleNumber": "!@#$",
                "vehicleModel": "Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "test@upi",
                "termsAccepted": True,
            },
        },
    )
    assert r.status_code == 400
    assert "vehicle registration number" in r.json()["error"].lower()

    # Invalid license number
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Valid Name",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Splendor",
                "drivingLicenseNumber": "NO",
                "upiId": "test@upi",
                "termsAccepted": True,
            },
        },
    )
    assert r.status_code == 400
    assert "driving licence number" in r.json()["error"].lower()

    # Invalid UPI
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Valid Name",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "invalid-upi",
                "termsAccepted": True,
            },
        },
    )
    assert r.status_code == 400
    assert "upi id" in r.json()["error"].lower()

    # Terms not accepted
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Valid Name",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "test@upi",
                "termsAccepted": False,
            },
        },
    )
    assert r.status_code == 400
    assert "terms" in r.json()["error"].lower()


def test_register_driver_creates_new_driver_account(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")

    created_docs = {}

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def set(self, data, merge=False):
            created_docs[(self.col, self.doc_id)] = data

        def get(self):
            doc = MagicMock()
            doc.exists = False
            return doc

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

        def where(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def get(self):
            return []

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    class MockAuthClient:
        def __init__(self, app):
            pass

        def get_user_by_phone_number(self, p):
            raise Exception("not found")

        def create_user(self, **kwargs):
            record = MagicMock()
            record.uid = "new-driver-uid"
            return record

        def create_custom_token(self, uid):
            return "test-custom-token-driver"

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", MockAuthClient)

    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "driverpassword123",
            "profile": {
                "name": "New Captain",
                "email": "captain@example.com",
                "gender": "Male",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor Plus",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "captain@upi",
                "termsAccepted": True,
            },
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["customToken"] == "test-custom-token-driver"
    assert data["profile"]["role"] == "driver"
    assert data["profile"]["vehicleType"] == "bike"
    assert data["profile"]["vehicleNumber"] == "TR01AB1234"
    assert data["profile"]["verificationStatus"] == "pending_review"

    # Verify Firestore user doc
    user_doc = created_docs.get(("users", "new-driver-uid"))
    assert user_doc is not None
    assert user_doc["role"] == "driver"
    assert user_doc["drivingLicenseNumber"] == "TR0120200001234"

    # Verify phoneLoginIndex
    index_doc = created_docs.get(("phoneLoginIndex", phone))
    assert index_doc is not None
    assert index_doc["role"] == "driver"


def test_register_driver_upgrades_existing_passenger(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")
    existing_passenger_uid = "existing-p-uid"

    saved_updates = {}

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def set(self, data, merge=False):
            saved_updates[(self.col, self.doc_id)] = data

        def get(self):
            doc = MagicMock()
            if self.col == "phoneLoginIndex" and self.doc_id == phone:
                doc.exists = True
                doc.to_dict.return_value = {
                    "uid": existing_passenger_uid,
                    "role": "passenger",
                    "email": "existing@example.com",
                    "phone": phone,
                }
            elif self.col == "users" and self.doc_id == existing_passenger_uid:
                doc.exists = True
                doc.to_dict.return_value = {
                    "uid": existing_passenger_uid,
                    "name": "Existing Passenger",
                    "role": "passenger",
                    "email": "existing@example.com",
                    "phone": phone,
                }
            else:
                doc.exists = False
            return doc

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

        def where(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def get(self):
            return []

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    class MockAuthClient:
        def __init__(self, app):
            pass

        def update_user(self, uid, **kwargs):
            pass

        def create_custom_token(self, uid):
            return "upgraded-custom-token"

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", MockAuthClient)

    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "newpassword123",
            "profile": {
                "name": "Upgraded Driver",
                "email": "existing@example.com",
                "gender": "Male",
                "vehicleType": "auto",
                "vehicleNumber": "TR01XY9999",
                "vehicleModel": "Bajaj RE",
                "drivingLicenseNumber": "TR0120220005678",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["customToken"] == "upgraded-custom-token"
    assert data["profile"]["role"] == "driver"

    # Verify user record updated to driver
    user_update = saved_updates.get(("users", existing_passenger_uid))
    assert user_update is not None
    assert user_update["role"] == "driver"
    assert user_update["vehicleType"] == "auto"

    # Verify phoneLoginIndex updated to driver
    index_update = saved_updates.get(("phoneLoginIndex", phone))
    assert index_update is not None
    assert index_update["role"] == "driver"


def test_register_driver_rejects_if_already_driver(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def get(self):
            doc = MagicMock()
            doc.exists = True
            doc.to_dict.return_value = {
                "uid": "already-driver-uid",
                "role": "driver",
                "phone": phone,
            }
            return doc

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    class MockAuthClient:
        def __init__(self, app):
            pass

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", MockAuthClient)

    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Already Driver",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )

    assert response.status_code == 409
    assert "already exists" in response.json()["error"].lower()


def test_register_driver_rejects_passenger_register_token() -> None:
    # A token minted with purpose="register" (passenger) must NOT be accepted on /api/register-driver
    token = build_verification_token("+919436332301", "register")
    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Sneaky Driver",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )
    assert response.status_code == 400
    assert "cannot be used here" in response.json().get("error", "").lower()


def test_register_driver_rejects_phone_mismatch_or_invalid() -> None:
    token = build_verification_token("+919436332301", "driver_register")
    client = TestClient(app)

    # Submitting a completely different phone
    r = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "phone": "9876543210",
            "password": "password123",
            "profile": {
                "name": "Mismatch Phone",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )
    assert r.status_code == 400
    assert "does not match" in r.json().get("error", "").lower()

    # Submitting an invalid phone string
    r2 = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "phone": "invalid-phone",
            "password": "password123",
            "profile": {
                "name": "Invalid Phone",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )
    assert r2.status_code == 400
    assert "does not match" in r2.json().get("error", "").lower()


def test_register_driver_rejects_passenger_with_active_ride(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")
    passenger_uid = "active-ride-passenger"

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def get(self):
            doc = MagicMock()
            if self.col == "phoneLoginIndex" and self.doc_id == phone:
                doc.exists = True
                doc.to_dict.return_value = {
                    "uid": passenger_uid,
                    "role": "passenger",
                    "email": "active@example.com",
                    "phone": phone,
                }
            elif self.col == "users" and self.doc_id == passenger_uid:
                doc.exists = True
                doc.to_dict.return_value = {
                    "uid": passenger_uid,
                    "name": "Active Passenger",
                    "role": "passenger",
                    "phone": phone,
                }
            else:
                doc.exists = False
            return doc

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

        def where(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def get(self):
            if self.name == "rides":
                ride_doc = MagicMock()
                ride_doc.id = "ride-active-123"
                return [ride_doc]
            return []

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", lambda app: MagicMock())

    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Active Passenger",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )
    assert response.status_code == 400
    assert "active ride" in response.json().get("error", "").lower()


def test_register_driver_rolls_back_firestore_documents_on_failure(monkeypatch) -> None:
    phone = "+919436332301"
    token = build_verification_token(phone, "driver_register")
    deleted_calls = []

    class MockDocRef:
        def __init__(self, col, doc_id):
            self.col = col
            self.doc_id = doc_id

        def set(self, data, merge=False):
            pass

        def get(self):
            doc = MagicMock()
            doc.exists = False
            return doc

        def delete(self):
            deleted_calls.append((self.col, self.doc_id))

    class MockCollection:
        def __init__(self, name):
            self.name = name

        def document(self, doc_id):
            return MockDocRef(self.name, doc_id)

        def where(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def get(self):
            return []

    class MockDb:
        def collection(self, name):
            return MockCollection(name)

    class MockAuthClient:
        def __init__(self, app):
            pass

        def get_user_by_phone_number(self, p):
            raise Exception("not found")

        def create_user(self, **kwargs):
            record = MagicMock()
            record.uid = "failed-new-driver"
            return record

        def create_custom_token(self, uid):
            # Simulate unexpected failure after user is created
            raise RuntimeError("Database connection lost during token creation")

        def delete_user(self, uid):
            deleted_calls.append(("auth_user", uid))

    monkeypatch.setattr(account_router, "get_admin_app", lambda: object())
    monkeypatch.setattr(account_router.fb_firestore, "client", lambda app: MockDb())
    monkeypatch.setattr(account_router.fb_auth, "Client", MockAuthClient)

    client = TestClient(app)
    response = client.post(
        "/api/register-driver",
        json={
            "verificationToken": token,
            "password": "password123",
            "profile": {
                "name": "Failed Driver",
                "vehicleType": "bike",
                "vehicleNumber": "TR01AB1234",
                "vehicleModel": "Hero Splendor",
                "drivingLicenseNumber": "TR0120200001234",
                "upiId": "driver@upi",
                "termsAccepted": True,
            },
        },
    )
    assert response.status_code == 500
    assert ("auth_user", "failed-new-driver") in deleted_calls
    assert ("users", "failed-new-driver") in deleted_calls
    assert ("phoneLoginIndex", phone) in deleted_calls

