# Dispatch Reconnaissance Report (Phase 0)

Date: 2026-10-01  
Repository: `shuvanshil/ride-share-app`  
Author: Antigravity AI Agent

---

## 1. Current Ride Creation, Driver Selection & Offer Logic

### 1.1 Ride Creation (`api/routers/rides.py`)
- **Endpoint**: `POST /api/rides` (`create_passenger_ride`)
- **Flow**:
  1. Authenticates passenger via `current_user` dependency and verifies `role == "passenger"`.
  2. Validates pickup & dropoff coordinates (bounds $[-90, 90]$ and $[-180, 180]$) and computes route via `_server_route()` (calls Google Routes API `computeRoutes` with 4s timeout, falling back to Haversine $\times 1.25$ road curvature factor).
  3. Checks distance against `MAX_SERVICEABLE_DISTANCE_KM` (50 km).
  4. Calculates fare using `get_service_fare_policy()` and `calculate_fare()` from `api/core/fare_policy.py`.
  5. Queries candidate drivers in `_available_drivers()`:
     - Streams `driverPresence` collection where `driverAvailability` is `"searching"` or `"online"`.
     - Filters by: approved verification status (`verificationStatus == "approved"`), freshness (`last_seen <= 12 hours`), valid GPS coordinates, and matching `vehicle_type`.
     - Sorts candidates strictly by straight-line Haversine distance from pickup location.
     - Selects the top `DISPATCH_BATCH_SIZE = 10` drivers as `first_batch`.
  6. Executes Firestore transaction:
     - Confirms passenger has no ongoing active trip (`accepted`, `arrived`, `started`, `en_route`).
     - Auto-cancels any old unaccepted rides (`pending`, `searching`, `dispatching`) for this passenger.
     - Creates new ride document with `status: "pending"`, `verification_pin: None`, `driver_id: None`, `eligible_driver_ids: first_batch`, `notified_driver_ids: first_batch`.

### 1.2 Driver Selection & Offer Flow (`www/js/driver/driver-service.js`)
- **Realtime Listener**: Driver client runs Firestore listener:
  ```javascript
  query(collection(db, "rides"), where("eligible_driver_ids", "array-contains", currentUser.uid))
  ```
- **Offer Notification**: When a ride document matches, the driver app sounds a ring chime and renders an incoming ride request card with a 5-minute countdown.
- **Driver Actions**:
  - **Accept** (`POST /api/rides/{ride_id}/accept`): In a Firestore transaction, checks ride is still `pending`, not cancelled or timed out (> 5 min), verifies vehicle type match, driver in `eligible_driver_ids`, and driver not in `rejected_driver_ids`. Sets `status: "accepted"`, writes driver details, generates 4-digit `verification_pin`, and updates driver availability to `busy`.
  - **Decline** (`POST /api/rides/{ride_id}/reject`): Adds driver UID to `rejected_driver_ids` and updates status to `declined`.
- **Search Expansion** (`POST /api/rides/{ride_id}/dispatch`):
  - Triggered when initial batch does not accept.
  - Queries `_available_drivers()` excluding already notified or rejected drivers, and appends up to 10 more candidates to `eligible_driver_ids`.

---

## 2. Ride Statuses & Driver Availability Fields

### 2.1 Ride Statuses
| Status | Description |
|---|---|
| `pending` | Ride created, searching for driver, unassigned |
| `accepted` | Driver accepted offer, PIN generated, driver en route to pickup |
| `arrived` | Driver arrived at pickup location |
| `started` | PIN verified by driver, trip underway |
| `en_route` | Active in-transit trip state |
| `completed` | Trip completed, fare verified/settled |
| `cancelled_by_passenger` / `cancelled_by_driver` / `cancelled` | Cancelled by user or driver |
| `declined` | Declined by candidate driver |
| `timeout` | 5-minute search timeout expired without driver acceptance |

### 2.2 Driver Availability Fields & Persistence
Driver state is synchronized across three Firestore collections:
1. **`users/{uid}`**:
   - `driverAvailability`: `"searching"` | `"busy"` | `"offline"`
   - `desiredAvailability`: `"online"` | `"offline"`
   - `lastLocationAt`, `lastSeenAt`, `notificationEligibleUntil`
2. **`driverPresence/{uid}`** (Server-only, private telemetry):
   - `driverAvailability`, `desiredAvailability`, `driverLocation: {lat, lng}`, `driverHeading`, `driverSpeed`, `driverAccuracy`, `isConnected`, `lastLocationAt`, `lastSeenAt`, `updatedAt`
3. **`driverMapPresence/{uid}`** (Public coarse map presence):
   - `driverAvailability`, `desiredAvailability`, `driverLocation: {lat, lng}` (fuzzed/coarse 2 decimal places), `vehicle_type`, `vehicle_model`, `isConnected`, `lastLocationAt`, `lastSeenAt`

**Availability Toggle**: Handled via `POST /api/rides/driver-availability` with body `{"status": "searching" | "offline" | "busy"}`. Logout hooks (`www/js/driver/driver-availability.js`) call this endpoint with `"offline"`.

---

## 3. Location Storage & Dispatch Data Integrity

- **Driver Location Telemetry**: Sent via authenticated endpoint `POST /api/rides/driver-location`.
- **Server Validation**: Verifies auth token, checks approved driver status, validates GPS coordinates, speed, heading, and accuracy.
- **Server vs. Public Collections**:
  - `driverPresence/{driverId}`: Enforced by `firestore.rules` as `allow read, write: if false;`. Only FastAPI (Firebase Admin SDK) can read and write this collection.
  - `driverMapPresence/{driverId}`: Enforced as `allow read: if true; allow create, update, delete: if false;` with coarse location for guest/map visibility.
- **Dispatch Source**: All dispatch operations read from `driverPresence` using the Admin SDK, ensuring client apps cannot spoof positions or tamper with candidate selection.

---

## 4. Firestore Indexes & Rules

### 4.1 Existing Rules (`firestore.rules`)
- `/rides/{rideId}`: `allow read: if rideParticipant() || eligibleDriver() || isAdmin(); allow create, update, delete: if false;`
- `/driverPresence/{driverId}`: `allow read, write: if false;`
- `/driverMapPresence/{driverId}`: `allow read: if true; allow create, update, delete: if false;`
- `/users/{userId}`: `allow read: if signedIn() && (request.auth.uid == userId || isAdmin()); allow write: if false;`

### 4.2 Existing Indexes (`firestore.indexes.json`)
- Indexes exist on `rides` (by status, createdAt, passenger_id, driver_id, vehicle_type) and `users` (by role, driverAvailability, verificationStatus).
- **Index Gap**: `driverPresence` currently relies on single-field indexes (`driverAvailability`). New queries combining `driverAvailability == "searching"` and `zoneId in [...]` will require a composite index entry in `firestore.indexes.json`.

---

## 5. Hosting Model, Scheduling & Dependencies

### 5.1 Hosting Model
- **Environment**: Vercel Serverless Functions (`vercel.json` rewrites `/api/(.*)` to `/api/index`).
- **Characteristics**: Stateless execution. No persistent in-process memory or continuous daemon loop. Every dispatch tick must be fully stateless, idempotent, and backed by Firestore.

### 5.2 Scheduler Options
- `vercel.json` currently configures Vercel Cron:
  ```json
  "crons": [
    {
      "path": "/api/rides/cron/activate-scheduled",
      "schedule": "*/5 * * * *"
    }
  ]
  ```
- Vercel Cron or external pingers hitting authenticated endpoints can serve as the safety-net tick trigger.

### 5.3 Python Dependencies
- **Installed**: `fastapi` (0.115.x), `pydantic` (2.7.x), `firebase_admin` (6.5.x), `httpx` (0.27.x).
- **Not Installed**: `numpy`, `scipy`, `shapely`.
- **Architectural Fit**: The dispatch algorithm and LLA PIP checks will use pure-Python algorithms (ray-casting PIP, axial hex arithmetic, and pure-Python Hungarian / Jonker-Volgenant solver) requiring zero heavy runtime dependencies on serverless Vercel.

---

## 6. ETA & Routing Computation

- **Current Implementation**:
  - `_server_route` in `api/routers/rides.py` calls Google Routes API (`https://routes.googleapis.com/directions/v2:computeRoutes`) when `GOOGLE_MAPS_SERVER_KEY` is present.
  - Fallback: Straight-line `_haversine_km` $\times 1.25$ curvature factor.
- **Dispatch Shortlist ETA**:
  - Current driver matching uses raw straight-line Haversine distance.
  - The new two-tier ETA provider will use cheap Haversine $\times 1.4$ / $22\text{ km/h}$ for K-candidate pre-ranking, and Routes/Distance Matrix with 60s cache and 300ms timeout for the top 3 shortlist candidates.

---

## 7. PIN Issuance Lifecycle

- **Creation Time**: `POST /api/rides` creates ride with `"verification_pin": None`.
- **Acceptance Time**: Inside `POST /api/rides/{ride_id}/accept` transaction `accept_transaction(tx)`, the server generates a cryptographically secure 4-digit PIN (`secrets.randbelow(10000)`) and writes it to the ride.
- **Trip Start Time**: Driver submits PIN in `POST /api/rides/{ride_id}/transition` (`action: "verify_pin"`).
- **Conclusion**: PIN issuance remains strictly authoritative and occurs only upon driver acceptance.

---

## 8. Hard Constraints to Preserve

1. **Vehicle Type**: Ride `vehicle_type` must strictly match driver's registered `vehicle_type`.
2. **Driver Verification**: Driver must be verified (`verificationStatus == "approved"` or `is_verified == True`).
3. **Driver Availability**: Must be actively `searching`/`online` and `desiredAvailability != "offline"`.
4. **Single Active Trip**: Driver cannot hold or accept another ride if already assigned to an active trip (`accepted`, `arrived`, `started`, `en_route`).
5. **Declined / Excluded Drivers**: Drivers in `rejected_driver_ids` / `excludedDriverIds` are never re-offered the same ride.
6. **5-Minute Timeout**: Pending unaccepted rides expire after 5 minutes.

---

## 9. Section 17 Questions for Owner Confirmation

1. **Polygon & Buffer**: Unakoti District + North Tripura District bounding hexagon with 5–10 km buffer. (Preview script ready for Phase 1).
2. **Dropoff Rule**: Should dropoff *also* be required to be inside the LLA (`requireDropoffInside = True`), or pickup only?
3. **Safety-Net Tick Trigger**: Vercel Cron schedule (`* * * * *` or `*/5 * * * *`) vs. external uptime pinger hitting `/api/rides/dispatch-tick`.
4. **Initial Dispatch Config Defaults**:
   - `max_pickup_eta_minutes`: 25 min
   - `offer_timeout_seconds`: 15 s
   - `batch_hold_ms`: 1500 ms
   - `expand_after_seconds`: 20 s
   - `location_freshness_seconds`: 30 s
