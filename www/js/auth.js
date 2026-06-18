import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "goyatra_user_profile";
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
    document.getElementById('driver-view')?.classList.add('d-none');
    document.getElementById('driver-view')?.classList.remove('d-flex');
    document.getElementById('driver-review-view')?.classList.add('d-none');
    document.getElementById('driver-review-view')?.classList.remove('d-flex');
}

function showDriverReview(profile) {
    document.getElementById('dashboard-view')?.classList.add('d-none');
    document.getElementById('dashboard-view')?.classList.remove('d-flex');
    document.getElementById('driver-view')?.classList.add('d-none');
    document.getElementById('driver-view')?.classList.remove('d-flex');

    const vehicleModel = profile.vehicleModel || profile.vehicle_model || "";
    const vehicleNumber = profile.vehicleNumber || profile.vehicle_number || "";
    const vehicleSummary = [vehicleModel, vehicleNumber].filter(Boolean).join(" - ") || "Not submitted";

    const statusEl = document.getElementById('driver-review-status');
    const vehicleEl = document.getElementById('driver-review-vehicle');
    const licenseEl = document.getElementById('driver-review-license');
    if (statusEl) statusEl.innerText = profile.verificationStatus || "pending_review";
    if (vehicleEl) vehicleEl.innerText = vehicleSummary;
    if (licenseEl) licenseEl.innerText = profile.drivingLicenseNumber || "Not submitted";

    document.getElementById('driver-review-view')?.classList.remove('d-none');
    document.getElementById('driver-review-view')?.classList.add('d-flex');
}

function showDriverHome(profile) {
    document.getElementById('dashboard-view')?.classList.add('d-none');
    document.getElementById('dashboard-view')?.classList.remove('d-flex');
    document.getElementById('driver-review-view')?.classList.add('d-none');
    document.getElementById('driver-review-view')?.classList.remove('d-flex');
    document.getElementById('driver-view')?.classList.remove('d-none');
    document.getElementById('driver-view')?.classList.add('d-flex');

    const welcomeName = document.getElementById('driver-welcome-name');
    if (welcomeName) welcomeName.innerText = `Welcome, ${profile.name || "Driver"}`;
}

function renderSession(profile) {
    if (profile.role === "driver") {
        if (profile.verificationStatus === "approved") {
            showDriverHome(profile);
        } else {
            showDriverReview(profile);
        }
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
        alert("Could not logout. Please try again.");
    }
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        clearCachedProfile();
        window.location.replace("login.html");
        return;
    }

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (!userDocSnap.exists()) {
            clearCachedProfile();
            window.location.replace("login.html");
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
