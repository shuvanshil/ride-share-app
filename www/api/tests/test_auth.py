from api.core.auth import extract_bearer_token
from fastapi.testclient import TestClient

from api.index import app


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
