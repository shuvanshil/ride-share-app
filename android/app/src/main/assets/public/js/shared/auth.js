import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert } from './dialog.js';
import { hideInitialLoader, showPageLoader, hidePageLoader } from './loading.js';

import { unregisterDevicePushToken } from '../platform/notifications.js';
import { saveRememberedAccount, cleanupExpiredRememberedAccounts } from './remembered-accounts.js';

const PROFILE_CACHE_KEY = "liphtup_user_profile";
let sessionReadyDispatched = false;
let authInitialized = false;

const signOutHooks = [];

export function registerSignOutHook(fn) {
    if (typeof fn === 'function' && !signOutHooks.includes(fn)) {
        signOutHooks.push(fn);
    }
}

registerSignOutHook(async () => {
    await unregisterDevicePushToken().catch(() => {});
});

registerSignOutHook(async () => {
    try {
        const user = auth.currentUser;
        if (user) {
            const token = await user.getIdToken().catch(() => null);
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                }).catch(() => {});
            }
        }
    } catch (e) {}
});

/**
 * Returns a promise that resolves when Firebase Auth has finished its initial
 * state check. This prevents "Authentication is required" race conditions.
 */
export function waitForAuth(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (auth.currentUser) {
            authInitialized = true;
            resolve(auth.currentUser);
            return;
        }
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(auth.currentUser);
            }
        }, timeoutMs);

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                unsubscribe();
                authInitialized = true;
                resolve(user);
            }
        });
    });
}

/**
 * Helper to get an ID token, waiting for auth to initialize first.
 * Supports optional forced refresh (forceRefresh = true).
 */
export async function getAuthToken(forceRefresh = false) {
    let user = auth.currentUser;
    if (!user) {
        user = await waitForAuth().catch(() => null);
    }
    if (!user) return null;
    let token = await user.getIdToken(forceRefresh).catch(() => null);
    if (!token && !forceRefresh) {
        token = await user.getIdToken(true).catch(() => null);
    }
    return token;
}

/**
 * Authorized fetch wrapper that:
 * 1. Automatically attaches the Firebase ID token in Authorization header
 * 2. On 401 response, attempts a force token refresh and retries the request once
 * 3. On persistent 401 session expiration, alerts the user and redirects to login
 */
export async function authFetch(url, options = {}) {
    let token = await getAuthToken();
    const makeHeaders = (tok) => {
        const headers = new Headers(options.headers || {});
        if (tok) {
            headers.set('Authorization', `Bearer ${tok}`);
        }
        return headers;
    };

    let response = await fetch(url, {
        ...options,
        headers: makeHeaders(token)
    });

    if (response.status === 401) {
        // Try forced token refresh once
        const freshToken = await getAuthToken(true);
        if (freshToken) {
            response = await fetch(url, {
                ...options,
                headers: makeHeaders(freshToken)
            });
        }
    }

    if (response.status === 401) {
        try {
            const clone = response.clone();
            const data = await clone.json();
            const errMsg = String(data?.error || data?.detail || "");
            if (/inactivity|session expired|revoked|login again/i.test(errMsg)) {
                clearCachedProfile();
                await showAlert(data.error || "Your session has expired. Please login again.");
                const currentDest = window.location.pathname + window.location.search;
                const redirectUrl = `/login.html?redirect=${encodeURIComponent(currentDest)}`;
                window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(redirectUrl) : redirectUrl);
            }
        } catch (_) {}
    }

    return response;
}

if (typeof window !== 'undefined') {
    window.getAuthToken = getAuthToken;
    window.authFetch = authFetch;
}

function getCachedProfile() {
    try {
        let cached = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null");
        if (!cached?.uid) {
            cached = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "null");
        }
        if (!cached?.uid || Date.now() - Number(cached.cachedAt || 0) > 6 * 60 * 60 * 1000) {
            return null;
        }
        return cached;
    } catch {
        return null;
    }
}

function cacheProfile(profile) {
    const { createdAt, cachedAt, ...cacheableProfile } = profile;
    window.LIPHTUP_USER_ROLE = profile?.role || "passenger";
    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole(profile?.role || "");
    }
    try {
        const payload = JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        });
        sessionStorage.setItem(PROFILE_CACHE_KEY, payload);
        localStorage.setItem(PROFILE_CACHE_KEY, payload);
    } catch (error) {
        console.warn("Could not cache profile for fast navigation:", error);
    }
}

function clearCachedProfile() {
    window.LIPHTUP_USER_ROLE = "";
    try {
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
        localStorage.removeItem(PROFILE_CACHE_KEY);
    } catch {
        // Ignore storage failures; Firebase sign-out is the important operation.
    }
}

function showPassengerHome() {
    document.getElementById('dashboard-view')?.classList.remove('d-none');
    document.getElementById('dashboard-view')?.classList.add('d-flex');
}

function setGuestLoginVisibility(visible) {
    document.querySelectorAll('.guest-login-btn').forEach((button) => {
        button.classList.toggle('d-none', !visible);
    });
    const profileTrigger = document.getElementById('profile-menu-trigger');
    if (profileTrigger) {
        profileTrigger.classList.toggle('d-none', visible);
    }
}

function renderSession(profile) {
    setGuestLoginVisibility(false);

    // Use the native-bridge helper for robust page detection
    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));
    const isDriverPage = isCurrent('driver.html') || isCurrent('driver-service.html');
    const isHistoryPage = isCurrent('history.html');
    const isProfilePage = isCurrent('profile.html');
    const isLoginPage = isCurrent('login.html');

    if (profile.role === "driver") {
        const urlParams = new URLSearchParams(window.location.search);
        let pendingRideId = urlParams.get('rideId');
        if (!pendingRideId && window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.consumePendingRideId === 'function') {
            pendingRideId = window.LiphtUpNativeStatus.consumePendingRideId();
        }

        if (pendingRideId && (!isDriverPage || isCurrent('driver.html'))) {
            const targetUrl = `/driver-service.html?rideId=${encodeURIComponent(pendingRideId)}&from=push`;
            if (window.navigateToPage) {
                window.navigateToPage(targetUrl);
            } else {
                window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(targetUrl) : targetUrl);
            }
            return true;
        }

        if (!isDriverPage && !isHistoryPage && !isProfilePage && !isLoginPage) {
            window.location.replace(window.getPlatformUrl ? window.getPlatformUrl("/driver.html") : "/driver.html");
            return true;
        } else {
            setGuestLoginVisibility(false);
        }
    } else {
        if (isDriverPage) {
            window.location.replace(window.getPlatformUrl ? window.getPlatformUrl("/index.html") : "/index.html");
            return true;
        } else {
            showPassengerHome();
        }
    }
    return false;
}

function dispatchSessionReady(profile) {
    if (sessionReadyDispatched) return;
    sessionReadyDispatched = true;
    const role = profile?.role || "passenger";
    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole(role);
    }
    if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.setUserRole === 'function') {
        window.LiphtUpNativeStatus.setUserRole(role);
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SET_USER_ROLE', role: role });
    }
    window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
    if (profile) {
        saveRememberedAccount(profile);
    }
    if (auth.currentUser) {
        auth.currentUser.getIdToken().then((token) => {
            if (token) {
                fetch('/api/auth/activity', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                }).catch(() => {});
            }
        }).catch(() => {});
    }

    // Only hide if we aren't mid-redirect
    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));
    const isDriverPage = isCurrent('driver.html') || isCurrent('driver-service.html') || isCurrent('driver-payments.html');
    const roleMismatch = (profile.role === "driver" && !isDriverPage) || (profile.role !== "driver" && isDriverPage);

    if (profile.role !== "driver" && isDriverPage) {
        window.location.replace(window.getPlatformUrl ? window.getPlatformUrl("/index.html") : "/index.html");
        return;
    }

    if (!roleMismatch) {
        hideInitialLoader();
    }
}

function bootstrapFromCache() {
    // Only perform auto-routing if we are on the main entry page.
    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));
    const isEntryPage = isCurrent('index.html') || window.location.pathname === '/' || window.location.pathname === '';

    if (!isEntryPage) return;

    const cachedProfile = getCachedProfile();
    if (!cachedProfile) return;
    renderSession(cachedProfile);
    dispatchSessionReady(cachedProfile);
}

import { stopDriverTracking } from '../platform/geolocation.js';

bootstrapFromCache();

document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
        showPageLoader("Logging out...");
        clearCachedProfile();
        stopDriverTracking();
        window.dispatchEvent(new CustomEvent('user-logged-out'));
        if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
            window.LiphtUpNative.setUserRole("");
        }
        // Run registered sign-out hooks safely and await token unregistration
        for (const hook of signOutHooks) {
            try { await hook(); } catch (e) { console.warn("Signout hook error:", e); }
        }
        await signOut(auth);
        window.location.href = "/login.html";
    } catch (error) {
        console.error("Logout failed:", error);
        await showAlert("Could not logout. Please try again.");
    } finally {
        hidePageLoader({ force: true });
    }
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        clearCachedProfile();
        stopDriverTracking();
        window.dispatchEvent(new CustomEvent('user-logged-out'));
        if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
            window.LiphtUpNative.setUserRole("");
        }
        setGuestLoginVisibility(true);
        // Only redirect to login if we are on a protected page, and preserve target URL
        const isProtectedPage = window.location.pathname.includes('driver.html') ||
                                window.location.pathname.includes('driver-service.html') ||
                                window.location.pathname.includes('driver-payments.html') ||
                                window.location.pathname.includes('history.html');
        if (isProtectedPage) {
            const currentDest = window.location.pathname + window.location.search;
            const redirectUrl = `/login.html?redirect=${encodeURIComponent(currentDest)}`;
            window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(redirectUrl) : redirectUrl);
        } else {
            showPassengerHome();
        }
        hideInitialLoader();
        return;
    }

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (!userDocSnap.exists()) {
            clearCachedProfile();
            setGuestLoginVisibility(true);
            showPassengerHome();
            return;
        }

        const profile = userDocSnap.data();
        cacheProfile(profile);

        // Always dispatch session ready so role and events are synced on all pages
        dispatchSessionReady(profile);

        // Auto-register push notification token for all logged in users (passenger / driver)
        import('../platform/notifications.js').then(({ registerForPush, sendTokenToBackend }) => {
            registerForPush().then((res) => {
                if (res?.ok && res.token) {
                    sendTokenToBackend(res.token).catch(() => {});
                }
            }).catch(() => {});
        }).catch(() => {});

        // Only perform automatic routing/redirects if we are on the entry page (index.html)
        const path = window.location.pathname;
        const isEntryPage = path === "/" || path === "" || path.includes('index.html');

        if (isEntryPage) {
            renderSession(profile);
        } else {
            hideInitialLoader();
        }
    } catch (error) {
        console.warn("Existing auth session lookup failed:", error);
        hideInitialLoader();
    }
});
