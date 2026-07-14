from api.core.auth import extract_bearer_token


def test_extract_bearer_token_accepts_case_insensitive_scheme() -> None:
    assert extract_bearer_token("bearer abc123") == "abc123"


def test_extract_bearer_token_rejects_malformed_header() -> None:
    assert extract_bearer_token(None) == ""
    assert extract_bearer_token("Basic abc123") == ""
    assert extract_bearer_token("Bearer") == ""

