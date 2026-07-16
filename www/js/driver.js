import { auth, db } from './firebase-init.js';
import {
    collection,
    doc,
    setDoc,
    updateDoc,
    getDoc,
    getDocs,
    query,
    where,
    onSnapshot,
    serverTimestamp,
    increment,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { setRideActive } from './wake-lock.js?v=20260712-wake-lock';
import {
    registerDriverPushToken,
    startRideRequestRing,
    stopRideRequestRing
} from './messaging.js?v=20260713-driver-push';

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const DRIVER_ACTIVE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;
const DRIVER_NOTIFICATION_ELIGIBLE_MS = 30 * 60 * 1000;
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
// Smoothed (exponential moving average) coordinates + write-gate bookkeeping,
// tracked separately for the "searching" presence watch and the "on trip" watch.
let lastPresenceSmoothedPosition = null;
let lastPresenceWrittenPosition = null;
let lastPresenceWriteAt = 0;
let lastActiveSmoothedPosition = null;
let lastActiveWrittenPosition = null;
let lastActiveWriteAt = 0;

function addOptionalClickListener(elementId, handler) {
    const element = document.getElementById(elementId);
    if (element) {
        element.addEventListener('click', handler);
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

function showDriverHome(profile) {
    document.getElementById('driver-review-view')?.classList.add('d-none');
    document.getElementById('driver-review-view')?.classList.remove('d-flex');
    document.getElementById('driver-view')?.classList.remove('d-none');
    document.getElementById('driver-view')?.classList.add('d-flex');

    const welcomeName = document.getElementById('driver-welcome-name');
    if (welcomeName) welcomeName.innerText = `Welcome, ${profile.name || "Driver"}`;
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
    const label = document.getElementById('driver-duty-state');
    const helper = document.getElementById('driver-duty-helper');
    const noRidesMsg = document.getElementById('no-rides-msg');

    if (switchInput) switchInput.checked = isDriverDutyOnline();
    if (pill) {
        pill.textContent = isDriverDutyOnline() ? "Online" : "Offline";
        pill.classList.toggle('offline', !isDriverDutyOnline());
    }
    if (label) label.textContent = isDriverDutyOnline() ? "Online for rides" : "Offline";
    if (helper) {
        helper.textContent = isDriverDutyOnline()
            ? "Ride alerts can continue for 30 minutes after your last fresh location."
            : "Passengers cannot see you and ride alerts are paused.";
    }
    if (noRidesMsg) {
        noRidesMsg.querySelector('span').innerText = isDriverDutyOnline() ? "Live" : "Offline";
        noRidesMsg.querySelector('strong').innerText = isDriverDutyOnline()
            ? "Searching nearby passengers"
            : "Duty switch is off";
        noRidesMsg.querySelector('p').innerText = isDriverDutyOnline()
            ? "Keep location enabled to receive targeted requests."
            : "Turn online when you are ready to receive ride requests.";
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
    if (!currentUser || currentUser.role !== "driver") return;
    currentUser.driverAvailability = status;
    currentUser.desiredAvailability = status === "offline" ? "offline" : "online";
    driverDutyOnline = currentUser.desiredAvailability === "online";
    updateDutySwitchUi();

    try {
        if (status === "offline") stopPresenceTracking();
        await updateDriverAvailabilityThroughBackend(status);
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
    if (!currentUser || currentUser.role !== "driver") return;
    if (!isDriverDutyOnline() && fallbackAvailability !== "busy") return;

    currentUser.driverAvailability = currentlyAssignedRideId ? "busy" : currentUser.driverAvailability || fallbackAvailability;
    currentUser.desiredAvailability = "online";

    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");
    const response = await fetch("/api/rides/driver-location", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ lat, lng, rideId: currentlyAssignedRideId || null, ...telemetry })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not update driver GPS location.");
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
        await transitionRideThroughBackend(rideId, "mark_paid");
        return true;
    } catch (error) {
        console.error("Trip history creation failed:", error);
        alert(error.message || "Could not confirm payment and save trip history.");
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

    const q = query(
        collection(db, "rides"),
        where("eligible_driver_ids", "array-contains", currentUser.uid)
    );

    activeDriverJobsListener = onSnapshot(q, (querySnapshot) => {
        ridesContainer.innerHTML = "";
        ridesContainer.appendChild(noRidesMsg);

        if (querySnapshot.empty || !isDriverDutyOnline()) {
            stopRideRequestRing();
            noRidesMsg.classList.remove('d-none');
            return;
        }

        noRidesMsg.classList.add('d-none');
        let renderedRideCount = 0;
        let firstPendingRide = null;

        querySnapshot.forEach((docSnapshot) => {
            const rideId = docSnapshot.id;
            const ride = docSnapshot.data();

            if (ride.status !== "pending" || ride.driver_id) return;
            if (ride.vehicle_type && ride.vehicle_type !== inferVehicleTypeFromProfile(currentUser)) return;
            renderedRideCount += 1;
            if (!firstPendingRide) {
                firstPendingRide = {
                    id: rideId,
                    body: `${getRideDisplayAddress(ride, "pickup")} to ${getRideDisplayAddress(ride, "drop")}`
                };
            }

            const card = document.createElement('div');
            card.className = "card p-3 mb-3 border-start border-primary border-4 shadow-sm";
            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div>
                        <h6 class="fw-bold mb-1 text-dark">${ride.passenger_name}</h6>
                        <span class="badge bg-light text-dark border mb-2">${ride.service_name || getServiceLabel(ride.vehicle_type)} · ${ride.passenger_capacity || (ride.vehicle_type === "auto" ? 4 : 1)} passenger${Number(ride.passenger_capacity || 1) === 1 ? "" : "s"}</span>
                        <p class="mb-1 text-muted small"><strong>From:</strong> ${escapeHtml(getRideDisplayAddress(ride, "pickup"))}</p>
                        <p class="mb-2 text-muted small"><strong>To:</strong> ${escapeHtml(getRideDisplayAddress(ride, "drop"))}</p>
                        <div class="driver-location-preview-row">
                            ${renderLocationPreviewLink("Preview pickup", ride.pickup_lat, ride.pickup_lng)}
                            ${renderLocationPreviewLink("Preview destination", ride.drop_lat, ride.drop_lng)}
                        </div>
                    </div>
                    <span class="badge bg-primary fs-6">Rs ${ride.fare}</span>
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
                <button class="btn btn-sm btn-success w-100 fw-bold mt-2 accept-job-btn" data-id="${rideId}">
                    Accept Ride Request
                </button>
            `;

            ridesContainer.appendChild(card);
        });

        if (renderedRideCount === 0) {
            stopRideRequestRing();
            noRidesMsg.classList.remove('d-none');
        } else {
            startRideRequestRing(firstPendingRide || {});
        }

        document.querySelectorAll('.accept-job-btn').forEach(btn => {
            btn.addEventListener('click', (event) => acceptRideJob(event.target.getAttribute('data-id')));
        });
    });
}

function attachDriverTripListener(rideRef) {
    if (activeDriverTripListener) activeDriverTripListener();

    activeDriverTripListener = onSnapshot(rideRef, (docSnap) => {
        if (!docSnap.exists()) return;
        const currentRideData = docSnap.data();

        if (currentRideData.status === "cancelled_by_passenger") {
            alert("The passenger has cancelled this ride request.");
            setRideActive(false);

            if (activeDriverLocationWatchId !== null) {
                navigator.geolocation.clearWatch(activeDriverLocationWatchId);
                activeDriverLocationWatchId = null;
            }

            document.getElementById('active-trip-container').classList.add('d-none');
            currentlyAssignedRideId = null;
            activeDriverRideData = null;
            activeDriverRenderedStatus = null;
            setDriverAvailability("searching");

            if (activeDriverTripListener) activeDriverTripListener();
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

    activeDriverLocationWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
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
                await updateDoc(rideRef, {
                    driverLocation: { lat, lng },
                    ...telemetryResult.telemetry
                });
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

async function acceptRideJob(rideId) {
    try {
        stopRideRequestRing();
        const result = await acceptRideThroughBackend(rideId);
        const acceptedRideData = result.ride || {};
        await setDriverAvailability("busy");
        currentlyAssignedRideId = rideId;
        setRideActive(true);
        activeDriverRideData = acceptedRideData;
        document.getElementById('active-trip-container').classList.remove('d-none');
        renderActiveTripStatus("accepted", activeDriverRideData);
        attachDriverTripListener(doc(db, "rides", rideId));
        startDriverGpsBroadcast(doc(db, "rides", rideId));
    } catch (error) {
        console.error("Failed to commit transactional state adjustment:", error);
        alert(error.message || "Could not accept this ride.");
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
        alert("Could not update trip status. Please try again.");
    }
}

async function verifyAndStartTrip(rideId) {
    if (!rideId) {
        alert("No active ride found for PIN verification.");
        return;
    }

    const pinInput = document.getElementById('verification-pin-input');
    const typedPin = pinInput ? pinInput.value.trim() : "";

    if (!/^\d{4}$/.test(typedPin)) {
        alert("Please enter the 4-digit passenger PIN.");
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
        alert("Could not verify PIN. Please try again.");
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
        document.getElementById('driver-final-fare').innerText = `Rs ${finalFare}`;

        const driverUPI = currentUser.upiId;
        const upiQrImage = document.getElementById('upi-qr-image');

        if (driverUPI) {
            const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
            upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
            upiQrImage.classList.remove('d-none');
        } else {
            upiQrImage.src = "";
            upiQrImage.classList.add('d-none');
            alert("Your driver UPI ID is missing from your profile. Please collect cash for this ride.");
        }

        document.getElementById('driver-payment-view').classList.remove('d-none');
        if (activeDriverTripListener) activeDriverTripListener();
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
        currentlyAssignedRideId = null;
        setRideActive(false);
    } catch (error) {
        console.error("Error finalizing ride transaction:", error);
        alert("Database connection dropped during checkout.");
    }
}

async function cancelRideByDriver(rideId) {
    rideId = rideId || currentlyAssignedRideId;
    if (!rideId) {
        alert("No active trip found to cancel.");
        return;
    }

    if (!confirm("Warning: Cancelling active trips impacts your driver rating. Proceed?")) return;

    try {
        await transitionRideThroughBackend(rideId, "cancel");
        if (activeDriverTripListener) activeDriverTripListener();

        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        document.getElementById('active-trip-container').classList.add('d-none');
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
        alert("Trip aborted successfully. Status set to online.");

        currentlyAssignedRideId = null;
        setRideActive(false);
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
    if (profile.role !== "driver") {
        window.location.replace("index.html");
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
}

addOptionalClickListener('arrived-trip-btn', () => updateActiveRideStatus("arrived"));
addOptionalClickListener('start-trip-btn', () => updateActiveRideStatus("started"));
addOptionalClickListener('complete-trip-btn', completeRideJob);
addOptionalClickListener('cancel-driver-trip-btn', () => cancelRideByDriver());
addOptionalClickListener('driver-history-btn', () => {
    window.location.href = 'history.html';
});

addOptionalClickListener('driver-duty-switch', async (event) => {
    const checked = event.target.checked;
    event.target.disabled = true;
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
    }
});

addOptionalClickListener('close-driver-payment-btn', async () => {
    const closeBtn = document.getElementById('close-driver-payment-btn');
    closeBtn.disabled = true;
    closeBtn.innerText = "Saving trip history...";

    const saved = await markRidePaidAndCreateHistory(pendingDriverPaymentRideId);
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
        window.location.href = "login.html";
    } catch (error) {
        console.error("Logout failed:", error);
        alert("Could not logout. Please try again.");
    }
});

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "OPEN_DRIVER_RIDE") return;
        document.getElementById('available-rides-list')?.scrollIntoView({ behavior: "smooth", block: "start" });
        startRideRequestRing();
    });
}

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

        routeDriverProfile(userDocSnap.data());
    } catch (error) {
        console.warn("Driver auth session lookup failed:", error);
    }
});

window.addEventListener('beforeunload', () => {
    if (currentUser?.role === "driver") {
        updateDoc(doc(db, "users", currentUser.uid), {
            isConnected: false,
            lastAppSeenAt: serverTimestamp(),
            driverAvailabilityUpdatedAt: serverTimestamp()
        }).catch(() => {});
        setDoc(doc(db, "driverPresence", currentUser.uid), {
            isConnected: false,
            lastAppSeenAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }, { merge: true }).catch(() => {});
    }
});
