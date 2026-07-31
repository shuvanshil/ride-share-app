/**
 * wake-lock.js
 * ---------------------------------------------------------------
 * Minimal Screen Wake Lock manager for the LiphtUp PWA.
 */

// Holds the active WakeLockSentinel object (or null if not held).
let wakeLockRef = null;

// Placeholder/state flag: only re-acquire the lock while this is true.
// Toggle it with setRideActive() from wherever your ride lifecycle
// events already live (e.g. "passenger-service-lock-changed",
// "ride-completed-clear-map" in map.js).
let isRideActive = false;

// Feature detection — bail out silently on unsupported browsers
// (older Safari/iOS, some older Android WebViews, etc.).
const isWakeLockSupported = 'wakeLock' in navigator;

/**
 * 1. Robust async request with try/catch.
 * Requests a 'screen' wake lock and stores the sentinel reference.
 * Safe to call repeatedly — it no-ops if unsupported, if a ride
 * isn't active, or if a lock is already held.
 */
async function requestWakeLock() {
    if (!isRideActive || wakeLockRef) return;

    if (!isWakeLockSupported) {
        console.warn('Wake Lock API not supported on this browser/OS version.');
        return;
    }

    try {
        wakeLockRef = await navigator.wakeLock.request('screen');

        // If the lock is released for any reason outside our control
        // (OS-level battery saver, tab switch, etc.), clear our
        // reference so future logic knows it needs to be re-requested.
        wakeLockRef.addEventListener('release', () => {
            wakeLockRef = null;
        });

        console.log('Wake Lock acquired: screen will stay on during the ride.');
    } catch (error) {
        // Common causes: permission denied, low battery mode, or the
        // document isn't visible yet. Never let this break the app.
        wakeLockRef = null;
        console.warn('Wake Lock request failed:', error.name, error.message);
    }
}

/**
 * Releases the wake lock, if one is currently held.
 */
async function releaseWakeLock() {
    if (!wakeLockRef) return;

    try {
        await wakeLockRef.release();
    } catch (error) {
        console.warn('Wake Lock release failed:', error.name, error.message);
    } finally {
        wakeLockRef = null;
    }
}

/**
 * 2. Visibility state handling.
 * Mobile browsers automatically release the wake lock when the tab
 * is backgrounded/minimized. When the user returns to the app, we
 * re-acquire it — but only if a ride is still active.
 */
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isRideActive) {
        await requestWakeLock();
    }
});

/**
 * 3. State-conditioned activation (public API).
 * Call this from your ride lifecycle code:
 *   - setRideActive(true)  when a ride is booked / dispatch begins
 *   - setRideActive(false) when the ride is completed / cancelled
 *
 * This is the single entry point the rest of the app should use —
 * it keeps the wake lock in sync with `isRideActive` automatically.
 */
export async function setRideActive(active) {
    isRideActive = Boolean(active);

    if (isRideActive) {
        await requestWakeLock();
    } else {
        await releaseWakeLock();
    }
}

/**
 * 4. Graceful fallback helper, exposed in case you want to show a
 * UI hint (e.g. "Keep this screen on" tip) on unsupported browsers
 * such as iOS Safari < 16.4.
 */
export function isWakeLockAvailable() {
    return isWakeLockSupported;
}

/**
 * 5. Optional: expose current lock status for debugging/UI badges.
 */
export function isWakeLockHeld() {
    return wakeLockRef !== null;
}
