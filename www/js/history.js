import { auth, db } from './firebase-init.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const FILTER_LABELS = {
    day: "today",
    week: "this week",
    month: "this month",
    all: "all time"
};
const UNCLEAR_LOCATION_LABELS = new Set(["current location", "current", "my location", "pinned pickup", "pinned destination"]);

const historyState = {
    user: null,
    profile: null,
    trips: [],
    activeFilter: "all",
    unsubscribe: null,
    streamToken: 0
};

const historyList = document.getElementById('history-list');
const userContext = document.getElementById('history-user-context');
const totalTripsEl = document.getElementById('history-total-trips');
const totalFareEl = document.getElementById('history-total-fare');
const totalDistanceEl = document.getElementById('history-total-distance');
const moneyLabelEl = document.getElementById('history-money-label');
const summaryGrid = document.getElementById('history-summary-grid');
const detailModal = document.getElementById('history-detail-modal');
const detailContent = document.getElementById('history-detail-content');

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isDriverAccount() {
    return historyState.profile?.role === "driver";
}

function getCachedProfile() {
    try {
        const cached = JSON.parse(sessionStorage.getItem("liphtup_user_profile") || "null");
        if (cached?.uid && Date.now() - Number(cached.cachedAt || 0) <= 6 * 60 * 60 * 1000) {
            return cached;
        }
    } catch {
        // Continue with the Firestore profile.
    }
    return null;
}

function formatMoney(value) {
    const amount = Number(value || 0);
    return `₹${Math.round(amount)}`;
}

function formatDistance(value) {
    const distance = Number(value || 0);
    return distance > 0 ? `${distance.toFixed(1)} km` : "Not recorded";
}

function formatDuration(value) {
    const duration = Number(value || 0);
    return duration > 0 ? `${Math.round(duration)} mins` : "Not recorded";
}

function cleanLocationText(value) {
    return String(value || "").trim();
}

function isUnclearLocationText(value) {
    const text = cleanLocationText(value).toLowerCase();
    return !text || UNCLEAR_LOCATION_LABELS.has(text);
}

function getHistoryLocation(trip = {}, kind = "pickup") {
    const fallback = kind === "pickup" ? "Pickup not recorded" : "Drop not recorded";
    const candidates = kind === "pickup"
        ? [trip.pickup_display_address, trip.pickup_formatted_address, trip.pickup_location]
        : [trip.drop_display_address, trip.drop_formatted_address, trip.drop_full_address, trip.drop_location];
    const selected = candidates.map(cleanLocationText).find(Boolean);
    return selected && !isUnclearLocationText(selected) ? selected : fallback;
}

function formatDate(timestamp) {
    if (!timestamp?.toDate) return "Date not recorded";
    return timestamp.toDate().toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "medium"
    });
}

function getTripTime(trip) {
    const timestamp = trip.finalStatusAt || trip.completedAt || trip.cancelledAt || trip.verifiedAt;
    return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function getTripRole() {
    return isDriverAccount() ? "driver" : "passenger";
}

function getParticipantName(trip) {
    return isDriverAccount()
        ? trip.passenger_name || "Passenger"
        : trip.driver_name || "Driver";
}

function getTripStatusLabel(trip = {}) {
    const finalStatus = String(trip.final_status || "").toLowerCase();
    const tripStatus = String(trip.trip_status || "").toLowerCase();

    if (finalStatus === "completed" || tripStatus === "completed") return "Completed";
    if (finalStatus === "cancelled" || tripStatus.startsWith("cancelled")) {
        const actor = trip.cancelled_by || (tripStatus === "cancelled_by_passenger" ? "passenger" : tripStatus === "cancelled_by_driver" ? "driver" : "");
        return actor ? `Cancelled by ${actor}` : "Cancelled";
    }

    return "Verified";
}

function getTripDisplayTimestamp(trip = {}) {
    if (trip.final_status === "completed" || trip.trip_status === "completed") return trip.completedAt || trip.finalStatusAt;
    if (trip.final_status === "cancelled" || String(trip.trip_status || "").startsWith("cancelled")) return trip.cancelledAt || trip.finalStatusAt;
    return trip.verifiedAt || trip.finalStatusAt || trip.completedAt;
}

function getFilterLabel(filterName = historyState.activeFilter) {
    return FILTER_LABELS[filterName] || FILTER_LABELS.all;
}

function getDayStart(now) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getWeekStart(now) {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff).getTime();
}

function isTripInActiveFilter(trip) {
    if (historyState.activeFilter === "all") return true;

    const tripTime = getTripTime(trip);
    if (!tripTime) return false;

    const tripDate = new Date(tripTime);
    const now = new Date();

    if (historyState.activeFilter === "day") {
        return tripTime >= getDayStart(now);
    }

    if (historyState.activeFilter === "week") {
        const weekStart = getWeekStart(now);
        return tripTime >= weekStart;
    }

    if (historyState.activeFilter === "month") {
        return tripDate.getFullYear() === now.getFullYear()
            && tripDate.getMonth() === now.getMonth();
    }

    return true;
}

async function loadUserProfile(user) {
    const snap = await getDoc(doc(db, "users", user.uid));
    return snap.exists() ? snap.data() : {};
}

async function getTripsByField(fieldName, uid) {
    const q = query(
        collection(db, "tripHistory"),
        where(fieldName, "==", uid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data()
    }));
}

async function enrichTripHistoryAddress(trip) {
    if (trip.pickup_display_address && trip.drop_display_address) return trip;

    const rideId = trip.ride_id || trip.id;
    if (!rideId) return trip;

    try {
        const rideSnap = await getDoc(doc(db, "rides", rideId));
        if (!rideSnap.exists()) return trip;

        const ride = rideSnap.data();
        return {
            ...trip,
            pickup_display_address: trip.pickup_display_address || ride.pickup_display_address || "",
            pickup_formatted_address: trip.pickup_formatted_address || ride.pickup_formatted_address || "",
            pickup_landmark: trip.pickup_landmark || ride.pickup_landmark || "",
            drop_display_address: trip.drop_display_address || ride.drop_display_address || "",
            drop_formatted_address: trip.drop_formatted_address || ride.drop_formatted_address || ride.drop_full_address || "",
            drop_full_address: trip.drop_full_address || ride.drop_full_address || "",
            drop_landmark: trip.drop_landmark || ride.drop_landmark || "",
            pickup_location: isUnclearLocationText(trip.pickup_location)
                ? ride.pickup_display_address || ride.pickup_formatted_address || trip.pickup_location
                : trip.pickup_location,
            drop_location: isUnclearLocationText(trip.drop_location)
                ? ride.drop_display_address || ride.drop_formatted_address || ride.drop_full_address || trip.drop_location
                : trip.drop_location
        };
    } catch (error) {
        console.warn("Could not enrich trip history address:", error);
        return trip;
    }
}

async function loadTripHistory() {
    if (!historyState.user) return [];

    const fieldName = isDriverAccount() ? "driver_id" : "passenger_id";
    const trips = await getTripsByField(fieldName, historyState.user.uid);
    const enrichedTrips = await Promise.all(trips.map(enrichTripHistoryAddress));
    return enrichedTrips.sort((a, b) => getTripTime(b) - getTripTime(a));
}

function stopHistoryRealtime() {
    if (historyState.unsubscribe) {
        historyState.unsubscribe();
        historyState.unsubscribe = null;
    }
}

function startHistoryRealtime() {
    if (!historyState.user) return;
    stopHistoryRealtime();
    if (!historyState.trips.length) setLoadingState();

    const fieldName = isDriverAccount() ? "driver_id" : "passenger_id";
    const q = query(
        collection(db, "tripHistory"),
        where(fieldName, "==", historyState.user.uid)
    );
    const token = historyState.streamToken + 1;
    historyState.streamToken = token;

    historyState.unsubscribe = onSnapshot(q, async (snap) => {
        try {
            const trips = snap.docs.map((docSnap) => ({
                id: docSnap.id,
                ...docSnap.data()
            }));
            if (historyState.streamToken !== token) return;
            historyState.trips = trips.sort((a, b) => getTripTime(b) - getTripTime(a));
            renderTrips();

            const enrichedTrips = await Promise.all(trips.map(enrichTripHistoryAddress));
            if (historyState.streamToken !== token) return;
            historyState.trips = enrichedTrips.sort((a, b) => getTripTime(b) - getTripTime(a));
            renderTrips();
        } catch (error) {
            setErrorState(error);
        }
    }, setErrorState);
}

function getVisibleTrips() {
    return historyState.trips.filter(isTripInActiveFilter);
}

function renderSummary(trips) {
    summaryGrid.classList.toggle('d-none', !isDriverAccount());
    if (!isDriverAccount()) return;

    const totalFare = trips
        .filter((trip) => trip.final_status === "completed" || trip.trip_status === "completed")
        .reduce((sum, trip) => sum + Number(trip.fare_amount || 0), 0);
    const totalDistance = trips.reduce((sum, trip) => sum + Number(trip.distance_km || 0), 0);

    totalTripsEl.innerText = String(trips.length);
    totalFareEl.innerText = formatMoney(totalFare);
    totalDistanceEl.innerText = totalDistance > 0 ? `${totalDistance.toFixed(1)} km` : "0 km";
    moneyLabelEl.innerText = "Total Fare";
}

function renderEmptyState() {
    const roleText = isDriverAccount() ? "driven" : "booked";
    const filterText = getFilterLabel();
    const actionLabel = isDriverAccount() ? "Go Home" : "Book a Ride";
    const actionLink = isDriverAccount() ? "/driver" : "/index";

    historyList.innerHTML = `
        <div class="history-empty-card">
            <div class="history-empty-icon">◷</div>
            <h3>No ride history for ${escapeHtml(filterText)}</h3>
            <p>Your verified, completed, and cancelled ${escapeHtml(roleText)} trips for ${escapeHtml(filterText)} will appear here.</p>
            <button class="gy-btn gy-btn-primary" type="button" onclick="window.location.href='${actionLink}'">${actionLabel}</button>
        </div>
    `;
}

function renderTripCard(trip) {
    const role = getTripRole();
    const participantLabel = role === "driver" ? "Passenger" : "Driver";
    const moneyLabel = role === "driver" ? "Earnings" : "Fare";
    const statusLabel = getTripStatusLabel(trip);
    const vehicleDetails = trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || "Number not recorded"}`;

    return `
        <article class="history-trip-card">
            <div class="history-trip-top">
                <div>
                    <span class="history-role-pill ${role}">${role === "driver" ? "Driven" : "Ridden"}</span>
                    <h3>${escapeHtml(getParticipantName(trip))}</h3>
                    <p>${escapeHtml(statusLabel)} • ${escapeHtml(participantLabel)} • ${escapeHtml(formatDate(getTripDisplayTimestamp(trip)))}</p>
                </div>
                <div class="history-trip-fare">
                    <strong>${formatMoney(trip.fare_amount)}</strong>
                    <span>${moneyLabel}</span>
                </div>
            </div>

            <div class="history-route">
                <div><span class="pickup-dot">●</span><p>${escapeHtml(getHistoryLocation(trip, "pickup"))}</p></div>
                <div><span class="drop-pin">📍</span><p>${escapeHtml(getHistoryLocation(trip, "drop"))}</p></div>
            </div>

            <div class="history-trip-meta">
                <span>${formatDistance(trip.distance_km)}</span>
                <span>${formatDuration(trip.duration_minutes)}</span>
                <span>${escapeHtml(trip.service_name || (trip.vehicle_type === "auto" ? "Auto" : "Bike / Scooty"))}</span>
            </div>

            <div class="history-trip-footer">
                <small>${escapeHtml(vehicleDetails)}</small>
                <button class="history-detail-btn" type="button" data-trip-id="${escapeHtml(trip.id)}">Details</button>
            </div>
        </article>
    `;
}

function renderTrips() {
    const visibleTrips = getVisibleTrips();
    renderSummary(visibleTrips);

    if (!visibleTrips.length) {
        renderEmptyState();
        return;
    }

    historyList.innerHTML = visibleTrips.map(renderTripCard).join("");
    document.querySelectorAll('.history-detail-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const trip = historyState.trips.find((item) => item.id === button.dataset.tripId);
            if (trip) openTripDetail(trip);
        });
    });
}

function openTripDetail(trip) {
    const role = getTripRole();
    const statusLabel = getTripStatusLabel(trip);
    const vehicleDetails = trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || "Number not recorded"}`;

    detailContent.innerHTML = `
        <div class="history-detail-row"><span>Ride ID</span><strong>${escapeHtml(trip.ride_id || trip.id)}</strong></div>
        <div class="history-detail-row"><span>Final Status</span><strong>${escapeHtml(statusLabel)}</strong></div>
        <div class="history-detail-row"><span>Verification Date & Time</span><strong>${escapeHtml(formatDate(trip.verifiedAt))}</strong></div>
        <div class="history-detail-row"><span>Completion Date & Time</span><strong>${escapeHtml(formatDate(trip.completedAt))}</strong></div>
        <div class="history-detail-row"><span>Cancellation Date & Time</span><strong>${escapeHtml(formatDate(trip.cancelledAt))}</strong></div>
        <div class="history-detail-row"><span>Payment</span><strong>${escapeHtml(trip.payment_status || "pending")}</strong></div>
        <div class="history-detail-row"><span>Your Role</span><strong>${role === "driver" ? "Driver" : "Passenger"}</strong></div>
        <div class="history-detail-row"><span>Passenger</span><strong>${escapeHtml(trip.passenger_name || "Passenger")}</strong></div>
        <div class="history-detail-row"><span>Driver</span><strong>${escapeHtml(trip.driver_name || "Driver")}</strong></div>
        <div class="history-detail-row"><span>Vehicle</span><strong>${escapeHtml(vehicleDetails)}</strong></div>
        <div class="history-detail-row"><span>Service</span><strong>${escapeHtml(trip.service_name || (trip.vehicle_type === "auto" ? "Auto" : "Bike / Scooty"))}</strong></div>
        <div class="history-detail-row"><span>Pickup</span><strong>${escapeHtml(getHistoryLocation(trip, "pickup"))}</strong></div>
        <div class="history-detail-row"><span>Drop</span><strong>${escapeHtml(getHistoryLocation(trip, "drop"))}</strong></div>
        <div class="history-detail-row"><span>Distance</span><strong>${formatDistance(trip.distance_km)}</strong></div>
        <div class="history-detail-row"><span>Duration</span><strong>${formatDuration(trip.duration_minutes)}</strong></div>
        <div class="history-detail-row total"><span>Fare</span><strong>${formatMoney(trip.fare_amount)}</strong></div>
    `;
    detailModal.classList.remove('d-none');
}

function setLoadingState() {
    historyList.innerHTML = `<div class="history-loading-card">Loading ride history...</div>`;
}

function setErrorState(error) {
    console.error("History load failed:", error);
    historyList.innerHTML = `
        <div class="history-empty-card">
            <div class="history-empty-icon">!</div>
            <h3>Could not load history</h3>
            <p>Please check your internet connection and Firestore rules, then try again.</p>
            <button id="history-retry-btn" class="gy-btn gy-btn-primary" type="button">Try Again</button>
        </div>
    `;
    document.getElementById('history-retry-btn').addEventListener('click', refreshHistory);
}

async function refreshHistory() {
    if (!historyState.user) return;
    startHistoryRealtime();
}

function bindFilters() {
    document.querySelectorAll('.history-filter').forEach((button) => {
        button.addEventListener('click', () => {
            historyState.activeFilter = button.dataset.filter;
            document.querySelectorAll('.history-filter').forEach((item) => item.classList.remove('active'));
            button.classList.add('active');
            renderTrips();
        });
    });
}

bindFilters();
document.getElementById('history-refresh-btn').addEventListener('click', refreshHistory);
document.getElementById('history-detail-close-btn').addEventListener('click', () => {
    detailModal.classList.add('d-none');
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        stopHistoryRealtime();
        historyState.user = null;
        historyState.profile = null;
        historyState.trips = [];
        document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.remove('d-none'));
        userContext.innerText = "Login to view your ride history";
        historyList.innerHTML = `
            <div class="history-empty-card">
                <div class="history-empty-icon">○</div>
                <h3>You are not logged in</h3>
                <p>Please login to view your ride history.</p>
                <button class="gy-btn gy-btn-primary" type="button" onclick="window.location.href='/login'">Go to Login</button>
            </div>
        `;
        renderSummary([]);
        return;
    }

    document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.add('d-none'));

    historyState.user = user;
    const cachedProfile = getCachedProfile();

    if (cachedProfile?.uid === user.uid) {
        historyState.profile = cachedProfile;
        userContext.innerText = `${cachedProfile.name || "LiphtUp user"} • ${isDriverAccount() ? "driver" : "passenger"}`;
        startHistoryRealtime();

        loadUserProfile(user).then((profile) => {
            const roleChanged = profile.role !== historyState.profile?.role;
            historyState.profile = profile;
            userContext.innerText = `${profile.name || "LiphtUp user"} • ${isDriverAccount() ? "driver" : "passenger"}`;
            if (roleChanged) startHistoryRealtime();
        }).catch((error) => console.warn("Could not refresh history profile:", error));
        return;
    }

    setLoadingState();

    try {
        historyState.profile = await loadUserProfile(user);
        const name = historyState.profile.name || "LiphtUp user";
        const role = isDriverAccount() ? "driver" : "passenger";
        userContext.innerText = `${name} • ${role}`;
        startHistoryRealtime();
    } catch (error) {
        setErrorState(error);
    }
});
