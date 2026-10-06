# LiphtUp Dispatch Discovery & Legacy Architecture Audit

**Date:** 2026-10-05  
**Scope:** `api/routers/rides.py`, `api/index.py`, `api/core/`  
**Author:** Antigravity Worker  

---

## 1. Executive Summary

LiphtUp currently relies on a hybrid dispatch mechanism across two primary paths:
1. **Immediate Ride Creation (`POST /api/rides`):** Performs an on-demand nearest-driver query (`_available_drivers()`), sorts candidates strictly by Haversine distance, and broadcasts the ride to a batch of up to 10 drivers (`eligible_driver_ids` / `notified_driver_ids`). Any eligible driver can race to accept. For shared rides, active `shareTrips` are checked for route insertion and detour limits.
2. **Persistent Pending Requests (`pendingRideRequests` / `POST /api/pending-requests`):** Manages asynchronous booking, "Notify Me" (`notify_only`), and scheduled rides (`schedule`). Matching is performed reactively via `_match_pending_requests_for_driver()`, which conducts a FIFO scan (sorted by `createdAt` ASC) when a driver reports availability or location. When a match is found in "auto" mode, an atomic transaction transitions the request to `dispatching` and creates a targeted `rides` document for that single driver.
3. **Background Sweepers:** A 10-second daemon thread in `api/index.py` (`_bg_scheduled_ride_sweeper`) and cron endpoints (`/api/cron/activate-scheduled`) sweep due scheduled requests, prompt 10-minute timeout extensions, and clean up stale locks (>45s).

---

## 2. Legacy Data Models & State Machine

### 2.1 Collections Involved
- `rides`: Represents individual active/completed/cancelled trips.
  - States: `pending`, `accepted`, `arrived`, `started`, `en_route`, `completed`, `cancelled_by_passenger`, `cancelled_by_driver`, `declined`, `timeout`.
- `pendingRideRequests`: Represents queued bookings, scheduled rides, and notify-me requests.
  - States: `pending`, `dispatching`, `expired`, `cancelled`.
  - Modes: `auto` (auto-match to first available driver), `notify_only` (alert passenger when a driver enters radius), `schedule` (reserve for scheduled future departure).
- `driverPresence`: Driver online state, availability, GPS telemetry.
  - Availability: `offline`, `searching`, `busy`, `online`.
- `shareTrips`: Multi-passenger auto pooling trips.
  - States: `draft`, `to_pickup`, `active`, `completed`, `cancelled`.
- `demandEvents`: Telemetry logs for ride requests, matches, and cancellations.

### 2.2 State Flow
- **Passenger:** Requests ride -> `rides` (`pending`) or `pendingRideRequests` (`pending`).
- **Driver Matching:** 
  - Standard: Top 10 drivers notified. First to call `POST /rides/{id}/accept` claims the trip via Firestore transaction.
  - Pending/Scheduled: First FIFO candidate matching vehicle type and radius claims the driver. Status transitions to `dispatching`, soft-locking with `lockedByDriverId`.
- **Decline/Rejection:** Driver rejects ride -> appended to `rejected_driver_ids`. If pending request, reverts back to `pending` and triggers cascading match to next driver.
- **Completion/Cancellation:** Frees driver back to `searching`, triggering `_match_pending_requests_for_driver()`.

---

## 3. Shortcomings of Legacy Dispatch

1. **Greedy / FIFO Sub-Optimality:**
   - Standard dispatch notifies a batch of drivers who race to accept. The fastest driver to tap their screen wins, not the driver with the lowest ETA or best route alignment.
   - Pending request matching processes requests sequentially in FIFO order against the first available driver, ignoring global system efficiency, batch matching, or driver idle times.
2. **Double-Offering & Racing Hazards:**
   - Broadcast dispatching creates races where multiple drivers receive offers simultaneously for the same ride.
   - When a driver rejects, cascading dispatch synchronously queries Firestore across searching drivers on the request thread.
3. **No Global Cost Optimization:**
   - Does not optimize collective pickup ETA across multiple waiting passengers and idle drivers.
   - Does not balance passenger waiting time, driver idle time, vehicle utilization, or route synergy.
4. **Scattered Triggers & Tight Coupling:**
   - Matching calls are duplicated across 6+ different route endpoints (`driver-availability`, `driver-location`, `cancel`, `reject`, `transition`, `scheduled/activate-due`).

---

## 4. Target Architecture: Pool-Based Dispatch (Phase 1)

The new pool-based dispatch replaces ad-hoc FIFO matching with an atomic, transactional state-pool model evaluated by a pure rectangular Hungarian matching algorithm:

1. **Pools:**
   - `dispatchWPP` (Waiting Passenger Pool): strictly `WAITING` or `OFFERED`.
   - `dispatchDAP` (Driver Availability Pool): strictly `IDLE`, `SHARE_OPEN`, `BUSY`, or `OFFERED`.
2. **Cost Function:**
   $$\text{Cost}(p, d) = \text{ETA} \times (1 + W_{\text{URGENCY}} \times \text{wait}_P) - W_{\text{PAX\_WAIT}} \times \text{wait}_P - W_{\text{DRIVER\_IDLE}} \times \text{idle}_D - W_{\text{FARE}} \times \text{fare\_rate} + \text{detour} - W_{\text{SHARE}}$$
3. **Pure Python Rectangular Hungarian Matching:**
   $O(n^3)$ Kuhn-Munkres assignment without scipy/numpy dependencies, with dummy columns allowing passengers to remain unassigned if no eligible driver satisfies maximum ETA thresholds.
4. **Lease-based Dispatch Runner:**
   A distributed lock/lease in `dispatchControl` with a `dirty` flag loop, processing atomic batch matches and persisting assignments and notifications.
5. **Fail-Safe Fallback:**
   If the new matching engine encounters repeated consecutive failures, the system gracefully falls back to legacy matching while continuing to attempt pool recovery and logging diagnostic errors to the console.
