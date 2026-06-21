import { auth, db } from './firebase-init.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const historyState = {
    user: null,
    profile: null,
    trips: [],
    activeFilter: "all"
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

function formatDate(timestamp) {
    if (!timestamp?.toDate) return "Date not recorded";
    return timestamp.toDate().toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function getTripTime(trip) {
    return trip.completedAt?.toMillis ? trip.completedAt.toMillis() : 0;
}

function getTripRole(trip) {
    if (!historyState.user) return "passenger";
    return trip.driver_id === historyState.user.uid ? "driver" : "passenger";
}

function getParticipantName(trip) {
    return getTripRole(trip) === "driver"
        ? trip.passenger_name || "Passenger"
        : trip.driver_name || "Driver";
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

async function loadTripHistory() {
    if (!historyState.user) return [];

    const [passengerTrips, driverTrips] = await Promise.all([
        getTripsByField("passenger_id", historyState.user.uid),
        getTripsByField("driver_id", historyState.user.uid)
    ]);

    const tripMap = new Map();
    [...passengerTrips, ...driverTrips].forEach((trip) => {
        tripMap.set(trip.id, trip);
    });

    return [...tripMap.values()].sort((a, b) => getTripTime(b) - getTripTime(a));
}

function getVisibleTrips() {
    if (historyState.activeFilter === "all") return historyState.trips;
    return historyState.trips.filter((trip) => getTripRole(trip) === historyState.activeFilter);
}

function renderSummary(trips) {
    const isDriverAccount = historyState.profile?.role === "driver";
    summaryGrid.classList.toggle('d-none', !isDriverAccount);
    if (!isDriverAccount) return;

    const totalFare = trips.reduce((sum, trip) => sum + Number(trip.fare_amount || 0), 0);
    const totalDistance = trips.reduce((sum, trip) => sum + Number(trip.distance_km || 0), 0);
    const driverTripCount = trips.filter((trip) => getTripRole(trip) === "driver").length;
    const passengerTripCount = trips.length - driverTripCount;

    totalTripsEl.innerText = String(trips.length);
    totalFareEl.innerText = formatMoney(totalFare);
    totalDistanceEl.innerText = totalDistance > 0 ? `${totalDistance.toFixed(1)} km` : "0 km";

    if (historyState.activeFilter === "driver") {
        moneyLabelEl.innerText = "Earnings";
    } else if (historyState.activeFilter === "passenger") {
        moneyLabelEl.innerText = "Spent";
    } else {
        moneyLabelEl.innerText = driverTripCount > passengerTripCount ? "Net Fare" : "Total Fare";
    }
}

function renderEmptyState() {
    historyList.innerHTML = `
        <div class="history-empty-card">
            <div class="history-empty-icon">◷</div>
            <h3>No completed rides yet</h3>
            <p>Your paid completed trips will appear here after the driver confirms payment.</p>
            <button class="gy-btn gy-btn-primary" type="button" onclick="window.location.href='index.html'">Book a Ride</button>
        </div>
    `;
}

function renderTripCard(trip) {
    const role = getTripRole(trip);
    const participantLabel = role === "driver" ? "Passenger" : "Driver";
    const moneyLabel = role === "driver" ? "Earnings" : "Fare";
    const vehicleDetails = trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || "Number not recorded"}`;

    return `
        <article class="history-trip-card">
            <div class="history-trip-top">
                <div>
                    <span class="history-role-pill ${role}">${role === "driver" ? "Driven" : "Ridden"}</span>
                    <h3>${escapeHtml(getParticipantName(trip))}</h3>
                    <p>${escapeHtml(participantLabel)} • ${escapeHtml(formatDate(trip.completedAt))}</p>
                </div>
                <div class="history-trip-fare">
                    <strong>${formatMoney(trip.fare_amount)}</strong>
                    <span>${moneyLabel}</span>
                </div>
            </div>

            <div class="history-route">
                <div><span class="pickup-dot">●</span><p>${escapeHtml(trip.pickup_location || "Pickup not recorded")}</p></div>
                <div><span class="drop-pin">📍</span><p>${escapeHtml(trip.drop_location || "Drop not recorded")}</p></div>
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
    const role = getTripRole(trip);
    const vehicleDetails = trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || "Number not recorded"}`;

    detailContent.innerHTML = `
        <div class="history-detail-row"><span>Ride ID</span><strong>${escapeHtml(trip.ride_id || trip.id)}</strong></div>
        <div class="history-detail-row"><span>Status</span><strong>${escapeHtml(trip.trip_status || "completed")} / ${escapeHtml(trip.payment_status || "paid")}</strong></div>
        <div class="history-detail-row"><span>Date & Time</span><strong>${escapeHtml(formatDate(trip.completedAt))}</strong></div>
        <div class="history-detail-row"><span>Your Role</span><strong>${role === "driver" ? "Driver" : "Passenger"}</strong></div>
        <div class="history-detail-row"><span>Passenger</span><strong>${escapeHtml(trip.passenger_name || "Passenger")}</strong></div>
        <div class="history-detail-row"><span>Driver</span><strong>${escapeHtml(trip.driver_name || "Driver")}</strong></div>
        <div class="history-detail-row"><span>Vehicle</span><strong>${escapeHtml(vehicleDetails)}</strong></div>
        <div class="history-detail-row"><span>Service</span><strong>${escapeHtml(trip.service_name || (trip.vehicle_type === "auto" ? "Auto" : "Bike / Scooty"))}</strong></div>
        <div class="history-detail-row"><span>Pickup</span><strong>${escapeHtml(trip.pickup_location || "Pickup not recorded")}</strong></div>
        <div class="history-detail-row"><span>Drop</span><strong>${escapeHtml(trip.drop_location || "Drop not recorded")}</strong></div>
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
    setLoadingState();

    try {
        historyState.trips = await loadTripHistory();
        renderTrips();
    } catch (error) {
        setErrorState(error);
    }
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
        document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.remove('d-none'));
        userContext.innerText = "Login to view your completed trips";
        historyList.innerHTML = `
            <div class="history-empty-card">
                <div class="history-empty-icon">○</div>
                <h3>You are not logged in</h3>
                <p>Please login to view your ride history.</p>
                <button class="gy-btn gy-btn-primary" type="button" onclick="window.location.href='login.html'">Go to Login</button>
            </div>
        `;
        renderSummary([]);
        return;
    }

    document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.add('d-none'));

    historyState.user = user;
    setLoadingState();

    try {
        historyState.profile = await loadUserProfile(user);
        const name = historyState.profile.name || "LiphtUp user";
        const role = historyState.profile.role || "rider";
        userContext.innerText = `${name} • ${role}`;
        await refreshHistory();
    } catch (error) {
        setErrorState(error);
    }
});
