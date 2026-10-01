"""Pure-Python Bipartite Matching Solver and Cost Model for Batch Dispatch."""
from __future__ import annotations

import itertools
import math
import time
from typing import Any, Optional

LARGE_M = 1_000_000.0


def compute_pair_cost(
    eta_minutes: float,
    waiting_minutes: float = 0.0,
    alpha: float = 1.0,
    gamma: float = 0.0,
) -> float:
    """Cost function: w_p * (ETA ^ alpha), where w_p = 1 + gamma * waiting_minutes."""
    w_p = 1.0 + gamma * max(0.0, waiting_minutes)
    return w_p * (max(0.1, eta_minutes) ** alpha)


def hungarian_min_cost(matrix: list[list[float]]) -> list[int]:
    """Pure-Python Hungarian (Munkres / Jonker-Volgenant) algorithm for minimum-cost matching.

    Args:
        matrix: N x M cost matrix (N rows / workers, M cols / jobs, N <= M).
    Returns:
        List of length N where result[i] is the assigned column index for row i.
    """
    if not matrix:
        return []
    n = len(matrix)
    m = len(matrix[0])
    if n > m:
        raise ValueError("Hungarian solver requires N <= M rows/cols.")

    # 1-indexed Jonker-Volgenant/Hungarian implementation
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
                    cur = matrix[i0 - 1][j - 1] - u[i0] - v[j]
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
        if p[j] > 0:
            ans[p[j] - 1] = j - 1
    return ans


def brute_force_min_cost(matrix: list[list[float]]) -> tuple[list[int], float]:
    """Brute force solver for small matrices (N <= M) used in test verification."""
    n = len(matrix)
    m = len(matrix[0])
    best_cost = float("inf")
    best_assignment = [-1] * n

    for perm in itertools.permutations(range(m), n):
        cost = sum(matrix[i][perm[i]] for i in range(n))
        if cost < best_cost:
            best_cost = cost
            best_assignment = list(perm)

    return best_assignment, best_cost


def solve_greedy_regret(
    rides: list[dict[str, Any]],
    candidate_map: dict[str, list[tuple[str, float]]],
) -> dict[str, Optional[str]]:
    """Greedy regret fallback solver: O(R * K log R).

    Repeatedly assigns the ride with highest regret (difference between
    second-best available driver cost and best available driver cost)
    to its best available driver.
    """
    assigned_drivers: set[str] = set()
    proposals: dict[str, Optional[str]] = {r["id"]: None for r in rides}
    unassigned_ride_ids = set(r["id"] for r in rides)

    while unassigned_ride_ids:
        best_ride_id = None
        max_regret = -float("inf")
        best_driver_for_ride = None

        for r_id in unassigned_ride_ids:
            # Filter available candidates
            cands = [
                (d_id, cost)
                for d_id, cost in candidate_map.get(r_id, [])
                if d_id not in assigned_drivers
            ]
            if not cands:
                continue

            cands.sort(key=lambda item: item[1])
            best_driver = cands[0][0]
            best_cost = cands[0][1]

            if len(cands) == 1:
                regret = best_cost + 100.0  # High urgency if only 1 driver remains
            else:
                regret = cands[1][1] - best_cost

            if regret > max_regret:
                max_regret = regret
                best_ride_id = r_id
                best_driver_for_ride = best_driver

        if best_ride_id is None or best_driver_for_ride is None:
            break

        proposals[best_ride_id] = best_driver_for_ride
        assigned_drivers.add(best_driver_for_ride)
        unassigned_ride_ids.remove(best_ride_id)

    return proposals


def solve_batch_matching(
    rides: list[dict[str, Any]],
    candidate_map: dict[str, list[tuple[str, float]]],
    max_exact_size: int = 60,
    time_budget_ms: int = 400,
) -> dict[str, Optional[str]]:
    """Solves batch assignment for rides and candidate drivers.

    Splits into connected components (rides sharing drivers).
    Solo components use fast path.
    Contested components solve Hungarian min-cost assignment with dummy padding.
    Falls back to regret greedy if component exceeds max_exact_size or budget.
    """
    if not rides:
        return {}

    # Union-Find to partition into independent connected components
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        if parent.setdefault(x, x) != x:
            parent[x] = find(parent[x])
        return parent[x]

    def union(x: str, y: str):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for r in rides:
        r_id = r["id"]
        find(r_id)
        for d_id, _ in candidate_map.get(r_id, []):
            union(r_id, f"driver_{d_id}")

    # Group rides by component root
    components: dict[str, list[dict[str, Any]]] = {}
    for r in rides:
        root = find(r["id"])
        components.setdefault(root, []).append(r)

    proposals: dict[str, Optional[str]] = {}
    start_time = time.time()

    for comp_rides in components.values():
        if len(comp_rides) == 1:
            # Fast path: solo ride
            r = comp_rides[0]
            cands = candidate_map.get(r["id"], [])
            if cands:
                best_d = min(cands, key=lambda item: item[1])[0]
                proposals[r["id"]] = best_d
            else:
                proposals[r["id"]] = None
            continue

        # Check safety valve thresholds
        elapsed_ms = (time.time() - start_time) * 1000.0
        if len(comp_rides) > max_exact_size or elapsed_ms > time_budget_ms:
            comp_props = solve_greedy_regret(comp_rides, candidate_map)
            proposals.update(comp_props)
            continue

        # Build exact bipartite cost matrix
        all_drivers = list(set(
            d_id
            for r in comp_rides
            for d_id, _ in candidate_map.get(r["id"], [])
        ))

        nr = len(comp_rides)
        nd = len(all_drivers)
        # Pad with dummy columns so total columns = nd + nr, ensuring square/rectangular N <= M
        total_cols = nd + nr
        cost_matrix: list[list[float]] = []

        driver_idx_map = {d_id: idx for idx, d_id in enumerate(all_drivers)}

        for r in comp_rides:
            row = [LARGE_M * 2] * nd + [LARGE_M] * nr
            # Set real costs for candidate drivers
            for d_id, cost in candidate_map.get(r["id"], []):
                if d_id in driver_idx_map:
                    row[driver_idx_map[d_id]] = cost
            cost_matrix.append(row)

        try:
            assignment = hungarian_min_cost(cost_matrix)
            for r_idx, col_idx in enumerate(assignment):
                r_id = comp_rides[r_idx]["id"]
                if col_idx < nd and cost_matrix[r_idx][col_idx] < LARGE_M:
                    proposals[r_id] = all_drivers[col_idx]
                else:
                    proposals[r_id] = None
        except Exception:
            comp_props = solve_greedy_regret(comp_rides, candidate_map)
            proposals.update(comp_props)

    return proposals
