import { auth, db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const REFRESH_INTERVAL_MS = 30000;
let refreshTimer = null;

function formatRupees(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `Rs ${Math.round(amount)}` : "Rs 0";
}

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function renderDashboard(data) {
    document.getElementById('stat-today-earnings').innerText = formatRupees(data.today.earnings);
    document.getElementById('stat-today-completed').innerText = data.today.completedRides;
    document.getElementById('stat-pending-trips').innerText = data.pendingTrips.count;
    document.getElementById('stat-online-hours').innerText = `${data.today.onlineHours.toFixed(1)} h`;

    document.getElementById('stat-lifetime-earnings').innerText = formatRupees(data.performance.lifetimeEarnings);
    document.getElementById('stat-lifetime-trips').innerText = data.performance.lifetimeCompletedTrips;
    document.getElementById('stat-average-fare').innerText = formatRupees(data.performance.averageFare);
    document.getElementById('stat-acceptance-rate').innerText = data.today.acceptanceRate === null
        ? "No decisions yet today"
        : `${Math.round(data.today.acceptanceRate * 100)}%`;

    const currentTripSection = document.getElementById('dashboard-current-trip');
    if (data.currentTrip) {
        document.getElementById('current-trip-route').innerText = `${data.currentTrip.pickupName || "Pickup"} to ${data.currentTrip.dropName || "Drop"}`;
        document.getElementById('current-trip-passenger').innerText = `${data.currentTrip.passengerName || "Passenger"} · ${data.currentTrip.status}`;
        document.getElementById('current-trip-fare').innerText = formatRupees(data.currentTrip.fare);
        currentTripSection.classList.remove('d-none');
    } else {
        currentTripSection.classList.add('d-none');
    }

    const pendingSection = document.getElementById('dashboard-pending-preview');
    const pendingList = document.getElementById('pending-preview-list');
    if (data.pendingTrips.preview?.length) {
        pendingList.innerHTML = data.pendingTrips.preview.map((item) => `
            <div class="dashboard-pending-item">
                <div>
                    <strong>${escapeHtml(item.pickupName || "Pickup")}</strong>
                    <span class="text-muted small"> to ${escapeHtml(item.dropName || "Drop")}</span>
                </div>
                <span class="badge bg-light text-dark border">${formatRupees(item.fare)}</span>
            </div>
        `).join("");
        pendingSection.classList.remove('d-none');
    } else {
        pendingSection.classList.add('d-none');
    }

    document.getElementById('dashboard-loading').classList.add('d-none');
    document.getElementById('dashboard-error').classList.add('d-none');
    document.getElementById('dashboard-content').classList.remove('d-none');
}

function showError(message) {
    document.getElementById('dashboard-loading').classList.add('d-none');
    document.getElementById('dashboard-content').classList.add('d-none');
    document.getElementById('dashboard-error-text').innerText = message;
    document.getElementById('dashboard-error').classList.remove('d-none');
}

async function loadDashboard() {
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch("/api/rides/driver-dashboard", {
            headers: { Authorization: `Bearer ${idToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not load your dashboard.");
        renderDashboard(data);
    } catch (error) {
        console.error("Driver dashboard load failed:", error);
        showError(error.message || "Could not load your dashboard.");
    }
}

document.getElementById('dashboard-retry-btn')?.addEventListener('click', loadDashboard);

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace("/login");
        return;
    }
    try {
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        const profile = profileSnap.exists() ? profileSnap.data() : null;
        if (!profile || profile.role !== "driver") {
            window.location.replace("/login");
            return;
        }
        document.getElementById('dashboard-welcome-name').innerText = `Welcome, ${profile.name || "Driver"}`;
        if (profile.verificationStatus !== "approved") {
            showError("Your driver account is still under review. Dashboard stats are available once approved.");
            return;
        }

        await loadDashboard();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(loadDashboard, REFRESH_INTERVAL_MS);
    } catch (error) {
        console.warn("Driver dashboard auth check failed:", error);
        showError("Could not verify your driver session.");
    }
});
