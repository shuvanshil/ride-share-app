import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert } from './dialog.js';
import { hideInitialLoader } from './loading.js';
import { markCurrentDriverOffline } from './driver-availability.js';

const PROFILE_CACHE_KEY = "liphtup_user_profile";
let sessionReadyDispatched = false;
let authInitialized = false;

/**
 * Returns a promise that resolves when Firebase Auth has finished its initial
 * state check. This prevents "Authentication is required" race conditions.
 */
export function waitForAuth() {
    return new Promise((resolve) => {
        if (authInitialized) {
            resolve(auth.currentUser);
            return;
        }
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            authInitialized = true;
            resolve(user);
        });
    });
}

/**
 * Helper to get an ID token, waiting for auth to initialize first.
 */
export async function getAuthToken() {
    const user = await waitForAuth();
    if (!user) return null;
    return user.getIdToken();
}

function getCachedProfile() {
    try {
        const cached = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null");
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
    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole(profile?.role || "");
    }
    try {
        sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        }));
    } catch (error) {
        console.warn("Could not cache profile for fast navigation:", error);
    }
}

function clearCachedProfile() {
    try {
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
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
        if (!isDriverPage && !isHistoryPage && !isProfilePage && !isLoginPage) {
            window.location.replace("/driver.html");
            return true;
        } else {
            setGuestLoginVisibility(false);
        }
    } else {
        if (isDriverPage) {
            window.location.replace("/index.html");
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
    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole(profile?.role || "");
    }
    window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));

    // Only hide if we aren't mid-redirect
    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));
    const isDriverPage = isCurrent('driver.html') || isCurrent('driver-service.html');
    const roleMismatch = (profile.role === "driver" && !isDriverPage) || (profile.role !== "driver" && isDriverPage);

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

bootstrapFromCache();

document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
        showPageLoader("Logging out...");
        clearCachedProfile();
        if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
            window.LiphtUpNative.setUserRole("");
        }
        // Fire and forget driver offline update
        markCurrentDriverOffline();
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
        if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
            window.LiphtUpNative.setUserRole("");
        }
        setGuestLoginVisibility(true);
        // Only redirect to home if we aren't already on a guest-allowed page
        const isProtectedPage = window.location.pathname.includes('driver.html') ||
                                window.location.pathname.includes('history.html');
        if (isProtectedPage) {
            window.location.replace("/login.html");
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
