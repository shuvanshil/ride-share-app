import { adminGet, adminPatch, adminPost, adminDelete } from "./admin-api.js?v=2.7.0";
import { showTablerConfirm } from "./admin-confirm.js?v=2.7.0";
import { toast } from "./admin-toast.js?v=2.7.0";
import { showReadOnlyDrawer, closeDrawer } from "./admin-drawer.js?v=2.7.0";
import { renderRideMap, stopTracking } from "./admin-live.js?v=2.7.0";
import { db, auth } from "../../js/platform/firebase-init.js";
import { collection, limit, onSnapshot, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let activeSafetyTab = "sos";
let currentSosAlerts = [];
let currentSafetyReports = [];
const selectedSosIds = new Set();
const selectedReportIds = new Set();

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function formatWhen(value, fallback = "Not recorded") {
    if (!value) return fallback;
    try {
        if (typeof value === "object" && typeof value.toDate === "function") {
            return value.toDate().toLocaleString();
        }
        if (typeof value === "object" && typeof value._seconds === "number") {
            return new Date(value._seconds * 1000).toLocaleString();
        }
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        return d.toLocaleString();
    } catch {
        return fallback;
    }
}

function mapLink(location) {
    const lat = Number(location?.lat ?? location?.latitude);
    const lng = Number(location?.lng ?? location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return "";
    return `https://www.google.com/maps?q=${lat},${lng}`;
}

function formatCoords(coords, fallback = "Not recorded") {
    const lat = Number(coords?.lat ?? coords?.latitude);
    const lng = Number(coords?.lng ?? coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return fallback;
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function formatEmergencyContacts(contacts) {
    if (!contacts) return "Not recorded";
    if (Array.isArray(contacts)) {
        if (contacts.length === 0) return "Not recorded";
        return contacts
            .map((c) => {
                if (typeof c === "object" && c !== null) {
                    const name = escapeHtml(c.name || c.relation || "Contact");
                    const phone = escapeHtml(c.phone || c.number || c.mobile || "Not recorded");
                    return `<span class="badge bg-red-lt text-red me-1 mb-1">${name}: ${phone}</span>`;
                }
                return `<span class="badge bg-red-lt text-red me-1 mb-1">${escapeHtml(c)}</span>`;
            })
            .join(" ");
    }
    if (typeof contacts === "string" && contacts.trim()) {
        return escapeHtml(contacts.trim());
    }
    return "Not recorded";
}

async function withButtonSpinner(btn, actionFn) {
    if (!btn) return actionFn();
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span>Processing...`;
    try {
        return await actionFn();
    } finally {
        if (btn.isConnected) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

function isDeletableStatus(status) {
    return ["resolved", "dismissed", "closed"].includes(String(status || "open").trim().toLowerCase());
}

// ---------------------------------------------------------------------
// Bulk Selection Bar Management
// ---------------------------------------------------------------------

function updateSosBulkBar() {
    const bar = $("safety-sos-bulk-bar");
    const selectAll = $("safety-sos-select-all");
    const countBadge = $("safety-sos-selected-count");
    const deleteBtn = $("safety-sos-bulk-delete-btn");
    if (!bar) return;

    const deletableAlerts = currentSosAlerts.filter((a) => isDeletableStatus(a.status));
    // Prune any selected IDs that are no longer in current deletable list
    const validIds = new Set(deletableAlerts.map((a) => a.id));
    for (const id of [...selectedSosIds]) {
        if (!validIds.has(id)) selectedSosIds.delete(id);
    }

    if (deletableAlerts.length === 0) {
        bar.classList.add("d-none");
        if (deleteBtn) deleteBtn.disabled = true;
        if (selectAll) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        }
        return;
    }

    bar.classList.remove("d-none");
    const count = selectedSosIds.size;
    if (countBadge) {
        countBadge.textContent = `${count} selected`;
        countBadge.classList.toggle("d-none", count === 0);
    }
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.classList.toggle("d-none", count === 0);
    }
    if (selectAll) {
        selectAll.checked = deletableAlerts.length > 0 && count === deletableAlerts.length;
        selectAll.indeterminate = count > 0 && count < deletableAlerts.length;
    }
}

function updateReportsBulkBar() {
    const bar = $("safety-reports-bulk-bar");
    const selectAll = $("safety-reports-select-all");
    const countBadge = $("safety-reports-selected-count");
    const deleteBtn = $("safety-reports-bulk-delete-btn");
    if (!bar) return;

    const deletableReports = currentSafetyReports.filter((r) => isDeletableStatus(r.status));
    const validIds = new Set(deletableReports.map((r) => r.id));
    for (const id of [...selectedReportIds]) {
        if (!validIds.has(id)) selectedReportIds.delete(id);
    }

    if (deletableReports.length === 0) {
        bar.classList.add("d-none");
        if (deleteBtn) deleteBtn.disabled = true;
        if (selectAll) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        }
        return;
    }

    bar.classList.remove("d-none");
    const count = selectedReportIds.size;
    if (countBadge) {
        countBadge.textContent = `${count} selected`;
        countBadge.classList.toggle("d-none", count === 0);
    }
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.classList.toggle("d-none", count === 0);
    }
    if (selectAll) {
        selectAll.checked = deletableReports.length > 0 && count === deletableReports.length;
        selectAll.indeterminate = count > 0 && count < deletableReports.length;
    }
}

// ---------------------------------------------------------------------
// SOS Alerts List & Actions
// ---------------------------------------------------------------------

async function loadSosAlerts() {
    const list = $("safety-sos-list");
    if (!list) return;
    const status = $("safety-sos-status-filter")?.value || "open";
    list.innerHTML = `
        <div class="col-12 text-center py-5">
            <div class="spinner-border text-danger mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading SOS alerts...</div>
        </div>
    `;
    try {
        const data = await adminGet("/safety/sos-alerts", { status });
        currentSosAlerts = data.alerts || [];
        renderSosAlerts(currentSosAlerts);
    } catch (error) {
        list.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
    }
}

function renderSosAlerts(alerts) {
    const list = $("safety-sos-list");
    if (!list) return;
    updateSosBulkBar();

    if (!alerts.length) {
        list.innerHTML = `
            <div class="col-12 text-center py-5 text-secondary">
                <i class="ti ti-shield-check text-success mb-2" style="font-size: 2.5rem; display: block;"></i>
                No SOS alerts in this view.
            </div>
        `;
        return;
    }

    list.innerHTML = alerts
        .map((alert) => {
            const link = mapLink(alert.location || alert.incident_coords);
            const statusStr = String(alert.status || "open").toLowerCase();
            const isUrgent = statusStr === "open";
            const canDelete = isDeletableStatus(statusStr);
            const isChecked = selectedSosIds.has(alert.id);
            const reporterName = alert.reporter_name || alert.passenger_name || "Unknown Reporter";
            const reporterRole = alert.reporter_role || "passenger";
            const pickupLabel = alert.pickup_name || "Pickup not recorded";
            const dropLabel = alert.drop_name || "Destination not recorded";

            return `
            <div class="col-12" data-sos-card="${escapeHtml(alert.id)}">
                <div class="card card-sm sos-alert-card">
                    <div class="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
                        <div class="d-flex align-items-center gap-3">
                            ${canDelete ? `
                                <input type="checkbox" class="form-check-input m-0" data-select-sos="${escapeHtml(alert.id)}" ${isChecked ? "checked" : ""} aria-label="Select SOS alert">
                            ` : `
                                <input type="checkbox" class="form-check-input m-0" disabled title="Resolve this SOS alert before deleting" aria-label="Active SOS alert cannot be deleted">
                            `}
                            <span class="badge ${isUrgent ? "bg-danger-lt text-danger" : "bg-secondary-lt text-secondary"} text-uppercase">
                                ${isUrgent ? '<i class="ti ti-alert-triangle me-1"></i>' : ""}${escapeHtml(statusStr)}
                            </span>
                            <div>
                                <div class="d-flex align-items-center gap-2 flex-wrap">
                                    <strong class="text-dark">${escapeHtml(reporterName)}</strong>
                                    <span class="badge bg-blue-lt text-blue text-capitalize">${escapeHtml(reporterRole)}</span>
                                    ${alert.driver_name && alert.driver_name !== "Unassigned" && alert.driver_name !== "Not applicable"
                                        ? `<span class="text-secondary small"><i class="ti ti-steering-wheel me-1"></i>Driver: <strong>${escapeHtml(alert.driver_name)}</strong></span>`
                                        : `<span class="text-muted small">${escapeHtml(alert.driver_name || "Unassigned")}</span>`}
                                </div>
                                <small class="text-secondary d-block mt-1">
                                    <i class="ti ti-map-pin text-success me-1"></i>${escapeHtml(pickupLabel)}
                                    <span class="mx-1">&rarr;</span>
                                    <i class="ti ti-flag text-danger me-1"></i>${escapeHtml(dropLabel)}
                                </small>
                            </div>
                        </div>
                        ${alert.note ? `<div class="text-secondary small fst-italic">Note: "${escapeHtml(alert.note)}"</div>` : ""}
                        <div class="text-secondary small ms-auto me-2">${escapeHtml(formatWhen(alert.createdAt))}</div>
                        <div class="d-flex align-items-center gap-2">
                            <button class="btn btn-outline-info btn-sm d-inline-flex align-items-center gap-1" data-view-sos="${escapeHtml(alert.id)}" type="button">
                                <i class="ti ti-eye"></i> View Details
                            </button>
                            ${link ? `<a class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" href="${link}" target="_blank" rel="noopener"><i class="ti ti-map-pin"></i> Map</a>` : ""}
                            ${isUrgent
                                ? `<button class="btn btn-primary btn-sm d-inline-flex align-items-center gap-1" data-resolve-sos="${escapeHtml(alert.id)}" type="button"><i class="ti ti-check"></i> Mark Resolved</button>`
                                : `<button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-reopen-sos="${escapeHtml(alert.id)}" type="button"><i class="ti ti-rotate-clockwise"></i> Reopen</button>
                                   <button class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1" data-delete-sos="${escapeHtml(alert.id)}" type="button" title="Delete resolved SOS record"><i class="ti ti-trash"></i> Delete</button>`}
                        </div>
                    </div>
                </div>
            </div>`;
        })
        .join("");

    list.querySelectorAll("[data-select-sos]").forEach((cb) => {
        cb.addEventListener("change", (e) => {
            const id = cb.dataset.selectSos;
            if (e.target.checked) selectedSosIds.add(id);
            else selectedSosIds.delete(id);
            updateSosBulkBar();
        });
    });

    list.querySelectorAll("[data-view-sos]").forEach((btn) => {
        btn.addEventListener("click", () => openSosDetailDrawer(btn.dataset.viewSos));
    });

    list.querySelectorAll("[data-resolve-sos]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const confirmed = await showTablerConfirm("Mark this SOS alert as resolved?", {
                title: "Resolve SOS Alert",
                variant: "success",
                confirmText: "Mark Resolved"
            });
            if (!confirmed) return;
            await withButtonSpinner(btn, async () => {
                try {
                    await adminPatch(`/safety/sos-alerts/${btn.dataset.resolveSos}`, { action: "resolve" });
                    toast("SOS alert resolved.");
                    await loadSosAlerts();
                    refreshSafetyBadge();
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
    });

    list.querySelectorAll("[data-reopen-sos]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            await withButtonSpinner(btn, async () => {
                try {
                    await adminPatch(`/safety/sos-alerts/${btn.dataset.reopenSos}`, { action: "reopen" });
                    selectedSosIds.delete(btn.dataset.reopenSos);
                    toast("SOS alert reopened.");
                    await loadSosAlerts();
                    refreshSafetyBadge();
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
    });

    list.querySelectorAll("[data-delete-sos]").forEach((btn) => {
        btn.addEventListener("click", () => handleDeleteSos(btn.dataset.deleteSos, btn));
    });
}

async function handleDeleteSos(alertId, btn = null) {
    const confirmed = await showTablerConfirm(
        "Permanently delete this resolved SOS alert record? This action cannot be undone.",
        {
            title: "Delete SOS Incident Record",
            variant: "danger",
            confirmText: "Delete Permanently"
        }
    );
    if (!confirmed) return false;
    let deleted = false;
    await withButtonSpinner(btn, async () => {
        try {
            await adminDelete(`/safety/sos-alerts/${alertId}`);
            selectedSosIds.delete(alertId);
            currentSosAlerts = currentSosAlerts.filter((a) => a.id !== alertId);
            renderSosAlerts(currentSosAlerts);
            toast("SOS alert record deleted.");
            deleted = true;
        } catch (error) {
            toast(error.message, "error");
        }
    });
    return deleted;
}

async function handleBulkDeleteSos(btn) {
    const ids = [...selectedSosIds];
    if (!ids.length) return;
    const confirmed = await showTablerConfirm(
        `Permanently delete ${ids.length} selected resolved SOS alert record(s)? This action cannot be undone.`,
        {
            title: `Delete ${ids.length} SOS Record(s)`,
            variant: "danger",
            confirmText: `Delete ${ids.length} Record(s)`
        }
    );
    if (!confirmed) return;
    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost("/safety/sos-alerts/bulk-delete", { ids });
            ids.forEach((id) => selectedSosIds.delete(id));
            toast(`Deleted ${res.deletedCount ?? res.count ?? ids.length} SOS alert record(s).`);
            await loadSosAlerts();
        } catch (error) {
            toast(error.message, "error");
        }
    });
}

// ---------------------------------------------------------------------
// SOS Details Window / Drawer (Redesigned)
// ---------------------------------------------------------------------

export async function openSosDetailDrawer(alertId) {
    stopTracking();
    showReadOnlyDrawer("SOS Alert Incident Details", `
        <div class="text-center py-5">
            <div class="spinner-border text-danger mb-2" role="status"></div>
            <div class="text-secondary small">Loading full emergency incident details...</div>
        </div>
    `);

    try {
        let alertData = null;
        const cached = currentSosAlerts.find((a) => a.id === alertId);
        try {
            const response = await adminGet(`/safety/sos-alerts/${encodeURIComponent(alertId)}`);
            alertData = response?.alert || cached;
        } catch {
            alertData = cached;
        }

        if (!alertData) {
            showReadOnlyDrawer("SOS Alert Incident Details", `<p class="text-danger text-center py-4 my-0">Unable to retrieve SOS alert record.</p>`);
            return;
        }

        const statusStr = String(alertData.status || "open").toLowerCase();
        const isUrgent = statusStr === "open";
        const canDelete = isDeletableStatus(statusStr);
        const contactsHtml = formatEmergencyContacts(alertData.emergency_contacts);
        const driverAssigned = alertData.driver_id || (alertData.driver_name && !["Unassigned", "Not applicable", "Unable to retrieve"].includes(alertData.driver_name));
        const vehicleSummary = [
            alertData.vehicle_type && alertData.vehicle_type !== "Not available" && alertData.vehicle_type !== "Not applicable"
                ? String(alertData.vehicle_type).toUpperCase()
                : "",
            alertData.vehicle_number && alertData.vehicle_number !== "Not recorded" && alertData.vehicle_number !== "Not applicable"
                ? String(alertData.vehicle_number)
                : "",
            alertData.vehicle_model ? `(${alertData.vehicle_model})` : ""
        ].filter(Boolean).join(" &bull; ") || (driverAssigned ? "Not recorded" : "Not applicable");

        const fareDisplay = alertData.fare !== null && alertData.fare !== undefined && alertData.fare !== ""
            ? `₹${escapeHtml(alertData.fare)}`
            : (alertData.ride_id ? "Not recorded" : "Not applicable");

        const pinVerifiedBadge = alertData.pin_verified
            ? `<span class="badge bg-success-lt text-success"><i class="ti ti-shield-check me-1"></i>Verified</span>`
            : (alertData.ride_id ? `<span class="badge bg-secondary-lt text-secondary">Not verified at incident</span>` : `<span class="text-muted">Not applicable</span>`);

        const html = `
            <!-- Header Summary Card -->
            <div class="admin-detail-header-card ${isUrgent ? "border-danger bg-danger-lt" : "border-secondary bg-light"} mb-3">
                <div class="d-flex flex-wrap align-items-start justify-content-between gap-2">
                    <div>
                        <div class="d-flex align-items-center gap-2 mb-1">
                            <span class="badge ${isUrgent ? "bg-danger text-white" : "bg-secondary text-white"} text-uppercase">
                                <i class="ti ti-alert-triangle me-1"></i>${escapeHtml(statusStr)}
                            </span>
                            <span class="badge ${isUrgent ? "bg-red-lt text-red" : "bg-blue-lt text-blue"} text-uppercase">
                                Priority: ${escapeHtml(alertData.priority || (isUrgent ? "critical" : "normal"))}
                            </span>
                            <span class="text-secondary small">ID: <code>${escapeHtml(alertData.id || alertId)}</code></span>
                        </div>
                        <h4 class="m-0 fw-bold text-dark">SOS Emergency Alert &mdash; ${escapeHtml(alertData.reporter_name || "Unknown")}</h4>
                        <div class="text-secondary small mt-1">
                            Triggered: <strong>${escapeHtml(formatWhen(alertData.triggered_at || alertData.createdAt))}</strong>
                            ${alertData.resolved_at ? ` &bull; Resolved: <strong>${escapeHtml(formatWhen(alertData.resolved_at))}</strong>` : ""}
                        </div>
                    </div>
                    <div class="d-flex flex-wrap gap-2">
                        ${isUrgent
                            ? `<button type="button" class="btn btn-sm btn-success" id="drawer-sos-resolve-btn"><i class="ti ti-check me-1"></i>Mark Resolved</button>`
                            : `<button type="button" class="btn btn-sm btn-outline-secondary" id="drawer-sos-reopen-btn"><i class="ti ti-rotate-clockwise me-1"></i>Reopen</button>`}
                        ${canDelete
                            ? `<button type="button" class="btn btn-sm btn-outline-danger" id="drawer-sos-delete-btn"><i class="ti ti-trash me-1"></i>Delete</button>`
                            : ""}
                    </div>
                </div>
                ${alertData.note ? `
                    <div class="w-100 mt-2 p-3 rounded bg-white border border-danger-subtle small" style="box-sizing: border-box; word-break: break-word; overflow-wrap: anywhere;">
                        <strong class="text-danger d-block mb-1"><i class="ti ti-message-report me-1"></i>Emergency Note:</strong>
                        <div class="text-dark" style="word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap;">${escapeHtml(alertData.note)}</div>
                    </div>
                ` : ""}
            </div>

            <!-- Section 1: Reporter & Passenger Details -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-user-exclamation text-danger me-2"></i>
                    <span>Reporter &amp; Passenger Information</span>
                    <span class="badge bg-blue-lt text-blue ms-auto text-capitalize">Reporter: ${escapeHtml(alertData.reporter_role || "passenger")}</span>
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Passenger Name</span>
                        <strong class="admin-detail-value">${escapeHtml(alertData.passenger_name || "Unable to retrieve")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Passenger Phone</span>
                        <span class="admin-detail-value">
                            ${alertData.passenger_phone && alertData.passenger_phone !== "Not recorded"
                                ? `<a href="tel:${escapeHtml(alertData.passenger_phone)}" class="fw-bold text-primary text-decoration-none"><i class="ti ti-phone me-1"></i>${escapeHtml(alertData.passenger_phone)}</a>`
                                : `<span class="text-muted">${escapeHtml(alertData.passenger_phone || "Not recorded")}</span>`}
                        </span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Passenger Email</span>
                        <span class="admin-detail-value">${escapeHtml(alertData.passenger_email || "Not recorded")}</span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Reporter Name &amp; Phone</span>
                        <span class="admin-detail-value">${escapeHtml(alertData.reporter_name || "Unable to retrieve")} (${escapeHtml(alertData.reporter_phone || "Not recorded")})</span>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Emergency Contacts</span>
                        <div class="admin-detail-value mt-1">${contactsHtml}</div>
                    </div>
                </div>
            </div>

            <!-- Section 2: Driver & Vehicle Details -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-steering-wheel text-primary me-2"></i>
                    <span>Driver &amp; Vehicle Details</span>
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Driver Name</span>
                        <strong class="admin-detail-value">${escapeHtml(alertData.driver_name || "Unassigned")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Driver Phone</span>
                        <span class="admin-detail-value">
                            ${alertData.driver_phone && !["Not recorded", "Not applicable"].includes(alertData.driver_phone)
                                ? `<a href="tel:${escapeHtml(alertData.driver_phone)}" class="fw-bold text-primary text-decoration-none"><i class="ti ti-phone me-1"></i>${escapeHtml(alertData.driver_phone)}</a>`
                                : `<span class="text-muted">${escapeHtml(alertData.driver_phone || "Not applicable")}</span>`}
                        </span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Vehicle Type &amp; Plate</span>
                        <strong class="admin-detail-value">${vehicleSummary}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Driver Status</span>
                        <span class="admin-detail-value text-capitalize">${escapeHtml(alertData.driver_status || "Not applicable")}</span>
                    </div>
                </div>
            </div>

            <!-- Section 3: Associated Ride & Route Summary -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-route text-secondary me-2"></i>
                    <span>Ride &amp; Route Information</span>
                    ${alertData.ride_id ? `<code class="ms-auto small">${escapeHtml(alertData.ride_id)}</code>` : `<span class="ms-auto text-muted small">No linked ride</span>`}
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Pickup Address</span>
                        <strong class="admin-detail-value"><i class="ti ti-map-pin text-success me-1"></i>${escapeHtml(alertData.pickup_name || "Not recorded")}</strong>
                        <small class="text-secondary d-block">Coords: ${escapeHtml(formatCoords(alertData.pickup_coords))}</small>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Destination Address</span>
                        <strong class="admin-detail-value"><i class="ti ti-flag text-danger me-1"></i>${escapeHtml(alertData.drop_name || "Not recorded")}</strong>
                        <small class="text-secondary d-block">Coords: ${escapeHtml(formatCoords(alertData.drop_coords))}</small>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Ride Type &amp; Status</span>
                        <span class="admin-detail-value text-capitalize">${escapeHtml(alertData.ride_type || "Not applicable")} &bull; <strong>${escapeHtml(alertData.ride_status || "Not applicable")}</strong></span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Fare</span>
                        <strong class="admin-detail-value">${fareDisplay}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">PIN Verification</span>
                        <div class="admin-detail-value">${pinVerifiedBadge}</div>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Trigger Coordinates</span>
                        <span class="admin-detail-value">${escapeHtml(formatCoords(alertData.incident_coords || alertData.location))}</span>
                    </div>
                </div>
            </div>

            <!-- Section 4: Static Incident-Time Map Snapshot -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-map-2 text-primary me-2"></i>
                    <span>Incident Location &amp; Route Snapshot</span>
                    <span class="badge bg-amber-lt text-amber ms-auto">Incident Snapshot</span>
                </div>
                <div class="p-3">
                    <div id="sos-detail-map-readout" class="admin-track-readout text-secondary small mb-2">Loading incident map snapshot...</div>
                    <div id="sos-detail-map" class="admin-track-map"></div>
                </div>
            </div>

            <!-- Collapsible Resolution & Audit Metadata -->
            <details class="admin-collapsible mb-2">
                <summary class="admin-collapsible-summary">
                    <span><i class="ti ti-list-details me-2 text-secondary"></i>Audit &amp; Resolution Metadata</span>
                    <i class="ti ti-chevron-down admin-collapsible-chevron"></i>
                </summary>
                <div class="admin-collapsible-body">
                    <div class="admin-detail-grid">
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Alert ID</span>
                            <code class="admin-detail-value">${escapeHtml(alertData.id || alertId)}</code>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Resolved By Admin</span>
                            <span class="admin-detail-value">${escapeHtml(alertData.resolved_by || (isUrgent ? "Not applicable (Open)" : "Not recorded"))}</span>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Resolved Timestamp</span>
                            <span class="admin-detail-value">${escapeHtml(alertData.resolved_at ? formatWhen(alertData.resolved_at) : (isUrgent ? "Not applicable (Open)" : "Not recorded"))}</span>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Reopened Timestamp</span>
                            <span class="admin-detail-value">${escapeHtml(alertData.reopened_at ? formatWhen(alertData.reopened_at) : "Not applicable")}</span>
                        </div>
                    </div>
                </div>
            </details>
        `;

        const { bodyEl } = showReadOnlyDrawer("SOS Alert Incident Details", html);

        // Render Static Incident Map Snapshot using centralized map module
        const mapEl = bodyEl.querySelector("#sos-detail-map");
        const readoutEl = bodyEl.querySelector("#sos-detail-map-readout");
        renderRideMap(mapEl, alertData, { isSnapshot: true, readoutEl });

        // Wire Drawer Action Buttons
        bodyEl.querySelector("#drawer-sos-resolve-btn")?.addEventListener("click", async (e) => {
            const btn = e.currentTarget;
            await withButtonSpinner(btn, async () => {
                try {
                    await adminPatch(`/safety/sos-alerts/${alertId}`, { action: "resolve" });
                    toast("SOS alert resolved.");
                    await loadSosAlerts();
                    refreshSafetyBadge();
                    openSosDetailDrawer(alertId);
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });

        bodyEl.querySelector("#drawer-sos-reopen-btn")?.addEventListener("click", async (e) => {
            const btn = e.currentTarget;
            await withButtonSpinner(btn, async () => {
                try {
                    await adminPatch(`/safety/sos-alerts/${alertId}`, { action: "reopen" });
                    toast("SOS alert reopened.");
                    await loadSosAlerts();
                    refreshSafetyBadge();
                    openSosDetailDrawer(alertId);
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });

        bodyEl.querySelector("#drawer-sos-delete-btn")?.addEventListener("click", async (e) => {
            const deleted = await handleDeleteSos(alertId, e.currentTarget);
            if (deleted) closeDrawer(true);
        });
    } catch (error) {
        showReadOnlyDrawer("SOS Alert Incident Details", `<p class="text-danger text-center py-4 my-0">${escapeHtml(error.message)}</p>`);
    }
}

// ---------------------------------------------------------------------
// Safety Reports List & Actions
// ---------------------------------------------------------------------

async function loadSafetyReports() {
    const list = $("safety-reports-list");
    if (!list) return;
    const status = $("safety-reports-status-filter")?.value || "open";
    list.innerHTML = `
        <div class="col-12 text-center py-5">
            <div class="spinner-border text-warning mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading safety reports...</div>
        </div>
    `;
    try {
        const data = await adminGet("/safety/reports", { status });
        currentSafetyReports = data.reports || [];
        renderSafetyReports(currentSafetyReports);
    } catch (error) {
        list.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
    }
}

function renderSafetyReports(reports) {
    const list = $("safety-reports-list");
    if (!list) return;
    updateReportsBulkBar();

    if (!reports.length) {
        list.innerHTML = `
            <div class="col-12 text-center py-5 text-secondary">
                <i class="ti ti-file-check text-muted mb-2" style="font-size: 2.5rem; display: block;"></i>
                No safety reports in this view.
            </div>
        `;
        return;
    }

    list.innerHTML = reports
        .map((report) => {
            const statusStr = String(report.status || "open").toLowerCase();
            const isOpen = statusStr === "open";
            const canDelete = isDeletableStatus(statusStr);
            const isChecked = selectedReportIds.has(report.id);
            const categoryLabel = String(report.category || "general").replace(/_/g, " ");
            const reporterName = report.reporter_name || report.passenger_name || "Unknown Reporter";
            const reporterRole = report.reporter_role || "passenger";

            return `
            <div class="col-12" data-report-card="${escapeHtml(report.id)}">
                <div class="card card-sm safety-report-card">
                    <div class="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
                        <div class="d-flex align-items-center gap-3">
                            ${canDelete ? `
                                <input type="checkbox" class="form-check-input m-0" data-select-report="${escapeHtml(report.id)}" ${isChecked ? "checked" : ""} aria-label="Select safety report">
                            ` : `
                                <input type="checkbox" class="form-check-input m-0" disabled title="Resolve or dismiss this safety report before deleting" aria-label="Open safety report cannot be deleted">
                            `}
                            <span class="badge ${isOpen ? "bg-warning-lt text-warning" : "bg-secondary-lt text-secondary"} text-uppercase">
                                ${escapeHtml(statusStr)}
                            </span>
                            <div>
                                <div class="d-flex align-items-center gap-2 flex-wrap">
                                    <strong class="text-capitalize text-dark">${escapeHtml(categoryLabel)}</strong>
                                    <span class="text-secondary small">by <strong>${escapeHtml(reporterName)}</strong> (${escapeHtml(reporterRole)})</span>
                                    ${report.driver_name && !["Unassigned", "Not applicable"].includes(report.driver_name)
                                        ? `<span class="badge bg-blue-lt text-blue"><i class="ti ti-steering-wheel me-1"></i>${escapeHtml(report.driver_name)}</span>`
                                        : ""}
                                </div>
                                ${report.description ? `<div class="text-secondary small mt-1 text-truncate" style="max-width: 520px;">"${escapeHtml(report.description)}"</div>` : ""}
                            </div>
                        </div>
                        <div class="text-secondary small ms-auto me-2">${escapeHtml(formatWhen(report.createdAt))}</div>
                        <div class="d-flex align-items-center gap-2">
                            <button class="btn btn-outline-info btn-sm d-inline-flex align-items-center gap-1" data-view-report="${escapeHtml(report.id)}" type="button">
                                <i class="ti ti-eye"></i> View Details
                            </button>
                            ${isOpen
                                ? `<button class="btn btn-primary btn-sm d-inline-flex align-items-center gap-1" data-resolve-report="${escapeHtml(report.id)}" type="button"><i class="ti ti-check"></i> Resolve</button>
                                   <button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-dismiss-report="${escapeHtml(report.id)}" type="button"><i class="ti ti-x"></i> Dismiss</button>`
                                : `<button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-reopen-report="${escapeHtml(report.id)}" type="button"><i class="ti ti-rotate-clockwise"></i> Reopen</button>
                                   <button class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1" data-delete-report="${escapeHtml(report.id)}" type="button" title="Delete closed safety report"><i class="ti ti-trash"></i> Delete</button>`}
                        </div>
                    </div>
                </div>
            </div>`;
        })
        .join("");

    list.querySelectorAll("[data-select-report]").forEach((cb) => {
        cb.addEventListener("change", (e) => {
            const id = cb.dataset.selectReport;
            if (e.target.checked) selectedReportIds.add(id);
            else selectedReportIds.delete(id);
            updateReportsBulkBar();
        });
    });

    list.querySelectorAll("[data-view-report]").forEach((btn) => {
        btn.addEventListener("click", () => openReportDetailDrawer(btn.dataset.viewReport));
    });

    list.querySelectorAll("[data-resolve-report]").forEach((btn) => {
        btn.addEventListener("click", () => withButtonSpinner(btn, () => actOnReport(btn.dataset.resolveReport, "resolve")));
    });
    list.querySelectorAll("[data-dismiss-report]").forEach((btn) => {
        btn.addEventListener("click", () => withButtonSpinner(btn, () => actOnReport(btn.dataset.dismissReport, "dismiss")));
    });
    list.querySelectorAll("[data-reopen-report]").forEach((btn) => {
        btn.addEventListener("click", () => withButtonSpinner(btn, () => actOnReport(btn.dataset.reopenReport, "reopen")));
    });
    list.querySelectorAll("[data-delete-report]").forEach((btn) => {
        btn.addEventListener("click", () => handleDeleteReport(btn.dataset.deleteReport, btn));
    });
}

async function handleDeleteReport(reportId, btn = null) {
    const confirmed = await showTablerConfirm(
        "Permanently delete this resolved/dismissed safety report? This action cannot be undone.",
        {
            title: "Delete Safety Report",
            variant: "danger",
            confirmText: "Delete Permanently"
        }
    );
    if (!confirmed) return false;
    let deleted = false;
    await withButtonSpinner(btn, async () => {
        try {
            await adminDelete(`/safety/reports/${reportId}`);
            selectedReportIds.delete(reportId);
            currentSafetyReports = currentSafetyReports.filter((r) => r.id !== reportId);
            renderSafetyReports(currentSafetyReports);
            toast("Safety report deleted.");
            deleted = true;
        } catch (error) {
            toast(error.message, "error");
        }
    });
    return deleted;
}

async function handleBulkDeleteReports(btn) {
    const ids = [...selectedReportIds];
    if (!ids.length) return;
    const confirmed = await showTablerConfirm(
        `Permanently delete ${ids.length} selected resolved/dismissed safety report(s)? This action cannot be undone.`,
        {
            title: `Delete ${ids.length} Safety Report(s)`,
            variant: "danger",
            confirmText: `Delete ${ids.length} Report(s)`
        }
    );
    if (!confirmed) return;
    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost("/safety/reports/bulk-delete", { ids });
            ids.forEach((id) => selectedReportIds.delete(id));
            toast(`Deleted ${res.deletedCount ?? res.count ?? ids.length} safety report(s).`);
            await loadSafetyReports();
        } catch (error) {
            toast(error.message, "error");
        }
    });
}

// ---------------------------------------------------------------------
// Safety Report Details Window / Drawer (Redesigned)
// ---------------------------------------------------------------------

export async function openReportDetailDrawer(reportId) {
    stopTracking();
    showReadOnlyDrawer("Safety Report Details", `
        <div class="text-center py-5">
            <div class="spinner-border text-warning mb-2" role="status"></div>
            <div class="text-secondary small">Loading safety report details...</div>
        </div>
    `);

    try {
        let rep = null;
        const cached = currentSafetyReports.find((r) => r.id === reportId);
        try {
            const response = await adminGet(`/safety/reports/${encodeURIComponent(reportId)}`);
            rep = response?.report || cached;
        } catch {
            rep = cached;
        }

        if (!rep) {
            showReadOnlyDrawer("Safety Report Details", `<p class="text-danger text-center py-4 my-0">Unable to retrieve safety report record.</p>`);
            return;
        }

        const statusStr = String(rep.status || "open").toLowerCase();
        const isOpen = statusStr === "open";
        const canDelete = isDeletableStatus(statusStr);
        const categoryLabel = String(rep.category || "general").replace(/_/g, " ");
        const contactsHtml = formatEmergencyContacts(rep.emergency_contacts);
        const driverAssigned = rep.driver_id || (rep.driver_name && !["Unassigned", "Not applicable", "Unable to retrieve"].includes(rep.driver_name));
        const vehicleSummary = [
            rep.vehicle_type && !["Not available", "Not applicable"].includes(rep.vehicle_type)
                ? String(rep.vehicle_type).toUpperCase()
                : "",
            rep.vehicle_number && !["Not recorded", "Not applicable"].includes(rep.vehicle_number)
                ? String(rep.vehicle_number)
                : ""
        ].filter(Boolean).join(" &bull; ") || (driverAssigned ? "Not recorded" : "Not applicable");

        const fareDisplay = rep.fare !== null && rep.fare !== undefined && rep.fare !== ""
            ? `₹${escapeHtml(rep.fare)}`
            : (rep.ride_id ? "Not recorded" : "Not applicable");

        const html = `
            <!-- Header Summary Card -->
            <div class="admin-detail-header-card ${isOpen ? "border-warning bg-warning-lt" : "border-secondary bg-light"} mb-3">
                <div class="d-flex flex-wrap align-items-start justify-content-between gap-2">
                    <div>
                        <div class="d-flex align-items-center gap-2 mb-1">
                            <span class="badge ${isOpen ? "bg-warning text-dark" : "bg-secondary text-white"} text-uppercase">
                                <i class="ti ti-flag me-1"></i>${escapeHtml(statusStr)}
                            </span>
                            <span class="badge bg-orange-lt text-orange text-capitalize">
                                Category: ${escapeHtml(categoryLabel)}
                            </span>
                            <span class="text-secondary small">ID: <code>${escapeHtml(rep.id || reportId)}</code></span>
                        </div>
                        <h4 class="m-0 fw-bold text-dark text-capitalize">${escapeHtml(categoryLabel)} &mdash; Safety Report</h4>
                        <div class="text-secondary small mt-1">
                            Submitted: <strong>${escapeHtml(formatWhen(rep.submitted_at || rep.createdAt))}</strong>
                            ${rep.updated_at ? ` &bull; Updated: <strong>${escapeHtml(formatWhen(rep.updated_at))}</strong>` : ""}
                        </div>
                    </div>
                    <div class="d-flex flex-wrap gap-2">
                        ${isOpen
                            ? `<button type="button" class="btn btn-sm btn-primary" id="drawer-report-resolve-btn"><i class="ti ti-check me-1"></i>Resolve</button>
                               <button type="button" class="btn btn-sm btn-outline-secondary" id="drawer-report-dismiss-btn"><i class="ti ti-x me-1"></i>Dismiss</button>`
                            : `<button type="button" class="btn btn-sm btn-outline-secondary" id="drawer-report-reopen-btn"><i class="ti ti-rotate-clockwise me-1"></i>Reopen</button>`}
                        ${canDelete
                            ? `<button type="button" class="btn btn-sm btn-outline-danger" id="drawer-report-delete-btn"><i class="ti ti-trash me-1"></i>Delete</button>`
                            : ""}
                    </div>
                </div>
                <div class="w-100 mt-2 p-3 rounded bg-white border small" style="box-sizing: border-box; word-break: break-word; overflow-wrap: anywhere;">
                    <strong class="text-dark d-block mb-1"><i class="ti ti-blockquote me-1 text-warning"></i>Statement / Description:</strong>
                    <div class="text-secondary" style="word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap;">${escapeHtml(rep.description || "No statement text provided.")}</div>
                </div>
            </div>

            <!-- Section 1: Reporter Details -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-user-check text-warning me-2"></i>
                    <span>Reporter &amp; Passenger Details</span>
                    <span class="badge bg-blue-lt text-blue ms-auto text-capitalize">Reporter Role: ${escapeHtml(rep.reporter_role || "passenger")}</span>
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Reporter Name</span>
                        <strong class="admin-detail-value">${escapeHtml(rep.reporter_name || "Unable to retrieve")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Reporter Phone</span>
                        <span class="admin-detail-value">
                            ${rep.reporter_phone && rep.reporter_phone !== "Not recorded"
                                ? `<a href="tel:${escapeHtml(rep.reporter_phone)}" class="fw-bold text-primary text-decoration-none"><i class="ti ti-phone me-1"></i>${escapeHtml(rep.reporter_phone)}</a>`
                                : `<span class="text-muted">${escapeHtml(rep.reporter_phone || "Not recorded")}</span>`}
                        </span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Passenger Name</span>
                        <strong class="admin-detail-value">${escapeHtml(rep.passenger_name || "Unable to retrieve")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Passenger Phone</span>
                        <span class="admin-detail-value">${escapeHtml(rep.passenger_phone || "Not recorded")}</span>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Emergency Contacts</span>
                        <div class="admin-detail-value mt-1">${contactsHtml}</div>
                    </div>
                </div>
            </div>

            <!-- Section 2: Reported Party & Driver Details -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-steering-wheel text-primary me-2"></i>
                    <span>Reported Party &amp; Driver Details</span>
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Reported Party</span>
                        <strong class="admin-detail-value">${escapeHtml(rep.reported_party_name || "Not applicable")} <span class="text-secondary fw-normal">(${escapeHtml(rep.reported_party_role || "Not applicable")})</span></strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Reported Party Phone</span>
                        <span class="admin-detail-value">${escapeHtml(rep.reported_party_phone || "Not applicable")}</span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Driver Name</span>
                        <strong class="admin-detail-value">${escapeHtml(rep.driver_name || "Not applicable")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Vehicle Details</span>
                        <strong class="admin-detail-value">${vehicleSummary}</strong>
                    </div>
                </div>
            </div>

            <!-- Section 3: Associated Ride Details -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-map-pins text-secondary me-2"></i>
                    <span>Associated Ride Information</span>
                    ${rep.ride_id ? `<code class="ms-auto small">${escapeHtml(rep.ride_id)}</code>` : `<span class="ms-auto text-muted small">No linked ride</span>`}
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Pickup Location</span>
                        <strong class="admin-detail-value"><i class="ti ti-map-pin text-success me-1"></i>${escapeHtml(rep.pickup_name || "Not applicable")}</strong>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Destination Location</span>
                        <strong class="admin-detail-value"><i class="ti ti-flag text-danger me-1"></i>${escapeHtml(rep.drop_name || "Not applicable")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Ride Status</span>
                        <strong class="admin-detail-value text-capitalize">${escapeHtml(rep.ride_status || "Not applicable")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Ride Fare</span>
                        <strong class="admin-detail-value">${fareDisplay}</strong>
                    </div>
                </div>
            </div>

            <!-- Section 4: Route & Location Snapshot Map -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-map-2 text-primary me-2"></i>
                    <span>Incident / Ride Location Map Snapshot</span>
                </div>
                <div class="p-3">
                    <div id="report-detail-map-readout" class="admin-track-readout text-secondary small mb-2">Loading map snapshot...</div>
                    <div id="report-detail-map" class="admin-track-map"></div>
                </div>
            </div>

            <!-- Collapsible Audit Metadata -->
            <details class="admin-collapsible mb-2">
                <summary class="admin-collapsible-summary">
                    <span><i class="ti ti-list-details me-2 text-secondary"></i>Audit &amp; Resolution Metadata</span>
                    <i class="ti ti-chevron-down admin-collapsible-chevron"></i>
                </summary>
                <div class="admin-collapsible-body">
                    <div class="admin-detail-grid">
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Report ID</span>
                            <code class="admin-detail-value">${escapeHtml(rep.id || reportId)}</code>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Reporter User ID</span>
                            <code class="admin-detail-value">${escapeHtml(rep.reporter_id || "Not recorded")}</code>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Handled By Admin</span>
                            <span class="admin-detail-value">${escapeHtml(rep.updated_by || (isOpen ? "Not applicable (Open)" : "Not recorded"))}</span>
                        </div>
                        <div class="admin-detail-cell">
                            <span class="admin-detail-label">Last Action Timestamp</span>
                            <span class="admin-detail-value">${escapeHtml(rep.updated_at ? formatWhen(rep.updated_at) : (isOpen ? "Not applicable (Open)" : "Not recorded"))}</span>
                        </div>
                    </div>
                </div>
            </details>
        `;

        const { bodyEl } = showReadOnlyDrawer("Safety Report Details", html);

        const mapEl = bodyEl.querySelector("#report-detail-map");
        const readoutEl = bodyEl.querySelector("#report-detail-map-readout");
        renderRideMap(mapEl, rep, { isSnapshot: true, readoutEl });

        bodyEl.querySelector("#drawer-report-resolve-btn")?.addEventListener("click", async (e) => {
            await withButtonSpinner(e.currentTarget, async () => {
                await actOnReport(reportId, "resolve");
                openReportDetailDrawer(reportId);
            });
        });
        bodyEl.querySelector("#drawer-report-dismiss-btn")?.addEventListener("click", async (e) => {
            await withButtonSpinner(e.currentTarget, async () => {
                await actOnReport(reportId, "dismiss");
                openReportDetailDrawer(reportId);
            });
        });
        bodyEl.querySelector("#drawer-report-reopen-btn")?.addEventListener("click", async (e) => {
            await withButtonSpinner(e.currentTarget, async () => {
                await actOnReport(reportId, "reopen");
                openReportDetailDrawer(reportId);
            });
        });
        bodyEl.querySelector("#drawer-report-delete-btn")?.addEventListener("click", async (e) => {
            const deleted = await handleDeleteReport(reportId, e.currentTarget);
            if (deleted) closeDrawer(true);
        });
    } catch (error) {
        showReadOnlyDrawer("Safety Report Details", `<p class="text-danger text-center py-4 my-0">${escapeHtml(error.message)}</p>`);
    }
}

async function actOnReport(reportId, action) {
    try {
        await adminPatch(`/safety/reports/${reportId}`, { action });
        if (action === "reopen") selectedReportIds.delete(reportId);
        toast(`Report ${action === "resolve" ? "resolved" : action === "dismiss" ? "dismissed" : "reopened"}.`);
        await loadSafetyReports();
        refreshSafetyBadge();
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Section wiring & Realtime Badges
// ---------------------------------------------------------------------

export function loadSafety() {
    return Promise.all([loadSosAlerts(), loadSafetyReports(), refreshSafetyBadge()]);
}

export async function refreshSafetyBadge() {
    const badge = $("admin-safety-nav-badge");
    if (!badge) return;
    try {
        const overview = await adminGet("/overview", {}, { cacheable: true });
        const count = overview?.safety?.openSosAlerts || 0;
        badge.innerText = `(${count})`;
        badge.classList.toggle("d-none", count === 0);
    } catch {
        badge.classList.add("d-none");
    }
}

let sosListenerStarted = false;
let knownOpenSosIds = new Set();
let firstSosSnapshot = true;

export function startSosRealtimeAlerts() {
    if (sosListenerStarted) return;
    sosListenerStarted = true;
    const q = query(collection(db, "sosAlerts"), where("status", "==", "open"), orderBy("createdAt", "desc"), limit(50));
    onSnapshot(
        q,
        (snap) => {
            const badge = $("admin-safety-nav-badge");
            if (badge) {
                badge.innerText = `(${snap.size})`;
                badge.classList.toggle("d-none", snap.size === 0);
            }
            if (!firstSosSnapshot) {
                snap.docChanges().forEach((change) => {
                    if (change.type === "added" && !knownOpenSosIds.has(change.doc.id)) {
                        toast("New SOS alert -- open the Safety section.", "error");
                    }
                });
            }
            firstSosSnapshot = false;
            knownOpenSosIds = new Set(snap.docs.map((d) => d.id));
        },
        (error) => {
            if (!auth.currentUser) return;
            console.warn("[admin-safety] SOS realtime listener error:", error);
        }
    );
}

document.querySelectorAll(".admin-safety-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        activeSafetyTab = tab.dataset.safetyTab;
        document.querySelectorAll(".admin-safety-tab").forEach((t) => t.classList.toggle("active", t === tab));
        $("safety-sos-panel")?.classList.toggle("d-none", activeSafetyTab !== "sos");
        $("safety-sos-list")?.classList.toggle("d-none", activeSafetyTab !== "sos");
        $("safety-reports-panel")?.classList.toggle("d-none", activeSafetyTab !== "reports");
        $("safety-reports-list")?.classList.toggle("d-none", activeSafetyTab !== "reports");
    });
});

$("safety-sos-status-filter")?.addEventListener("change", () => {
    selectedSosIds.clear();
    loadSosAlerts();
});
$("safety-reports-status-filter")?.addEventListener("change", () => {
    selectedReportIds.clear();
    loadSafetyReports();
});

$("safety-sos-select-all")?.addEventListener("change", (e) => {
    const deletable = currentSosAlerts.filter((a) => isDeletableStatus(a.status));
    if (e.target.checked) {
        deletable.forEach((a) => selectedSosIds.add(a.id));
    } else {
        selectedSosIds.clear();
    }
    renderSosAlerts(currentSosAlerts);
});

$("safety-sos-bulk-delete-btn")?.addEventListener("click", (e) => {
    handleBulkDeleteSos(e.currentTarget);
});

$("safety-reports-select-all")?.addEventListener("change", (e) => {
    const deletable = currentSafetyReports.filter((r) => isDeletableStatus(r.status));
    if (e.target.checked) {
        deletable.forEach((r) => selectedReportIds.add(r.id));
    } else {
        selectedReportIds.clear();
    }
    renderSafetyReports(currentSafetyReports);
});

$("safety-reports-bulk-delete-btn")?.addEventListener("click", (e) => {
    handleBulkDeleteReports(e.currentTarget);
});
