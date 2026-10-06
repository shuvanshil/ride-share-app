# LiphtUp Pool-Based Dispatch: Subsystem Data Model & Audit Schema

**Version:** 2.0 (Phase 2 Hardened)  
**Date:** 2026-10-05  

---

## 1. Subsystem Collections & Schemas

### 1.1 `dispatchWPP` (Waiting Passenger Pool)
- **`id`** (`string`): Passenger document ID.
- **`pickup`** (`{lat: float, lng: float, name: string}`): Origin coordinates and title.
- **`drop`** (`{lat: float, lng: float, name: string, address: string}`): Destination coordinates and address.
- **`req_time`** (`float`): Request timestamp in epoch seconds.
- **`fare`** (`float`): Quoted fare in INR.
- **`vehicle_type`** (`string`): Vehicle class (`auto`, `bike`, `any`).
- **`wants_share`** (`boolean`): Pooling toggle.
- **`seats`** (`integer`): Seats needed.
- **`state`** (`string`): Current state (`WAITING` | `OFFERED`).
- **`current_offer_driver_id`** (`string | null`): Assigned driver ID during outstanding offer.
- **`offer_expires_at`** (`float | null`): Epoch expiration timestamp.
- **`banned`** (`list[string]`): Ineligible driver IDs.
- **`version`** (`integer`): Optimistic concurrency token.

### 1.2 `dispatchDAP` (Driver Availability Pool)
- **`id`** (`string`): Driver document ID.
- **`loc`** (`{lat: float, lng: float}`): Current GPS location.
- **`cell`** (`string`): Discrete spatial cell key.
- **`state`** (`string`): State machine state (`IDLE`, `SHARE_OPEN`, `BUSY`, `OFFERED`, `STALE`, `OFFLINE`).
- **`pool`** (`string`): Sub-pool identity (`IDLE`, `SHARE`, `BUSY`, `OFFLINE`).
- **`seats_free` / `seatsFree`** (`integer`): Available seat count (0 to `SHARE_MAX_SEATS`).
- **`route` / `routeStops`** (`list[object]`): Active waypoint sequence.
- **`idle_since`** (`float`): Epoch time since driver became available.
- **`last_seen`** (`float`): Epoch timestamp of last GPS heartbeat.
- **`vehicle_type`** (`string`): `auto` | `bike`.
- **`is_approved`** (`boolean`): Driver verification status.
- **`current_offer_passenger_id`** (`string | null`): Assigned passenger ID during offer.
- **`offer_expires_at`** (`float | null`): Expiration timestamp.

### 1.3 `dispatchControl`
- **`lease_holder`** (`string | null`): Active runner instance identifier.
- **`lease_expires_at`** (`float`): Lease expiry epoch seconds.
- **`dirty`** (`boolean`): High-priority matching request flag.
- **`consecutive_errors`** (`integer`): Engine error failure counter.

### 1.4 `dispatchAssignments`
- **`assignment_id`** (`string`): Pairing outcome identifier.
- **`run_id`** (`string`): Solver cycle identifier.
- **`passenger_id`** (`string`): Matched passenger.
- **`driver_id`** (`string`): Matched driver.
- **`cost`** (`float`): Objective Kuhn-Munkres score.
- **`eta_minutes`** (`float`): Pickup ETA in minutes.
- **`detour_minutes`** (`float`): Route detour in minutes.
- **`fare`** (`float`): Trip fare.
- **`state`** (`string`): `offered` | `accepted` | `rejected` | `expired`.
- **`route_stops`** (`list[object]`): Assigned stop sequence if shared ride.
- **`offer_expires_at`** (`float`): Offer expiration timestamp.

### 1.5 `dispatchRuns`
- **`run_id`** (`string`): Cycle ID.
- **`timestamp`** (`float`): Start epoch timestamp.
- **`duration_ms`** (`float`): Execution duration in milliseconds.
- **`wpp_waiting`** (`integer`): Waiting passenger count.
- **`dap_idle`** (`integer`): Idle driver count.
- **`dap_share`** (`integer`): Active carpooling driver count.
- **`edges_count`** (`integer`): Evaluated candidate edges.
- **`assignments_count`** (`integer`): Committed pairings.
- **`reads_count`** (`integer`): Firestore read operations.
- **`writes_count`** (`integer`): Firestore write operations.
- **`total_cost`** (`float`): Total objective plan cost.

### 1.6 `dispatchEvents`
- **`event_id`** (`string`): Audit record ID.
- **`event_type`** (`string`): Event classification (e.g., `wpp_passenger_synced`, `assignment_offered`).
- **`actor_id`** (`string`): Actor identifier.
- **`details`** (`map`): Structured payload.
- **`timestamp`** (`float`): Event epoch timestamp.

### 1.7 `dispatchNotifications` (Outbox Queue)
- **`id`** (`string`): Notification ID.
- **`recipient_id`** (`string`): User or driver ID.
- **`recipient_role`** (`string`): `passenger` | `driver`.
- **`type`** (`string`): Alert type (`ride_offer`, `driver_available`).
- **`title`** (`string`): Notification headline.
- **`body`** (`string`): Display body.
- **`data`** (`map`): Push payload.
- **`status`** (`string`): `pending` | `sent` | `failed`.
- **`attempts`** (`integer`): Retry counter.

---

## 2. Admin Operational Questions & Query Mapping

The queries implemented in `api/dispatch/queries.py` and `api/dispatch/invariants.py` cover each administrative question:

| Admin Operational Question | Subsystem Query Function |
| :--- | :--- |
| *What is the live operational status, pool sizes, and fallback status?* | `get_dispatch_status(db)` |
| *What are the recent solver run cycles, durations, and counts?* | `get_recent_runs(db, limit=20)` |
| *What are the recent assignments and pairings?* | `get_recent_assignments(db, limit=20)` |
| *What is the recent system audit log across all transitions?* | `get_recent_events(db, limit=30)` |
| *What is the full lifecycle event timeline for a specific ride?* | `get_ride_timeline(db, ride_id)` |
| *Are there any invariant violations or pool inconsistencies?* | `get_live_dispatch_stats(db)` / `check_dispatch_invariants(db)` |
| *Do daily event and assignment tallies match stored counters?* | `reconcile_daily_stats(db, day)` / `reconcile_daily(db, day)` |

---

## 3. Worked Example: `ride_timeline` for One Complete Ride

Below is a complete, chronologically ordered `ride_timeline` audit record for a single ride (`ride_agt_88201`):

```json
[
  {
    "event_id": "evt_1700000000000_pax_agt_01",
    "event_type": "wpp_passenger_synced",
    "actor_id": "pax_agt_01",
    "timestamp": 1700000000.0,
    "details": {
      "state": "WAITING",
      "version": 1,
      "ride_id": null,
      "pending_request_id": "req_agt_01",
      "wants_share": true
    }
  },
  {
    "event_id": "evt_1700000015000_drv_agt_42",
    "event_type": "assignment_offered",
    "actor_id": "drv_agt_42",
    "timestamp": 1700000015.0,
    "details": {
      "passenger_id": "pax_agt_01",
      "assignment_id": "asgn_1700000015000_pax_agt_",
      "cost": -1.45,
      "eta": 2.4,
      "detour": 0.0
    }
  },
  {
    "event_id": "evt_1700000022000_drv_agt_42",
    "event_type": "share_assignment_accepted",
    "actor_id": "drv_agt_42",
    "timestamp": 1700000022.0,
    "details": {
      "passenger_id": "pax_agt_01",
      "ride_id": "ride_agt_88201",
      "seats_left": 2,
      "pool": "SHARE"
    }
  },
  {
    "event_id": "evt_1700000180000_drv_agt_42",
    "event_type": "driver_arrived",
    "actor_id": "drv_agt_42",
    "timestamp": 1700000180.0,
    "details": {
      "ride_id": "ride_agt_88201",
      "passenger_id": "pax_agt_01",
      "pickup_location": "Post Office Chowmuhani"
    }
  },
  {
    "event_id": "evt_1700000210000_drv_agt_42",
    "event_type": "ride_started",
    "actor_id": "drv_agt_42",
    "timestamp": 1700000210.0,
    "details": {
      "ride_id": "ride_agt_88201",
      "passenger_id": "pax_agt_01",
      "otp_verified": true
    }
  },
  {
    "event_id": "evt_1700000720000_drv_agt_42",
    "event_type": "share_stop_completed",
    "actor_id": "drv_agt_42",
    "timestamp": 1700000720.0,
    "details": {
      "passenger_id": "pax_agt_01",
      "ride_id": "ride_agt_88201",
      "seats_free": 3,
      "pool": "IDLE"
    }
  },
  {
    "event_id": "evt_1700000721000_pax_agt_01",
    "event_type": "wpp_passenger_removed",
    "actor_id": "pax_agt_01",
    "timestamp": 1700000721.0,
    "details": {
      "reason": "completed",
      "ride_id": "ride_agt_88201"
    }
  }
]
```
