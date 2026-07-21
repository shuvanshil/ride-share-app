import asyncio

import pytest

from api.core import google_client
from api.core.errors import ApiError


def test_google_provider_error_does_not_expose_response_payload(monkeypatch) -> None:
    class FakeResponse:
        is_error = True
        status_code = 403

        def json(self):
            return {"error": {"message": "private Google diagnostic"}}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def request(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(google_client.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    with pytest.raises(ApiError) as caught:
        asyncio.run(google_client.fetch_json("https://provider.invalid"))

    assert caught.value.status_code == 502
    assert caught.value.message == "Google provider request failed."
    assert caught.value.extra == {}
