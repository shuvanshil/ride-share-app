import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeMapEngine } from './map.js';

const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const pickupInput = document.getElementById('pickup-input');
const dropInput = document.getElementById('drop-input');
const findRideBtn = document.getElementById('request-ride-btn');
const refreshLocationBtn = document.getElementById('refresh-location-btn');
const clearDropBtn = document.getElementById('clear-drop-btn');
const locationStatus = document.getElementById('services-location-status');
const gpsPill = document.getElementById('services-gps-pill');

let servicesSessionStarted = false;

function setStatus(message, state = "loading") {
    if (locationStatus) locationStatus.innerText = message;
    if (!gpsPill) return;

    gpsPill.dataset.state = state;
    gpsPill.innerText = state === "ready" ? "Live" : state === "error" ? "Check" : "GPS";
}

function showAuthGuard(title, message) {
    dashboardView.classList.add('d-none');
    authView.classList.remove('d-none');

    const heading = authView.querySelector('h1');
    const copy = authView.querySelector('p');
    if (heading) heading.innerText = title;
    if (copy) copy.innerText = message;
}

function showPassengerServices() {
    authView.classList.add('d-none');
    dashboardView.classList.remove('d-none');
}

async function refreshServicesMap() {
    try {
        setStatus("Refreshing your exact pickup location...", "loading");
        await initializeMapEngine();
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    } catch (error) {
        console.error("Services location refresh failed:", error);
        setStatus("Could not refresh location. Check GPS permission.", "error");
    }
}

function bindServicesControls() {
    refreshLocationBtn.addEventListener('click', refreshServicesMap);

    clearDropBtn.addEventListener('click', () => {
        if (dropInput.readOnly) return;
        dropInput.value = "";
        dropInput.dispatchEvent(new Event('input', { bubbles: true }));
        dropInput.focus();
    });

    dropInput.addEventListener('input', () => {
        findRideBtn.disabled = !dropInput.value.trim();
    });

    window.addEventListener('map-engine-ready', () => {
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    });
}

bindServicesControls();
findRideBtn.disabled = true;

onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
        showAuthGuard("Login required", "Please login before booking your ride.");
        return;
    }

    try {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!userSnap.exists()) {
            showAuthGuard("Profile incomplete", "Please complete your GoYatra profile before booking.");
            return;
        }

        const profile = userSnap.data();
        if (profile.role === "driver") {
            showAuthGuard("Passenger service only", "Drivers can manage ride requests from the Home duty console.");
            return;
        }

        showPassengerServices();

        if (!servicesSessionStarted) {
            servicesSessionStarted = true;
            window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
        }
    } catch (error) {
        console.error("Services auth bootstrap failed:", error);
        showAuthGuard("Could not load account", "Please check your internet connection and try again.");
    }
});
