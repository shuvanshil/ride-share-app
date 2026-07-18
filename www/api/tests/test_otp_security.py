from fastapi.testclient import TestClient
import pytest

from api.core.errors import ApiError
from api.index import app
from api.routers import otp as otp_router


def test_send_otp_returns_rate_limit_without_provider_details(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)

    def reject_send(*_args, **_kwargs):
        raise ApiError("Please wait before requesting another OTP.", 429)

    monkeypatch.setattr(otp_router, "reserve_otp_send", reject_send)

    response = TestClient(app).post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "register"},
    )

    assert response.status_code == 429
    assert response.json() == {"error": "Please wait before requesting another OTP."}


def test_otp_provider_failure_does_not_expose_provider_response(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)

    async def provider_response(_url):
        return {"Status": "Error", "Details": "internal provider diagnostic"}

    monkeypatch.setattr(otp_router, "reserve_otp_send", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(otp_router, "require_env", lambda _name: "test-key")
    monkeypatch.setattr(otp_router, "fetch_two_factor_json", provider_response)

    response = TestClient(app).post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "register"},
    )

    assert response.status_code == 502
    assert response.json() == {"error": "Could not send OTP."}


def test_unexpected_otp_error_does_not_expose_exception_details(monkeypatch) -> None:
    monkeypatch.setattr(otp_router, "enforce_rate_limit", lambda *_args, **_kwargs: None)

    def unexpected_failure(*_args, **_kwargs):
        raise RuntimeError("firestore credential detail")

    monkeypatch.setattr(otp_router, "reserve_otp_send", unexpected_failure)

    response = TestClient(app).post(
        "/api/send-otp",
        json={"phone": "9436332301", "purpose": "register"},
    )

    assert response.status_code == 500
    assert response.json() == {"error": "Could not send OTP. Please try again."}


def test_otp_provider_http_error_does_not_expose_provider_payload(monkeypatch) -> None:
    from api.core import otp as otp_core

    class FakeResponse:
        is_error = True
        status_code = 503

        def json(self):
            return {"Status": "Error", "Details": "private provider diagnostic"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(otp_core.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    with pytest.raises(ApiError) as caught:
        import asyncio
        asyncio.run(otp_core.fetch_two_factor_json("https://provider.invalid"))

    assert caught.value.status_code == 502
    assert caught.value.message == "OTP provider request failed."
    assert caught.value.extra == {}
