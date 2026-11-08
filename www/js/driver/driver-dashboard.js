import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { hideInitialLoader } from '../shared/loading.js';
import { paymentReminderManager } from './driver-payment-reminder.js';
import { renderLanguageSwitcher } from '../shared/i18n.js';

const REFRESH_INTERVAL_MS = 30000;
let refreshTimer = null;
let dailyRealtimeUnsub = null;
let currentDashboardData = null;
let activePeriodTab = 'week'; // 'week' | 'month'

function formatRupees(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return "₹0";
    return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

function formatDistance(value) {
    const km = Number(value);
    if (!Number.isFinite(km) || km <= 0) return "0 km";
    if (km < 1) {
        const meters = Math.round((km * 1000) / 10) * 10;
        return meters <= 0 ? "0 km" : `${meters} m`;
    }
    return `${km.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

function formatOnlineTime(seconds) {
    const totalSecs = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    return `${hours.toLocaleString('en-IN')}h ${minutes}m`;
}

function formatCount(value) {
    const count = Math.max(0, Math.floor(Number(value) || 0));
    return count.toLocaleString('en-IN');
}

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function updatePeriodView() {
    if (!currentDashboardData) return;
    const periodData = activePeriodTab === 'month' ? currentDashboardData.month : currentDashboardData.week;
    if (!periodData) return;

    // Date range label
    const rangeEl = document.getElementById('period-date-range-label');
    if (rangeEl && periodData.label) {
        rangeEl.textContent = periodData.label;
    }

    // 4 Quad tiles
    const distEl = document.getElementById('period-stat-distance');
    if (distEl) distEl.textContent = formatDistance(periodData.distanceKm);

    const earnEl = document.getElementById('period-stat-earnings');
    if (earnEl) earnEl.textContent = formatRupees(periodData.earnings);

    const tripEl = document.getElementById('period-stat-trips');
    if (tripEl) tripEl.textContent = formatCount(periodData.completedRides);

    const timeEl = document.getElementById('period-stat-online-time');
    if (timeEl) timeEl.textContent = formatOnlineTime(periodData.onlineSeconds);
}

function renderDashboard(data) {
    currentDashboardData = data;

    // 1. Today's Performance
    const todayBadgeEl = document.getElementById('dashboard-today-date-badge');
    if (todayBadgeEl && data.todayLabel) {
        todayBadgeEl.textContent = data.todayLabel;
    }
    const todayEarnEl = document.getElementById('stat-today-earnings');
    if (todayEarnEl) todayEarnEl.textContent = formatRupees(data.today?.earnings);

    const todayTripsEl = document.getElementById('stat-today-completed');
    if (todayTripsEl) todayTripsEl.textContent = formatCount(data.today?.completedRides);

    // 2. Tabbed Period Summary
    updatePeriodView();

    // 3. Lifetime Summary
    const lifeDistEl = document.getElementById('lifetime-stat-distance');
    if (lifeDistEl) {
        const distKm = data.lifetime?.distanceKm ?? data.performance?.lifetimeDistanceKm;
        lifeDistEl.textContent = formatDistance(distKm);
    }

    const lifeEarnEl = document.getElementById('lifetime-stat-earnings');
    if (lifeEarnEl) {
        const earn = data.lifetime?.earnings ?? data.performance?.lifetimeEarnings;
        lifeEarnEl.textContent = formatRupees(earn);
    }

    const lifeTripEl = document.getElementById('lifetime-stat-trips');
    if (lifeTripEl) {
        const trips = data.lifetime?.completedRides ?? data.performance?.lifetimeCompletedTrips;
        lifeTripEl.textContent = formatCount(trips);
    }

    const lifeTimeEl = document.getElementById('lifetime-stat-online-time');
    if (lifeTimeEl) {
        lifeTimeEl.textContent = formatOnlineTime(data.lifetime?.onlineSeconds);
    }

    // 4. Current Trip Section (if active)
    const currentTripSection = document.getElementById('dashboard-current-trip');
    if (currentTripSection) {
        if (data.currentTrip) {
            const routeEl = document.getElementById('current-trip-route');
            if (routeEl) routeEl.innerText = `${data.currentTrip.pickupName || "Pickup"} to ${data.currentTrip.dropName || "Drop"}`;
            const passEl = document.getElementById('current-trip-passenger');
            if (passEl) passEl.innerText = `${data.currentTrip.passengerName || "Passenger"} · ${data.currentTrip.status}`;
            const fareEl = document.getElementById('current-trip-fare');
            if (fareEl) fareEl.innerText = formatRupees(data.currentTrip.fare);
            currentTripSection.classList.remove('d-none');
        } else {
            currentTripSection.classList.add('d-none');
        }
    }

    // 5. Queued Requests (if any)
    const pendingSection = document.getElementById('dashboard-pending-preview');
    const pendingList = document.getElementById('pending-preview-list');
    if (pendingSection && pendingList) {
        if (data.pendingTrips?.preview?.length) {
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
    }

    document.getElementById('dashboard-loading')?.classList.add('d-none');
    document.getElementById('dashboard-error')?.classList.add('d-none');
    document.getElementById('dashboard-content')?.classList.remove('d-none');
}

function showError(message) {
    document.getElementById('dashboard-loading')?.classList.add('d-none');
    document.getElementById('dashboard-content')?.classList.add('d-none');
    const errText = document.getElementById('dashboard-error-text');
    if (errText) errText.innerText = message;
    document.getElementById('dashboard-error')?.classList.remove('d-none');
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

function setupPeriodTabs() {
    const weekBtn = document.getElementById('tab-week-btn');
    const monthBtn = document.getElementById('tab-month-btn');

    weekBtn?.addEventListener('click', () => {
        if (activePeriodTab === 'week') return;
        activePeriodTab = 'week';
        weekBtn.classList.add('active');
        weekBtn.setAttribute('aria-selected', 'true');
        monthBtn?.classList.remove('active');
        monthBtn?.setAttribute('aria-selected', 'false');
        updatePeriodView();
    });

    monthBtn?.addEventListener('click', () => {
        if (activePeriodTab === 'month') return;
        activePeriodTab = 'month';
        monthBtn.classList.add('active');
        monthBtn.setAttribute('aria-selected', 'true');
        weekBtn?.classList.remove('active');
        weekBtn?.setAttribute('aria-selected', 'false');
        updatePeriodView();
    });
}

function subscribeRealtimeTodayStats(uid, dayStr) {
    if (dailyRealtimeUnsub) {
        dailyRealtimeUnsub();
        dailyRealtimeUnsub = null;
    }
    if (!uid || !dayStr) return;

    try {
        dailyRealtimeUnsub = onSnapshot(doc(db, "driverDailyStats", `${uid}_${dayStr}`), (snap) => {
            if (snap.exists() && currentDashboardData) {
                const fresh = snap.data() || {};
                const earn = Number(fresh.earnings) || 0;
                const completed = Number(fresh.completed_rides) || 0;
                const distance = Number(fresh.distance_km) || 0;
                const onlineSecs = Number(fresh.online_seconds) || 0;

                // Update today values
                currentDashboardData.today.earnings = earn;
                currentDashboardData.today.completedRides = completed;
                currentDashboardData.today.distanceKm = distance;
                currentDashboardData.today.onlineSeconds = onlineSecs;

                const todayEarnEl = document.getElementById('stat-today-earnings');
                if (todayEarnEl) todayEarnEl.textContent = formatRupees(earn);
                const todayTripsEl = document.getElementById('stat-today-completed');
                if (todayTripsEl) todayTripsEl.textContent = formatCount(completed);
            }
        }, (err) => {
            console.warn("Realtime daily stats listener notice:", err);
        });
    } catch (e) {
        console.warn("Could not attach daily stats realtime listener:", e);
    }
}

document.getElementById('dashboard-retry-btn')?.addEventListener('click', loadDashboard);

setupPeriodTabs();

// Render language switcher in header
const langEl = document.getElementById('driver-dashboard-lang-switcher');
if (langEl) renderLanguageSwitcher(langEl);

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace("/login.html");
        hideInitialLoader();
        return;
    }
    try {
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        const profile = profileSnap.exists() ? profileSnap.data() : null;
        if (!profile || profile.role !== "driver") {
            window.location.replace("/login.html");
            hideInitialLoader();
            return;
        }
        if (profile.verificationStatus !== "approved") {
            showError("Your driver account is still under review. Dashboard stats are available once approved.");
            hideInitialLoader();
            return;
        }

        await loadDashboard();

        // Subscribe to today's stats in real-time
        if (currentDashboardData?.date) {
            subscribeRealtimeTodayStats(user.uid, currentDashboardData.date);
        }

        paymentReminderManager.init(user);
        hideInitialLoader();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(loadDashboard, REFRESH_INTERVAL_MS);
    } catch (error) {
        console.warn("Driver dashboard auth check failed:", error);
        showError("Could not verify your driver session.");
        hideInitialLoader();
    }
});
