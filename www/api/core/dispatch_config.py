from __future__ import annotations

import json
import os
from typing import Any, Optional
from pydantic import BaseModel, Field

from .config import get_env

CONFIG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "config"))


import logging

logger = logging.getLogger(__name__)

class DispatchConfig(BaseModel):
    lla_enforce: bool = Field(default=False)
    require_dropoff_inside: bool = Field(default=True)
    offer_timeout_seconds: int = Field(default=15, ge=5, le=60)
    location_freshness_seconds: int = Field(default=60, ge=10, le=300)
    max_location_age_seconds_with_push: int = Field(default=600, ge=60, le=3600)
    batch_hold_ms: int = Field(default=1500, ge=0, le=10000)
    expand_after_seconds: int = Field(default=20, ge=5, le=120)
    max_pickup_eta_minutes: float = Field(default=25.0, ge=1.0, le=120.0)
    hard_max_pickup_eta_minutes: float = Field(default=40.0, ge=1.0, le=120.0)
    candidates_k: int = Field(default=8, ge=1, le=50)
    cost_exponent_alpha: float = Field(default=1.0, ge=1.0, le=3.0)
    aging_weight_gamma: float = Field(default=0.0, ge=0.0, le=1.0)
    cheap_road_factor: float = Field(default=1.4, ge=1.0, le=2.5)
    cheap_speed_kmh: float = Field(default=22.0, ge=5.0, le=100.0)
    route_matrix_timeout_ms: int = Field(default=300, ge=50, le=3000)
    max_exact_size: int = Field(default=60, ge=5, le=500)
    exact_solver_timeout_ms: int = Field(default=400, ge=50, le=2000)
    profile: Optional[str] = Field(default=None)


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
    env_lla = (get_env("LLA_ENFORCE") or "").strip().lower() in ("true", "1", "yes")

    config_data: dict[str, Any] = {
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
            # Normalize camelCase and nested LLA keys
            if "lla_enforce" in data:
                config_data["lla_enforce"] = bool(data["lla_enforce"])
            elif "llaEnforce" in data:
                config_data["lla_enforce"] = bool(data["llaEnforce"])
            elif isinstance(data.get("lla"), dict) and "enforce" in data["lla"]:
                config_data["lla_enforce"] = bool(data["lla"]["enforce"])

            if "require_dropoff_inside" in data:
                config_data["require_dropoff_inside"] = bool(data["require_dropoff_inside"])
            elif "requireDropoffInside" in data:
                config_data["require_dropoff_inside"] = bool(data["requireDropoffInside"])

            if "maxPickupEtaMinutes" in data:
                config_data["max_pickup_eta_minutes"] = float(data["maxPickupEtaMinutes"])
            if "hardMaxPickupEtaMinutes" in data:
                config_data["hard_max_pickup_eta_minutes"] = float(data["hardMaxPickupEtaMinutes"])
            if "offerTimeoutSeconds" in data:
                config_data["offer_timeout_seconds"] = int(data["offerTimeoutSeconds"])
            if "locationFreshnessSeconds" in data:
                config_data["location_freshness_seconds"] = int(data["locationFreshnessSeconds"])
            if "maxLocationAgeSecondsWithPush" in data:
                config_data["max_location_age_seconds_with_push"] = int(data["maxLocationAgeSecondsWithPush"])
            if "profile" in data:
                config_data["profile"] = str(data["profile"])

            valid_fields = set(DispatchConfig.model_fields.keys())
            for k, v in data.items():
                if k in ("algorithm", "dispatch_algorithm", "dispatchAlgorithm"):
                    logger.warning("Ignoring deprecated dispatch configuration key '%s' (hex_batch is permanent)", k)
                    continue
                if k in valid_fields and k not in config_data and v is not None:
                    config_data[k] = v
                elif k not in valid_fields and k not in ("lla", "llaEnforce", "requireDropoffInside", "maxPickupEtaMinutes", "hardMaxPickupEtaMinutes", "offerTimeoutSeconds", "locationFreshnessSeconds", "maxLocationAgeSecondsWithPush"):
                    logger.warning("Ignoring unknown dispatch configuration key: %s", k)
    except Exception:
        pass

    try:
        _CACHED_DISPATCH_CONFIG = DispatchConfig(**config_data)
    except Exception:
        _CACHED_DISPATCH_CONFIG = DispatchConfig(lla_enforce=env_lla)

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
