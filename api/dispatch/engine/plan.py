"""Data models and plan objects for pure dispatch matching."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class PassengerEntry:
    """Passenger representation in the waiting pool."""
    id: str
    pickup: tuple[float, float]
    drop: tuple[float, float]
    req_time: float                          # unix timestamp in seconds
    wants_share: bool = False
    seats: int = 1
    fare: float = 0.0
    banned: set[str] = field(default_factory=set)
    state: str = "WAITING"                   # WAITING | OFFERED
    version: int = 1
    vehicle_type: str = "auto"               # bike | auto | any
    mode: str = "auto"                       # auto | notify_only | schedule
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DriverEntry:
    """Driver representation in the available driver pool."""
    id: str
    loc: tuple[float, float]
    cell: str = ""
    state: str = "IDLE"                      # IDLE | SHARE_OPEN | SHARE | BUSY | OFFERED
    pool: str = "IDLE"                       # IDLE | SHARE | BUSY | OFFERED
    idle_since: float = 0.0                  # unix timestamp in seconds
    seats_free: int = 1
    route: list[dict[str, Any]] = field(default_factory=list)
    last_seen: float = 0.0                   # unix timestamp in seconds
    version: int = 1
    vehicle_type: str = "auto"               # bike | auto
    is_approved: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def is_share(self) -> bool:
        return self.pool == "SHARE" or self.state in ("SHARE_OPEN", "SHARE") or (self.seats_free > 0 and self.vehicle_type == "auto" and bool(self.route))

    @property
    def route_stops(self) -> list[dict[str, Any]]:
        return self.route


@dataclass
class Assignment:
    """Paired passenger-driver assignment outcome."""
    passenger_id: str
    driver_id: str
    cost: float
    eta_minutes: float
    detour_minutes: float = 0.0
    fare: float = 0.0
    timestamp: float = 0.0
    route_stops: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DispatchPlan:
    """Complete global solution plan produced by dispatch matching."""
    assignments: list[Assignment] = field(default_factory=list)
    unassigned_passengers: list[str] = field(default_factory=list)
    unassigned_drivers: list[str] = field(default_factory=list)
    total_cost: float = 0.0
    execution_ms: float = 0.0
    hit_budget: bool = False
