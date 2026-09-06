import asyncio
import time
from fastapi.testclient import TestClient
import pytest

from api.core import otp as otp_core
from api.core.errors import ApiError
from api.index import app
from api.routers import otp as otp_router


def test_otp_config_existing_provider(monkeypatch) -> None:
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "existing")
    monkeypatch.setattr(otp_router, "OTP_PROVIDER", "existing")

    client = TestClient(app)
    response = client.get("/api/otp-config")
    assert response.status_code == 200
    data = response.json()
    assert data == {"ok": True, "provider": "existing"}


def test_otp_config_msg91_provider(monkeypatch) -> None:
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "require_env", lambda name: f"mock-{name}")

    client = TestClient(app)
    response = client.get("/api/otp-config")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["provider"] == "msg91"
    assert data["widgetId"] == "mock-MSG91_WIDGET_ID"
    assert data["tokenAuth"] == "mock-MSG91_WIDGET_TOKEN"
    assert "MSG91_AUTH_KEY" not in data
    assert "authKey" not in data


def test_send_otp_msg91_reserves_slot(monkeypatch) -> None:
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)

    reserved_calls = []

    def mock_reserve(phone, purpose, is_retry=False):
        reserved_calls.append((phone, purpose, is_retry))

    monkeypatch.setattr(otp_router, "reserve_otp_send", mock_reserve)

    client = TestClient(app)
    response = client.post(
        "/api/send-otp",
        json={"phone": "+919876543210", "purpose": "register"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["permitted"] is True
    assert data["provider"] == "msg91"
    assert data["identifier"] == "919876543210"
    assert reserved_calls == [("+919876543210", "register", False)]


def test_bind_session_msg91(monkeypatch) -> None:
    bound_calls = []

    def mock_bind(phone, purpose, req_id):
        bound_calls.append((phone, purpose, req_id))

    monkeypatch.setattr(otp_router, "bind_otp_session", mock_bind)

    client = TestClient(app)
    response = client.post(
        "/api/otp/session",
        json={"phone": "9876543210", "purpose": "register", "reqId": "req_abc123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["otpSessionId"] == "req_abc123"
    assert bound_calls == [("+919876543210", "register", "req_abc123")]


def test_report_failure_msg91(monkeypatch) -> None:
    failed_calls = []

    def mock_record_failed(phone, purpose, req_id):
        failed_calls.append((phone, purpose, req_id))

    monkeypatch.setattr(otp_router, "record_failed_otp_attempt", mock_record_failed)

    client = TestClient(app)
    response = client.post(
        "/api/otp/report-failure",
        json={"phone": "9876543210", "purpose": "register", "reqId": "req_abc123"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert failed_calls == [("+919876543210", "register", "req_abc123")]


def test_verify_otp_msg91_success(monkeypatch) -> None:
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "require_env", lambda _name: "test-secret")
    monkeypatch.setattr(otp_core, "require_env", lambda _name: "test-secret")

    async def mock_verify_access_token(token):
        assert token == "valid-jwt-token"
        return {"ok": True, "verifiedPhone": "+919876543210"}

    marked_verified = []

    def mock_mark_verified(phone, purpose, session_id):
        marked_verified.append((phone, purpose, session_id))

    monkeypatch.setattr(otp_router, "verify_msg91_access_token", mock_verify_access_token)
    monkeypatch.setattr(otp_router, "mark_otp_verified", mock_mark_verified)

    client = TestClient(app)
    response = client.post(
        "/api/verify-otp",
        json={
            "phone": "9876543210",
            "purpose": "register",
            "otpSessionId": "req_abc123",
            "accessToken": "valid-jwt-token",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["phone"] == "+919876543210"
    assert data["provider"] == "msg91"
    assert "verificationToken" in data
    assert marked_verified == [("+919876543210", "register", "req_abc123")]

    # Validate HMAC token is verifiable by LiphtUP
    token_payload = otp_core.verify_token(data["verificationToken"], "register")
    assert token_payload["phone"] == "+919876543210"
    assert token_payload["purpose"] == "register"


def test_verify_otp_msg91_phone_mismatch_rejected(monkeypatch) -> None:
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "OTP_PROVIDER", "msg91")
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)

    async def mock_verify_access_token(token):
        return {"ok": True, "verifiedPhone": "+919999999999"}

    monkeypatch.setattr(otp_router, "verify_msg91_access_token", mock_verify_access_token)

    client = TestClient(app)
    response = client.post(
        "/api/verify-otp",
        json={
            "phone": "9876543210",
            "purpose": "register",
            "otpSessionId": "req_abc123",
            "accessToken": "attacker-jwt-for-other-number",
        },
    )
    assert response.status_code == 400
    assert "Verified phone identity does not match" in response.json()["error"]


def test_to_msg91_identifier() -> None:
    from api.core.otp_providers.msg91 import to_msg91_identifier

    assert to_msg91_identifier("+919876543210") == "919876543210"
    assert to_msg91_identifier("9876543210") == "919876543210"
    assert to_msg91_identifier("+91 98765-43210") == "919876543210"


def test_msg91_response_parser() -> None:
    from api.core.otp_providers.msg91 import _extract_msg91_phone

    assert _extract_msg91_phone({"type": "success", "message": "919876543210"}) == "+919876543210"
    assert _extract_msg91_phone({"status": "success", "data": {"mobile": "919876543210"}}) == "+919876543210"
    assert _extract_msg91_phone({"status": "success", "mobile": "+919876543210"}) == "+919876543210"
    assert _extract_msg91_phone({"data": {"number": "9876543210"}}) == "+919876543210"
    assert _extract_msg91_phone({"status": "failed", "message": "invalid"}) == ""


def test_reserve_otp_send_cooldown_and_window(monkeypatch) -> None:
    """Verify 60s cooldown and 5/hr window in Firestore transaction."""
    stored_state = {}

    class MockSnapshot:
        def __init__(self, data):
            self._data = data
            self.exists = bool(data)
        def to_dict(self):
            return dict(self._data)

    class MockDocRef:
        def get(self, transaction=None):
            return MockSnapshot(stored_state)

    class MockTransaction:
        def set(self, ref, data, merge=True):
            stored_state.update(data)

    class MockDb:
        def transaction(self):
            return MockTransaction()
        def collection(self, name):
            return self
        def document(self, name):
            return MockDocRef()

    monkeypatch.setattr(otp_core, "get_firestore", lambda: MockDb())
    monkeypatch.setattr(otp_core, "firestore_transactional", lambda: lambda f: lambda tx: f(tx))

    now = 1000.0
    # 1. First send: allowed
    otp_core.reserve_otp_send("+919876543210", "register", now=now)
    assert stored_state["lastSentAt"] == now

    # 2. Cooldown rejection within 60s
    with pytest.raises(ApiError) as err:
        otp_core.reserve_otp_send("+919876543210", "register", now=now + 30.0)
    assert err.value.status_code == 429
    assert "Please wait before requesting another OTP" in err.value.message

    # 3. After 60s: allowed
    now += 65.0
    otp_core.reserve_otp_send("+919876543210", "register", now=now)

    # 4. Fill window up to 5 sends
    now += 65.0
    otp_core.reserve_otp_send("+919876543210", "register", now=now)
    now += 65.0
    otp_core.reserve_otp_send("+919876543210", "register", now=now)
    now += 65.0
    otp_core.reserve_otp_send("+919876543210", "register", now=now)

    # 5. 6th send in window: rejected with 429
    now += 65.0
    with pytest.raises(ApiError) as err:
        otp_core.reserve_otp_send("+919876543210", "register", now=now)
    assert err.value.status_code == 429
    assert "Too many OTP requests" in err.value.message


def test_failed_attempts_lock_session_at_five(monkeypatch) -> None:
    stored_state = {"activeSessionId": "req_123", "verifyAttempts": 0}

    class MockSnapshot:
        def __init__(self, data):
            self._data = data
            self.exists = bool(data)
        def to_dict(self):
            return dict(self._data)

    class MockDocRef:
        def get(self, transaction=None):
            return MockSnapshot(stored_state)

    class MockTransaction:
        def set(self, ref, data, merge=True):
            stored_state.update(data)

    class MockDb:
        def transaction(self):
            return MockTransaction()
        def collection(self, name):
            return self
        def document(self, name):
            return MockDocRef()

    monkeypatch.setattr(otp_core, "get_firestore", lambda: MockDb())
    monkeypatch.setattr(otp_core, "firestore_transactional", lambda: lambda f: lambda tx: f(tx))

    # Attempts 1 to 4: increments
    for i in range(1, 5):
        otp_core.record_failed_otp_attempt("+919876543210", "register", "req_123")
        assert stored_state["verifyAttempts"] == i
        assert stored_state["isLocked"] is False

    # 5th attempt: locks session and raises 429
    with pytest.raises(ApiError) as err:
        otp_core.record_failed_otp_attempt("+919876543210", "register", "req_123")
    assert err.value.status_code == 429
    assert stored_state["verifyAttempts"] == 5
    assert stored_state["isLocked"] is True


def test_session_id_mismatch_rejected(monkeypatch) -> None:
    stored_state = {"activeSessionId": "req_session_A", "verifyAttempts": 0}

    class MockSnapshot:
        def __init__(self, data):
            self._data = data
            self.exists = bool(data)
        def to_dict(self):
            return dict(self._data)

    class MockDocRef:
        def get(self, transaction=None):
            return MockSnapshot(stored_state)

    class MockTransaction:
        def set(self, ref, data, merge=True):
            stored_state.update(data)

    class MockDb:
        def transaction(self):
            return MockTransaction()
        def collection(self, name):
            return self
        def document(self, name):
            return MockDocRef()

    monkeypatch.setattr(otp_core, "get_firestore", lambda: MockDb())
    monkeypatch.setattr(otp_core, "firestore_transactional", lambda: lambda f: lambda tx: f(tx))

    # Calling with session B when activeSessionId is session A -> rejected
    with pytest.raises(ApiError) as err:
        otp_core.record_failed_otp_attempt("+919876543210", "register", "req_session_B")
    assert err.value.status_code == 400


def test_token_replay_rejected_by_mark_verified(monkeypatch) -> None:
    stored_state = {"activeSessionId": "req_123", "verifyAttempts": 0, "tokenIssued": True}

    class MockSnapshot:
        def __init__(self, data):
            self._data = data
            self.exists = bool(data)
        def to_dict(self):
            return dict(self._data)

    class MockDocRef:
        def get(self, transaction=None):
            return MockSnapshot(stored_state)

    class MockTransaction:
        def set(self, ref, data, merge=True):
            stored_state.update(data)

    class MockDb:
        def transaction(self):
            return MockTransaction()
        def collection(self, name):
            return self
        def document(self, name):
            return MockDocRef()

    monkeypatch.setattr(otp_core, "get_firestore", lambda: MockDb())
    monkeypatch.setattr(otp_core, "firestore_transactional", lambda: lambda f: lambda tx: f(tx))

    with pytest.raises(ApiError) as err:
        otp_core.mark_otp_verified("+919876543210", "register", "req_123")
    assert err.value.status_code == 400
    assert "already been consumed" in err.value.message


def test_otp_provider_dynamic_profile_field(monkeypatch) -> None:
    from api.routers.account import _build_profile

    # When existing: "2factor"
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "existing")
    profile = _build_profile("test_uid", "+919876543210", {"name": "Test User", "email": "test@example.com", "role": "passenger"})
    assert profile["otpProvider"] == "2factor"

    # When msg91: "msg91"
    monkeypatch.setattr(otp_core, "OTP_PROVIDER", "msg91")
    profile = _build_profile("test_uid", "+919876543210", {"name": "Test User", "email": "test@example.com", "role": "passenger"})
    assert profile["otpProvider"] == "msg91"
