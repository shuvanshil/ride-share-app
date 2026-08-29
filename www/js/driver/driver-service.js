import { auth, db } from '../platform/firebase-init.js';
import { createRideMapSurface, fetchRoadRouteDetails, warmGoogleMaps } from '../map/map-core.js';
import { acquireWakeLock, releaseWakeLock } from '../platform/wake-lock.js';
import { showAlert, showConfirm } from '../shared/dialog.js';
import { showPageLoader, hidePageLoader, hideInitialLoader } from '../shared/loading.js';
import { waitForAuth } from '../shared/auth.js';
import { t } from '../shared/i18n.js';
import {
    registerDriverPushToken,
    startRideRequestRing,
    stopRideRequestRing
} from '../shared/messaging.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    serverTimestamp,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const ACTIVE_RIDE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const ROUTE_RECALC_DISTANCE_METERS = 25;
const ROUTE_RECALC_MIN_INTERVAL_MS = 7000;
const ROUTE_REVEAL_ANIM_MS = 900;
const ROUTE_PROGRESS_COMPLETED_COLOR = "#0b5d2a";
const ROUTE_PROGRESS_REMAINING_COLOR = "#16723a";
const DRIVER_ARRIVAL_THRESHOLD_METERS = 35;
// Mirrors the same outlier-rejection guard used for the passenger's map
// (see map.js) - a single fix that implies faster-than-plausible movement
// is noise (indoor/network-based location drift), not a real teleport.
const DRIVER_MAX_PLAUSIBLE_SPEED_MPS = 28;
const DRIVER_OUTLIER_CONFIRM_RADIUS_METERS = 60;
const LOCATION_WRITE_DISTANCE_METERS = 10;
const LOCATION_WRITE_MIN_INTERVAL_MS = 5000;
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;
const DRIVER_LOCATION_CACHE_KEY = "liphtup_last_driver_location";
const DEFAULT_DRIVER_LOCATION = Object.freeze({ lat: 24.3124, lng: 92.0135 });
const DRIVER_NAV_MODE_CACHE_KEY = "liphtup_driver_nav_mode";
const DRIVER_IGNORED_RIDES_PREFIX = "liphtup_driver_ignored_requests_";
const NAV_CAMERA_TILT = 55;
const NAV_CAMERA_ZOOM = 18;
const DRIVER_MARKER_ANIM_MIN_MS = 300;
const DRIVER_MARKER_ANIM_MAX_MS = 5000;
const DRIVER_MARKER_ANIM_DEFAULT_MS = 600;
const CAMERA_ROTATE_ANIM_MS = 700;
// See the matching comments in js/map.js: these keep the driver's own
// vehicle icon snapped onto the real road route (instead of drifting off
// it from ordinary GPS inaccuracy) and keep its heading matched to the
// route monotonically, so noisy GPS pings on a winding road can't make the
// icon momentarily face backward.
const ROUTE_SNAP_MAX_METERS = 30;
const ROUTE_MATCH_BACKWARD_TOLERANCE = 2;
const ROUTE_MATCH_SEARCH_WINDOW = 60;

const mapHost = document.getElementById('driver-service-map');
const statusText = document.getElementById('driver-service-status');

function getIgnoredRidesStorageKey() {
    return `${DRIVER_IGNORED_RIDES_PREFIX}${currentUser?.uid || "unknown"}`;
}

function loadIgnoredRideIds() {
    if (!currentUser?.uid) return ignoredRideIds;
    try {
        const raw = localStorage.getItem(getIgnoredRidesStorageKey()) || "[]";
        const parsed = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
        ignoredRideIds = parsed;
        return ignoredRideIds;
    } catch {
        return ignoredRideIds;
    }
}

function saveIgnoredRideIds(rideIds) {
    ignoredRideIds = Array.from(new Set(rideIds));
    try {
        localStorage.setItem(getIgnoredRidesStorageKey(), JSON.stringify(ignoredRideIds));
    } catch {
        // Ignore storage failures; this feature is optional.
    }
}
// ==========================================
// 5-MINUTE RIDE REQUEST TIMEOUT & LIFECYCLE
// ==========================================
const RIDE_REQUEST_TTL_MS = 5 * 60 * 1000;
const activeRideRequestTimers = new Map();

function getRideCreatedAtMs(ride = {}) {
    if (ride.createdAt) {
        if (typeof ride.createdAt.toMillis === "function") return ride.createdAt.toMillis();
        if (typeof ride.createdAt.toDate === "function") return ride.createdAt.toDate().getTime();
        if (typeof ride.createdAt === "number") return ride.createdAt;
        if (typeof ride.createdAt.seconds === "number") return ride.createdAt.seconds * 1000;
    }
    if (ride.fare_requested_at) {
        const t = new Date(ride.fare_requested_at).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    if (ride.requested_at) {
        const t = new Date(ride.requested_at).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    return Date.now();
}

function getRideRemainingMs(ride = {}) {
    const createdMs = getRideCreatedAtMs(ride);
    const elapsed = Date.now() - createdMs;
    return Math.max(0, RIDE_REQUEST_TTL_MS - elapsed);
}

function formatCountdownTimer(remainingMs) {
    const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function clearRideRequestTimer(rideId) {
    const timer = activeRideRequestTimers.get(rideId);
    if (timer) {
        clearInterval(timer);
        activeRideRequestTimers.delete(rideId);
    }
}

function clearAllRideRequestTimers() {
    activeRideRequestTimers.forEach((timer) => clearInterval(timer));
    activeRideRequestTimers.clear();
}

function removeExpiredRideCard(rideId) {
    clearRideRequestTimer(rideId);
    const card = ridesContainer?.querySelector(`.ride-request-card[data-ride-id="${rideId}"], .driver-service-request-card[data-ride-id="${rideId}"]`);
    if (card) {
        card.classList.add('fade-out');
        setTimeout(() => {
            if (card) card.remove();
            recheckIncomingRequestsCount();
        }, 280);
    } else {
        recheckIncomingRequestsCount();
    }
}

function recheckIncomingRequestsCount() {
    const remainingCards = ridesContainer ? ridesContainer.querySelectorAll('.ride-request-card, .driver-service-request-card').length : 0;
    if (remainingCards === 0) {
        stopRideRequestRing();
        renderNoIncomingRequests();
    }
}

function attachRideCardCountdown(rideId, ride) {
    clearRideRequestTimer(rideId);
    const initialRemaining = getRideRemainingMs(ride);
    if (initialRemaining <= 0) {
        removeExpiredRideCard(rideId);
        return;
    }

    const timer = setInterval(() => {
        const remaining = getRideRemainingMs(ride);
        const timerVal = document.getElementById(`srv-timer-val-${rideId}`);
        const timerPill = document.getElementById(`srv-timer-${rideId}`);

        if (remaining <= 0) {
            clearRideRequestTimer(rideId);
            removeExpiredRideCard(rideId);
            return;
        }

        if (timerVal) {
            timerVal.textContent = formatCountdownTimer(remaining);
        }
        if (timerPill) {
            timerPill.classList.toggle('is-urgent', remaining <= 60000);
        }
    }, 1000);

    activeRideRequestTimers.set(rideId, timer);
}

function ignoreRideRequest(rideId) {
    if (!rideId || !currentUser?.uid) return;
    clearRideRequestTimer(rideId);

    const ignored = new Set(loadIgnoredRideIds());
    ignored.add(rideId);
    saveIgnoredRideIds(Array.from(ignored));

    removeExpiredRideCard(rideId);

    rejectRideThroughBackend(rideId).catch((error) => {
        console.warn("Could not record ride decline server-side:", error);
    });
}
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
let ignoredRideIds = [];
let currentTarget = null;
let currentTargetKey = "";
let currentRideStatus = "";
let pendingPaymentRideId = null;
let lifecycleGpsText = "GPS locking...";
let driverMarkerAnimationFrame = null;
let lastDriverHeading = null;
let incomingRideUnsubscribe = null;
let acceptRideInProgress = false;
let driverPostRideAvailability = "searching";

function formatFareAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `Rs ${Math.round(amount)}` : "Rs 0";
}

function fareAdjustmentMessage(ride, fallback = "") {
    const adjustment = ride?.fare_adjustment;
    if (adjustment?.message) return adjustment.message;
    if (Number.isFinite(Number(ride?.fare))) return `Final fare: ${formatFareAmount(ride.fare)}.`;
    return fallback;
}

function formatDistancePastDestination(km) {
    const meters = Math.round(Number(km) * 1000);
    if (!Number.isFinite(meters) || meters <= 0) return "";
    if (meters < 1000) return `${meters} meters`;
    return `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km`;
}

function renderFareAdjustmentNote(elementId, ride) {
    const noteEl = document.getElementById(elementId);
    if (!noteEl) return;

    const adjustment = ride?.fare_adjustment;
    const finalFare = formatFareAmount(adjustment?.final_fare ?? ride?.fare);
    const originalFare = Number(adjustment?.original_fare);
    const adjustedFare = Number(adjustment?.final_fare ?? ride?.fare);
    const addedFare = adjustedFare - originalFare;
    let message = "";

    if (adjustment?.reason === "extra_after_drop") {
        const distanceText = formatDistancePastDestination(adjustment.extra_dropoff_distance_km);
        const addedText = Number.isFinite(addedFare) && addedFare > 0
            ? `, an additional ${formatFareAmount(addedFare)} was added`
            : "";
        message = distanceText
            ? `Since the final drop-off was ${distanceText} past the original location${addedText}. Final fare: ${finalFare}.`
            : fareAdjustmentMessage(ride, `Final fare: ${finalFare}.`);
    } else if (adjustment?.reason && adjustment.final_fare !== adjustment.original_fare) {
        message = fareAdjustmentMessage(ride, `Final fare: ${finalFare}.`);
    }

    noteEl.innerText = message;
    noteEl.classList.toggle('d-none', !message);
}

warmGoogleMaps();

const VEHICLE_MARKER_ASSETS = Object.freeze({
    bike: new URL("../../assets/vehicle-markers/bike-marker.png", import.meta.url).href,
    auto: new URL("../../assets/vehicle-markers/auto-marker.png", import.meta.url).href
});

function cacheProfile(profile) {
    const { createdAt, cachedAt, ...cacheableProfile } = profile;
    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole("driver");
    }
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

// See js/map.js for the full rationale: projects `point` onto the segment
// [segStart, segEnd] and returns how far along it (0..1) the closest point
// falls, using a flat-plane approximation that's accurate enough for the
// short segments making up a Google Routes polyline.
function projectFractionOntoSegment(point, segStart, segEnd) {
    const lngScale = Math.cos((segStart.lat * Math.PI) / 180) || 1e-9;
    const segLat = segEnd.lat - segStart.lat;
    const segLng = (segEnd.lng - segStart.lng) * lngScale;
    const pointLat = point.lat - segStart.lat;
    const pointLng = (point.lng - segStart.lng) * lngScale;

    const segLengthSq = (segLat * segLat) + (segLng * segLng);
    if (segLengthSq <= 1e-18) return 0;

    const fraction = ((pointLat * segLat) + (pointLng * segLng)) / segLengthSq;
    return Math.max(0, Math.min(1, fraction));
}

// Finds the closest point to `position` on `routePath`, searching only a
// small window around `lastIndex` so GPS jitter on a winding/looping road
// can't match a distant part of the route and flip the heading backward.
// Falls back to a full search the first time or when the window has nothing
// within ROUTE_SNAP_MAX_METERS.
function matchPositionToRoute(position, routePath, lastIndex = -1) {
    if (!position || !Array.isArray(routePath) || routePath.length < 2) return null;

    const searchFullRange = lastIndex < 0;
    const windowStart = searchFullRange
        ? 0
        : Math.max(0, lastIndex - ROUTE_MATCH_BACKWARD_TOLERANCE);
    const windowEnd = searchFullRange
        ? routePath.length - 2
        : Math.min(routePath.length - 2, lastIndex + ROUTE_MATCH_SEARCH_WINDOW);

    let best = null;
    for (let i = windowStart; i <= windowEnd; i += 1) {
        const segStart = routePath[i];
        const segEnd = routePath[i + 1];
        const fraction = projectFractionOntoSegment(position, segStart, segEnd);
        const projected = {
            lat: segStart.lat + ((segEnd.lat - segStart.lat) * fraction),
            lng: segStart.lng + ((segEnd.lng - segStart.lng) * fraction)
        };
        const distance = distanceMeters(position, projected);
        if (!best || distance < best.distanceMeters) {
            best = { index: i, point: projected, distanceMeters: distance, heading: calculateBearing(segStart, segEnd) };
        }
    }

    if (!searchFullRange && (!best || best.distanceMeters > ROUTE_SNAP_MAX_METERS)) {
        return matchPositionToRoute(position, routePath, -1);
    }

    return best;
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

        // Glowing pulse ripples
        const ripple1 = document.createElement("div");
        ripple1.className = "driver-vehicle-ripple";
        const ripple2 = document.createElement("div");
        ripple2.className = "driver-vehicle-ripple driver-vehicle-ripple-2";
        this.element.appendChild(ripple1);
        this.element.appendChild(ripple2);

        // 'You are here' wobble speech bubble
        const bubble = document.createElement("div");
        bubble.className = "driver-you-are-here-bubble";
        bubble.textContent = t('services.you_are_here', "You are here");
        this.element.appendChild(bubble);

        // Separate inner wrapper for arrive-bounce/select-pop CSS animations,
        // keeping them off both this.element (JS-driven position translate)
        // and the <img> (JS-driven heading rotation) so transforms never fight.
        this.innerWrap = document.createElement("div");
        this.innerWrap.className = "rotating-vehicle-marker-inner";
        this.image = document.createElement("img");
        this.image.alt = "";
        this.image.draggable = false;
        this.image.style.cssText = "width:48px;height:48px;object-fit:contain;transform-origin:50% 50%;filter:drop-shadow(0 3px 6px rgba(15,23,42,0.35));user-select:none;";
        this.innerWrap.appendChild(this.image);
        this.element.appendChild(this.innerWrap);
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

    setArriving(arriving) {
        this.innerWrap?.classList.toggle("is-arriving", Boolean(arriving));
    }

    pulseSelect() {
        if (!this.innerWrap) return;
        this.innerWrap.classList.remove("is-selected");
        void this.innerWrap.offsetWidth;
        this.innerWrap.classList.add("is-selected");
        window.clearTimeout(this.selectPulseTimer);
        this.selectPulseTimer = window.setTimeout(() => {
            this.innerWrap?.classList.remove("is-selected");
        }, 450);
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

function setMapStageExpanded(expanded) {
    const mapStage = document.getElementById("driver-map-stage");
    if (mapStage) {
        mapStage.classList.toggle("has-active-trip", Boolean(expanded));
        mapStage.classList.toggle("is-expanded", Boolean(expanded));
    }
}

function updateIncomingRequestsVisibility() {
    if (!requestsPanel) return;
    const hasRide = Boolean(currentRideId);
    requestsPanel.classList.toggle('d-none', hasRide);
    setMapStageExpanded(hasRide);
}

function renderIncomingRideCard(rideId, ride = {}) {
    const passengerPhone = String(ride.passenger_phone || ride.passengerPhone || "").trim();
    const callablePhone = passengerPhone.replace(/[^\d+]/g, "");
    const passengerName = escapeHtml(ride.passenger_name || "Passenger");
    const fareAmount = Math.round(Number(ride.fare) || 0);
    const passCount = ride.passenger_capacity || (ride.vehicle_type === "auto" ? 3 : 1);
    const passLabel = Number(passCount) === 1 ? t('common.passenger', "passenger") : t('driver.passengers_count', "passengers");
    const remainingMs = getRideRemainingMs(ride);

    const card = document.createElement('div');
    card.className = "ride-request-card card shadow-sm p-3 mb-3 driver-service-request-card";
    card.dataset.rideId = rideId;
    card.innerHTML = `
        <div class="request-header-row">
            <div class="passenger-name-wrap">
                <h5 class="passenger-name mb-1">${passengerName}</h5>
                <span class="vehicle-capacity-badge">
                    <span>👤</span> ${ride.service_name || getServiceLabel(ride.vehicle_type)} · ${passCount} ${passLabel}
                </span>
            </div>
            <div class="d-flex flex-column align-items-end gap-1">
                <span class="fare-badge">₹${fareAmount}</span>
                <div class="request-timer-pill ${remainingMs <= 60000 ? 'is-urgent' : ''}" id="srv-timer-${rideId}">
                    <span class="timer-icon">⏳</span>
                    <span class="timer-label">${t('driver.expires_in', "Expires in")}</span>
                    <strong class="timer-val" id="srv-timer-val-${rideId}">${formatCountdownTimer(remainingMs)}</strong>
                </div>
                ${callablePhone ? `
                    <a class="btn-call-passenger mt-1" href="tel:${callablePhone}" aria-label="${t('driver.call_btn', 'Call')} ${passengerName}">
                        <span>📞</span> ${t('driver.call_btn', 'Call')}
                    </a>
                ` : `
                    <button class="btn-call-passenger disabled mt-1" type="button" disabled aria-label="Phone unavailable">
                        <span>📞</span> ${t('driver.call_btn', 'Call')}
                    </button>
                `}
            </div>
        </div>

        <div class="route-display-box my-3">
            <div class="route-step pickup">
                <span class="route-dot green"></span>
                <div class="route-text-group">
                    <span class="route-label">${t('driver.from_label', "From: ")}</span>
                    <span class="route-address">${escapeHtml(getRideDisplayAddress(ride, "pickup"))}</span>
                </div>
            </div>
            <div class="route-step drop">
                <span class="route-dot red"></span>
                <div class="route-text-group">
                    <span class="route-label">${t('driver.to_label', "To: ")}</span>
                    <span class="route-address">${escapeHtml(getRideDisplayAddress(ride, "drop"))}</span>
                </div>
            </div>
        </div>

        <div class="location-preview-row">
            ${renderLocationPreviewLink(t('driver.preview_pickup', "Preview pickup"), ride.pickup_lat, ride.pickup_lng)}
            ${renderLocationPreviewLink(t('driver.preview_destination', "Preview destination"), ride.drop_lat, ride.drop_lng)}
        </div>

        <div class="trip-metrics-card">
            <div class="metric-column">
                <small>${t('history.total_distance', "Distance")}</small>
                <strong>${formatRideDistance(ride.distance_km)}</strong>
            </div>
            <div class="metric-column text-end">
                <small>${t('driver.estimated_time', "Estimated time")}</small>
                <strong>${formatRideDuration(ride.duration_minutes)}</strong>
            </div>
        </div>

        <button class="btn-accept-ride accept-job-btn driver-service-accept-btn" data-id="${rideId}" data-ride-id="${rideId}">
            <span>✓</span> ${t('driver.accept_ride_request_btn', "Accept Ride Request")}
        </button>
        <button class="btn-ignore-ride ignore-job-btn driver-service-ignore-btn" data-id="${rideId}" data-ride-id="${rideId}">
            <span>✕</span> ${t('driver.ignore_btn', "Ignore")}
        </button>
    `;

    return card;
}

function renderNoIncomingRequests() {
    ridesContainer.innerHTML = "";
    ridesContainer.appendChild(noRidesMsg);
    noRidesMsg.querySelector('strong').innerText = t('driver.searching_passengers_title', "Searching nearby passengers");
    noRidesMsg.querySelector('p').innerText = t('driver.keep_open_hint', "Keep this page open to receive targeted requests.");
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

        const validSnapshotRideIds = new Set();
        snapshot.forEach((docSnapshot) => validSnapshotRideIds.add(docSnapshot.id));

        // Clear timers for any ride that is no longer active / pending
        activeRideRequestTimers.forEach((_, trackedRideId) => {
            if (!validSnapshotRideIds.has(trackedRideId)) {
                clearRideRequestTimer(trackedRideId);
            }
        });

        let renderedRideCount = 0;
        let firstPendingRide = null;
        const driverVehicleType = getDriverRequestVehicleType(currentUser);

        const ignored = loadIgnoredRideIds();
        snapshot.forEach((docSnapshot) => {
            const rideId = docSnapshot.id;
            if (ignored.includes(rideId)) return;
            const ride = docSnapshot.data();

            if (ride.status !== "pending" || ride.driver_id) {
                clearRideRequestTimer(rideId);
                return;
            }
            if ((ride.rejected_driver_ids || []).includes(currentUser.uid)) {
                clearRideRequestTimer(rideId);
                return;
            }
            const isEligibleTarget = (ride.eligible_driver_ids || []).includes(currentUser.uid);
            if (!isEligibleTarget && ride.vehicle_type && driverVehicleType && ride.vehicle_type !== driverVehicleType) {
                clearRideRequestTimer(rideId);
                return;
            }

            // Expiration check: if older than 5 minutes, do not render and clear timer
            const remainingMs = getRideRemainingMs(ride);
            if (remainingMs <= 0) {
                clearRideRequestTimer(rideId);
                return;
            }

            renderedRideCount += 1;
            if (!firstPendingRide) {
                firstPendingRide = {
                    id: rideId,
                    body: `${getRideDisplayAddress(ride, "pickup")} to ${getRideDisplayAddress(ride, "drop")}`
                };
            }
            ridesContainer.appendChild(renderIncomingRideCard(rideId, ride));
            attachRideCardCountdown(rideId, ride);
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
        clearAllRideRequestTimers();
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
        body: JSON.stringify({ status, ...(locationData || {}) }),
        signal: AbortSignal.timeout(8000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not update driver availability.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

let demandPollInterval = null;

async function pollDriverNearbyDemand() {
    if (!currentUser?.uid || currentUser.driverAvailability === "offline") return;
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;
        const res = await fetch("/api/rides/driver/nearby-demand", {
            headers: { Authorization: `Bearer ${idToken}` },
            signal: AbortSignal.timeout(6000)
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok && (data.waitingCount > 0 || data.scheduledSoonCount > 0)) {
            updateDriverDemandChip(data);
        } else {
            hideDriverDemandChip();
        }
    } catch (e) {
        console.warn("Driver demand check skipped:", e);
    }
}

function updateDriverDemandChip(data) {
    let chip = document.getElementById('driver-demand-chip');
    if (!chip) {
        chip = document.createElement('div');
        chip.id = 'driver-demand-chip';
        chip.className = 'driver-demand-chip animate-fade-in';
        chip.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:9px 18px;border-radius:24px;font-size:13px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,0.3);z-index:1050;pointer-events:auto;border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;gap:8px;max-width:90vw;text-align:center;';
        document.body.appendChild(chip);
    }

    const waiting = data.waitingCount || 0;
    const scheduled = data.scheduledSoonCount || 0;
    const windowLabel = data.scheduledWindowLabel || "in the next hour";
    const area = data.roughArea ? ` near ${data.roughArea}` : "";

    let content = "";
    if (waiting > 0 && scheduled > 0) {
        content = `⚡ <strong>${waiting} rider${waiting > 1 ? 's' : ''} waiting</strong>${area} &bull; ⏰ <strong>${scheduled} scheduled</strong> ${windowLabel}`;
    } else if (waiting > 0) {
        content = `⚡ <strong>${waiting} rider${waiting > 1 ? 's' : ''} waiting</strong>${area || " nearby"}`;
    } else if (scheduled > 0) {
        content = `⏰ <strong>${scheduled} scheduled pickup${scheduled > 1 ? 's' : ''}</strong> ${windowLabel}`;
    }

    chip.innerHTML = content;
    chip.classList.remove('d-none');
}

function hideDriverDemandChip() {
    const chip = document.getElementById('driver-demand-chip');
    if (chip) chip.classList.add('d-none');
}

async function setServiceDriverAvailability(status) {
    if (!currentUser?.uid) return;

    // 1. Instant local & UI update
    currentUser.driverAvailability = status;
    currentUser.desiredAvailability = status === "offline" ? "offline" : "online";
    cacheProfile(currentUser);
    updateDriverAvailabilityUI(status);

    if (status === "searching") {
        pollDriverNearbyDemand();
        if (!demandPollInterval) {
            demandPollInterval = setInterval(pollDriverNearbyDemand, 30000);
        }
        setTimeout(() => {
            registerDriverPushToken(db, currentUser.uid).catch((error) => {
                console.warn("Driver push token registration failed:", error);
            });
        }, 0);
    } else {
        if (demandPollInterval) {
            clearInterval(demandPollInterval);
            demandPollInterval = null;
        }
        hideDriverDemandChip();
    }

    // 2. Fast background sync
    const locationData = lastPosition ? { lat: lastPosition.lat, lng: lastPosition.lng } : null;
    return updateDriverAvailabilityThroughBackend(status, locationData);
}

async function acceptIncomingRide(rideId, button) {
    if (!rideId || !currentUser?.uid || acceptRideInProgress) return;

    acceptRideInProgress = true;
    clearRideRequestTimer(rideId);
    stopRideRequestRing();
    if (button) {
        button.disabled = true;
        button.innerText = t('driver.accepting', "Accepting...");
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
        driverPostRideAvailability = currentUser?.desiredAvailability === "offline" ? "offline" : "searching";

        await setServiceDriverAvailability("busy");
        renderActiveRideState(rideId, { ...acceptedRideData, status: "accepted" });
        updateIncomingRequestsVisibility();
        statusText.innerText = t('driver.ride_accepted_route_loading', "Ride accepted - route is loading");
    } catch (error) {
        console.error("Driver service ride acceptance failed:", error);
        clearRideRequestTimer(rideId);
        removeExpiredRideCard(rideId);

        const isCancelled = /cancelled|no longer available|no longer exists|cancelled by the passenger/i.test(error.message || "");
        const isExpired = /expired|timeout|time limit/i.test(error.message || "");
        const alreadyTaken = /already accepted/i.test(error.message || "");

        if (isCancelled) {
            await showAlert(t('driver.ride_cancelled_by_passenger', "This ride request was cancelled by the passenger."));
        } else if (isExpired) {
            await showAlert(t('driver.ride_request_expired', "This ride request has expired."));
        } else if (alreadyTaken) {
            await showAlert(t('driver.another_driver_accepted', "Another driver already accepted this ride. Refreshing the list…"));
        } else {
            await showAlert(error.message || "Could not accept this ride.");
        }

        if (button) {
            button.disabled = false;
            button.innerText = t('driver.accept_ride_request_btn', "Accept Ride Request");
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

function getEnteredPin() {
    const boxes = document.querySelectorAll('.at-pin-digit-box');
    if (boxes.length === 4) {
        return Array.from(boxes).map(b => b.value).join('');
    }
    const singleInput = document.getElementById('driver-service-verification-pin-input');
    return singleInput ? singleInput.value.trim() : '';
}

function setupPinDigitBoxes() {
    const boxes = document.querySelectorAll('.at-pin-digit-box');
    if (!boxes.length) return;

    boxes.forEach((box, index) => {
        box.addEventListener('input', (e) => {
            const val = box.value.replace(/[^\d]/g, '');
            box.value = val ? val.charAt(val.length - 1) : '';

            if (box.value && index < boxes.length - 1) {
                boxes[index + 1].focus();
            }

            const pin = getEnteredPin();
            if (/^\d{4}$/.test(pin)) {
                verifyAndStartTrip(currentRideId);
            }
        });

        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && index > 0) {
                boxes[index - 1].focus();
                boxes[index - 1].value = '';
                e.preventDefault();
            }
        });

        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedData = (e.clipboardData || window.clipboardData).getData('text').replace(/[^\d]/g, '');
            if (pastedData.length >= 4) {
                boxes.forEach((b, i) => {
                    b.value = pastedData.charAt(i) || '';
                });
                boxes[3].focus();
                const pin = getEnteredPin();
                if (/^\d{4}$/.test(pin)) {
                    verifyAndStartTrip(currentRideId);
                }
            }
        });
    });
}

function renderLifecycleState(status, rideData = currentRide) {
    currentRideStatus = status;
    currentRide = { ...(currentRide || {}), ...(rideData || {}), status };

    const headerBadge = document.getElementById('active-trip-header-badge');
    const showPinVerification = ["accepted", "arrived"].includes(status);

    if (headerBadge) {
        headerBadge.innerText = showPinVerification ? "Waiting to Start" : "Active";
        headerBadge.className = `active-trip-header-badge ${showPinVerification ? 'waiting' : ''}`;
    }

    const rawPassengerName = String(currentRide.passenger_name || "Passenger").trim() || "Passenger";
    const passengerName = escapeHtml(rawPassengerName);
    const passengerInitial = escapeHtml(rawPassengerName.charAt(0).toUpperCase() || "P");
    const passengerPhone = String(currentRide.passenger_phone || "").trim();
    const callablePhone = passengerPhone.replace(/[^\d+]/g, "");

    const pickupName = escapeHtml(getRideDisplayAddress(currentRide, "pickup"));
    const destName = escapeHtml(getRideDisplayAddress(currentRide, "drop"));
    const distanceLabel = formatRideDistance(currentRide.distance_km);
    const durationLabel = formatRideDuration(currentRide.duration_minutes);

    // If PIN verification panel is already rendered and driver is typing,
    // preserve the input DOM elements so focus is never lost and virtual keyboard stays open!
    const existingPinContainer = document.getElementById('at-pin-card-wrap');
    if (showPinVerification && existingPinContainer) {
        const statusBanner = document.getElementById('at-status-banner-el');
        if (statusBanner) {
            statusBanner.className = "at-status-banner at-status-waiting";
            statusBanner.innerHTML = `
                <div class="at-status-icon-wrap">
                    <span class="webicon webicon-schedule" style="width:20px;height:20px;background-color:#D97706;"></span>
                </div>
                <div class="at-status-text">
                    <strong>${t('driver.waiting_to_start_trip', "WAITING TO START TRIP")}</strong>
                    <p>${t('driver.ask_pin_hint', "Ask the passenger for their 4-digit trip PIN")}</p>
                </div>
            `;
        }
        return;
    }

    const passengerCardHtml = `
        <div class="at-passenger-card">
            <div class="at-passenger-left">
                <div class="at-passenger-avatar">${passengerInitial}</div>
                <div class="at-passenger-info">
                    <strong class="at-passenger-name">${passengerName}</strong>
                    <span class="at-passenger-role">${t('common.passenger', "Passenger")}</span>
                </div>
            </div>
            <div class="at-passenger-actions">
                ${callablePhone ? `
                    <a class="at-action-btn" href="tel:${callablePhone}" aria-label="${t('driver.call_btn', 'Call')} ${passengerName}">
                        <span class="webicon webicon-call" aria-hidden="true" style="width:16px;height:16px;"></span>
                        <span>${t('driver.call_btn', 'Call')}</span>
                    </a>
                ` : `
                    <button class="at-action-btn" type="button" disabled aria-label="Passenger phone unavailable">
                        <span class="webicon webicon-call" aria-hidden="true" style="width:16px;height:16px;"></span>
                        <span>${t('driver.call_btn', 'Call')}</span>
                    </button>
                `}
            </div>
        </div>
    `;

    const statusBannerHtml = showPinVerification ? `
        <div id="at-status-banner-el" class="at-status-banner at-status-waiting">
            <div class="at-status-icon-wrap">
                <span class="webicon webicon-schedule" style="width:20px;height:20px;background-color:#D97706;"></span>
            </div>
            <div class="at-status-text">
                <strong>${t('driver.waiting_to_start_trip', "WAITING TO START TRIP")}</strong>
                <p>${t('driver.ask_pin_hint', "Ask the passenger for their 4-digit trip PIN")}</p>
            </div>
        </div>
    ` : `
        <div id="at-status-banner-el" class="at-status-banner at-status-progress">
            <div class="at-status-icon-wrap">
                <span class="webicon webicon-notify" style="width:20px;height:20px;background-color:#059669;"></span>
            </div>
            <div class="at-status-text">
                <strong>${t('driver.trip_in_progress_title', "TRIP IN PROGRESS")}</strong>
                <p>${t('driver.driving_to_destination', "Driving passenger safely to destination")}</p>
            </div>
        </div>
    `;

    const routeCardHtml = `
        <div class="at-card at-route-card">
            <div class="at-card-section-label">${t('driver.route_details', "ROUTE DETAILS")}</div>
            <div class="at-route-timeline">
                <div class="at-route-stop">
                    <span class="at-stop-dot at-stop-pickup">
                        <span class="at-dot-inner"></span>
                    </span>
                    <div class="at-stop-content">
                        <span class="at-stop-tag at-tag-pickup">${t('driver.pickup_tag', "PICKUP")}</span>
                        <strong class="at-stop-title">${pickupName}</strong>
                    </div>
                </div>
                <div class="at-route-connector-line"></div>
                <div class="at-route-stop">
                    <span class="at-stop-dot at-stop-dest">
                        <span class="at-dot-pin"></span>
                    </span>
                    <div class="at-stop-content">
                        <span class="at-stop-tag at-tag-dest">${t('driver.destination_tag', "DESTINATION")}</span>
                        <strong class="at-stop-title">${destName}</strong>
                    </div>
                </div>
            </div>
            <div class="at-route-footer-metrics">
                <div class="at-metric-item">
                    <span class="webicon webicon-notify" style="width:16px;height:16px;background-color:#64748B;"></span>
                    <strong>${distanceLabel}</strong>
                </div>
                <div class="at-metric-item">
                    <span class="webicon webicon-schedule" style="width:16px;height:16px;background-color:#64748B;"></span>
                    <strong>~${durationLabel}</strong>
                </div>
            </div>
        </div>
    `;

    const pinVerificationCardHtml = showPinVerification ? `
        <div class="at-card at-pin-card" id="at-pin-card-wrap">
            <div class="at-card-section-label">${t('driver.passenger_trip_pin', "PASSENGER TRIP PIN")}</div>
            <div class="at-pin-boxes-wrap" id="at-pin-boxes-container">
                <input type="tel" class="at-pin-digit-box" maxlength="1" inputmode="numeric" pattern="[0-9]*" data-index="0" autocomplete="off">
                <input type="tel" class="at-pin-digit-box" maxlength="1" inputmode="numeric" pattern="[0-9]*" data-index="1" autocomplete="off">
                <input type="tel" class="at-pin-digit-box" maxlength="1" inputmode="numeric" pattern="[0-9]*" data-index="2" autocomplete="off">
                <input type="tel" class="at-pin-digit-box" maxlength="1" inputmode="numeric" pattern="[0-9]*" data-index="3" autocomplete="off">
            </div>
            <p class="at-pin-hint">${t('driver.enter_pin_subhint', "Enter 4-digit PIN provided by the passenger")}</p>
            <button type="button" id="driver-service-verify-pin-btn" class="at-start-trip-btn">
                <div class="at-start-btn-content">
                    <span class="at-play-icon">►</span>
                    <span>${t('driver.start_trip_action', "Start Trip")}</span>
                </div>
                <small class="at-start-btn-sub">${t('driver.pin_auto_verify', "PIN will be verified automatically")}</small>
            </button>
        </div>
    ` : `
        <div class="at-card at-complete-card">
            <button type="button" id="driver-service-complete-btn" class="at-dropoff-btn">
                <div class="at-dropoff-btn-icon">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                </div>
                <div class="at-dropoff-btn-text">
                    <strong>${t('driver.dropoff_passenger_btn', "Drop Off Passenger & Complete Trip")}</strong>
                    <span>${t('driver.dropoff_tap_hint', "Tap when passenger has safely arrived at destination")}</span>
                </div>
            </button>
        </div>
    `;

    const totalFarePaise = Number(currentRide.farePaise) || Math.round(parseFloat(currentRide.fare || 0) * 100);
    const walletPaidPaise = Number(currentRide.walletPaidAmountPaise) || Math.round(parseFloat(currentRide.wallet_paid_amount || 0) * 100);
    const cashPaidPaise = Number(currentRide.cashPaidAmountPaise || 0);
    const couponApplied = currentRide.couponApplied;
    const couponDiscountPaise = couponApplied 
        ? (Number(couponApplied.discountPaise) || Math.round(parseFloat(couponApplied.discountAmount || 0) * 100)) 
        : (Number(currentRide.couponDiscountAmountPaise) || 0);

    const remainingFarePaise = (currentRide.remainingFarePaise !== undefined) 
        ? Number(currentRide.remainingFarePaise) 
        : Math.max(0, totalFarePaise - (walletPaidPaise + cashPaidPaise + couponDiscountPaise));

    const totalFare = totalFarePaise / 100.0;
    const walletPaidAmount = walletPaidPaise / 100.0;
    const couponDiscountAmount = couponDiscountPaise / 100.0;
    const remainingFare = remainingFarePaise / 100.0;

    let farePaymentCardHtml = "";
    if (couponDiscountAmount > 0) {
        if (remainingFare === 0) {
            farePaymentCardHtml = `
                <div class="at-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; margin: 16px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span style="color: #475569; font-size: 13px; font-weight: 600;">Original Trip Fare:</span>
                        <span style="text-decoration: line-through; color: #94a3b8; font-size: 14px;">₹${totalFare.toLocaleString('en-IN')}</span>
                    </div>
                    <div style="color: #0284c7; font-size: 14px; font-weight: 600; margin-bottom: 8px;">
                        <i class="ti ti-ticket me-1"></i> Coupon (${couponApplied?.code || 'Promo'}): ₹${couponDiscountAmount.toLocaleString('en-IN')} Platform Subsidy (added to your wallet)
                    </div>
                    <div style="font-size: 16px; font-weight: 700; color: #16a34a; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                        New fare to collect: ₹0 (Fully covered by platform)
                    </div>
                </div>
            `;
        } else {
            farePaymentCardHtml = `
                <div class="at-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; margin: 16px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span style="color: #475569; font-size: 13px; font-weight: 600;">Original Trip Fare:</span>
                        <span style="text-decoration: line-through; color: #94a3b8; font-size: 14px;">₹${totalFare.toLocaleString('en-IN')}</span>
                    </div>
                    <div style="color: #0284c7; font-size: 14px; font-weight: 600; margin-bottom: 8px;">
                        <i class="ti ti-ticket me-1"></i> Coupon (${couponApplied?.code || 'Promo'}): ₹${couponDiscountAmount.toLocaleString('en-IN')} Platform Subsidy (added to your wallet)
                    </div>
                    <div style="font-size: 16px; font-weight: 700; color: #0f172a; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                        New fare to collect: ₹${remainingFare.toLocaleString('en-IN')}
                    </div>
                </div>
            `;
        }
    } else if (walletPaidAmount > 0) {
        if (remainingFare === 0) {
            farePaymentCardHtml = `
                <div class="at-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; margin: 16px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span style="color: #475569; font-size: 13px; font-weight: 600;">Original Trip Fare:</span>
                        <span style="text-decoration: line-through; color: #94a3b8; font-size: 14px;">₹${totalFare.toLocaleString('en-IN')}</span>
                    </div>
                    <div style="color: #475569; font-size: 14px; margin-bottom: 6px;">
                        Passenger paid ₹${walletPaidAmount.toLocaleString('en-IN')} via wallet credit (added to your wallet).
                    </div>
                    <div style="font-size: 16px; font-weight: 700; color: #16a34a; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                        New fare to collect: ₹0 (Fully paid)
                    </div>
                </div>
            `;
        } else {
            farePaymentCardHtml = `
                <div class="at-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; margin: 16px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span style="color: #475569; font-size: 13px; font-weight: 600;">Original Trip Fare:</span>
                        <span style="text-decoration: line-through; color: #94a3b8; font-size: 14px;">₹${totalFare.toLocaleString('en-IN')}</span>
                    </div>
                    <div style="color: #475569; font-size: 14px; margin-bottom: 6px;">
                        Passenger paid ₹${walletPaidAmount.toLocaleString('en-IN')} via wallet credit (added to your wallet).
                    </div>
                    <div style="font-size: 16px; font-weight: 700; color: #0f172a; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                        New fare to collect: ₹${remainingFare.toLocaleString('en-IN')}
                    </div>
                </div>
            `;
        }
    } else {
        farePaymentCardHtml = `
            <div class="at-card" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; margin: 16px 0; display: flex; justify-content: space-between; align-items: center;">
                <span style="color: #475569; font-weight: 600; font-size: 14px;">Total Trip Fare:</span>
                <strong style="font-size: 18px; color: #0f172a;">₹${totalFare.toLocaleString('en-IN')}</strong>
            </div>
        `;
    }

    const cancelCardHtml = `
        <div class="at-cancel-card-wrap">
            <button type="button" id="driver-service-cancel-btn" class="gy-btn gy-btn-danger-outline w-100 py-2.5 fw-bold" style="border-radius: 12px; font-size: 14px;">
                ${t('driver.cancel_this_ride', "Cancel this ride")}
            </button>
        </div>
    `;

    lifecycleDetails.innerHTML = `
        ${passengerCardHtml}
        ${statusBannerHtml}
        ${farePaymentCardHtml}
        ${routeCardHtml}
        ${pinVerificationCardHtml}
        ${cancelCardHtml}
    `;

    if (showPinVerification) {
        setupPinDigitBoxes();
        const verifyPinButton = document.getElementById('driver-service-verify-pin-btn');
        if (verifyPinButton) {
            verifyPinButton.addEventListener('click', () => verifyAndStartTrip(currentRideId));
        }
    } else {
        const completeBtn = document.getElementById('driver-service-complete-btn');
        if (completeBtn) {
            completeBtn.addEventListener('click', () => completeRideJob());
        }
    }

    const cancelBtn = document.getElementById('driver-service-cancel-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => cancelRideByDriver());
    }

    const sosBtn = document.getElementById('driver-service-sos-btn');
    if (sosBtn) {
        sosBtn.addEventListener('click', () => sendDriverSos());
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
let driverPendingOutlierPosition = null;
let driverLastAcceptedFixAt = null;

// Rejects a single noisy GPS/network-location fix on the driver's own
// marker instead of snapping to it: if the implied speed since the last
// accepted fix is implausible, hold position. A second fix landing near
// that same "bad" spot is treated as real and accepted.
function filterOwnPositionOutlier(rawPosition, now) {
    const current = driverMarker?.getPosition?.();
    if (!current) return rawPosition;

    const lastKnown = { lat: current.lat(), lng: current.lng() };
    const elapsedSeconds = driverLastAcceptedFixAt
        ? Math.max(1, (now - driverLastAcceptedFixAt) / 1000)
        : 5;
    const jumpDistanceMeters = distanceMeters(lastKnown, rawPosition);
    const impliedSpeedMps = jumpDistanceMeters / elapsedSeconds;

    if (impliedSpeedMps <= DRIVER_MAX_PLAUSIBLE_SPEED_MPS) {
        driverPendingOutlierPosition = null;
        driverLastAcceptedFixAt = now;
        return rawPosition;
    }

    if (driverPendingOutlierPosition
        && distanceMeters(driverPendingOutlierPosition, rawPosition) <= DRIVER_OUTLIER_CONFIRM_RADIUS_METERS) {
        driverPendingOutlierPosition = null;
        driverLastAcceptedFixAt = now;
        return rawPosition;
    }

    driverPendingOutlierPosition = rawPosition;
    return lastKnown;
}

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
    // Cap duration to ensure responsiveness
    const duration = Math.min(DRIVER_MARKER_ANIM_MAX_MS, Math.max(DRIVER_MARKER_ANIM_MIN_MS, sinceLastFix * 0.8));
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
            // Update tracking to prevent jump-back
            if (progress > 0.5) lastDriverHeading = frameHeading;
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
let driverRouteMatchIndex = -1;
let driverRouteMatchPoint = null;
let driverLastRoutePathRef = null;
let routeCompletedPolyline = null;
let routeRemainingPolyline = null;
let routeRevealFrame = null;
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

function stopRouteReveal() {
    if (routeRevealFrame) {
        cancelAnimationFrame(routeRevealFrame);
        routeRevealFrame = null;
    }
}

function clearRoute() {
    stopRouteReveal();
    if (routePolyline?.setMap) routePolyline.setMap(null);
    routePolyline = null;
    if (routeCompletedPolyline?.setMap) routeCompletedPolyline.setMap(null);
    routeCompletedPolyline = null;
    if (routeRemainingPolyline?.setMap) routeRemainingPolyline.setMap(null);
    routeRemainingPolyline = null;
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
    navToggleButton.innerHTML = '<span class="driver-nav-toggle-icon" aria-hidden="true"></span>';
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

function getTargetMarkerIcon(kind) {
    const maps = window.google.maps;
    const isPickup = kind === "pickup";
    const iconUrl = isPickup
        ? "/assets/icons/webicons/passenger-pickup-marker.png"
        : "/assets/icons/webicons/destination-flag-marker.png";
    return {
        url: iconUrl,
        scaledSize: new maps.Size(40, 50),
        anchor: new maps.Point(20, 48)
    };
}

function upsertTargetMarker() {
    if (!map || !currentTarget || !window.google?.maps) return;

    const markerIcon = getTargetMarkerIcon(currentTarget.kind);

    if (!targetMarker) {
        targetMarker = new window.google.maps.Marker({
            map,
            position: currentTarget.position,
            title: currentTarget.place,
            icon: markerIcon,
            animation: window.google.maps.Animation.DROP,
            zIndex: 900
        });
        return;
    }

    targetMarker.setPosition(currentTarget.position);
    targetMarker.setTitle(currentTarget.place);
    targetMarker.setIcon(markerIcon);
    targetMarker.setLabel(null);
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

// Animates the route being "drawn" onto the map point by point instead of
// appearing all at once, the first time it's calculated (or after a full
// reroute). Per-tick progress splitting (updateDriverRouteProgress) takes
// over once this finishes.
function revealRoute(path) {
    stopRouteReveal();
    if (!routeRemainingPolyline || !Array.isArray(path) || path.length < 2) return;

    const startedAt = performance.now();
    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / ROUTE_REVEAL_ANIM_MS);
        const pointCount = Math.max(2, Math.round(path.length * progress));
        routeRemainingPolyline.setPath(path.slice(0, pointCount));
        if (progress < 1) {
            routeRevealFrame = requestAnimationFrame(step);
        } else {
            routeRemainingPolyline.setPath(path);
            routeRevealFrame = null;
        }
    };
    routeRevealFrame = requestAnimationFrame(step);
}

function splitDriverRoutePathAtMatch(path, matchIndex, matchPoint) {
    if (!Array.isArray(path) || path.length < 2) {
        return { completed: [], remaining: path || [] };
    }
    const index = Number.isInteger(matchIndex) && matchIndex >= 0
        ? Math.max(0, Math.min(path.length - 2, matchIndex))
        : 0;
    const anchor = matchPoint || path[index];
    const completed = path.slice(0, index + 1).concat([anchor]);
    const remaining = [anchor].concat(path.slice(index + 1));
    return { completed, remaining };
}

// Splits the driver's own route into a muted "completed" segment behind
// them and a highlighted "remaining" segment ahead, updated on every GPS
// tick from the route-match index already computed for marker snapping.
function updateDriverRouteProgress() {
    if (!routeCompletedPolyline || !routeRemainingPolyline || routeRevealFrame) return;
    if (driverRouteMatchIndex < 0 || !activeRoutePath.length) return;

    const { completed, remaining } = splitDriverRoutePathAtMatch(
        activeRoutePath,
        driverRouteMatchIndex,
        driverRouteMatchPoint
    );
    routeCompletedPolyline.setPath(completed);
    routeRemainingPolyline.setPath(remaining);
}

function drawRoute(path) {
    if (!map || !Array.isArray(path) || path.length < 2 || !window.google?.maps) return;

    clearRoute();
    activeRoutePath = path;
    routeCompletedPolyline = new window.google.maps.Polyline({
        map,
        path: [],
        strokeColor: ROUTE_PROGRESS_COMPLETED_COLOR,
        strokeOpacity: 0.5,
        strokeWeight: 6,
        zIndex: 499
    });
    routeRemainingPolyline = new window.google.maps.Polyline({
        map,
        path: [],
        strokeColor: ROUTE_PROGRESS_REMAINING_COLOR,
        strokeOpacity: 0.96,
        strokeWeight: 6,
        zIndex: 500
    });
    revealRoute(path);
    fitActiveRoute(path);
}

// Finds where on the known route the driver's own vehicle currently is,
// snapping onto it (see matchPositionToRoute above) so this driver's own
// marker renders on the road instead of drifting off it, and so its heading
// tracks the route's direction instead of flipping backward on GPS jitter.
// Returns null when there's no usable route (falls back to GPS heading).
function resolveRouteMatch(position) {
    if (driverLastRoutePathRef !== activeRoutePath) {
        driverRouteMatchIndex = -1;
        driverLastRoutePathRef = activeRoutePath;
    }
    const match = matchPositionToRoute(position, activeRoutePath, driverRouteMatchIndex);
    if (!match || match.distanceMeters > ROUTE_SNAP_MAX_METERS) {
        driverRouteMatchIndex = -1;
        driverRouteMatchPoint = null;
        return null;
    }
    driverRouteMatchIndex = match.index;
    driverRouteMatchPoint = match.point;
    return match;
}

function buildLocationTelemetry(coords, browserCoords, previousPosition, previousHeading) {
    const telemetry = {};
    const gpsHeading = normalizeHeading(browserCoords?.heading);
    const routeMatch = currentTarget ? resolveRouteMatch(coords) : null;
    const routeHeading = routeMatch?.heading ?? null;
    const moved = distanceMeters(previousPosition, coords);
    const calculatedHeading = moved >= DRIVER_HEADING_MIN_DISTANCE_METERS
        ? calculateBearing(previousPosition, coords)
        : null;
    const heading = routeHeading ?? gpsHeading ?? calculatedHeading ?? normalizeHeading(previousHeading);

    if (heading != null) telemetry.driverHeading = heading;
    if (Number.isFinite(Number(browserCoords?.speed))) telemetry.driverSpeed = Number(browserCoords.speed);
    if (Number.isFinite(Number(browserCoords?.accuracy))) telemetry.driverAccuracy = Number(browserCoords.accuracy);

    // `renderPosition` is only for drawing this driver's own marker on their
    // own map -- snapped onto the road when we're confident enough (a close
    // route match). The raw `coords` are still what get written to Firestore
    // via telemetry/location writes, since that's the ground truth other
    // clients (the passenger's map) work from and snap themselves.
    const renderPosition = routeMatch ? routeMatch.point : coords;

    return { telemetry, heading, renderPosition };
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
    await updateDriverLocationThroughBackend(position, telemetryData, currentRideId);
}

let isLocationSettled = false;
let gpsSampleCount = 0;
let locationSettlementTimer = null;

function hideLocationLoadingOverlay() {
    isLocationSettled = true;
    const overlay = document.getElementById("driver-location-loading-overlay");
    if (overlay) overlay.classList.add("d-none");
    driverMarker?.element?.classList.remove("is-locating");
}

function showLocationLoadingOverlay() {
    isLocationSettled = false;
    gpsSampleCount = 0;
    const overlay = document.getElementById("driver-location-loading-overlay");
    if (overlay) overlay.classList.remove("d-none");
    driverMarker?.element?.classList.add("is-locating");

    window.clearTimeout(locationSettlementTimer);
    locationSettlementTimer = window.setTimeout(() => {
        hideLocationLoadingOverlay();
    }, 4000);
}

async function handleLocation(position) {
    if (!position?.coords) return;
    gpsSampleCount++;
    const accuracy = Number(position?.coords?.accuracy) || 999;
    if (!isLocationSettled && (accuracy <= 100 || gpsSampleCount >= 2)) {
        hideLocationLoadingOverlay();
    }

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
    updateDriverLocationDisplay(coords.lat, coords.lng);
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

    upsertDriverMarker(
        filterOwnPositionOutlier(telemetryResult.renderPosition || coords, performance.now()),
        telemetryResult.heading
    );

    if (currentTarget) {
        upsertTargetMarker();
        const arrivalDistance = distanceMeters(coords, currentTarget.position);
        driverMarker?.setArriving?.(Number.isFinite(arrivalDistance) && arrivalDistance <= DRIVER_ARRIVAL_THRESHOLD_METERS);
        updateDriverRouteProgress();
        // If the route-match snap just failed (driverRouteMatchIndex === -1)
        // while we already had a route, the driver has genuinely drifted off
        // it - request a fresh route immediately instead of waiting for the
        // normal recalculation throttle.
        const deviated = activeRoutePath.length > 1 && driverRouteMatchIndex === -1;
        refreshRoute(coords, deviated);
    } else {
        driverMarker?.setArriving?.(false);
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
    showLocationLoadingOverlay();
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
    releaseWakeLock();
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
    acquireWakeLock();
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
    if (targetChanged) driverMarker?.pulseSelect?.();
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
        await showAlert(t('driver.no_active_ride_pin', "No active ride found for PIN verification."));
        return;
    }

    const typedPin = getEnteredPin();

    if (!/^\d{4}$/.test(typedPin)) {
        await showAlert(t('driver.enter_4digit_pin', "Please enter the 4-digit passenger PIN."));
        return;
    }

    try {
        const result = await transitionRideThroughBackend(rideId, "verify_pin", typedPin);
        renderActiveRideState(rideId, result.ride || { ...currentRide, status: "en_route" });
    } catch (error) {
        console.error("PIN verification failed:", error);
        await showAlert(t('driver.verify_pin_failed', "Could not verify PIN. Please try again."));
    }
}

async function transitionRideThroughBackend(rideId, action, pin = "") {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    window.LiphtUpLoading?.showPageLoader?.(t('driver.updating_trip_status', "Updating trip status..."));
    try {
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
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

async function completeRideJob() {
    if (!currentRideId) {
        await showAlert(t('driver.no_active_trip_complete', "No active trip found to complete."));
        return;
    }

    // Keep the ID locally because the realtime listener may clear
    // currentRideId immediately after the server changes the ride to
    // `completed`.
    const completedRideId = currentRideId;
    pendingPaymentRideId = completedRideId;

    try {
        const result = await transitionRideThroughBackend(completedRideId, "complete");
        const rideData = result.ride || currentRide || {};
        const totalFarePaise = Number(rideData.farePaise) || Math.round(parseFloat(rideData.fare || 0) * 100);
        const walletPaidPaise = Number(rideData.walletPaidAmountPaise) || Math.round(parseFloat(rideData.wallet_paid_amount || 0) * 100);
        const couponApplied = rideData.couponApplied;
        const couponDiscountPaise = couponApplied ? (Number(couponApplied.discountPaise) || Math.round(parseFloat(couponApplied.discountAmount || 0) * 100)) : 0;
        const couponDiscountAmount = couponDiscountPaise / 100.0;

        const remainingFarePaise = (rideData.remainingFarePaise !== undefined) ? Number(rideData.remainingFarePaise) : Math.max(0, totalFarePaise - (walletPaidPaise + couponDiscountPaise));

        const totalFare = totalFarePaise / 100.0;
        const walletPaidAmount = walletPaidPaise / 100.0;
        const remainingFare = remainingFarePaise / 100.0;

        const breakdownBox = document.getElementById('driver-wallet-breakdown-box');
        const breakdownText = document.getElementById('driver-wallet-breakdown-text');
        const paymentTitle = document.getElementById('driver-service-payment-title');
        const paymentSubtitle = document.getElementById('driver-service-payment-subtitle');

        if (remainingFare === 0 && (walletPaidAmount > 0 || couponDiscountAmount > 0)) {
            // Fully paid via wallet or platform coupon!
            finalFareEl.innerText = formatFareAmount(0);
            if (paymentTitle) paymentTitle.innerText = t('wallet.payment_success', 'Ride Fully Covered');
            if (paymentSubtitle) paymentSubtitle.innerText = couponDiscountAmount > 0 
                ? `Fare of ₹${totalFare} covered by platform promotion and credited to your wallet.` 
                : t('wallet.paid_via_wallet_no_cash', { amount: walletPaidAmount });
            if (breakdownBox) {
                breakdownBox.classList.remove('d-none');
                if (breakdownText) {
                    breakdownText.innerText = couponDiscountAmount > 0 
                        ? `Full fare (₹${totalFare}) covered by promotional subsidy and added to your wallet. No cash collection needed.`
                        : `Full fare (₹${totalFare}) paid via passenger wallet credits and added to your wallet. No cash collection needed.`;
                }
            }
            upiQrImage.classList.add('d-none');
        } else {
            // Cash / UPI collection required for remaining fare
            finalFareEl.innerText = formatFareAmount(remainingFare);
            if (couponDiscountAmount > 0) {
                if (breakdownBox) {
                    breakdownBox.classList.remove('d-none');
                    if (breakdownText) breakdownText.innerText = `Fare Updated: ₹${couponDiscountAmount} promotional adjustment applied. Amount to collect: ₹${remainingFare}`;
                }
            } else if (walletPaidAmount > 0) {
                if (breakdownBox) {
                    breakdownBox.classList.remove('d-none');
                    if (breakdownText) breakdownText.innerText = `Total: ₹${totalFare} | Paid via Wallet: ₹${walletPaidAmount} | Collect: ₹${remainingFare}`;
                }
            } else {
                if (breakdownBox) breakdownBox.classList.add('d-none');
            }

            const driverUPI = currentUser.upiId;
            if (driverUPI) {
                const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${remainingFare}&cu=INR`);
                upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
                upiQrImage.classList.remove('d-none');
            } else {
                upiQrImage.src = "";
                upiQrImage.classList.add('d-none');
                await showAlert(t('driver.missing_upi_cash', "Your driver UPI ID is missing from your profile. Please collect cash for this ride."));
            }
        }

        paymentModal.classList.remove('d-none');
        renderFareAdjustmentNote('driver-service-fare-note', result.ride);
        await setServiceDriverAvailability(driverPostRideAvailability);
        hideLifecyclePanel();
    } catch (error) {
        console.error("Error finalizing ride transaction:", error);
        await showAlert(t('driver.db_dropped_checkout', "Database connection dropped during checkout."));
    }
}

async function cancelRideByDriver() {
    if (!currentRideId) {
        await showAlert(t('driver.no_active_trip_to_cancel', "No active trip found to cancel."));
        return;
    }

    if (!(await showConfirm(t('driver.cancel_warning_confirm', "Warning: Cancelling active trips impacts your driver rating. Proceed?")))) return;

    try {
        const rideId = currentRideId;
        const result = await transitionRideThroughBackend(rideId, "cancel");
        renderIdleState();
        await showAlert(fareAdjustmentMessage(result.ride, t('driver.trip_cancelled_online', "Trip cancelled. You are back online.")));
    } catch (error) {
        console.error("Driver cancel execution failure:", error);
        await showAlert(t('driver.cancel_trip_failed', "Could not cancel the active trip."));
    }
}

async function sendDriverSos() {
    if (!currentRideId) {
        await showAlert(t('driver.no_active_ride_sos', "No active ride found to trigger SOS emergency."));
        return;
    }

    const confirmSos = await showConfirm(
        t('driver.sos_confirm_message', "This alerts LiphtUp's safety team immediately with your location. For any life-threatening emergency, call local emergency services first."),
        { okText: t('driver.send_sos', "Send SOS"), cancelText: t('common.cancel', "Cancel") }
    );
    if (!confirmSos) return;

    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");

        window.LiphtUpLoading?.showPageLoader?.(t('driver.sending_emergency_sos', "Sending Emergency SOS..."));
        const response = await fetch(`/api/rides/${encodeURIComponent(currentRideId)}/sos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ role: "driver" })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.error || "Could not send emergency alert.");
        }
        await showAlert(t('driver.driver_sos_sent', "Emergency SOS Alert Sent! Our safety team has received your live location and is responding."));
    } catch (error) {
        console.error("Driver SOS alert failed:", error);
        await showAlert(t('driver.sos_send_error', "Could not send SOS alert. Please call emergency services (112) directly if in immediate danger."));
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

async function markRidePaidAndCreateHistory(rideId) {
    if (!rideId) {
        await showAlert(t('driver.no_completed_ride_payment', "No completed ride found for payment confirmation."));
        return false;
    }

    try {
        await transitionRideThroughBackend(rideId, "mark_paid");
        return true;
    } catch (error) {
        console.error("Trip history creation failed:", error);
        await showAlert(error.message || t('driver.confirm_payment_failed', "Could not confirm payment and save trip history."));
        return false;
    }
}

function startActiveRideListener() {
    if (!currentUser?.uid) return;
    if (activeRideUnsubscribe) activeRideUnsubscribe();

    const requestedRideId = new URLSearchParams(window.location.search).get("rideId");

    let lastObservedWalletPaidPaise = 0;
    let lastObservedCouponDiscountPaise = 0;
    const activeRideQuery = query(
        collection(db, "rides"),
        where("driver_id", "==", currentUser.uid),
        where("status", "in", ACTIVE_RIDE_STATUSES)
    );

    activeRideUnsubscribe = onSnapshot(activeRideQuery, async (snapshot) => {
        if (snapshot.empty) {
            lastObservedWalletPaidPaise = 0;
            lastObservedCouponDiscountPaise = 0;
            if (currentRideId) {
                try {
                    const rideSnap = await getDoc(doc(db, "rides", currentRideId));
                    const ride = rideSnap.exists() ? rideSnap.data() : null;
                    if (ride?.status === "cancelled_by_passenger") {
                        await showAlert("Passenger cancelled this ride. You are back online.");
                    } else if (ride?.status === "cancelled_by_driver" || ride?.status === "cancelled") {
                        await showAlert("Trip cancelled. You are back online.");
                    }
                } catch (error) {
                    console.warn("Could not check final ride status:", error);
                }
            }
            renderIdleState();
            return;
        }

        const requestedRide = requestedRideId
            ? snapshot.docs.find((rideDoc) => rideDoc.id === requestedRideId)
            : null;
        const existingRide = currentRideId
            ? snapshot.docs.find((rideDoc) => rideDoc.id === currentRideId)
            : null;
        const activeRideDoc = requestedRide || existingRide || snapshot.docs[0];
        const rideData = activeRideDoc.data() || {};

        // Detect new wallet payment during active trip
        const currentWalletPaidPaise = Number(rideData.walletPaidAmountPaise) || Math.round(parseFloat(rideData.wallet_paid_amount || 0) * 100);
        if (lastObservedWalletPaidPaise > 0 && currentWalletPaidPaise > lastObservedWalletPaidPaise) {
            const addedInr = (currentWalletPaidPaise - lastObservedWalletPaidPaise) / 100.0;
            const remainingFarePaise = (rideData.remainingFarePaise !== undefined) ? Number(rideData.remainingFarePaise) : Math.max(0, (Number(rideData.farePaise) || 0) - currentWalletPaidPaise);
            const remainingInr = remainingFarePaise / 100.0;
            showAlert(`Passenger paid ₹${addedInr.toLocaleString('en-IN')} with wallet credits! Updated cash to collect: ₹${remainingInr.toLocaleString('en-IN')}`);
        } else if (lastObservedWalletPaidPaise === 0 && currentWalletPaidPaise > 0 && currentRideId === activeRideDoc.id) {
            const totalPaidInr = currentWalletPaidPaise / 100.0;
            const remainingFarePaise = (rideData.remainingFarePaise !== undefined) ? Number(rideData.remainingFarePaise) : Math.max(0, (Number(rideData.farePaise) || 0) - currentWalletPaidPaise);
            const remainingInr = remainingFarePaise / 100.0;
            showAlert(`Passenger paid ₹${totalPaidInr.toLocaleString('en-IN')} with wallet credits! Updated cash to collect: ₹${remainingInr.toLocaleString('en-IN')}`);
        }
        lastObservedWalletPaidPaise = currentWalletPaidPaise;

        // Detect coupon promotion applied during active trip
        const couponApplied = rideData.couponApplied;
        const currentCouponDiscountPaise = couponApplied 
            ? (Number(couponApplied.discountPaise) || Math.round(parseFloat(couponApplied.discountAmount || 0) * 100)) 
            : (Number(rideData.couponDiscountAmountPaise) || 0);
        if (lastObservedCouponDiscountPaise === 0 && currentCouponDiscountPaise > 0 && currentRideId === activeRideDoc.id) {
            const discInr = currentCouponDiscountPaise / 100.0;
            const remainingFarePaise = (rideData.remainingFarePaise !== undefined) ? Number(rideData.remainingFarePaise) : Math.max(0, (Number(rideData.farePaise) || 0) - currentCouponDiscountPaise);
            const remainingInr = remainingFarePaise / 100.0;
            showAlert(`Promotion Applied! ₹${discInr.toLocaleString('en-IN')} platform subsidy added to your wallet! Updated cash to collect: ₹${remainingInr.toLocaleString('en-IN')}`);
        }
        lastObservedCouponDiscountPaise = currentCouponDiscountPaise;

        renderActiveRideState(activeRideDoc.id, rideData);
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

openConsoleButton?.addEventListener('click', () => {
    window.location.href = '/driver.html';
});

completeButton?.addEventListener('click', completeRideJob);
cancelButton?.addEventListener('click', cancelRideByDriver);
ridesContainer?.addEventListener('click', (event) => {
    const ignoreButton = event.target.closest('.driver-service-ignore-btn');
    if (ignoreButton) {
        ignoreRideRequest(ignoreButton.dataset.rideId);
        return;
    }

    const acceptButton = event.target.closest('.driver-service-accept-btn');
    if (!acceptButton) return;
    acceptIncomingRide(acceptButton.dataset.rideId, acceptButton);
});

closePaymentButton.addEventListener('click', async () => {
    closePaymentButton.disabled = true;
    closePaymentButton.innerText = t('driver.saving_trip_history', "Saving trip history...");

    const saved = await markRidePaidAndCreateHistory(pendingPaymentRideId);
    if (!saved) {
        closePaymentButton.disabled = false;
        closePaymentButton.innerText = t('driver.fare_received_clear', "Fare Received & Clear");
        return;
    }

    paymentModal.classList.add('d-none');
    window.location.reload();
});

window.addEventListener('beforeunload', () => {
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
    if (activeRideUnsubscribe) activeRideUnsubscribe();
    if (incomingRideUnsubscribe) incomingRideUnsubscribe();
    if (driverMarkerAnimationFrame) cancelAnimationFrame(driverMarkerAnimationFrame);
    mapShell?.destroy();
});

async function checkDriverAccountHoldStatus(user) {
    try {
        if (!user) return;
        const token = await user.getIdToken();
        const response = await fetch('/api/account/driver-payments/status', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return;
        const data = await response.json();
        if (data.isAccountOnHold) {
            renderAccountHoldModal();
        }
    } catch (e) {
        console.warn("Account hold check error:", e);
    }
}

function renderAccountHoldModal() {
    let overlay = document.getElementById('account-hold-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'account-hold-modal-overlay';
        overlay.className = 'py-modal-overlay non-closable';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,0.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';
        overlay.innerHTML = `
            <div class="py-modal-card text-center" style="max-width: 400px; border: 2px solid #DC2626; background:#fff; border-radius:18px; box-shadow:0 20px 40px rgba(0,0,0,0.3); overflow:hidden;">
                <div class="py-modal-body p-4">
                    <div class="py-hold-icon-circle mb-3" style="width:64px;height:64px;border-radius:50%;background:#FEE2E2;display:flex;align-items:center;justify-content:center;margin:0 auto;">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#DC2626" stroke-width="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                    </div>
                    <h3 class="text-danger fw-extrabold mb-2" style="font-size: 1.25rem;">Account Temporarily On Hold</h3>
                    <p class="text-secondary small mb-4" style="line-height: 1.5;">
                        Your driver account has been placed on hold because weekly fee payments for <strong>10 or more weeks</strong> have not been received. Please pay your outstanding fees to resume receiving ride requests.
                    </p>
                    <a href="/driver-payments.html" class="py-main-pay-btn w-100 text-decoration-none d-inline-flex justify-content-center align-items-center" style="padding: 14px; background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #fff; font-weight: 800; border-radius: 12px;">
                        Pay Outstanding Weekly Fees
                    </a>
                    <p class="text-muted mt-3 mb-0" style="font-size: 0.75rem;">
                        This non-closable dialog will be removed automatically after your payment review is completed by our accounts team.
                    </p>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.classList.remove('d-none');
}

async function bootstrapDriverService() {
    showPageLoader(t('driver.opening_trip_console', "Opening trip console…"));
    const user = await waitForAuth();

    if (!user) {
        hidePageLoader({ force: true });
        hideInitialLoader();
        window.location.replace('/login.html');
        return;
    }

    try {
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        if (!profileSnap.exists()) {
            hidePageLoader({ force: true });
            hideInitialLoader();
            window.location.replace('/login.html');
            return;
        }

        const profile = profileSnap.data();
        const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));

        if (profile.role !== "driver") {
            hidePageLoader({ force: true });
            hideInitialLoader();
            if (!isCurrent('index.html')) {
                window.location.replace('/index.html');
            }
            return;
        }

        if (profile.verificationStatus !== "approved") {
            hidePageLoader({ force: true });
            hideInitialLoader();
            if (!isCurrent('driver.html')) {
                window.location.replace('/driver.html');
            }
            return;
        }

        currentUser = profile;
        cacheProfile(profile);
        updateDriverAvailabilityUI(currentUser.driverAvailability);
        checkDriverAccountHoldStatus(user);
        registerDriverPushToken(db, currentUser.uid).catch((error) => {
            console.warn("Driver service push token registration failed:", error);
        });

        // Bind control buttons
        document.getElementById("driver-go-online-btn")?.addEventListener("click", () => {
            toggleDriverOnlineStatus("searching");
        });
        document.getElementById("driver-empty-go-online-link")?.addEventListener("click", (e) => {
            e.preventDefault();
            toggleDriverOnlineStatus("searching");
        });
        document.getElementById("driver-service-live-pill")?.addEventListener("click", () => {
            if (activeRide) return;
            const isCurrentlyOffline = (currentUser?.driverAvailability || "offline") === "offline";
            toggleDriverOnlineStatus(isCurrentlyOffline ? "searching" : "offline");
        });
        document.getElementById("driver-recenter-btn")?.addEventListener("click", () => {
            if (map && lastPosition) map.panTo(lastPosition);
        });
        document.getElementById("driver-zoom-in-btn")?.addEventListener("click", () => {
            if (map) map.setZoom((map.getZoom() || 15) + 1);
        });
        document.getElementById("driver-zoom-out-btn")?.addEventListener("click", () => {
            if (map) map.setZoom((map.getZoom() || 15) - 1);
        });

        startActiveRideListener();
        startIncomingRideListener();
        startLocationTracking();
        hidePageLoader({ force: true });
        hideInitialLoader();
    } catch (error) {
        console.error("Driver service authentication failed:", error);
        hidePageLoader({ force: true });
        hideInitialLoader();
        showMessage("Could not load driver account", "Check your connection and retry the page.", "map");
    }
}

let geocoderInstance = null;
function updateDriverLocationDisplay(lat, lng) {
    const nameEl = document.getElementById("driver-location-name");
    if (!nameEl || !window.google?.maps?.Geocoder) return;

    if (!geocoderInstance) geocoderInstance = new window.google.maps.Geocoder();
    geocoderInstance.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === "OK" && results?.[0]) {
            const comps = results[0].address_components || [];
            const sublocality = comps.find(c => c.types.includes("sublocality") || c.types.includes("locality") || c.types.includes("neighborhood"))?.long_name;
            const state = comps.find(c => c.types.includes("administrative_area_level_1"))?.long_name;
            if (sublocality || state) {
                nameEl.textContent = [sublocality, state || "Tripura"].filter(Boolean).join(", ");
            } else {
                nameEl.textContent = results[0].formatted_address.split(",").slice(0, 2).join(",");
            }
        }
    });
}

function updateDriverAvailabilityUI(statusOverride) {
    const status = String(statusOverride || currentUser?.driverAvailability || "searching").toLowerCase();
    const isOffline = status === "offline";

    const offlineCard = document.getElementById("driver-offline-card");
    if (offlineCard) {
        offlineCard.classList.toggle("d-none", !isOffline);
    }

    const emptyTitle = document.querySelector("#driver-service-no-rides-msg .driver-empty-title");
    const emptySubtext = document.getElementById("driver-empty-subtext");
    if (emptyTitle && emptySubtext) {
        if (isOffline) {
            emptyTitle.textContent = t('driver.driver_offline', "Driver is offline");
            emptySubtext.innerHTML = t('driver.go_online_hint', "Go online to start receiving ride requests.");
        } else {
            emptyTitle.textContent = t('driver.no_active_requests', "No active requests");
            emptySubtext.innerHTML = t('driver.searching_nearby_passengers', "We are searching for nearby passengers.");
        }
    }

    const statusPill = document.getElementById("driver-service-live-pill");
    if (statusPill) {
        statusPill.dataset.state = isOffline ? "loading" : "ready";
        statusPill.textContent = isOffline ? t('driver.offline_pill', "OFFLINE") : t('driver.live_pill', "LIVE");
    }

    const statusText = document.getElementById("driver-service-status");
    if (statusText) {
        statusText.textContent = isOffline
            ? t('driver.currently_offline', "You are currently offline")
            : t('driver.online_searching', "Online & searching for passengers");
    }
}

async function toggleDriverOnlineStatus(targetStatus) {
    if (!auth.currentUser) return;
    const prevStatus = currentUser?.driverAvailability || "offline";
    const prevDesired = currentUser?.desiredAvailability || "offline";

    // 1. Instant Optimistic UI Update (0ms latency)
    if (currentUser) {
        currentUser.driverAvailability = targetStatus;
        currentUser.desiredAvailability = targetStatus === "offline" ? "offline" : "online";
        cacheProfile(currentUser);
    }
    updateDriverAvailabilityUI(targetStatus);

    if (targetStatus === "searching") {
        pollDriverNearbyDemand();
        if (!demandPollInterval) {
            demandPollInterval = setInterval(pollDriverNearbyDemand, 30000);
        }
        startLocationTracking();
        setTimeout(() => {
            registerDriverPushToken(db, currentUser?.uid).catch((error) => {
                console.warn("Driver push token registration failed:", error);
            });
        }, 0);
    } else {
        if (demandPollInterval) {
            clearInterval(demandPollInterval);
            demandPollInterval = null;
        }
        hideDriverDemandChip();
    }

    // 2. Fast background sync
    try {
        const locationData = lastPosition ? { lat: lastPosition.lat, lng: lastPosition.lng } : null;
        await updateDriverAvailabilityThroughBackend(targetStatus, locationData);
    } catch (err) {
        console.error("Toggle driver availability failed:", err);
        // Rollback state on error
        if (currentUser) {
            currentUser.driverAvailability = prevStatus;
            currentUser.desiredAvailability = prevDesired;
            cacheProfile(currentUser);
        }
        updateDriverAvailabilityUI(prevStatus);
        await showAlert(t('driver.update_status_network_failed', "Could not update online status. Check your connection."));
    }
}

bootstrapDriverService();

window.addEventListener('languageChanged', () => {
    const status = currentUser?.driverAvailability || "offline";
    updateDriverAvailabilityUI(status);
});
