import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { createBaseTileLayer, initializeMapEngine } from './map.js';

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
let confirmMapInstance = null;
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
    // Services is a separate page, so this swaps local page panels instead of
    // navigating away from the shared app.js lifecycle engine.
    dashboardView.classList.add('d-none');
    confirmRideView.classList.remove('d-none');
}

function hideConfirmRideView() {
    confirmRideView.classList.add('d-none');
    dashboardView.classList.remove('d-none');
}

function resetConfirmMap() {
    if (confirmMapInstance) {
        confirmMapInstance.remove();
        confirmMapInstance = null;
    }
}

function parseFareAmount(fareText) {
    return Math.max(0, Math.round(Number(String(fareText || "").replace(/[^\d.]/g, "")) || 0));
}

function formatFare(amount) {
    return `₹${Math.round(Number(amount) || 0)}`;
}

function updateVehicleSelection(vehicleType) {
    selectedVehicleType = vehicleType;
    // app.js reads this value after Services confirms the ride.
    window.selectedServiceVehicleType = vehicleType;

    vehicleOptions.forEach((option) => {
        const isActive = option.dataset.vehicle === vehicleType;
        option.classList.toggle('active', isActive);
        option.querySelector('i').innerText = isActive ? "✓" : "";
    });
}

function createConfirmIcon(type) {
    const isPickup = type === "pickup";
    return window.L.divIcon({
        className: `service-confirm-marker ${type}`,
        html: isPickup
            ? '<span class="confirm-pickup-dot"></span>'
            : `<svg width="28" height="34" viewBox="0 0 28 34" aria-hidden="true">
                <path d="M14 33C14 33 26 20.7 26 12.8C26 6.3 20.6 1 14 1C7.4 1 2 6.3 2 12.8C2 20.7 14 33 14 33Z" fill="#EF4444" stroke="#fff" stroke-width="3"/>
                <circle cx="14" cy="12.8" r="4.2" fill="#fff"/>
            </svg>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });
}

async function fetchConfirmRoute(origin, destination) {
    const fallback = [
        [origin.lat, origin.lng],
        [destination.lat, destination.lng]
    ];

    try {
        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
        const response = await fetch(routeUrl);
        const data = await response.json();
        const coordinates = data.routes?.[0]?.geometry?.coordinates;

        if (!Array.isArray(coordinates) || !coordinates.length) {
            return fallback;
        }

        return coordinates.map(([lng, lat]) => [lat, lng]);
    } catch (error) {
        console.warn("Confirm route fetch failed, using direct fallback:", error);
        return fallback;
    }
}

async function renderConfirmRouteMap(fareQuote) {
    const mapElement = document.getElementById('service-confirm-map');
    if (!mapElement || !window.L) return;

    const origin = {
        lat: Number(fareQuote?.pickup_lat),
        lng: Number(fareQuote?.pickup_lng)
    };
    const destination = {
        lat: Number(fareQuote?.drop_lat),
        lng: Number(fareQuote?.drop_lng)
    };

    if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) {
        return;
    }

    resetConfirmMap();
    confirmMapInstance = window.L.map(mapElement, {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: true,
        minZoom: 10,
        maxZoom: 19
    });

    createBaseTileLayer(window.L).addTo(confirmMapInstance);

    const routeCoords = await fetchConfirmRoute(origin, destination);
    const routeGlow = window.L.polyline(routeCoords, {
        color: '#fff',
        weight: 10,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(confirmMapInstance);

    const routeLine = window.L.polyline(routeCoords, {
        color: '#1A7A2E',
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(confirmMapInstance);

    window.L.marker([origin.lat, origin.lng], { icon: createConfirmIcon("pickup") }).addTo(confirmMapInstance);
    window.L.marker([destination.lat, destination.lng], { icon: createConfirmIcon("drop") }).addTo(confirmMapInstance);
    confirmMapInstance.fitBounds(routeLine.getBounds(), { padding: [42, 42] });

    setTimeout(() => {
        confirmMapInstance?.invalidateSize();
        confirmMapInstance?.fitBounds(routeGlow.getBounds(), { padding: [42, 42] });
    }, 80);
}

function openConfirmRide(detail) {
    // app.js dispatches this payload after fare calculation, before Firestore create.
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
    renderConfirmRouteMap(detail.fareQuote || {});
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
        confirmRideBtn.disabled = true;
        confirmRideBtn.innerText = "Starting search...";
        const selectedFare = confirmFares[selectedVehicleType] || confirmFares.bike;
        document.getElementById('fare-amount').innerText = formatFare(selectedFare);
        // These dataset values tell app.js to skip the Services confirm screen
        // and continue into the original Firestore ride creation flow.
        findRideBtn.dataset.serviceRideConfirmed = "true";
        findRideBtn.dataset.vehicleType = selectedVehicleType;
        window.selectedServiceVehicleType = selectedVehicleType;
        hideConfirmRideView();
        findRideBtn.click();
        confirmRideBtn.disabled = false;
        confirmRideBtn.innerText = "Confirm Ride";
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
