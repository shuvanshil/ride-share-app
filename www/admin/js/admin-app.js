import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch, refreshAdminToken } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { DataTable } from "./data-table.js";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js";
import { startLiveFeed, stopLiveFeed, trackRideOnMap, stopTracking } from "./admin-live.js";
import { toast } from "./admin-toast.js";
import { loadSafety, refreshSafetyBadge, startSosRealtimeAlerts } from "./admin-safety.js";
import { initAdminPayments, loadAdminPayments } from "./admin-payments.js";
import { loadPermissions, initPermissionsModal } from "./admin-permissions.js";

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
// Auth gate & Role Enforcement
// ---------------------------------------------------------------------

function showOnly(el) {
    [loginScreen, deniedScreen, shell].forEach((node) => {
        node.classList.toggle("d-none", node !== el);
    });
}

function applyRolePermissions(role) {
    currentAdminRole = String(role || "admin").toLowerCase();
    
    // Update Header Badge
    const badge = $("admin-header-role-badge");
    if (badge) {
        if (currentAdminRole === "super_admin") {
            badge.className = "badge bg-purple-lt text-purple ms-1 fw-bold";
            badge.textContent = "Super Admin";
        } else if (currentAdminRole === "manager") {
            badge.className = "badge bg-warning-lt text-warning ms-1 fw-bold";
            badge.textContent = "Manager";
        } else {
            badge.className = "badge bg-blue-lt text-blue ms-1 fw-bold";
            badge.textContent = "Admin";
        }
    }

    // Sidebar items visibility
    const hidePermissions = currentAdminRole !== "super_admin";
    const hideManagerRestricted = currentAdminRole === "manager";

    $("nav-item-permissions")?.classList.toggle("d-none", hidePermissions);
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
    if (!user) {
        stopLiveFeed();
        showOnly(loginScreen);
        return;
    }
    try {
        const result = await adminGet("/verify");
        $("admin-user-label").textContent = result.name || result.email || "";
        applyRolePermissions(result.role);
        
        showOnly(shell);
        resetToDashboard();
        loadSection("dashboard");
        refreshSafetyBadge();
        initAdminPayments();
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
            await loginAdmin(email, password);
        } catch (error) {
            errorTextEl.textContent = "Sign in failed. Check your email and password.";
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

$("admin-denied-back-btn")?.addEventListener("click", () => showOnly(loginScreen));
$("admin-logout-btn")?.addEventListener("click", async () => {
    clearInterval(liveRidesTimer);
    stopLiveFeed();
    await logoutAdmin();
});

// ---------------------------------------------------------------------
// Live feed panel
// ---------------------------------------------------------------------

function onFeedEvent(event) {
    const list = $("admin-feed-list");
    if (list.querySelector(".spinner-border") || list.querySelector(".text-muted")) list.innerHTML = "";
    const item = document.createElement("div");
    item.className = "admin-feed-item";
    item.innerHTML = `<span class="admin-feed-dot admin-feed-dot-${eventColor(event.type)}"></span>
        <span>${escapeHtml(event.text)}</span>
        <span class="admin-feed-time">${new Date(event.at).toLocaleTimeString()}</span>`;
    list.prepend(item);
    while (list.children.length > 60) list.lastChild.remove();

    if ($("admin-feed-panel").classList.contains("is-open")) return;
    feedUnreadCount += 1;
    const badge = $("admin-feed-badge");
    badge.textContent = feedUnreadCount;
    badge.classList.remove("d-none");
}

function eventColor(type) {
    if (type.startsWith("driver_offline") || type.includes("suspended") || type.includes("blocked")) return "warn";
    if (type.includes("cancelled")) return "danger";
    return "ok";
}

$("admin-feed-toggle")?.addEventListener("click", () => {
    $("admin-feed-panel").classList.toggle("is-open");
    if ($("admin-feed-panel").classList.contains("is-open")) {
        feedUnreadCount = 0;
        $("admin-feed-badge").classList.add("d-none");
    }
});
$("admin-feed-close")?.addEventListener("click", () => $("admin-feed-panel").classList.remove("is-open"));

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
// Dashboard
// ---------------------------------------------------------------------

function todayIsoRange() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { dateFrom: iso(start), dateTo: iso(end) };
}

function renderGreeting() {
    const el = $("dashboard-greeting");
    if (!el) return;
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    el.innerHTML = `
        <div class="alert alert-info border-info shadow-xs mb-3" role="alert">
            <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                <div class="d-flex align-items-center gap-3">
                    <i class="ti ti-sun text-info alert-icon" style="font-size: 2rem;"></i>
                    <div>
                        <h4 class="alert-title fw-bold mb-1 h3">Good ${timeOfDay}!</h4>
                        <div class="text-secondary small">Logged in as <strong>${currentAdminRole.replace("_", " ").toUpperCase()}</strong>. Welcome back to LiphtUp Console.</div>
                    </div>
                </div>
                <div class="badge bg-blue text-white d-flex align-items-center gap-1 p-2">
                    <i class="ti ti-calendar"></i>
                    <span>${dateStr}</span>
                </div>
            </div>
        </div>
    `;
}

function skeletonCards(count) {
    return Array.from({ length: count }, () => `
        <div class="col-sm-6 col-lg-3 mb-3">
            <div class="card card-sm border-0 shadow-xs p-4 text-center">
                <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
                <div class="text-secondary small">Loading...</div>
            </div>
        </div>
    `).join("");
}

async function loadDashboard() {
    renderGreeting();
    const kpiWrap = $("dashboard-kpis");
    const grid = $("dashboard-cards");
    kpiWrap.innerHTML = skeletonCards(7);
    grid.innerHTML = skeletonCards(8);
    try {
        const data = await adminGet("/overview", {}, { cacheable: true });
        const { dateFrom, dateTo } = todayIsoRange();

        const healthStatus = data.systemHealth?.status || "ok";
        const healthLabel = { ok: "All normal", attention: "Needs attention", unknown: "Unknown" }[healthStatus] || "Unknown";
        const healthTone = { ok: "success", attention: "danger", unknown: "secondary" }[healthStatus] || "secondary";

        const kpis = [
            {
                label: "Total rides today",
                value: data.today.totalRides,
                icon: "ti-car",
                onClick: () => openRidesDrillDown("Rides today", { status: "all", dateFrom, dateTo }),
            },
            {
                label: "Active rides right now",
                value: data.today.activeRides,
                icon: "ti-radar",
                onClick: () => openLiveDrillDown("Active rides right now"),
            },
            {
                label: "Online drivers",
                value: data.drivers.activeOnline,
                icon: "ti-steering-wheel",
                onClick: () => openDriversDrillDown("Online drivers", { availability: "online" }),
            },
            {
                label: "Active riders",
                value: new Set((data.today.activeRidePassengerIds || [])).size || data.today.activeRides,
                icon: "ti-users",
                onClick: () => openLiveDrillDown("Passengers currently on a ride", { passengersOnly: true }),
            },
            {
                label: "Completed today",
                value: data.today.completedRides,
                icon: "ti-circle-check",
                onClick: () => openRidesDrillDown("Completed today", { status: "completed", dateFrom, dateTo }),
            },
            {
                label: "Cancelled today",
                value: data.today.cancelledRides,
                icon: "ti-circle-x",
                onClick: () => openRidesDrillDown("Cancelled today", { status: "cancelled", dateFrom, dateTo }),
            },
        ];

        kpiWrap.innerHTML = kpis
            .map(
                (k, i) => `
                <div class="col-sm-6 col-lg-4 col-xl-2">
                    <button type="button" class="card card-sm card-link border-0 shadow-xs w-100 text-start p-3 h-100" data-kpi="${i}">
                        <div class="row align-items-center">
                            <div class="col-auto">
                                <span class="avatar bg-primary-lt text-primary">
                                    <i class="ti ${k.icon}"></i>
                                </span>
                            </div>
                            <div class="col">
                                <div class="text-secondary small font-weight-medium">${k.label}</div>
                                <div class="h2 mb-0 fw-bold text-dark">${k.value}</div>
                            </div>
                        </div>
                        <div class="text-secondary small mt-2 d-flex align-items-center">
                            <span>View details</span> <i class="ti ti-chevron-right ms-auto"></i>
                        </div>
                    </button>
                </div>`
            )
            .join("") + `
            <div class="col-sm-6 col-lg-4 col-xl-2">
                <button type="button" class="card card-sm card-link border-0 shadow-xs w-100 text-start p-3 h-100 bg-${healthTone}-lt text-${healthTone}" data-kpi="health">
                    <div class="row align-items-center">
                        <div class="col-auto">
                            <span class="avatar bg-${healthTone} text-white">
                                <i class="ti ti-heart-rate-monitor"></i>
                            </span>
                        </div>
                        <div class="col">
                            <div class="small font-weight-medium">System Health</div>
                            <div class="h2 mb-0 fw-bold">${healthLabel}</div>
                        </div>
                    </div>
                    <div class="small mt-2 d-flex align-items-center">
                        <span>Health details</span> <i class="ti ti-chevron-right ms-auto"></i>
                    </div>
                </button>
            </div>`;

        kpiWrap.querySelectorAll("[data-kpi]").forEach((btn) => {
            btn.addEventListener("click", () => {
                if (btn.dataset.kpi === "health") return openHealthDrawer(data.systemHealth);
                kpis[Number(btn.dataset.kpi)].onClick();
            });
        });

        const cards = [
            ["group", "Today's Metrics"],
            ["Distance (km)", data.today.totalDistanceKm],
            ["Fare collected (Rs)", data.today.totalFareCollected],
            ["Avg ride distance (km)", data.today.averageRideDistanceKm],
            ["New users today", data.today.newUsersToday],
            ["New drivers today", data.today.newDriversToday],
            ["group", "Drivers Overview"],
            ["Total drivers", data.drivers.total, () => goToSection("drivers", { "driver-status-filter": "" })],
            ["Busy drivers", data.drivers.busy, () => openDriversDrillDown("Busy drivers", { availability: "busy" })],
            ["Pending approval", data.drivers.pendingApproval, () => goToSection("drivers", { "driver-status-filter": "pending_review" })],
            ["Suspended drivers", data.drivers.suspended, () => goToSection("drivers", { "driver-status-filter": "suspended" })],
            ["Blocked drivers", data.drivers.blocked, () => goToSection("drivers", { "driver-status-filter": "blocked" })],
            ["group", "Passengers & Platform"],
            ["Total passengers", data.passengers.total, () => goToSection("passengers")],
            ["New registrations today", data.passengers.newRegistrationsToday],
            ["Total registered users", data.platform.totalRegisteredUsers],
            ["Total completed rides", data.platform.totalCompletedRides, () => goToSection("ride-history", { "history-status-filter": "completed" })],
        ];

        grid.innerHTML = cards
            .map(([label, value, onClick]) =>
                label === "group"
                    ? `<div class="col-12"><div class="hr-text hr-text-left my-2 font-weight-bold text-secondary text-uppercase">${value}</div></div>`
                    : `
                    <div class="col-sm-6 col-md-4 col-lg-3">
                        <${onClick ? 'button type="button"' : "div"} class="card card-sm border-0 shadow-xs p-3 w-100 text-start${onClick ? " card-link" : ""}" data-stat="${label}">
                            <div class="h2 mb-0 fw-bold text-primary">${value}</div>
                            <div class="text-secondary small">${label}</div>
                        </${onClick ? "button" : "div"}>
                    </div>`
            )
            .join("");

        cards.forEach(([label, , onClick]) => {
            if (!onClick) return;
            const el = Array.from(grid.querySelectorAll("[data-stat]")).find((n) => n.dataset.stat === label);
            if (el) el.addEventListener("click", onClick);
        });
    } catch (error) {
        kpiWrap.innerHTML = "";
        grid.innerHTML = `<div class="col-12 text-center text-danger py-4">${error.message}</div>`;
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
