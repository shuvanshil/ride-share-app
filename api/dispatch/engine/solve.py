"""Global dispatch solver executing Hungarian bipartite assignment with dummy columns."""
from __future__ import annotations

import time
from typing import Optional

from ..config import (
    DUMMY_UNASSIGNED_COST_PENALTY,
    MAX_COMPONENT_PAX,
    RUN_TIME_BUDGET_MS,
    WEIGHTS,
    DispatchWeights,
)
from .components import decompose_components
from .edges import build_candidate_edges
from .hungarian import hungarian_min_cost
from .plan import Assignment, DispatchPlan, DriverEntry, PassengerEntry


INELIGIBLE_COST_PENALTY = 1_000_000.0


def solve_dispatch(
    passengers: list[PassengerEntry],
    drivers: list[DriverEntry],
    now: Optional[float] = None,
    weights: DispatchWeights = WEIGHTS,
    detour_map: Optional[dict[tuple[str, str], float]] = None,
    time_budget_ms: float = RUN_TIME_BUDGET_MS,
) -> DispatchPlan:
    """Solve the global minimum-cost passenger-driver assignment problem.
    
    Uses pure Python rectangular Kuhn-Munkres (Hungarian) matching with dummy columns
    so passengers without a viable or cost-effective driver stay unassigned.
    Enforces MAX_COMPONENT_PAX and RUN_TIME_BUDGET_MS caps.
    """
    start_time = time.perf_counter()
    if now is None:
        now = time.time()

    # Filter to visible entries (WAITING passengers and IDLE / SHARE_OPEN / SHARE drivers)
    active_passengers = [p for p in passengers if p.state == "WAITING"]
    active_drivers = [d for d in drivers if (d.state in ("IDLE", "SHARE_OPEN", "SHARE") or d.pool in ("IDLE", "SHARE")) and d.is_approved]

    if not active_passengers or not active_drivers:
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return DispatchPlan(
            assignments=[],
            unassigned_passengers=[p.id for p in active_passengers],
            unassigned_drivers=[d.id for d in active_drivers],
            total_cost=0.0,
            execution_ms=round(elapsed_ms, 2),
            hit_budget=False,
        )

    # Build candidate edges
    candidate_edges = build_candidate_edges(
        passengers=active_passengers,
        drivers=active_drivers,
        now=now,
        weights=weights,
        detour_map=detour_map,
    )

    if not candidate_edges:
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        return DispatchPlan(
            assignments=[],
            unassigned_passengers=[p.id for p in active_passengers],
            unassigned_drivers=[d.id for d in active_drivers],
            total_cost=0.0,
            execution_ms=round(elapsed_ms, 2),
            hit_budget=False,
        )

    # Decompose into connected components
    components, isolated_p_indices, isolated_d_indices = decompose_components(
        num_passengers=len(active_passengers),
        num_drivers=len(active_drivers),
        edges=candidate_edges,
    )

    all_assignments: list[Assignment] = []
    assigned_passenger_indices: set[int] = set()
    assigned_driver_indices: set[int] = set()
    total_cost_accum = 0.0
    hit_budget = False

    for comp in components:
        # Check run time budget before each component
        if (time.perf_counter() - start_time) * 1000.0 >= time_budget_ms:
            hit_budget = True
            break

        comp_n_p = len(comp.passenger_indices)
        comp_n_d = len(comp.driver_indices)

        if comp_n_p == 0 or comp_n_d == 0 or not comp.edges:
            continue

        # Enforce MAX_COMPONENT_PAX cap: prioritize oldest waiting passengers
        if comp_n_p > MAX_COMPONENT_PAX:
            sorted_p = sorted(comp.passenger_indices, key=lambda idx: active_passengers[idx].req_time)
            capped_p_set = set(sorted_p[:MAX_COMPONENT_PAX])
            active_comp_p_indices = [idx for idx in comp.passenger_indices if idx in capped_p_set]
            active_comp_edges = [e for e in comp.edges if e.passenger_idx in capped_p_set]
            comp_n_p = len(active_comp_p_indices)
        else:
            active_comp_p_indices = comp.passenger_indices
            active_comp_edges = comp.edges

        # Map global indices to component local indices
        p_global_to_local = {g_idx: l_idx for l_idx, g_idx in enumerate(active_comp_p_indices)}
        d_global_to_local = {g_idx: l_idx for l_idx, g_idx in enumerate(comp.driver_indices)}

        # Edge lookup and max edge cost for dummy columns
        comp_edge_map = {}
        max_edge_cost = -float("inf")
        for e in active_comp_edges:
            l_p = p_global_to_local.get(e.passenger_idx)
            l_d = d_global_to_local.get(e.driver_idx)
            if l_p is None or l_d is None:
                continue
            comp_edge_map[(l_p, l_d)] = e
            if e.cost > max_edge_cost:
                max_edge_cost = e.cost

        # Dummy column cost set slightly above worst edge
        dummy_cost = max(max_edge_cost + 10.0, 50.0)

        # Build cost matrix:
        # Rows: comp_n_p
        # Cols: comp_n_d real driver cols + comp_n_p dummy cols
        total_cols = comp_n_d + comp_n_p
        matrix: list[list[float]] = []

        for l_p in range(comp_n_p):
            row = [INELIGIBLE_COST_PENALTY] * total_cols
            # Real driver columns
            for l_d in range(comp_n_d):
                edge = comp_edge_map.get((l_p, l_d))
                if edge is not None:
                    row[l_d] = edge.cost
            # Dummy column corresponding to this passenger
            row[comp_n_d + l_p] = dummy_cost
            matrix.append(row)

        row_assignment, _ = hungarian_min_cost(matrix)

        for l_p, col in enumerate(row_assignment):
            if col == -1 or col >= comp_n_d:
                # Assigned to dummy column -> remains unassigned
                continue

            # Assigned to real driver column
            l_d = col
            edge = comp_edge_map.get((l_p, l_d))
            if edge is None or matrix[l_p][l_d] >= INELIGIBLE_COST_PENALTY:
                continue

            g_p_idx = active_comp_p_indices[l_p]
            g_d_idx = comp.driver_indices[l_d]

            assigned_passenger_indices.add(g_p_idx)
            assigned_driver_indices.add(g_d_idx)
            total_cost_accum += edge.cost

            all_assignments.append(
                Assignment(
                    passenger_id=active_passengers[g_p_idx].id,
                    driver_id=active_drivers[g_d_idx].id,
                    cost=round(edge.cost, 4),
                    eta_minutes=round(edge.eta_minutes, 2),
                    detour_minutes=round(edge.detour_minutes, 2),
                    fare=round(active_passengers[g_p_idx].fare, 2),
                    timestamp=now,
                    route_stops=getattr(edge, "route_stops", []),
                )
            )

    unassigned_passengers = [
        active_passengers[i].id
        for i in range(len(active_passengers))
        if i not in assigned_passenger_indices
    ]
    unassigned_drivers = [
        active_drivers[i].id
        for i in range(len(active_drivers))
        if i not in assigned_driver_indices
    ]

    elapsed_ms = (time.perf_counter() - start_time) * 1000.0
    return DispatchPlan(
        assignments=all_assignments,
        unassigned_passengers=unassigned_passengers,
        unassigned_drivers=unassigned_drivers,
        total_cost=round(total_cost_accum, 4),
        execution_ms=round(elapsed_ms, 2),
        hit_budget=hit_budget,
    )
