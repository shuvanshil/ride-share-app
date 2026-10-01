from __future__ import annotations

import json
import os
from typing import Any
from pydantic import BaseModel, Field

from .config import get_env

CONFIG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "config"))


class DispatchConfig(BaseModel):
    algorithm: str = Field(default="legacy")
    lla_enforce: bool = Field(default=False)
    require_dropoff_inside: bool = Field(default=True)
    offer_timeout_seconds: int = Field(default=15, ge=5, le=60)
    location_freshness_seconds: int = Field(default=30, ge=10, le=300)
    batch_hold_ms: int = Field(default=1500, ge=0, le=10000)
    expand_after_seconds: int = Field(default=20, ge=5, le=120)
    max_pickup_eta_minutes: float = Field(default=25.0, ge=1.0, le=120.0)
    candidates_k: int = Field(default=8, ge=1, le=50)
    cost_exponent_alpha: float = Field(default=1.0, ge=1.0, le=3.0)
    aging_weight_gamma: float = Field(default=0.0, ge=0.0, le=1.0)
    cheap_road_factor: float = Field(default=1.4, ge=1.0, le=2.5)
    cheap_speed_kmh: float = Field(default=22.0, ge=5.0, le=100.0)
    route_matrix_timeout_ms: int = Field(default=300, ge=50, le=3000)
    max_exact_size: int = Field(default=60, ge=5, le=500)
    exact_solver_timeout_ms: int = Field(default=400, ge=50, le=2000)


import time

_CONFIG_CACHE_TIME = 0.0
_CACHED_DISPATCH_CONFIG: DispatchConfig | None = None
_CACHE_TTL_SECONDS = 10.0


def load_dispatch_config(force_refresh: bool = False) -> DispatchConfig:
    global _CONFIG_CACHE_TIME, _CACHED_DISPATCH_CONFIG
    now = time.time()
    if not force_refresh and _CACHED_DISPATCH_CONFIG is not None and (now - _CONFIG_CACHE_TIME) < _CACHE_TTL_SECONDS:
        return _CACHED_DISPATCH_CONFIG

    # 1. Base from Environment Variables
    env_algo = get_env("DISPATCH_ALGORITHM") or "legacy"
    env_lla = (get_env("LLA_ENFORCE") or "").strip().lower() in ("true", "1", "yes")

    config_data: dict[str, Any] = {
        "algorithm": env_algo,
        "lla_enforce": env_lla,
    }

    # 2. Check Firestore systemSettings/dispatch for runtime dynamic overrides
    try:
        from .firebase import get_admin_app
        from firebase_admin import firestore as fb_firestore

        db = fb_firestore.client(get_admin_app())
        doc = db.collection("systemSettings").document("dispatch").get()
        if doc.exists:
            data = doc.to_dict() or {}
            for k, v in data.items():
                if v is not None:
                    config_data[k] = v
    except Exception:
        pass

    try:
        _CACHED_DISPATCH_CONFIG = DispatchConfig(**config_data)
    except Exception:
        _CACHED_DISPATCH_CONFIG = DispatchConfig(algorithm=env_algo, lla_enforce=env_lla)

    _CONFIG_CACHE_TIME = now
    return _CACHED_DISPATCH_CONFIG


def load_lla_config() -> dict[str, Any]:
    path = os.path.join(CONFIG_DIR, "lla.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def load_zones_config() -> dict[str, Any]:
    path = os.path.join(CONFIG_DIR, "zones.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}
