import { auth, db } from './firebase-init.js';
import { 
    collection, 
    addDoc, 
    doc, 
    updateDoc, 
    getDoc,
    getDocs,
    query, 
    where,
    onSnapshot,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { calculateServiceFare, getRideService } from './fare-policy.js';

const ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"];
const DISPATCH_BATCH_SIZE = 10;
const DISPATCH_TIMEOUT_MS = 45000;
const DRIVER_LOCATION_VISIBLE_MS = 15 * 60 * 1000;
const DRIVER_NOTIFICATION_ELIGIBLE_MS = 30 * 60 * 1000;
const APP_SHARE_URL = "https://liphtup.in/";
const APP_SHARE_TITLE = "LiphtUp";
const APP_SHARE_TEXT = "Ride Together, Save Together. Invite friends and unlock exciting LiphtUp discounts.";
const UNCLEAR_LOCATION_LABELS = new Set(["current location", "current", "my location", "pinned pickup", "pinned destination"]);

// Global variables
let currentUser = null;
let activeRideListener = null;          // For Passenger monitoring
let activeDispatchExpansionTimer = null;

let currentPassengerRideId = null;

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

async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const temporaryInput = document.createElement('textarea');
        temporaryInput.value = text;
        temporaryInput.setAttribute('readonly', '');
        temporaryInput.style.position = 'fixed';
        temporaryInput.style.opacity = '0';
        document.body.appendChild(temporaryInput);
        temporaryInput.select();
        const copied = document.execCommand('copy');
        temporaryInput.remove();
        return copied;
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
    const shareMessage = `${APP_SHARE_TEXT} ${APP_SHARE_URL}`;

    if (typeof navigator.share === 'function') {
        try {
            await navigator.share(shareData);
            setInviteFriendsStatus("Invite shared successfully.");
            return;
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.warn("Native share failed; falling back to copy:", error);
        }
    }

    const copied = await copyTextToClipboard(shareMessage);
    setInviteFriendsStatus(copied ? "Invite link copied. Share it with friends." : "Unable to share right now. Please try again.");
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
            </div>
            ${driverPhone ? `
                <a href="tel:${driverPhone}" class="btn btn-outline-primary btn-sm fw-semibold">
                    Call Driver
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

function dispatchPassengerDriverLocation(ride) {
    if (!ride?.driverLocation) return;

    window.dispatchEvent(new CustomEvent('driver-location-updated', {
        detail: {
            ...ride.driverLocation,
            driver_id: ride.driver_id,
            driverId: ride.driver_id,
            driver_name: ride.driver_name,
            vehicle_type: ride.vehicle_type,
            vehicleType: ride.vehicle_type,
            vehicle_model: ride.vehicle_model,
            vehicleModel: ride.vehicle_model,
            driverHeading: ride.driverHeading,
            driverSpeed: ride.driverSpeed,
            driverAccuracy: ride.driverAccuracy,
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
    currentPassengerRideId = rideId;
    const cancelBtn = document.getElementById('passenger-cancel-ride-btn');
    if (cancelBtn) cancelBtn.classList.remove('d-none');
}

function hidePassengerCancelButton() {
    currentPassengerRideId = null;
    const cancelBtn = document.getElementById('passenger-cancel-ride-btn');
    if (cancelBtn) cancelBtn.classList.add('d-none');
}

function resetPassengerBookingUi() {
    clearDispatchExpansionTimer();
    hidePassengerVerificationPin();
    hidePassengerDriverCard();
    hidePassengerCancelButton();
    setPassengerDestinationLocked(false);
    setPassengerServiceLocked(false);
    window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));

    const requestBtn = document.getElementById('request-ride-btn');
    requestBtn.innerHTML = 'Find Ride';
    requestBtn.disabled = false;
    requestBtn.className = "gy-btn gy-btn-primary w-100";
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

function isDriverNotificationEligible(driver) {
    if (driver.desiredAvailability === "offline" || driver.driverAvailability === "offline") return false;
    const eligibleUntil = getTimestampMs(driver.notificationEligibleUntil);
    if (eligibleUntil) return eligibleUntil >= Date.now();

    const lastSeenAt = getTimestampMs(driver.lastAppSeenAt || driver.lastSeenAt || driver.updatedAt);
    return Boolean(lastSeenAt) && Date.now() - lastSeenAt <= DRIVER_NOTIFICATION_ELIGIBLE_MS;
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
    const driversQuery = query(collection(db, "driverPresence"), where("driverAvailability", "==", "searching"));
    const driversSnap = await getDocs(driversQuery);

    return driversSnap.docs
        .map((driverDoc) => ({ id: driverDoc.id, ...driverDoc.data() }))
        .filter((driver) => {
            const location = driver.driverLocation || {};
            return driver.verificationStatus === "approved"
                && isDriverRecentlyConnected(driver)
                && isDriverNotificationEligible(driver)
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
}

function scheduleDispatchExpansion(rideId, ride) {
    if (!currentUser || currentUser.role !== "passenger" || ride.status !== "pending") return;
    clearDispatchExpansionTimer();

    activeDispatchExpansionTimer = setTimeout(() => expandRideDispatch(rideId), ride.dispatch_timeout_ms || DISPATCH_TIMEOUT_MS);
}

async function expandRideDispatch(rideId) {
    if (!currentUser || currentUser.role !== "passenger") return;

    try {
        const rideRef = doc(db, "rides", rideId);
        const rideSnap = await getDoc(rideRef);
        if (!rideSnap.exists()) return;

        const ride = rideSnap.data();
        if (ride.status !== "pending" || ride.passenger_id !== currentUser.uid) return;

        const alreadyNotified = ride.notified_driver_ids || [];
        const rejectedDrivers = ride.rejected_driver_ids || [];
        const excludedIds = [...alreadyNotified, ...rejectedDrivers];
        const nearestDrivers = await fetchNearestAvailableDrivers(ride.pickup_lat, ride.pickup_lng, excludedIds, ride.vehicle_type || "");
        const nextBatch = nearestDrivers.slice(0, ride.dispatch_batch_size || DISPATCH_BATCH_SIZE);
        const nextBatchIds = nextBatch.map((driver) => driver.uid || driver.id);

        if (!nextBatchIds.length) {
            await updateDoc(rideRef, {
                search_status: "no_more_available_drivers",
                updatedAt: serverTimestamp()
            });
            document.getElementById('request-ride-btn').innerHTML = "No nearby drivers online. You can cancel and rebook.";
            document.getElementById('request-ride-btn').className = "btn btn-secondary w-100 fw-bold py-2";
            return;
        }

        const updatedEligibleIds = [...new Set([...(ride.eligible_driver_ids || []), ...nextBatchIds])];
        const updatedNotifiedIds = [...new Set([...alreadyNotified, ...nextBatchIds])];

        await updateDoc(rideRef, {
            eligible_driver_ids: updatedEligibleIds,
            notified_driver_ids: updatedNotifiedIds,
            dispatch_round: (ride.dispatch_round || 0) + 1,
            search_status: "expanded_driver_search",
            last_dispatch_at: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        notifyRideDrivers(rideId, nextBatchIds).catch(() => {});
    } catch (error) {
        console.error("Ride dispatch expansion failed:", error);
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

function buildPassengerHistoryUpdate(rideId, rideData, status) {
    const isCancelled = status === "cancelled_by_passenger" || status === "cancelled_by_driver";
    const cancelledBy = status === "cancelled_by_passenger" ? "passenger" : status === "cancelled_by_driver" ? "driver" : "";

    return {
        ride_id: rideId,
        passenger_id: rideData.passenger_id || null,
        driver_id: rideData.driver_id || null,
        pickup_location: getRideHistoryAddress(rideData, "pickup"),
        pickup_display_address: rideData.pickup_display_address || "",
        pickup_formatted_address: rideData.pickup_formatted_address || "",
        pickup_landmark: rideData.pickup_landmark || "",
        drop_location: getRideHistoryAddress(rideData, "drop"),
        drop_display_address: rideData.drop_display_address || "",
        drop_formatted_address: rideData.drop_formatted_address || rideData.drop_full_address || "",
        drop_full_address: rideData.drop_full_address || "",
        drop_landmark: rideData.drop_landmark || "",
        verifiedAt: rideData.pinVerifiedAt || rideData.verifiedAt || serverTimestamp(),
        completedAt: status === "completed" ? rideData.completedAt || serverTimestamp() : null,
        cancelledAt: isCancelled ? rideData.cancelledAt || serverTimestamp() : null,
        finalStatusAt: status === "completed"
            ? rideData.completedAt || serverTimestamp()
            : isCancelled
                ? rideData.cancelledAt || serverTimestamp()
                : null,
        distance_km: Number(rideData.distance_km || 0),
        duration_minutes: Number(rideData.duration_minutes || 0),
        fare_amount: Number(rideData.fare || 0),
        trip_status: status || "verified",
        final_status: status === "completed" ? "completed" : isCancelled ? "cancelled" : "verified",
        cancelled_by: cancelledBy,
        payment_status: rideData.payment_status || "pending",
        driver_name: rideData.driver_name || "Driver",
        passenger_name: rideData.passenger_name || "Passenger",
        vehicle_model: rideData.vehicle_model || "Vehicle",
        vehicle_number: rideData.vehicle_number || "Number not recorded",
        vehicle_details: `${rideData.vehicle_model || "Vehicle"} - ${rideData.vehicle_number || "Number not recorded"}`,
        vehicle_type: rideData.vehicle_type || "",
        service_name: rideData.service_name || getRideService(rideData.vehicle_type)?.name || "",
        passenger_capacity: Number(rideData.passenger_capacity || (rideData.vehicle_type === "auto" ? 4 : 1)),
        source: "client_passenger_status_sync",
        updatedAt: serverTimestamp()
    };
}

async function savePassengerVerifiedHistoryStatus(rideId, status) {
    const rideRef = doc(db, "rides", rideId);
    const historyRef = doc(db, "tripHistory", rideId);

    await runTransaction(db, async (transaction) => {
        const rideSnap = await transaction.get(rideRef);
        if (!rideSnap.exists()) {
            throw new Error("Ride document no longer exists.");
        }

        const rideData = rideSnap.data();
        if (rideData.passenger_id !== currentUser?.uid) {
            throw new Error("Only the passenger can cancel this ride.");
        }

        const update = {
            status,
            cancelledAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        transaction.update(rideRef, update);

        if (rideData.pinVerifiedAt) {
            transaction.set(historyRef, buildPassengerHistoryUpdate(rideId, {
                ...rideData,
                status
            }, status), { merge: true });
        }
    });
}


// ==========================================
// 1. ROLE-BASED APPLICATION ROUTER
// ==========================================
window.addEventListener('user-session-ready', (e) => {
    currentUser = e.detail;
    console.log(`Session validated. Routing profile role: ${currentUser.role}`);

    if (currentUser.role === "driver") {
        window.location.replace("driver.html");
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
        renderPassengerDriverCard(activeRide);
        renderPassengerVerificationPin(activeRide.verification_pin);
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
const requestRideButton = document.getElementById('request-ride-btn');
if (requestRideButton) {
requestRideButton.addEventListener('click', async () => {
    if (!currentUser) return;

    const pickupText = document.getElementById('pickup-input').value;
    const dropText = document.getElementById('drop-input').value;
    const requestBtn = document.getElementById('request-ride-btn');
    const fareQuote = window.latestFareQuote || {};
    const requestedVehicleType = window.selectedRideService?.id || "";
    const service = getRideService(requestedVehicleType);
    const fareAmount = calculateServiceFare(requestedVehicleType, fareQuote.distance_km);

    const hasValidRoute = Number.isFinite(Number(fareQuote.pickup_lat))
        && Number.isFinite(Number(fareQuote.pickup_lng))
        && Number.isFinite(Number(fareQuote.drop_lat))
        && Number.isFinite(Number(fareQuote.drop_lng));

    if (!dropText || !service || !hasValidRoute || !Number.isFinite(fareAmount) || fareAmount <= 0) {
        alert("Please select a destination and choose Bike or Auto before confirming your ride.");
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
            alert("You already have an active ride request or an ongoing trip!");
            return; 
        }
    } catch (queryError) {
        console.error("Active ride validation failed:", queryError);
        alert("Network synchronization error. Please try again.");
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
    requestBtn.innerHTML = '⏳ Waiting for a driver to accept...';
    requestBtn.className = "btn btn-warning w-100 fw-bold py-2 text-dark";
    requestBtn.disabled = true;

    try {
        const verificationPin = generateVerificationPin();
        const [dispatchState, pickupGeocode, dropGeocode] = await Promise.all([
            buildInitialDispatchState(fareQuote.pickup_lat, fareQuote.pickup_lng, requestedVehicleType),
            reverseGeocodeRidePoint(fareQuote.pickup_lat, fareQuote.pickup_lng),
            reverseGeocodeRidePoint(fareQuote.drop_lat, fareQuote.drop_lng)
        ]);
        const rideData = {
            passenger_id: currentUser.uid,
            passenger_name: currentUser.name,
            passenger_phone: currentUser.phone,
            pickup_name: pickupText,
            drop_name: dropText,
            drop_full_address: fareQuote.drop_full_address || "",
            ...buildRideAddressFields("pickup", pickupGeocode, pickupText),
            ...buildRideAddressFields("drop", dropGeocode || {
                fullAddress: fareQuote.drop_full_address || "",
                displayAddress: fareQuote.drop_full_address || "",
                name: dropText
            }, dropText),
            drop_source: fareQuote.drop_source || "",
            drop_provider: fareQuote.drop_provider || fareQuote.drop_source || "",
            drop_place_id: fareQuote.drop_place_id || "",
            drop_eloc: fareQuote.drop_eloc || "",
            drop_type_hint: fareQuote.drop_type_hint || "",
            pickup_lat: fareQuote.pickup_lat || null,
            pickup_lng: fareQuote.pickup_lng || null,
            drop_lat: fareQuote.drop_lat || null,
            drop_lng: fareQuote.drop_lng || null,
            distance_km: fareQuote.distance_km || null,
            duration_minutes: fareQuote.duration_minutes || null,
            fare: fareAmount,
            fare_base: service.baseFare,
            fare_per_km: service.perKmRate,
            fare_currency: "INR",
            vehicle_type: requestedVehicleType,
            service_name: service.name,
            passenger_capacity: service.capacity,
            status: "pending",
            driver_id: null,
            driver_name: null,
            driver_phone: null,
            vehicle_model: null,
            vehicle_number: null,
            driverAvailabilitySnapshot: null,
            payment_methods: ["cash", "upi"],
            payment_status: "pending",
            verification_pin: verificationPin,
            ...dispatchState,
            createdAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(db, "rides"), rideData);
        notifyRideDrivers(docRef.id, dispatchState.notified_driver_ids).catch(() => {});
        showPassengerCancelButton(docRef.id);
        renderPassengerVerificationPin(verificationPin);
        listenToRideStatusUpdates(docRef.id);

    } catch (error) {
        console.error("Database Write Failure:", error);
        setPassengerDestinationLocked(false);
        setPassengerServiceLocked(false);
        requestBtn.innerHTML = 'Find Ride';
        requestBtn.className = "gy-btn gy-btn-primary w-100";
        requestBtn.disabled = false;
        alert(error.message || "Could not create this ride request. Please try again.");
    }
});
}

function listenToRideStatusUpdates(rideId) {
    const requestBtn = document.getElementById('request-ride-btn');
    showPassengerCancelButton(rideId);

    activeRideListener = onSnapshot(doc(db, "rides", rideId), (docSnap) => {
        if (!docSnap.exists()) return;
        const ride = docSnap.data();

        if (ACTIVE_RIDE_STATUSES.includes(ride.status)) {
            setPassengerDestinationLocked(true, ride.drop_name || "", ride.pickup_name || "");
            setPassengerServiceLocked(true, ride);
        }

        // FIXED: Added handling for when a driver cancels mid-trip
        if (ride.status === "cancelled_by_driver") {
            alert("Your driver had to cancel the trip due to an unexpected issue. Please request a new ride.");
            resetPassengerBookingUi();
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
            return;
        }

        if (ride.status === "cancelled_by_passenger") {
            resetPassengerBookingUi();
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            if (activeRideListener) activeRideListener();
            return;
        }

        if (ride.status === "pending") {
            if (ride.search_status === "no_available_drivers" || ride.search_status === "no_more_available_drivers") {
                requestBtn.innerHTML = "No nearby drivers online. You can cancel and rebook.";
                requestBtn.className = "btn btn-secondary w-100 fw-bold py-2";
                if (ride.search_status === "no_available_drivers") {
                    scheduleDispatchExpansion(rideId, ride);
                } else {
                    clearDispatchExpansionTimer();
                }
            } else {
                scheduleDispatchExpansion(rideId, ride);
                requestBtn.innerHTML = "Searching nearby drivers...";
                requestBtn.className = "btn btn-warning w-100 fw-bold py-2 text-dark";
            }
        } else if (ride.status === "accepted") {
            clearDispatchExpansionTimer();
            renderPassengerDriverCard(ride);
            renderPassengerVerificationPin(ride.verification_pin);
            requestBtn.innerHTML = `Driver accepted. On the way to pickup.`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "arrived") {
            renderPassengerDriverCard(ride);
            requestBtn.innerHTML = 'Driver arrived at pickup.';
            requestBtn.className = "btn btn-info w-100 fw-bold py-2 text-dark";

            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "started") {
            renderPassengerDriverCard(ride);
            requestBtn.innerHTML = 'Trip started. Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

            dispatchPassengerDriverLocation(ride);
        } else if (ride.status === "en_route") {
            renderPassengerDriverCard(ride);
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
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            
            const finalFare = ride.fare || "0.00";
            document.getElementById('passenger-final-fare').innerText = `₹${finalFare}`;
            document.getElementById('passenger-payment-view').classList.remove('d-none');
            
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
        }
    });
}

async function cancelRideByPassenger(rideId) {
    rideId = rideId || currentPassengerRideId;
    if (!rideId) {
        alert("No active ride found to cancel.");
        return;
    }

    if (!confirm("Are you sure you want to cancel your ride request?")) return;

    try {
        await savePassengerVerifiedHistoryStatus(rideId, "cancelled_by_passenger");

        alert("Your ride request has been cancelled.");
        resetPassengerBookingUi();

        if (activeRideListener) {
            activeRideListener();
            activeRideListener = null;
        }
    } catch (error) {
        console.error("Failed to cancel ride:", error);
        alert(error.message || "Could not cancel this ride. Please try again.");
    }
}


// ==========================================
// 4. GLOBAL UI EVENT LISTENERS
// ==========================================
addOptionalClickListener('passenger-cancel-ride-btn', () => cancelRideByPassenger());

addOptionalClickListener('close-passenger-payment-btn', () => {
    document.getElementById('passenger-payment-view').classList.add('d-none');
    window.location.reload(); 
});

addOptionalClickListener('passenger-history-btn', () => {
    window.location.href = 'history.html';
});

addOptionalClickListener('invite-friends-btn', () => {
    setInviteFriendsStatus("");
    inviteFriends();
});

