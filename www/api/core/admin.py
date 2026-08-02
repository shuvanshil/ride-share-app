"""Compatibility shim for admin helpers now isolated under admin_console."""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from admin_console.api.core.admin import now_utc, require_admin, write_audit_log  # noqa: E402,F401
