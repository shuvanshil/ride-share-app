/**
 * wake-lock.js
 * ---------------------------------------------------------------
 * Minimal Screen Wake Lock manager for the LiphtUp PWA.
 */

let wakeLockRef = null;
let isRideActive = false;
const isWakeLockSupported = 'wakeLock' in navigator;

async function requestWakeLock() {
    if (!isWakeLockSupported || !isRideActive || wakeLockRef) return;

    try {
        wakeLockRef = await navigator.wakeLock.request('screen');

        wakeLockRef.addEventListener('release', () => {
            wakeLockRef = null;
        });

        console.log('Wake Lock acquired: screen will stay on during the ride.');
    } catch (error) {
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

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isRideActive) {
        await requestWakeLock();
    }
});

export async function setRideActive(active) {
    isRideActive = Boolean(active);

    if (isRideActive) {
        await requestWakeLock();
    } else {
        await releaseWakeLock();
    }
}

export function isWakeLockAvailable() {
    return isWakeLockSupported;
}

/**
 * 5. Optional: expose current lock status for debugging/UI badges.
 */
export function isWakeLockHeld() {
    return wakeLockRef !== null;
}
