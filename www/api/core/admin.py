"""Compatibility shim for admin helpers now isolated under admin_console."""
from __future__ import annotations

from admin_console.api.core.admin import now_utc, require_admin, write_audit_log  # noqa: F401
