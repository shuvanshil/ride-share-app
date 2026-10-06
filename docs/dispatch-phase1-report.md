# LiphtUp Pool-Based Dispatch: Phase 1 Implementation & Verification Report

**Date:** 2026-10-05  
**Subsystem:** LiphtUp Dispatch Engine & Pools (Phase 1)  
**Status:** Complete & Passing (191/191 pytest tests pass)  
**Authors:** Antigravity Worker  

---

## 1. Executive Summary

Phase 1 of the LiphtUp Pool-Based Dispatch system has been fully implemented, integrated, and verified. The ad-hoc, FIFO greedy matching of the legacy codebase has been migrated to an atomic, pool-based state machine model powered by a pure-Python rectangular Hungarian (Kuhn-Munkres) minimum-cost bipartite matching algorithm ($O(n^3)$).

All existing product features—including normal ride booking, shared pooling, notify-me requests, scheduled rides, and cancellations—have been seamlessly integrated into the pool system. A dedicated, resilient fallback mechanism ensures that if the new matching engine encounters repeated consecutive failures, the system gracefully falls back to legacy matching while logging diagnostic error messages to the console.

100% byte parity is strictly maintained across all Python files between `api/` and `www/api/`.

---

## 2. Architecture & Modules Implemented

### 2.1 Pure Matching Engine (`api/dispatch/engine/`)
- **`geo.py`:** Haversine distance, uniform grid cell discretization (`lat_lon_to_cell`), Chebyshev ring neighborhood expansion, and bounding box radius coverage.
- **`eta.py`:** Pickup ETA estimation using local average speed (25 km/h) and Haversine distance.
- **`radius.py`:** Dynamic expanding radius with formula:
  $$\text{maxETA}(\text{waitP}) = \min(\text{cap\_eta}, \text{base\_max\_eta} + \text{growth\_rate} \times \max(0, \text{waitP}))$$
- **`plan.py`:** Pure data models for `PassengerEntry`, `DriverEntry`, `Assignment`, and `DispatchPlan`.
- **`eligibility.py`:** Hard filters checking banned driver sets, driver approval status, state visibility (`WAITING` for passengers, `IDLE` / `SHARE_OPEN` for drivers), vehicle compatibility, shared seats capacity, detour limits, and expanding ETA limits.
- **`cost.py`:** Objective cost formula combining ETA, passenger wait time discount, driver idle time discount, fare rate per minute, detour penalty, and shared ride bonus.
- **`edges.py`:** Directed candidate edge creation between eligible passengers and drivers.
- **`components.py`:** Graph connected component decomposition splitting the bipartite matching problem into independent, isolated subgraphs for optimal scaling.
- **`hungarian.py`:** Pure Python rectangular Kuhn-Munkres algorithm handling arbitrary $n \times m$ real cost matrices without external dependencies (`scipy`/`numpy`).
- **`solve.py`:** High-level solver adding dummy unassigned columns so passengers without viable drivers remain unassigned.

### 2.2 Pool State Machines & Collections (`api/dispatch/pools.py`)
- **`dispatchWPP`:** Waiting Passenger Pool (`WAITING`, `OFFERED`). Idempotent addition, version tracking, and safe deletion.
- **`dispatchDAP`:** Driver Availability Pool (`IDLE`, `SHARE_OPEN`, `BUSY`, `OFFERED`). Telemetry synchronization and spatial cell keys.
- **`dispatchControl`:** Distributed lease locking (`lease_holder`, `lease_expires_at`, `dirty`, `consecutive_errors`).
- **`dispatchAssignments`:** Pairing outcomes with cost, ETA, detour, and offer expiration.
- **`dispatchRuns`:** Run-level telemetry (duration ms, counts, total cost).
- **`dispatchEvents`:** Audit log of pool transitions.
- **`dispatchNotifications`:** Reliable outbox queue for asynchronous push notification delivery.
- **`dispatchScheduled`:** Pre-departure scheduled requests waiting for release into WPP.
- **`dispatchNotifyMe`:** Proximity alert requests waiting for nearby available drivers.

### 2.3 Lease Runner & Sweeper (`api/dispatch/runner.py`, `api/dispatch/sweeper.py`)
- **`run_dispatch(db)`:** Distributed lease acquisition with `dirty`-loop execution. Runs matching engine, atomically locks paired entries to `OFFERED`, commits assignments, materializes concrete `rides` records for pending requests, and sets dirty flag upon state changes.
- **`run_dispatch_sweeper(db)`:** 10-second maintenance sweeping:
  1. Stale drivers (>45s GPS lapse) marked `STALE`.
  2. Expired offers reverted (`OFFERED` -> `WAITING`/`IDLE`) with unresponsive drivers banned.
  3. Max wait passengers (>25 min) timed out.
  4. Due scheduled rides released to WPP (lead window: 15 min), and unserved scheduled rides timed out (>10 min past departure time).
  5. Notify-me requests evaluated for nearby drivers and expired past TTL.
  6. Outbox notifications dispatched.
  7. Stuck leases and locks repaired (>60s).

### 2.4 Resilient Safe Fallback Mechanism
- The runner tracks `_consecutive_engine_errors`.
- If consecutive engine failures reach `MAX_CONSECUTIVE_ENGINE_ERRORS` (3 attempts), the runner enters fallback mode, prints `[DISPATCH_FALLBACK]` to the console (`stdout` and `stderr`), and invokes the registered legacy matching fallback.
- Upon successful execution of the new matching engine, the error counter resets to 0.

### 2.5 API Endpoints (`api/routers/dispatch.py`)
- `POST /api/dispatch/nudge`: Triggers an immediate matching cycle.
- `POST /api/dispatch/sweep`: Triggers an immediate sweeper cycle.
- `GET /api/dispatch/status`: Operational health, pool counts, and fallback status.
- `GET /api/dispatch/runs`: Recent runner cycles.
- `GET /api/dispatch/assignments`: Recent pairings.
- `GET /api/dispatch/events`: Recent audit events.

---

## 3. Verification & Test Suite Results

### 3.1 Unit Testing: Pure Engine (`api/tests/test_engine.py`)
- **Hungarian vs. Brute Force:** 200 random rectangular cost matrices verified with 100% agreement against exhaustive permutation brute-force search.
- **Example 1:** Global 13.0 min pickup ETA achieved over greedy/sub-optimal 16.0 min assignment.
- **Example 2:** Longest waiting passenger and longest idle driver prioritized over newly joined entries.
- **Scarcity:** $N > M$ handles unassigned passengers cleanly without duplicate assignments.
- **Radius Expansion:** Dynamically expands eligibility from 8 min up to 13 min as wait time increases.
- **Banned Drivers:** Banned driver sets strictly respected even when adjacent.

### 3.2 Integration Testing: Pools, Runner & Fallback (`api/tests/test_dispatch_pools.py`)
- **WPP Idempotence:** Multiple additions update version without duplication; deletions are safe no-ops.
- **DAP State Transitions:** Transitions between `IDLE`, `SHARE_OPEN`, `OFFLINE`, and `OFFERED`.
- **Runner Cycle:** Full lease acquisition, matching, assignment persistence, and notification enqueueing verified with in-memory store.
- **Sweeper Operations:** Stale driver demotion (>45s) and expired offer rollback verified.
- **Fallback Activation:** 3 consecutive simulated engine errors verified to trigger fallback handler and output console warning `[DISPATCH_FALLBACK]`.
- **Scheduled Sweep:** 15-minute lead window release into WPP and 10-minute departure timeout verified.
- **Notify-Me Sweep:** Proximity alert detection and TTL expiry verified.
- **Pending Auto Materialization:** Materialization of concrete `rides` doc for pending auto requests verified.
- **Rejection Cascading:** Pool ride rejection maintaining `pending` status and matching next candidate verified.
- **Shared Capacity Preservation:** Accepting shared ride keeping driver in `SHARE_OPEN` verified.

### 3.3 Full Test Suite Status
```
Collected 191 items
Status: 191 passed in 2.61s (100% passing)
```

### 3.4 Byte Parity Verification
Verified via recursive binary byte comparison across all Python files in `api/` and `www/api/`:
```
100% BYTE PARITY VERIFIED ACROSS ALL PYTHON FILES IN api/ AND www/api/!
```
