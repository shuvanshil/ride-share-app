"""Pure Python Rectangular Kuhn-Munkres (Hungarian) minimum-weight assignment.

Zero external dependencies (no numpy, no scipy).
Time complexity: O(min(n, m)^2 * max(n, m)).
Handles arbitrary real costs (positive, negative, zero) and rectangular matrices.
"""
from __future__ import annotations


def hungarian_min_cost(matrix: list[list[float]]) -> tuple[list[int], float]:
    """Find the minimum-weight bipartite matching on an n x m cost matrix.
    
    Args:
        matrix: 2D list of costs of dimensions n (rows) x m (cols).
        
    Returns:
        assignment: List of length n where assignment[i] is the column index assigned
                    to row i, or -1 if row i is unassigned (when n > m).
        total_cost: Sum of matrix[i][assignment[i]] for all matched rows.
    """
    n = len(matrix)
    if n == 0:
        return [], 0.0

    m = len(matrix[0])
    if m == 0:
        return [-1] * n, 0.0

    # If rows > cols, transpose so rows <= cols, then invert result
    if n > m:
        transposed = [[matrix[r][c] for r in range(n)] for c in range(m)]
        col_matching, cost = hungarian_min_cost(transposed)
        row_matching = [-1] * n
        for col_idx, row_idx in enumerate(col_matching):
            if row_idx != -1:
                row_matching[row_idx] = col_idx
        return row_matching, cost

    # Here n <= m
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)        # p[j] is 1-indexed row assigned to column j
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

    row_assignment = [-1] * n
    for j in range(1, m + 1):
        if 0 < p[j] <= n:
            row_assignment[p[j] - 1] = j - 1

    total_cost = sum(
        matrix[i][row_assignment[i]]
        for i in range(n)
        if row_assignment[i] != -1
    )
    return row_assignment, round(total_cost, 6)
