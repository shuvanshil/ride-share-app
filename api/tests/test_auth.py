import asyncio
import json

from api.core.auth import extract_bearer_token
from api.core.errors import ApiError
from fastapi.testclient import TestClient

from api.index import app, unhandled_error_handler
from api.routers.rides import _driver_fare_adjustment, _require_approved_driver, _require_role


def test_extract_bearer_token_accepts_case_insensitive_scheme() -> None:
    assert extract_bearer_token("bearer abc123") == "abc123"


def test_extract_bearer_token_rejects_malformed_header() -> None:
    assert extract_bearer_token(None) == ""
    assert extract_bearer_token("Basic abc123") == ""
    assert extract_bearer_token("Bearer") == ""


def test_profile_endpoint_requires_authentication() -> None:
    response = TestClient(app).get("/api/profile")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_cancellation_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/cancel")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_creation_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides",
        json={
            "pickupName": "Pickup",
            "dropName": "Drop",
            "pickupLat": 23.83,
            "pickupLng": 91.98,
            "dropLat": 23.84,
            "dropLng": 91.99,
            "vehicleType": "bike",
        },
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_ride_acceptance_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/accept")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_transition_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/example-ride/transition",
        json={"action": "complete"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_dispatch_expansion_requires_authentication() -> None:
    response = TestClient(app).post("/api/rides/example-ride/dispatch")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_availability_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-availability",
        json={"status": "searching"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_location_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-location",
        json={"lat": 23.83, "lng": 91.98},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_driver_push_token_requires_authentication() -> None:
    response = TestClient(app).post(
        "/api/rides/driver-push-token",
        json={"token": "x" * 20, "permission": "granted"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication is required."}


def test_unhandled_errors_do_not_expose_exception_details() -> None:
    response = asyncio.run(unhandled_error_handler(None, RuntimeError("secret provider detail")))
    assert response.status_code == 500
    assert json.loads(response.body) == {"error": "Internal server error"}


def test_role_guard_rejects_the_wrong_account_role() -> None:
    _require_role({"role": "driver"}, "driver", "driver only")

    try:
        _require_role({"role": "passenger"}, "driver", "driver only")
    except ApiError as error:
        assert error.status_code == 403
        assert error.message == "driver only"
    else:
        raise AssertionError("Expected a passenger to be rejected by the driver guard")


def test_approved_driver_guard_rejects_unapproved_driver() -> None:
    _require_approved_driver({"role": "driver", "verificationStatus": "approved"}, "approved driver only")

    for profile in (
        {"role": "driver", "verificationStatus": "pending_review"},
        {"role": "driver", "verificationStatus": "suspended"},
        {"role": "passenger", "verificationStatus": "approved"},
    ):
        try:
            _require_approved_driver(profile, "approved driver only")
        except ApiError as error:
            assert error.status_code == 403
            assert error.message == "approved driver only"
        else:
            raise AssertionError("Expected a non-approved driver profile to be rejected")


def base_completed_ride(driver_lat: float, driver_lng: float) -> dict:
    return {
        "status": "en_route",
        "pinVerifiedAt": "2026-07-23T10:00:00+00:00",
        "pickup_lat": 0.0,
        "pickup_lng": 0.0,
        "drop_lat": 0.0,
        "drop_lng": 0.1,
        "driverLocation": {"lat": driver_lat, "lng": driver_lng},
        "distance_km": 11.12,
        "fare": 93,
        "quoted_fare": 93,
        "vehicle_type": "bike",
    }


def test_driver_fare_adjustment_zero_travel_after_pickup() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.0), "cancel")

    assert adjustment["final_fare"] == 0
    assert adjustment["reason"] == "zero_passenger_travel"


def test_driver_fare_adjustment_reduces_before_ninety_percent() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.05), "cancel")

    assert adjustment["reason"] == "partial_trip"
    assert adjustment["final_fare"] < adjustment["original_fare"]
    assert adjustment["progress_ratio"] < 0.9


def test_driver_fare_adjustment_keeps_full_fare_at_ninety_percent() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.091), "cancel")

    assert adjustment["reason"] == "full_trip_threshold"
    assert adjustment["final_fare"] == adjustment["original_fare"]


def test_driver_fare_adjustment_does_not_charge_extra_before_drop() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.095), "complete")

    assert adjustment["reason"] == "full_trip_threshold"
    assert adjustment["final_fare"] == adjustment["original_fare"]


def test_driver_fare_adjustment_adds_only_after_free_dropoff_buffer() -> None:
    adjustment = _driver_fare_adjustment(base_completed_ride(0.0, 0.102), "complete")

    assert adjustment["reason"] == "extra_after_drop"
    assert adjustment["final_fare"] > adjustment["original_fare"]
    assert adjustment["extra_dropoff_distance_km"] > 0.1


def test_check_phone_invalid_returns_false(monkeypatch) -> None:
    client = TestClient(app)
    response = client.post("/api/auth/check-phone", json={"phone": "123"})
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["exists"] is False


def test_check_phone_existing_in_index(monkeypatch) -> None:
    class MockDoc:
        exists = True

    class MockCollection:
        def document(self, phone):
            return self
        def get(self):
            return MockDoc()

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    response = client.post("/api/auth/check-phone", json={"phone": "9876543210"})
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["exists"] is True
    assert data["phone"] == "+919876543210"


def test_check_phone_non_existing_returns_false(monkeypatch) -> None:
    class MockDoc:
        exists = False

    class MockCollection:
        def document(self, phone):
            return self
        def get(self):
            return MockDoc()

    class MockDb:
        def collection(self, name):
            return MockCollection()

    class MockAuthClient:
        def __init__(self, app):
            pass
        def get_user_by_phone_number(self, phone):
            raise Exception("User not found")

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())
    monkeypatch.setattr("api.routers.auth.fb_auth.Client", MockAuthClient)

    client = TestClient(app)
    response = client.post("/api/auth/check-phone", json={"phone": "9876543210"})
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["exists"] is False


def test_validate_base_profile_gender_options() -> None:
    from api.routers.account import _validate_base_profile, _build_profile

    male_profile = _validate_base_profile({"name": "Test User", "email": "test@example.com", "role": "passenger", "gender": "Male"})
    assert male_profile["gender"] == "Male"

    female_profile = _validate_base_profile({"name": "Test User", "email": "test@example.com", "role": "driver", "gender": "Female"})
    assert female_profile["gender"] == "Female"

    others_profile = _validate_base_profile({"name": "Test User", "email": "test@example.com", "role": "passenger", "gender": "Others"})
    assert others_profile["gender"] == "Others"

    # Default fallback for accounts registered without gender
    default_profile = _validate_base_profile({"name": "Test User", "email": "test@example.com", "role": "passenger"})
    assert default_profile["gender"] == "Others"

    built = _build_profile("test-uid", "+919876543210", {"name": "Test User", "email": "test@example.com", "gender": "Female"})
    assert built["gender"] == "Female"


def test_validate_base_profile_optional_email() -> None:
    from api.routers.account import _validate_base_profile, _build_profile

    no_email_profile = _validate_base_profile({"name": "No Email User", "gender": "Male"})
    assert no_email_profile["name"] == "No Email User"
    assert no_email_profile["email"] == ""
    assert no_email_profile["gender"] == "Male"

    built = _build_profile("test-uid-2", "+919876543211", {"name": "No Email User", "gender": "Female"})
    assert built["email"] == ""
    assert built["name"] == "No Email User"
    assert built["gender"] == "Female"


def test_check_phone_existing_in_auth(monkeypatch) -> None:
    class MockDoc:
        exists = False

    class MockCollection:
        def document(self, phone):
            return self
        def get(self):
            return MockDoc()
        def where(self, *args, **kwargs):
            return self
        def limit(self, n):
            return self

    class MockDb:
        def collection(self, name):
            return MockCollection()

    class MockAuthClient:
        def __init__(self, app):
            pass
        def get_user_by_phone_number(self, phone):
            return object()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())
    monkeypatch.setattr("api.routers.auth.fb_auth.Client", MockAuthClient)

    client = TestClient(app)
    response = client.post("/api/auth/check-phone", json={"phone": "9876543210"})
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["exists"] is True


def test_send_otp_blocks_existing_user_on_registration(monkeypatch) -> None:
    monkeypatch.setattr("api.routers.otp.check_user_phone_exists", lambda phone: True)

    client = TestClient(app)
    response = client.post("/api/send-otp", json={"phone": "9876543210", "purpose": "register"})
    assert response.status_code == 409
    data = response.json()
    assert "already exists" in (data.get("detail") or data.get("error") or "")


def test_check_phone_returns_role_and_synthetic_email(monkeypatch) -> None:
    class MockIndexDoc:
        exists = True
        def to_dict(self):
            return {"role": "driver", "uid": "driver-uid-1", "email": ""}

    class MockCollection:
        def document(self, phone):
            return self
        def get(self):
            return MockIndexDoc()

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    response = client.post("/api/auth/check-phone", json={"phone": "+919876543210"})
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["exists"] is True
    assert data["role"] == "driver"
    assert data["email"] == "919876543210@user.liphtup.in"



def test_session_returns_seven_day_expiry(monkeypatch) -> None:
    import time
    from api.core.auth import current_user
    app.dependency_overrides[current_user] = lambda: {
        "uid": "usr_test_sess",
        "email": "test@liphtup.com",
        "phone_number": "+919876543210",
        "email_verified": True,
        "iat": int(time.time()),
    }
    class MockDoc:
        exists = False
        def to_dict(self):
            return {}

    class MockCollection:
        def document(self, doc_id):
            return self
        def get(self):
            return MockDoc()
        def set(self, data, merge=False):
            pass

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    try:
        response = client.get("/api/auth/session")
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert data["user"]["uid"] == "usr_test_sess"
        assert "lastMeaningfulActivityAt" in data
        assert "expiresAt" in data
        diff_ms = data["expiresAt"] - data["lastMeaningfulActivityAt"]
        # Exactly 7 days (604,800,000 ms)
        assert abs(diff_ms - 7 * 24 * 3600 * 1000) < 5000
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_session_expired_after_seven_days_inactivity(monkeypatch) -> None:
    import time
    from datetime import datetime, timezone, timedelta
    from api.core.auth import current_user
    app.dependency_overrides[current_user] = lambda: {
        "uid": "usr_test_expired",
        "email": "test@liphtup.com",
        "phone_number": "+919876543210",
        "email_verified": True,
        "iat": int(time.time()),
    }
    eight_days_ago = datetime.now(timezone.utc) - timedelta(days=8)

    class MockDoc:
        exists = True
        def to_dict(self):
            return {
                "uid": "usr_test_expired",
                "lastActivityAt": eight_days_ago,
                "isRevoked": False,
            }

    class MockCollection:
        def document(self, doc_id):
            return self
        def get(self):
            return MockDoc()

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    try:
        response = client.get("/api/auth/session")
        assert response.status_code == 401
        data = response.json()
        assert "7 days of inactivity" in (data.get("error") or data.get("detail") or "")
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_logout_revokes_session(monkeypatch) -> None:
    import time
    from api.core.auth import current_user
    app.dependency_overrides[current_user] = lambda: {
        "uid": "usr_test_logout",
        "email": "test@liphtup.com",
        "phone_number": "+919876543210",
        "email_verified": True,
        "iat": int(time.time()),
    }
    saved_state = {}

    class MockCollection:
        def document(self, doc_id):
            return self
        def set(self, data, merge=False):
            saved_state.update(data)

    class MockDb:
        def collection(self, name):
            return MockCollection()

    revoked_uids = []
    class MockAuthModule:
        @staticmethod
        def revoke_refresh_tokens(uid, app=None):
            revoked_uids.append(uid)

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())
    monkeypatch.setattr("api.routers.auth.fb_auth", MockAuthModule)

    client = TestClient(app)
    try:
        response = client.post("/api/auth/logout")
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert "usr_test_logout" in revoked_uids
        assert saved_state.get("isRevoked") is True
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_activity_renews_session_deadline(monkeypatch) -> None:
    import time
    from api.core.auth import current_user
    app.dependency_overrides[current_user] = lambda: {
        "uid": "usr_test_activity",
        "email": "test@liphtup.com",
        "phone_number": "+919876543210",
        "email_verified": True,
        "iat": int(time.time()),
    }
    saved_state = {}

    class MockCollection:
        def document(self, doc_id):
            return self
        def set(self, data, merge=False):
            saved_state.update(data)

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    try:
        response = client.post("/api/auth/activity")
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert "lastMeaningfulActivityAt" in data
        assert "expiresAt" in data
        assert saved_state.get("isRevoked") is False
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_fresh_login_supersedes_stale_inactivity_in_session(monkeypatch) -> None:
    import time
    from datetime import datetime, timezone, timedelta
    from api.core.auth import current_user
    now_ts = int(time.time())
    app.dependency_overrides[current_user] = lambda: {
        "uid": "usr_test_fresh_login",
        "email": "test@liphtup.com",
        "phone_number": "+919876543210",
        "email_verified": True,
        "iat": now_ts,
        "auth_time": now_ts,
    }
    ten_days_ago = datetime.now(timezone.utc) - timedelta(days=10)
    saved_state = {}

    class MockDoc:
        exists = True
        def to_dict(self):
            return {
                "uid": "usr_test_fresh_login",
                "lastActivityAt": ten_days_ago,
                "isRevoked": False,
            }

    class MockDocRef:
        def get(self):
            return MockDoc()
        def set(self, data, merge=False):
            saved_state.update(data)

    class MockCollection:
        def document(self, doc_id):
            return MockDocRef()

    class MockDb:
        def collection(self, name):
            return MockCollection()

    monkeypatch.setattr("api.routers.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.routers.auth.fb_firestore.client", lambda app: MockDb())

    client = TestClient(app)
    try:
        response = client.get("/api/auth/session")
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert saved_state.get("isRevoked") is False
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_core_auth_enforce_session_inactivity_expiry(monkeypatch) -> None:
    import time
    from datetime import datetime, timezone, timedelta
    import pytest
    from api.core.auth import enforce_session_inactivity_expiry
    from api.core.errors import ApiError

    now_ts = int(time.time())
    ten_days_ago = datetime.now(timezone.utc) - timedelta(days=10)
    saved_state = {}

    class MockDocRef:
        def __init__(self, doc_data, exists=True):
            self._doc_data = doc_data
            self._exists = exists
        def get(self):
            class MockDoc:
                exists = self._exists
                def to_dict(inner_self):
                    return self._doc_data
            return MockDoc()
        def set(self, data, merge=False):
            saved_state.update(data)

    class MockDb:
        def __init__(self, doc_ref):
            self._doc_ref = doc_ref
        def collection(self, name):
            class Coll:
                def document(inner_self, doc_id):
                    return self._doc_ref
            return Coll()

    # 1. Fresh login with 10-day stale lastActivityAt -> succeeds and renews
    fresh_user_doc = MockDocRef({"uid": "u1", "lastActivityAt": ten_days_ago, "isRevoked": False})
    monkeypatch.setattr("api.core.auth.get_admin_app", lambda: object())
    monkeypatch.setattr("api.core.auth.fb_firestore.client", lambda app: MockDb(fresh_user_doc))
    enforce_session_inactivity_expiry({"uid": "u1", "iat": now_ts, "auth_time": now_ts})
    assert saved_state.get("isRevoked") is False

    # 2. Missing userSessions doc -> succeeds and initializes
    missing_doc = MockDocRef({}, exists=False)
    monkeypatch.setattr("api.core.auth.fb_firestore.client", lambda app: MockDb(missing_doc))
    enforce_session_inactivity_expiry({"uid": "u2", "iat": now_ts, "auth_time": now_ts - 1000})

    # 3. Truly inactive user -> raises 401 ApiError
    stale_user_doc = MockDocRef({"uid": "u3", "lastActivityAt": ten_days_ago, "isRevoked": False})
    monkeypatch.setattr("api.core.auth.fb_firestore.client", lambda app: MockDb(stale_user_doc))
    with pytest.raises(ApiError) as exc_info:
        enforce_session_inactivity_expiry({"uid": "u3", "iat": now_ts, "auth_time": now_ts - 12 * 86400})
    assert exc_info.value.status_code == 401
    assert "7 days of inactivity" in str(exc_info.value.message)

    # 4. Token issued after revocation -> clears revocation and succeeds
    revoked_doc = MockDocRef({"uid": "u4", "isRevoked": True, "revokedAt": now_ts - 300})
    monkeypatch.setattr("api.core.auth.fb_firestore.client", lambda app: MockDb(revoked_doc))
    enforce_session_inactivity_expiry({"uid": "u4", "iat": now_ts, "auth_time": now_ts})
    assert saved_state.get("isRevoked") is False

    # 5. Token issued before revocation -> raises 401
    revoked_doc2 = MockDocRef({"uid": "u5", "isRevoked": True, "revokedAt": now_ts})
    monkeypatch.setattr("api.core.auth.fb_firestore.client", lambda app: MockDb(revoked_doc2))
    with pytest.raises(ApiError) as exc_info2:
        enforce_session_inactivity_expiry({"uid": "u5", "iat": now_ts - 300, "auth_time": now_ts - 300})
    assert exc_info2.value.status_code == 401
    assert "revoked" in str(exc_info2.value.message)

