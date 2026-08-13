import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeMapEngine, useCurrentPickupLocation, warmGoogleMaps } from './map.js?v=20260731-passenger-nav-camera';
import { getRideService } from './fare-policy.js';
import { acquireWakeLock, releaseWakeLock } from '../platform/wake-lock.js';
import { setInlineLoading, hideInitialLoader } from './loading.js';
import { waitForAuth } from './auth.js';

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
const swapLocationsBtn = document.getElementById('swap-locations-btn');
const selectOnMapBtn = document.getElementById('select-on-map-btn');

let servicesSessionStarted = false;
let selectedServiceType = "auto";
let serviceSelectionLocked = false;
let isAuthenticatedPassenger = false;
let currentPickup = null;
const requestedDestination = new URLSearchParams(window.location.search).get("destination")?.trim() || "";

warmGoogleMaps();

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
    const headingCopy = serviceOptions.querySelector('.ride-service-heading p');
    if (headingCopy) {
        headingCopy.innerText = quote.is_night_fare
            ? "Night fare applies from 10:00 PM to 4:30 AM."
            : "Fares use the calculated road distance.";
    }
    serviceOptions.classList.remove('d-none');
    selectRideService(selectedServiceType);
}

function resetFareOptions() {
    if (serviceSelectionLocked) return;
    window.selectedRideService = null;
    serviceOptions.classList.add('d-none');
    findRideBtn.innerHTML = dropInput.value.trim()
        ? '<span class="lu-spinner lu-spinner-sm" aria-hidden="true"></span><span>Calculating route...</span>'
        : "Please enter destination";
    findRideBtn.disabled = true;
}

function setServiceSelectionLocked(detail = {}) {
    serviceSelectionLocked = Boolean(detail.locked);
    serviceOptions.classList.toggle('is-locked', serviceSelectionLocked);
    if (serviceSelectionLocked) acquireWakeLock(); else releaseWakeLock();

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
    setInlineLoading(gpsPill, state === "loading");
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

function requestPrefilledDestination() {
    if (!requestedDestination || window.selectedDestination) return;
    dropInput.value = requestedDestination;
    window.dispatchEvent(new CustomEvent('prefill-destination-request', {
        detail: { query: requestedDestination }
    }));
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
        setStatus("Detecting your current pickup location...", "loading");
        await useCurrentPickupLocation();
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    } catch (error) {
        console.error("Services location refresh failed:", error);
        setStatus("Could not refresh location. Check GPS permission.", "error");
    }
}

function swapLocations() {
    if (serviceSelectionLocked) return;
    const pLoc = currentPickup;
    const dLoc = window.selectedDestination;

    if (!pLoc || !dLoc) return;

    // Local swap of values for immediate feedback
    pickupInput.value = dLoc.name || dLoc.mainName;
    dropInput.value = pLoc.name || pLoc.mainName;

    window.dispatchEvent(new CustomEvent('locations-swapped', {
        detail: { pickup: dLoc, destination: pLoc }
    }));
}

function bindServicesControls() {
    refreshLocationBtn.addEventListener('click', refreshServicesMap);
    if (swapLocationsBtn) swapLocationsBtn.addEventListener('click', swapLocations);
    if (selectOnMapBtn) {
        selectOnMapBtn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('request-destination-pick-on-map'));
        });
    }


    if (clearDropBtn) {
        clearDropBtn.addEventListener('click', () => {
            if (dropInput.readOnly) return;
            dropInput.value = "";
            dropInput.dispatchEvent(new Event('input', { bubbles: true }));
            dropInput.focus();
        });
    }

    dropInput.addEventListener('input', () => {
        resetFareOptions();
    });

    document.querySelectorAll('[data-service-type]').forEach((card) => {
        card.addEventListener('click', () => selectRideService(card.dataset.serviceType));
    });

    window.addEventListener('fare-quote-updated', (event) => renderFareOptions(event.detail));
    window.addEventListener('fare-quote-reset', resetFareOptions);
    window.addEventListener('passenger-service-lock-changed', (event) => setServiceSelectionLocked(event.detail));
    window.addEventListener('ride-completed-clear-map', () => releaseWakeLock());

    window.addEventListener('map-engine-ready', () => {
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
        requestPrefilledDestination();
    });

    window.addEventListener('pickup-location-updated', (event) => {
        currentPickup = event.detail;
        setStatus(event.detail?.name || "Pickup location detected.", "ready");
    });

    if (findRideBtn) {
        findRideBtn.addEventListener('click', () => {
            if (!isAuthenticatedPassenger && window.selectedRideService) {
                openBookingLoginGate();
            }
        });
    }

    const loginBtn = document.getElementById('booking-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            window.location.href = '/login.html';
        });
    }

    const loginCloseBtn = document.getElementById('booking-login-close-btn');
    if (loginCloseBtn) loginCloseBtn.addEventListener('click', closeBookingLoginGate);

    if (bookingLoginGate) {
        bookingLoginGate.addEventListener('click', (event) => {
            if (event.target === bookingLoginGate) closeBookingLoginGate();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !bookingLoginGate.classList.contains('d-none')) {
            closeBookingLoginGate();
        }
    });
}

bindServicesControls();
findRideBtn.disabled = true;

async function bootstrapServices() {
    // Start guest services immediately if auth takes too long,
    // ensuring the map loads for everyone.
    const mapTimeout = setTimeout(() => {
        if (!servicesSessionStarted) startGuestServices();
    }, 2500);

    const user = await waitForAuth();
    clearTimeout(mapTimeout);

    if (!user) {
        startGuestServices();
        hideInitialLoader();
        return;
    }

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (!userDocSnap.exists()) {
            startGuestServices();
            hideInitialLoader();
            return;
        }

        const profile = userDocSnap.data();
        if (profile.role === "driver") {
            window.location.replace('/driver.html');
            return;
        }

        isAuthenticatedPassenger = true;
        setGuestLoginVisibility(false);
        showPassengerServices();

        if (!servicesSessionStarted) {
            servicesSessionStarted = true;
            window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
        }
        hideInitialLoader();
    } catch (error) {
        console.error("Services bootstrap failed:", error);
        startGuestServices();
        hideInitialLoader();
    }
}

bootstrapServices();
