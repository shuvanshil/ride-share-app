import { auth, db } from './firebase-init.js';
import { createRideMapSurface, fetchRoadRouteDetails, warmGoogleMaps } from './map.js';
import { setRideActive } from './wake-lock.js?v=20260712-wake-lock';
import {
    registerDriverPushToken,
    startRideRequestRing,
    stopRideRequestRing
} from './messaging.js?v=20260713-driver-push';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    increment,
    onSnapshot,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    updateDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const ACTIVE_RIDE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const ROUTE_RECALC_DISTANCE_METERS = 25;
const ROUTE_RECALC_MIN_INTERVAL_MS = 7000;
const LOCATION_WRITE_DISTANCE_METERS = 10;
const LOCATION_WRITE_MIN_INTERVAL_MS = 5000;
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;
const DRIVER_LOCATION_CACHE_KEY = "liphtup_last_driver_location";
const DEFAULT_DRIVER_LOCATION = Object.freeze({ lat: 24.3124, lng: 92.0135 });
const DRIVER_NAV_MODE_CACHE_KEY = "liphtup_driver_nav_mode";
const NAV_CAMERA_TILT = 55;
const NAV_CAMERA_ZOOM = 18;
const DRIVER_MARKER_ANIM_MIN_MS = 700;
const DRIVER_MARKER_ANIM_MAX_MS = 6000;
const DRIVER_MARKER_ANIM_DEFAULT_MS = 700;
const CAMERA_ROTATE_ANIM_MS = 700;

const mapHost = document.getElementById('driver-service-map');
const statusText = document.getElementById('driver-service-status');
const livePill = document.getElementById('driver-service-live-pill');
const routePanel = document.getElementById('driver-route-panel');
const routeLabel = document.getElementById('driver-route-label');
const routePlace = document.getElementById('driver-route-place');
const routeDistance = document.getElementById('driver-route-distance');
const routeDuration = document.getElementById('driver-route-duration');
const routeWarning = document.getElementById('driver-route-warning');
const messagePanel = document.getElementById('driver-map-message');
const messageTitle = document.getElementById('driver-map-message-title');
const messageCopy = document.getElementById('driver-map-message-copy');
const retryButton = document.getElementById('driver-location-retry-btn');
const openConsoleButton = document.getElementById('driver-open-console-btn');
const lifecyclePanel = document.getElementById('driver-service-lifecycle');
const lifecycleDetails = document.getElementById('driver-service-trip-details');
const completeButton = document.getElementById('driver-service-complete-btn');
const cancelButton = document.getElementById('driver-service-cancel-btn');
const paymentModal = document.getElementById('driver-service-payment-view');
const finalFareEl = document.getElementById('driver-service-final-fare');
const upiQrImage = document.getElementById('driver-service-upi-qr-image');
const closePaymentButton = document.getElementById('driver-service-close-payment-btn');
const requestsPanel = document.getElementById('driver-service-requests');
const ridesContainer = document.getElementById('driver-service-rides-list');
const noRidesMsg = document.getElementById('driver-service-no-rides-msg');

let currentUser = null;
let currentRide = null;
let currentRideId = null;
let currentTarget = null;
let currentTargetKey = "";
let currentRideStatus = "";
let pendingPaymentRideId = null;
let lifecycleGpsText = "GPS locking...";
let driverMarkerAnimationFrame = null;
let lastDriverHeading = null;
let incomingRideUnsubscribe = null;
let acceptRideInProgress = false;

warmGoogleMaps();

const VEHICLE_MARKER_ASSETS = Object.freeze({
    bike: new URL("../assets/vehicle-markers/bike-marker.png", import.meta.url).href,
    auto: new URL("../assets/vehicle-markers/auto-marker.png", import.meta.url).href
});

function cacheProfile(profile) {
    const { createdAt, cachedAt, ...cacheableProfile } = profile;
    try {
        sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        }));
    } catch (error) {
        console.warn("Could not cache driver profile:", error);
    }
}

function inferVehicleType(driver = {}) {
    const text = [
        driver.vehicle_type,
        driver.vehicleType,
        driver.vehicle_model,
        driver.vehicleModel,
        driver.vehicleName
    ].filter(Boolean).join(" ").toLowerCase();
    return /auto|rickshaw|tuk/.test(text) ? "auto" : "bike";
}

function getServiceLabel(vehicleType) {
    return vehicleType === "auto" ? "Auto" : "Bike / Scooty";
}

function getDriverRequestVehicleType(driver = {}) {
    const text = [
        driver.vehicle_type,
        driver.vehicleType,
        driver.vehicle_model,
        driver.vehicleModel,
        driver.vehicleName
    ].filter(Boolean).join(" ").toLowerCase();

    if (/auto|rickshaw|tuk/.test(text)) return "auto";
    if (/bike|scooter|scooty|activa|motorcycle/.test(text)) return "bike";
    return "";
}

function getLiveVehicleMarkerIcon() {
    const maps = window.google.maps;
    return {
        url: VEHICLE_MARKER_ASSETS[inferVehicleType(currentUser)],
        scaledSize: new maps.Size(48, 48),
        anchor: new maps.Point(24, 24)
    };
}

function normalizeHeading(value) {
    const heading = Number(value);
    return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
}

function shortestHeadingDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function smoothHeading(previousHeading, nextHeading, strength = 0.35) {
    const previous = normalizeHeading(previousHeading);
    const next = normalizeHeading(nextHeading);
    if (next == null) return previous;
    if (previous == null) return next;
    return normalizeHeading(previous + shortestHeadingDelta(previous, next) * strength);
}

function calculateBearing(from, to) {
    if (!from || !to) return null;

    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const deltaLng = (to.lng - from.lng) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

class RotatingVehicleMarker {
    constructor({ map: markerMap, position, title = "", vehicleType = "bike", heading = null, zIndex = 1000, live = false }) {
        this.position = position;
        this.heading = normalizeHeading(heading);
        this.overlay = new window.google.maps.OverlayView();
        this.element = document.createElement("div");
        this.element.className = "rotating-vehicle-marker";
        this.element.classList.toggle("is-live-tracked", Boolean(live));
        this.element.style.cssText = "position:absolute;width:48px;height:48px;pointer-events:auto;will-change:transform;animation:vehicle-marker-pop 260ms cubic-bezier(0.34,1.56,0.64,1);";
        this.element.style.zIndex = String(zIndex);
        this.element.title = title;
        this.image = document.createElement("img");
        this.image.alt = "";
        this.image.draggable = false;
        this.image.style.cssText = "width:48px;height:48px;object-fit:contain;transform-origin:50% 50%;filter:drop-shadow(0 3px 6px rgba(15,23,42,0.35));user-select:none;";
        this.element.appendChild(this.image);
        this.setVehicleType(vehicleType);
        this.setHeading(this.heading);

        this.overlay.onAdd = () => this.overlay.getPanes()?.overlayMouseTarget.appendChild(this.element);
        this.overlay.draw = () => this.draw();
        this.overlay.onRemove = () => this.element.remove();
        this.overlay.setMap(markerMap);
    }

    draw() {
        const projection = this.overlay.getProjection();
        if (!projection || !this.position) return;
        const point = projection.fromLatLngToDivPixel(new window.google.maps.LatLng(this.position.lat, this.position.lng));
        if (!point) return;
        this.element.style.transform = `translate(${point.x - 24}px, ${point.y - 24}px)`;
    }

    getPosition() {
        return new window.google.maps.LatLng(this.position.lat, this.position.lng);
    }

    setPosition(position) {
        this.position = position;
        this.draw();
    }

    setMap(markerMap) {
        this.overlay.setMap(markerMap);
    }

    setTitle(title = "") {
        this.element.title = title;
    }

    setVehicleType(vehicleType = "bike") {
        this.image.src = VEHICLE_MARKER_ASSETS[vehicleType] || VEHICLE_MARKER_ASSETS.bike;
    }

    setHeading(heading) {
        const normalized = normalizeHeading(heading);
        if (normalized == null) return;
        this.heading = normalized;
        this.image.style.transform = `rotate(${normalized}deg)`;
    }

    setLiveTracked(live) {
        this.element.classList.toggle("is-live-tracked", Boolean(live));
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatRideDistance(value) {
    const distance = Number(value);
    return Number.isFinite(distance) && distance > 0 ? `${distance.toFixed(1)} km` : "Not available";
}

function formatRideDuration(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? `${Math.round(duration)} mins` : "Not available";
}

function normalizeRideCoordinates(latValue, lngValue) {
    const lat = Number(latValue);
    const lng = Number(lngValue);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function getRideDisplayAddress(ride = {}, kind = "pickup") {
    const label = kind === "pickup" ? ride.pickup_name : ride.drop_name;
    const fallback = kind === "pickup" ? "Pickup location unavailable" : "Destination unavailable";
    const candidates = kind === "pickup"
        ? [ride.pickup_display_address, ride.pickup_formatted_address, ride.pickup_landmark, ride.pickup_name]
        : [ride.drop_display_address, ride.drop_formatted_address, ride.drop_full_address, ride.drop_landmark, ride.drop_name];
    const selected = candidates.map((value) => String(value || "").trim()).find(Boolean);
    const coords = kind === "pickup"
        ? normalizeRideCoordinates(ride.pickup_lat, ride.pickup_lng)
        : normalizeRideCoordinates(ride.drop_lat, ride.drop_lng);

    if (coords && (!selected || /^current location$/i.test(selected))) {
        return "Pinned location available - preview on map";
    }

    return selected || label || fallback;
}

function buildMapPreviewUrl(latValue, lngValue) {
    const coords = normalizeRideCoordinates(latValue, lngValue);
    if (!coords) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coords.lat},${coords.lng}`)}`;
}

function renderLocationPreviewLink(label, latValue, lngValue) {
    const url = buildMapPreviewUrl(latValue, lngValue);
    if (!url) return "";
    return `<a class="driver-location-preview-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

function updateIncomingRequestsVisibility() {
    if (!requestsPanel) return;
    requestsPanel.classList.toggle('d-none', Boolean(currentRideId));
}

function renderIncomingRideCard(rideId, ride = {}) {
    const passengerName = escapeHtml(ride.passenger_name || "Passenger");
    const serviceName = escapeHtml(ride.service_name || getServiceLabel(ride.vehicle_type));
    const passengerCapacity = Number(ride.passenger_capacity || (ride.vehicle_type === "auto" ? 4 : 1));
    const pickupName = escapeHtml(getRideDisplayAddress(ride, "pickup"));
    const dropName = escapeHtml(getRideDisplayAddress(ride, "drop"));
    const fare = escapeHtml(ride.fare || "0");
    const previewLinks = [
        renderLocationPreviewLink("Preview pickup", ride.pickup_lat, ride.pickup_lng),
        renderLocationPreviewLink("Preview destination", ride.drop_lat, ride.drop_lng)
    ].filter(Boolean).join("");

    const card = document.createElement('div');
    card.className = "driver-service-request-card";
    card.innerHTML = `
        <div class="driver-service-request-head">
            <div>
                <h6>${passengerName}</h6>
                <span>${serviceName} - ${passengerCapacity} passenger${passengerCapacity === 1 ? "" : "s"}</span>
            </div>
            <strong>Rs ${fare}</strong>
        </div>
        <div class="driver-service-request-route">
            <p><b>From:</b> ${pickupName}</p>
            <p><b>To:</b> ${dropName}</p>
            ${previewLinks ? `<div class="driver-location-preview-row">${previewLinks}</div>` : ""}
        </div>
        <div class="ride-request-metrics" aria-label="Ride distance and estimated time">
            <div>
                <small>Distance</small>
                <strong>${formatRideDistance(ride.distance_km)}</strong>
            </div>
            <div>
                <small>Estimated time</small>
                <strong>${formatRideDuration(ride.duration_minutes)}</strong>
            </div>
        </div>
        <button class="gy-btn gy-btn-primary driver-service-accept-btn" type="button" data-ride-id="${escapeHtml(rideId)}">
            Accept Ride Request
        </button>
    `;

    return card;
}

function renderNoIncomingRequests() {
    ridesContainer.innerHTML = "";
    ridesContainer.appendChild(noRidesMsg);
    noRidesMsg.querySelector('strong').innerText = "Searching nearby passengers";
    noRidesMsg.querySelector('p').innerText = "Keep this page open to receive targeted requests.";
    noRidesMsg.classList.remove('d-none');
}

function startIncomingRideListener() {
    if (!currentUser?.uid || !ridesContainer || !noRidesMsg) return;
    if (incomingRideUnsubscribe) incomingRideUnsubscribe();

    const incomingRideQuery = query(
        collection(db, "rides"),
        where("eligible_driver_ids", "array-contains", currentUser.uid)
    );

    incomingRideUnsubscribe = onSnapshot(incomingRideQuery, (snapshot) => {
        ridesContainer.innerHTML = "";
        ridesContainer.appendChild(noRidesMsg);
        noRidesMsg.classList.add('d-none');

        let renderedRideCount = 0;
        let firstPendingRide = null;
        const driverVehicleType = getDriverRequestVehicleType(currentUser);

        snapshot.forEach((docSnapshot) => {
            const ride = docSnapshot.data();
            if (ride.status !== "pending" || ride.driver_id) return;
            if (ride.vehicle_type && ride.vehicle_type !== driverVehicleType) return;

            renderedRideCount += 1;
            if (!firstPendingRide) {
                firstPendingRide = {
                    id: docSnapshot.id,
                    body: `${getRideDisplayAddress(ride, "pickup")} to ${getRideDisplayAddress(ride, "drop")}`
                };
            }
            ridesContainer.appendChild(renderIncomingRideCard(docSnapshot.id, ride));
        });

        if (renderedRideCount === 0) {
            stopRideRequestRing();
            renderNoIncomingRequests();
        } else {
            startRideRequestRing(firstPendingRide || {});
        }

        updateIncomingRequestsVisibility();
    }, (error) => {
        console.error("Driver service incoming ride listener failed:", error);
        renderNoIncomingRequests();
        noRidesMsg.querySelector('strong').innerText = "Could not sync ride requests";
        noRidesMsg.querySelector('p').innerText = "Check your connection and keep this page open.";
    });
}

async function updateDriverAvailabilityThroughBackend(status, locationData = null) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch("/api/rides/driver-availability", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ status, ...(locationData || {}) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not update driver availability.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

async function setServiceDriverAvailability(status) {
    if (!currentUser?.uid) return;

    currentUser.driverAvailability = status;
    currentUser.desiredAvailability = status === "offline" ? "offline" : "online";
    const locationData = lastPosition ? { lat: lastPosition.lat, lng: lastPosition.lng } : null;
    const online = status !== "offline";
    const notificationEligibleUntil = online ? new Date(Date.now() + 30 * 60 * 1000) : new Date(0);

    try {
        await updateDriverAvailabilityThroughBackend(status, locationData);
        return;
    } catch (backendError) {
        if (!backendError?.backendUnavailable) throw backendError;
        console.warn("Availability backend unavailable; using temporary Firestore fallback.", backendError);
    }

    const userUpdate = {
        driverAvailability: status,
        desiredAvailability: online ? "online" : "offline",
        isConnected: online,
        notificationEligibleUntil,
        driverAvailabilityUpdatedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp()
    };
    if (locationData) userUpdate.driverLocation = locationData;

    const presenceUpdate = {
        uid: currentUser.uid,
        name: currentUser.name || "Driver",
        phone: currentUser.phone || "",
        driverAvailability: status,
        desiredAvailability: online ? "online" : "offline",
        verificationStatus: currentUser.verificationStatus || "pending_review",
        vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || "",
        vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || "",
        vehicle_type: inferVehicleType(currentUser),
        isConnected: online,
        notificationEligibleUntil,
        updatedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp()
    };
    if (locationData) presenceUpdate.driverLocation = locationData;

    await Promise.allSettled([
        updateDoc(doc(db, "users", currentUser.uid), userUpdate),
        setDoc(doc(db, "driverPresence", currentUser.uid), presenceUpdate, { merge: true })
    ]);
}

async function acceptIncomingRide(rideId, button) {
    if (!rideId || !currentUser?.uid || acceptRideInProgress) return;

    acceptRideInProgress = true;
    stopRideRequestRing();
    if (button) {
        button.disabled = true;
        button.innerText = "Accepting...";
    }

    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/accept`, {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.error || "Could not accept this ride.");
        }
        const acceptedRideData = data.ride || {};

        await setServiceDriverAvailability("busy");
        renderActiveRideState(rideId, { ...acceptedRideData, status: "accepted" });
        updateIncomingRequestsVisibility();
        statusText.innerText = "Ride accepted - route is loading";
    } catch (error) {
        console.error("Driver service ride acceptance failed:", error);
        alert(error.message || "Could not accept this ride.");
        if (button) {
            button.disabled = false;
            button.innerText = "Accept Ride Request";
        }
    } finally {
        acceptRideInProgress = false;
    }
}

function setGpsState(state, label) {
    livePill.dataset.state = state;
    livePill.innerText = label;
}

function setLifecycleGpsText(text) {
    lifecycleGpsText = text;
    const gpsNode = document.getElementById('driver-service-gps-status');
    if (gpsNode) gpsNode.innerText = text;
}

function showMessage(title, copy, action = "location") {
    messageTitle.innerText = title;
    messageCopy.innerText = copy;
    retryButton.dataset.action = action;
    retryButton.innerText = action === "map" ? "Retry Map" : "Retry Location";
    messagePanel.classList.remove('d-none');
}

function hideMessage() {
    messagePanel.classList.add('d-none');
}

function showRouteWarning(message) {
    routeWarning.innerText = message;
    routeWarning.classList.remove('d-none');
}

function hideRouteWarning() {
    routeWarning.classList.add('d-none');
}

function normalizeCoordinates(latValue, lngValue) {
    const lat = Number(latValue);
    const lng = Number(lngValue);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function readCachedDriverLocation() {
    try {
        const cached = JSON.parse(localStorage.getItem(DRIVER_LOCATION_CACHE_KEY) || "null");
        return normalizeCoordinates(cached?.lat, cached?.lng);
    } catch {
        return null;
    }
}

function rememberDriverLocation(position) {
    const coords = normalizeCoordinates(position?.lat, position?.lng);
    if (!coords) return;

    try {
        localStorage.setItem(DRIVER_LOCATION_CACHE_KEY, JSON.stringify({
            lat: coords.lat,
            lng: coords.lng,
            savedAt: Date.now()
        }));
    } catch {
        // Location caching is a speed hint only; live GPS still drives backend updates.
    }
}

function getInitialDriverLocation() {
    return readCachedDriverLocation() || DEFAULT_DRIVER_LOCATION;
}

function distanceMeters(pointA, pointB) {
    if (!pointA || !pointB) return Infinity;

    const earthRadius = 6371000;
    const lat1 = pointA.lat * Math.PI / 180;
    const lat2 = pointB.lat * Math.PI / 180;
    const deltaLat = (pointB.lat - pointA.lat) * Math.PI / 180;
    const deltaLng = (pointB.lng - pointA.lng) * Math.PI / 180;
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function renderActivePassengerContact(ride = {}) {
    const rawPassengerName = String(ride.passenger_name || "Passenger").trim() || "Passenger";
    const passengerName = escapeHtml(rawPassengerName);
    const passengerInitial = escapeHtml(rawPassengerName.charAt(0).toUpperCase() || "P");
    const passengerPhone = String(ride.passenger_phone || "").trim();
    const callablePhone = passengerPhone.replace(/[^\d+]/g, "");

    return `
        <div class="active-passenger-contact">
            <div class="active-passenger-avatar" aria-hidden="true">${passengerInitial}</div>
            <div class="active-passenger-copy">
                <span>Passenger</span>
                <strong>${passengerName}</strong>
            </div>
            ${callablePhone ? `
                <a class="active-passenger-call" href="tel:${callablePhone}" aria-label="Call ${passengerName}">
                    <span aria-hidden="true">☎</span>
                    <small>Call</small>
                </a>
            ` : `
                <button class="active-passenger-call" type="button" disabled aria-label="Passenger phone unavailable">
                    <span aria-hidden="true">☎</span>
                    <small>Call</small>
                </button>
            `}
        </div>
    `;
}

function renderActiveTripRoute(ride = {}) {
    const pickup = escapeHtml(getRideDisplayAddress(ride, "pickup"));
    const destination = escapeHtml(getRideDisplayAddress(ride, "drop"));
    const distanceLabel = formatRideDistance(ride.distance_km);
    const durationLabel = formatRideDuration(ride.duration_minutes);

    return `
        <div class="active-trip-route" aria-label="Active trip route">
            <div class="active-trip-place">
                <span class="active-route-dot pickup" aria-hidden="true"></span>
                <div>
                    <small>Pickup</small>
                    <strong>${pickup}</strong>
                </div>
            </div>
            <div class="active-route-line" aria-hidden="true"></div>
            <div class="active-trip-place">
                <span class="active-route-dot destination" aria-hidden="true"></span>
                <div>
                    <small>Destination</small>
                    <strong>${destination}</strong>
                </div>
            </div>
            <div class="active-trip-metrics">
                <div><small>Distance</small><strong>${distanceLabel}</strong></div>
                <div><small>Estimated time</small><strong>${durationLabel}</strong></div>
            </div>
        </div>
    `;
}

function resetLifecycleButtons(status = "accepted") {
    completeButton.classList.toggle('d-none', !["started", "en_route"].includes(status));
    completeButton.disabled = !["started", "en_route"].includes(status);
}

function renderLifecycleState(status, rideData = currentRide) {
    currentRideStatus = status;
    currentRide = { ...(currentRide || {}), ...(rideData || {}), status };

    const labels = {
        accepted: "Passenger PIN verification required",
        arrived: "Passenger PIN verification required",
        started: "Trip started - continue to destination",
        en_route: "Trip in progress"
    };

    const showPinVerification = ["accepted", "arrived"].includes(status);
    const pinVerificationHtml = showPinVerification ? `
        <div id="driver-service-verification-panel" class="mt-3">
            <label for="driver-service-verification-pin-input" class="form-label fw-semibold mb-1">Passenger PIN</label>
            <input id="driver-service-verification-pin-input" type="tel" maxlength="4" inputmode="numeric" class="form-control text-center fw-bold mb-2" placeholder="Enter 4-digit PIN">
            <button id="driver-service-verify-pin-btn" class="btn btn-success w-100 fw-bold" type="button">
                Verify & Start Trip
            </button>
        </div>
    ` : "";

    lifecycleDetails.innerHTML = `
        ${renderActivePassengerContact(currentRide)}
        ${renderActiveTripRoute(currentRide)}
        <p class="mb-1"><strong>Status:</strong> ${labels[status] || escapeHtml(status)}</p>
        <p class="mb-0 text-secondary" id="driver-service-gps-status">${escapeHtml(lifecycleGpsText)}</p>
        ${pinVerificationHtml}
    `;

    resetLifecycleButtons(status);

    const verifyPinButton = document.getElementById('driver-service-verify-pin-btn');
    if (verifyPinButton) {
        verifyPinButton.addEventListener('click', () => verifyAndStartTrip(currentRideId));
    }
}

function showLifecyclePanel(status, rideData = currentRide) {
    lifecyclePanel.classList.remove('d-none');
    renderLifecycleState(status, rideData);
}

function hideLifecyclePanel() {
    lifecyclePanel.classList.add('d-none');
}

let lastDriverMarkerFixAt = null;

function animateDriverMarkerTo(position, heading = null) {
    if (driverMarkerAnimationFrame) cancelAnimationFrame(driverMarkerAnimationFrame);
    const current = driverMarker?.getPosition();
    const now0 = performance.now();

    if (!current || typeof requestAnimationFrame !== "function") {
        driverMarker?.setPosition(position);
        driverMarker?.setHeading?.(heading);
        lastDriverMarkerFixAt = now0;
        if (navigationModeEnabled) applyNavigationCamera(position, heading, true);
        return;
    }

    const start = { lat: current.lat(), lng: current.lng() };
    const latDelta = position.lat - start.lat;
    const lngDelta = position.lng - start.lng;
    if (Math.abs(latDelta) > 0.05 || Math.abs(lngDelta) > 0.05) {
        driverMarker.setPosition(position);
        driverMarker.setHeading?.(heading);
        driverMarkerAnimationFrame = null;
        lastDriverMarkerFixAt = now0;
        if (navigationModeEnabled) applyNavigationCamera(position, heading, true);
        return;
    }

    // Match the glide duration to however long it actually took for this GPS
    // fix to arrive, so the marker (and nav camera) are always in motion
    // instead of snapping into place and then sitting still.
    const sinceLastFix = lastDriverMarkerFixAt ? now0 - lastDriverMarkerFixAt : DRIVER_MARKER_ANIM_DEFAULT_MS;
    const duration = Math.min(DRIVER_MARKER_ANIM_MAX_MS, Math.max(DRIVER_MARKER_ANIM_MIN_MS, sinceLastFix));
    lastDriverMarkerFixAt = now0;

    const startedAt = now0;
    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = progress * progress * (3 - (2 * progress));
        const framePosition = {
            lat: start.lat + (latDelta * eased),
            lng: start.lng + (lngDelta * eased)
        };
        driverMarker.setPosition(framePosition);
        let frameHeading = lastDriverHeading;
        if (heading != null) {
            frameHeading = smoothHeading(lastDriverHeading, heading, eased);
            driverMarker.setHeading?.(frameHeading);
        }
        if (navigationModeEnabled) applyNavigationCamera(framePosition, frameHeading);

        if (progress < 1) {
            driverMarkerAnimationFrame = requestAnimationFrame(step);
        } else {
            lastDriverHeading = heading ?? lastDriverHeading;
            driverMarker.setHeading?.(lastDriverHeading);
            driverMarkerAnimationFrame = null;
        }
    };
    driverMarkerAnimationFrame = requestAnimationFrame(step);
}

let mapShell = null;
let map = null;
let driverMarker = null;
let targetMarker = null;
let routePolyline = null;
let locationWatchId = null;
let activeRideUnsubscribe = null;
let lastPosition = null;
let hasLiveGpsPosition = false;
let lastRoutePosition = null;
let lastRouteAt = 0;
let lastWritePosition = null;
let lastWriteAt = 0;
let routeRequestInFlight = false;
let routeRefreshQueued = false;
let firstRouteFitComplete = false;
let routeRetryTimer = null;
let activeRoutePath = [];
let navToggleButton = null;
let cameraAnimationFrame = null;
let lastCameraHeading = 0;
let navigationModeEnabled = readCachedNavigationModePreference();

function readCachedNavigationModePreference() {
    try {
        const cached = localStorage.getItem(DRIVER_NAV_MODE_CACHE_KEY);
        return cached === null ? true : cached === "1";
    } catch {
        return true;
    }
}

function rememberNavigationModePreference(enabled) {
    try {
        localStorage.setItem(DRIVER_NAV_MODE_CACHE_KEY, enabled ? "1" : "0");
    } catch {
        // Private browsing may block storage; navigation mode still works this session.
    }
}

function clearRoute() {
    if (routePolyline?.setMap) routePolyline.setMap(null);
    routePolyline = null;
    activeRoutePath = [];
}

function clearTarget() {
    if (targetMarker?.setMap) targetMarker.setMap(null);
    targetMarker = null;
    clearRoute();
    currentTarget = null;
    currentTargetKey = "";
    firstRouteFitComplete = false;
    if (routeRetryTimer) {
        window.clearTimeout(routeRetryTimer);
        routeRetryTimer = null;
    }
    resetCameraToOverview();
}

function scheduleRouteRetry() {
    if (routeRetryTimer) window.clearTimeout(routeRetryTimer);
    routeRetryTimer = window.setTimeout(() => {
        routeRetryTimer = null;
        if (lastPosition && currentTarget) refreshRoute(lastPosition, true);
    }, 20000);
}

async function ensureMap(position) {
    if (map) return map;

    try {
        mapShell = await createRideMapSurface(mapHost, {
            center: position,
            zoom: 17,
            minZoom: 9,
            maxZoom: 21,
            zoomControl: true,
            fullscreenControl: true,
            gestureHandling: "greedy",
            enableCameraRotation: true
        });
        map = mapShell.map;
        hideMessage();
        ensureNavToggleButton();
        return map;
    } catch (error) {
        console.error("Driver Google Map failed to load:", error);
        setGpsState("error", "MAP");
        showMessage(
            "Map could not load",
            "Check the Google Maps browser key and your network connection, then retry.",
            "map"
        );
        throw error;
    }
}

function stopCameraAnimation() {
    if (cameraAnimationFrame) {
        cancelAnimationFrame(cameraAnimationFrame);
        cameraAnimationFrame = null;
    }
}

// Rotates + tilts the camera so the driver's direction of travel always
// points "up" on screen (heading-up navigation), following the driver from
// pickup to drop-off the same way Google Maps / Uber turn-by-turn does.
// Only takes effect once the driver actually has somewhere to drive to -
// while idle the map stays flat and north-up.
function applyNavigationCamera(position, heading, instant = false) {
    if (!map || !navigationModeEnabled || !position || !map.moveCamera) return;
    // fitBounds() (used for the initial pickup/destination overview) resets
    // heading and tilt to zero, so wait until that first framing is done
    // before rotating the camera - otherwise the rotation would be
    // immediately undone the moment the route arrives.
    if (!currentTarget || !firstRouteFitComplete) return;

    const targetHeading = normalizeHeading(heading) ?? lastCameraHeading;
    const targetZoom = map.getZoom() || NAV_CAMERA_ZOOM;

    if (instant) {
        stopCameraAnimation();
        map.moveCamera({ center: position, heading: targetHeading, tilt: NAV_CAMERA_TILT, zoom: Math.max(targetZoom, NAV_CAMERA_ZOOM) });
        lastCameraHeading = targetHeading;
        return;
    }

    stopCameraAnimation();
    const startHeading = normalizeHeading(map.getHeading?.()) ?? lastCameraHeading;
    const startedAt = performance.now();

    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / CAMERA_ROTATE_ANIM_MS);
        const eased = progress * progress * (3 - (2 * progress));
        const nextHeading = smoothHeading(startHeading, targetHeading, eased);
        map.moveCamera({ center: position, heading: nextHeading, tilt: NAV_CAMERA_TILT, zoom: Math.max(map.getZoom() || NAV_CAMERA_ZOOM, NAV_CAMERA_ZOOM) });
        if (progress < 1) {
            cameraAnimationFrame = requestAnimationFrame(step);
        } else {
            lastCameraHeading = targetHeading;
            cameraAnimationFrame = null;
        }
    };
    cameraAnimationFrame = requestAnimationFrame(step);
}

function resetCameraToOverview() {
    stopCameraAnimation();
    if (!map || !map.moveCamera) return;
    map.moveCamera({
        center: lastPosition || map.getCenter?.(),
        heading: 0,
        tilt: 0,
        zoom: map.getZoom() || 16
    });
    lastCameraHeading = 0;
}

function setNavigationMode(enabled) {
    navigationModeEnabled = enabled;
    rememberNavigationModePreference(enabled);
    navToggleButton?.classList.toggle("is-active", enabled);
    navToggleButton?.setAttribute("aria-pressed", String(enabled));
    if (navToggleButton) navToggleButton.title = enabled ? "Navigation mode: on (tap for map view)" : "Map view (tap for navigation mode)";

    if (!map) return;
    if (enabled && currentTarget && lastPosition) {
        applyNavigationCamera(lastPosition, lastDriverHeading, true);
    } else {
        resetCameraToOverview();
    }
}

function ensureNavToggleButton() {
    if (navToggleButton || !mapHost?.parentElement) return;

    navToggleButton = document.createElement("button");
    navToggleButton.type = "button";
    navToggleButton.className = "driver-nav-toggle-btn";
    navToggleButton.setAttribute("aria-label", "Toggle navigation camera");
    navToggleButton.innerHTML = '<span class="driver-nav-toggle-icon" aria-hidden="true">&#8963;</span>';
    navToggleButton.addEventListener("click", () => setNavigationMode(!navigationModeEnabled));
    mapHost.parentElement.appendChild(navToggleButton);
    setNavigationMode(navigationModeEnabled);
}

function upsertDriverMarker(position, heading = null) {
    if (!map || !window.google?.maps) return;

    if (!driverMarker) {
        driverMarker = new RotatingVehicleMarker({
            map,
            position,
            title: "Your live location",
            vehicleType: inferVehicleType(currentUser),
            heading,
            zIndex: 1000,
            live: true
        });
        lastDriverHeading = normalizeHeading(heading) ?? lastDriverHeading;
        lastDriverMarkerFixAt = performance.now();
        if (navigationModeEnabled && currentTarget) applyNavigationCamera(position, heading, true);
        return;
    }

    animateDriverMarkerTo(position, heading);
}

function upsertTargetMarker() {
    if (!map || !currentTarget || !window.google?.maps) return;

    if (!targetMarker) {
        targetMarker = new window.google.maps.Marker({
            map,
            position: currentTarget.position,
            title: currentTarget.place,
            label: {
                text: currentTarget.kind === "pickup" ? "P" : "D",
                color: "#ffffff",
                fontWeight: "800"
            },
            zIndex: 900
        });
        return;
    }

    targetMarker.setPosition(currentTarget.position);
    targetMarker.setTitle(currentTarget.place);
    targetMarker.setLabel({
        text: currentTarget.kind === "pickup" ? "P" : "D",
        color: "#ffffff",
        fontWeight: "800"
    });
}

function fitActiveRoute(path) {
    if (!map || !currentTarget || firstRouteFitComplete || !window.google?.maps) return;

    const bounds = new window.google.maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    bounds.extend(currentTarget.position);
    if (lastPosition) bounds.extend(lastPosition);
    map.fitBounds(bounds, { top: 110, right: 42, bottom: 70, left: 42 });
    firstRouteFitComplete = true;

    if (navigationModeEnabled && lastPosition) {
        window.setTimeout(() => applyNavigationCamera(lastPosition, lastDriverHeading, true), 900);
    }
}

function drawRoute(path) {
    if (!map || !Array.isArray(path) || path.length < 2 || !window.google?.maps) return;

    clearRoute();
    activeRoutePath = path;
    routePolyline = new window.google.maps.Polyline({
        map,
        path,
        strokeColor: "#16723a",
        strokeOpacity: 0.96,
        strokeWeight: 6,
        zIndex: 500
    });
    fitActiveRoute(path);
}

function getRouteHeading(position) {
    if (!position || activeRoutePath.length < 2) return null;

    let bestIndex = -1;
    let bestDistance = Infinity;
    activeRoutePath.forEach((point, index) => {
        const distance = distanceMeters(position, point);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    if (bestIndex < 0) return null;
    const nextPoint = activeRoutePath[bestIndex + 1] || activeRoutePath[bestIndex];
    const previousPoint = activeRoutePath[bestIndex - 1] || activeRoutePath[bestIndex];
    return calculateBearing(previousPoint, nextPoint);
}

function buildLocationTelemetry(coords, browserCoords, previousPosition, previousHeading) {
    const telemetry = {};
    const gpsHeading = normalizeHeading(browserCoords?.heading);
    const routeHeading = currentTarget ? getRouteHeading(coords) : null;
    const moved = distanceMeters(previousPosition, coords);
    const calculatedHeading = moved >= DRIVER_HEADING_MIN_DISTANCE_METERS
        ? calculateBearing(previousPosition, coords)
        : null;
    const heading = routeHeading ?? gpsHeading ?? calculatedHeading ?? normalizeHeading(previousHeading);

    if (heading != null) telemetry.driverHeading = heading;
    if (Number.isFinite(Number(browserCoords?.speed))) telemetry.driverSpeed = Number(browserCoords.speed);
    if (Number.isFinite(Number(browserCoords?.accuracy))) telemetry.driverAccuracy = Number(browserCoords.accuracy);

    return { telemetry, heading };
}

function updateRouteMetrics(routeDetails) {
    routeDistance.innerText = Number.isFinite(routeDetails?.distanceKm)
        ? `${routeDetails.distanceKm.toFixed(1)} km`
        : "-- km";
    routeDuration.innerText = Number.isFinite(routeDetails?.durationMinutes)
        ? `${Math.round(routeDetails.durationMinutes)} min`
        : "-- min";
}

async function refreshRoute(position, force = false) {
    if (!map || !currentTarget || !position) return;

    const moved = distanceMeters(lastRoutePosition, position);
    const elapsed = Date.now() - lastRouteAt;
    if (!force && moved < ROUTE_RECALC_DISTANCE_METERS) return;
    if (!force && elapsed < ROUTE_RECALC_MIN_INTERVAL_MS) {
        routeRefreshQueued = true;
        return;
    }

    if (routeRequestInFlight) {
        routeRefreshQueued = true;
        return;
    }

    routeRequestInFlight = true;
    routeRefreshQueued = false;
    const requestTargetKey = currentTargetKey;

    try {
        const routeDetails = await fetchRoadRouteDetails(position, currentTarget.position);
        if (requestTargetKey !== currentTargetKey) return;
        if (!routeDetails?.routePath?.length) {
            showRouteWarning("Google could not find a driving route. Live driver and stop markers remain visible.");
            lastRoutePosition = position;
            lastRouteAt = Date.now();
            scheduleRouteRetry();
            return;
        }

        if (routeRetryTimer) {
            window.clearTimeout(routeRetryTimer);
            routeRetryTimer = null;
        }
        lastRoutePosition = position;
        lastRouteAt = Date.now();
        hideRouteWarning();
        updateRouteMetrics(routeDetails);
        drawRoute(routeDetails.routePath);
    } catch (error) {
        if (requestTargetKey !== currentTargetKey) return;
        console.warn("Driver route refresh failed:", error);
        showRouteWarning("Route refresh failed. Keeping the last route and live markers while we retry.");
        lastRoutePosition = position;
        lastRouteAt = Date.now();
        scheduleRouteRetry();
    } finally {
        routeRequestInFlight = false;
        if (routeRefreshQueued && lastPosition && currentTarget) {
            window.setTimeout(() => refreshRoute(lastPosition), ROUTE_RECALC_MIN_INTERVAL_MS);
        }
    }
}

async function updateDriverLocationThroughBackend(position, telemetry, rideId = null) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch("/api/rides/driver-location", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ lat: position.lat, lng: position.lng, rideId, ...telemetry })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not update driver GPS location.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

async function writeDriverLocation(position) {
    if (!currentUser?.uid) return;

    const elapsed = Date.now() - lastWriteAt;
    const moved = distanceMeters(lastWritePosition, position);
    if (elapsed < LOCATION_WRITE_MIN_INTERVAL_MS && moved < LOCATION_WRITE_DISTANCE_METERS) return;

    lastWriteAt = Date.now();
    lastWritePosition = position;
    const locationData = { lat: position.lat, lng: position.lng };
    const telemetryData = {};
    if (Number.isFinite(Number(position.driverHeading))) telemetryData.driverHeading = Number(position.driverHeading);
    if (Number.isFinite(Number(position.driverSpeed))) telemetryData.driverSpeed = Number(position.driverSpeed);
    if (Number.isFinite(Number(position.driverAccuracy))) telemetryData.driverAccuracy = Number(position.driverAccuracy);
    try {
        await updateDriverLocationThroughBackend(position, telemetryData, currentRideId);
        return;
    } catch (backendError) {
        if (!backendError?.backendUnavailable) throw backendError;
        console.warn("GPS backend unavailable; using temporary Firestore fallback.", backendError);
    }
    const availability = currentRide ? "busy" : "searching";
    currentUser.driverAvailability = availability;
    currentUser.desiredAvailability = "online";
    const notificationEligibleUntil = new Date(Date.now() + 30 * 60 * 1000);

    const writes = [
        updateDoc(doc(db, "users", currentUser.uid), {
            driverLocation: locationData,
            ...telemetryData,
            driverAvailability: availability,
            desiredAvailability: "online",
            isConnected: true,
            lastSeenAt: serverTimestamp(),
            lastAppSeenAt: serverTimestamp(),
            lastLocationAt: serverTimestamp(),
            notificationEligibleUntil,
            driverAvailabilityUpdatedAt: serverTimestamp()
        }),
        setDoc(doc(db, "driverPresence", currentUser.uid), {
            uid: currentUser.uid,
            name: currentUser.name || "Driver",
            phone: currentUser.phone || "",
            driverLocation: locationData,
            ...telemetryData,
            driverAvailability: availability,
            desiredAvailability: "online",
            verificationStatus: currentUser.verificationStatus || "pending_review",
            vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || "",
            vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || "",
            vehicle_type: inferVehicleType(currentUser),
            isConnected: true,
            lastSeenAt: serverTimestamp(),
            lastAppSeenAt: serverTimestamp(),
            lastLocationAt: serverTimestamp(),
            notificationEligibleUntil,
            updatedAt: serverTimestamp()
        }, { merge: true })
    ];

    if (currentRideId) {
        writes.push(updateDoc(doc(db, "rides", currentRideId), {
            driverLocation: locationData,
            ...telemetryData,
            driverLocationUpdatedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }));
    }

    const results = await Promise.allSettled(writes);
    results.forEach((result) => {
        if (result.status === "rejected") {
            console.warn("A driver location write failed:", result.reason);
        }
    });
}

async function handleLocation(position) {
    const previousPosition = lastPosition;
    const coords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
    };
    const telemetryResult = buildLocationTelemetry(coords, position.coords, previousPosition, lastDriverHeading);
    if (telemetryResult.heading != null) {
        coords.driverHeading = telemetryResult.heading;
        lastDriverHeading = telemetryResult.heading;
    }
    if (Number.isFinite(Number(telemetryResult.telemetry.driverSpeed))) {
        coords.driverSpeed = telemetryResult.telemetry.driverSpeed;
    }
    if (Number.isFinite(Number(telemetryResult.telemetry.driverAccuracy))) {
        coords.driverAccuracy = telemetryResult.telemetry.driverAccuracy;
    }

    lastPosition = coords;
    hasLiveGpsPosition = true;
    rememberDriverLocation(coords);
    setGpsState("live", "LIVE");
    setLifecycleGpsText("GPS Active & Broadcasting");
    hideMessage();
    statusText.innerText = currentTarget
        ? currentTarget.kind === "pickup"
            ? "Live route to passenger pickup"
            : "Passenger verified - navigating to destination"
        : "Online and ready for ride requests";

    writeDriverLocation(coords).catch((error) => {
        console.warn("Driver location sync failed:", error);
    });

    try {
        await ensureMap(coords);
    } catch {
        return;
    }

    upsertDriverMarker(coords, telemetryResult.heading);

    if (currentTarget) {
        upsertTargetMarker();
        refreshRoute(coords);
    } else {
        map.panTo(coords);
        hideRouteWarning();
    }
}

function handleLocationError(error) {
    console.warn("Driver GPS update failed:", error);
    setGpsState("error", "GPS");
    setLifecycleGpsText("GPS signal interrupted");

    if (hasLiveGpsPosition && lastPosition) {
        statusText.innerText = "GPS signal lost. Showing your last known position.";
        showRouteWarning("GPS signal interrupted. Navigation will resume automatically when location returns.");
        return;
    }

    const denied = error?.code === error?.PERMISSION_DENIED || error?.code === 1;
    showMessage(
        denied ? "Location permission required" : "Current location unavailable",
        denied
            ? "Allow precise location access in your browser settings, then retry."
            : "Move to an open area, check GPS, and retry live location.",
        "location"
    );
}

function startLocationTracking() {
    const initialPosition = getInitialDriverLocation();
    lastPosition = lastPosition || initialPosition;

    ensureMap(initialPosition).then(() => {
        upsertDriverMarker(initialPosition);
        if (currentTarget) {
            upsertTargetMarker();
            refreshRoute(initialPosition, true);
        } else {
            map.panTo(initialPosition);
        }
    }).catch(() => {});

    if (!navigator.geolocation) {
        setGpsState("error", "GPS");
        setLifecycleGpsText("GPS not supported");
        showMessage("Location is not supported", "This browser cannot provide live GPS navigation.", "location");
        return;
    }

    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
    }

    setGpsState("loading", "GPS");
    setLifecycleGpsText("GPS locking...");
    statusText.innerText = "Finding your live position...";
    locationWatchId = navigator.geolocation.watchPosition(
        handleLocation,
        handleLocationError,
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 12000
        }
    );
}

function getRideTarget(ride) {
    const isDestinationLeg = ride.status === "en_route" || ride.status === "started";
    const position = isDestinationLeg
        ? normalizeCoordinates(ride.drop_lat, ride.drop_lng)
        : normalizeCoordinates(ride.pickup_lat, ride.pickup_lng);

    if (!position) return null;

    return {
        kind: isDestinationLeg ? "destination" : "pickup",
        position,
        place: isDestinationLeg
            ? ride.drop_name || ride.drop_full_address || "Passenger destination"
            : ride.pickup_name || "Passenger pickup"
    };
}

function renderIdleState() {
    setRideActive(false);
    clearTarget();
    currentRide = null;
    currentRideId = null;
    currentRideStatus = "";
    routePanel.classList.add('d-none');
    openConsoleButton.classList.add('d-none');
    hideLifecyclePanel();
    hideRouteWarning();
    statusText.innerText = "Online and ready for ride requests";
    updateIncomingRequestsVisibility();
    if (lastPosition && map) map.panTo(lastPosition);
}

function renderActiveRideState(rideId, ride) {
    setRideActive(true);
    currentRideId = rideId;
    currentRide = ride;
    currentRideStatus = ride.status || "accepted";
    openConsoleButton.classList.remove('d-none');
    updateIncomingRequestsVisibility();
    showLifecyclePanel(currentRideStatus, ride);

    const target = getRideTarget(ride);
    if (!target) {
        clearTarget();
        routePanel.classList.add('d-none');
        statusText.innerText = "Active ride coordinates are unavailable";
        showRouteWarning("This ride is missing map coordinates. Open the Duty Console for ride details.");
        return;
    }

    const nextTargetKey = `${target.kind}:${target.position.lat}:${target.position.lng}`;
    const targetChanged = nextTargetKey !== currentTargetKey;
    if (targetChanged) {
        if (targetMarker?.setMap) targetMarker.setMap(null);
        targetMarker = null;
        clearRoute();
        currentTargetKey = nextTargetKey;
        firstRouteFitComplete = false;
        lastRoutePosition = null;
        lastRouteAt = 0;
        routeRefreshQueued = false;
        if (routeRetryTimer) {
            window.clearTimeout(routeRetryTimer);
            routeRetryTimer = null;
        }
    }

    currentTarget = target;
    routeLabel.innerText = target.kind === "pickup" ? "Navigate to pickup" : "Navigate to destination";
    routePlace.innerText = target.place;
    routePanel.classList.remove('d-none');
    statusText.innerText = target.kind === "pickup"
        ? "Live route to passenger pickup"
        : "Passenger verified - navigating to destination";

    if (map) upsertTargetMarker();
    if (lastPosition) refreshRoute(lastPosition, targetChanged);
}

async function verifyAndStartTrip(rideId) {
    if (!rideId) {
        alert("No active ride found for PIN verification.");
        return;
    }

    const pinInput = document.getElementById('driver-service-verification-pin-input');
    const typedPin = pinInput ? pinInput.value.trim() : "";

    if (!/^\d{4}$/.test(typedPin)) {
        alert("Please enter the 4-digit passenger PIN.");
        return;
    }

    try {
        const result = await transitionRideThroughBackend(rideId, "verify_pin", typedPin);
        renderActiveRideState(rideId, result.ride || { ...currentRide, status: "en_route" });
    } catch (error) {
        console.error("PIN verification failed:", error);
        alert("Could not verify PIN. Please try again.");
    }
}

async function transitionRideThroughBackend(rideId, action, pin = "") {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action, pin })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not update this ride.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

async function completeRideJob() {
    if (!currentRideId) {
        alert("No active trip found to complete.");
        return;
    }

    // Keep the ID locally because the realtime listener may clear
    // currentRideId immediately after the server changes the ride to
    // `completed`.
    const completedRideId = currentRideId;
    pendingPaymentRideId = completedRideId;

    try {
        const result = await transitionRideThroughBackend(completedRideId, "complete");
        const finalFare = parseFloat(result.ride?.fare || currentRide?.fare || 0);
        finalFareEl.innerText = `Rs ${finalFare}`;

        const driverUPI = currentUser.upiId;
        if (driverUPI) {
            const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
            upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
            upiQrImage.classList.remove('d-none');
        } else {
            upiQrImage.src = "";
            upiQrImage.classList.add('d-none');
            alert("Your driver UPI ID is missing from your profile. Please collect cash for this ride.");
        }

        paymentModal.classList.remove('d-none');
        hideLifecyclePanel();
    } catch (error) {
        console.error("Error finalizing ride transaction:", error);
        alert("Database connection dropped during checkout.");
    }
}

async function cancelRideByDriver() {
    if (!currentRideId) {
        alert("No active trip found to cancel.");
        return;
    }

    if (!confirm("Warning: Cancelling active trips impacts your driver rating. Proceed?")) return;

    try {
        const rideId = currentRideId;
        try {
            await transitionRideThroughBackend(rideId, "cancel");
            alert("Trip cancelled successfully.");
            return;
        } catch (backendError) {
            if (!backendError?.backendUnavailable) throw backendError;
            console.warn("Driver cancellation backend unavailable; using temporary Firestore fallback.", backendError);
        }

        await runTransaction(db, async (transaction) => {
            const rideRef = doc(db, "rides", rideId);
            const rideSnap = await transaction.get(rideRef);
            if (!rideSnap.exists()) return;
            const rideData = rideSnap.data();

            transaction.update(rideRef, {
                status: "cancelled_by_driver",
                cancelledAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            if (rideData.pinVerifiedAt) {
                transaction.set(doc(db, "tripHistory", rideId), buildTripHistoryFinalUpdate({
                    ...rideData,
                    ride_id: rideId,
                    status: "cancelled_by_driver"
                }, "cancelled_by_driver"), { merge: true });
            }
        });

        alert("Trip cancelled successfully.");
    } catch (error) {
        console.error("Driver cancel execution failure:", error);
        alert("Could not cancel the active trip.");
    }
}

function buildTripHistoryRecord(rideId, rideData) {
    const status = rideData.status || "verified";
    const isCancelled = status === "cancelled_by_passenger" || status === "cancelled_by_driver";
    const isCompleted = status === "completed";
    const cancelledBy = status === "cancelled_by_passenger"
        ? "passenger"
        : status === "cancelled_by_driver"
            ? "driver"
            : "";

    return {
        ride_id: rideId,
        passenger_id: rideData.passenger_id || null,
        driver_id: rideData.driver_id || null,
        pickup_location: getRideDisplayAddress(rideData, "pickup") || "Pickup not recorded",
        pickup_display_address: rideData.pickup_display_address || "",
        pickup_formatted_address: rideData.pickup_formatted_address || "",
        pickup_landmark: rideData.pickup_landmark || "",
        drop_location: getRideDisplayAddress(rideData, "drop") || "Drop not recorded",
        drop_display_address: rideData.drop_display_address || "",
        drop_formatted_address: rideData.drop_formatted_address || rideData.drop_full_address || "",
        drop_full_address: rideData.drop_full_address || "",
        drop_landmark: rideData.drop_landmark || "",
        verifiedAt: rideData.pinVerifiedAt || rideData.verifiedAt || serverTimestamp(),
        completedAt: isCompleted ? rideData.completedAt || serverTimestamp() : null,
        cancelledAt: isCancelled ? rideData.cancelledAt || serverTimestamp() : null,
        finalStatusAt: isCompleted
            ? rideData.completedAt || serverTimestamp()
            : isCancelled
                ? rideData.cancelledAt || serverTimestamp()
                : null,
        paidAt: rideData.payment_status === "paid" ? rideData.paidAt || serverTimestamp() : null,
        distance_km: Number(rideData.distance_km || 0),
        duration_minutes: Number(rideData.duration_minutes || 0),
        fare_amount: Number(rideData.fare || 0),
        trip_status: status,
        final_status: isCompleted ? "completed" : isCancelled ? "cancelled" : "verified",
        cancelled_by: cancelledBy,
        payment_status: rideData.payment_status || "pending",
        driver_name: rideData.driver_name || "Driver",
        passenger_name: rideData.passenger_name || "Passenger",
        vehicle_model: rideData.vehicle_model || "Vehicle",
        vehicle_number: rideData.vehicle_number || "Number not recorded",
        vehicle_details: `${rideData.vehicle_model || "Vehicle"} - ${rideData.vehicle_number || "Number not recorded"}`,
        vehicle_type: rideData.vehicle_type || "",
        service_name: rideData.service_name || getServiceLabel(rideData.vehicle_type),
        passenger_capacity: Number(rideData.passenger_capacity || (rideData.vehicle_type === "auto" ? 4 : 1)),
        source: rideData.source || "client_verification",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
}

function buildTripHistoryFinalUpdate(rideData, status) {
    const isCancelled = status === "cancelled_by_passenger" || status === "cancelled_by_driver";
    const cancelledBy = status === "cancelled_by_passenger" ? "passenger" : status === "cancelled_by_driver" ? "driver" : "";
    const record = buildTripHistoryRecord(rideData.ride_id, { ...rideData, status });
    delete record.createdAt;

    return {
        ...record,
        completedAt: status === "completed" ? serverTimestamp() : rideData.completedAt || null,
        cancelledAt: isCancelled ? serverTimestamp() : rideData.cancelledAt || null,
        finalStatusAt: serverTimestamp(),
        final_status: status === "completed" ? "completed" : isCancelled ? "cancelled" : "verified",
        cancelled_by: cancelledBy,
        trip_status: status,
        updatedAt: serverTimestamp()
    };
}

async function markRidePaidAndCreateHistory(rideId) {
    if (!rideId) {
        alert("No completed ride found for payment confirmation.");
        return false;
    }

    try {
        try {
            await transitionRideThroughBackend(rideId, "mark_paid");
            return true;
        } catch (backendError) {
            if (!backendError?.backendUnavailable) throw backendError;
            console.warn("Payment backend unavailable; using temporary Firestore fallback.", backendError);
        }

        const rideRef = doc(db, "rides", rideId);
        const historyRef = doc(db, "tripHistory", rideId);

        await runTransaction(db, async (transaction) => {
            const rideSnap = await transaction.get(rideRef);
            if (!rideSnap.exists()) {
                throw new Error("Ride document no longer exists.");
            }

            const rideData = rideSnap.data();
            if (rideData.status !== "completed") {
                throw new Error("Only completed rides can be moved into trip history.");
            }

            if (rideData.driver_id !== currentUser.uid) {
                throw new Error("Only the assigned driver can confirm this payment.");
            }

            transaction.update(rideRef, {
                payment_status: "paid",
                payment_confirmed_by: currentUser.uid,
                paymentConfirmedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            const historyRecord = buildTripHistoryRecord(rideId, {
                ...rideData,
                status: "completed",
                payment_status: "paid",
                source: "client_payment_confirmation"
            });
            delete historyRecord.createdAt;
            transaction.set(historyRef, historyRecord, { merge: true });
        });

        return true;
    } catch (error) {
        console.error("Trip history creation failed:", error);
        alert(error.message || "Could not confirm payment and save trip history.");
        return false;
    }
}

function startActiveRideListener() {
    if (!currentUser?.uid) return;
    if (activeRideUnsubscribe) activeRideUnsubscribe();

    const activeRideQuery = query(
        collection(db, "rides"),
        where("driver_id", "==", currentUser.uid),
        where("status", "in", ACTIVE_RIDE_STATUSES)
    );

    activeRideUnsubscribe = onSnapshot(activeRideQuery, (snapshot) => {
        if (snapshot.empty) {
            renderIdleState();
            return;
        }

        const existingRide = currentRideId
            ? snapshot.docs.find((rideDoc) => rideDoc.id === currentRideId)
            : null;
        const activeRideDoc = existingRide || snapshot.docs[0];
        renderActiveRideState(activeRideDoc.id, activeRideDoc.data());
    }, (error) => {
        console.error("Driver active ride listener failed:", error);
        showRouteWarning("Could not sync the active ride. Check your connection; live GPS remains active.");
    });
}

retryButton.addEventListener('click', () => {
    hideMessage();
    if (retryButton.dataset.action === "map" && !lastPosition) {
        window.location.reload();
        return;
    }

    if (retryButton.dataset.action === "map" && lastPosition) {
        if (driverMarkerAnimationFrame) {
            cancelAnimationFrame(driverMarkerAnimationFrame);
            driverMarkerAnimationFrame = null;
        }
        mapShell?.destroy();
        mapShell = null;
        map = null;
        driverMarker = null;
        targetMarker = null;
        routePolyline = null;
        ensureMap(lastPosition).then(() => {
            upsertDriverMarker(lastPosition);
            if (currentTarget) {
                upsertTargetMarker();
                refreshRoute(lastPosition, true);
            }
        }).catch(() => {});
        return;
    }

    startLocationTracking();
});

openConsoleButton.addEventListener('click', () => {
    window.location.href = 'driver.html';
});

completeButton.addEventListener('click', completeRideJob);
cancelButton.addEventListener('click', cancelRideByDriver);
ridesContainer?.addEventListener('click', (event) => {
    const acceptButton = event.target.closest('.driver-service-accept-btn');
    if (!acceptButton) return;
    acceptIncomingRide(acceptButton.dataset.rideId, acceptButton);
});

closePaymentButton.addEventListener('click', async () => {
    closePaymentButton.disabled = true;
    closePaymentButton.innerText = "Saving trip history...";

    const saved = await markRidePaidAndCreateHistory(pendingPaymentRideId);
    if (!saved) {
        closePaymentButton.disabled = false;
        closePaymentButton.innerText = "Fare Received & Clear";
        return;
    }

    paymentModal.classList.add('d-none');
    window.location.reload();
});

onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
        window.location.replace('login.html');
        return;
    }

    try {
        const profileSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!profileSnap.exists()) {
            window.location.replace('login.html');
            return;
        }

        const profile = profileSnap.data();
        if (profile.role !== "driver") {
            window.location.replace('index.html');
            return;
        }

        if (profile.verificationStatus !== "approved") {
            window.location.replace('driver.html');
            return;
        }

        currentUser = profile;
        cacheProfile(profile);
        registerDriverPushToken(db, currentUser.uid).catch((error) => {
            console.warn("Driver service push token registration failed:", error);
        });
        startActiveRideListener();
        startIncomingRideListener();
        startLocationTracking();
    } catch (error) {
        console.error("Driver service authentication failed:", error);
        showMessage("Could not load driver account", "Check your connection and retry the page.", "map");
    }
});

window.addEventListener('beforeunload', () => {
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
    if (activeRideUnsubscribe) activeRideUnsubscribe();
    if (incomingRideUnsubscribe) incomingRideUnsubscribe();
    if (driverMarkerAnimationFrame) cancelAnimationFrame(driverMarkerAnimationFrame);
    mapShell?.destroy();
});
