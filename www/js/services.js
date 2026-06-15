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
const confirmRideView = document.getElementById('service-confirm-ride-view');
const confirmBackBtn = document.getElementById('service-confirm-back-btn');
const confirmRideBtn = document.getElementById('service-confirm-ride-btn');
const confirmPickupText = document.getElementById('confirm-pickup-text');
const confirmDropText = document.getElementById('confirm-drop-text');
const confirmDistanceText = document.getElementById('confirm-distance-text');
const confirmDurationText = document.getElementById('confirm-duration-text');
const confirmBikeFare = document.getElementById('confirm-bike-fare');
const confirmAutoFare = document.getElementById('confirm-auto-fare');
const vehicleOptions = Array.from(document.querySelectorAll('.service-vehicle-option'));

let servicesSessionStarted = false;
let selectedVehicleType = "bike";
let confirmFares = {
    bike: 0,
    auto: 0
};

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

function showConfirmRideView() {
    dashboardView.classList.add('d-none');
    confirmRideView.classList.remove('d-none');
}

function hideConfirmRideView() {
    confirmRideView.classList.add('d-none');
    dashboardView.classList.remove('d-none');
}

function parseFareAmount(fareText) {
    return Math.max(0, Math.round(Number(String(fareText || "").replace(/[^\d.]/g, "")) || 0));
}

function formatFare(amount) {
    return `₹${Math.round(Number(amount) || 0)}`;
}

function updateVehicleSelection(vehicleType) {
    selectedVehicleType = vehicleType;
    window.selectedServiceVehicleType = vehicleType;

    vehicleOptions.forEach((option) => {
        const isActive = option.dataset.vehicle === vehicleType;
        option.classList.toggle('active', isActive);
        option.querySelector('i').innerText = isActive ? "✓" : "";
    });
}

function openConfirmRide(detail) {
    const baseBikeFare = parseFareAmount(detail.fareText);
    confirmFares = {
        bike: baseBikeFare,
        auto: Math.max(baseBikeFare + 20, Math.round(baseBikeFare * 1.3))
    };

    confirmPickupText.innerText = detail.pickupText || "Pickup location";
    confirmDropText.innerText = detail.dropText || "Drop location";
    confirmDistanceText.innerText = detail.fareQuote?.distance_km
        ? `${Number(detail.fareQuote.distance_km).toFixed(1)} km`
        : "Route";
    confirmDurationText.innerText = detail.fareQuote?.duration_minutes
        ? `${Math.round(Number(detail.fareQuote.duration_minutes))} mins`
        : "ETA";
    confirmBikeFare.innerText = formatFare(confirmFares.bike);
    confirmAutoFare.innerText = formatFare(confirmFares.auto);
    updateVehicleSelection("bike");
    showConfirmRideView();
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

    window.addEventListener('service-confirm-ride-requested', (event) => {
        openConfirmRide(event.detail || {});
    });

    confirmBackBtn.addEventListener('click', hideConfirmRideView);

    vehicleOptions.forEach((option) => {
        option.addEventListener('click', () => updateVehicleSelection(option.dataset.vehicle || "bike"));
    });

    confirmRideBtn.addEventListener('click', () => {
        const selectedFare = confirmFares[selectedVehicleType] || confirmFares.bike;
        document.getElementById('fare-amount').innerText = formatFare(selectedFare);
        findRideBtn.dataset.serviceRideConfirmed = "true";
        findRideBtn.dataset.vehicleType = selectedVehicleType;
        window.selectedServiceVehicleType = selectedVehicleType;
        hideConfirmRideView();
        findRideBtn.click();
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
