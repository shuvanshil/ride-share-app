import { auth, db } from '../platform/firebase-init.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    onSnapshot,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { acquireWakeLock, releaseWakeLock } from '../platform/wake-lock.js';
import { showAlert, showConfirm } from '../shared/dialog.js';
import { showPageLoader, hidePageLoader, setButtonBusy, hideInitialLoader } from '../shared/loading.js';
import { waitForAuth } from '../shared/auth.js';
import {
    registerDriverPushToken,
    startRideRequestRing,
    stopRideRequestRing
} from '../shared/messaging.js';

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const DRIVER_ACTIVE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;
const DRIVER_NOTIFICATION_ELIGIBLE_MS = 12 * 60 * 60 * 1000;
// Raw GPS fixes jitter by a few metres even while a vehicle is parked. Writing
// every single watchPosition callback straight to Firestore is what made the
// auto icon "glitch"/shift on both the driver's and the rider's map -- each
// noisy fix was rendered as if the vehicle had actually moved. These gates
// throttle writes to real movement, while still refreshing on a heartbeat so
// the driver doesn't look stale/offline while stationary.
const DRIVER_LOCATION_WRITE_DISTANCE_METERS = 8;
const DRIVER_LOCATION_WRITE_MIN_INTERVAL_MS = 4000;
// Slightly tighter gate while a ride is active, since the rider is watching
// the car move in real time and expects more frequent updates than the
// idle "searching for a ride" loop.
const DRIVER_ACTIVE_LOCATION_WRITE_DISTANCE_METERS = 5;
const DRIVER_ACTIVE_LOCATION_WRITE_MIN_INTERVAL_MS = 2500;

let currentUser = null;
let activeDriverLocationWatchId = null;
let driverPresenceWatchId = null;
let activeDriverTripListener = null;
let activeDriverJobsListener = null;
let currentlyAssignedRideId = null;
let pendingDriverPaymentRideId = null;
let activeDriverRenderedStatus = null;
let activeConsoleUid = null;
let activeDriverRideData = null;
let lastPresenceHeadingPosition = null;
let lastPresenceHeading = null;
let lastActiveHeadingPosition = null;
let lastActiveHeading = null;
let driverDutyOnline = true;
let driverPostRideAvailability = "searching";
let ignoredRideIds = [];
const DRIVER_IGNORED_RIDES_PREFIX = "liphtup_driver_ignored_requests_";

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

function renderOfflineEmptyState(container) {
    if (!container) return;
    const t = (k, f) => (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t(k) : f;
    const tOfflineTitle = t('driver.offline_title', "You're Offline");
    const tOfflineSub = t('driver.duty_switch_off', "Duty switch is off");
    const tOfflineDesc = t('driver.turn_online_desc', "Turn online to get new ride requests and start earning.");
    const tGoOnline = t('driver.go_online', "Go Online");

    container.className = "offline-empty-card";
    container.innerHTML = `
        <div class="offline-illustration-wrapper mb-3">
            <img src="assets/driver-offline-illustration.png" alt="${tOfflineTitle}" class="offline-illustration-img">
        </div>
        <h4 class="fw-bold text-dark mb-1">${tOfflineTitle}</h4>
        <p class="offline-subtitle fw-bold text-secondary mb-2">${tOfflineSub}</p>
        <p class="offline-desc text-muted small mb-4">${tOfflineDesc}</p>
        <button id="go-online-btn" class="btn-go-online" type="button">
            <span>⚡</span> ${tGoOnline}
        </button>
    `;
    const goOnlineBtn = container.querySelector('#go-online-btn');
    if (goOnlineBtn) {
        goOnlineBtn.addEventListener('click', () => {
            const dutySwitch = document.getElementById('driver-duty-switch');
            if (dutySwitch && !dutySwitch.checked) {
                dutySwitch.click();
            }
        });
    }
}

function renderOnlineEmptyState(container) {
    if (!container) return;
    const t = (k, f) => (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t(k) : f;
    const tAllSet = t('driver.all_set', "You're all set!");
    const tRequestsNotice = t('driver.new_requests_appear', "New ride requests will appear here.");

    container.className = "online-empty-card";
    container.innerHTML = `
        <div class="searching-icon-circle">
            <span>📡</span>
        </div>
        <h4 class="fw-bold text-dark mb-1">${tAllSet}</h4>
        <p class="text-muted small mb-0">${tRequestsNotice}</p>
    `;
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
    const card = document.querySelector(`.ride-request-card[data-ride-id="${rideId}"], .card[data-ride-id="${rideId}"]`);
    if (card) {
        card.classList.add('fade-out');
        setTimeout(() => {
            if (card) card.remove();
            recheckAvailableRidesCount();
        }, 280);
    } else {
        recheckAvailableRidesCount();
    }
}

function recheckAvailableRidesCount() {
    const ridesContainer = document.getElementById('available-rides-list');
    const remainingCards = ridesContainer ? ridesContainer.querySelectorAll('.ride-request-card, .card[data-ride-id]').length : 0;
    const requestsBadge = document.getElementById('incoming-requests-badge');
    const requestsCount = document.getElementById('incoming-requests-count');
    const noRidesMsg = document.getElementById('no-rides-msg');

    if (remainingCards === 0) {
        stopRideRequestRing();
        if (noRidesMsg) {
            noRidesMsg.classList.remove('d-none');
            if (isDriverDutyOnline()) {
                renderOnlineEmptyState(noRidesMsg);
            } else {
                renderOfflineEmptyState(noRidesMsg);
            }
        }
        if (requestsBadge) requestsBadge.classList.add('d-none');
    } else if (requestsBadge && requestsCount) {
        requestsCount.textContent = `${remainingCards} New`;
        requestsBadge.classList.remove('d-none');
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
        const timerVal = document.getElementById(`req-timer-val-${rideId}`);
        const timerPill = document.getElementById(`req-timer-${rideId}`);

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

// ==========================================
// PASSENGER SAFETY: EMERGENCY SOS (Feature 3)
// ==========================================
function getQuickPosition(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        const timer = setTimeout(() => resolve(null), timeoutMs);
        navigator.geolocation.getCurrentPosition(
            (position) => {
                clearTimeout(timer);
                resolve({ lat: position.coords.latitude, lng: position.coords.longitude });
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 }
        );
    });
}

async function sendDriverSos() {
    if (!currentlyAssignedRideId) {
        await showAlert("Start or accept a trip first, then use SOS during that trip.");
        return;
    }
    const confirmed = await showConfirm(
        "This alerts LiphtUp's safety team immediately with your location. For any life-threatening emergency, call local emergency services first.",
        { okText: "Send SOS", cancelText: "Cancel" }
    );
    if (!confirmed) return;

    try {
        const position = await getQuickPosition();
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch(`/api/rides/${encodeURIComponent(currentlyAssignedRideId)}/sos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify(position ? { lat: position.lat, lng: position.lng } : {})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not send the SOS alert.");
        await showAlert("SOS sent. LiphtUp's safety team has been alerted with your trip and location.");
    } catch (error) {
        console.error("SOS failed:", error);
        await showAlert(error.message || "Could not send the SOS alert. Please call local emergency services directly.");
    }
}

async function rejectRideThroughBackend(rideId) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not decline this ride.");
    }
}

// Smoothed (exponential moving average) coordinates + write-gate bookkeeping,
// tracked separately for the "searching" presence watch and the "on trip" watch.
let lastPresenceSmoothedPosition = null;
let lastPresenceWrittenPosition = null;
let lastPresenceWriteAt = 0;
let lastActiveSmoothedPosition = null;
let lastActiveWrittenPosition = null;
let lastActiveWriteAt = 0;

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

function addOptionalClickListener(elementId, handler) {
    const element = document.getElementById(elementId);
    if (element) {
        element.addEventListener('click', handler);
    }
}

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

function inferVehicleTypeFromProfile(driver) {
    const text = [
        driver.vehicle_type,
        driver.vehicleType,
        driver.vehicle_model,
        driver.vehicleModel,
        driver.vehicleName
    ].filter(Boolean).join(" ").toLowerCase();

    if (text.includes("auto") || text.includes("rickshaw") || text.includes("tuk")) return "auto";
    if (text.includes("bike") || text.includes("scooter") || text.includes("activa") || text.includes("motorcycle")) return "bike";
    return "";
}

function getServiceLabel(vehicleType) {
    return vehicleType === "auto" ? "Auto" : "Bike / Scooty";
}

function normalizeHeading(value) {
    const heading = Number(value);
    return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
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

// Blends a new raw GPS fix into the previous smoothed position instead of
// trusting each fix outright. Fixes reported with poor accuracy are trusted
// less, so a single noisy reading can't yank the marker sideways.
function smoothGpsCoordinate(previousSmoothed, rawCoords, accuracyMeters) {
    if (!previousSmoothed) return rawCoords;

    const accuracyWeight = Number.isFinite(accuracyMeters)
        ? Math.max(0.2, Math.min(1, 12 / Math.max(accuracyMeters, 6)))
        : 0.6;

    return {
        lat: previousSmoothed.lat + ((rawCoords.lat - previousSmoothed.lat) * accuracyWeight),
        lng: previousSmoothed.lng + ((rawCoords.lng - previousSmoothed.lng) * accuracyWeight)
    };
}

// Only write a location update when the vehicle actually moved a meaningful
// distance, or enough time has passed that a heartbeat write is due anyway
// (so the driver doesn't fall out of "online" freshness checks while parked).
function shouldWriteDriverLocation(
    lastWrittenPosition,
    lastWriteAt,
    candidatePosition,
    distanceThresholdMeters = DRIVER_LOCATION_WRITE_DISTANCE_METERS,
    minIntervalMs = DRIVER_LOCATION_WRITE_MIN_INTERVAL_MS
) {
    if (!lastWrittenPosition) return true;

    const elapsed = Date.now() - lastWriteAt;
    const moved = distanceMeters(lastWrittenPosition, candidatePosition);
    if (elapsed < minIntervalMs && moved < distanceThresholdMeters) {
        return false;
    }
    return true;
}

function buildDriverTelemetry(coords, browserCoords, previousPosition, previousHeading) {
    const telemetry = {};
    const gpsHeading = normalizeHeading(browserCoords?.heading);
    const moved = distanceMeters(previousPosition, coords);
    const calculatedHeading = moved >= DRIVER_HEADING_MIN_DISTANCE_METERS
        ? calculateBearing(previousPosition, coords)
        : null;
    const heading = gpsHeading ?? calculatedHeading ?? normalizeHeading(previousHeading);

    if (heading != null) telemetry.driverHeading = heading;
    if (Number.isFinite(Number(browserCoords?.speed))) telemetry.driverSpeed = Number(browserCoords.speed);
    if (Number.isFinite(Number(browserCoords?.accuracy))) telemetry.driverAccuracy = Number(browserCoords.accuracy);

    return { telemetry, heading };
}

function showDriverReview(profile) {
    document.getElementById('driver-view')?.classList.add('d-none');
    document.getElementById('driver-view')?.classList.remove('d-flex');

    const vehicleModel = profile.vehicleModel || profile.vehicle_model || "";
    const vehicleNumber = profile.vehicleNumber || profile.vehicle_number || "";
    const vehicleSummary = [vehicleModel, vehicleNumber].filter(Boolean).join(" - ") || "Not submitted";

    document.getElementById('driver-review-status').innerText = profile.verificationStatus || "pending_review";
    document.getElementById('driver-review-vehicle').innerText = vehicleSummary;
    document.getElementById('driver-review-license').innerText = profile.drivingLicenseNumber || "Not submitted";
    document.getElementById('driver-review-view')?.classList.remove('d-none');
    document.getElementById('driver-review-view')?.classList.add('d-flex');
}

function getGreetingPrefix() {
    const hour = new Date().getHours();
    const t = (k, f) => (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t(k) : f;
    if (hour >= 5 && hour < 12) return t('home.greeting_morning', "Good morning");
    if (hour >= 12 && hour < 17) return t('home.greeting_afternoon', "Good afternoon");
    return t('home.greeting_evening', "Good evening");
}

function showDriverHome(profile) {
    document.getElementById('driver-review-view')?.classList.add('d-none');
    document.getElementById('driver-review-view')?.classList.remove('d-flex');
    document.getElementById('driver-view')?.classList.remove('d-none');
    document.getElementById('driver-view')?.classList.add('d-flex');

    const welcomeName = document.getElementById('driver-welcome-name');
    if (welcomeName) {
        const rawName = String(profile.name || profile.displayName || "Driver").trim();
        const prefix = getGreetingPrefix();
        welcomeName.innerText = `${prefix}, ${rawName} 👋`;
    }

    const initialsEl = document.getElementById('driver-avatar-initials');
    const avatarCircle = document.getElementById('driver-greeting-avatar');
    if (avatarCircle) {
        if (profile.profile_photo_url || profile.avatarUrl) {
            avatarCircle.innerHTML = `<img src="${profile.profile_photo_url || profile.avatarUrl}" alt="Avatar">`;
        } else if (initialsEl) {
            const rawName = String(profile.name || "Driver").trim();
            const initials = rawName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || "DR";
            initialsEl.innerText = initials;
        }
    }
}

function getNotificationEligibleUntilDate() {
    return new Date(Date.now() + DRIVER_NOTIFICATION_ELIGIBLE_MS);
}

function getDriverDutyStatus(profile = currentUser) {
    if (profile?.desiredAvailability === "offline" || profile?.driverAvailability === "offline") {
        return "offline";
    }
    return "online";
}

function isDriverDutyOnline() {
    return driverDutyOnline === true;
}

function stopPresenceTracking() {
    if (driverPresenceWatchId !== null) {
        navigator.geolocation.clearWatch(driverPresenceWatchId);
        driverPresenceWatchId = null;
    }
}

function updateDutySwitchUi() {
    const switchInput = document.getElementById('driver-duty-switch');
    const pill = document.getElementById('driver-duty-pill');
    const pillText = document.getElementById('driver-duty-pill-text');
    const label = document.getElementById('driver-duty-state');
    const helper = document.getElementById('driver-duty-helper');
    const badge = document.getElementById('incoming-requests-badge');
    const noRidesMsg = document.getElementById('no-rides-msg');

    const online = isDriverDutyOnline();

    if (switchInput) switchInput.checked = online;
    if (pill) {
        pill.classList.toggle('online', online);
        pill.classList.toggle('offline', !online);
    }
    if (pillText) {
        pillText.textContent = online ? "Online" : "Offline";
    }
    if (label) {
        label.textContent = online ? "Online" : "Offline";
    }
    if (helper) {
        helper.textContent = online
            ? "Ride alerts can continue while you stay online, even if the app is minimized."
            : "Passengers cannot see you and ride alerts are paused.";
    }

    if (noRidesMsg) {
        if (!online) {
            renderOfflineEmptyState(noRidesMsg);
            if (badge) badge.classList.add('d-none');
        } else {
            const ridesContainer = document.getElementById('available-rides-list');
            const hasCards = ridesContainer ? ridesContainer.querySelectorAll('.ride-request-card, .card[data-ride-id]').length > 0 : false;
            if (!hasCards) {
                renderOnlineEmptyState(noRidesMsg);
                if (badge) badge.classList.add('d-none');
            }
        }
    }
}

async function updateDriverAvailabilityThroughBackend(status) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch("/api/rides/driver-availability", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ status })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not update driver availability.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

async function setDriverAvailability(status) {
    if (!auth.currentUser || !currentUser || currentUser.role !== "driver") return;
    currentUser.driverAvailability = status;
    currentUser.desiredAvailability = status === "offline" ? "offline" : "online";
    driverDutyOnline = currentUser.desiredAvailability === "online";
    updateDutySwitchUi();

    try {
        if (status === "offline") stopPresenceTracking();
        await updateDriverAvailabilityThroughBackend(status);
        cacheProfile(currentUser);
        if (status === "online" || status === "searching" || status === "busy") {
            registerDriverPushToken(db, currentUser.uid).catch((error) => {
                console.warn("Driver push token registration failed:", error);
            });
        }
    } catch (error) {
        console.warn("Driver availability update failed:", error);
    }
}

async function updateDriverPresenceLocation(lat, lng, fallbackAvailability = "searching", telemetry = {}) {
    try {
        const user = auth.currentUser;
        if (!user || user.role !== "driver") return;
        if (!isDriverDutyOnline() && fallbackAvailability !== "busy") return;

        const idToken = await user.getIdToken(false);
        const response = await fetch("/api/rides/driver-location", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ lat, lng, rideId: currentlyAssignedRideId || null, ...telemetry }),
            signal: AbortSignal.timeout(6000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            console.warn("Driver presence update error:", data.error);
        }
    } catch (error) {
        console.warn("Driver presence update failed:", error);
    }
}

function startDriverPresenceTracking() {
    if (!currentUser || currentUser.role !== "driver" || currentUser.verificationStatus !== "approved") return;
    if (!isDriverDutyOnline()) {
        stopPresenceTracking();
        return;
    }
    if (!navigator.geolocation) {
        console.warn("Driver presence tracking needs browser location access.");
        return;
    }

    stopPresenceTracking();

    driverPresenceWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            try {
                const rawCoords = { lat: position.coords.latitude, lng: position.coords.longitude };
                const smoothed = smoothGpsCoordinate(
                    lastPresenceSmoothedPosition,
                    rawCoords,
                    position.coords.accuracy
                );
                lastPresenceSmoothedPosition = smoothed;

                if (!shouldWriteDriverLocation(lastPresenceWrittenPosition, lastPresenceWriteAt, smoothed)) {
                    return;
                }
                lastPresenceWrittenPosition = smoothed;
                lastPresenceWriteAt = Date.now();

                const { lat, lng } = smoothed;
                const coords = { lat, lng };
                const telemetryResult = buildDriverTelemetry(
                    coords,
                    position.coords,
                    lastPresenceHeadingPosition,
                    lastPresenceHeading
                );
                lastPresenceHeadingPosition = coords;
                lastPresenceHeading = telemetryResult.heading;
                await updateDriverPresenceLocation(lat, lng, "searching", telemetryResult.telemetry);
            } catch (error) {
                console.warn("Driver presence update failed:", error);
            }
        },
        (error) => {
            console.warn("Driver presence GPS failed:", error);
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
}

function resetActiveTripButtons(status = "accepted") {
    const arrivedBtn = document.getElementById('arrived-trip-btn');
    const startBtn = document.getElementById('start-trip-btn');
    const completeBtn = document.getElementById('complete-trip-btn');

    arrivedBtn.classList.add('d-none');
    startBtn.classList.add('d-none');
    completeBtn.classList.toggle('d-none', status !== "en_route");
    completeBtn.disabled = status !== "en_route";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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
                    <span class="webicon webicon-call" aria-hidden="true" style="width:14px;height:14px;"></span>
                    <small>Call</small>
                </a>
            ` : `
                <button class="active-passenger-call" type="button" disabled aria-label="Passenger phone unavailable">
                    <span class="webicon webicon-call" aria-hidden="true" style="width:14px;height:14px;"></span>
                    <small>Call</small>
                </button>
            `}
        </div>
    `;
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

function renderActiveTripStatus(status, rideData = activeDriverRideData) {
    activeDriverRenderedStatus = status;
    activeDriverRideData = { ...(activeDriverRideData || {}), ...(rideData || {}), status };

    const labels = {
        accepted: "PIN verification required",
        arrived: "Arrived at pickup - ready to start",
        started: "Trip started - drive to destination",
        en_route: "Trip in Progress"
    };

    const activeTripDetails = document.getElementById('active-trip-details');
    const gpsStatusText = document.getElementById('gps-status')?.innerText || "GPS locking...";
    const pinVerificationHtml = status === "accepted" ? `
        <div id="verification-pin-panel" class="mt-3">
            <label for="verification-pin-input" class="form-label fw-semibold mb-1">Passenger PIN</label>
            <input id="verification-pin-input" type="tel" maxlength="4" inputmode="numeric" class="form-control text-center fw-bold mb-2" placeholder="Enter 4-digit PIN">
            <button id="verify-pin-btn" class="btn btn-success w-100 fw-bold">
                Verify & Start Trip
            </button>
        </div>
    ` : "";

    activeTripDetails.innerHTML = `
        ${renderActivePassengerContact(activeDriverRideData)}
        ${renderActiveTripRoute(activeDriverRideData)}
        <p class="mb-1"><strong>Status:</strong> ${labels[status] || status}</p>
        <p class="mb-0 text-secondary" id="gps-status">${gpsStatusText}</p>
        ${pinVerificationHtml}
    `;

    resetActiveTripButtons(status);

    const verifyPinBtn = document.getElementById('verify-pin-btn');
    if (verifyPinBtn) {
        verifyPinBtn.addEventListener('click', () => verifyAndStartTrip(currentlyAssignedRideId));
    }
}

function showDriverActiveTripPanel(status, rideData = activeDriverRideData) {
    document.getElementById('active-trip-container').classList.remove('d-none');
    document.getElementById('active-trip-details').innerHTML = `
        <p class="mb-1"><strong>Status:</strong> Restoring active trip...</p>
        <p class="mb-0 text-secondary" id="gps-status">GPS locking...</p>
    `;
    renderActiveTripStatus(status, rideData);
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

async function markRidePaidAndCreateHistory(rideId) {
    if (!rideId) {
        await showAlert("No completed ride found for payment confirmation.");
        return false;
    }

    try {
        await transitionRideThroughBackend(rideId, "mark_paid");
        return true;
    } catch (error) {
        console.error("Trip history creation failed:", error);
        await showAlert(error.message || "Could not confirm payment and save trip history.");
        return false;
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

async function restoreDriverActiveRide() {
    if (!currentUser || currentUser.role !== "driver" || currentUser.verificationStatus !== "approved") return;

    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("driver_id", "==", currentUser.uid),
            where("status", "in", DRIVER_ACTIVE_STATUSES)
        );
        const activeRideSnap = await getDocs(activeRideQuery);

        if (activeRideSnap.empty) return;

        const activeRideDoc = activeRideSnap.docs[0];
        const rideRef = doc(db, "rides", activeRideDoc.id);
        currentlyAssignedRideId = activeRideDoc.id;
        await setDriverAvailability("busy");
        activeDriverRideData = activeRideDoc.data();
        showDriverActiveTripPanel(activeDriverRideData.status, activeDriverRideData);
        attachDriverTripListener(rideRef);
        startDriverGpsBroadcast(rideRef);
    } catch (error) {
        console.error("Driver active ride restoration failed:", error);
    }
}

function initDriverJobsStream() {
    const ridesContainer = document.getElementById('available-rides-list');
    const noRidesMsg = document.getElementById('no-rides-msg');
    const requestsBadge = document.getElementById('incoming-requests-badge');
    const requestsCount = document.getElementById('incoming-requests-count');

    const q = query(
        collection(db, "rides"),
        where("eligible_driver_ids", "array-contains", currentUser.uid)
    );

    activeDriverJobsListener = onSnapshot(q, (querySnapshot) => {
        ridesContainer.innerHTML = "";
        ridesContainer.appendChild(noRidesMsg);

        if (querySnapshot.empty || !isDriverDutyOnline()) {
            clearAllRideRequestTimers();
            stopRideRequestRing();
            noRidesMsg.classList.remove('d-none');
            if (!isDriverDutyOnline()) {
                renderOfflineEmptyState(noRidesMsg);
            } else {
                renderOnlineEmptyState(noRidesMsg);
            }
            if (requestsBadge) requestsBadge.classList.add('d-none');
            return;
        }

        const validSnapshotRideIds = new Set();
        querySnapshot.forEach((docSnapshot) => validSnapshotRideIds.add(docSnapshot.id));

        // Clear timers for any ride that is no longer active / pending in the snapshot
        activeRideRequestTimers.forEach((_, trackedRideId) => {
            if (!validSnapshotRideIds.has(trackedRideId)) {
                clearRideRequestTimer(trackedRideId);
            }
        });

        let renderedRideCount = 0;
        let firstPendingRide = null;

        const ignored = loadIgnoredRideIds();
        querySnapshot.forEach((docSnapshot) => {
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
            if (ride.vehicle_type && ride.vehicle_type !== inferVehicleTypeFromProfile(currentUser)) {
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

            const passengerPhone = String(ride.passenger_phone || ride.passengerPhone || "").trim();
            const callablePhone = passengerPhone.replace(/[^\d+]/g, "");
            const passengerName = escapeHtml(ride.passenger_name || "Passenger");
            const fareAmount = Math.round(Number(ride.fare) || 0);
            const passCount = ride.passenger_capacity || (ride.vehicle_type === "auto" ? 3 : 1);

            const card = document.createElement('div');
            card.className = "ride-request-card card shadow-sm p-3 mb-3";
            card.dataset.rideId = rideId;
            card.innerHTML = `
                <div class="request-header-row">
                    <div class="passenger-name-wrap">
                        <h5 class="passenger-name mb-1">${passengerName}</h5>
                        <span class="vehicle-capacity-badge">
                            <span>👤</span> ${ride.service_name || getServiceLabel(ride.vehicle_type)} · ${passCount} passenger${Number(passCount) === 1 ? "" : "s"}
                        </span>
                    </div>
                    <div class="d-flex flex-column align-items-end gap-1">
                        <span class="fare-badge">₹${fareAmount}</span>
                        <div class="request-timer-pill ${remainingMs <= 60000 ? 'is-urgent' : ''}" id="req-timer-${rideId}">
                            <span class="timer-icon">⏳</span>
                            <span class="timer-label">Expires in</span>
                            <strong class="timer-val" id="req-timer-val-${rideId}">${formatCountdownTimer(remainingMs)}</strong>
                        </div>
                        ${callablePhone ? `
                            <a class="btn-call-passenger mt-1" href="tel:${callablePhone}" aria-label="Call ${passengerName}">
                                <span>📞</span> Call
                            </a>
                        ` : `
                            <button class="btn-call-passenger disabled mt-1" type="button" disabled aria-label="Phone unavailable">
                                <span>📞</span> Call
                            </button>
                        `}
                    </div>
                </div>

                <div class="route-display-box my-3">
                    <div class="route-step pickup">
                        <span class="route-dot green"></span>
                        <div class="route-text-group">
                            <span class="route-label">From: </span>
                            <span class="route-address">${escapeHtml(getRideDisplayAddress(ride, "pickup"))}</span>
                        </div>
                    </div>
                    <div class="route-step drop">
                        <span class="route-dot red"></span>
                        <div class="route-text-group">
                            <span class="route-label">To: </span>
                            <span class="route-address">${escapeHtml(getRideDisplayAddress(ride, "drop"))}</span>
                        </div>
                    </div>
                </div>

                <div class="location-preview-row">
                    ${renderLocationPreviewLink("Preview pickup", ride.pickup_lat, ride.pickup_lng)}
                    ${renderLocationPreviewLink("Preview destination", ride.drop_lat, ride.drop_lng)}
                </div>

                <div class="trip-metrics-card">
                    <div class="metric-column">
                        <small>Distance</small>
                        <strong>${formatRideDistance(ride.distance_km)}</strong>
                    </div>
                    <div class="metric-column text-end">
                        <small>Estimated time</small>
                        <strong>${formatRideDuration(ride.duration_minutes)}</strong>
                    </div>
                </div>

                <button class="btn-accept-ride accept-job-btn" data-id="${rideId}">
                    <span>✓</span> Accept Ride Request
                </button>
                <button class="btn-ignore-ride ignore-job-btn" data-id="${rideId}">
                    <span>✕</span> Ignore
                </button>
            `;

            ridesContainer.appendChild(card);
            attachRideCardCountdown(rideId, ride);
        });

        if (renderedRideCount === 0) {
            stopRideRequestRing();
            noRidesMsg.classList.remove('d-none');
            renderOnlineEmptyState(noRidesMsg);
            if (requestsBadge) requestsBadge.classList.add('d-none');
        } else {
            noRidesMsg.classList.add('d-none');
            if (requestsBadge && requestsCount) {
                requestsCount.textContent = `${renderedRideCount} New`;
                requestsBadge.classList.remove('d-none');
            }
            startRideRequestRing(firstPendingRide || {});
        }

        document.querySelectorAll('.accept-job-btn').forEach(btn => {
            btn.addEventListener('click', (event) => acceptRideJob(event.currentTarget.getAttribute('data-id')));
        });
        document.querySelectorAll('.ignore-job-btn').forEach(btn => {
            btn.addEventListener('click', (event) => ignoreRideRequest(event.currentTarget.getAttribute('data-id')));
        });
    });
}

function attachDriverTripListener(rideRef) {
    if (activeDriverTripListener) activeDriverTripListener();

    activeDriverTripListener = onSnapshot(rideRef, (docSnap) => {
        if (!docSnap.exists()) return;
        const currentRideData = docSnap.data();

        if (["cancelled_by_passenger", "cancelled_by_driver", "cancelled"].includes(currentRideData.status)) {
            const cancelledMsg = currentRideData.status === "cancelled_by_passenger"
                ? "Passenger cancelled this ride. You are back online."
                : "Trip cancelled. You are back online.";
            showAlert(cancelledMsg);
            releaseWakeLock();

            if (activeDriverLocationWatchId !== null) {
                navigator.geolocation.clearWatch(activeDriverLocationWatchId);
                activeDriverLocationWatchId = null;
            }

            document.getElementById('active-trip-container')?.classList.add('d-none');
            currentlyAssignedRideId = null;
            activeDriverRideData = null;
            activeDriverRenderedStatus = null;
            setDriverAvailability("searching");

            if (activeDriverTripListener) {
                activeDriverTripListener();
                activeDriverTripListener = null;
            }
            return;
        }

        if (DRIVER_ACTIVE_STATUSES.includes(currentRideData.status)) {
            const passengerChanged = currentRideData.passenger_name !== activeDriverRideData?.passenger_name
                || currentRideData.passenger_phone !== activeDriverRideData?.passenger_phone;
            activeDriverRideData = currentRideData;
            if (currentRideData.status !== activeDriverRenderedStatus || passengerChanged) {
                renderActiveTripStatus(currentRideData.status, currentRideData);
            }
        }
    });
}

function startDriverGpsBroadcast(rideRef) {
    if (!navigator.geolocation) return;

    if (activeDriverLocationWatchId !== null) {
        navigator.geolocation.clearWatch(activeDriverLocationWatchId);
        activeDriverLocationWatchId = null;
    }

    lastActiveSmoothedPosition = null;
    lastActiveWrittenPosition = null;
    lastActiveWriteAt = 0;
    lastActiveHeadingPosition = null;
    lastActiveHeading = null;

    activeDriverLocationWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const rawCoords = { lat: position.coords.latitude, lng: position.coords.longitude };
            const smoothed = smoothGpsCoordinate(
                lastActiveSmoothedPosition,
                rawCoords,
                position.coords.accuracy
            );
            lastActiveSmoothedPosition = smoothed;

            if (!shouldWriteDriverLocation(
                lastActiveWrittenPosition,
                lastActiveWriteAt,
                smoothed,
                DRIVER_ACTIVE_LOCATION_WRITE_DISTANCE_METERS,
                DRIVER_ACTIVE_LOCATION_WRITE_MIN_INTERVAL_MS
            )) {
                return;
            }

            lastActiveWrittenPosition = smoothed;
            lastActiveWriteAt = Date.now();

            const lat = smoothed.lat;
            const lng = smoothed.lng;
            const coords = { lat, lng };
            const telemetryResult = buildDriverTelemetry(
                coords,
                position.coords,
                lastActiveHeadingPosition,
                lastActiveHeading
            );
            lastActiveHeadingPosition = coords;
            lastActiveHeading = telemetryResult.heading;

            if (currentlyAssignedRideId) {
                await updateDriverPresenceLocation(lat, lng, "busy", telemetryResult.telemetry);
                document.getElementById('gps-status').innerText = "GPS Active & Broadcasting";
            }
        },
        (error) => {
            console.error("GPS Tracking Error:", error);
            document.getElementById('gps-status').innerText = "GPS Signal Lost. Please enable location.";
        },
        { enableHighAccuracy: true, maximumAge: 0 }
    );
}

function setRideListBusy(busy) {
    document.querySelectorAll('.accept-job-btn, .ignore-job-btn').forEach((btn) => {
        if (busy) {
            btn.dataset.luWasDisabled = btn.disabled ? "1" : "0";
            btn.disabled = true;
        } else if (btn.dataset.luWasDisabled !== undefined) {
            btn.disabled = btn.dataset.luWasDisabled === "1";
            delete btn.dataset.luWasDisabled;
        }
    });
}

async function acceptRideJob(rideId) {
    setRideListBusy(true);
    const clickedBtn = document.querySelector(`.accept-job-btn[data-id="${CSS.escape(rideId)}"]`);
    const restoreBtn = setButtonBusy(clickedBtn, "Accepting…");

    try {
        clearRideRequestTimer(rideId);
        stopRideRequestRing();
        driverPostRideAvailability = currentUser?.desiredAvailability === "offline" ? "offline" : "searching";
        const result = await acceptRideThroughBackend(rideId);
        const acceptedRideData = result.ride || {};
        await setDriverAvailability("busy");
        currentlyAssignedRideId = rideId;
        acquireWakeLock();
        activeDriverRideData = acceptedRideData;
        document.getElementById('active-trip-container').classList.remove('d-none');
        renderActiveTripStatus("accepted", activeDriverRideData);
        attachDriverTripListener(doc(db, "rides", rideId));
        startDriverGpsBroadcast(doc(db, "rides", rideId));

        showPageLoader("Ride accepted — opening trip console…");

        const serviceUrl = new URL("/driver-service.html", window.location.href);
        serviceUrl.searchParams.set("rideId", rideId);
        window.location.href = serviceUrl.href;
    } catch (error) {
        console.error("Failed to commit transactional state adjustment:", error);
        restoreBtn();
        setRideListBusy(false);

        clearRideRequestTimer(rideId);
        removeExpiredRideCard(rideId);

        const isCancelled = /cancelled|no longer available|no longer exists|cancelled by the passenger/i.test(error.message || "");
        const isExpired = /expired|timeout|time limit/i.test(error.message || "");
        const alreadyTaken = /already accepted/i.test(error.message || "");

        if (isCancelled) {
            await showAlert("This ride request was cancelled by the passenger.");
        } else if (isExpired) {
            await showAlert("This ride request has expired.");
        } else if (alreadyTaken) {
            await showAlert("Another driver already accepted this ride. Refreshing the list…");
        } else {
            await showAlert(error.message || "Could not accept this ride.");
        }
    }
}

async function acceptRideThroughBackend(rideId) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not accept this ride.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

async function updateActiveRideStatus(nextStatus) {
    if (!currentlyAssignedRideId) {
        console.error("Cannot update trip status: active ride tracker lost.");
        return;
    }

    try {
        const backendAction = { arrived: "arrive", started: "start" }[nextStatus];
        if (!backendAction) throw new Error(`Unsupported ride status: ${nextStatus}.`);
        const result = await transitionRideThroughBackend(currentlyAssignedRideId, backendAction);
        activeDriverRideData = result.ride || { ...activeDriverRideData, status: nextStatus };
        renderActiveTripStatus(nextStatus, activeDriverRideData);
    } catch (error) {
        console.error("Trip status update failed:", error);
        await showAlert("Could not update trip status. Please try again.");
    }
}

async function verifyAndStartTrip(rideId) {
    if (!rideId) {
        await showAlert("No active ride found for PIN verification.");
        return;
    }

    const pinInput = document.getElementById('verification-pin-input');
    const typedPin = pinInput ? pinInput.value.trim() : "";

    if (!/^\d{4}$/.test(typedPin)) {
        await showAlert("Please enter the 4-digit passenger PIN.");
        return;
    }

    try {
        const result = await transitionRideThroughBackend(rideId, "verify_pin", typedPin);
        activeDriverRideData = result.ride || { ...activeDriverRideData, status: "en_route" };

        const verificationPanel = document.getElementById('verification-pin-panel');
        if (verificationPanel) verificationPanel.classList.add('d-none');

        renderActiveTripStatus("en_route", activeDriverRideData);
    } catch (error) {
        console.error("PIN verification failed:", error);
        await showAlert("Could not verify PIN. Please try again.");
    }
}

async function completeRideJob() {
    if (!currentlyAssignedRideId) {
        console.error("Cannot complete trip: active tracker lost.");
        return;
    }

    const completedRideId = currentlyAssignedRideId;
    try {
        const result = await transitionRideThroughBackend(completedRideId, "complete");
        const finalFare = parseFloat(result.ride?.fare || activeDriverRideData?.fare || 0);
        pendingDriverPaymentRideId = completedRideId;
        document.getElementById('driver-final-fare').innerText = formatFareAmount(finalFare);

        const driverUPI = currentUser.upiId;
        const upiQrImage = document.getElementById('upi-qr-image');

        if (driverUPI) {
            const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
            upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
            upiQrImage.classList.remove('d-none');
        } else {
            upiQrImage.src = "";
            upiQrImage.classList.add('d-none');
            await showAlert("Your driver UPI ID is missing from your profile. Please collect cash for this ride.");
        }

        document.getElementById('driver-payment-view').classList.remove('d-none');
        renderFareAdjustmentNote('driver-fare-note', result.ride);
        if (activeDriverTripListener) activeDriverTripListener();
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
        currentlyAssignedRideId = null;
        releaseWakeLock();
        await setDriverAvailability(driverPostRideAvailability);
    } catch (error) {
        console.error("Error finalizing ride transaction:", error);
        await showAlert("Database connection dropped during checkout.");
    }
}

async function cancelRideByDriver(rideId) {
    rideId = rideId || currentlyAssignedRideId;
    if (!rideId) {
        await showAlert("No active trip found to cancel.");
        return;
    }

    if (!(await showConfirm("Are you sure you want to cancel this trip and proceed?"))) return;

    try {
        const result = await transitionRideThroughBackend(rideId, "cancel");
        if (activeDriverTripListener) activeDriverTripListener();

        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        document.getElementById('active-trip-container').classList.add('d-none');
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
        await showAlert(fareAdjustmentMessage(result.ride, "Trip cancelled. You are back online."));

        currentlyAssignedRideId = null;
        releaseWakeLock();
        await setDriverAvailability("searching");
    } catch (error) {
        console.error("Driver cancel execution failure:", error);
    }
}

function startDriverConsole(profile) {
    if (activeConsoleUid === profile.uid) {
        currentUser = { ...currentUser, ...profile };
        driverDutyOnline = getDriverDutyStatus(currentUser) === "online";
        showDriverHome(currentUser);
        updateDutySwitchUi();
        return;
    }

    activeConsoleUid = profile.uid;
    currentUser = profile;
    driverDutyOnline = getDriverDutyStatus(profile) === "online";
    showDriverHome(profile);
    updateDutySwitchUi();
    if (isDriverDutyOnline()) {
        setDriverAvailability(profile.driverAvailability === "busy" ? "busy" : "searching");
        startDriverPresenceTracking();
    } else {
        stopPresenceTracking();
    }
    initDriverJobsStream();
    restoreDriverActiveRide();
}

function routeDriverProfile(profile) {
    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));

    if (profile.role !== "driver") {
        if (!isCurrent('index.html')) {
            window.location.replace("/index.html");
        }
        return;
    }

    cacheProfile(profile);

    if (profile.verificationStatus === "approved") {
        startDriverConsole(profile);
    } else {
        currentUser = profile;
        showDriverReview(profile);
    }
}

const cachedProfile = getCachedProfile();
if (cachedProfile) {
    routeDriverProfile(cachedProfile);
    hideInitialLoader();
}

addOptionalClickListener('arrived-trip-btn', () => updateActiveRideStatus("arrived"));
addOptionalClickListener('start-trip-btn', () => updateActiveRideStatus("started"));
addOptionalClickListener('complete-trip-btn', completeRideJob);
addOptionalClickListener('cancel-driver-trip-btn', () => cancelRideByDriver());
addOptionalClickListener('driver-sos-btn', () => sendDriverSos());
addOptionalClickListener('driver-history-btn', () => {
    window.location.href = '/history.html';
});
addOptionalClickListener('driver-earnings-btn', () => {
    window.location.href = '/history.html';
});
addOptionalClickListener('logout-btn-review', async () => {
    window.LiphtUpLoading?.showPageLoader?.("Logging out...");
    try {
        clearCachedProfile();
        await setDriverAvailability("offline");
        await signOut(auth);
        window.location.href = "/login.html";
    } catch (error) {
        console.error("Logout failed:", error);
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
        await showAlert("Could not logout. Please try again.");
    }
});
addOptionalClickListener('driver-duty-switch', async (event) => {
    const checked = event.target.checked;
    event.target.disabled = true;
    window.LiphtUpLoading?.showPageLoader?.("Updating online status...");
    try {
        if (checked) {
            driverDutyOnline = true;
            currentUser.desiredAvailability = "online";
            await registerDriverPushToken(db, currentUser.uid).catch((error) => {
                console.warn("Driver push token registration failed:", error);
            });
            await setDriverAvailability(currentlyAssignedRideId ? "busy" : "searching");
            startDriverPresenceTracking();
        } else {
            driverDutyOnline = false;
            currentUser.desiredAvailability = "offline";
            stopRideRequestRing();
            await setDriverAvailability("offline");
        }
    } finally {
        event.target.disabled = false;
        updateDutySwitchUi();
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
});

addOptionalClickListener('close-driver-payment-btn', async () => {
    const closeBtn = document.getElementById('close-driver-payment-btn');
    closeBtn.disabled = true;
    closeBtn.innerText = "Saving trip history...";
    window.LiphtUpLoading?.showPageLoader?.("Saving trip history...");

    const saved = await markRidePaidAndCreateHistory(pendingDriverPaymentRideId);
    window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    if (!saved) {
        closeBtn.disabled = false;
        closeBtn.innerText = "Fare Received & Clear";
        return;
    }

    document.getElementById('driver-payment-view').classList.add('d-none');
    window.location.reload();
});

addOptionalClickListener('logout-btn', async () => {
    try {
        clearCachedProfile();
        await setDriverAvailability("offline");
        await signOut(auth);
        window.location.href = "/login.html";
    } catch (error) {
        console.error("Logout failed:", error);
        await showAlert("Could not logout. Please try again.");
    }
});

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "OPEN_DRIVER_RIDE") return;
        document.getElementById('available-rides-list')?.scrollIntoView({ behavior: "smooth", block: "start" });
        startRideRequestRing();
    });
}

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

async function bootstrapDriver() {
    const user = await waitForAuth();
    if (!user) {
        window.location.replace("/login.html");
        return;
    }

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (!userDocSnap.exists()) {
            clearCachedProfile();
            window.location.replace("/login.html");
            return;
        }
        routeDriverProfile(userDocSnap.data());
        checkDriverAccountHoldStatus(user);
        hideInitialLoader();
    } catch (error) {
        console.warn("Driver auth session lookup failed:", error);
        hideInitialLoader();
    }
}

bootstrapDriver();
