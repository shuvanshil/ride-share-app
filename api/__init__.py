"""
Compatibility module bridging 'api.*' imports to 'backend.*'.

Ensures that any existing tests or references to 'api.routers', 'api.core', etc.
continue to function identically while keeping the actual modules outside the 'api/'
folder to satisfy Vercel's Serverless Function count limit (<= 12 on Hobby plan).
"""
from __future__ import annotations

import importlib
import pkgutil
import sys
from pathlib import Path

_API_DIR = Path(__file__).resolve().parent
_ROOT_DIR = _API_DIR.parent
if str(_ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(_ROOT_DIR))

import backend

# Recursively register all backend submodules under api.* in sys.modules
for importer, modname, ispkg in pkgutil.walk_packages(backend.__path__, prefix="backend."):
    api_name = "api." + modname[len("backend."):]
    try:
        mod = importlib.import_module(modname)
        sys.modules[api_name] = mod
    except Exception:
        pass

import backend.core as core
import backend.dispatch as dispatch
import backend.routers as routers
import backend.services as services

sys.modules["api.core"] = core
sys.modules["api.dispatch"] = dispatch
sys.modules["api.routers"] = routers
sys.modules["api.services"] = services

from .index import app

__all__ = ["app", "core", "dispatch", "routers", "services"]
