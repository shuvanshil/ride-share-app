/**
 * Platform adapter for Screen Wake Lock.
 * Uses the browser Wake Lock API on web and @capacitor-community/keep-awake on native.
 */

let wakeLockSentinel = null;
const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

/**
 * Acquires a screen wake lock.
 */
export async function acquireWakeLock() {
    if (isNative) {
        console.log('[platform/wake-lock] acquiring native keep-awake...');
        try {
            const KeepAwake = window.Capacitor.Plugins.KeepAwake;
            if (KeepAwake) {
                await KeepAwake.keepAwake();
                console.log('[platform/wake-lock] native keep-awake acquired.');
                return true;
            }
        } catch (error) {
            console.error('[platform/wake-lock] native keep-awake failed:', error);
        }
        return false;
    }

    // Web Implementation
    if (!('wakeLock' in navigator)) {
        return false;
    }

    // Browser Wake Lock API requires the tab to be actively visible
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return false;
    }

    try {
        if (wakeLockSentinel) return true;
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
            console.log('[platform/wake-lock] web wake lock released.');
            wakeLockSentinel = null;
        });
        console.log('[platform/wake-lock] web wake lock acquired.');
        return true;
    } catch (error) {
        if (error.name === 'NotAllowedError') {
            // Benign browser restriction when tab is in background
            return false;
        }
        console.warn('[platform/wake-lock] web wake lock request failed:', error);
        return false;
    }
}

/**
 * Releases the screen wake lock.
 */
export async function releaseWakeLock() {
    if (isNative) {
        try {
            const KeepAwake = window.Capacitor.Plugins.KeepAwake;
            if (KeepAwake) {
                await KeepAwake.allowSleep();
                console.log('[platform/wake-lock] native keep-awake released.');
            }
        } catch (error) {
            console.error('[platform/wake-lock] native allowSleep failed:', error);
        }
        return;
    }

    // Web Implementation
    if (wakeLockSentinel) {
        try {
            await wakeLockSentinel.release();
            wakeLockSentinel = null;
        } catch (error) {
            console.warn('[platform/wake-lock] web wake lock release failed:', error);
        }
    }
}

/**
 * Re-acquires the wake lock if the document becomes visible again (Web only).
 * Capacitor plugin handles app lifecycle internally.
 */
if (!isNative) {
    document.addEventListener('visibilitychange', async () => {
        if (wakeLockSentinel !== null && document.visibilityState === 'visible') {
            await acquireWakeLock();
        }
    });
}
