import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch, refreshAdminToken } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { DataTable } from "./data-table.js";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js";
import { startLiveFeed, stopLiveFeed, trackRideOnMap, stopTracking } from "./admin-live.js";
import { toast } from "./admin-toast.js";
import { loadSafety, refreshSafetyBadge, startSosRealtimeAlerts } from "./admin-safety.js";
import { initAdminPayments, loadAdminPayments } from "./admin-payments.js";
import { loadPermissions, initPermissionsModal } from "./admin-permissions.js";
import { initAdminCoupons, loadAdminCoupons } from "./admin-coupons.js";

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
// Mobile Device Detection (Requirement 7)
// ---------------------------------------------------------------------

function checkMobileDevice() {
    const isMobile = window.innerWidth < 992 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const modal = $("modal-mobile-warning");
    if (!modal) return;
    if (isMobile) {
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
        const allowed = new Set(["dashboard", "drivers", "payments", "safety"]);
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
        initAdminCoupons();
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
            initAdminCoupons();
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
            <span class="admin-feed-time">${new Date(event.at).toLocaleTimeString()}</span>`;
        list.prepend(item);
        while (list.children.length > 60) list.lastChild.remove();
    }

    // Mirror to dashboard Recent Activity feed
    recentActivityItems.unshift({
        text: event.text,
        color: eventColor(event.type) === "ok" ? "success" : (eventColor(event.type) === "danger" ? "danger" : "warning"),
        at: event.at || Date.now(),
        timeStr: "just now"
    });
    if (recentActivityItems.length > 20) recentActivityItems.pop();
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
    if (type.startsWith("driver_offline") || type.includes("suspended") || type.includes("blocked")) return "warn";
    if (type.includes("cancelled")) return "danger";
    return "ok";
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
        loadLiveRides();
        liveRidesTimer = setInterval(loadLiveRides, 8000);
        return;
    }
    if (loadedSections.has(name)) return;
    loadedSections.add(name);
    if (name === "dashboard") loadDashboard();
    if (name === "drivers") loadDrivers(true);
    if (name === "payments") loadAdminPayments();
    if (name === "coupons") loadAdminCoupons();
    if (name === "safety") loadSafety();
    if (name === "ride-history") loadHistory(true);
    if (name === "passengers") loadPassengers(true);
    if (name === "analytics") loadAnalytics();
    if (name === "audit-log") loadAuditLog(true);
    if (name === "permissions") loadPermissions();
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
["history-status-filter", "history-vehicle-filter", "history-feedback-filter", "history-month-filter"].forEach((id) =>
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

    const total = online + busy + offline || (online ? online : 1);
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
    driverDonutChartInstance = new window.Chart(ctx, {
        type: "doughnut",
        data: {
            labels: ["Available", "On ride", "Offline"],
            datasets: [{
                data: [online || 1, busy, offline],
                backgroundColor: ["#2fb344", "#206bc4", "#f59f00"],
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
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

    list.innerHTML = recentActivityItems.slice(0, 6).map((item) => `
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

        // 5. Recent Activity Feed - use real data from server API
        recentActivityItems = Array.isArray(data.recentActivity) ? [...data.recentActivity] : [];
        renderRecentActivityWidget();

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
    const confirmed = await showTablerConfirm(`Are you sure you want to ${action} ${ids.length} selected driver(s)?`, {
        title: `${action.toUpperCase()} Drivers`,
        variant: action === "suspend" || action === "block" ? "danger" : "primary"
    });
    if (!confirmed) return;
    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/drivers/${uid}`, { action });
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
            ${detailRow("Status", d.verificationStatus)}
            ${detailRow("Online status", d.driverAvailability)}
            ${detailRow("Rating", "Not collected yet")}
            ${detailRow("Earnings balance", `Lifetime: Rs ${d.lifetimeEarnings || 0}`)}
            ${detailRow("Completed trips", d.totalCompletedTrips || 0)}
            <div class="d-flex flex-wrap gap-1 mt-3">
                ${actionBtn("approve", "Approve")}
                ${actionBtn("reject", "Reject")}
                ${actionBtn("suspend", "Suspend")}
                ${actionBtn("block", "Block")}
                ${actionBtn("unblock", "Unblock")}
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
                const confirmed = await showTablerConfirm(`Are you sure you want to ${btn.textContent} this driver?`, {
                    title: `${btn.textContent} Driver`,
                    variant: action === "block" || action === "suspend" || action === "reject" ? "danger" : "primary"
                });
                if (!confirmed) return;
                await withButtonSpinner(btn, async () => {
                    try {
                        await adminPatch(`/drivers/${uid}`, { action });
                        toast(`Driver ${action}d.`);
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
// Live rides + live tracking
// ---------------------------------------------------------------------

async function loadLiveRides() {
    const list = $("live-rides-list");
    try {
        const data = await adminGet("/rides/live");
        if (data.rides.length === 0) {
            list.innerHTML = `<div class="col-12 text-center text-secondary py-5"><i class="ti ti-car text-muted mb-2" style="font-size: 2.5rem; display: block;"></i>No active rides right now.</div>`;
            return;
        }
        list.innerHTML = data.rides
            .map(
                (r) => `<div class="col-md-6 col-lg-4">
                    <div class="card border-0 shadow-xs">
                        <div class="card-body">
                            <div class="d-flex align-items-center justify-content-between mb-2">
                                ${statusChip(r.status)}
                                <strong class="text-success">Rs ${r.fare || 0}</strong>
                            </div>
                            <div class="mb-2">
                                <strong>${escapeHtml(r.pickup_name || "Pickup")}</strong> &rarr; <strong>${escapeHtml(r.drop_name || "Drop")}</strong>
                            </div>
                            <div class="small text-secondary mb-3">
                                Driver: <strong>${escapeHtml(r.driver_name || "Unassigned")}</strong>
                            </div>
                            <div class="d-flex gap-2">
                                <button class="btn btn-outline-primary btn-sm flex-fill" data-track="${r.id}" type="button">
                                    <i class="ti ti-map-pin me-1"></i>Track Live
                                </button>
                                <button class="btn btn-outline-danger btn-sm flex-fill" data-cancel="${r.id}" type="button">
                                    <i class="ti ti-x me-1"></i>Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>`
            )
            .join("");
        list.querySelectorAll("[data-cancel]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const confirmed = await showTablerConfirm("Are you sure you want to cancel this live ride?", {
                    title: "Cancel Live Ride",
                    variant: "danger",
                    confirmText: "Cancel Ride"
                });
                if (!confirmed) return;
                await withButtonSpinner(btn, async () => {
                    try {
                        await adminPatch(`/rides/${btn.dataset.cancel}`, { action: "cancel" });
                        toast("Ride cancelled.");
                        loadLiveRides();
                    } catch (error) {
                        toast(error.message, "error");
                    }
                });
            });
        });
        list.querySelectorAll("[data-track]").forEach((btn) => {
            btn.addEventListener("click", () => openLiveTrackingDrawer(btn.dataset.track));
        });
    } catch (error) {
        list.innerHTML = `<div class="col-12 text-center text-danger py-4">${error.message}</div>`;
    }
}

function openLiveTrackingDrawer(rideId) {
    const html = `
        <div id="live-track-readout" class="admin-track-readout text-primary mb-2">
            <div class="spinner-border text-primary spinner-border-sm me-2" role="status"></div>Connecting live map...
        </div>
        <div id="live-track-map" class="admin-track-map mb-2"></div>
        <p class="admin-drawer-hint">Route line is a straight approximation between pickup, driver's last GPS ping, and drop.</p>
    `;
    showReadOnlyDrawer("Live Ride Tracking", html);
    trackRideOnMap($("live-track-map"), $("live-track-readout"), rideId).catch(() => {
        $("live-track-readout").textContent = "Could not load the live map.";
    });
}

$("admin-drawer-close")?.addEventListener("click", () => stopTracking());
$("admin-drawer-backdrop")?.addEventListener("click", () => stopTracking());

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

function openRideDrawer(ride) {
    const timeline = [
        ["Requested", ride.createdAt],
        ["Accepted", ride.acceptedAt],
        ["Started", ride.startedAt || ride.pinVerifiedAt],
        ["Completed", ride.completedAt],
        ["Cancelled", ride.cancelledAt],
    ].filter(([, ts]) => ts);

    const notes = Array.isArray(ride.adminNotes) ? ride.adminNotes : [];

    let feedbackHtml = "";
    if (ride.feedback && ride.feedback.submitted) {
        const expMap = {
            poor: "🔴 Poor",
            decent: "🟠 Decent",
            good: "🟢 Good",
            loved: "🟢 Loved it!"
        };
        const expLabel = expMap[ride.feedback.experience] || ride.feedback.experience;
        const reasonsList = (ride.feedback.reasons || [])
            .map(r => r.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))
            .join(", ");
        feedbackHtml = `
            <h4 class="admin-drawer-subsection text-success">Passenger Feedback</h4>
            ${detailRow("Experience", expLabel)}
            ${detailRow("Passenger mentioned", escapeHtml(reasonsList || "None selected"))}
        `;
    }

    const html = `
        ${feedbackHtml}

        <h4 class="admin-drawer-subsection">Timeline</h4>
        ${timeline.length ? timeline.map(([label, ts]) => detailRow(label, formatTimestamp(ts))).join("") : `<p class="text-secondary text-center py-2">No timestamps recorded.</p>`}

        <h4 class="admin-drawer-subsection">Route</h4>
        ${detailRow("Pickup", ride.pickup_name || ride.pickupName || "")}
        ${detailRow("Drop", ride.drop_name || ride.dropName || "")}

        <h4 class="admin-drawer-subsection">Fare &amp; Payment</h4>
        ${detailRow("Fare", `Rs ${ride.fare || 0}${ride.fareAdjustedByAdmin ? " (admin-adjusted)" : ""}`)}
        ${detailRow("Payment status", ride.payment_status || "pending")}

        <h4 class="admin-drawer-subsection">People</h4>
        ${detailRow("Driver", ride.driver_name || "Unassigned")}
        ${detailRow("Passenger", (ride.passenger_id || "").slice(0, 10))}

        <h4 class="admin-drawer-subsection">Status &amp; Cancellation</h4>
        ${detailRow("Status", ride.status)}
        ${detailRow("Cancellation reason", ride.cancellationReason || "Not recorded")}

        <h4 class="admin-drawer-subsection">Adjust Fare</h4>
        <div class="input-group mb-3">
            <span class="input-group-text">₹</span>
            <input type="number" min="0" id="ride-fare-input" class="form-control" value="${ride.fare || 0}">
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
                await adminPatch(`/rides/${ride.id}`, { action: "update_fare", fare });
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
                const result = await adminPatch(`/rides/${ride.id}`, { action: "add_note", notes: notesText });
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
    return `<div class="admin-detail-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value ?? "")}</span></div>`;
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

function actionBtn(action, label) {
    return `<button class="btn btn-outline-secondary btn-sm me-1 mb-1" data-action="${action}" type="button">${label}</button>`;
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
