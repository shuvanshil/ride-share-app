import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert } from './dialog.js';

const PROFILE_CACHE_KEY = "liphtup_user_profile";
let sessionReadyDispatched = false;

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
    if (profile.role === "driver") {
        window.location.replace("driver.html");
    } else {
        showPassengerHome();
    }
}

function dispatchSessionReady(profile) {
    if (sessionReadyDispatched) return;
    sessionReadyDispatched = true;
    window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
}

function bootstrapFromCache() {
    const cachedProfile = getCachedProfile();
    if (!cachedProfile) return;
    renderSession(cachedProfile);
    dispatchSessionReady(cachedProfile);
}

bootstrapFromCache();

document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
        clearCachedProfile();
        await signOut(auth);
        window.location.href = "login.html";
    } catch (error) {
        console.error("Logout failed:", error);
        await showAlert("Could not logout. Please try again.");
    }
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        clearCachedProfile();
        setGuestLoginVisibility(true);
        showPassengerHome();
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
        renderSession(profile);
        dispatchSessionReady(profile);
    } catch (error) {
        console.warn("Existing auth session lookup failed:", error);
    }
});
