"""Bipartite candidate graph edge generation."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from ..config import WEIGHTS, DispatchWeights
from .cost import compute_pairing_cost
from .detour import compute_detour_penalty
from .eligibility import check_eligibility
from .plan import DriverEntry, PassengerEntry


@dataclass
class CandidateEdge:
    """Directed edge in the bipartite matching graph from passenger to driver."""
    passenger_idx: int
    driver_idx: int
    passenger_id: str
    driver_id: str
    cost: float
    eta_minutes: float
    detour_minutes: float = 0.0
    route_stops: list[dict[str, Any]] = field(default_factory=list)


def build_candidate_edges(
    passengers: list[PassengerEntry],
    drivers: list[DriverEntry],
    now: float,
    weights: DispatchWeights = WEIGHTS,
    detour_map: Optional[dict[tuple[str, str], float]] = None,
) -> list[CandidateEdge]:
    """Evaluate all passenger-driver pairs and return valid candidate edges with computed costs."""
    detour_map = detour_map or {}
    edges: list[CandidateEdge] = []

    for p_idx, p in enumerate(passengers):
        for d_idx, d in enumerate(drivers):
            detour_min = detour_map.get((p.id, d.id), 0.0)
            route_stops: list[dict[str, Any]] = []
            pickup_eta: Optional[float] = None

            if d.is_share:
                # If explicit detour_map is provided, use it; otherwise compute optimal stop insertion
                if (p.id, d.id) in detour_map:
                    detour_min = detour_map[(p.id, d.id)]
                else:
                    detour_res = compute_detour_penalty(p, d)
                    if detour_res is None:
                        continue
                    detour_min, pickup_eta, route_stops = detour_res

            eligible, _reason, eta = check_eligibility(
                passenger=p,
                driver=d,
                now=now,
                detour_minutes=detour_min,
                pickup_eta=pickup_eta,
            )
            if not eligible:
                continue

            cost = compute_pairing_cost(
                passenger=p,
                driver=d,
                now=now,
                eta_minutes=eta,
                detour_minutes=detour_min,
                weights=weights,
            )

            edges.append(
                CandidateEdge(
                    passenger_idx=p_idx,
                    driver_idx=d_idx,
                    passenger_id=p.id,
                    driver_id=d.id,
                    cost=cost,
                    eta_minutes=eta,
                    detour_minutes=detour_min,
                    route_stops=route_stops,
                )
            )

    return edges
