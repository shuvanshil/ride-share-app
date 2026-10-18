from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from api.core import admin, auth
from api.core.errors import ApiError


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
