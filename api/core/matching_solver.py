"""Global bipartite minimum-cost matching engine and assignment solvers."""
from __future__ import annotations

import collections
import math
from typing import Any, Optional

from .dispatch_config import (
    DRIVER_DECLINE_COOLDOWN_SECONDS,
    DRIVER_IDLE_CAP,
    DRIVER_IDLE_WEIGHT,
    ETA_COST_EXPONENT,
    MAX_COMPONENT_SIZE,
    PASSENGER_CANCEL_RECOVERY_PRIORITY_BOOST,
    PASSENGER_SCHEDULED_PRIORITY_BOOST,
    PASSENGER_WAIT_CAP,
    PASSENGER_WAIT_WEIGHT,
    SWAP_PASS_LIMIT,
    UNASSIGNED_PENALTY_BASE,
    UNASSIGNED_PENALTY_PER_MINUTE,
    get_eta_ceiling_for_tier,
)
from .spatial_index import SpatialGridIndex, estimate_pickup_eta_minutes, haversine_distance_km


def compute_driver_priority(idle_minutes: float, recent_declines: int = 0) -> float:
    base = min(DRIVER_IDLE_CAP, DRIVER_IDLE_WEIGHT * max(0.0, idle_minutes))
    penalty = float(recent_declines) * 1.5
    return max(0.0, base - penalty)


def compute_passenger_priority(
    wait_minutes: float,
    is_driver_cancelled: bool = False,
    is_scheduled: bool = False,
) -> float:
    base = min(PASSENGER_WAIT_CAP, PASSENGER_WAIT_WEIGHT * max(0.0, wait_minutes))
    if is_driver_cancelled:
        base += PASSENGER_CANCEL_RECOVERY_PRIORITY_BOOST
    if is_scheduled:
        base += PASSENGER_SCHEDULED_PRIORITY_BOOST
    return base


def compute_unassigned_penalty(wait_minutes: float) -> float:
    return UNASSIGNED_PENALTY_BASE + (UNASSIGNED_PENALTY_PER_MINUTE * max(0.0, wait_minutes))


def compute_edge_cost(
    eta_minutes: float,
    passenger_priority: float,
    driver_priority: float,
) -> float:
    base_eta_cost = math.pow(max(0.01, eta_minutes), ETA_COST_EXPONENT)
    return base_eta_cost - passenger_priority - driver_priority


def solve_hungarian(cost_matrix: list[list[float]]) -> list[int]:
    """Solve minimum weight bipartite matching for an N x M matrix (N <= M).

    Returns a list `matching` of length N where `matching[i]` is the column matched
    to row `i`. Implemented via the O(N^2 * M) Jonker-Volgenant shortest augmenting path method.
    """
    n = len(cost_matrix)
    if n == 0:
        return []
    m = len(cost_matrix[0])
    if n > m:
        raise ValueError("Cost matrix must have at least as many columns as rows.")

    min_val = min(min(r) for r in cost_matrix)
    if min_val < 0.0:
        offset = -min_val
        cost_matrix = [[x + offset for x in r] for r in cost_matrix]

    # 1-based indexing for Jonker-Volgenant SAP
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)
    way = [0] * (m + 1)

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [float("inf")] * (m + 1)
        used = [False] * (m + 1)

        while True:
            used[j0] = True
            i0 = p[j0]
            delta = float("inf")
            j1 = 0

            for j in range(1, m + 1):
                if not used[j]:
                    cur = cost_matrix[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j

            for j in range(0, m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta

            j0 = j1
            if p[j0] == 0:
                break

        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    ans = [-1] * n
    for j in range(1, m + 1):
        if p[j] > 0 and p[j] <= n:
            ans[p[j] - 1] = j - 1

    return ans


class BipartiteMatchingSolver:
    """Solves multi-passenger multi-driver matching per connected component."""

    def __init__(self, max_component_size: int = MAX_COMPONENT_SIZE):
        self.max_component_size = max_component_size

    def solve_component(
        self,
        passengers: list[dict[str, Any]],
        drivers: list[dict[str, Any]],
        edges: dict[tuple[int, int], dict[str, Any]],
    ) -> list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]]:
        """Solves assignment for one component.

        Returns list of tuples: (passenger, matched_driver_or_none, metadata).
        """
        num_p = len(passengers)
        num_d = len(drivers)

        if num_p == 0:
            return []

        if num_d == 0:
            return [(p, None, {"reason": "no_drivers_in_component"}) for p in passengers]

        # Use fallback if component size exceeds limit
        if num_p > self.max_component_size or num_d > self.max_component_size:
            return self._solve_greedy_with_swaps(passengers, drivers, edges)

        # Build N x (M + N) cost matrix (passengers as rows, drivers + dummy unassigned as columns)
        # Row i corresponds to passenger i
        # Column j (0 <= j < num_d) corresponds to driver j
        # Column num_d + i corresponds to passenger i's unassigned option
        num_cols = num_d + num_p
        cost_matrix: list[list[float]] = []

        for p_idx, p in enumerate(passengers):
            row: list[float] = []
            unassigned_cost = compute_unassigned_penalty(p.get("wait_minutes", 0.0))

            # Driver columns
            for d_idx, d in enumerate(drivers):
                edge = edges.get((p_idx, d_idx))
                if edge is not None:
                    row.append(edge["cost"])
                else:
                    # Invalid / out of range edge gets high prohibitive cost
                    row.append(unassigned_cost + 1000.0)

            # Dummy unassigned columns
            for dummy_idx in range(num_p):
                if dummy_idx == p_idx:
                    row.append(unassigned_cost)
                else:
                    row.append(unassigned_cost + 1000.0)

            cost_matrix.append(row)

        assignment = solve_hungarian(cost_matrix)
        results: list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]] = []

        for p_idx, matched_col in enumerate(assignment):
            p = passengers[p_idx]
            if matched_col >= 0 and matched_col < num_d:
                edge = edges.get((p_idx, matched_col))
                # Verify that it is a valid edge and cost < unassigned penalty
                if edge is not None:
                    d = drivers[matched_col]
                    results.append((p, d, edge))
                    continue
            results.append((p, None, {"reason": "unassigned_optimal"}))

        return results

    def _solve_greedy_with_swaps(
        self,
        passengers: list[dict[str, Any]],
        drivers: list[dict[str, Any]],
        edges: dict[tuple[int, int], dict[str, Any]],
    ) -> list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]]:
        """Greedy lowest-cost initial matching followed by 2-opt pairwise swaps."""
        # 1. Sort all available valid edges deterministically
        sorted_edges = []
        for (p_idx, d_idx), edge_info in edges.items():
            sorted_edges.append((edge_info["cost"], p_idx, d_idx, edge_info))
        sorted_edges.sort(key=lambda item: (item[0], item[1], item[2]))

        assigned_p: dict[int, int] = {}  # p_idx -> d_idx
        assigned_d: dict[int, int] = {}  # d_idx -> p_idx

        for cost, p_idx, d_idx, edge_info in sorted_edges:
            unassigned_p_cost = compute_unassigned_penalty(passengers[p_idx].get("wait_minutes", 0.0))
            if cost >= unassigned_p_cost:
                continue
            if p_idx not in assigned_p and d_idx not in assigned_d:
                assigned_p[p_idx] = d_idx
                assigned_d[d_idx] = p_idx

        # 2. Pairwise swap improvements (2-opt) via incident edges
        p_incident: dict[int, list[int]] = {}
        for (p_idx, d_idx) in edges:
            p_incident.setdefault(p_idx, []).append(d_idx)

        for _ in range(SWAP_PASS_LIMIT):
            improved = False
            for p1, d1 in list(assigned_p.items()):
                cost1 = edges[(p1, d1)]["cost"]
                for d2 in p_incident.get(p1, []):
                    if d2 == d1 or d2 not in assigned_d:
                        continue
                    p2 = assigned_d[d2]
                    edge_21 = edges.get((p2, d1))
                    if edge_21 is None:
                        continue
                    edge_12 = edges[(p1, d2)]
                    cost2 = edges[(p2, d2)]["cost"]
                    new_total = edge_12["cost"] + edge_21["cost"]
                    old_total = cost1 + cost2
                    if new_total < old_total - 1e-4:
                        assigned_p[p1] = d2
                        assigned_p[p2] = d1
                        assigned_d[d1] = p2
                        assigned_d[d2] = p1
                        improved = True
                        break
                if improved:
                    break
            if not improved:
                break

        results: list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]] = []
        for p_idx, p in enumerate(passengers):
            if p_idx in assigned_p:
                d_idx = assigned_p[p_idx]
                d = drivers[d_idx]
                edge_info = edges[(p_idx, d_idx)]
                results.append((p, d, edge_info))
            else:
                results.append((p, None, {"reason": "unassigned_greedy"}))

        return results


def build_candidate_graph_and_solve(
    passengers: list[dict[str, Any]],
    drivers: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]]:
    """Decomposes the global passenger-driver graph into connected components and solves each."""
    if not passengers:
        return []
    if not drivers:
        return [(p, None, {"reason": "no_available_drivers"}) for p in passengers]

    # Deterministic sorting of inputs
    sorted_passengers = sorted(
        passengers,
        key=lambda p: (-float(p.get("wait_minutes", 0.0)), str(p.get("request_id", ""))),
    )
    sorted_drivers = sorted(
        drivers,
        key=lambda d: (-float(d.get("idle_minutes", 0.0)), str(d.get("driver_id", ""))),
    )

    # 1. Build spatial index and precompute priorities for drivers
    driver_grid = SpatialGridIndex(cell_size_km=2.0)
    driver_priorities = [
        compute_driver_priority(
            idle_minutes=float(d.get("idle_minutes", 0.0)),
            recent_declines=int(d.get("declines_recent", 0)),
        )
        for d in sorted_drivers
    ]
    for d_idx, d in enumerate(sorted_drivers):
        d_lat = float(d["location"]["lat"])
        d_lng = float(d["location"]["lng"])
        driver_grid.insert(str(d_idx), d_lat, d_lng, {"d_idx": d_idx, "driver": d})

    # 2. Build adjacency and edge costs
    p_adj: dict[int, list[int]] = {i: [] for i in range(len(sorted_passengers))}
    d_adj: dict[int, list[int]] = {j: [] for j in range(len(sorted_drivers))}
    edges: dict[tuple[int, int], dict[str, Any]] = {}

    speed_kpm = 30.0 / 60.0  # DEFAULT_SPEED_KMH / 60.0

    for p_idx, p in enumerate(sorted_passengers):
        p_lat = float(p["pickup"]["lat"])
        p_lng = float(p["pickup"]["lng"])
        p_radius_km = float(p.get("current_radius_km", 2.0))
        p_tier = int(p.get("tier", 0))
        eta_ceiling = get_eta_ceiling_for_tier(p_tier)
        p_excluded = set(p.get("excluded_driver_ids") or [])
        p_vehicle = str(p.get("vehicle_type", "auto")).lower()
        p_priority = compute_passenger_priority(
            wait_minutes=float(p.get("wait_minutes", 0.0)),
            is_driver_cancelled=bool(p.get("was_driver_cancelled", False)),
            is_scheduled=bool(p.get("is_scheduled", False)),
        )

        nearby_drivers = driver_grid.query_radius(p_lat, p_lng, p_radius_km)
        for cand in nearby_drivers:
            d_idx = cand["payload"]["d_idx"]
            d = cand["payload"]["driver"]
            driver_id = str(d["driver_id"])
            if driver_id in p_excluded:
                continue

            d_vehicle = str(d.get("vehicle_type", "auto")).lower()
            if p_vehicle != "any" and p_vehicle != d_vehicle:
                continue

            dist_km = cand["distance_km"]
            if dist_km > p_radius_km + 0.05:
                continue
            eta_min = (dist_km * 1.3) / speed_kpm
            if eta_min > eta_ceiling:
                continue

            d_priority = driver_priorities[d_idx]
            cost = compute_edge_cost(eta_min, p_priority, d_priority)

            p_adj[p_idx].append(d_idx)
            d_adj[d_idx].append(p_idx)
            edges[(p_idx, d_idx)] = {
                "distance_km": dist_km,
                "eta_minutes": eta_min,
                "passenger_priority": p_priority,
                "driver_priority": d_priority,
                "cost": cost,
            }

    # 3. Partition into connected components using BFS
    visited_p: set[int] = set()
    visited_d: set[int] = set()
    components: list[tuple[list[int], list[int]]] = []

    for start_p in range(len(sorted_passengers)):
        if start_p in visited_p:
            continue
        comp_p = [start_p]
        comp_d: list[int] = []
        visited_p.add(start_p)
        queue = collections.deque([("p", start_p)])

        while queue:
            node_type, idx = queue.popleft()
            if node_type == "p":
                for neighbor_d in p_adj[idx]:
                    if neighbor_d not in visited_d:
                        visited_d.add(neighbor_d)
                        comp_d.append(neighbor_d)
                        queue.append(("d", neighbor_d))
            else:
                for neighbor_p in d_adj[idx]:
                    if neighbor_p not in visited_p:
                        visited_p.add(neighbor_p)
                        comp_p.append(neighbor_p)
                        queue.append(("p", neighbor_p))

        components.append((comp_p, comp_d))

    # 3. Solve each component
    solver = BipartiteMatchingSolver()
    all_results: list[tuple[dict[str, Any], Optional[dict[str, Any]], dict[str, Any]]] = []

    for comp_p_indices, comp_d_indices in components:
        comp_passengers = [sorted_passengers[i] for i in comp_p_indices]
        comp_drivers = [sorted_drivers[j] for j in comp_d_indices]

        # Re-index edges for sub-matrix
        p_map = {orig_p: sub_p for sub_p, orig_p in enumerate(comp_p_indices)}
        d_map = {orig_d: sub_d for sub_d, orig_d in enumerate(comp_d_indices)}

        sub_edges: dict[tuple[int, int], dict[str, Any]] = {}
        for orig_p in comp_p_indices:
            for orig_d in comp_d_indices:
                if (orig_p, orig_d) in edges:
                    sub_edges[(p_map[orig_p], d_map[orig_d])] = edges[(orig_p, orig_d)]

        comp_results = solver.solve_component(comp_passengers, comp_drivers, sub_edges)
        all_results.extend(comp_results)

    return all_results
