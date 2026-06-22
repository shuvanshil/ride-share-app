import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeMapEngine } from './map.js';
import { getRideService } from './fare-policy.js';

const dashboardView = document.getElementById('dashboard-view');
const pickupInput = document.getElementById('pickup-input');
const dropInput = document.getElementById('drop-input');
const findRideBtn = document.getElementById('request-ride-btn');
const refreshLocationBtn = document.getElementById('refresh-location-btn');
const clearDropBtn = document.getElementById('clear-drop-btn');
const locationStatus = document.getElementById('services-location-status');
const gpsPill = document.getElementById('services-gps-pill');
const serviceOptions = document.getElementById('ride-service-options');
const distanceLabel = document.getElementById('ride-distance-label');
const bookingLoginGate = document.getElementById('booking-login-gate');

let servicesSessionStarted = false;
let selectedServiceType = "bike";
let serviceSelectionLocked = false;
let isAuthenticatedPassenger = false;

function selectRideService(serviceType) {
    if (serviceSelectionLocked) return;
    const service = getRideService(serviceType);
    const fare = window.latestFareQuote?.fare_options?.[serviceType];
    if (!service || !Number.isFinite(fare)) return;

    selectedServiceType = serviceType;
    window.selectedRideService = { ...service, fare };
    document.querySelectorAll('[data-service-type]').forEach((card) => {
        const selected = card.dataset.serviceType === serviceType;
        card.classList.toggle('is-selected', selected);
        card.setAttribute('aria-pressed', String(selected));
    });
    document.getElementById('fare-amount').innerText = `₹${fare}`;
    findRideBtn.innerText = `Confirm ${service.shortName} · ₹${fare}`;
    findRideBtn.disabled = false;
}

function renderFareOptions(quote) {
    if (!quote?.fare_options) return;
    document.getElementById('bike-fare').innerText = `₹${quote.fare_options.bike}`;
    document.getElementById('auto-fare').innerText = `₹${quote.fare_options.auto}`;
    distanceLabel.innerText = `${Number(quote.distance_km).toFixed(1)} km`;
    serviceOptions.classList.remove('d-none');
    selectRideService(selectedServiceType);
}

function resetFareOptions() {
    if (serviceSelectionLocked) return;
    window.selectedRideService = null;
    serviceOptions.classList.add('d-none');
    findRideBtn.innerText = "Calculating route...";
    findRideBtn.disabled = true;
}

function setServiceSelectionLocked(detail = {}) {
    serviceSelectionLocked = Boolean(detail.locked);
    serviceOptions.classList.toggle('is-locked', serviceSelectionLocked);

    const headingCopy = serviceOptions.querySelector('.ride-service-heading p');
    if (headingCopy) {
        headingCopy.innerText = serviceSelectionLocked
            ? "Vehicle locked for your active ride."
            : "Fares use the calculated road distance.";
    }

    document.querySelectorAll('[data-service-type]').forEach((card) => {
        const selected = serviceSelectionLocked && card.dataset.serviceType === detail.vehicleType;
        card.disabled = serviceSelectionLocked;
        if (serviceSelectionLocked) {
            card.classList.toggle('is-selected', selected);
            card.setAttribute('aria-pressed', String(selected));
        }
    });

    if (!serviceSelectionLocked) return;

    selectedServiceType = detail.vehicleType;
    const service = getRideService(selectedServiceType);
    if (!service) return;

    serviceOptions.classList.remove('d-none');
    window.selectedRideService = { ...service, fare: detail.fare };
    if (Number.isFinite(detail.fare)) {
        document.getElementById(`${selectedServiceType}-fare`).innerText = `₹${detail.fare}`;
        document.getElementById('fare-amount').innerText = `₹${detail.fare}`;
    }
    if (Number.isFinite(detail.distanceKm)) {
        distanceLabel.innerText = `${detail.distanceKm.toFixed(1)} km`;
    }
}

function setStatus(message, state = "loading") {
    if (locationStatus) locationStatus.innerText = message;
    if (!gpsPill) return;

    gpsPill.dataset.state = state;
    gpsPill.innerText = state === "ready" ? "Live" : state === "error" ? "Check" : "GPS";
}

function showPassengerServices() {
    dashboardView.classList.remove('d-none');
}

function setGuestLoginVisibility(visible) {
    document.querySelectorAll('.guest-login-btn').forEach((button) => {
        button.classList.toggle('d-none', !visible);
    });
}

function openBookingLoginGate() {
    bookingLoginGate.classList.remove('d-none');
}

function closeBookingLoginGate() {
    bookingLoginGate.classList.add('d-none');
}

function startGuestServices() {
    isAuthenticatedPassenger = false;
    setGuestLoginVisibility(true);
    showPassengerServices();
    if (!servicesSessionStarted) {
        servicesSessionStarted = true;
        initializeMapEngine().catch((error) => {
            console.error("Guest map initialization failed:", error);
            setStatus("Could not load the map. Check location permission.", "error");
        });
    }
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
        resetFareOptions();
    });

    document.querySelectorAll('[data-service-type]').forEach((card) => {
        card.addEventListener('click', () => selectRideService(card.dataset.serviceType));
    });

    window.addEventListener('fare-quote-updated', (event) => renderFareOptions(event.detail));
    window.addEventListener('fare-quote-reset', resetFareOptions);
    window.addEventListener('passenger-service-lock-changed', (event) => setServiceSelectionLocked(event.detail));

    window.addEventListener('map-engine-ready', () => {
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    });

    window.addEventListener('pickup-location-updated', (event) => {
        setStatus(event.detail?.name || "Manual pickup selected.", "ready");
    });

    findRideBtn.addEventListener('click', () => {
        if (!isAuthenticatedPassenger && window.selectedRideService) {
            openBookingLoginGate();
        }
    });
    document.getElementById('booking-login-btn').addEventListener('click', () => {
        window.location.href = 'login.html';
    });
    document.getElementById('booking-login-close-btn').addEventListener('click', closeBookingLoginGate);
    bookingLoginGate.addEventListener('click', (event) => {
        if (event.target === bookingLoginGate) closeBookingLoginGate();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !bookingLoginGate.classList.contains('d-none')) {
            closeBookingLoginGate();
        }
    });
}

bindServicesControls();
findRideBtn.disabled = true;

onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
        startGuestServices();
        return;
    }

    try {
        const userSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!userSnap.exists()) {
            startGuestServices();
            return;
        }

        const profile = userSnap.data();
        if (profile.role === "driver") {
            window.location.replace('driver.html');
            return;
        }

        isAuthenticatedPassenger = true;
        setGuestLoginVisibility(false);
        showPassengerServices();

        if (!servicesSessionStarted) {
            servicesSessionStarted = true;
            window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
        }
    } catch (error) {
        console.error("Services auth bootstrap failed:", error);
        startGuestServices();
    }
});
