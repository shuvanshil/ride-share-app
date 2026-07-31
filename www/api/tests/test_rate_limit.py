from fastapi import Request

from api.core import rate_limit


def test_rate_limit_key_is_hmac_and_does_not_contain_raw_address(monkeypatch) -> None:
    monkeypatch.setattr(rate_limit, "require_env", lambda _name: "test-secret")

    key = rate_limit.rate_limit_key("google-route", "203.0.113.10")

    assert key != "203.0.113.10"
    assert len(key) == 64
    assert key == rate_limit.rate_limit_key("google-route", "203.0.113.10")


def test_client_address_prefers_forwarded_edge_address() -> None:
    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(b"x-forwarded-for", b"203.0.113.10, 10.0.0.1")],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "scheme": "http",
    })

    assert rate_limit.client_address(request) == "203.0.113.10"
