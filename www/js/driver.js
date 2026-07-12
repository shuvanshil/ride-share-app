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

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const DRIVER_ACTIVE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;

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

async function setDriverAvailability(status) {
    if (!currentUser || currentUser.role !== "driver") return;
    currentUser.driverAvailability = status;

    try {
        if (status === "offline" && driverPresenceWatchId !== null) {
            navigator.geolocation.clearWatch(driverPresenceWatchId);
            driverPresenceWatchId = null;
        }

        await updateDoc(doc(db, "users", currentUser.uid), {
            driverAvailability: status,
            isConnected: status !== "offline",
            driverAvailabilityUpdatedAt: serverTimestamp()
        });
        await setDoc(doc(db, "driverPresence", currentUser.uid), {
            uid: currentUser.uid,
            name: currentUser.name || "Driver",
            phone: currentUser.phone || "",
            driverAvailability: status,
            verificationStatus: currentUser.verificationStatus || "pending_review",
            vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || "",
            vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || "",
            vehicle_type: inferVehicleTypeFromProfile(currentUser),
            isConnected: status !== "offline",
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.warn("Driver availability update failed:", error);
    }
}

async function updateDriverPresenceLocation(lat, lng, fallbackAvailability = "searching", telemetry = {}) {
    if (!currentUser || currentUser.role !== "driver") return;

    await setDoc(doc(db, "driverPresence", currentUser.uid), {
        uid: currentUser.uid,
        name: currentUser.name || "Driver",
        phone: currentUser.phone || "",
        driverLocation: { lat, lng },
        driverAvailability: currentUser.driverAvailability || fallbackAvailability,
        ...telemetry,
        verificationStatus: currentUser.verificationStatus || "pending_review",
        vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || "",
        vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || "",
        vehicle_type: inferVehicleTypeFromProfile(currentUser),
        isConnected: true,
        lastSeenAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    }, { merge: true });
}

function startDriverPresenceTracking() {
    if (!currentUser || currentUser.role !== "driver" || currentUser.verificationStatus !== "approved") return;
    if (!navigator.geolocation) {
        console.warn("Driver presence tracking needs browser location access.");
        return;
    }

    if (driverPresenceWatchId !== null) {
        navigator.geolocation.clearWatch(driverPresenceWatchId);
        driverPresenceWatchId = null;
    }

    driverPresenceWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            try {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const coords = { lat, lng };
                const telemetryResult = buildDriverTelemetry(
                    coords,
                    position.coords,
                    lastPresenceHeadingPosition,
                    lastPresenceHeading
                );
                lastPresenceHeadingPosition = coords;
                lastPresenceHeading = telemetryResult.heading;
                await updateDoc(doc(db, "users", currentUser.uid), {
                    driverLocation: { lat, lng },
                    ...telemetryResult.telemetry,
                    isConnected: true,
                    lastSeenAt: serverTimestamp()
                });
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

        if (querySnapshot.empty) {
            noRidesMsg.classList.remove('d-none');
            return;
        }

        noRidesMsg.classList.add('d-none');
        let renderedRideCount = 0;

        querySnapshot.forEach((docSnapshot) => {
            const rideId = docSnapshot.id;
            const ride = docSnapshot.data();

            if (ride.status !== "pending" || ride.driver_id) return;
            if (ride.vehicle_type && ride.vehicle_type !== inferVehicleTypeFromProfile(currentUser)) return;
            renderedRideCount += 1;

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
            noRidesMsg.classList.remove('d-none');
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
        let acceptedRideData = null;
        const rideRef = doc(db, "rides", rideId);
        const driverActiveRideQuery = query(
            collection(db, "rides"),
            where("driver_id", "==", currentUser.uid),
            where("status", "in", DRIVER_ACTIVE_STATUSES)
        );
        const activeRideSnap = await getDocs(driverActiveRideQuery);

        if (!activeRideSnap.empty) {
            throw new Error("You already have an active ride.");
        }

        await runTransaction(db, async (transaction) => {
            const rideSnap = await transaction.get(rideRef);

            if (!rideSnap.exists()) {
                throw new Error("Ride request no longer exists.");
            }

            const rideData = rideSnap.data();
            acceptedRideData = rideData;

            if (rideData.status !== "pending" || rideData.driver_id) {
                throw new Error("This ride was already accepted by another driver.");
            }

            const driverVehicleType = inferVehicleTypeFromProfile(currentUser);
            if (!driverVehicleType || rideData.vehicle_type !== driverVehicleType) {
                throw new Error(`This ${getServiceLabel(rideData.vehicle_type)} request requires a matching registered vehicle.`);
            }

            if (!Array.isArray(rideData.eligible_driver_ids) || !rideData.eligible_driver_ids.includes(currentUser.uid)) {
                throw new Error("This ride request is no longer available for you.");
            }

            transaction.update(rideRef, {
                status: "accepted",
                driver_id: currentUser.uid,
                driver_name: currentUser.name,
                driver_phone: currentUser.phone,
                vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || currentUser.vehicleName || "Registered Vehicle",
                vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || currentUser.vehicleNo || "Vehicle number pending",
                vehicle_type: driverVehicleType,
                acceptedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        await setDriverAvailability("busy");
        currentlyAssignedRideId = rideId;
        activeDriverRideData = { ...acceptedRideData, status: "accepted" };
        document.getElementById('active-trip-container').classList.remove('d-none');
        renderActiveTripStatus("accepted", activeDriverRideData);
        attachDriverTripListener(rideRef);
        startDriverGpsBroadcast(rideRef);
    } catch (error) {
        console.error("Failed to commit transactional state adjustment:", error);
        alert(error.message || "Could not accept this ride.");
    }
}

async function updateActiveRideStatus(nextStatus) {
    if (!currentlyAssignedRideId) {
        console.error("Cannot update trip status: active ride tracker lost.");
        return;
    }

    try {
        const rideRef = doc(db, "rides", currentlyAssignedRideId);
        const rideSnap = await getDoc(rideRef);

        if (!rideSnap.exists()) {
            alert("This ride no longer exists.");
            return;
        }

        const rideData = rideSnap.data();
        const allowedTransitions = {
            accepted: ["arrived"],
            arrived: ["started"],
            started: ["completed"]
        };

        if (rideData.driver_id !== currentUser.uid) {
            alert("Only the assigned driver can update this trip.");
            return;
        }

        if (!allowedTransitions[rideData.status]?.includes(nextStatus)) {
            alert(`Cannot move ride from ${rideData.status} to ${nextStatus}.`);
            return;
        }

        const timestampField = {
            arrived: "arrivedAt",
            started: "startedAt"
        }[nextStatus];

        await updateDoc(rideRef, {
            status: nextStatus,
            [timestampField]: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        renderActiveTripStatus(nextStatus);
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
        const rideRef = doc(db, "rides", rideId);
        const rideSnap = await getDoc(rideRef);

        if (!rideSnap.exists()) {
            alert("This ride no longer exists.");
            return;
        }

        const rideData = rideSnap.data();

        if (rideData.driver_id !== currentUser.uid) {
            alert("Only the assigned driver can verify this ride.");
            return;
        }

        if (String(rideData.verification_pin || "") !== typedPin) {
            alert("Incorrect verification PIN. Please verify with the passenger.");
            return;
        }

        let verifiedRideData = null;
        await runTransaction(db, async (transaction) => {
            const freshRideSnap = await transaction.get(rideRef);
            if (!freshRideSnap.exists()) {
                throw new Error("This ride no longer exists.");
            }

            const freshRideData = freshRideSnap.data();
            if (freshRideData.driver_id !== currentUser.uid) {
                throw new Error("Only the assigned driver can verify this ride.");
            }

            if (String(freshRideData.verification_pin || "") !== typedPin) {
                throw new Error("Incorrect verification PIN. Please verify with the passenger.");
            }

            verifiedRideData = freshRideData;
            transaction.update(rideRef, {
                status: "en_route",
                pinVerifiedAt: serverTimestamp(),
                startedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        if (verifiedRideData) {
            setDoc(doc(db, "tripHistory", rideId), buildTripHistoryRecord(rideId, {
                ...verifiedRideData,
                status: "verified",
                payment_status: verifiedRideData.payment_status || "pending"
            }), { merge: true }).catch((historyError) => {
                console.warn("Trip history save after PIN verification failed:", historyError);
            });
        }

        const verificationPanel = document.getElementById('verification-pin-panel');
        if (verificationPanel) verificationPanel.classList.add('d-none');

        renderActiveTripStatus("en_route");
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

    try {
        const rideRef = doc(db, "rides", currentlyAssignedRideId);
        const rideSnap = await getDoc(rideRef);
        if (!rideSnap.exists()) return;

        const rideData = rideSnap.data();
        if (rideData.status !== "en_route") {
            alert("Verify the passenger PIN before completing this trip.");
            return;
        }

        const finalFare = parseFloat(rideData.fare || 0);

        await runTransaction(db, async (transaction) => {
            const freshRideSnap = await transaction.get(rideRef);
            if (!freshRideSnap.exists()) return;
            const freshRideData = freshRideSnap.data();

            transaction.update(rideRef, {
                status: "completed",
                completedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            transaction.set(doc(db, "tripHistory", currentlyAssignedRideId), buildTripHistoryFinalUpdate({
                ...freshRideData,
                ride_id: currentlyAssignedRideId,
                status: "completed"
            }, "completed"), { merge: true });
        });

        if (activeDriverTripListener) activeDriverTripListener();

        await updateDoc(doc(db, "users", currentUser.uid), {
            lifetime_earnings: increment(finalFare),
            total_completed_trips: increment(1)
        });

        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        await setDriverAvailability("searching");

        document.getElementById('active-trip-container').classList.add('d-none');
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
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
        pendingDriverPaymentRideId = currentlyAssignedRideId;
        currentlyAssignedRideId = null;
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
        const rideRef = doc(db, "rides", rideId);

        if (activeDriverTripListener) activeDriverTripListener();

        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        await runTransaction(db, async (transaction) => {
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

        document.getElementById('active-trip-container').classList.add('d-none');
        activeDriverRideData = null;
        activeDriverRenderedStatus = null;
        alert("Trip aborted successfully. Status set to online.");

        currentlyAssignedRideId = null;
        await setDriverAvailability("searching");
    } catch (error) {
        console.error("Driver cancel execution failure:", error);
    }
}

function startDriverConsole(profile) {
    if (activeConsoleUid === profile.uid) {
        currentUser = { ...currentUser, ...profile };
        showDriverHome(currentUser);
        return;
    }

    activeConsoleUid = profile.uid;
    currentUser = profile;
    showDriverHome(profile);
    setDriverAvailability("searching");
    startDriverPresenceTracking();
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
            driverAvailability: "offline",
            driverAvailabilityUpdatedAt: serverTimestamp()
        }).catch(() => {});
        setDoc(doc(db, "driverPresence", currentUser.uid), {
            isConnected: false,
            driverAvailability: "offline",
            updatedAt: serverTimestamp()
        }, { merge: true }).catch(() => {});
    }
});
