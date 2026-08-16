import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch, refreshAdminToken } from "./admin-api.js";
import { showAlert, showConfirm } from "../../js/shared/dialog.js";
import { DataTable } from "./data-table.js";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js";
import { startLiveFeed, trackRideOnMap, stopTracking } from "./admin-live.js";
import { toast } from "./admin-toast.js";
import { loadSafety, refreshSafetyBadge, startSosRealtimeAlerts } from "./admin-safety.js";

const $ = (id) => document.getElementById(id);

const loginScreen = $("admin-login-screen");
const deniedScreen = $("admin-denied-screen");
const shell = $("admin-shell");

let liveRidesTimer = null;
const cursors = { drivers: null, history: null, passengers: null, audit: null };
let driversTable = null;
let passengersTable = null;
let historyTable = null;
let auditTable = null;
let feedUnreadCount = 0;
let feedStarted = false;
let liveErrorShown = false;

// A basic global error boundary: unexpected JS errors surface as a toast
// instead of silently breaking the page.
window.addEventListener("error", (e) => toast(`Something went wrong: ${e.message}`, "error"));
window.addEventListener("unhandledrejection", (e) => toast(`Something went wrong: ${e.reason?.message || e.reason}`, "error"));

// ---------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------

function showOnly(el) {
    [loginScreen, deniedScreen, shell].forEach((node) => {
        node.classList.toggle("d-none", node !== el);
    });
}

/** Always land on the Dashboard section after a fresh sign-in or reload,
 * regardless of whatever section a previous session left the static HTML
 * in. Re-asserted explicitly here rather than assumed from markup. */
function resetToDashboard() {
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === "dashboard"));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== "section-dashboard"));
}

watchAdminAuth(async (user) => {
    if (!user) {
        showOnly(loginScreen);
        return;
    }
    try {
        const result = await adminGet("/verify");
        $("admin-user-label").textContent = result.name || result.email || "";
        showOnly(shell);
        resetToDashboard();
        loadSection("dashboard");
        refreshSafetyBadge();
        startSosRealtimeAlerts();
        if (!feedStarted) {
            feedStarted = true;
            // Make sure the token used by Firestore's realtime listeners has
            // any admin claim granted just before this sign-in -- see the
            // comment on refreshAdminToken() for why this matters.
            await refreshAdminToken();
            startLiveFeed(onFeedEvent, (message) => {
                if (liveErrorShown) return;
                liveErrorShown = true;
                toast(message, "error");
            });
        }
    } catch (error) {
        await logoutAdmin();
        showOnly(deniedScreen);
    }
});

async function handleAdminLogin() {
    const email = $("admin-email").value.trim();
    const password = $("admin-password").value;
    const errorEl = $("admin-login-error");
    errorEl.classList.add("d-none");
    if (!email || !password) {
        errorEl.textContent = "Enter your email and password.";
        errorEl.classList.remove("d-none");
        return;
    }
    try {
        await loginAdmin(email, password);
    } catch (error) {
        errorEl.textContent = "Sign in failed. Check your email and password.";
        errorEl.classList.remove("d-none");
    }
}

$("admin-login-btn")?.addEventListener("click", handleAdminLogin);
$("admin-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});
$("admin-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});

$("admin-denied-back-btn").addEventListener("click", () => showOnly(loginScreen));
$("admin-logout-btn").addEventListener("click", async () => {
    clearInterval(liveRidesTimer);
    await logoutAdmin();
});

// ---------------------------------------------------------------------
// Live feed panel
// ---------------------------------------------------------------------

function onFeedEvent(event) {
    const list = $("admin-feed-list");
    if (list.querySelector(".admin-empty-row")) list.innerHTML = "";
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

$("admin-feed-toggle").addEventListener("click", () => {
    $("admin-feed-panel").classList.toggle("is-open");
    if ($("admin-feed-panel").classList.contains("is-open")) {
        feedUnreadCount = 0;
        $("admin-feed-badge").classList.add("d-none");
    }
});
$("admin-feed-close").addEventListener("click", () => $("admin-feed-panel").classList.remove("is-open"));

// ---------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------

document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".admin-section").forEach((s) => s.classList.add("d-none"));
        $(`section-${btn.dataset.section}`).classList.remove("d-none");
        $("admin-sidebar").classList.remove("is-open");
        loadSection(btn.dataset.section);
    });
});

$("admin-sidebar-toggle").addEventListener("click", () => {
    $("admin-sidebar").classList.toggle("is-open");
});

const loadedSections = new Set();

function loadSection(name) {
    clearInterval(liveRidesTimer);
    if (name === "live-rides") {
        loadLiveRides();
        liveRidesTimer = setInterval(loadLiveRides, 8000);
        return;
    }
    if (loadedSections.has(name)) return;
    loadedSections.add(name);
    if (name === "dashboard") loadDashboard();
    if (name === "drivers") loadDrivers(true);
    if (name === "safety") loadSafety();
    if (name === "ride-history") loadHistory(true);
    if (name === "passengers") loadPassengers(true);
    if (name === "analytics") loadAnalytics();
    if (name === "audit-log") loadAuditLog(true);
}

/** Switches to another section programmatically (from a dashboard card or
 * drawer link) the same way clicking its nav button would, optionally
 * applying a filter before loading it. */
function goToSection(name, filters = {}) {
    Object.entries(filters).forEach(([id, value]) => {
        const el = $(id);
        if (el) el.value = value;
    });
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== `section-${name}`));
    loadedSections.delete(name); // force a reload so the new filter takes effect
    loadSection(name);
    closeDrawer(true);
}

$("driver-status-filter").addEventListener("change", () => loadDrivers(true));
["history-status-filter", "history-vehicle-filter", "history-month-filter"].forEach((id) =>
    $(id).addEventListener("change", () => loadHistory(true))
);
$("history-day-filter").addEventListener("change", () => loadHistory(true));
$("history-clear-date").addEventListener("click", () => {
    $("history-month-filter").value = "";
    $("history-day-filter").value = "";
    loadHistory(true);
});
$("drivers-pending-chip").addEventListener("click", () => {
    $("driver-status-filter").value = "pending_review";
    loadDrivers(true);
});

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
        <div class="admin-greeting-text">Good ${timeOfDay}! How's your day going so far?</div>
        <div class="admin-greeting-date">${dateStr}</div>
    `;
}

function skeletonCards(count, cls = "admin-kpi-card") {
    return Array.from({ length: count }, () => `<div class="${cls} admin-skeleton"></div>`).join("");
}

async function loadDashboard() {
    renderGreeting();
    const kpiWrap = $("dashboard-kpis");
    const grid = $("dashboard-cards");
    kpiWrap.innerHTML = skeletonCards(7);
    grid.innerHTML = skeletonCards(10, "admin-stat-card");
    try {
        const data = await adminGet("/overview", {}, { cacheable: true });
        const { dateFrom, dateTo } = todayIsoRange();

        const healthStatus = data.systemHealth?.status || "ok";
        const healthLabel = { ok: "All normal", attention: "Needs attention", unknown: "Unknown" }[healthStatus] || "Unknown";

        const kpis = [
            {
                label: "Total rides today",
                value: data.today.totalRides,
                onClick: () => openRidesDrillDown("Rides today", { status: "all", dateFrom, dateTo }),
            },
            {
                label: "Active rides",
                value: data.today.activeRides,
                onClick: () => openLiveDrillDown("Active rides right now"),
            },
            {
                label: "Online drivers",
                value: data.drivers.activeOnline,
                onClick: () => openDriversDrillDown("Online drivers", { availability: "online" }),
            },
            {
                label: "Active riders",
                value: new Set((data.today.activeRidePassengerIds || [])).size || data.today.activeRides,
                onClick: () => openLiveDrillDown("Passengers currently on a ride", { passengersOnly: true }),
            },
            {
                label: "Completed today",
                value: data.today.completedRides,
                onClick: () => openRidesDrillDown("Completed today", { status: "completed", dateFrom, dateTo }),
            },
            {
                label: "Cancelled today",
                value: data.today.cancelledRides,
                onClick: () => openRidesDrillDown("Cancelled today", { status: "cancelled", dateFrom, dateTo }),
            },
        ];
        kpiWrap.innerHTML = kpis
            .map(
                (k, i) => `<button type="button" class="admin-kpi-card admin-kpi-clickable" data-kpi="${i}">
                    <div class="admin-kpi-value">${k.value}</div>
                    <div class="admin-kpi-label">${k.label}</div>
                </button>`
            )
            .join("") + `<button type="button" class="admin-kpi-card admin-kpi-clickable admin-kpi-health admin-health-${healthStatus}" data-kpi="health">
                <div class="admin-kpi-value">${healthLabel}</div>
                <div class="admin-kpi-label">System health</div>
            </button>`;
        kpiWrap.querySelectorAll("[data-kpi]").forEach((btn) => {
            btn.addEventListener("click", () => {
                if (btn.dataset.kpi === "health") return openHealthDrawer(data.systemHealth);
                kpis[Number(btn.dataset.kpi)].onClick();
            });
        });

        const cards = [
            ["group", "Today"],
            ["Distance (km)", data.today.totalDistanceKm],
            ["Fare collected (Rs)", data.today.totalFareCollected],
            ["Avg ride distance (km)", data.today.averageRideDistanceKm],
            ["New users today", data.today.newUsersToday],
            ["New drivers today", data.today.newDriversToday],
            ["group", "Drivers"],
            ["Total drivers", data.drivers.total, () => goToSection("drivers", { "driver-status-filter": "" })],
            ["Busy", data.drivers.busy, () => openDriversDrillDown("Busy drivers", { availability: "busy" })],
            ["Pending approval", data.drivers.pendingApproval, () => goToSection("drivers", { "driver-status-filter": "pending_review" })],
            ["Suspended", data.drivers.suspended, () => goToSection("drivers", { "driver-status-filter": "suspended" })],
            ["Blocked", data.drivers.blocked, () => goToSection("drivers", { "driver-status-filter": "blocked" })],
            ["group", "Passengers & Platform"],
            ["Total passengers", data.passengers.total, () => goToSection("passengers")],
            ["New registrations today", data.passengers.newRegistrationsToday],
            ["Total registered users", data.platform.totalRegisteredUsers],
            ["Total completed rides", data.platform.totalCompletedRides, () => goToSection("ride-history", { "history-status-filter": "completed" })],
        ];
        grid.innerHTML = cards
            .map(([label, value, onClick]) =>
                label === "group"
                    ? `<div class="admin-card-group-title">${label === "group" ? value : ""}</div>`
                    : `<${onClick ? "button type=\"button\"" : "div"} class="admin-stat-card${onClick ? " admin-kpi-clickable" : ""}" data-stat="${label}"><div class="admin-stat-card-value">${value}</div><div class="admin-stat-card-label">${label}</div></${onClick ? "button" : "div"}>`
            )
            .join("");
        cards.forEach(([label, , onClick]) => {
            if (!onClick) return;
            const el = Array.from(grid.querySelectorAll("[data-stat]")).find((n) => n.dataset.stat === label);
            if (el) el.addEventListener("click", onClick);
        });
    } catch (error) {
        kpiWrap.innerHTML = "";
        grid.innerHTML = `<p class="admin-empty-row">${error.message}</p>`;
    }
}

function openHealthDrawer(health) {
    const notes = health?.notes || [];
    showReadOnlyDrawer(
        "System health",
        `${detailRow("Status", health?.status || "unknown")}
         ${detailRow("Last admin action", formatTimestamp(health?.lastAdminActionAt))}
         <h4 class="admin-drawer-subsection">Notes</h4>
         ${notes.length ? notes.map((n) => `<p class="admin-detail-row"><span>${escapeHtml(n)}</span></p>`).join("") : `<p class="admin-empty-row">Nothing needs attention.</p>`}`
    );
}

/** Small non-interactive summary table used inside drill-down drawers, with
 * a "View all" link that jumps to the full section/filter for anything
 * beyond the first page. */
function summaryTable(rows, columns, emptyText) {
    if (!rows.length) return `<p class="admin-empty-row">${emptyText}</p>`;
    return `<table class="admin-table"><thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="dt-clickable-row" data-row-open>${columns.map((c) => `<td>${c.render(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

async function openRidesDrillDown(title, { status, dateFrom, dateTo }) {
    showReadOnlyDrawer(title, `<p class="admin-empty-row">Loading...</p>`);
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
            <button type="button" class="admin-btn-outline mt-3" id="drill-view-all">View all in Ride History</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(data.rides[i])));
        document.getElementById("drill-view-all").addEventListener("click", () =>
            goToSection("ride-history", { "history-status-filter": status === "all" || status === "cancelled" || status === "active" ? "" : status })
        );
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="admin-empty-row">${error.message}</p>`);
    }
}

async function openDriversDrillDown(title, { availability, status } = {}) {
    showReadOnlyDrawer(title, `<p class="admin-empty-row">Loading...</p>`);
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
        showReadOnlyDrawer(title, `<p class="admin-empty-row">${error.message}</p>`);
    }
}

async function openLiveDrillDown(title, { passengersOnly = false } = {}) {
    showReadOnlyDrawer(title, `<p class="admin-empty-row">Loading...</p>`);
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
            <button type="button" class="admin-btn-outline mt-3" id="drill-view-live">View all in Live Rides</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(rows[i])));
        document.getElementById("drill-view-live").addEventListener("click", () => goToSection("live-rides"));
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="admin-empty-row">${error.message}</p>`);
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
    const confirmed = await showConfirm(`${action} ${ids.length} selected driver(s)?`);
    if (!confirmed) return;
    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/drivers/${uid}`, { action });
            ok += 1;
        } catch (error) {
            // continue with the rest; report a summary below
        }
    }
    toast(`${action} applied to ${ok}/${ids.length} drivers.`);
    loadDrivers(true);
}

async function loadDrivers(reset) {
    if (reset) cursors.drivers = null;
    const status = $("driver-status-filter").value;
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
    showReadOnlyDrawer("Driver", `<p class="admin-empty-row">Loading...</p>`);
    try {
        const data = await adminGet(`/drivers/${uid}`);
        const d = data.driver;
        const recentRidesHtml = data.recentRides.length
            ? `<table class="admin-table"><thead><tr><th>Route</th><th>Fare</th><th>Status</th></tr></thead><tbody>${data.recentRides
                  .map((r) => `<tr><td>${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}</td><td>Rs ${r.fare || 0}</td><td>${escapeHtml(r.status || "")}</td></tr>`)
                  .join("")}</tbody></table>`
            : `<p class="admin-empty-row">No rides yet.</p>`;

        const summary = `
            <div class="admin-drawer-photo-row">
                ${d.profilePhotoUrl ? `<img src="${escapeAttr(d.profilePhotoUrl)}" class="admin-drawer-photo" alt="">` : `<div class="admin-drawer-photo admin-drawer-photo-placeholder"></div>`}
                <div>
                    <div class="admin-drawer-name">${escapeHtml(d.name || "Unnamed")}</div>
                    <div class="admin-drawer-sub">Driver ID: ${escapeHtml(d.uid)}</div>
                </div>
            </div>
            ${detailRow("Status", d.verificationStatus)}
            ${detailRow("Online status", d.driverAvailability)}
            ${detailRow("Rating", "Not collected yet")}
            ${detailRow("Wallet / earnings balance", `Lifetime earnings: Rs ${d.lifetimeEarnings || 0}`)}
            ${detailRow("Address", "Not collected yet")}
            ${detailRow("Insurance", "Not collected yet")}
            ${detailRow("Vehicle documents", "Not collected yet")}
            ${detailRow("Completed trips", d.totalCompletedTrips || 0)}
            <div class="admin-action-row">
                ${actionBtn("approve", "Approve")}
                ${actionBtn("reject", "Reject")}
                ${actionBtn("suspend", "Suspend")}
                ${actionBtn("block", "Block")}
                ${actionBtn("unblock", "Unblock")}
            </div>
            <h4 class="admin-drawer-subsection">Recent rides</h4>
            ${recentRidesHtml}
            <h4 class="admin-drawer-subsection">Edit profile</h4>
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
                const confirmed = await showConfirm(`${btn.textContent} this driver?`);
                if (!confirmed) return;
                try {
                    await adminPatch(`/drivers/${uid}`, { action: btn.dataset.action });
                    toast(`Driver ${btn.dataset.action}d.`);
                    closeDrawer(true);
                    loadDrivers(true);
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
    } catch (error) {
        showReadOnlyDrawer("Driver", `<p class="admin-empty-row">${error.message}</p>`);
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
            list.innerHTML = `<p class="admin-empty-row">No active rides right now.</p>`;
            return;
        }
        list.innerHTML = data.rides
            .map(
                (r) => `<div class="admin-ride-card">
                    ${statusChip(r.status)}
                    <span><strong>${escapeHtml(r.pickup_name || "Pickup")}</strong> &rarr; <strong>${escapeHtml(r.drop_name || "Drop")}</strong></span>
                    <span>${escapeHtml(r.driver_name || "Unassigned")}</span>
                    <span>Rs ${r.fare || 0}</span>
                    <div class="admin-ride-card-actions">
                        <button class="admin-btn-outline" data-track="${r.id}" type="button">Track live</button>
                        <button class="admin-btn-outline" data-cancel="${r.id}" type="button">Cancel</button>
                    </div>
                </div>`
            )
            .join("");
        list.querySelectorAll("[data-cancel]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const confirmed = await showConfirm("Cancel this ride?");
                if (!confirmed) return;
                try {
                    await adminPatch(`/rides/${btn.dataset.cancel}`, { action: "cancel" });
                    toast("Ride cancelled.");
                    loadLiveRides();
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
        list.querySelectorAll("[data-track]").forEach((btn) => {
            btn.addEventListener("click", () => openLiveTrackingDrawer(btn.dataset.track));
        });
    } catch (error) {
        list.innerHTML = `<p class="admin-empty-row">${error.message}</p>`;
    }
}

function openLiveTrackingDrawer(rideId) {
    const html = `
        <div id="live-track-readout" class="admin-track-readout">Connecting...</div>
        <div id="live-track-map" class="admin-track-map"></div>
        <p class="admin-drawer-hint">Route line is a straight approximation between pickup, the driver's last GPS ping, and drop -- not the actual road path.</p>
    `;
    showReadOnlyDrawer("Live tracking", html);
    trackRideOnMap($("live-track-map"), $("live-track-readout"), rideId).catch(() => {
        $("live-track-readout").textContent = "Could not load the live map.";
    });
}

$("admin-drawer-close").addEventListener("click", () => stopTracking());
$("admin-drawer-backdrop").addEventListener("click", () => stopTracking());

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
            { key: "status", label: "Status", sortable: true, render: (r) => statusChip(r.status) },
        ],
    });
    return historyTable;
}

/** Builds the "Any month" dropdown with the current month plus the past 11
 * months, each stored as its UTC first-of-month day so it can be turned
 * straight into a dateFrom/dateTo pair. */
function populateHistoryMonthFilter() {
    const select = $("history-month-filter");
    if (select.dataset.populated) return;
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
    const status = $("history-status-filter").value;
    const vehicleType = $("history-vehicle-filter").value;
    const day = $("history-day-filter").value;
    const month = $("history-month-filter").value;
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
    const html = `
        <h4 class="admin-drawer-subsection">Timeline</h4>
        ${timeline.length ? timeline.map(([label, ts]) => detailRow(label, formatTimestamp(ts))).join("") : `<p class="admin-empty-row">No timestamps recorded.</p>`}

        <h4 class="admin-drawer-subsection">Route</h4>
        ${detailRow("Pickup", ride.pickup_name || ride.pickupName || "")}
        ${detailRow("Drop", ride.drop_name || ride.dropName || "")}

        <h4 class="admin-drawer-subsection">Fare &amp; payment</h4>
        ${detailRow("Fare", `Rs ${ride.fare || 0}${ride.fareAdjustedByAdmin ? " (admin-adjusted)" : ""}`)}
        ${detailRow("Payment status", ride.payment_status || "pending")}

        <h4 class="admin-drawer-subsection">People</h4>
        ${detailRow("Driver", ride.driver_name || "Unassigned")}
        ${detailRow("Passenger", (ride.passenger_id || "").slice(0, 10))}

        <h4 class="admin-drawer-subsection">Status &amp; cancellation</h4>
        ${detailRow("Status", ride.status)}
        ${detailRow("Cancellation reason", ride.cancellationReason || "Not recorded")}

        <h4 class="admin-drawer-subsection">Adjust fare</h4>
        <div class="mb-2 d-flex gap-2">
            <input type="number" min="0" id="ride-fare-input" class="form-control gy-input" value="${ride.fare || 0}">
            <button id="ride-fare-save" class="admin-btn-outline" type="button">Save</button>
        </div>

        <h4 class="admin-drawer-subsection">Admin notes</h4>
        <div class="admin-notes-list">
            ${notes.length ? notes.map((n) => `<div class="admin-note"><div>${escapeHtml(n.text)}</div><div class="admin-note-meta">${escapeHtml(n.byEmail || "")} \u00b7 ${formatTimestamp(n.at)}</div></div>`).join("") : `<p class="admin-empty-row">No notes yet.</p>`}
        </div>
        <div class="mb-2 d-flex gap-2">
            <input type="text" id="ride-note-input" class="form-control gy-input" placeholder="Add an internal note...">
            <button id="ride-note-save" class="admin-btn-outline" type="button">Add</button>
        </div>
    `;
    showReadOnlyDrawer("Ride detail", html);

    document.getElementById("ride-fare-save").addEventListener("click", async () => {
        const fare = Number(document.getElementById("ride-fare-input").value);
        if (!(fare >= 0)) return toast("Enter a valid fare.", "error");
        try {
            await adminPatch(`/rides/${ride.id}`, { action: "update_fare", fare });
            toast("Fare updated.");
            loadHistory(true);
        } catch (error) {
            toast(error.message, "error");
        }
    });
    document.getElementById("ride-note-save").addEventListener("click", async () => {
        const notesText = document.getElementById("ride-note-input").value.trim();
        if (!notesText) return;
        try {
            const result = await adminPatch(`/rides/${ride.id}`, { action: "add_note", notes: notesText });
            toast("Note added.");
            openRideDrawer(result.ride);
        } catch (error) {
            toast(error.message, "error");
        }
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
                render: (r) => `<select class="form-select gy-input admin-filter-select" data-passenger-action="${r.uid}">
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
    const confirmed = await showConfirm(`${action} ${ids.length} selected passenger(s)?`);
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
                const confirmed = await showConfirm(`${action} this passenger's account?`);
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
                    { label: "Rides", data: rides, backgroundColor: "#1A7A2E", yAxisID: "y" },
                    { label: "Fare collected (Rs)", data: fare, type: "line", borderColor: "#D32F2F", yAxisID: "y1" },
                ],
            },
            options: {
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
            { key: "adminEmail", label: "Admin", sortable: true },
            { key: "action", label: "Action", sortable: true },
            { key: "targetType", label: "Target type", sortable: true },
            { key: "targetId", label: "Target ID", render: (r) => (r.targetId || "").slice(0, 12) },
            { key: "createdAt", label: "When", sortable: true, render: (r) => formatTimestamp(r.createdAt) },
        ],
    });
    return auditTable;
}

async function loadAuditLog(reset) {
    if (reset) cursors.audit = null;
    const table = ensureAuditTable();
    try {
        const data = await adminGet("/audit-logs", { cursor: reset ? null : cursors.audit });
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

// Buckets every status string this console displays (ride lifecycle,
// driver verification, passenger account state) into a handful of visual
// tones, so an admin can tell "this needs action" from "this is fine" at a
// glance without reading every cell.
const STATUS_TONES = {
    // rides
    pending: "amber", accepted: "blue", arrived: "blue", started: "blue", en_route: "blue",
    completed: "green", cancelled_by_passenger: "red", cancelled_by_driver: "red",
    // drivers
    pending_review: "amber", approved: "green", rejected: "red", suspended: "red", blocked: "red",
    // passengers
    active: "green", restricted: "amber",
};
function statusChip(status) {
    const value = String(status || "").trim();
    const tone = STATUS_TONES[value] || "grey";
    const label = value ? value.replace(/_/g, " ") : "unknown";
    return `<span class="status-pill status-pill-${tone}">${escapeHtml(label)}</span>`;
}

function actionBtn(action, label) {
    return `<button class="admin-btn-outline" data-action="${action}" type="button">${label}</button>`;
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
