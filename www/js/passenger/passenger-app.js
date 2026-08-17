import { auth, db } from '../platform/firebase-init.js';
import { 
    collection, 
    doc, 
    getDoc,
    getDocs,
    query, 
    where,
    onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { calculateServiceFare, getServiceFarePolicy } from '../shared/fare-policy.js';
import { showAlert, showConfirm } from '../shared/dialog.js';
import { share, copyToClipboard } from '../platform/share.js';
import { getCurrentPosition } from '../platform/geolocation.js';

const ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"];
const DISPATCH_BATCH_SIZE = 10;
const DISPATCH_TIMEOUT_MS = 15000;
const MAX_SEARCH_DURATION_MS = 100000; // 100 seconds search timeout limit
const DRIVER_LOCATION_VISIBLE_MS = 15 * 60 * 1000;
const APP_SHARE_URL = "https://liphtup.in/";
const APP_SHARE_TITLE = "LiphtUp";
const APP_SHARE_TEXT = "Ride Together, Save Together. Invite friends and unlock exciting LiphtUp discounts.";
const UNCLEAR_LOCATION_LABELS = new Set(["current location", "current", "my location", "pinned pickup", "pinned destination"]);

const AVAILABILITY_THRESHOLDS = {
    HIGH: 3,
    MODERATE: 1,
    VERY_LOW: 0
};
const DEFAULT_SEARCH_RADIUS_METERS = 5000;
const EXPANDED_SEARCH_RADIUS_METERS = 12000;
const SEARCH_WINDOW_SECONDS = 35;

// Global variables
let currentUser = null;
let activeRideListener = null;          // For Passenger monitoring
let activeDispatchExpansionTimer = null;
let activeSearchTimeoutTimer = null;
const passengerSearchStartTimes = {};

let currentPassengerRideId = null;
let currentPassengerRideData = null;

let currentSearchRadiusMeters = DEFAULT_SEARCH_RADIUS_METERS;
let searchStateInterval = null;
let searchDotsCycle = 0;
let searchStartedAt = 0;
let activePendingRequestId = null;
let activePendingRequestData = null;

const SEARCH_STATUS_MESSAGES = [
    { maxSec: 7, headline: "Finding the best driver for you...", subline: "This usually takes less than 35s" },
    { maxSec: 15, headline: "Checking nearby drivers...", subline: "Reaching out to vehicles near your pickup" },
    { maxSec: 25, headline: "Waiting on driver confirmation...", subline: "Almost there, securing your ride" },
    { maxSec: 999, headline: "Still looking for available drivers...", subline: "It's a quiet hour, expanding our search" }
];

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

function cleanAddressPart(value) {
    return String(value || "").trim();
}

function compactAddressParts(parts = []) {
    const seen = new Set();
    return parts
        .map(cleanAddressPart)
        .filter(Boolean)
        .filter((part) => {
            const key = part.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function isUnclearLocationLabel(value) {
    const label = cleanAddressPart(value).toLowerCase();
    return !label || UNCLEAR_LOCATION_LABELS.has(label);
}

async function reverseGeocodeRidePoint(lat, lng) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;

    try {
        const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
        const response = await fetch(`/api/google-reverse-geocode?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        return response.ok ? data.result || null : null;
    } catch (error) {
        console.warn("Ride address reverse geocode failed:", error);
        return null;
    }
}

function buildRideAddressFields(prefix, geocode, originalLabel = "") {
    const displayAddress = compactAddressParts([
        geocode?.displayAddress,
        geocode?.fullAddress
    ])[0] || "";
    const fallbackAddress = !isUnclearLocationLabel(originalLabel) ? cleanAddressPart(originalLabel) : "";

    return {
        [`${prefix}_display_address`]: displayAddress || fallbackAddress,
        [`${prefix}_formatted_address`]: cleanAddressPart(geocode?.fullAddress),
        [`${prefix}_landmark`]: cleanAddressPart(geocode?.landmark || geocode?.name),
        [`${prefix}_road`]: cleanAddressPart(geocode?.road),
        [`${prefix}_locality`]: cleanAddressPart(geocode?.locality),
        [`${prefix}_city`]: cleanAddressPart(geocode?.city),
        [`${prefix}_district`]: cleanAddressPart(geocode?.district),
        [`${prefix}_pin_code`]: cleanAddressPart(geocode?.pinCode),
        [`${prefix}_reverse_geocoded_at`]: geocode ? new Date().toISOString() : ""
    };
}

function setPassengerDestinationLocked(locked, destinationName = "", pickupName = "") {
    const dropInput = document.getElementById('drop-input');
    if (!dropInput) return;

    const pickupInput = document.getElementById('pickup-input');
    if (pickupInput) {
        if (locked && pickupName) pickupInput.value = pickupName;
        pickupInput.readOnly = locked;
        pickupInput.setAttribute('aria-readonly', String(locked));
        pickupInput.classList.toggle('destination-locked', locked);
    }

    const refreshLocationBtn = document.getElementById('refresh-location-btn');
    if (refreshLocationBtn) {
        refreshLocationBtn.disabled = locked;
        refreshLocationBtn.classList.toggle('d-none', locked);
    }

    if (locked && destinationName) {
        dropInput.value = destinationName;
    }

    dropInput.readOnly = locked;
    dropInput.setAttribute('aria-readonly', String(locked));
    dropInput.classList.toggle('destination-locked', locked);
    dropInput.title = locked
        ? "Destination is fixed for this ride. Cancel the ride to choose another destination."
        : "";

    const clearDropBtn = document.getElementById('clear-drop-btn');
    if (clearDropBtn) {
        clearDropBtn.disabled = locked;
        clearDropBtn.classList.toggle('d-none', locked);
    }

    window.dispatchEvent(new CustomEvent('passenger-destination-lock-changed', {
        detail: { locked }
    }));
}

function setPassengerServiceLocked(locked, ride = {}) {
    window.dispatchEvent(new CustomEvent('passenger-service-lock-changed', {
        detail: {
            locked,
            vehicleType: ride.vehicle_type || ride.id || "",
            serviceName: ride.service_name || ride.name || "",
            fare: Number(ride.fare),
            distanceKm: Number(ride.distance_km)
        }
    }));
}

function hasPassengerLifecycleSurface() {
    return Boolean(
        document.getElementById('request-ride-btn') &&
        document.getElementById('fare-quote-box') &&
        document.getElementById('drop-input')
    );
}

function addOptionalClickListener(elementId, handler) {
    const element = document.getElementById(elementId);
    if (element) {
        element.addEventListener('click', handler);
    }
}


function setInviteFriendsStatus(message = "") {
    const statusEl = document.getElementById('invite-friends-status');
    if (statusEl) statusEl.innerText = message;
}

async function inviteFriends() {
    const shareData = {
        title: APP_SHARE_TITLE,
        text: APP_SHARE_TEXT,
        url: APP_SHARE_URL
    };

    setInviteFriendsStatus("Opening share...");

    try {
        const result = await share(shareData);
        if (result && result.ok) {
            setInviteFriendsStatus("");
            return;
        }
        if (result && result.reason === 'aborted') {
            setInviteFriendsStatus("");
            return;
        }
    } catch (err) {
        console.warn("Native share failed, using fallback:", err);
    }

    // Direct fallback for Android WebView / Web app share
    const shareText = `${APP_SHARE_TEXT} ${APP_SHARE_URL}`;
    const whatsappUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
    
    try {
        const opened = window.open(whatsappUrl, '_blank');
        if (opened) {
            setInviteFriendsStatus("");
            return;
        }
    } catch (e) {
        console.warn("WhatsApp intent failed:", e);
    }

    const copied = await copyToClipboard(shareText);
    if (copied) {
        showAlert("Invite link copied to clipboard! Share it with your friends to get discounts.");
        setInviteFriendsStatus("Link copied!");
        setTimeout(() => setInviteFriendsStatus(""), 3000);
    } else {
        setInviteFriendsStatus("Could not open share option.");
    }
}
window.LiphtUpShareInvite = inviteFriends;

// ==========================================
// PASSENGER SAFETY: SOS + LIVE TRIP SHARING (Feature 3)
// ==========================================
let tripShareEnabled = false;

function setShareTripButtonState(enabled) {
    tripShareEnabled = enabled;
    const btn = document.getElementById('passenger-share-trip-btn');
    if (!btn) return;
    const label = document.getElementById('passenger-share-trip-label');
    if (label) label.innerText = enabled ? "Sharing On · Tap to Stop" : "Share Trip";
    btn.classList.toggle('gy-btn-outline', !enabled);
    btn.classList.toggle('gy-btn-dark', enabled);
}

function getQuickPosition(timeoutMs = 4000) {
    return getCurrentPosition({ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 })
        .then(position => ({ lat: position.coords.latitude, lng: position.coords.longitude }))
        .catch(() => null);
}

async function sendPassengerSos() {
    if (!currentPassengerRideId) {
        await showAlert("SOS is available once a driver is on the way.");
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
        const response = await fetch(`/api/rides/${encodeURIComponent(currentPassengerRideId)}/sos`, {
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

async function togglePassengerShareTrip() {
    if (!currentPassengerRideId) {
        await showAlert("Trip sharing is available once your ride is active.");
        return;
    }
    const enable = !tripShareEnabled;
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch(`/api/rides/${encodeURIComponent(currentPassengerRideId)}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ enable })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not update trip sharing.");
        setShareTripButtonState(enable);

        if (enable) {
            const trackUrl = `https://liphtup.in/track?ride=${encodeURIComponent(currentPassengerRideId)}`;
            const shareData = {
                title: "Track my LiphtUp trip",
                text: "I'm on a LiphtUp trip — follow my live location here:",
                url: trackUrl
            };

            const result = await share(shareData);
            if (result.ok) return;

            if (result.reason !== 'aborted') {
                const copied = await copyToClipboard(`${shareData.text} ${trackUrl}`);
                await showAlert(copied ? "Tracking link copied. Send it to a trusted contact." : trackUrl);
            }
        } else {
            await showAlert("Live trip sharing turned off.");
        }
    } catch (error) {
        console.error("Trip sharing toggle failed:", error);
        await showAlert(error.message || "Could not update trip sharing.");
    }
}

function generateVerificationPin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function insertPassengerLifecycleCard(element, preferredAnchor = null) {
    const bottomSheetContainer = document.querySelector('#bottom-sheet .container');
    if (!bottomSheetContainer) return false;

    // Home keeps the request button directly inside the container. Services wraps
    // it inside .services-ride-actions, so only insert before direct children.
    const anchor = preferredAnchor && preferredAnchor.parentElement === bottomSheetContainer
        ? preferredAnchor
        : bottomSheetContainer.querySelector(':scope > .services-ride-actions')
            || bottomSheetContainer.querySelector(':scope > #request-ride-btn');

    if (anchor) {
        bottomSheetContainer.insertBefore(element, anchor);
    } else {
        bottomSheetContainer.appendChild(element);
    }

    return true;
}

function renderPassengerVerificationPin(pin) {
    if (!pin) return;

    const bottomSheetContainer = document.querySelector('#bottom-sheet .container');
    if (!bottomSheetContainer) return;

    let pinBox = document.getElementById('passenger-verification-pin-box');
    if (!pinBox) {
        pinBox = document.createElement('div');
        pinBox.id = 'passenger-verification-pin-box';
        pinBox.className = 'bg-warning-subtle border border-warning rounded p-2 mb-3 text-center';
        insertPassengerLifecycleCard(pinBox, document.getElementById('request-ride-btn'));
    }

    pinBox.innerHTML = `
        <div class="small text-secondary fw-semibold">Passenger Verification PIN</div>
        <div class="fs-3 fw-bold text-dark letter-spacing-2">${pin}</div>
        <div class="small text-muted">Share this PIN only with your assigned driver.</div>
    `;
    pinBox.classList.remove('d-none');
}

function hidePassengerVerificationPin() {
    const pinBox = document.getElementById('passenger-verification-pin-box');
    if (pinBox) pinBox.classList.add('d-none');
}

function renderPassengerDriverCard(ride) {
    if (!ride.driver_name && !ride.driver_phone && !ride.vehicle_model && !ride.vehicle_number) return;

    const bottomSheetContainer = document.querySelector('#bottom-sheet .container');
    if (!bottomSheetContainer) return;

    let driverCard = document.getElementById('passenger-driver-card');
    if (!driverCard) {
        driverCard = document.createElement('div');
        driverCard.id = 'passenger-driver-card';
        driverCard.className = 'bg-white border rounded p-3 mb-3 shadow-sm';
        insertPassengerLifecycleCard(driverCard, document.getElementById('passenger-verification-pin-box') || document.getElementById('request-ride-btn'));
    }

    const driverName = ride.driver_name || "Assigned Driver";
    const vehicleModel = ride.vehicle_model || "Vehicle";
    const vehicleNumber = ride.vehicle_number || "Number pending";
    const driverPhone = ride.driver_phone || "";
    const serviceLabel = ride.service_name || (ride.vehicle_type === "auto" ? "Auto" : "Bike / Scooty");

    driverCard.innerHTML = `
        <div class="d-flex justify-content-between align-items-start gap-3">
            <div>
                <div class="fw-bold text-dark">${driverName}</div>
                <div class="small text-muted">${serviceLabel} · ${vehicleModel} · ${vehicleNumber}</div>
                <span class="driver-verified-badge">✓ Verified Driver</span>
            </div>
            ${driverPhone ? `
                <a href="tel:${driverPhone}" class="btn btn-outline-primary btn-sm fw-semibold d-inline-flex align-items-center gap-1">
                    <span class="webicon webicon-call" style="width:14px;height:14px;"></span> Call Driver
                </a>
            ` : ""}
        </div>
    `;
    driverCard.classList.remove('d-none');
}

function hidePassengerDriverCard() {
    const driverCard = document.getElementById('passenger-driver-card');
    if (driverCard) driverCard.classList.add('d-none');
}

// ==========================================
// TRIP-IN-PROGRESS UI (post PIN verification)
// ==========================================
// Once the pickup PIN has been verified (status "started"/"en_route"), the
// normal "choose your ride" booking surface is replaced by a full-height map
// with a collapsible drawer showing the driver, fare, and PIN. See
// css/style.css ".services-page.trip-live" / ".trip-progress-panel".
let tripProgressPanelBound = false;

function bindTripProgressPanel() {
    if (tripProgressPanelBound) return;
    tripProgressPanelBound = true;

    const handle = document.getElementById('trip-progress-handle');
    const panel = document.getElementById('trip-progress-panel');
    if (!handle || !panel) return;

    handle.addEventListener('click', () => {
        panel.dataset.userToggled = 'true';
        const expanded = panel.classList.toggle('is-expanded');
        handle.setAttribute('aria-expanded', String(expanded));
        const subtext = document.getElementById('trip-progress-status-subtext');
        if (subtext) subtext.innerText = expanded ? "Tap to hide details" : "Tap for details";
    });
}

function showTripProgressPanel(ride) {
    const dashboardView = document.getElementById('dashboard-view');
    const panel = document.getElementById('trip-progress-panel');
    if (!dashboardView || !panel) return;

    bindTripProgressPanel();
    dashboardView.classList.add('trip-live');
    panel.classList.remove('d-none');

    // Requirement 5: Passenger ride-details card must be expanded by default for every newly accepted/active ride
    if (!panel.dataset.userToggled) {
        panel.classList.add('is-expanded');
        const handle = document.getElementById('trip-progress-handle');
        if (handle) handle.setAttribute('aria-expanded', 'true');
    }

    const statusText = document.getElementById('trip-progress-status-text');
    const statusSubtext = document.getElementById('trip-progress-status-subtext');

    // Set dynamic status text based on ride status and distance
    let mainStatus = "Trip in progress";
    let subStatus = "Tap for ride details";

    if (ride.status === "accepted") {
        mainStatus = "Driver is on the way";
    } else if (ride.status === "arrived") {
        mainStatus = "Driver has arrived";
        subStatus = "Meet driver at pickup";
    } else if (ride.status === "started" || ride.status === "en_route") {
        mainStatus = "Trip in progress";
    }

    // Calculate and show distance if driver location is available
    if (ride.driverLocation?.lat && ride.driverLocation?.lng) {
        const targetLat = (ride.status === "accepted" || ride.status === "arrived") ? ride.pickup_lat : ride.drop_lat;
        const targetLng = (ride.status === "accepted" || ride.status === "arrived") ? ride.pickup_lng : ride.drop_lng;

        if (targetLat && targetLng) {
            const distKm = calculateDispatchDistanceKm(
                Number(ride.driverLocation.lat),
                Number(ride.driverLocation.lng),
                Number(targetLat),
                Number(targetLng)
            );

            if (ride.status === "accepted") {
                subStatus = `${distKm.toFixed(1)} km away`;
            } else if (ride.status === "started" || ride.status === "en_route") {
                subStatus = `${distKm.toFixed(1)} km to destination`;
                if (distKm < 0.5) mainStatus = "Almost there";
            }
        }
    }

    if (statusText) statusText.innerText = mainStatus;
    if (statusSubtext) {
        statusSubtext.innerText = panel.classList.contains('is-expanded') ? "Tap to hide details" : subStatus;
    }

    const driverName = ride.driver_name || "Assigned Driver";
    const vehicleModel = ride.vehicle_model || "Vehicle";
    const vehicleNumber = ride.vehicle_number || "Number pending";
    const driverPhone = ride.driver_phone || "";
    const vehicleType = ride.vehicle_type || "auto";
    const serviceLabel = ride.service_name || (vehicleType === "auto" ? "Auto" : "Bike / Scooty");
    const driverPhoto = ride.driver_profile_photo || "";

    const driverBox = document.getElementById('trip-progress-driver');
    if (driverBox) {
        // Use a generic SVG placeholder if no photo is available to avoid 404s
        const avatarSrc = driverPhoto || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239CA3AF'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

        driverBox.innerHTML = `
            <div class="driver-avatar-wrap">
                <img src="${avatarSrc}" alt="${driverName}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%239CA3AF%22%3E%3Cpath d=%22M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z%22/%3E%3C/svg%3E'">
                <div class="driver-verified-check">✓</div>
            </div>
            <div class="driver-info-main">
                <span class="verified-badge">✓ Verified Driver</span>
                <strong>${driverName}</strong>
                <div class="driver-vehicle-info">${serviceLabel} · ${vehicleModel} · ${vehicleNumber}</div>
            </div>
            <div class="driver-action-side">
                <img src="assets/vehicle-markers/${vehicleType}-marker.png" class="driver-vehicle-image" alt="${vehicleType}">
                ${driverPhone ? `
                    <a href="tel:${driverPhone}" class="call-driver-btn-compact">
                         <span class="webicon webicon-call" style="width:14px;height:14px;"></span> Call
                    </a>
                ` : ""}
            </div>
        `;
    }

    const pinBox = document.getElementById('trip-progress-pin-box');
    const pinEl = document.getElementById('trip-progress-pin');
    if (pinEl && ride.verification_pin && (ride.status === "accepted" || ride.status === "arrived")) {
        pinEl.innerText = ride.verification_pin;
        pinBox?.classList.remove('d-none');
    } else {
        pinBox?.classList.add('d-none');
    }

    // Populate locations
    const pickupEl = document.getElementById('trip-progress-pickup-name');
    const dropEl = document.getElementById('trip-progress-drop-name');
    if (pickupEl) pickupEl.innerText = ride.pickup_display_address || ride.pickup_name || "Pickup location";
    if (dropEl) dropEl.innerText = ride.drop_display_address || ride.drop_name || "Destination";

    const fareEl = document.getElementById('trip-progress-fare');
    if (fareEl) fareEl.innerText = Number.isFinite(Number(ride.fare)) ? `₹${ride.fare}` : "₹0";
}

function hideTripProgressPanel() {
    const dashboardView = document.getElementById('dashboard-view');
    const panel = document.getElementById('trip-progress-panel');
    dashboardView?.classList.remove('trip-live');
    if (!panel) return;
    delete panel.dataset.userToggled;
    panel.classList.add('d-none');
    panel.classList.remove('is-expanded');
    document.getElementById('trip-progress-handle')?.setAttribute('aria-expanded', 'false');
}

function dispatchPassengerDriverLocation(ride) {
    if (!ride) return;
    const location = ride.driverLocation || (ride.driver_id ? { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) } : null);
    if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) return;

    window.dispatchEvent(new CustomEvent('driver-location-updated', {
        detail: {
            ...location,
            driverLocation: location,
            driver_id: ride.driver_id,
            driverId: ride.driver_id,
            driver_name: ride.driver_name,
            vehicle_type: ride.vehicle_type,
            vehicleType: ride.vehicle_type,
            vehicle_model: ride.vehicle_model,
            vehicleModel: ride.vehicle_model,
            driverHeading: ride.driverHeading ?? location.driverHeading,
            driverSpeed: ride.driverSpeed ?? location.driverSpeed,
            driverAccuracy: ride.driverAccuracy ?? location.driverAccuracy,
            rideStatus: ride.status,
            status: ride.status,
            pickup_lat: ride.pickup_lat,
            pickup_lng: ride.pickup_lng,
            drop_lat: ride.drop_lat,
            drop_lng: ride.drop_lng
        }
    }));
}

function showPassengerCancelButton(rideId) {
    currentPassengerRideId = rideId || currentPassengerRideId;
    const cancelReqBtn = document.getElementById('cancel-ride-request-btn');
    if (cancelReqBtn) cancelReqBtn.classList.remove('d-none');
    document.getElementById('passenger-safety-actions')?.classList.remove('d-none');
}

function hidePassengerCancelButton() {
    currentPassengerRideId = null;
    currentPassengerRideData = null;
    const cancelReqBtn = document.getElementById('cancel-ride-request-btn');
    if (cancelReqBtn) cancelReqBtn.classList.add('d-none');
    document.getElementById('passenger-safety-actions')?.classList.add('d-none');
    setShareTripButtonState(false);
}

function resetPassengerBookingUi(options = {}) {
    const preserveSelections = Boolean(options.preserveSelections);
    clearDispatchExpansionTimer();
    stopSearchStateUi();
    hideNoDriverOptions();
    currentSearchRadiusMeters = DEFAULT_SEARCH_RADIUS_METERS;
    currentPassengerRideId = null;
    currentPassengerRideData = null;
    hidePassengerVerificationPin();
    hidePassengerDriverCard();
    hidePassengerCancelButton();
    hideTripProgressPanel();
    setPassengerDestinationLocked(false);
    setPassengerServiceLocked(false);

    const requestBtn = document.getElementById('request-ride-btn');
    const dropInput = document.getElementById('drop-input');
    const pendingCard = document.getElementById('pending-active-card');
    if (pendingCard) pendingCard.classList.add('d-none');

    if (preserveSelections) {
        // Scenario A: Driver had accepted the ride.
        // Preserve passenger's destination, vehicle selection, and fare quote.
        if (requestBtn) {
            delete requestBtn.dataset.state;
            requestBtn.disabled = false;
            requestBtn.classList.remove('d-none');
            if (window.selectedRideService && window.latestFareQuote?.fare_options?.[window.selectedRideService.id]) {
                const serviceName = window.selectedRideService.shortName || window.selectedRideService.name || "Ride";
                const fare = window.latestFareQuote.fare_options[window.selectedRideService.id];
                requestBtn.innerHTML = `Confirm ${serviceName} · ₹${fare}`;
            } else {
                requestBtn.innerHTML = 'Find Ride';
            }
            requestBtn.className = "gy-btn gy-btn-primary w-100";
        }
    } else {
        // Scenario B: Pending ride request cancelled before acceptance.
        // Completely reset destination, vehicle selection, and search state.
        if (dropInput) dropInput.value = "";
        window.latestFareQuote = null;
        window.selectedRideService = null;
        const fareQuoteBox = document.getElementById('fare-quote-box');
        if (fareQuoteBox) {
            fareQuoteBox.classList.add('d-none');
            fareQuoteBox.classList.remove('d-flex');
        }
        const availWrapper = document.getElementById('availability-card-wrapper');
        if (availWrapper) availWrapper.classList.add('d-none');
        window.dispatchEvent(new CustomEvent('fare-quote-reset'));
        window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));

        if (requestBtn) {
            delete requestBtn.dataset.state;
            requestBtn.disabled = true;
            requestBtn.classList.remove('d-none');
            requestBtn.innerHTML = 'Please enter destination';
            requestBtn.className = "gy-btn gy-btn-primary w-100";
        }
    }
}

function updateAvailabilityIndicator(freeDriversCount = 0) {
    const cardWrapper = document.getElementById('availability-card-wrapper');
    const card = document.getElementById('availability-card');
    const statusName = document.getElementById('availability-status-name');
    const subtext = document.getElementById('availability-subtext');
    const scheduleShortcut = document.getElementById('availability-schedule-shortcut');
    if (!card || !statusName || !subtext) return;

    if (cardWrapper && window.latestFareQuote) {
        cardWrapper.classList.remove('d-none');
    }

    card.classList.remove('is-high', 'is-moderate', 'is-low');

    if (freeDriversCount >= AVAILABILITY_THRESHOLDS.HIGH) {
        card.classList.add('is-high');
        statusName.innerText = "High";
        subtext.innerText = "Plenty of drivers online nearby.";
        scheduleShortcut?.classList.add('d-none');
    } else if (freeDriversCount >= AVAILABILITY_THRESHOLDS.MODERATE) {
        card.classList.add('is-moderate');
        statusName.innerText = "Moderate";
        subtext.innerText = "Drivers are available, may take a few mins.";
        scheduleShortcut?.classList.add('d-none');
    } else {
        card.classList.add('is-low');
        statusName.innerText = "Very Low";
        subtext.innerText = "Fewer drivers online in this area right now.";
        scheduleShortcut?.classList.remove('d-none');
    }
}

window.addEventListener('nearby-drivers-updated', (e) => {
    const detail = e.detail || {};
    const totalFree = (detail.drivers || []).filter((d) => d.driverAvailability === "searching" || !d.driverAvailability).length;
    updateAvailabilityIndicator(totalFree);
});

function startSearchStateUi(customDurationSeconds = SEARCH_WINDOW_SECONDS) {
    const requestBtn = document.getElementById('request-ride-btn');
    const searchCard = document.getElementById('engaging-search-card');
    const noDriverShell = document.getElementById('no-driver-options-shell');
    const pendingCard = document.getElementById('pending-active-card');

    if (requestBtn) requestBtn.classList.add('d-none');
    if (noDriverShell) noDriverShell.classList.add('d-none');
    if (pendingCard) pendingCard.classList.add('d-none');
    if (searchCard) searchCard.classList.remove('d-none');

    searchStartedAt = Date.now();
    if (searchStateInterval) clearInterval(searchStateInterval);

    const dots = document.querySelectorAll('.search-dot');
    const headline = document.getElementById('search-headline');
    const subline = document.getElementById('search-subline');

    searchStateInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - searchStartedAt) / 1000);
        searchDotsCycle = (searchDotsCycle + 1) % (dots.length || 5);

        dots.forEach((dot, idx) => {
            dot.classList.toggle('is-active', idx === searchDotsCycle);
        });

        const msgObj = SEARCH_STATUS_MESSAGES.find((m) => elapsedSec <= m.maxSec) || SEARCH_STATUS_MESSAGES[SEARCH_STATUS_MESSAGES.length - 1];
        if (headline && msgObj) headline.innerText = msgObj.headline;
        if (subline && msgObj) subline.innerText = msgObj.subline;

        if (elapsedSec >= customDurationSeconds) {
            stopSearchStateUi();
            showNoDriverOptions();
        }
    }, 1000);
}

function stopSearchStateUi() {
    if (searchStateInterval) {
        clearInterval(searchStateInterval);
        searchStateInterval = null;
    }
    const searchCard = document.getElementById('engaging-search-card');
    if (searchCard) searchCard.classList.add('d-none');
}

function showNoDriverOptions() {
    stopSearchStateUi();
    const noDriverShell = document.getElementById('no-driver-options-shell');
    const requestBtn = document.getElementById('request-ride-btn');
    const cancelBtn = document.getElementById('cancel-ride-request-btn');

    if (noDriverShell) noDriverShell.classList.remove('d-none');
    if (requestBtn) requestBtn.classList.add('d-none');
    if (cancelBtn) cancelBtn.classList.remove('d-none');

    logClientDemandEvent("search_timeout", {
        searchRadius: currentSearchRadiusMeters,
        rideId: currentPassengerRideId
    });
}

function hideNoDriverOptions() {
    const noDriverShell = document.getElementById('no-driver-options-shell');
    if (noDriverShell) noDriverShell.classList.add('d-none');
}

async function logClientDemandEvent(eventType, metadata = {}) {
    try {
        const idToken = await auth.currentUser?.getIdToken();
        const fareQuote = window.latestFareQuote || {};
        await fetch("/api/rides/log-demand-event", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
            },
            body: JSON.stringify({
                eventType,
                pickupLat: Number(fareQuote.pickup_lat) || null,
                pickupLng: Number(fareQuote.pickup_lng) || null,
                vehicleType: window.selectedRideService?.id || "auto",
                metadata
            })
        });
    } catch (e) {
        console.warn("Client demand event logging skipped:", e);
    }
}

async function handleTryAgainNow() {
    hideNoDriverOptions();
    startSearchStateUi(35);
    if (currentPassengerRideId) {
        try {
            await expandRideDispatch(currentPassengerRideId);
        } catch (e) {
            console.warn("Retry dispatch:", e);
        }
    }
}

function openScheduleModal() {
    const modal = document.getElementById('schedule-ride-modal');
    const timeInput = document.getElementById('schedule-time-input');
    if (modal && timeInput) {
        const defaultTime = new Date(Date.now() + 20 * 60 * 1000);
        const isoLocal = new Date(defaultTime.getTime() - defaultTime.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        timeInput.value = isoLocal;
        timeInput.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        modal.classList.remove('d-none');
    }
}

function closeScheduleModal() {
    const modal = document.getElementById('schedule-ride-modal');
    if (modal) modal.classList.add('d-none');
}

async function confirmScheduleRide() {
    const timeInput = document.getElementById('schedule-time-input');
    if (!timeInput?.value) {
        await showAlert("Please choose a pickup time.");
        return;
    }
    const chosenDate = new Date(timeInput.value);
    if (chosenDate <= new Date()) {
        await showAlert("Please select a time in the future.");
        return;
    }
    closeScheduleModal();
    await submitPendingRideRequest("schedule", chosenDate.toISOString());
}

async function handleNotifyMeWhenAvailable() {
    try {
        const { registerForPush, sendTokenToBackend } = await import('../platform/notifications.js');
        const pushResult = await registerForPush();
        if (pushResult?.ok && pushResult.token) {
            await sendTokenToBackend(pushResult.token);
        }
    } catch (e) {
        console.warn("Push token registration check skipped:", e);
    }

    await submitPendingRideRequest("notify_only");
}

async function handleIncreaseSearchRadius() {
    currentSearchRadiusMeters = EXPANDED_SEARCH_RADIUS_METERS;
    logClientDemandEvent("radius_expanded", { newRadiusMeters: currentSearchRadiusMeters });

    const fareAmount = window.selectedRideService?.fare || 0;
    const modal = document.getElementById('fare-disclosure-modal');
    const amountEl = document.getElementById('fare-disclosure-new-amount');
    if (amountEl) amountEl.innerText = `₹${fareAmount}`;

    if (modal) {
        modal.classList.remove('d-none');
    } else {
        proceedExpandedSearch();
    }
}

function proceedExpandedSearch() {
    const modal = document.getElementById('fare-disclosure-modal');
    if (modal) modal.classList.add('d-none');

    hideNoDriverOptions();
    updateAvailabilityIndicator(2);
    startSearchStateUi(40);
    if (currentPassengerRideId) {
        expandRideDispatch(currentPassengerRideId).catch(() => {});
    }
}

async function submitPendingRideRequest(mode = "notify_only", activatesAt = null) {
    const pickupText = document.getElementById('pickup-input')?.value || "";
    const dropText = document.getElementById('drop-input')?.value || "";
    const fareQuote = window.latestFareQuote || {};
    const requestedVehicleType = window.selectedRideService?.id || "auto";

    if (!pickupText || !dropText) {
        await showAlert("Please specify pickup and destination.");
        return;
    }

    window.LiphtUpLoading?.showPageLoader?.("Saving waiting request...");
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Please log in to continue.");

        const response = await fetch("/api/rides/pending-request", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({
                pickupName: pickupText,
                dropName: dropText,
                pickupLat: Number(fareQuote.pickup_lat) || 0,
                pickupLng: Number(fareQuote.pickup_lng) || 0,
                dropLat: Number(fareQuote.drop_lat) || 0,
                dropLng: Number(fareQuote.drop_lng) || 0,
                vehicleType: requestedVehicleType,
                searchRadius: currentSearchRadiusMeters,
                mode,
                fareEstimate: {
                    fare: window.selectedRideService?.fare || 0,
                    distance_km: fareQuote.distance_km || 0,
                    vehicle_type: requestedVehicleType
                },
                activatesAt,
                dropFullAddress: fareQuote.drop_full_address || ""
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.error || "Could not register pending request.");
        }

        activePendingRequestId = data.requestId;
        hideNoDriverOptions();
        stopSearchStateUi();
        showPendingActiveCard(mode, activatesAt);
        await showAlert(
            mode === "schedule"
                ? "Ride scheduled! We'll auto-search for nearby drivers when your time arrives."
                : "You're in queue! We'll notify you the moment an approved driver becomes free."
        );
    } catch (e) {
        console.error("Pending request error:", e);
        await showAlert(e.message || "Could not save pending request.");
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

function showPendingActiveCard(mode = "notify_only", activatesAt = null) {
    const pendingCard = document.getElementById('pending-active-card');
    const titleEl = document.getElementById('pending-mode-title');
    const descEl = document.getElementById('pending-mode-desc');
    const requestBtn = document.getElementById('request-ride-btn');
    const cancelBtn = document.getElementById('cancel-ride-request-btn');

    if (!pendingCard) return;

    if (requestBtn) requestBtn.classList.add('d-none');
    if (cancelBtn) cancelBtn.classList.remove('d-none');

    if (mode === "schedule" && activatesAt) {
        const timeStr = new Date(activatesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (titleEl) titleEl.innerText = `Scheduled for ${timeStr}`;
        if (descEl) descEl.innerText = "We'll dispatch this request to nearby drivers automatically at your scheduled time.";
    } else {
        if (titleEl) titleEl.innerText = "Waiting for next available driver";
        if (descEl) descEl.innerText = "We are actively monitoring for newly available drivers in your pickup area.";
    }

    pendingCard.classList.remove('d-none');
}

async function cancelPendingRideRequest() {
    if (!activePendingRequestId) return;
    const confirmed = await showConfirm("Cancel your waiting ride request?", { okText: "Yes, cancel", cancelText: "Keep waiting" });
    if (!confirmed) return;

    window.LiphtUpLoading?.showPageLoader?.("Cancelling...");
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");

        await fetch(`/api/rides/pending-request/${encodeURIComponent(activePendingRequestId)}/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({ reason: "cancelled_by_passenger" })
        });

        activePendingRequestId = null;
        activePendingRequestData = null;
        const pendingCard = document.getElementById('pending-active-card');
        if (pendingCard) pendingCard.classList.add('d-none');
        resetPassengerBookingUi();
        await showAlert("Waiting request cancelled.");
    } catch (e) {
        console.error("Cancel pending failed:", e);
        await showAlert(e.message || "Could not cancel request.");
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

function applyServiceBookingDraft() {
    if (!currentUser || currentUser.role !== "passenger") return false;

    const rawDraft = sessionStorage.getItem("liphtup_service_booking_draft");
    if (!rawDraft) return false;

    try {
        const draft = JSON.parse(rawDraft);
        if (!draft?.drop || Date.now() - Number(draft.createdAt || 0) > 10 * 60 * 1000) {
            sessionStorage.removeItem("liphtup_service_booking_draft");
            return false;
        }

        const pickupInput = document.getElementById('pickup-input');
        const dropInput = document.getElementById('drop-input');

        if (pickupInput && draft.pickup && !pickupInput.value) {
            pickupInput.value = draft.pickup;
        }

        if (dropInput) {
            dropInput.value = draft.drop;
            dropInput.dispatchEvent(new Event('input', { bubbles: true }));
            sessionStorage.removeItem("liphtup_service_booking_draft");
            return true;
        }
    } catch (error) {
        console.warn("Could not apply Services booking draft:", error);
        sessionStorage.removeItem("liphtup_service_booking_draft");
    }

    return false;
}

function calculateDispatchDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function isDriverRecentlyConnected(driver) {
    if (driver.desiredAvailability === "offline" || driver.driverAvailability === "offline") return false;
    const lastLocationAt = getTimestampMs(driver.lastLocationAt || driver.lastSeenAt || driver.updatedAt);
    if (!lastLocationAt) return Boolean(driver.isConnected);
    return Date.now() - lastLocationAt <= DRIVER_LOCATION_VISIBLE_MS;
}

function getTimestampMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
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

function driverMatchesRequestedVehicle(driver, requestedVehicleType) {
    if (!requestedVehicleType) return true;
    const driverVehicleType = inferVehicleTypeFromProfile(driver);
    return driverVehicleType === requestedVehicleType;
}

function getVehicleMatchRank(driver, requestedVehicleType) {
    if (!requestedVehicleType) return 0;
    const driverVehicleType = inferVehicleTypeFromProfile(driver);
    if (driverVehicleType === requestedVehicleType) return 0;
    return driverVehicleType ? 2 : 1;
}

async function fetchNearestAvailableDrivers(pickupLat, pickupLng, excludedDriverIds = [], requestedVehicleType = "") {
    if (!Number.isFinite(Number(pickupLat)) || !Number.isFinite(Number(pickupLng))) {
        return [];
    }

    const excludedSet = new Set(excludedDriverIds.filter(Boolean));
    const driversQuery = query(collection(db, "driverMapPresence"), where("driverAvailability", "==", "searching"));
    const driversSnap = await getDocs(driversQuery);

    return driversSnap.docs
        .map((driverDoc) => ({ id: driverDoc.id, ...driverDoc.data() }))
        .filter((driver) => {
            const location = driver.driverLocation || {};
            return driver.verificationStatus === "approved"
                && isDriverRecentlyConnected(driver)
                && driverMatchesRequestedVehicle(driver, requestedVehicleType)
                && !excludedSet.has(driver.uid || driver.id)
                && Number.isFinite(Number(location.lat))
                && Number.isFinite(Number(location.lng));
        })
        .map((driver) => ({
            ...driver,
            vehicleMatchRank: getVehicleMatchRank(driver, requestedVehicleType),
            dispatchDistanceKm: calculateDispatchDistanceKm(
                Number(pickupLat),
                Number(pickupLng),
                Number(driver.driverLocation.lat),
                Number(driver.driverLocation.lng)
            )
        }))
        .sort((a, b) => a.vehicleMatchRank - b.vehicleMatchRank || a.dispatchDistanceKm - b.dispatchDistanceKm);
}

async function buildInitialDispatchState(pickupLat, pickupLng, requestedVehicleType = "") {
    const nearestDrivers = await fetchNearestAvailableDrivers(pickupLat, pickupLng, [], requestedVehicleType);
    const firstBatch = nearestDrivers.slice(0, DISPATCH_BATCH_SIZE);
    const firstBatchIds = firstBatch.map((driver) => driver.uid || driver.id);

    return {
        eligible_driver_ids: firstBatchIds,
        notified_driver_ids: firstBatchIds,
        rejected_driver_ids: [],
        dispatch_batch_size: DISPATCH_BATCH_SIZE,
        dispatch_timeout_ms: DISPATCH_TIMEOUT_MS,
        dispatch_total_candidates: nearestDrivers.length,
        dispatch_round: firstBatchIds.length ? 1 : 0,
        search_status: firstBatchIds.length ? "searching_nearby_drivers" : "no_available_drivers",
        last_dispatch_at: serverTimestamp()
    };
}

async function notifyRideDrivers(rideId, driverIds = []) {
    const uniqueDriverIds = [...new Set(driverIds.filter(Boolean))];
    if (!rideId || !uniqueDriverIds.length) return;
    if (currentPassengerRideId && currentPassengerRideId !== rideId) return;
    if (currentPassengerRideData?.status && currentPassengerRideData.status !== "pending") return;

    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;

        const response = await fetch("/api/notify-ride-request", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({ rideId, driverIds: uniqueDriverIds })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            console.warn("Ride push notification request failed:", data.error || response.status);
        }
    } catch (error) {
        console.warn("Ride push notification request failed:", error);
    }
}

function clearDispatchExpansionTimer() {
    if (activeDispatchExpansionTimer) {
        clearTimeout(activeDispatchExpansionTimer);
        activeDispatchExpansionTimer = null;
    }
    if (activeSearchTimeoutTimer) {
        clearTimeout(activeSearchTimeoutTimer);
        activeSearchTimeoutTimer = null;
    }
}

function getRideSearchStartTime(rideId, ride = {}) {
    const key = `liphtup_ride_search_start_${rideId}`;
    const stored = sessionStorage.getItem(key);
    if (stored) return Number(stored);

    const createdTime = Date.parse(ride.created_at || "") || Date.now();
    sessionStorage.setItem(key, String(createdTime));
    return createdTime;
}

function handleSearchTimeout(rideId) {
    clearDispatchExpansionTimer();
    stopSearchStateUi();
    showNoDriverOptions();
}

function scheduleDispatchExpansion(rideId, ride = {}) {
    if (!currentUser || currentUser.role !== "passenger" || ride.status !== "pending") return;
    if (currentPassengerRideId && currentPassengerRideId !== rideId) return;

    clearDispatchExpansionTimer();

    const startTime = getRideSearchStartTime(rideId, ride);
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_SEARCH_DURATION_MS - elapsed;

    if (remainingMs <= 0 || ride.search_status === "no_more_available_drivers" || ride.search_status === "no_available_drivers" || ride.search_status === "timeout") {
        handleSearchTimeout(rideId);
        return;
    }

    // Schedule overall 100s timeout stop
    activeSearchTimeoutTimer = setTimeout(() => {
        handleSearchTimeout(rideId);
    }, remainingMs);

    // Schedule periodic dispatch expansion (every 15s)
    const nextExpansionInterval = Math.min(ride.dispatch_timeout_ms || 15000, remainingMs);
    activeDispatchExpansionTimer = setTimeout(() => {
        expandRideDispatch(rideId);
    }, nextExpansionInterval);
}

async function expandRideDispatch(rideId) {
    if (!currentUser || currentUser.role !== "passenger") return;
    if (!rideId || (currentPassengerRideId && currentPassengerRideId !== rideId)) {
        clearDispatchExpansionTimer();
        return;
    }
    if (currentPassengerRideData?.status && currentPassengerRideData.status !== "pending") {
        clearDispatchExpansionTimer();
        return;
    }

    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/dispatch`, {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not expand the driver search.");

        if (currentPassengerRideId !== rideId || currentPassengerRideData?.status !== "pending") {
            clearDispatchExpansionTimer();
            return;
        }

        if (data.driverIds?.length) notifyRideDrivers(rideId, data.driverIds).catch(() => {});

        const reqBtn = document.getElementById('request-ride-btn');
        if (reqBtn && currentPassengerRideId === rideId && currentPassengerRideData?.status === "pending") {
            const startTime = getRideSearchStartTime(rideId, currentPassengerRideData || {});
            const elapsed = Date.now() - startTime;
            if (elapsed >= MAX_SEARCH_DURATION_MS || data.searchStatus === "no_more_available_drivers" || data.searchStatus === "no_available_drivers") {
                handleSearchTimeout(rideId);
            } else {
                delete reqBtn.dataset.state;
                reqBtn.disabled = true;
                reqBtn.innerHTML = "Searching nearby drivers...";
                reqBtn.className = "btn btn-warning w-100 fw-bold py-2 text-dark";
                scheduleDispatchExpansion(rideId, currentPassengerRideData || { dispatch_timeout_ms: DISPATCH_TIMEOUT_MS });
            }
        }
        return data;
    } catch (error) {
        console.warn("Ride dispatch expansion skipped or ended:", error.message || error);
    }
}

function resetPassengerRequestButtonForActiveRide(status) {
    const requestBtn = document.getElementById('request-ride-btn');

    const buttonState = {
        pending: {
            text: "Waiting for a driver to accept...",
            className: "btn btn-warning w-100 fw-bold py-2 text-dark"
        },
        accepted: {
            text: "Driver accepted. On the way to pickup.",
            className: "btn btn-success w-100 fw-bold py-2"
        },
        arrived: {
            text: "Driver arrived at pickup.",
            className: "btn btn-info w-100 fw-bold py-2 text-dark"
        },
        started: {
            text: "Trip started. Enjoy your ride.",
            className: "btn btn-primary w-100 fw-bold py-2"
        },
        en_route: {
            text: "🚗 Trip in Progress! Enjoy your ride.",
            className: "btn btn-primary w-100 fw-bold py-2"
        }
    }[status] || {
        text: "Ride in progress...",
        className: "btn btn-secondary w-100 fw-bold py-2"
    };

    requestBtn.innerHTML = buttonState.text;
    requestBtn.className = buttonState.className;
    requestBtn.disabled = true;
}

function getRideHistoryAddress(ride = {}, kind = "pickup") {
    const fallback = kind === "pickup" ? "Pickup not recorded" : "Drop not recorded";
    const candidates = kind === "pickup"
        ? [ride.pickup_display_address, ride.pickup_formatted_address, ride.pickup_landmark, ride.pickup_name]
        : [ride.drop_display_address, ride.drop_formatted_address, ride.drop_full_address, ride.drop_landmark, ride.drop_name];
    return candidates.map(cleanAddressPart).find(Boolean) || fallback;
}

// ==========================================
// 1. ROLE-BASED APPLICATION ROUTER
// ==========================================
window.addEventListener('user-session-ready', (e) => {
    currentUser = e.detail;
    console.log(`Session validated. Routing profile role: ${currentUser.role}`);

    if (window.LiphtUpNative && typeof window.LiphtUpNative.setUserRole === 'function') {
        window.LiphtUpNative.setUserRole(currentUser.role || "");
    }

    const isCurrent = window.isCurrentPage || ((p) => window.location.pathname.includes(p));
    const isDriverPage = isCurrent('driver.html') || isCurrent('driver-service.html');
    const isHistoryPage = isCurrent('history.html');
    const isProfilePage = isCurrent('profile.html');
    const isLoginPage = isCurrent('login.html');

    if (currentUser.role === "driver") {
        if (!isDriverPage && !isHistoryPage && !isProfilePage && !isLoginPage) {
            window.location.replace("/driver.html");
        }
        return;
    }

    if (isDriverPage) {
        window.location.replace("/index.html");
        return;
    }

    // User is a passenger; map initializations happen through map.js automatically
    console.log("Passenger architecture mapped via map.js pipeline context.");
    if (!hasPassengerLifecycleSurface()) {
        return;
    }

    restorePassengerActiveRide().then((restoredActiveRide) => {
        if (restoredActiveRide) return;
        window.addEventListener('map-engine-ready', applyServiceBookingDraft, { once: true });
        setTimeout(applyServiceBookingDraft, 1200);
    });
});

async function restorePassengerActiveRide() {
    if (!currentUser || currentUser.role !== "passenger") return;

    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("passenger_id", "==", currentUser.uid),
            where("status", "in", ACTIVE_RIDE_STATUSES)
        );

        const activeRideSnap = await getDocs(activeRideQuery);
        if (activeRideSnap.empty) return false;

        const activeRideDoc = activeRideSnap.docs[0];
        const activeRide = activeRideDoc.data();

        console.log(`Restoring passenger active ride: ${activeRideDoc.id}`);
        showPassengerCancelButton(activeRideDoc.id);
        setPassengerDestinationLocked(true, activeRide.drop_name || "", activeRide.pickup_name || "");
        setPassengerServiceLocked(true, activeRide);

        if (["accepted", "arrived", "started", "en_route"].includes(activeRide.status)) {
            showTripProgressPanel(activeRide);
        }

        if (activeRide.fare) {
            document.getElementById('fare-amount').innerText = `₹${activeRide.fare}`;
            document.getElementById('fare-quote-box').classList.remove('d-none');
            document.getElementById('fare-quote-box').classList.add('d-flex');
        }

        resetPassengerRequestButtonForActiveRide(activeRide.status);
        listenToRideStatusUpdates(activeRideDoc.id);

        dispatchPassengerDriverLocation(activeRide);

        return true;
    } catch (error) {
        console.error("Passenger active ride restore failed:", error);
        return false;
    }
}

// ==========================================
// 2. PASSENGER ENGINE: SUBMIT REQUESTS
// ==========================================
async function createRideThroughBackend(payload) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Authentication is required.");

    const response = await fetch("/api/rides", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        const error = new Error(data.error || "Could not create this ride request.");
        error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
        throw error;
    }
    return data;
}

const requestRideButton = document.getElementById('request-ride-btn');
if (requestRideButton) {
requestRideButton.addEventListener('click', async () => {
    if (!currentUser) return;

    const requestBtn = document.getElementById('request-ride-btn');
    if (requestBtn && (requestBtn.dataset.state === "no_drivers" || requestBtn.dataset.state === "retry_search")) {
        const rideId = currentPassengerRideId;
        if (!rideId) {
            resetPassengerBookingUi();
            return;
        }
        passengerSearchStartTimes[rideId] = Date.now();
        delete requestBtn.dataset.state;
        requestBtn.disabled = true;
        requestBtn.innerHTML = "Searching nearby drivers...";
        requestBtn.className = "btn btn-warning w-100 fw-bold py-2 text-dark";
        showPassengerCancelButton(rideId);

        try {
            await expandRideDispatch(rideId);
            scheduleDispatchExpansion(rideId, currentPassengerRideData || {});
        } catch (e) {
            console.error("Retry dispatch error:", e);
            handleSearchTimeout(rideId);
        }
        return;
    }

    const pickupText = document.getElementById('pickup-input').value;
    const dropText = document.getElementById('drop-input').value;
    const fareQuote = window.latestFareQuote || {};
    const requestedVehicleType = window.selectedRideService?.id || "";
    const rideRequestedAt = new Date();
    const service = getServiceFarePolicy(requestedVehicleType, rideRequestedAt);
    const fareAmount = calculateServiceFare(requestedVehicleType, fareQuote.distance_km, rideRequestedAt);

    const hasValidRoute = Number.isFinite(Number(fareQuote.pickup_lat))
        && Number.isFinite(Number(fareQuote.pickup_lng))
        && Number.isFinite(Number(fareQuote.drop_lat))
        && Number.isFinite(Number(fareQuote.drop_lng));

    if (!dropText || !service || !hasValidRoute || !Number.isFinite(fareAmount) || fareAmount <= 0) {
        await showAlert("Please select a destination and choose Bike or Auto before confirming your ride.");
        return;
    }

    // Double-Booking Protection Check
    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("passenger_id", "==", currentUser.uid),
            where("status", "in", ACTIVE_RIDE_STATUSES)
        );

        const activeRideSnap = await getDocs(activeRideQuery); 
        if (!activeRideSnap.empty) {
            await showAlert("You already have an active ride request or an ongoing trip!");
            return; 
        }
    } catch (queryError) {
        console.error("Active ride validation failed:", queryError);
        await showAlert("Network synchronization error. Please try again.");
        return;
    }

    // UI updates only happen if the user has no active bookings
    setPassengerDestinationLocked(true, dropText, pickupText);
    setPassengerServiceLocked(true, {
        ...service,
        vehicle_type: requestedVehicleType,
        fare: fareAmount,
        distance_km: fareQuote.distance_km
    });
    startSearchStateUi(35);

    try {
        const backendRide = await createRideThroughBackend({
            pickupName: pickupText,
            dropName: dropText,
            pickupLat: Number(fareQuote.pickup_lat),
            pickupLng: Number(fareQuote.pickup_lng),
            dropLat: Number(fareQuote.drop_lat),
            dropLng: Number(fareQuote.drop_lng),
            vehicleType: requestedVehicleType,
            dropFullAddress: fareQuote.drop_full_address || "",
            dropSource: fareQuote.drop_source || "",
            dropProvider: fareQuote.drop_provider || fareQuote.drop_source || "",
            dropPlaceId: fareQuote.drop_place_id || "",
            dropEloc: fareQuote.drop_eloc || "",
            dropTypeHint: fareQuote.drop_type_hint || ""
        });
        currentPassengerRideId = backendRide.rideId;
        notifyRideDrivers(backendRide.rideId, backendRide.notifiedDriverIds || []).catch(() => {});
        showPassengerCancelButton(backendRide.rideId);
        listenToRideStatusUpdates(backendRide.rideId);

    } catch (error) {
        console.error("Database Write Failure:", error);
        stopSearchStateUi();
        setPassengerDestinationLocked(false);
        setPassengerServiceLocked(false);
        requestBtn.innerHTML = 'Find Ride';
        requestBtn.className = "gy-btn gy-btn-primary w-100";
        requestBtn.disabled = false;
        requestBtn.classList.remove('d-none');
        await showAlert(error.message || "Could not create this ride request. Please try again.");
    }
});
}

function listenToRideStatusUpdates(rideId) {
    const requestBtn = document.getElementById('request-ride-btn');
    showPassengerCancelButton(rideId);

    activeRideListener = onSnapshot(doc(db, "rides", rideId), (docSnap) => {
        if (!docSnap.exists()) return;
        const ride = docSnap.data();
        currentPassengerRideData = ride;

        if (ACTIVE_RIDE_STATUSES.includes(ride.status)) {
            setPassengerDestinationLocked(true, ride.drop_name || "", ride.pickup_name || "");
            setPassengerServiceLocked(true, ride);
        }

        if (["cancelled", "cancelled_by_passenger", "cancelled_by_driver"].includes(ride.status)) {
            clearDispatchExpansionTimer();
            stopSearchStateUi();
            hideNoDriverOptions();
            const driverHadAccepted = Boolean(ride.driver_id) || ["accepted", "arrived", "started", "en_route", "cancelled_by_driver"].includes(ride.status);
            if (ride.status === "cancelled_by_driver") {
                const message = fareAdjustmentMessage(ride, "Please request a new ride.");
                showAlert(`Your driver cancelled the trip. ${message}`);
            }
            resetPassengerBookingUi({ preserveSelections: driverHadAccepted });
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            if (activeRideListener) {
                activeRideListener();
                activeRideListener = null;
            }
            return;
        }

        if (ride.status === "pending") {
            showPassengerCancelButton(rideId);
            const startTime = getRideSearchStartTime(rideId, ride);
            const elapsed = Date.now() - startTime;

            if (elapsed >= MAX_SEARCH_DURATION_MS || ride.search_status === "no_available_drivers" || ride.search_status === "no_more_available_drivers" || ride.search_status === "timeout") {
                handleSearchTimeout(rideId);
            } else {
                scheduleDispatchExpansion(rideId, ride);
            }
        } else if (ride.status === "accepted") {
            clearDispatchExpansionTimer();
            stopSearchStateUi();
            hideNoDriverOptions();
            showTripProgressPanel(ride);
            requestBtn.innerHTML = `Driver accepted. On the way to pickup.`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            if (typeof window.clearRouteAndDestination === 'function') {
                window.clearRouteAndDestination();
            }
            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "arrived") {
            stopSearchStateUi();
            hideNoDriverOptions();
            showTripProgressPanel(ride);
            requestBtn.innerHTML = 'Driver arrived at pickup.';
            requestBtn.className = "btn btn-info w-100 fw-bold py-2 text-dark";

            if (typeof window.clearRouteAndDestination === 'function') {
                window.clearRouteAndDestination();
            }
            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "started") {
            showTripProgressPanel(ride);
            requestBtn.innerHTML = 'Trip started. Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "en_route") {
            showTripProgressPanel(ride);
            requestBtn.innerHTML = '🚗 Trip in Progress! Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "completed") {
            clearDispatchExpansionTimer();
            setPassengerDestinationLocked(false);
            setPassengerServiceLocked(false);
            requestBtn.innerHTML = '🎉 Trip Completed! Safe travels.';
            requestBtn.className = "btn btn-dark w-100 fw-bold py-2";
            hidePassengerVerificationPin();
            hidePassengerDriverCard();
            hidePassengerCancelButton();
            hideTripProgressPanel();
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            
            const finalFare = ride.fare || "0.00";
            document.getElementById('passenger-payment-view').classList.remove('d-none');
            document.getElementById('passenger-final-fare').innerText = formatFareAmount(finalFare);
            renderFareAdjustmentNote('passenger-fare-note', ride);
            
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
        }
    });
}

async function cancelRideByPassenger(rideId) {
    rideId = rideId || currentPassengerRideId;
    if (!rideId) {
        await showAlert("No active ride found to cancel.");
        return;
    }

    const status = currentPassengerRideData?.status || "";
    const driverHadAccepted = Boolean(currentPassengerRideData?.driver_id) || ["accepted", "arrived", "started", "en_route"].includes(status);
    const cancelMessage = ["started", "en_route"].includes(status)
        ? "Please talk to the driver if you want to cancel. If you cancel by yourself, you may still be charged fully."
        : ["accepted", "arrived"].includes(status)
            ? "Cancel this ride? Your driver will be notified immediately."
            : "Cancel this ride request?";

    if (!(await showConfirm(cancelMessage, { okText: "Cancel ride", cancelText: "Keep ride" }))) return;

    window.LiphtUpLoading?.showPageLoader?.("Cancelling ride request...");
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");

        const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/cancel`, {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.error || "Could not cancel this ride.");
        }

        resetPassengerBookingUi({ preserveSelections: driverHadAccepted });

        if (activeRideListener) {
            activeRideListener();
            activeRideListener = null;
        }
        await showAlert("Your ride has been cancelled.");
    } catch (error) {
        console.error("Failed to cancel ride:", error);
        await showAlert(error.message || "Could not cancel this ride. Please try again.");
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}


// ==========================================
// 4. GLOBAL UI EVENT LISTENERS
// ==========================================

addOptionalClickListener('passenger-payment-close-btn', () => {
    document.getElementById('passenger-payment-view').classList.add('d-none');
});

addOptionalClickListener('close-passenger-payment-btn', () => {
    document.getElementById('passenger-payment-view').classList.add('d-none');
    window.location.reload(); 
});

addOptionalClickListener('passenger-history-btn', () => {
    window.location.href = '/history.html';
});

function bindShareListeners() {
    addOptionalClickListener('invite-friends-card', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        setInviteFriendsStatus("");
        inviteFriends();
    });

    addOptionalClickListener('invite-friends-btn', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        setInviteFriendsStatus("");
        inviteFriends();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindShareListeners);
} else {
    bindShareListeners();
}

addOptionalClickListener('passenger-sos-btn', () => sendPassengerSos());
addOptionalClickListener('passenger-share-trip-btn', () => togglePassengerShareTrip());
addOptionalClickListener('cancel-ride-request-btn', async () => {
    if (activePendingRequestId) {
        await cancelPendingRideRequest();
    } else if (currentPassengerRideId) {
        await cancelRideByPassenger(currentPassengerRideId);
    } else {
        resetPassengerBookingUi();
        await showAlert("Ride request cancelled.");
    }
});

// Availability Card Info & Popover
addOptionalClickListener('availability-info-btn', () => {
    const popover = document.getElementById('estimated-price-popover');
    if (popover) popover.classList.toggle('d-none');
});

addOptionalClickListener('close-popover-btn', () => {
    const popover = document.getElementById('estimated-price-popover');
    if (popover) popover.classList.add('d-none');
});

addOptionalClickListener('availability-schedule-shortcut', () => {
    openScheduleModal();
});

// Engaging Search State Early Tap-Out
addOptionalClickListener('search-tapout-btn', () => {
    showNoDriverOptions();
});

// No-Driver Options Sheet Handlers
addOptionalClickListener('opt-try-again-btn', () => {
    handleTryAgainNow();
});

addOptionalClickListener('opt-schedule-btn', () => {
    openScheduleModal();
});

addOptionalClickListener('opt-notify-btn', () => {
    handleNotifyMeWhenAvailable();
});

addOptionalClickListener('opt-widen-radius-btn', () => {
    handleIncreaseSearchRadius();
});

// Schedule Ride Modal Handlers
addOptionalClickListener('schedule-modal-close-btn', () => closeScheduleModal());
addOptionalClickListener('schedule-modal-cancel-btn', () => closeScheduleModal());
addOptionalClickListener('schedule-modal-confirm-btn', () => confirmScheduleRide());

// Fare Disclosure Modal Handlers
addOptionalClickListener('fare-disclosure-close-btn', () => {
    document.getElementById('fare-disclosure-modal')?.classList.add('d-none');
});
addOptionalClickListener('fare-disclosure-cancel-btn', () => {
    document.getElementById('fare-disclosure-modal')?.classList.add('d-none');
});
addOptionalClickListener('fare-disclosure-confirm-btn', () => {
    proceedExpandedSearch();
});

// Pending Request Cancel Button
addOptionalClickListener('pending-cancel-btn', () => {
    cancelPendingRideRequest();
});

// Check and restore active pending requests on session load
async function checkActivePendingRequestOnLoad() {
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;

        const response = await fetch("/api/rides/pending-request/active", {
            headers: { Authorization: `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (data.ok && data.hasActivePending && data.pendingRequest) {
            activePendingRequestId = data.pendingRequest.requestId;
            activePendingRequestData = data.pendingRequest;
            showPendingActiveCard(data.pendingRequest.mode, data.pendingRequest.activatesAt);
        }
    } catch (e) {
        console.warn("Active pending check skipped:", e);
    }
}

window.addEventListener('user-session-ready', () => {
    setTimeout(checkActivePendingRequestOnLoad, 1000);
});
