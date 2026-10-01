# LiphtUp Dispatch Feature Audit & Verification Matrix

This document provides a comprehensive audit of all system components, Firestore collections/fields, and client applications interacting with ride dispatch, candidate filtering, and lifecycle state machines under both **Legacy** and **Hex-Batch** dispatch architectures.

---

## 1. Field Reader & Writer Audit Across Codebase

| Field Name | Firestore Path(s) | Writers | Readers | Legacy Behaviour | Hex-Batch Behaviour |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `eligible_driver_ids` | `rides/{rideId}` | `POST /api/rides` (legacy), `POST /api/rides/{id}/dispatch` (legacy), `POST /api/rides/dispatch-tick` (hex_batch) | `driver.js`, `driver-service.js`, `api/routers/rides.py` (`accept_driver_ride`, `reject_driver_ride`), `firestore.rules` (`eligibleDriver()`) | Array of top-10 candidate driver IDs notified simultaneously in broadcast. | Single-element array `[offered_driver_id]` during active offer window; cleared to `[]` on decline/expiry. Preserves Firestore security rules (`eligibleDriver()`) without rules changes. |
| `notified_driver_ids` | `rides/{rideId}` | `POST /api/rides`, `POST /api/rides/{id}/dispatch` | `api/routers/rides.py` (legacy candidate exclusion), `admin.js` | Accumulates all driver IDs ever notified for this ride. | Maintained for administrative auditing and analytics. |
| `rejected_driver_ids` | `rides/{rideId}`, `pendingRideRequests/{id}` | `POST /api/rides/{id}/reject`, `driver-service.js` | `api/routers/rides.py` (`_available_drivers`, `accept_driver_ride`, `reject_driver_ride`), `driver-service.js` | Driver decline appends UID to `rejected_driver_ids` and sets status to `"declined"`. | Driver decline appends UID to `rejected_driver_ids` and `excludedDriverIds`, clears `currentOffer` & `dispatchLock`, preserves ride status as `"pending"`, and immediately triggers next matching tick. |
| `currentOffer` | `rides/{rideId}` | `POST /api/core/dispatch_engine.py` (`lock_and_offer_tx`), `POST /api/rides/{id}/reject` | `api/routers/rides.py` (`accept_driver_ride`), `driver.js`, `driver-service.js` | Field does not exist (`None`). | Map `{driverId, createdAt, expiresAt}` defining the exclusive 15s offer window. Driver card counts down to `expiresAt`. Server-side `accept` verifies `currentOffer.driverId == caller` and `now <= expiresAt`. |
| `dispatchLock` | `driverPresence/{driverId}` | `api/core/dispatch_engine.py` (`lock_and_offer_tx`), `api/routers/rides.py` (`accept_driver_ride`, `reject_driver_ride`) | `api/core/dispatch_engine.py` | Field does not exist (`None`). | Map `{rideId, expiresAt}` preventing the driver from receiving overlapping offers during the 15s window. Cleared on accept, decline, cancellation, or TTL expiry. |
| `searchRing` | `rides/{rideId}` | `POST /api/rides` (hex_batch), `POST /api/rides/{id}/dispatch` (hex_batch), `api/core/dispatch_engine.py` | `api/core/dispatch_engine.py`, `passenger.js` | Field does not exist (`None`). | Integer ($1 \dots 10$) representing current hexagonal ring radius. Auto-expanded over time or bumped on client `/dispatch` calls. |
| `dispatch_algorithm` | `rides/{rideId}` | `POST /api/rides`, `POST /api/rides/pending-request` activation | `api/routers/rides.py` (`accept`, `reject`, `/dispatch`) | Set to `"legacy"` for existing rides. | Stamped at ride creation with active configuration (`"legacy"` or `"hex_batch"`). Ensures flipping the system flag only affects newly created rides. |
| `driverAvailability` | `users/{uid}`, `driverPresence/{uid}`, `driverMapPresence/{uid}` | `POST /api/rides/driver-availability`, `POST /api/rides/driver-location`, `POST /api/rides/{id}/accept`, `POST /api/rides/{id}/cancel` | `api/routers/rides.py`, `passenger.js`, `driver.js`, `admin.js` | States: `searching`, `busy`, `offline`. | States identical: `searching`, `busy`, `offline`. Composite index on `(driverAvailability, zoneId, lastLocationAt)` accelerates geo queries. |
| `notificationEligibleUntil` | `users/{uid}`, `driverPresence/{uid}` | `_build_driver_availability_updates`, `save_driver_push_token`, `update_driver_location` | `api/routers/rides.py`, `api/core/dispatch_engine.py` | 12-hour window from last active online status. | Used as reachability signal: backgrounded driver with stale GPS fix ($> 30\text{s}$) but valid push eligibility is deprioritized (+5 min ETA penalty) rather than excluded. Stale fix without push eligibility ($> 60\text{s}$) is excluded. |

---

## 2. Feature Compatibility Matrix

### 2.1 Schedule for Later (`mode == "schedule"`)
- **LLA Gate Enforcement**: Evaluated at scheduling time in `POST /api/rides/pending-request` and re-evaluated at activation time. Rejects out-of-bounds pickup/dropoff with 400 when `lla.enforce == True`.
- **Wait-Aging Parity**: Aging weight ($\gamma \cdot \text{waiting\_minutes}$) begins accumulating only upon activation (`activatesAt`), preventing unfair prioritization of pre-scheduled requests over immediate on-demand requests.
- **Reminders & Push Notifications**: 15-minute passenger reminder and 10-minute timeout reschedule prompt (`/reschedule-15min`) remain completely unchanged.

### 2.2 Notify Me When Available (`mode == "notify_only"`)
- **Eligibility Parity**: Uses identical vehicle type, verification status, and radius checks.
- **Max ETA Decoupling**: Passenger availability notification is not suppressed by the max-ETA cap ($25\text{ min}$), ensuring riders in low-density areas are alerted whenever a driver comes online.
- **Double-Serving Prevention**: `lastNotifiedAt` timestamp prevents spamming duplicate notifications within the same online session.

### 2.3 Increase Search Radius (`POST /api/rides/{ride_id}/dispatch`)
- **Legacy Path**: Queries next 10 nearest drivers and appends them to `eligible_driver_ids` and `notified_driver_ids`.
- **Hex-Batch Path**: Increments `searchRing` by 1, persists `last_dispatch_at`, and executes an authoritative lease-protected tick. Never appends drivers to `eligible_driver_ids`.
- **Passenger UI Parity**: Returns standard `{ok: True, rideId, searchStatus: "searching_nearby_drivers"}` keeping frontend search animation and messages working seamlessly.

### 2.4 Driver Offer & Lifecycle States
- **Single Offer Exclusivity**: In `hex_batch`, `eligible_driver_ids` is strictly set to `[offered_driver_id]`, ensuring the driver app's real-time listener receives the incoming card with zero race conditions against other drivers.
- **Countdown Sync**: Driver incoming offer card calculates time remaining against `currentOffer.expiresAt` (15s) rather than a fixed 5-minute legacy countdown.
- **Decline Handling**: Driver decline maintains ride status as `"pending"`, clears `dispatchLock`, appends driver to `rejected_driver_ids` / `excludedDriverIds`, and triggers an immediate tick for the next best assignment.
- **Cancellation Mid-Offer**: If a passenger cancels while an offer is ticking, the driver's `dispatchLock` is released immediately.

---

## 3. Verification Test Suite Matrix

| Test Suite / Case | Scenario Covered | Expected Assertion |
| :--- | :--- | :--- |
| `test_ride_stamped_with_algorithm` | Ride creation under legacy vs hex_batch | Ride document has `dispatch_algorithm` matching system setting at creation time. |
| `test_flag_flip_isolation` | Flag flipped from legacy to hex_batch | Existing legacy rides continue processing under legacy rules; new rides use hex_batch. |
| `test_expand_dispatch_hex_batch_vs_legacy` | Passenger calls `POST /api/rides/{id}/dispatch` | In hex_batch: `searchRing` increments, `eligible_driver_ids` unchanged. In legacy: batch appended. |
| `test_scheduled_ride_lla_gate` | Schedule creation & activation with pickup outside LLA | Returns 400 ApiError when `lla_enforce: True`. |
| `test_notify_only_reachability` | Driver appears near notify-only pending request | In-app/push notification dispatched to passenger without assigning or locking driver. |
| `test_location_freshness_penalties` | Drivers with fix age 10s, 45s, 75s (with push) vs 75s (no push) | 10s: 0 penalty; 45s: 0.5m penalty; 75s (push): 5m penalty; 75s (no push): excluded (>60s cutoff). |
| `test_decline_keeps_pending_and_frees_lock` | Driver rejects offer in hex_batch | Ride status stays `"pending"`, `dispatchLock` cleared, next candidate offered. |
| `test_passenger_cancel_mid_offer` | Passenger cancels ride while driver has active offer | Ride status becomes `"cancelled_by_passenger"`, driver `dispatchLock` cleared. |
| `test_offer_expiry_and_steal_prevention` | Driver A attempts to accept after 15s or Driver B attempts to steal | Expired accept returns 410; unauthorized driver accept returns 403. |
| `test_opportunistic_tick_throttling` | Rapid concurrent requests trigger opportunistic ticks | Distributed lease and 5s throttle prevent duplicate database writes and execution overload. |
| `test_cron_secret_security` | `/cron/activate-scheduled` invoked with/without secret | Valid `Authorization: Bearer <secret>` passes; invalid/missing header returns 401. |
