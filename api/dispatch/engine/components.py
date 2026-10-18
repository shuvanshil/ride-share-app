"""Connected component decomposition of the bipartite matching graph."""
from __future__ import annotations

from dataclasses import dataclass, field
from .edges import CandidateEdge


@dataclass
class BipartiteComponent:
    """Disjoint subgraph of passengers and drivers linked by candidate edges."""
    passenger_indices: list[int] = field(default_factory=list)
    driver_indices: list[int] = field(default_factory=list)
    edges: list[CandidateEdge] = field(default_factory=list)


def decompose_components(
    num_passengers: int,
    num_drivers: int,
    edges: list[CandidateEdge],
) -> tuple[list[BipartiteComponent], list[int], list[int]]:
    """Decompose bipartite candidate graph into connected components.
    
    Returns:
        (components, isolated_passengers, isolated_drivers)
    """
    if not edges:
        return (
            [],
            list(range(num_passengers)),
            list(range(num_drivers)),
        )

    # Adjacency list: p_idx (0..num_passengers-1) and d_idx (num_passengers..num_passengers+num_drivers-1)
    offset = num_passengers
    adj: dict[int, set[int]] = {i: set() for i in range(num_passengers + num_drivers)}
    edge_map: dict[tuple[int, int], CandidateEdge] = {}

    for e in edges:
        adj[e.passenger_idx].add(offset + e.driver_idx)
        adj[offset + e.driver_idx].add(e.passenger_idx)
        edge_map[(e.passenger_idx, e.driver_idx)] = e

    visited = set()
    components: list[BipartiteComponent] = []
    isolated_passengers: list[int] = []
    isolated_drivers: list[int] = []

    for p in range(num_passengers):
        if not adj[p]:
            isolated_passengers.append(p)

    for d in range(num_drivers):
        node = offset + d
        if not adj[node]:
            isolated_drivers.append(d)

    # Traverse non-empty components
    for node in range(num_passengers + num_drivers):
        if node in visited or not adj[node]:
            continue

        comp_p = []
        comp_d = []
        queue = [node]
        visited.add(node)

        while queue:
            curr = queue.pop(0)
            if curr < offset:
                comp_p.append(curr)
            else:
                comp_d.append(curr - offset)

            for neighbor in adj[curr]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)

        comp_edges = [
            edge_map[(p_i, d_i)]
            for p_i in comp_p
            for d_i in comp_d
            if (p_i, d_i) in edge_map
        ]

        components.append(
            BipartiteComponent(
                passenger_indices=sorted(comp_p),
                driver_indices=sorted(comp_d),
                edges=comp_edges,
            )
        )

    return components, isolated_passengers, isolated_drivers
