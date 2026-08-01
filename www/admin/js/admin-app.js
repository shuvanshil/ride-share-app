import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch } from "./admin-api.js";
import { showAlert, showConfirm } from "../../js/dialog.js";
import { DataTable } from "./data-table.js";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js";
import { startLiveFeed, trackRideOnMap, stopTracking } from "./admin-live.js";
import { toast } from "./admin-toast.js";

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

watchAdminAuth(async (user) => {
    if (!user) {
        showOnly(loginScreen);
        return;
    }
    try {
        const result = await adminGet("/verify");
        $("admin-user-label").textContent = result.name || result.email || "";
        showOnly(shell);
        loadSection("dashboard");
        if (!feedStarted) {
            feedStarted = true;
            startLiveFeed(onFeedEvent);
        }
    } catch (error) {
        await logoutAdmin();
        showOnly(deniedScreen);
    }
});

$("admin-login-btn").addEventListener("click", async () => {
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
    if (name === "ride-history") loadHistory(true);
    if (name === "passengers") loadPassengers(true);
    if (name === "analytics") loadAnalytics();
    if (name === "audit-log") loadAuditLog(true);
}

$("driver-status-filter").addEventListener("change", () => loadDrivers(true));
["history-status-filter", "history-vehicle-filter"].forEach((id) =>
    $(id).addEventListener("change", () => loadHistory(true))
);

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------

async function loadDashboard() {
    const kpiWrap = $("dashboard-kpis");
    const grid = $("dashboard-cards");
    kpiWrap.innerHTML = "";
    grid.innerHTML = `<p class="admin-empty-row">Loading...</p>`;
    try {
        const data = await adminGet("/overview", {}, { cacheable: true });
        kpiWrap.innerHTML = [
            ["Total rides today", data.today.totalRides],
            ["Active rides", data.today.activeRides],
            ["Online drivers", data.drivers.activeOnline],
            ["Offline drivers", data.drivers.offline],
        ]
            .map(
                ([label, value]) => `<div class="admin-kpi-card">
                    <div class="admin-kpi-value">${value}</div>
                    <div class="admin-kpi-label">${label}</div>
                </div>`
            )
            .join("");

        const cards = [
            ["group", "Today"],
            ["Completed", data.today.completedRides],
            ["Cancelled", data.today.cancelledRides],
            ["Distance (km)", data.today.totalDistanceKm],
            ["Fare collected (Rs)", data.today.totalFareCollected],
            ["Avg ride distance (km)", data.today.averageRideDistanceKm],
            ["New users today", data.today.newUsersToday],
            ["New drivers today", data.today.newDriversToday],
            ["group", "Drivers"],
            ["Total drivers", data.drivers.total],
            ["Busy", data.drivers.busy],
            ["Pending approval", data.drivers.pendingApproval],
            ["Suspended", data.drivers.suspended],
            ["Blocked", data.drivers.blocked],
            ["group", "Passengers & Platform"],
            ["Total passengers", data.passengers.total],
            ["New registrations today", data.passengers.newRegistrationsToday],
            ["Total registered users", data.platform.totalRegisteredUsers],
            ["Total completed rides", data.platform.totalCompletedRides],
        ];
        grid.innerHTML = cards
            .map(([label, value]) =>
                label === "group"
                    ? `<div class="admin-card-group-title">${value}</div>`
                    : `<div class="admin-stat-card"><div class="admin-stat-card-value">${value}</div><div class="admin-stat-card-label">${label}</div></div>`
            )
            .join("");
    } catch (error) {
        grid.innerHTML = `<p class="admin-empty-row">${error.message}</p>`;
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
            { key: "verificationStatus", label: "Status", sortable: true, render: (r) => `<span class="status-pill">${escapeHtml(r.verificationStatus || "")}</span>` },
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
                    <span class="status-pill">${escapeHtml(r.status || "")}</span>
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
            { key: "driver_name", label: "Driver", sortable: true },
            { key: "passenger_id", label: "Passenger", sortable: false, render: (r) => (r.passenger_id || "").slice(0, 8) },
            { key: "route", label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
            { key: "fare", label: "Fare", sortable: true, render: (r) => `Rs ${r.fare || 0}` },
            { key: "status", label: "Status", sortable: true, render: (r) => `<span class="status-pill">${escapeHtml(r.status || "")}</span>` },
        ],
    });
    return historyTable;
}

async function loadHistory(reset) {
    if (reset) cursors.history = null;
    const status = $("history-status-filter").value;
    const vehicleType = $("history-vehicle-filter").value;
    const table = ensureHistoryTable();
    try {
        const data = await adminGet("/rides/history", { status, vehicleType, cursor: reset ? null : cursors.history });
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
            { key: "accountStatus", label: "Status", sortable: true, render: (r) => `<span class="status-pill">${escapeHtml(r.accountStatus || "active")}</span>` },
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
