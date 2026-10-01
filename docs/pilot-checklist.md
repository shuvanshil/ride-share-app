# LiphtUp Pilot Deployment Checklist & Device Test Script

This checklist defines the operational procedure for enabling the **Hex-Batch Dispatch & LLA Geofence Pilot** in the Kailashahar and Dharmanagar operational zone.

---

## 1. Pilot Configuration

The dispatch configuration can be updated dynamically at runtime without restarting or redeploying backend containers by updating the Firestore document `systemSettings/dispatch`.

### 1.1 Enabling Pilot Profile in Firestore
Write the following JSON to `systemSettings/dispatch`:
```json
{
  "algorithm": "hex_batch",
  "lla_enforce": true,
  "require_dropoff_inside": true,
  "offer_timeout_seconds": 15,
  "location_freshness_seconds": 60,
  "batch_hold_ms": 0,
  "expand_after_seconds": 15,
  "max_pickup_eta_minutes": 25.0,
  "candidates_k": 8,
  "cost_exponent_alpha": 1.0,
  "aging_weight_gamma": 0.05,
  "profile": "pilot"
}
```

*Note: The backend caches `systemSettings/dispatch` for 10 seconds. Changes take effect automatically within 10 seconds across all instances.*

---

## 2. Step-by-Step Physical Device Test Script

Conduct this test with **2 Driver Devices (D1, D2)** and **1 Passenger Device (P1)** on location in Kailashahar / Dharmanagar.

### Step 1: LLA Gate Verification (Passenger App)
1. On **P1**, set pickup location to **Agartala** (outside LLA: $23.8315, 91.2868$).
2. Attempt to book a ride or schedule a ride.
3. **Verify**: In-app modal appears showing: *"This pickup location is outside LiphtUp's Limited Lipht Area (LLA)."* Ride creation is blocked.
4. Set pickup and dropoff locations to **Kailashahar Town** ($24.3314, 92.0084$).
5. **Verify**: Fare calculation and ride creation proceed normally.

### Step 2: Location Freshness & Heartbeat (Driver App)
1. Place **D1** online in foreground in Kailashahar. Keep the vehicle stationary.
2. Monitor network telemetry in DevTools or server logs.
3. **Verify**: Every 20 seconds, `driver-service.js` stationary heartbeat sends telemetry to `POST /api/rides/driver-location`.
4. Background the app on **D1** for 45 seconds.
5. **Verify**: Driver fix age reaches $> 30\text{s}$, `notificationEligibleUntil` remains valid, and driver receives reachability status (deprioritized with +5m penalty, not excluded).

### Step 3: Single Offer Exclusivity & Countdown
1. Position **D1** closer to **P1** than **D2**.
2. **P1** creates a ride request.
3. **Verify**:
   - Only **D1** receives the incoming ride offer card.
   - **D2** sees no notification or incoming offer.
   - Driver card counts down from **15 seconds** (synchronized with `currentOffer.expiresAt`).
   - `rides/{rideId}.eligible_driver_ids` contains only `["D1_UID"]`.

### Step 4: Decline & Rapid Re-dispatch
1. On **D1**, tap **Decline** before the 15-second timer expires.
2. **Verify**:
   - Ride status remains `"pending"`.
   - **D1**'s `dispatchLock` is released immediately.
   - **D1** is added to `rejected_driver_ids`.
   - Within 1–2 seconds, the offer is dispatched to **D2**.
   - **D2** accepts the ride. PIN is generated and trip state becomes `"accepted"`.

### Step 5: Passenger Search Expansion
1. Create a ride on **P1** with no drivers in the immediate vicinity (Ring 1).
2. Passenger screen shows searching animation. Tap **"Increase Search Radius"** (or wait 15s).
3. **Verify**:
   - `POST /api/rides/{rideId}/dispatch` is invoked.
   - `searchRing` increments from 1 to 2.
   - `eligible_driver_ids` is NOT polluted with legacy batch arrays.
   - Driver in adjacent hexagonal zone receives the exclusive offer.

---

## 3. Rollback Procedure

Since legacy dispatch code has been removed from the codebase, rollback is executed by reverting the deployment or deploying the tagged commit `pre-legacy-removal`:

### Option A: Redeploy Previous Deployment via Vercel / CI Dashboard (Fastest, < 1 min)
1. Open the Vercel or deployment dashboard.
2. Select the previous stable deployment tagged before `pre-legacy-removal`.
3. Click **Instant Rollback / Promote to Production**.

### Option B: Git Revert & Redeploy
```bash
# Checkout or revert to the pre-legacy-removal tag:
git revert HEAD -m 1
git push origin main
```

---

## 4. Operational Monitoring & Metrics

Monitor pilot health in Firebase Console / Firestore:
- **`dispatchMetrics` Collection**: Tracks every dispatch tick, solver execution time (target $< 10\text{ms}$), pending queue depth, and match count.
- **`dispatchShadowLogs` Collection**: If shadow mode was run prior to pilot, contains historical side-by-side comparison logs.
- **`driverDailyStats` Collection**: Tracks driver acceptance and decline counts.
