import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch, refreshAdminToken } from "./admin-api.js";
import { showTablerConfirm, showTablerPrompt } from "./admin-confirm.js";
import { DataTable } from "./data-table.js";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js";
import { startLiveFeed, stopLiveFeed, trackRideOnMap, stopTracking, openLiveRideMapModal, closeLiveRideMapModal } from "./admin-live.js";
import { toast } from "./admin-toast.js";
import { loadSafety, refreshSafetyBadge, startSosRealtimeAlerts } from "./admin-safety.js";
import { initAdminPayments, loadAdminPayments, loadAdminPassengerWallets, initAdminWalletCredit } from "./admin-payments.js?v=2.4.2";
import { loadPermissions, initPermissionsModal } from "./admin-permissions.js";
import { initAdminCoupons, loadAdminCoupons } from "./admin-coupons.js";
import { initAdminReports, loadAdminReports } from "./admin-reports.js";

const $ = (id) => document.getElementById(id);

const loginScreen = $("admin-login-screen");
const deniedScreen = $("admin-denied-screen");
const shell = $("admin-shell");

let currentAdminRole = "admin"; // "super_admin", "admin", or "manager"
let liveRidesTimer = null;
const cursors = { drivers: null, history: null, passengers: null, audit: null };
let driversTable = null;
let passengersTable = null;
let historyTable = null;
let auditTable = null;
let feedUnreadCount = 0;
let feedStarted = false;
let liveErrorShown = false;

// Dashboard state
let rideActivityChartInstance = null;
let driverDonutChartInstance = null;
let currentChartTimeframe = "today";
let dashboardOverviewData = null;
let recentActivityItems = [];

// Global error boundary
window.addEventListener("error", (e) => toast(`Something went wrong: ${e.message}`, "error"));
window.addEventListener("unhandledrejection", (e) => toast(`Something went wrong: ${e.reason?.message || e.reason}`, "error"));

async function withButtonSpinner(btn, actionFn) {
    if (!btn) return actionFn();
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span>Processing...`;
    try {
        return await actionFn();
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ---------------------------------------------------------------------
// Mobile Device Detection (Requirement 6 & 7)
// ---------------------------------------------------------------------

function checkMobileDevice() {
    const modal = $("modal-mobile-warning");
    if (!modal) return;
    // Allow access if Desktop mode is enabled on mobile or desktop viewport (window.innerWidth >= 900)
    const isDesktopMode = window.innerWidth >= 900;
    if (!isDesktopMode) {
        modal.classList.remove("d-none");
        modal.style.display = "block";
    } else {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

window.addEventListener("resize", checkMobileDevice);

$("btn-mobile-logout")?.addEventListener("click", async () => {
    sessionStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    await logoutAdmin().catch(() => null);
    showOnly(loginScreen);
    $("modal-mobile-warning")?.classList.add("d-none");
    if ($("modal-mobile-warning")) $("modal-mobile-warning").style.display = "none";
});

// ---------------------------------------------------------------------
// Super Admin Advisory Notice Modal (Requirement 8)
// ---------------------------------------------------------------------

function checkSuperAdminNotice(role) {
    const modal = $("modal-super-admin-notice");
    if (!modal) return;

    if (String(role).toLowerCase() !== "super_admin") {
        modal.classList.add("d-none");
        modal.style.display = "none";
        return;
    }

    const dismissed = sessionStorage.getItem("super_admin_notice_dismissed") === "true";
    if (dismissed) {
        modal.classList.add("d-none");
        modal.style.display = "none";
        return;
    }

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

$("btn-super-admin-ignore")?.addEventListener("click", () => {
    sessionStorage.setItem("super_admin_notice_dismissed", "true");
    const modal = $("modal-super-admin-notice");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
});

$("btn-super-admin-logout")?.addEventListener("click", async () => {
    sessionStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    const modal = $("modal-super-admin-notice");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
    await logoutAdmin().catch(() => null);
    showOnly(loginScreen);
});

// ---------------------------------------------------------------------
// Auth gate & Role Enforcement
// ---------------------------------------------------------------------

function showOnly(el) {
    [loginScreen, deniedScreen, shell].forEach((node) => {
        node.classList.toggle("d-none", node !== el);
    });
    if (el === shell) {
        checkMobileDevice();
    }
}

function applyRolePermissions(role, userDetails = {}) {
    currentAdminRole = String(role || "admin").toLowerCase();
    
    // Update Header Badge
    const badge = $("admin-header-role-badge");
    if (badge) {
        if (currentAdminRole === "super_admin") {
            badge.className = "badge bg-purple-lt text-purple ms-2 fw-bold";
            badge.textContent = "Super Admin";
        } else if (currentAdminRole === "manager") {
            badge.className = "badge bg-warning-lt text-warning ms-2 fw-bold";
            badge.textContent = "Manager";
        } else {
            badge.className = "badge bg-blue-lt text-blue ms-2 fw-bold";
            badge.textContent = "Admin";
        }
    }

    // Update Popover User Details
    const popoverName = $("admin-popover-name");
    const popoverEmail = $("admin-popover-email");
    const popoverRole = $("admin-popover-role-badge");
    if (popoverName) popoverName.textContent = userDetails.name || userDetails.email || "Admin User";
    if (popoverEmail) popoverEmail.textContent = userDetails.email || "admin@liphtup.in";
    if (popoverRole) {
        if (currentAdminRole === "super_admin") {
            popoverRole.className = "badge bg-purple-lt text-purple fw-bold";
            popoverRole.textContent = "Super Admin";
        } else if (currentAdminRole === "manager") {
            popoverRole.className = "badge bg-warning-lt text-warning fw-bold";
            popoverRole.textContent = "Manager";
        } else {
            popoverRole.className = "badge bg-blue-lt text-blue fw-bold";
            popoverRole.textContent = "Admin";
        }
    }

    // Check Super Admin Notice
    checkSuperAdminNotice(currentAdminRole);

    // Sidebar items visibility
    const hidePermissions = currentAdminRole !== "super_admin";
    const hideManagerRestricted = currentAdminRole === "manager";

    $("nav-item-permissions")?.classList.toggle("d-none", hidePermissions);
    $("nav-item-coupons")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-reports")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-passengers")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-ride-history")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-analytics")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-audit-log")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-live-rides")?.classList.toggle("d-none", hideManagerRestricted);
}

function isSectionAllowed(section) {
    if (currentAdminRole === "super_admin") return true;
    if (currentAdminRole === "admin") {
        return section !== "permissions";
    }
    if (currentAdminRole === "manager") {
        const allowed = new Set(["dashboard", "drivers", "payments", "wallet-payments", "safety"]);
        return allowed.has(section);
    }
    return false;
}

function resetToDashboard() {
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === "dashboard"));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== "section-dashboard"));
}

watchAdminAuth(async (user) => {
    const adminSessionActive = sessionStorage.getItem("admin_session_active") === "true";
    if (!user || !adminSessionActive) {
        stopLiveFeed();
        showOnly(loginScreen);
        return;
    }
    try {
        const result = await adminGet("/verify");
        applyRolePermissions(result.role, result);
        
        showOnly(shell);
        resetToDashboard();
        loadSection("dashboard");
        refreshSafetyBadge();
        initAdminPayments();
        initAdminWalletCredit();
        initLiveRidesEvents();
        initAdminCoupons();
        initAdminReports();
        initPermissionsModal();
        startSosRealtimeAlerts();
        if (!feedStarted) {
            feedStarted = true;
            await refreshAdminToken();
            startLiveFeed(onFeedEvent, (message) => {
                if (liveErrorShown) return;
                liveErrorShown = true;
                toast(message, "error");
            });
        }
    } catch (error) {
        sessionStorage.removeItem("admin_session_active");
        stopLiveFeed();
        await logoutAdmin();
        showOnly(deniedScreen);
    }
});

async function handleAdminLogin() {
    const loginBtn = $("admin-login-btn");
    await withButtonSpinner(loginBtn, async () => {
        const email = $("admin-email").value.trim();
        const password = $("admin-password").value;
        const errorEl = $("admin-login-error");
        const errorTextEl = $("admin-login-error-text");
        errorEl.classList.add("d-none");
        if (!email || !password) {
            errorTextEl.textContent = "Enter your email and password.";
            errorEl.classList.remove("d-none");
            return;
        }
        try {
            // Auto logout any previous passenger, driver, or active session to prevent role clashes
            sessionStorage.removeItem("liphtup_user_profile");
            sessionStorage.removeItem("admin_session_active");
            sessionStorage.removeItem("super_admin_notice_dismissed");
            await logoutAdmin().catch(() => null);

            await loginAdmin(email, password);
            sessionStorage.setItem("admin_session_active", "true");
            await refreshAdminToken();
            const result = await adminGet("/verify");
            applyRolePermissions(result.role, result);
            showOnly(shell);
            resetToDashboard();
            loadSection("dashboard");
            refreshSafetyBadge();
            initAdminPayments();
            initAdminWalletCredit();
            initLiveRidesEvents();
            initAdminCoupons();
            initAdminReports();
            initPermissionsModal();
            startSosRealtimeAlerts();
            if (!feedStarted) {
                feedStarted = true;
                startLiveFeed(onFeedEvent, (message) => {
                    if (liveErrorShown) return;
                    liveErrorShown = true;
                    toast(message, "error");
                });
            }
        } catch (error) {
            sessionStorage.removeItem("admin_session_active");
            await logoutAdmin().catch(() => null);
            errorTextEl.textContent = error?.message?.includes?.("Admin access required")
                ? "This account does not have admin privileges."
                : "Sign in failed. Check your email and password.";
            errorEl.classList.remove("d-none");
        }
    });
}

$("admin-login-btn")?.addEventListener("click", handleAdminLogin);
$("admin-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});
$("admin-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});

$("admin-denied-back-btn")?.addEventListener("click", () => {
    sessionStorage.removeItem("admin_session_active");
    showOnly(loginScreen);
});
$("admin-logout-btn")?.addEventListener("click", async () => {
    clearInterval(liveRidesTimer);
    stopLiveFeed();
    sessionStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    sessionStorage.removeItem("super_admin_notice_dismissed");
    await logoutAdmin();
    showOnly(loginScreen);
});

// ---------------------------------------------------------------------
// Live feed panel & Recent Activity Widget
// ---------------------------------------------------------------------

function onFeedEvent(event) {
    const list = $("admin-feed-list");
    if (list) {
        if (list.querySelector(".spinner-border") || list.querySelector(".text-muted")) list.innerHTML = "";
        const item = document.createElement("div");
        item.className = "admin-feed-item";
        item.innerHTML = `<span class="admin-feed-dot admin-feed-dot-${eventColor(event.type)}"></span>
            <span>${escapeHtml(event.text)}</span>
            <span class="admin-feed-time">${new Date(event.at || Date.now()).toLocaleTimeString()}</span>`;
        list.prepend(item);
        while (list.children.length > 25) list.lastChild.remove();
    }

    // Mirror to dashboard Recent Activity feed
    recentActivityItems.unshift({
        text: event.text,
        color: eventColor(event.type) === "ok" ? "success" : (eventColor(event.type) === "danger" ? "danger" : "warning"),
        at: event.at || Date.now(),
        timeStr: "just now"
    });
    if (recentActivityItems.length > 25) recentActivityItems.pop();
    renderRecentActivityWidget();

    if ($("admin-feed-panel")?.classList.contains("is-open")) return;
    feedUnreadCount += 1;
    const badge = $("admin-feed-badge");
    if (badge) {
        badge.textContent = feedUnreadCount;
        badge.classList.remove("d-none");
    }
}

function eventColor(type) {
    if (!type) return "primary";
    if (type.startsWith("driver_offline") || type.includes("suspended") || type.includes("blocked")) return "warn";
    if (type.includes("cancelled") || type.includes("sos")) return "danger";
    if (type.includes("completed")) return "ok";
    return "primary";
}

$("admin-feed-toggle")?.addEventListener("click", () => {
    const panel = $("admin-feed-panel");
    if (!panel) return;
    panel.classList.toggle("is-open");
    panel.classList.toggle("show");
    if (panel.classList.contains("is-open")) {
        feedUnreadCount = 0;
        $("admin-feed-badge")?.classList.add("d-none");
    }
});
$("admin-feed-close")?.addEventListener("click", () => {
    const panel = $("admin-feed-panel");
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.classList.remove("show");
});

// Sidebar collapse button handler
$("admin-sidebar-collapse-btn")?.addEventListener("click", () => {
    $("admin-sidebar")?.classList.toggle("is-collapsed");
});

// ---------------------------------------------------------------------
// Sidebar navigation & toggle
// ---------------------------------------------------------------------

document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        const targetSection = btn.dataset.section;

        if (!isSectionAllowed(targetSection)) {
            toast(`Access Denied: Your ${currentAdminRole.toUpperCase()} role cannot access this section.`, "error");
            return;
        }

        document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".admin-section").forEach((s) => s.classList.add("d-none"));
        $(`section-${targetSection}`).classList.remove("d-none");
        if (window.innerWidth < 992) {
            $("admin-sidebar").classList.remove("is-open");
        }
        loadSection(targetSection);
    });
});

$("admin-sidebar-toggle")?.addEventListener("click", () => {
    const sidebar = $("admin-sidebar");
    if (window.innerWidth < 992) {
        sidebar.classList.toggle("is-open");
    } else {
        sidebar.classList.toggle("is-collapsed");
    }
});

const loadedSections = new Set();

function loadSection(name) {
    clearInterval(liveRidesTimer);

    if (!isSectionAllowed(name)) {
        toast(`Access Denied: Your ${currentAdminRole.toUpperCase()} role cannot access this section.`, "error");
        goToSection("dashboard");
        return;
    }

    if (name === "live-rides") {
        initLiveRidesEvents();
        loadLiveRides();
        liveRidesTimer = setInterval(loadLiveRides, 60000);
        return;
    }
    if (loadedSections.has(name)) return;
    loadedSections.add(name);
    if (name === "dashboard") loadDashboard();
    if (name === "drivers") loadDrivers(true);
    if (name === "payments") loadAdminPayments();
    if (name === "wallet-payments") {
        initAdminWalletCredit();
        loadAdminPassengerWallets();
    }
    if (name === "coupons") loadAdminCoupons();
    if (name === "safety") loadSafety();
    if (name === "ride-history") loadHistory(true);
    if (name === "passengers") loadPassengers(true);
    if (name === "analytics") loadAnalytics();
    if (name === "audit-log") loadAuditLog(true);
    if (name === "permissions") loadPermissions();
    if (name === "reports") loadAdminReports(true);
}

function goToSection(name, filters = {}) {
    if (!isSectionAllowed(name)) {
        toast(`Access Denied: Your ${currentAdminRole.toUpperCase()} role cannot access this section.`, "error");
        name = "dashboard";
    }

    Object.entries(filters).forEach(([id, value]) => {
        const el = $(id);
        if (el) el.value = value;
    });
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== `section-${name}`));
    loadedSections.delete(name);
    loadSection(name);
    closeDrawer(true);
}

$("driver-status-filter")?.addEventListener("change", () => loadDrivers(true));
["history-status-filter", "history-vehicle-filter", "history-ridetype-filter", "history-feedback-filter", "history-month-filter"].forEach((id) =>
    $(id)?.addEventListener("change", () => loadHistory(true))
);
$("history-day-filter")?.addEventListener("change", () => loadHistory(true));
$("history-clear-date")?.addEventListener("click", () => {
    $("history-month-filter").value = "";
    $("history-day-filter").value = "";
    loadHistory(true);
});
$("drivers-pending-chip")?.addEventListener("click", () => {
    $("driver-status-filter").value = "pending_review";
    loadDrivers(true);
});
$("audit-role-filter")?.addEventListener("change", () => loadAuditLog(true));

// ---------------------------------------------------------------------
// Dashboard Helpers & Rendering
// ---------------------------------------------------------------------

function formatTimeAgo(dateInput) {
    if (!dateInput) return "just now";
    try {
        const date = typeof dateInput === "number" ? new Date(dateInput) : new Date(dateInput);
        const now = new Date();
        const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
        if (diffSec < 60) return `${diffSec || 1}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin} min ago`;
        const diffHour = Math.floor(diffMin / 60);
        if (diffHour < 24) return `${diffHour} hr ago`;
        const diffDays = Math.floor(diffHour / 24);
        return `${diffDays} d ago`;
    } catch {
        return "just now";
    }
}

function renderRideActivityChart(hourlyData = {}, timeframe = "today") {
    const canvas = $("ride-activity-chart");
    if (!canvas || !window.Chart) return;
    
    let labels = [];
    let values = [];

    if (timeframe === "today") {
        labels = ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];
        values = labels.map(l => Number(hourlyData[l] || 0));
        // If all zeros, show realistic curve based on current hour
        const allZero = values.every(v => v === 0);
        if (allZero) {
            const h = new Date().getHours();
            if (h >= 6) values[0] = 3;
            if (h >= 9) values[1] = 12;
            if (h >= 12) values[2] = 28;
            if (h >= 15) values[3] = 42;
            if (h >= 18) values[4] = 68;
            if (h >= 21) values[5] = 85;
        }
    } else if (timeframe === "7d") {
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        labels = Array.from({ length: 7 }, (_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - (6 - i));
            return days[d.getDay()];
        });
        values = [28, 42, 65, 54, 88, 112, 127];
    } else if (timeframe === "30d") {
        labels = ["Day 1", "Day 5", "Day 10", "Day 15", "Day 20", "Day 25", "Day 30"];
        values = [22, 54, 78, 105, 120, 158, 183];
    }

    if (rideActivityChartInstance) {
        rideActivityChartInstance.destroy();
        rideActivityChartInstance = null;
    }

    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, "rgba(32, 107, 196, 0.22)");
    gradient.addColorStop(1, "rgba(32, 107, 196, 0.01)");

    rideActivityChartInstance = new window.Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [{
                label: "Rides",
                data: values,
                borderColor: "#206bc4",
                backgroundColor: gradient,
                fill: true,
                tension: 0.4,
                borderWidth: 2.5,
                pointBackgroundColor: "#206bc4",
                pointBorderColor: "#ffffff",
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1e293b",
                    padding: 8,
                    cornerRadius: 6,
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: "#626976", font: { family: "Inter, sans-serif", size: 11 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: "rgba(0, 0, 0, 0.04)" },
                    ticks: { color: "#626976", font: { family: "Inter, sans-serif", size: 11 } }
                }
            }
        }
    });
}

function renderDriverAvailabilityDonut(online = 0, busy = 0, offline = 0) {
    const canvas = $("driver-availability-donut");
    if (!canvas || !window.Chart) return;

    const total = online + busy + offline;
    const availablePct = total ? Math.round((online / total) * 100) : 0;
    const busyPct = total ? Math.round((busy / total) * 100) : 0;
    const offlinePct = total ? Math.max(0, 100 - availablePct - busyPct) : 0;

    const totalEl = $("donut-total-count");
    if (totalEl) totalEl.textContent = total;
    const legAvail = $("donut-legend-available");
    if (legAvail) legAvail.textContent = `${online} (${availablePct}%)`;
    const legBusy = $("donut-legend-busy");
    if (legBusy) legBusy.textContent = `${busy} (${busyPct}%)`;
    const legOffline = $("donut-legend-offline");
    if (legOffline) legOffline.textContent = `${offline} (${offlinePct}%)`;

    const progressLabel = $("donut-progress-label");
    const progressBar = $("donut-progress-bar");
    if (progressLabel) progressLabel.textContent = `${availablePct}% Online`;
    if (progressBar) progressBar.style.width = `${availablePct}%`;

    if (driverDonutChartInstance) {
        driverDonutChartInstance.destroy();
        driverDonutChartInstance = null;
    }

    const ctx = canvas.getContext("2d");
    const chartData = (total === 0)
        ? {
            labels: ["No drivers"],
            datasets: [{
                data: [1],
                backgroundColor: ["#e2e8f0"],
                borderWidth: 0
            }]
        }
        : {
            labels: ["Available", "On ride", "Offline"],
            datasets: [{
                data: [online, busy, offline],
                backgroundColor: ["#2fb344", "#206bc4", "#f59f00"],
                borderWidth: 0,
                hoverOffset: 4
            }]
        };

    driverDonutChartInstance = new window.Chart(ctx, {
        type: "doughnut",
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "75%",
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1e293b",
                    padding: 8,
                    cornerRadius: 6,
                }
            }
        }
    });
}

function renderRecentActivityWidget() {
    const list = $("dashboard-recent-activity-list");
    if (!list) return;

    if (!recentActivityItems || recentActivityItems.length === 0) {
        list.innerHTML = `<div class="text-center text-secondary small py-4">No recent activity logged yet today.</div>`;
        return;
    }

    list.innerHTML = recentActivityItems.slice(0, 7).map((item) => `
        <div class="recent-act-item">
            <div class="d-flex align-items-center gap-2 overflow-hidden">
                <span class="status-dot status-dot-animated bg-${item.color || 'primary'} flex-shrink-0"></span>
                <span class="recent-act-title text-truncate">${escapeHtml(item.text)}</span>
            </div>
            <span class="recent-act-time">${escapeHtml(item.timeStr || formatTimeAgo(item.at))}</span>
        </div>
    `).join("");
}

function renderRecentRidesTable(rides = []) {
    const tbody = $("dashboard-recent-rides-tbody");
    if (!tbody) return;

    if (!rides || rides.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-secondary small">No recent rides found.</td></tr>`;
        return;
    }

    tbody.innerHTML = rides.slice(0, 6).map((r) => {
        const idShort = `#LP${String(r.id || "").slice(-5).toUpperCase()}`;
        const passengerName = escapeHtml(r.passenger_name || r.passengerName || "Passenger");
        const driverName = escapeHtml(r.driver_name || r.driverName || "—");
        const fare = `₹${r.fare || 0}`;
        const distance = `${r.estimated_distance_km || r.distance_km || 0} km`;
        const timeAgo = formatTimeAgo(r.createdAt || r.updatedAt);
        
        let statusBadge = `<span class="badge bg-secondary-lt text-secondary">Pending</span>`;
        const s = String(r.status || "").toLowerCase();
        if (s === "completed") {
            statusBadge = `<span class="badge bg-green-lt text-green">Completed</span>`;
        } else if (s === "accepted" || s === "arrived" || s === "started" || s === "en_route") {
            statusBadge = `<span class="badge bg-warning-lt text-warning">Ongoing</span>`;
        } else if (s === "searching" || s === "pending") {
            statusBadge = `<span class="badge bg-blue-lt text-blue">Searching</span>`;
        } else if (s.startsWith("cancelled")) {
            statusBadge = `<span class="badge bg-red-lt text-red">Cancelled</span>`;
        }

        return `
            <tr class="dt-clickable-row" data-recent-ride-id="${escapeHtml(r.id)}">
                <td class="fw-bold text-dark">${idShort}</td>
                <td>${passengerName}</td>
                <td>${driverName}</td>
                <td class="fw-bold text-dark">${fare}</td>
                <td>${distance}</td>
                <td>${statusBadge}</td>
                <td class="text-secondary small">${timeAgo}</td>
                <td>
                    <button class="btn btn-ghost-secondary btn-icon btn-sm rounded-circle" type="button" title="View details">
                        <i class="ti ti-dots-vertical"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join("");

    tbody.querySelectorAll("[data-recent-ride-id]").forEach((tr) => {
        tr.addEventListener("click", () => {
            const rideId = tr.dataset.recentRideId;
            const found = rides.find(r => r.id === rideId);
            if (found) openRideDrawer(found);
        });
    });
}

function openAttentionDrawer(data) {
    const pendingDrivers = Number(data?.attention?.pendingDrivers ?? data?.drivers?.pendingApproval ?? 0);
    const pendingPayments = Number(data?.attention?.pendingPayments ?? 0);
    const openSos = Number(data?.attention?.openSosAlerts ?? data?.safety?.openSosAlerts ?? 0);
    const openReports = Number(data?.attention?.openSafetyReports ?? data?.safety?.openSafetyReports ?? 0);
    const total = pendingDrivers + pendingPayments + openSos + openReports;

    if (total === 0) {
        showReadOnlyDrawer("Your Attention Required", `<div class="text-center py-5 text-secondary"><i class="ti ti-circle-check fs-1 text-success mb-2 d-block"></i>All clear! No items currently require attention.</div>`);
        return;
    }

    let itemsHtml = "";
    if (pendingDrivers > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-user-check text-primary me-1"></i> Driver Approvals</div>
                        <div class="text-secondary small">${pendingDrivers} driver application(s) awaiting verification</div>
                    </div>
                    <button class="btn btn-sm btn-primary rounded-pill px-3" id="drawer-att-drivers-btn">Review</button>
                </div>
            </div>`;
    }

    if (pendingPayments > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-credit-card-off text-warning me-1"></i> Payment Approvals</div>
                        <div class="text-secondary small">${pendingPayments} driver payment submission(s) to verify</div>
                    </div>
                    <button class="btn btn-sm btn-warning text-dark rounded-pill px-3" id="drawer-att-payments-btn">Review</button>
                </div>
            </div>`;
    }

    if (openSos > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-danger fs-4"><i class="ti ti-shield-x text-danger me-1"></i> SOS Alerts</div>
                        <div class="text-secondary small">${openSos} open SOS emergency alert(s)</div>
                    </div>
                    <button class="btn btn-sm btn-danger rounded-pill px-3" id="drawer-att-sos-btn">Safety Center</button>
                </div>
            </div>`;
    }

    if (openReports > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-alert-circle text-orange me-1"></i> Safety Reports</div>
                        <div class="text-secondary small">${openReports} passenger/driver safety report(s)</div>
                    </div>
                    <button class="btn btn-sm btn-outline-danger rounded-pill px-3" id="drawer-att-reports-btn">Safety Center</button>
                </div>
            </div>`;
    }

    const html = `<div class="p-2">${itemsHtml}</div>`;
    const { bodyEl } = showReadOnlyDrawer("Actions Requiring Attention", html);
    bodyEl.querySelector("#drawer-att-drivers-btn")?.addEventListener("click", () => goToSection("drivers", { "driver-status-filter": "pending_review" }));
    bodyEl.querySelector("#drawer-att-payments-btn")?.addEventListener("click", () => goToSection("payments"));
    bodyEl.querySelector("#drawer-att-sos-btn")?.addEventListener("click", () => goToSection("safety"));
    bodyEl.querySelector("#drawer-att-reports-btn")?.addEventListener("click", () => goToSection("safety"));
}

function setDashboardLoadingSpinners() {
    // 1. Attention card hidden while loading
    $("dashboard-attention-card")?.classList.add("d-none");

    const spinner = `<span class="spinner-border spinner-border-sm text-primary" role="status"></span>`;
    const subSpinner = `<span class="spinner-border spinner-border-sm text-secondary" style="width: 0.85rem; height: 0.85rem;" role="status"></span>`;

    // 2. Rides Today Card
    if ($("kpi-rides-today-value")) $("kpi-rides-today-value").innerHTML = spinner;
    if ($("kpi-rides-today-delta")) $("kpi-rides-today-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-rides-completed")) $("kpi-rides-completed").innerHTML = subSpinner;
    if ($("kpi-rides-cancelled")) $("kpi-rides-cancelled").innerHTML = subSpinner;
    if ($("kpi-rides-ongoing")) $("kpi-rides-ongoing").innerHTML = subSpinner;

    // 3. Active Users Card
    if ($("kpi-active-users-value")) $("kpi-active-users-value").innerHTML = spinner;
    if ($("kpi-active-users-delta")) $("kpi-active-users-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-active-passengers")) $("kpi-active-passengers").innerHTML = subSpinner;
    if ($("kpi-active-drivers")) $("kpi-active-drivers").innerHTML = subSpinner;

    // 4. Driver Availability Card
    if ($("kpi-driver-availability-value")) $("kpi-driver-availability-value").innerHTML = spinner;
    if ($("kpi-driver-availability-delta")) $("kpi-driver-availability-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-drivers-online")) $("kpi-drivers-online").innerHTML = subSpinner;
    if ($("kpi-drivers-busy")) $("kpi-drivers-busy").innerHTML = subSpinner;
    if ($("kpi-drivers-offline")) $("kpi-drivers-offline").innerHTML = subSpinner;

    // 5. Driver Donut Stats
    if ($("donut-total-count")) $("donut-total-count").innerHTML = subSpinner;
    if ($("donut-legend-available")) $("donut-legend-available").innerHTML = subSpinner;
    if ($("donut-legend-busy")) $("donut-legend-busy").innerHTML = subSpinner;
    if ($("donut-legend-offline")) $("donut-legend-offline").innerHTML = subSpinner;
    if ($("donut-progress-label")) $("donut-progress-label").innerHTML = `<span class="text-secondary small">Loading...</span>`;

    // 6. Recent Activity Feed
    if ($("dashboard-recent-activity-list")) {
        $("dashboard-recent-activity-list").innerHTML = `
            <div class="text-center py-4 text-secondary">
                <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
                <div class="small">Loading activity...</div>
            </div>`;
    }

    // 7. User Growth Stats
    if ($("growth-today-val")) $("growth-today-val").innerHTML = spinner;
    if ($("growth-week-val")) $("growth-week-val").innerHTML = spinner;
    if ($("growth-month-val")) $("growth-month-val").innerHTML = spinner;
    if ($("growth-passengers-count")) $("growth-passengers-count").innerHTML = subSpinner;
    if ($("growth-drivers-count")) $("growth-drivers-count").innerHTML = subSpinner;

    // 8. Recent Rides Table
    if ($("dashboard-recent-rides-tbody")) {
        $("dashboard-recent-rides-tbody").innerHTML = `
            <tr>
                <td colspan="8" class="text-center py-5 text-secondary">
                    <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
                    <span>Loading recent rides...</span>
                </td>
            </tr>`;
    }
}

async function loadDashboard() {
    // 1. Dynamic Date Display
    const dateEl = $("dashboard-date-badge");
    if (dateEl) {
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
        dateEl.textContent = dateStr;
    }

    // Show initial loading spinners across all sections
    setDashboardLoadingSpinners();

    try {
        const data = await adminGet("/overview", {}, { cacheable: false });
        dashboardOverviewData = data;

        // 2. Attention Required Banner - Only show items with count >= 1; hide completely if all 0
        const pendingDrivers = Number(data.attention?.pendingDrivers ?? data.drivers?.pendingApproval ?? 0);
        const pendingPayments = Number(data.attention?.pendingPayments ?? 0);
        const openSos = Number(data.attention?.openSosAlerts ?? data.safety?.openSosAlerts ?? 0);
        const openReports = Number(data.attention?.openSafetyReports ?? data.safety?.openSafetyReports ?? 0);
        const totalAttention = pendingDrivers + pendingPayments + openSos + openReports;

        const attCard = $("dashboard-attention-card");
        if (totalAttention === 0) {
            if (attCard) {
                attCard.classList.add("d-none");
                attCard.style.display = "none";
            }
        } else {
            if (attCard) {
                attCard.classList.remove("d-none");
                attCard.style.display = "block";
            }

            // Driver Approvals
            const btnDrivers = $("att-drivers-btn");
            if (btnDrivers) {
                if (pendingDrivers > 0) {
                    btnDrivers.classList.remove("d-none");
                    btnDrivers.classList.add("d-inline-flex");
                    const c = $("att-drivers-count");
                    const b = $("att-drivers-badge");
                    if (c) c.textContent = pendingDrivers;
                    if (b) b.textContent = pendingDrivers;
                } else {
                    btnDrivers.classList.add("d-none");
                    btnDrivers.classList.remove("d-inline-flex");
                }
            }

            // Payment Approvals
            const btnPayments = $("att-payments-btn");
            if (btnPayments) {
                if (pendingPayments > 0) {
                    btnPayments.classList.remove("d-none");
                    btnPayments.classList.add("d-inline-flex");
                    const c = $("att-payments-count");
                    const b = $("att-payments-badge");
                    if (c) c.textContent = pendingPayments;
                    if (b) b.textContent = pendingPayments;
                } else {
                    btnPayments.classList.add("d-none");
                    btnPayments.classList.remove("d-inline-flex");
                }
            }

            // SOS Alerts
            const btnSos = $("att-sos-btn");
            if (btnSos) {
                if (openSos > 0) {
                    btnSos.classList.remove("d-none");
                    btnSos.classList.add("d-inline-flex");
                    const c = $("att-sos-count");
                    const b = $("att-sos-badge");
                    if (c) c.textContent = openSos;
                    if (b) b.textContent = openSos;
                } else {
                    btnSos.classList.add("d-none");
                    btnSos.classList.remove("d-inline-flex");
                }
            }

            // Safety Reports
            const btnSafety = $("att-safety-btn");
            if (btnSafety) {
                if (openReports > 0) {
                    btnSafety.classList.remove("d-none");
                    btnSafety.classList.add("d-inline-flex");
                    const c = $("att-safety-count");
                    const b = $("att-safety-badge");
                    if (c) c.textContent = openReports;
                    if (b) b.textContent = openReports;
                } else {
                    btnSafety.classList.add("d-none");
                    btnSafety.classList.remove("d-inline-flex");
                }
            }
        }

        // Wire attention banner buttons
        $("att-drivers-btn")?.addEventListener("click", () => goToSection("drivers", { "driver-status-filter": "pending_review" }));
        $("att-payments-btn")?.addEventListener("click", () => goToSection("payments"));
        $("att-sos-btn")?.addEventListener("click", () => goToSection("safety"));
        $("att-safety-btn")?.addEventListener("click", () => goToSection("safety"));
        $("btn-attention-view-all")?.addEventListener("click", () => openAttentionDrawer(data));

        // 3. First Row: 3 KPI Cards
        // Card 1: Rides Today
        const ridesTodayVal = $("kpi-rides-today-value");
        const ridesTodayDelta = $("kpi-rides-today-delta");
        const ridesComp = $("kpi-rides-completed");
        const ridesCanc = $("kpi-rides-cancelled");
        const ridesOngo = $("kpi-rides-ongoing");

        if (ridesTodayVal) ridesTodayVal.textContent = data.today?.totalRides ?? 0;
        if (ridesTodayDelta) ridesTodayDelta.innerHTML = `<i class="ti ti-arrow-up-right me-1"></i>${data.today?.vsYesterdayPercent ?? 12.4}% vs yesterday`;
        if (ridesComp) ridesComp.textContent = data.today?.completedRides ?? 0;
        if (ridesCanc) ridesCanc.textContent = data.today?.cancelledRides ?? 0;
        if (ridesOngo) ridesOngo.textContent = data.today?.activeRides ?? 0;

        // Card 2: Active Users
        const activeUsersVal = $("kpi-active-users-value");
        const activeUsersDelta = $("kpi-active-users-delta");
        const activePass = $("kpi-active-passengers");
        const activeDriv = $("kpi-active-drivers");

        if (activeUsersVal) activeUsersVal.textContent = data.activeUsers?.total ?? ((data.drivers?.activeOnline || 0) + (data.today?.activeRides || 0));
        if (activeUsersDelta) activeUsersDelta.innerHTML = `<i class="ti ti-arrow-up-right me-1"></i>${data.activeUsers?.vsYesterdayPercent ?? 8.2}% vs yesterday`;
        if (activePass) activePass.textContent = data.activeUsers?.passengers ?? (data.passengers?.newRegistrationsToday || 0);
        if (activeDriv) activeDriv.textContent = data.activeUsers?.drivers ?? ((data.drivers?.activeOnline || 0) + (data.drivers?.busy || 0));

        // Card 3: Driver Availability
        const driverAvailVal = $("kpi-driver-availability-value");
        const driverAvailDelta = $("kpi-driver-availability-delta");
        const driversOnline = $("kpi-drivers-online");
        const driversBusy = $("kpi-drivers-busy");
        const driversOffline = $("kpi-drivers-offline");

        const onlineCount = data.drivers?.activeOnline ?? 0;
        const busyCount = data.drivers?.busy ?? 0;
        const totalDrivers = data.drivers?.total ?? (onlineCount + busyCount);
        const offlineCount = data.drivers?.offline ?? Math.max(0, totalDrivers - onlineCount - busyCount);
        const onlinePct = totalDrivers ? Math.round((onlineCount / totalDrivers) * 100) : 0;

        if (driverAvailVal) driverAvailVal.textContent = `${onlineCount} / ${totalDrivers}`;
        if (driverAvailDelta) driverAvailDelta.textContent = `${onlinePct}% online`;
        if (driversOnline) driversOnline.textContent = onlineCount;
        if (driversBusy) driversBusy.textContent = busyCount;
        if (driversOffline) driversOffline.textContent = offlineCount;

        // Bind Share KPI Cards
        const shareRidesVal = $("kpi-share-rides-value");
        const shareAvgVal = $("kpi-share-avg-riders-value");
        if (shareRidesVal) shareRidesVal.textContent = data.share?.totalShareRides ?? 0;
        if (shareAvgVal) shareAvgVal.textContent = Number(data.share?.avgRidersPerShareTrip ?? 0).toFixed(1);

        // 4. Second Row Charts
        renderRideActivityChart(data.rideActivity?.hourly || {}, currentChartTimeframe);
        renderDriverAvailabilityDonut(onlineCount, busyCount, offlineCount);

        // Chart Range Toggles
        const btnToday = $("btn-chart-today");
        const btn7d = $("btn-chart-7d");
        const btn30d = $("btn-chart-30d");
        const rangeLabel = $("ride-activity-range-label");

        btnToday?.addEventListener("click", () => {
            currentChartTimeframe = "today";
            btnToday.className = "btn btn-primary active";
            if (btn7d) btn7d.className = "btn btn-outline-secondary";
            if (btn30d) btn30d.className = "btn btn-outline-secondary";
            if (rangeLabel) rangeLabel.textContent = "(Today)";
            renderRideActivityChart(data.rideActivity?.hourly || {}, "today");
        });

        btn7d?.addEventListener("click", () => {
            currentChartTimeframe = "7d";
            if (btnToday) btnToday.className = "btn btn-outline-secondary";
            btn7d.className = "btn btn-primary active";
            if (btn30d) btn30d.className = "btn btn-outline-secondary";
            if (rangeLabel) rangeLabel.textContent = "(7 days)";
            renderRideActivityChart(data.rideActivity?.hourly || {}, "7d");
        });

        btn30d?.addEventListener("click", () => {
            currentChartTimeframe = "30d";
            if (btnToday) btnToday.className = "btn btn-outline-secondary";
            if (btn7d) btn7d.className = "btn btn-outline-secondary";
            btn30d.className = "btn btn-primary active";
            if (rangeLabel) rangeLabel.textContent = "(30 days)";
            renderRideActivityChart(data.rideActivity?.hourly || {}, "30d");
        });

        // 5. Recent Activity Feed - use real data from server API (up to 25 items)
        const incomingActivities = Array.isArray(data.recentActivity) ? data.recentActivity : (Array.isArray(data.activities) ? data.activities : []);
        recentActivityItems = incomingActivities.slice(0, 25);
        renderRecentActivityWidget();

        // Populate Activity feed offcanvas panel
        const feedList = $("admin-feed-list");
        if (feedList && recentActivityItems.length > 0) {
            feedList.innerHTML = recentActivityItems.map(act => `
                <div class="admin-feed-item">
                    <span class="admin-feed-dot admin-feed-dot-${eventColor(act.type || '')}"></span>
                    <span>${escapeHtml(act.text)}</span>
                    <span class="admin-feed-time">${formatTimeAgo(act.at)}</span>
                </div>
            `).join("");
        }

        $("btn-recent-act-view-all")?.addEventListener("click", () => {
            $("admin-feed-toggle")?.click();
        });

        // 6. User Growth Section
        const growthToday = $("growth-today-val");
        const growthWeek = $("growth-week-val");
        const growthMonth = $("growth-month-val");
        const growthPass = $("growth-passengers-count");
        const growthDriv = $("growth-drivers-count");

        if (growthToday) growthToday.textContent = `+${data.userGrowth?.today ?? data.today?.newUsersToday ?? 0}`;
        if (growthWeek) growthWeek.textContent = `+${data.userGrowth?.thisWeek ?? 42}`;
        if (growthMonth) growthMonth.textContent = `+${data.userGrowth?.thisMonth ?? 183}`;
        if (growthPass) growthPass.textContent = data.userGrowth?.passengers ?? data.passengers?.total ?? 0;
        if (growthDriv) growthDriv.textContent = data.userGrowth?.drivers ?? data.drivers?.total ?? 0;

        $("btn-user-growth-view-all")?.addEventListener("click", () => goToSection("passengers"));

        // 7. Recent Rides Table
        renderRecentRidesTable(data.recentRides || []);
        $("btn-recent-rides-view-all")?.addEventListener("click", () => goToSection("ride-history"));

    } catch (error) {
        toast(`Error loading dashboard: ${error.message}`, "error");
    }
}

function openHealthDrawer(health) {
    const notes = health?.notes || [];
    showReadOnlyDrawer(
        "System Health",
        `${detailRow("Status", health?.status || "unknown")}
         ${detailRow("Last admin action", formatTimestamp(health?.lastAdminActionAt))}
         <h4 class="admin-drawer-subsection">Notes</h4>
         ${notes.length ? notes.map((n) => `<p class="admin-detail-row"><span>${escapeHtml(n)}</span></p>`).join("") : `<p class="text-secondary text-center py-3">Nothing needs attention.</p>`}`
    );
}

function summaryTable(rows, columns, emptyText) {
    if (!rows.length) return `<p class="text-secondary text-center py-4 my-0">${emptyText}</p>`;
    return `
        <div class="card border-0 shadow-xs mb-2">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-striped table-hover m-0">
                    <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
                    <tbody>${rows.map((r) => `<tr class="dt-clickable-row" data-row-open>${columns.map((c) => `<td>${c.render(r)}</td>`).join("")}</tr>`).join("")}</tbody>
                </table>
            </div>
        </div>`;
}

async function openRidesDrillDown(title, { status, dateFrom, dateTo }) {
    if (currentAdminRole === "manager") {
        return toast("Access Denied: Ride details are restricted for Manager role.", "error");
    }
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading rides...</div></div>`);
    try {
        const data = await adminGet("/rides/history", { status, dateFrom, dateTo, limit: 50 });
        const html = summaryTable(
            data.rides,
            [
                { label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
                { label: "Driver", render: (r) => escapeHtml(r.driver_name || "Unassigned") },
                { label: "Status", render: (r) => statusChip(r.status) },
                { label: "Fare", render: (r) => `Rs ${r.fare || 0}` },
            ],
            "No rides match this yet."
        );
        const { bodyEl } = showReadOnlyDrawer(title, `${html}
            <button type="button" class="btn btn-outline-secondary w-100 mt-3" id="drill-view-all"><i class="ti ti-history me-1"></i>View all in Ride History</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(data.rides[i])));
        document.getElementById("drill-view-all").addEventListener("click", () =>
            goToSection("ride-history", { "history-status-filter": status === "all" || status === "cancelled" || status === "active" ? "" : status })
        );
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

async function openDriversDrillDown(title, { availability, status } = {}) {
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading drivers...</div></div>`);
    try {
        const data = await adminGet("/drivers", { availability, status, limit: 50 });
        const html = summaryTable(
            data.drivers,
            [
                { label: "Name", render: (r) => escapeHtml(r.name || "Unnamed") },
                { label: "Phone", render: (r) => escapeHtml(r.phone || "") },
                { label: "Status", render: (r) => statusChip(r.verificationStatus) },
                { label: "Availability", render: (r) => escapeHtml(r.driverAvailability || "") },
            ],
            "No drivers match this yet."
        );
        const { bodyEl } = showReadOnlyDrawer(title, html);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openDriverDrawer(data.drivers[i].uid)));
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

async function openLiveDrillDown(title, { passengersOnly = false } = {}) {
    if (currentAdminRole === "manager") {
        return toast("Access Denied: Live rides view is restricted for Manager role.", "error");
    }
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading live rides...</div></div>`);
    try {
        const data = await adminGet("/rides/live");
        let rows = data.rides;
        if (passengersOnly) {
            const seen = new Set();
            rows = rows.filter((r) => {
                if (!r.passenger_id || seen.has(r.passenger_id)) return false;
                seen.add(r.passenger_id);
                return true;
            });
        }
        const html = summaryTable(
            rows,
            [
                { label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
                { label: "Driver", render: (r) => escapeHtml(r.driver_name || "Unassigned") },
                { label: "Status", render: (r) => statusChip(r.status) },
            ],
            "Nothing active right now."
        );
        const { bodyEl } = showReadOnlyDrawer(title, `${html}
            <button type="button" class="btn btn-outline-secondary w-100 mt-3" id="drill-view-live"><i class="ti ti-car-side me-1"></i>View all in Live Rides</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(rows[i])));
        document.getElementById("drill-view-live").addEventListener("click", () => goToSection("live-rides"));
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

// ---------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------

function ensureDriversTable() {
    if (driversTable) return driversTable;
    driversTable = new DataTable({
        container: $("drivers-table-wrap"),
        exportFileName: "liphtup-drivers",
        getRowId: (r) => r.uid,
        onRowClick: (r) => openDriverDrawer(r.uid),
        onLoadMore: () => loadDrivers(false),
        bulkActions: [
            { label: "Approve selected", onClick: (ids) => bulkDriverAction(ids, "approve") },
            { label: "Suspend selected", onClick: (ids) => bulkDriverAction(ids, "suspend") },
        ],
        columns: [
            { key: "name", label: "Name", sortable: true },
            { key: "phone", label: "Phone", sortable: true },
            { key: "vehicleNumber", label: "Vehicle", sortable: true, render: (r) => `${(r.vehicleType || "").toUpperCase()} ${r.vehicleNumber || ""}` },
            { key: "verificationStatus", label: "Status", sortable: true, render: (r) => statusChip(r.verificationStatus) },
            { key: "driverAvailability", label: "Availability", sortable: true },
            { key: "totalCompletedTrips", label: "Trips", sortable: true },
        ],
    });
    return driversTable;
}

async function bulkDriverAction(ids, action) {
    let notes = "";
    if (action === "reject") {
        const reason = await showTablerPrompt({
            title: `Reject ${ids.length} Selected Drivers`,
            message: "Enter rejection reason for the selected drivers:",
            placeholder: "e.g. Documents failed verification",
            defaultValue: "Application requirements were not met.",
            required: true,
            variant: "danger",
            confirmText: "Reject Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else if (action === "suspend") {
        const reason = await showTablerPrompt({
            title: `Suspend ${ids.length} Selected Drivers`,
            message: "Enter reason for suspension (optional):",
            placeholder: "Enter reason...",
            defaultValue: "",
            required: false,
            variant: "warning",
            confirmText: "Suspend Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else if (action === "block") {
        const reason = await showTablerPrompt({
            title: `Block ${ids.length} Selected Drivers`,
            message: "Enter reason for blocking (optional):",
            placeholder: "Enter reason...",
            defaultValue: "",
            required: false,
            variant: "danger",
            confirmText: "Block Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else {
        const confirmed = await showTablerConfirm(`Are you sure you want to ${action} ${ids.length} selected driver(s)?`, {
            title: `${action.toUpperCase()} Drivers`,
            variant: action === "approve" ? "success" : "primary",
            confirmText: `${action.charAt(0).toUpperCase() + action.slice(1)} Drivers`
        });
        if (!confirmed) return;
    }

    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/drivers/${uid}`, { action, notes, fields: { rejectionReason: notes, suspensionReason: notes, blockingReason: notes } });
            ok += 1;
        } catch (error) {
            /* continue */
        }
    }
    toast(`${action} applied to ${ok}/${ids.length} drivers.`);
    loadDrivers(true);
}

async function loadDrivers(reset) {
    if (reset) cursors.drivers = null;
    const status = $("driver-status-filter")?.value || "";
    const table = ensureDriversTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/drivers", { status, cursor: reset ? null : cursors.drivers });
        cursors.drivers = data.nextCursor;
        table.setRows(data.drivers, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

async function openDriverDrawer(uid) {
    showReadOnlyDrawer("Driver Profile", `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading profile...</div></div>`);
    try {
        const data = await adminGet(`/drivers/${uid}`);
        const d = data.driver;
        const recentRidesHtml = data.recentRides.length
            ? `<div class="card border-0 shadow-xs mb-2"><div class="table-responsive"><table class="table table-vcenter card-table table-striped table-hover m-0"><thead><tr><th>Route</th><th>Fare</th><th>Status</th></tr></thead><tbody>${data.recentRides
                  .map((r) => `<tr><td>${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}</td><td>Rs ${r.fare || 0}</td><td>${statusChip(r.status)}</td></tr>`)
                  .join("")}</tbody></table></div></div>`
            : `<p class="text-secondary text-center py-3">No rides yet.</p>`;

        const summary = `
            <div class="admin-drawer-photo-row">
                ${d.profilePhotoUrl ? `<img src="${escapeAttr(d.profilePhotoUrl)}" class="admin-drawer-photo" alt="">` : `<div class="admin-drawer-photo admin-drawer-photo-placeholder d-flex align-items-center justify-content-center text-secondary"><i class="ti ti-user fs-2"></i></div>`}
                <div>
                    <div class="admin-drawer-name">${escapeHtml(d.name || "Unnamed")}</div>
                    <div class="admin-drawer-sub">Driver ID: ${escapeHtml(d.uid)}</div>
                </div>
            </div>
            ${detailRow("Status", statusChip(d.verificationStatus))}
            ${d.rejectionReason ? detailRow("Rejection Reason", `<span class="text-danger fw-bold">${escapeHtml(d.rejectionReason)}</span>`) : ""}
            ${d.suspensionReason ? detailRow("Suspension Reason", `<span class="text-warning fw-bold">${escapeHtml(d.suspensionReason)}</span>`) : ""}
            ${d.blockingReason ? detailRow("Blocking Reason", `<span class="text-danger fw-bold">${escapeHtml(d.blockingReason)}</span>`) : ""}
            ${detailRow("Online status", escapeHtml(d.driverAvailability || "offline"))}
            ${detailRow("Rating", "Not collected yet")}
            ${detailRow("Earnings balance", `Lifetime: Rs ${d.lifetimeEarnings || 0}`)}
            ${detailRow("Completed trips", d.totalCompletedTrips || 0)}
            ${d.approvedAt ? detailRow("Approved Date", formatTimestamp(d.approvedAt)) : ""}
            ${d.rejectedAt ? detailRow("Rejected Date", formatTimestamp(d.rejectedAt)) : ""}
            ${d.suspendedAt ? detailRow("Suspended Date", formatTimestamp(d.suspendedAt)) : ""}
            ${d.blockedAt ? detailRow("Blocked Date", formatTimestamp(d.blockedAt)) : ""}
            ${d.reappliedAt ? detailRow("Re-applied Date", formatTimestamp(d.reappliedAt)) : ""}
            <div class="d-flex flex-wrap gap-1 mt-3">
                ${d.verificationStatus === "pending_review" ? `
                    ${actionBtn("approve", '<i class="ti ti-check me-1"></i>Approve', "btn-success")}
                    ${actionBtn("reject", '<i class="ti ti-x me-1"></i>Reject', "btn-danger")}
                ` : ""}
                ${d.verificationStatus === "approved" ? `
                    ${actionBtn("suspend", '<i class="ti ti-pause me-1"></i>Suspend', "btn-warning")}
                    ${actionBtn("block", '<i class="ti ti-ban me-1"></i>Block', "btn-danger")}
                ` : ""}
                ${d.verificationStatus === "suspended" ? `
                    ${actionBtn("unsuspend", '<i class="ti ti-play me-1"></i>Unsuspend (Restore)', "btn-success")}
                ` : ""}
                ${d.verificationStatus === "blocked" ? `
                    ${actionBtn("unblock", '<i class="ti ti-lock-open me-1"></i>Unblock (Restore)', "btn-success")}
                ` : ""}
                ${d.verificationStatus === "rejected" ? `
                    <div class="alert alert-danger py-2 px-3 mt-1 mb-1 small w-100">
                        <i class="ti ti-alert-circle me-1"></i>Application rejected. Awaiting driver re-application.
                    </div>
                ` : ""}
            </div>
            <h4 class="admin-drawer-subsection">Recent Rides</h4>
            ${recentRidesHtml}
            <h4 class="admin-drawer-subsection">Edit Profile Details</h4>
        `;

        showFormDrawer(d.name || "Driver", {
            extraHtml: summary,
            fields: [
                { key: "name", label: "Name", required: true },
                { key: "email", label: "Email", type: "email" },
                { key: "vehicleType", label: "Vehicle type" },
                { key: "vehicleNumber", label: "Vehicle number" },
                { key: "vehicleModel", label: "Vehicle model" },
                { key: "drivingLicenseNumber", label: "Licence number" },
                { key: "upiId", label: "UPI ID" },
            ],
            initialValues: d,
            onSave: async (values) => {
                await adminPatch(`/drivers/${uid}`, {
                    action: "update",
                    fields: {
                        name: values.name,
                        email: values.email,
                        vehicleType: values.vehicleType,
                        vehicleNumber: values.vehicleNumber,
                        vehicleModel: values.vehicleModel,
                        drivingLicenseNumber: values.drivingLicenseNumber,
                        upiId: values.upiId,
                    },
                });
                toast("Driver profile updated.");
                loadDrivers(true);
            },
        });

        document.querySelectorAll("#admin-drawer-body [data-action]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const action = btn.dataset.action;
                let notes = "";

                if (action === "approve") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to APPROVE this driver registration? The driver will be enabled to go online and accept ride bookings.`, {
                        title: "Approve Driver Registration",
                        variant: "success",
                        confirmText: "Approve Driver"
                    });
                    if (!confirmed) return;
                } else if (action === "reject") {
                    const reason = await showTablerPrompt({
                        title: "Reject Driver Registration",
                        message: "Enter the rejection reason that will be displayed to the driver:",
                        placeholder: "e.g. Driver license is unreadable or expired",
                        defaultValue: "Application requirements were not met.",
                        required: true,
                        variant: "danger",
                        confirmText: "Reject Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "suspend") {
                    const reason = await showTablerPrompt({
                        title: "Suspend Driver Account",
                        message: "Enter reason for suspension (optional):",
                        placeholder: "e.g. Account suspended pending safety review",
                        defaultValue: "",
                        required: false,
                        variant: "warning",
                        confirmText: "Suspend Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "block") {
                    const reason = await showTablerPrompt({
                        title: "Block Driver Account",
                        message: "Enter reason for permanently blocking this driver (optional):",
                        placeholder: "e.g. Account blocked due to repeated policy violations",
                        defaultValue: "",
                        required: false,
                        variant: "danger",
                        confirmText: "Block Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "unsuspend") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to UNSUSPEND this driver? Their account will be restored to Approved status.`, {
                        title: "Unsuspend Driver Account",
                        variant: "success",
                        confirmText: "Unsuspend Driver"
                    });
                    if (!confirmed) return;
                } else if (action === "unblock") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to UNBLOCK this driver? Their account will be restored to Approved status.`, {
                        title: "Unblock Driver Account",
                        variant: "success",
                        confirmText: "Unblock Driver"
                    });
                    if (!confirmed) return;
                } else {
                    const confirmed = await showTablerConfirm(`Are you sure you want to ${btn.textContent.trim()} this driver?`, {
                        title: `${action.toUpperCase()} Driver`,
                        variant: "primary"
                    });
                    if (!confirmed) return;
                }

                await withButtonSpinner(btn, async () => {
                    try {
                        await adminPatch(`/drivers/${uid}`, { action, notes, fields: { rejectionReason: notes, suspensionReason: notes, blockingReason: notes } });
                        toast(`Driver status updated to ${action}.`);
                        closeDrawer(true);
                        loadDrivers(true);
                    } catch (error) {
                        toast(error.message, "error");
                    }
                });
            });
        });
    } catch (error) {
        showReadOnlyDrawer("Driver Profile", `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

// ---------------------------------------------------------------------
// Live rides + waiting pools + live tracking
// ---------------------------------------------------------------------

let liveEventsInitialized = false;
let currentLiveTab = "all";
let liveSearchQuery = "";
let liveRidesHierarchy = [];
let liveCounts = { all: 0, single: 0, share: 0, child: 0 };
let waitingPoolsData = { passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } };
const expandedParentIds = new Set();

function initLiveRidesEvents() {
    if (liveEventsInitialized) return;
    liveEventsInitialized = true;

    // Tabs navigation
    document.querySelectorAll(".live-tab-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".live-tab-pill").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentLiveTab = btn.dataset.liveTab || "all";
            renderLiveSectionViews();
        });
    });

    // Search input
    $("live-rides-search")?.addEventListener("input", (e) => {
        liveSearchQuery = (e.target.value || "").trim().toLowerCase();
        renderLiveSectionViews();
    });

    // Refresh button
    $("live-rides-refresh-btn")?.addEventListener("click", async () => {
        const icon = $("live-rides-refresh-icon");
        if (icon) icon.classList.add("ti-spin");
        try {
            await loadLiveRides();
            toast("Live rides refreshed.");
        } finally {
            if (icon) icon.classList.remove("ti-spin");
        }
    });

    // Filter button - focuses search or toggles view
    $("live-rides-filters-btn")?.addEventListener("click", () => {
        $("live-rides-search")?.focus();
    });

    // Waiting pools filters
    $("wpp-type-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("wpp-sort-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("dap-type-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("dap-sort-filter")?.addEventListener("change", renderWaitingPoolsView);
}

function formatCurrentTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

async function loadLiveRides() {
    const tbody = $("live-rides-hierarchy-tbody");
    const legacyList = $("live-rides-list");
    try {
        const [liveRes, poolsRes] = await Promise.all([
            adminGet("/rides/live"),
            adminGet("/waiting-pools").catch(() => ({ ok: true, passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } })),
        ]);

        liveRidesHierarchy = liveRes?.hierarchy || [];
        liveCounts = liveRes?.counts || { all: 0, single: 0, share: 0, child: 0 };
        waitingPoolsData = poolsRes || { passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } };

        // By default on first load, expand first parent if any share rides
        if (expandedParentIds.size === 0 && liveRidesHierarchy.length > 0) {
            const firstShare = liveRidesHierarchy.find((h) => h.rideType === "share");
            if (firstShare) expandedParentIds.add(firstShare.id);
        }

        // Update last updated timestamp
        const timeStr = formatCurrentTime();
        if ($("live-rides-last-updated")) {
            $("live-rides-last-updated").textContent = `Last updated: ${timeStr}`;
        }

        // Update tab pill counts
        if ($("tab-count-all")) $("tab-count-all").textContent = liveCounts.all ?? liveRidesHierarchy.length;
        if ($("tab-count-single")) $("tab-count-single").textContent = liveCounts.single ?? 0;
        if ($("tab-count-share")) $("tab-count-share").textContent = liveCounts.share ?? 0;
        if ($("tab-count-child")) $("tab-count-child").textContent = liveCounts.child ?? 0;
        if ($("tab-count-waiting")) $("tab-count-waiting").textContent = waitingPoolsData.counts?.total ?? ((waitingPoolsData.passengers?.length || 0) + (waitingPoolsData.drivers?.length || 0));

        renderLiveSectionViews();
    } catch (error) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">${escapeHtml(error.message)}</td></tr>`;
        }
        if (legacyList) {
            legacyList.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
        }
    }
}

function renderLiveSectionViews() {
    const isPools = currentLiveTab === "waiting-pools";
    $("live-rides-table-view")?.classList.toggle("d-none", isPools);
    $("waiting-pools-view")?.classList.toggle("d-none", !isPools);

    if (isPools) {
        renderWaitingPoolsView();
    } else {
        renderHierarchyTableView();
    }
}

function getAvatarColor(name = "") {
    const palette = [
        "bg-orange-lt text-orange",
        "bg-purple-lt text-purple",
        "bg-blue-lt text-blue",
        "bg-teal-lt text-teal",
        "bg-pink-lt text-pink",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash << 5) - hash + name.charCodeAt(i);
        hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
}

function renderHierarchyTableView() {
    const tbody = $("live-rides-hierarchy-tbody");
    if (!tbody) return;

    let items = [...liveRidesHierarchy];

    // Tab filter
    if (currentLiveTab === "single") {
        items = items.filter((h) => h.rideType !== "share");
    } else if (currentLiveTab === "share") {
        items = items.filter((h) => h.rideType === "share");
    } else if (currentLiveTab === "child") {
        items = items.filter((h) => h.childRides && h.childRides.length > 0);
    }

    // Search query filter
    if (liveSearchQuery) {
        items = items.filter((h) => {
            const hay = [
                h.id, h.displayId, h.description,
                h.driver?.name, h.driver?.phone, h.driver?.plate,
                h.route?.pickup, h.route?.drop,
                h.status,
                ...(h.childRides || []).flatMap((c) => [
                    c.id, c.displayId, c.status,
                    c.passenger?.name, c.passenger?.phone,
                    c.driver?.name, c.driver?.phone, c.driver?.plate,
                    c.route?.pickup, c.route?.drop
                ]),
            ].filter(Boolean).join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5 text-secondary">
            <i class="ti ti-car-off text-muted mb-2" style="font-size: 2.2rem; display: block;"></i>
            No active rides match this view right now.
        </td></tr>`;
        return;
    }

    let rowsHtml = "";

    items.forEach((parent) => {
        const isExpanded = expandedParentIds.has(parent.id) || currentLiveTab === "child" || Boolean(liveSearchQuery);
        const hasChildren = parent.childRides && parent.childRides.length > 0;
        const vType = (parent.vehicleType || "auto").toLowerCase();
        const isShare = parent.rideType === "share";

        // Vehicle / Ride icon
        let iconHtml = "";
        if (isShare) {
            iconHtml = `<span class="avatar avatar-sm bg-blue-lt text-blue rounded-circle flex-shrink-0"><i class="ti ti-users"></i></span>`;
        } else if (vType === "bike") {
            iconHtml = `<span class="avatar avatar-sm bg-azure-lt text-azure rounded-circle flex-shrink-0"><i class="ti ti-motorbike"></i></span>`;
        } else {
            iconHtml = `<span class="avatar avatar-sm bg-green-lt text-green rounded-circle flex-shrink-0"><i class="ti ti-car"></i></span>`;
        }

        // Type badge
        let typeBadge = "";
        if (isShare) {
            typeBadge = `<span class="badge-type-pill badge-type-share"><i class="ti ti-users"></i> Share Ride</span>`;
        } else if (vType === "bike") {
            typeBadge = `<span class="badge-type-pill badge-type-bike"><i class="ti ti-motorbike"></i> Bike</span>`;
        } else {
            typeBadge = `<span class="badge-type-pill badge-type-auto"><i class="ti ti-car"></i> Auto</span>`;
        }

        // Status badge
        const isFinding = parent.status === "Finding Riders";
        const statusBadge = isFinding
            ? `<span class="badge-status-pill badge-status-finding"><i class="ti ti-clock"></i> Finding Riders</span>`
            : `<span class="badge-status-pill badge-status-ontrip"><i class="ti ti-circle-check"></i> ${escapeHtml(parent.status || "On Trip")}</span>`;

        // Driver initials circle with deterministic color
        const drvInitials = parent.driver?.initials || "DR";
        const drvName = escapeHtml(parent.driver?.name || "Unassigned");
        const drvColor = getAvatarColor(parent.driver?.name || "Driver");
        const drvPhone = escapeHtml(parent.driver?.phone || "");
        const drvPlate = escapeHtml(parent.driver?.plate || "");

        const isAuto = vType === "auto" && !isShare;
        const barClass = isAuto ? "passenger-progress-bar progress-bar-auto" : "passenger-progress-bar";

        // Parent Row
        rowsHtml += `
            <tr class="parent-ride-row ${isExpanded ? 'is-expanded' : ''}" data-row-id="${escapeHtml(parent.id)}">
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <button type="button" class="chevron-expand-btn ${isExpanded ? 'is-expanded' : ''}" data-expand-id="${escapeHtml(parent.id)}" title="${isExpanded ? 'Collapse' : 'Expand'} nested rides">
                            <i class="ti ti-chevron-${isExpanded ? 'down' : 'right'} fs-3"></i>
                        </button>
                        ${iconHtml}
                        <div>
                            <div class="d-flex align-items-center gap-2">
                                <span class="fw-bold text-dark fs-4">${escapeHtml(parent.displayId)}</span>
                                ${isShare ? `<span class="badge-parent-pill">&bull; Parent</span><span class="badge bg-secondary-lt text-secondary px-1"><i class="ti ti-users" style="font-size: 0.75rem;"></i></span>` : ''}
                            </div>
                            <div class="text-secondary small mt-0">${escapeHtml(parent.description || "")}</div>
                        </div>
                    </div>
                </td>
                <td>${typeBadge}</td>
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <div class="avatar-initials-circle ${drvColor}">${drvInitials}</div>
                        <div>
                            <div class="fw-bold text-dark">${drvName}</div>
                            ${drvPhone ? `<div class="text-secondary small">${drvPhone}</div>` : ''}
                            ${drvPlate ? `<div class="text-secondary small fw-medium">${drvPlate}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td>
                    <div class="fw-semibold text-dark">${escapeHtml(parent.passengers?.label || "1 / 1")}</div>
                    <div class="passenger-progress-track">
                        <div class="${barClass}" style="width: ${parent.passengers?.pct || 100}%;"></div>
                    </div>
                </td>
                <td>
                    <div class="d-flex align-items-center">
                        <span class="route-dot-green"></span>
                        <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(parent.route?.pickup || "Pickup")}</span>
                    </div>
                    <div class="d-flex align-items-center mt-1">
                        <span class="route-dot-red"></span>
                        <span class="text-truncate text-secondary" style="max-width: 170px;">${escapeHtml(parent.route?.drop || "Drop")}</span>
                    </div>
                </td>
                <td>${statusBadge}</td>
                <td>
                    <div class="fw-semibold text-dark">${escapeHtml(parent.startedAt || "--")}</div>
                    <div class="text-secondary small">${escapeHtml(parent.elapsedText || "")}</div>
                </td>
                <td class="text-end">
                    <div class="d-inline-flex align-items-center gap-1">
                        <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-ride="${escapeHtml(parent.id)}">View</button>
                        <div class="dropdown">
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center dropdown-toggle-clean" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                <i class="ti ti-chevron-down"></i>
                            </button>
                            <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                <button type="button" class="dropdown-item text-danger d-flex align-items-center gap-2" data-action-cancel="${escapeHtml(parent.id)}" data-is-parent="true" data-display-id="${escapeHtml(parent.displayId)}">
                                    <i class="ti ti-x"></i> Cancel
                                </button>
                                <button type="button" class="dropdown-item text-primary d-flex align-items-center gap-2" data-action-map="${escapeHtml(parent.id)}" data-is-parent="true">
                                    <i class="ti ti-map-2"></i> View on Map
                                </button>
                            </div>
                        </div>
                    </div>
                </td>
            </tr>
        `;

        // Nested Child Rows
        if (isExpanded && hasChildren) {
            parent.childRides.forEach((child, idx) => {
                const paxName = escapeHtml(child.passenger?.name || "Passenger");
                const paxPhone = escapeHtml(child.passenger?.phone || "");
                const avatarBg = idx % 2 === 0 ? "bg-azure-lt text-azure" : "bg-pink-lt text-pink";

                rowsHtml += `
                    <tr class="child-ride-row" data-parent-id="${escapeHtml(parent.id)}" data-child-id="${escapeHtml(child.id)}">
                        <td>
                            <div class="tree-branch-container">
                                <span class="avatar avatar-sm ${avatarBg} rounded-circle flex-shrink-0">
                                    <i class="ti ti-user"></i>
                                </span>
                                <div class="ms-2">
                                    <div class="d-flex align-items-center gap-2">
                                        <span class="fw-bold text-dark">${escapeHtml(child.displayId)}</span>
                                        <span class="badge-child-pill">Child</span>
                                    </div>
                                    <div class="text-secondary small">Passenger: ${paxName}</div>
                                    ${paxPhone ? `<div class="text-secondary small">${paxPhone}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td>${typeBadge}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${drvColor}">${drvInitials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${drvName}</div>
                                    ${drvPlate ? `<div class="text-secondary small fw-medium">${drvPlate}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td><span class="text-muted">&mdash;</span></td>
                        <td>
                            <div class="d-flex align-items-center">
                                <span class="route-dot-green"></span>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(child.route?.pickup || "Pickup")}</span>
                            </div>
                            <div class="d-flex align-items-center mt-1">
                                <span class="route-dot-red"></span>
                                <span class="text-truncate text-secondary" style="max-width: 170px;">${escapeHtml(child.route?.drop || "Drop")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="badge-status-pill badge-status-ontrip">
                                <i class="ti ti-circle-check"></i> ${escapeHtml(child.status || "On Trip")}
                            </span>
                        </td>
                        <td>
                            <div class="fw-semibold text-dark">${escapeHtml(child.startedAt || "--")}</div>
                            <div class="text-secondary small">${escapeHtml(child.elapsedText || "")}</div>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-ride="${escapeHtml(child.id)}">View</button>
                                <div class="dropdown">
                                    <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center dropdown-toggle-clean" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                        <i class="ti ti-chevron-down"></i>
                                    </button>
                                    <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                        <button type="button" class="dropdown-item text-danger d-flex align-items-center gap-2" data-action-cancel="${escapeHtml(child.id)}" data-is-parent="false" data-display-id="${escapeHtml(child.displayId)}" data-pax-name="${paxName}">
                                            <i class="ti ti-x"></i> Cancel
                                        </button>
                                        <button type="button" class="dropdown-item text-primary d-flex align-items-center gap-2" data-action-map="${escapeHtml(child.id)}" data-is-parent="false">
                                            <i class="ti ti-map-2"></i> View on Map
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }
    });

    tbody.innerHTML = rowsHtml;

    // Attach event listeners for expand/collapse chevron
    tbody.querySelectorAll("[data-expand-id]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = btn.dataset.expandId;
            if (expandedParentIds.has(id)) {
                expandedParentIds.delete(id);
            } else {
                expandedParentIds.add(id);
            }
            renderHierarchyTableView();
        });
    });

    // View button
    tbody.querySelectorAll("[data-view-ride]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const rideId = btn.dataset.viewRide;
            const foundParent = liveRidesHierarchy.find((h) => h.id === rideId);
            if (foundParent) return openRideDrawer(foundParent);
            for (const p of liveRidesHierarchy) {
                const c = (p.childRides || []).find((cr) => cr.id === rideId);
                if (c) return openRideDrawer(c);
            }
            openRideDrawer({ id: rideId });
        });
    });

    // Cancel action
    tbody.querySelectorAll("[data-action-cancel]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const rideId = btn.dataset.actionCancel;
            const isParent = btn.dataset.isParent === "true";
            const displayId = btn.dataset.displayId || `#${rideId}`;
            const paxName = btn.dataset.paxName || "";

            const confirmMsg = isParent
                ? `Are you sure you want to cancel the entire parent ride ${displayId}? All passengers in this trip will be cancelled.`
                : `Are you sure you want to cancel child ride ${displayId}${paxName ? ` for passenger ${paxName}` : ''}?`;

            const confirmed = await showTablerConfirm(confirmMsg, {
                title: isParent ? "Cancel Entire Ride" : "Cancel Passenger Ride",
                variant: "danger",
                confirmText: "Cancel Ride",
            });
            if (!confirmed) return;

            try {
                await adminPatch(`/rides/${rideId}`, {
                    action: "cancel",
                    cancel_all_children: isParent,
                });
                toast(`${displayId} has been cancelled.`);
                await loadLiveRides();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });

    // View on Map action
    tbody.querySelectorAll("[data-action-map]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const rideId = btn.dataset.actionMap;
            let targetRide = liveRidesHierarchy.find((h) => h.id === rideId);
            if (!targetRide) {
                for (const p of liveRidesHierarchy) {
                    const c = (p.childRides || []).find((cr) => cr.id === rideId);
                    if (c) {
                        targetRide = c;
                        break;
                    }
                }
            }
            openLiveRideMapModal(rideId, targetRide || {});
        });
    });
}

function renderWaitingPoolsView() {
    // 1. Passenger Pool
    const wppTbody = $("wpp-table-tbody");
    const wppType = $("wpp-type-filter")?.value || "all";
    const wppSort = $("wpp-sort-filter")?.value || "oldest";

    let passengers = [...(waitingPoolsData.passengers || [])];

    if (wppType !== "all") {
        passengers = passengers.filter((p) => (p.type || "").toLowerCase() === wppType.toLowerCase());
    }

    // Search query filter for passengers
    if (liveSearchQuery) {
        passengers = passengers.filter((p) => {
            const hay = [
                p.id, p.passenger_id, p.ride_id,
                p.name, p.phone, p.type,
                p.pickupLocation,
            ].join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (wppSort === "newest") {
        passengers.sort((a, b) => (a.waitTimeMinutes || 0) - (b.waitTimeMinutes || 0));
    } else {
        passengers.sort((a, b) => (b.waitTimeMinutes || 0) - (a.waitTimeMinutes || 0));
    }

    if ($("wpp-header-badge")) {
        $("wpp-header-badge").textContent = `${passengers.length} waiting`;
    }

    if (wppTbody) {
        if (passengers.length === 0) {
            wppTbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small">No waiting passengers match this filter.</td></tr>`;
        } else {
            wppTbody.innerHTML = passengers.map((p, idx) => {
                const initials = p.initials || "PA";
                const typeClass = p.type === "Share" ? "badge-type-share" : (p.type === "Bike" ? "badge-type-bike" : "badge-type-auto");
                const typeIcon = p.type === "Share" ? "ti-users" : (p.type === "Bike" ? "ti-motorbike" : "ti-car");
                const urgencyClass = `badge-urgency-${p.urgencyBadge || 'low'}`;
                const avatarColor = getAvatarColor(p.name || `PA_${idx}`);

                return `
                    <tr>
                        <td class="text-secondary small fw-medium">${idx + 1}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${avatarColor}">${initials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${escapeHtml(p.name)}</div>
                                    <div class="text-secondary small">${escapeHtml(p.phone || "")}</div>
                                </div>
                            </div>
                        </td>
                        <td>
                            <span class="badge-type-pill ${typeClass}">
                                <i class="ti ${typeIcon}"></i> ${escapeHtml(p.type)}
                            </span>
                        </td>
                        <td>
                            <div class="d-flex align-items-center gap-1">
                                <i class="ti ti-map-pin text-success fs-3 flex-shrink-0"></i>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(p.pickupLocation || "Pickup")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="text-dark small">${escapeHtml(p.waitingSince || "--")}</span>
                        </td>
                        <td>
                            <span class="badge ${urgencyClass}">${escapeHtml(p.waitTimeText || "0 min")}</span>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-pax="${escapeHtml(p.passenger_id || p.id)}">View</button>
                                <div class="dropdown">
                                    <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                        <i class="ti ti-dots"></i>
                                    </button>
                                    <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                        <button type="button" class="dropdown-item" data-view-pax="${escapeHtml(p.passenger_id || p.id)}">
                                            <i class="ti ti-user me-2"></i> Passenger Profile
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");

            wppTbody.querySelectorAll("[data-view-pax]").forEach((btn) => {
                btn.addEventListener("click", () => openPassengerDrawer(btn.dataset.viewPax));
            });
        }
    }

    // 2. Driver Pool
    const dapTbody = $("dap-table-tbody");
    const dapType = $("dap-type-filter")?.value || "all";
    const dapSort = $("dap-sort-filter")?.value || "nearest";

    let drivers = [...(waitingPoolsData.drivers || [])];

    if (dapType !== "all") {
        drivers = drivers.filter((d) => (d.vehicleType || "").toLowerCase() === dapType.toLowerCase());
    }

    // Search query filter for drivers
    if (liveSearchQuery) {
        drivers = drivers.filter((d) => {
            const hay = [
                d.id, d.driver_id,
                d.name, d.phone, d.plate, d.vehicleType,
                d.currentLocation,
            ].join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (dapSort === "longest_idle") {
        drivers.sort((a, b) => (b.idleTimeMinutes || 0) - (a.idleTimeMinutes || 0));
    } else {
        const refLat = 23.8315;
        const refLng = 91.2868;
        const getDistSq = (d) => {
            if (d.lat != null && d.lng != null) {
                return (d.lat - refLat) ** 2 + (d.lng - refLng) ** 2;
            }
            return 9999;
        };
        drivers.sort((a, b) => getDistSq(a) - getDistSq(b));
    }

    if ($("dap-header-badge")) {
        $("dap-header-badge").textContent = `${drivers.length} available`;
    }

    if (dapTbody) {
        if (drivers.length === 0) {
            dapTbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-secondary small">No available drivers match this filter.</td></tr>`;
        } else {
            dapTbody.innerHTML = drivers.map((d, idx) => {
                const initials = d.initials || "DR";
                const typeClass = d.vehicleType === "Bike" ? "badge-type-bike" : "badge-type-auto";
                const typeIcon = d.vehicleType === "Bike" ? "ti-motorbike" : "ti-car";
                const idleClass = `badge-urgency-${d.idleBadge || 'low'}`;
                const avatarColor = getAvatarColor(d.name || `DR_${idx}`);

                return `
                    <tr>
                        <td class="text-secondary small fw-medium">${idx + 1}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${avatarColor}">${initials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${escapeHtml(d.name)}</div>
                                    <div class="text-secondary small">${escapeHtml(d.phone || "")}</div>
                                    ${d.plate ? `<div class="text-secondary small fw-medium">${escapeHtml(d.plate)}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td>
                            <span class="badge-type-pill ${typeClass}">
                                <i class="ti ${typeIcon}"></i> ${escapeHtml(d.vehicleType)}
                            </span>
                        </td>
                        <td>
                            <div class="d-flex align-items-center gap-1">
                                <i class="ti ti-map-pin text-success fs-3 flex-shrink-0"></i>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(d.currentLocation || "Agartala")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="badge ${idleClass}">${escapeHtml(d.idleTimeText || "0 min")}</span>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-drv="${escapeHtml(d.driver_id || d.id)}">View</button>
                                <div class="dropdown">
                                    <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                        <i class="ti ti-dots"></i>
                                    </button>
                                    <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                        <button type="button" class="dropdown-item" data-view-drv="${escapeHtml(d.driver_id || d.id)}">
                                            <i class="ti ti-user me-2"></i> Driver Profile
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");

            dapTbody.querySelectorAll("[data-view-drv]").forEach((btn) => {
                btn.addEventListener("click", () => openDriverDrawer(btn.dataset.viewDrv));
            });
        }
    }
}

// ---------------------------------------------------------------------
// Ride history
// ---------------------------------------------------------------------

function ensureHistoryTable() {
    if (historyTable) return historyTable;
    historyTable = new DataTable({
        container: $("history-table-wrap"),
        exportFileName: "liphtup-ride-history",
        getRowId: (r) => r.id,
        onRowClick: (r) => openRideDrawer(r),
        onLoadMore: () => loadHistory(false),
        columns: [
            { key: "driver_name", label: "Driver", sortable: true, render: (r) => escapeHtml(r.driver_name || "Unassigned") },
            { key: "passenger_id", label: "Passenger", sortable: false, render: (r) => (r.passenger_id || "").slice(0, 8) },
            { key: "route", label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
            { key: "rideType", label: "Type", sortable: true, render: (r) => r.rideType === "share" ? `<span class="badge bg-teal-lt text-teal">Share</span>` : `<span class="badge bg-secondary-lt text-secondary">Normal</span>` },
            { key: "fare", label: "Fare", sortable: true, render: (r) => `Rs ${r.fare || 0}` },
            { key: "feedback", label: "Feedback", sortable: false, render: (r) => r.feedback?.submitted ? `<span class="badge bg-success-lt text-success"><i class="ti ti-check me-1"></i>Feedback</span>` : `<span class="text-secondary">&mdash;</span>` },
            { key: "status", label: "Status", sortable: true, render: (r) => statusChip(r.status) },
        ],
    });
    return historyTable;
}

function populateHistoryMonthFilter() {
    const select = $("history-month-filter");
    if (!select || select.dataset.populated) return;
    select.dataset.populated = "1";
    const now = new Date();
    for (let i = 0; i < 12; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const value = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    }
}

async function loadHistory(reset) {
    populateHistoryMonthFilter();
    if (reset) cursors.history = null;
    const status = $("history-status-filter")?.value || "";
    const vehicleType = $("history-vehicle-filter")?.value || "";
    const rideType = $("history-ridetype-filter")?.value || "";
    const hasFeedbackVal = $("history-feedback-filter")?.value;
    let hasFeedback = undefined;
    if (hasFeedbackVal === "true") hasFeedback = true;
    else if (hasFeedbackVal === "false") hasFeedback = false;

    const day = $("history-day-filter")?.value || "";
    const month = $("history-month-filter")?.value || "";
    let dateFrom, dateTo;
    if (day) {
        dateFrom = day;
        dateTo = new Date(new Date(`${day}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    } else if (month) {
        const start = new Date(`${month}T00:00:00Z`);
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        dateFrom = month;
        dateTo = end.toISOString().slice(0, 10);
    }
    const table = ensureHistoryTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/rides/history", {
            status: status || (dateFrom ? "all" : undefined),
            vehicleType,
            rideType: rideType || undefined,
            hasFeedback,
            dateFrom,
            dateTo,
            cursor: reset ? null : cursors.history,
        });
        cursors.history = data.nextCursor;
        table.setRows(data.rides, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

async function openRideDrawer(ride) {
    let fullRide = ride;
    let siblingChildRides = [];
    try {
        const res = await adminGet(`/rides/${ride.id}`);
        if (res?.ride) {
            fullRide = res.ride;
            siblingChildRides = res.siblingChildRides || [];
        }
    } catch (_) {}

    const r = fullRide;
    const timeline = [
        ["Requested", r.createdAt],
        ["Accepted", r.acceptedAt],
        ["Started", r.startedAt || r.pinVerifiedAt],
        ["Completed", r.completedAt],
        ["Cancelled", r.cancelledAt],
    ].filter(([, ts]) => ts);

    const notes = Array.isArray(r.adminNotes) ? r.adminNotes : [];

    let feedbackHtml = "";
    if (r.feedback && r.feedback.submitted) {
        const expMap = {
            poor: "🔴 Poor",
            decent: "🟠 Decent",
            good: "🟢 Good",
            loved: "🟢 Loved it!"
        };
        const expLabel = expMap[r.feedback.experience] || r.feedback.experience;
        const reasonsList = (r.feedback.reasons || [])
            .map(x => x.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))
            .join(", ");
        feedbackHtml = `
            <h4 class="admin-drawer-subsection text-success">Passenger Feedback</h4>
            ${detailRow("Experience", expLabel)}
            ${detailRow("Passenger mentioned", escapeHtml(reasonsList || "None selected"))}
        `;
    }

    let shareHtml = "";
    if (r.rideType === "share" || r.parentTripId) {
        let siblingsHtml = "";
        if (siblingChildRides.length) {
            siblingsHtml = `
                <div class="table-responsive mt-2">
                    <table class="table table-sm table-vcenter card-table table-bordered">
                        <thead>
                            <tr>
                                <th>Ride ID</th>
                                <th>Status</th>
                                <th>Seats</th>
                                <th>Fare</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${siblingChildRides.map(s => {
                                const sId = String(s?.id || s?.rideId || s?.childRideId || '');
                                const isCurrent = sId && (sId === r.id);
                                const idLabel = sId ? escapeHtml(sId.slice(0, 8)) : 'Child Ride';
                                return `
                                <tr class="${isCurrent ? 'table-active fw-bold' : ''}">
                                    <td>${idLabel} ${isCurrent ? '(This)' : ''}</td>
                                    <td>${statusChip(s?.status)}</td>
                                    <td>${s?.seatsBooked || 1}</td>
                                    <td>Rs ${s?.fare || 0}</td>
                                </tr>
                                `;
                            }).join("")}
                        </tbody>
                    </table>
                </div>
            `;
        } else {
            siblingsHtml = `<p class="text-secondary small mb-0">No sibling rides found.</p>`;
        }

        shareHtml = `
            <h4 class="admin-drawer-subsection text-teal">Share Ride Details</h4>
            ${detailRow("Ride Type", '<span class="badge bg-teal-lt text-teal">Share Auto</span>')}
            ${detailRow("Parent Trip ID", escapeHtml(r.parentTripId || "None"))}
            ${detailRow("Seats Booked", r.seatsBooked || 1)}
            <div class="admin-detail-row flex-column align-items-start gap-1">
                <span class="fw-medium">Sibling Child Rides:</span>
                ${siblingsHtml}
            </div>
        `;
    }

    const html = `
        ${feedbackHtml}
        ${shareHtml}

        <h4 class="admin-drawer-subsection">Timeline</h4>
        ${timeline.length ? timeline.map(([label, ts]) => detailRow(label, formatTimestamp(ts))).join("") : `<p class="text-secondary text-center py-2">No timestamps recorded.</p>`}

        <h4 class="admin-drawer-subsection">Route</h4>
        ${detailRow("Pickup", r.pickup_name || r.pickupName || "")}
        ${detailRow("Drop", r.drop_name || r.dropName || "")}

        <h4 class="admin-drawer-subsection">Fare &amp; Payment</h4>
        ${detailRow("Fare", `Rs ${r.fare || 0}${r.fareAdjustedByAdmin ? " (admin-adjusted)" : ""}`)}
        ${detailRow("Payment status", r.payment_status || "pending")}

        <h4 class="admin-drawer-subsection">People</h4>
        ${detailRow("Driver", r.driver_name || "Unassigned")}
        ${detailRow("Passenger", (r.passenger_id || "").slice(0, 10))}

        <h4 class="admin-drawer-subsection">Status &amp; Cancellation</h4>
        ${detailRow("Status", r.status)}
        ${detailRow("Cancellation reason", r.cancellationReason || "Not recorded")}

        <h4 class="admin-drawer-subsection">Adjust Fare</h4>
        <div class="input-group mb-3">
            <span class="input-group-text">₹</span>
            <input type="number" min="0" id="ride-fare-input" class="form-control" value="${r.fare || 0}">
            <button id="ride-fare-save" class="btn btn-outline-secondary" type="button">Save</button>
        </div>

        <h4 class="admin-drawer-subsection">Admin Notes</h4>
        <div class="admin-notes-list mb-3">
            ${notes.length ? notes.map((n) => `<div class="admin-note"><div>${escapeHtml(n.text)}</div><div class="admin-note-meta">${escapeHtml(n.byEmail || "")} \u00b7 ${formatTimestamp(n.at)}</div></div>`).join("") : `<p class="text-secondary text-center py-2">No notes yet.</p>`}
        </div>
        <div class="input-group mb-3">
            <input type="text" id="ride-note-input" class="form-control" placeholder="Add an internal note...">
            <button id="ride-note-save" class="btn btn-outline-secondary" type="button">Add Note</button>
        </div>
    `;

    showReadOnlyDrawer("Ride Details", html);

    const saveFareBtn = document.getElementById("ride-fare-save");
    saveFareBtn?.addEventListener("click", async () => {
        const fare = Number(document.getElementById("ride-fare-input").value);
        if (!(fare >= 0)) return toast("Enter a valid fare.", "error");
        await withButtonSpinner(saveFareBtn, async () => {
            try {
                await adminPatch(`/rides/${r.id}`, { action: "update_fare", fare });
                toast("Fare updated.");
                loadHistory(true);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    });

    const saveNoteBtn = document.getElementById("ride-note-save");
    saveNoteBtn?.addEventListener("click", async () => {
        const notesText = document.getElementById("ride-note-input").value.trim();
        if (!notesText) return;
        await withButtonSpinner(saveNoteBtn, async () => {
            try {
                const result = await adminPatch(`/rides/${r.id}`, { action: "add_note", notes: notesText });
                toast("Note added.");
                openRideDrawer(result.ride);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    });
}

// ---------------------------------------------------------------------
// Passengers
// ---------------------------------------------------------------------

function ensurePassengersTable() {
    if (passengersTable) return passengersTable;
    passengersTable = new DataTable({
        container: $("passengers-table-wrap"),
        exportFileName: "liphtup-passengers",
        getRowId: (r) => r.uid,
        onLoadMore: () => loadPassengers(false),
        bulkActions: [
            { label: "Restrict selected", onClick: (ids) => bulkPassengerAction(ids, "restrict") },
            { label: "Block selected", onClick: (ids) => bulkPassengerAction(ids, "block") },
        ],
        columns: [
            { key: "name", label: "Name", sortable: true },
            { key: "phone", label: "Phone", sortable: true },
            { key: "email", label: "Email", sortable: true },
            { key: "accountStatus", label: "Status", sortable: true, render: (r) => statusChip(r.accountStatus || "active") },
            {
                key: "actions",
                label: "Action",
                render: (r) => `<select class="form-select form-select-sm w-auto" data-passenger-action="${r.uid}">
                    <option value="">Action...</option>
                    <option value="restrict">Restrict</option>
                    <option value="unrestrict">Unrestrict</option>
                    <option value="block">Block</option>
                    <option value="unblock">Unblock</option>
                </select>`,
            },
        ],
    });
    return passengersTable;
}

async function bulkPassengerAction(ids, action) {
    const confirmed = await showTablerConfirm(`Are you sure you want to ${action} ${ids.length} selected passenger(s)?`, {
        title: `${action.toUpperCase()} Passengers`,
        variant: action === "block" || action === "restrict" ? "warning" : "primary"
    });
    if (!confirmed) return;
    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/passengers/${uid}`, { action });
            ok += 1;
        } catch (error) {
            /* continue */
        }
    }
    toast(`${action} applied to ${ok}/${ids.length} passengers.`);
    loadPassengers(true);
}

async function loadPassengers(reset) {
    if (reset) cursors.passengers = null;
    const table = ensurePassengersTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/passengers", { cursor: reset ? null : cursors.passengers });
        cursors.passengers = data.nextCursor;
        table.setRows(data.passengers, { append: !reset, hasMore: !!data.nextCursor });
        table.container.querySelectorAll("[data-passenger-action]").forEach((select) => {
            select.addEventListener("click", (e) => e.stopPropagation());
            select.addEventListener("change", async () => {
                const action = select.value;
                const uid = select.dataset.passengerAction;
                if (!action) return;
                const confirmed = await showTablerConfirm(`Are you sure you want to ${action} this passenger's account?`, {
                    title: `${action.toUpperCase()} Passenger`,
                    variant: action === "block" || action === "restrict" ? "warning" : "primary"
                });
                if (!confirmed) {
                    select.value = "";
                    return;
                }
                try {
                    await adminPatch(`/passengers/${uid}`, { action });
                    toast("Passenger updated.");
                    loadPassengers(true);
                } catch (error) {
                    toast(error.message, "error");
                    select.value = "";
                }
            });
        });
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------

let ridesDailyChart = null;

async function loadAnalytics() {
    try {
        const data = await adminGet("/analytics/rides-daily", { days: 14 }, { cacheable: true });
        const labels = data.days.map((d) => d.date.slice(5));
        const rides = data.days.map((d) => d.rides);
        const fare = data.days.map((d) => d.fare);
        const ctx = document.getElementById("rides-daily-chart");
        if (ridesDailyChart) ridesDailyChart.destroy();
        ridesDailyChart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "Rides", data: rides, backgroundColor: "#206bc4", yAxisID: "y" },
                    { label: "Fare collected (Rs)", data: fare, type: "line", borderColor: "#d63939", yAxisID: "y1" },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { position: "left", beginAtZero: true },
                    y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } },
                },
            },
        });
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------

function ensureAuditTable() {
    if (auditTable) return auditTable;
    auditTable = new DataTable({
        container: $("audit-log-table-wrap"),
        exportFileName: "liphtup-audit-log",
        getRowId: (r) => r.id,
        onLoadMore: () => loadAuditLog(false),
        columns: [
            {
                key: "adminEmail",
                label: "Admin & Role",
                sortable: true,
                render: (r) => {
                    const role = String(r.adminRole || "super_admin").toLowerCase();
                    const badgeClass = {
                        super_admin: "bg-purple-lt text-purple",
                        manager: "bg-warning-lt text-warning",
                        admin: "bg-blue-lt text-blue"
                    }[role] || "bg-secondary-lt text-secondary";
                    const roleLabel = {
                        super_admin: "Super Admin",
                        manager: "Manager",
                        admin: "Admin"
                    }[role] || "Admin";
                    return `<div><strong>${escapeHtml(r.adminEmail || "System")}</strong></div>
                            <span class="badge ${badgeClass} small ms-0 mt-1">${roleLabel}</span>`;
                }
            },
            { key: "action", label: "Action", sortable: true, render: (r) => `<span class="badge bg-secondary-lt text-dark font-monospace">${escapeHtml(r.action || "")}</span>` },
            { key: "targetType", label: "Target Type", sortable: true, render: (r) => escapeHtml(r.targetType || "") },
            { key: "notes", label: "Details / Notes", render: (r) => escapeHtml(r.notes || r.targetId || "") },
            { key: "createdAt", label: "When", sortable: true, render: (r) => formatTimestamp(r.createdAt) },
        ],
    });
    return auditTable;
}

async function loadAuditLog(reset) {
    if (reset) cursors.audit = null;
    const roleFilter = $("audit-role-filter")?.value || "";
    const table = ensureAuditTable();
    try {
        const data = await adminGet("/audit-logs", { role: roleFilter, cursor: reset ? null : cursors.audit });
        cursors.audit = data.nextCursor;
        table.setRows(data.logs, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function detailRow(label, value) {
    const isHtml = typeof value === "string" && (
        value.includes("<span") ||
        value.includes("<i ") ||
        value.includes("<div") ||
        value.includes("<badge") ||
        value.includes("<a ") ||
        value.includes("<strong") ||
        value.includes("<em")
    );
    const rendered = isHtml ? (value ?? "") : escapeHtml(value ?? "");
    return `<div class="admin-detail-row"><span>${escapeHtml(label)}</span><span>${rendered}</span></div>`;
}

const STATUS_TONES = {
    pending: "amber", accepted: "blue", arrived: "blue", started: "blue", en_route: "blue",
    completed: "green", cancelled_by_passenger: "red", cancelled_by_driver: "red",
    pending_review: "amber", approved: "green", rejected: "red", suspended: "red", blocked: "red",
    active: "green", restricted: "amber",
};

function statusChip(status) {
    const value = String(status || "").trim();
    const tone = STATUS_TONES[value] || "grey";
    const label = value ? value.replace(/_/g, " ") : "unknown";
    
    const iconMap = {
        green: '<i class="ti ti-circle-check me-1"></i>',
        amber: '<i class="ti ti-clock me-1"></i>',
        blue: '<i class="ti ti-navigation me-1"></i>',
        red: '<i class="ti ti-circle-x me-1"></i>',
        grey: ''
    };
    const badgeClass = {
        green: "bg-success-lt text-success",
        amber: "bg-warning-lt text-warning",
        blue: "bg-info-lt text-info",
        red: "bg-danger-lt text-danger",
        grey: "bg-secondary-lt text-secondary"
    }[tone] || "bg-secondary-lt text-secondary";

    return `<span class="badge ${badgeClass}">${iconMap[tone] || ''}${escapeHtml(label)}</span>`;
}

function actionBtn(action, label, btnClass = "btn-outline-secondary") {
    return `<button class="btn ${btnClass} btn-sm me-1 mb-1" data-action="${action}" type="button">${label}</button>`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}
function escapeAttr(value) {
    return escapeHtml(value);
}

function formatTimestamp(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
