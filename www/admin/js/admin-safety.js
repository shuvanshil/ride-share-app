import { adminGet, adminPatch } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";
import { showReadOnlyDrawer } from "./admin-drawer.js";
import { trackRideOnMap, stopTracking } from "./admin-live.js";
import { db, auth } from "../../js/platform/firebase-init.js";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let activeSafetyTab = "sos";

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function formatWhen(value) {
    if (!value) return "";
    try {
        return new Date(value).toLocaleString();
    } catch {
        return "";
    }
}

function mapLink(location) {
    if (!location?.lat || !location?.lng) return "";
    return `https://www.google.com/maps?q=${location.lat},${location.lng}`;
}

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
// SOS Alerts List
// ---------------------------------------------------------------------

async function loadSosAlerts() {
    const list = $("safety-sos-list");
    const status = $("safety-sos-status-filter")?.value || "open";
    list.innerHTML = `
        <div class="col-12 text-center py-5">
            <div class="spinner-border text-danger mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading SOS alerts...</div>
        </div>
    `;
    try {
        const data = await adminGet("/safety/sos-alerts", { status });
        renderSosAlerts(data.alerts || []);
    } catch (error) {
        list.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
    }
}

function renderSosAlerts(alerts) {
    const list = $("safety-sos-list");
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
            const link = mapLink(alert.location);
            const isUrgent = alert.status === "open";
            return `
            <div class="col-12">
                <div class="card card-sm border-0 shadow-xs ${isUrgent ? 'border-start border-3 border-danger' : ''}">
                    <div class="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge ${isUrgent ? 'bg-danger-lt text-danger' : 'bg-secondary-lt text-secondary'}">
                                ${isUrgent ? '<i class="ti ti-alert-triangle me-1"></i>' : ''}${escapeHtml(alert.status || "open")}
                            </span>
                            <div>
                                <strong class="d-block">${escapeHtml(alert.reporter_name || "Reporter")} <span class="text-muted font-weight-normal">(${escapeHtml(alert.reporter_role || "unknown")})</span></strong>
                                <small class="text-secondary">${escapeHtml(alert.pickup_name || "")} &rarr; ${escapeHtml(alert.drop_name || "")}</small>
                            </div>
                        </div>
                        ${alert.note ? `<div class="text-secondary small fst-italic">"${escapeHtml(alert.note)}"</div>` : ""}
                        <div class="text-secondary small ms-auto me-3">${formatWhen(alert.createdAt)}</div>
                        <div class="d-flex align-items-center gap-2">
                            <button class="btn btn-outline-info btn-sm d-inline-flex align-items-center gap-1" data-view-sos="${alert.id}" type="button">
                                <i class="ti ti-eye"></i> View Details
                            </button>
                            ${link ? `<a class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" href="${link}" target="_blank" rel="noopener"><i class="ti ti-map-pin"></i> Open Location</a>` : ""}
                            ${alert.status === "open"
                                ? `<button class="btn btn-primary btn-sm d-inline-flex align-items-center gap-1" data-resolve-sos="${alert.id}" type="button"><i class="ti ti-check"></i> Mark Resolved</button>`
                                : `<button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-reopen-sos="${alert.id}" type="button"><i class="ti ti-rotate-clockwise"></i> Reopen</button>`}
                        </div>
                    </div>
                </div>
            </div>`;
        })
        .join("");

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
                    loadSosAlerts();
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
                    toast("SOS alert reopened.");
                    loadSosAlerts();
                    refreshSafetyBadge();
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
    });
}

// ---------------------------------------------------------------------
// SOS Details Window / Drawer
// ---------------------------------------------------------------------

async function openSosDetailDrawer(alertId) {
    showReadOnlyDrawer("SOS Alert Incident Details", `
        <div class="text-center py-5">
            <div class="spinner-border text-danger mb-2" role="status"></div>
            <div class="text-secondary small">Loading full emergency details...</div>
        </div>
    `);

    try {
        const alertSnap = await getDoc(doc(db, "sosAlerts", alertId));
        if (!alertSnap.exists()) {
            showReadOnlyDrawer("SOS Alert Incident Details", `<p class="text-danger text-center py-4 my-0">SOS alert record not found.</p>`);
            return;
        }
        const alertData = alertSnap.data();

        // Fetch Passenger doc
        const passengerId = alertData.passenger_id || alertData.passengerId || alertData.reporter_id;
        let passenger = {};
        if (passengerId) {
            const pSnap = await getDoc(doc(db, "users", passengerId));
            if (pSnap.exists()) passenger = pSnap.data();
        }

        // Fetch Driver doc
        const driverId = alertData.driver_id || alertData.driverId;
        let driver = {};
        if (driverId) {
            const dSnap = await getDoc(doc(db, "users", driverId));
            if (dSnap.exists()) driver = dSnap.data();
        }

        // Fetch Ride doc
        const rideId = alertData.ride_id || alertData.rideId;
        let ride = {};
        if (rideId) {
            const rSnap = await getDoc(doc(db, "rides", rideId));
            if (rSnap.exists()) ride = rSnap.data();
        }

        const emergencyContacts = passenger.emergencyContacts || passenger.emergency_contacts || passenger.emergencyPhone || [];
        let contactsHtml = "None registered";
        if (Array.isArray(emergencyContacts) && emergencyContacts.length > 0) {
            contactsHtml = emergencyContacts.map(c => typeof c === 'object' ? `${escapeHtml(c.name || 'Contact')}: ${escapeHtml(c.phone || c.number || '')}` : escapeHtml(c)).join(", ");
        } else if (typeof emergencyContacts === 'string' && emergencyContacts.trim()) {
            contactsHtml = escapeHtml(emergencyContacts);
        }

        const html = `
            <div class="alert alert-danger border-danger shadow-xs mb-3" role="alert">
                <div class="d-flex align-items-center justify-content-between">
                    <div>
                        <h4 class="alert-title fw-bold mb-1"><i class="ti ti-alert-triangle me-1"></i>SOS EMERGENCY ALERT</h4>
                        <div class="small">Status: <strong>${(alertData.status || "open").toUpperCase()}</strong> &bull; ${formatWhen(alertData.createdAt)}</div>
                    </div>
                    ${alertData.status === "open" ? `<span class="badge bg-danger text-white p-2">URGENT ACTION</span>` : `<span class="badge bg-secondary text-white p-2">RESOLVED</span>`}
                </div>
                ${alertData.note ? `<div class="mt-2 text-dark font-weight-bold">Note: "${escapeHtml(alertData.note)}"</div>` : ""}
            </div>

            <h4 class="admin-drawer-subsection text-danger"><i class="ti ti-user-check me-1"></i>Passenger Details</h4>
            <div class="admin-detail-row"><span>Passenger Name</span><strong>${escapeHtml(passenger.name || alertData.reporter_name || "Unknown")}</strong></div>
            <div class="admin-detail-row"><span>Mobile Number</span><a href="tel:${escapeHtml(passenger.phone || alertData.reporter_phone || "")}" class="fw-bold text-primary"><i class="ti ti-phone me-1"></i>${escapeHtml(passenger.phone || alertData.reporter_phone || "Not recorded")}</a></div>
            <div class="admin-detail-row"><span>Emergency Contacts</span><strong class="text-danger">${contactsHtml}</strong></div>

            <h4 class="admin-drawer-subsection text-primary"><i class="ti ti-steering-wheel me-1"></i>Driver Details</h4>
            <div class="admin-detail-row"><span>Driver Name</span><strong>${escapeHtml(driver.name || ride.driver_name || "Unassigned")}</strong></div>
            <div class="admin-detail-row"><span>Mobile Number</span><a href="tel:${escapeHtml(driver.phone || "")}" class="fw-bold text-primary"><i class="ti ti-phone me-1"></i>${escapeHtml(driver.phone || "Not recorded")}</a></div>
            <div class="admin-detail-row"><span>Vehicle Info</span><strong>${escapeHtml((driver.vehicleType || ride.vehicle_type || "").toUpperCase())} ${escapeHtml(driver.vehicleNumber || ride.vehicle_number || "")}</strong></div>

            <h4 class="admin-drawer-subsection text-secondary"><i class="ti ti-map-pins me-1"></i>Ride &amp; Route Information</h4>
            <div class="admin-detail-row"><span>Pickup Location</span><strong>${escapeHtml(ride.pickup_name || alertData.pickup_name || "Not specified")}</strong></div>
            <div class="admin-detail-row"><span>Drop-off Location</span><strong>${escapeHtml(ride.drop_name || alertData.drop_name || "Not specified")}</strong></div>
            <div class="admin-detail-row"><span>Ride Status</span><strong>${(ride.status || alertData.ride_status || "N/A").toUpperCase()}</strong></div>

            <h4 class="admin-drawer-subsection text-dark"><i class="ti ti-map me-1"></i>Live Location &amp; Map</h4>
            <div id="sos-detail-map-readout" class="admin-track-readout text-primary mb-2">Connecting map...</div>
            <div id="sos-detail-map" class="admin-track-map mb-2"></div>
        `;

        const { bodyEl } = showReadOnlyDrawer("SOS Alert Incident Details", html);

        // Render Map
        if (rideId) {
            trackRideOnMap(bodyEl.querySelector("#sos-detail-map"), bodyEl.querySelector("#sos-detail-map-readout"), rideId);
        } else if (alertData.location?.lat && alertData.location?.lng) {
            const mapEl = bodyEl.querySelector("#sos-detail-map");
            mapEl.innerHTML = `<iframe width="100%" height="100%" style="border:0; border-radius:12px;" loading="lazy" allowfullscreen src="https://maps.google.com/maps?q=${alertData.location.lat},${alertData.location.lng}&z=15&output=embed"></iframe>`;
            bodyEl.querySelector("#sos-detail-map-readout").textContent = `GPS Location: ${alertData.location.lat}, ${alertData.location.lng}`;
        } else {
            bodyEl.querySelector("#sos-detail-map-readout").textContent = "Location coordinates not available.";
        }
    } catch (error) {
        showReadOnlyDrawer("SOS Alert Incident Details", `<p class="text-danger text-center py-4 my-0">${escapeHtml(error.message)}</p>`);
    }
}

// ---------------------------------------------------------------------
// Safety Reports List
// ---------------------------------------------------------------------

async function loadSafetyReports() {
    const list = $("safety-reports-list");
    const status = $("safety-reports-status-filter")?.value || "open";
    list.innerHTML = `
        <div class="col-12 text-center py-5">
            <div class="spinner-border text-warning mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading safety reports...</div>
        </div>
    `;
    try {
        const data = await adminGet("/safety/reports", { status });
        renderSafetyReports(data.reports || []);
    } catch (error) {
        list.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
    }
}

function renderSafetyReports(reports) {
    const list = $("safety-reports-list");
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
        .map((report) => `
        <div class="col-12">
            <div class="card card-sm border-0 shadow-xs">
                <div class="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
                    <div class="d-flex align-items-center gap-2">
                        <span class="badge ${report.status === "open" ? 'bg-warning-lt text-warning' : 'bg-secondary-lt text-secondary'}">
                            ${escapeHtml(report.status || "open")}
                        </span>
                        <div>
                            <strong>${escapeHtml(report.category || "other").replace(/_/g, " ")}</strong>
                            <small class="text-secondary ms-1">by ${escapeHtml(report.reporter_name || report.reporter_role || "user")}</small>
                        </div>
                    </div>
                    ${report.description ? `<div class="text-secondary small">${escapeHtml(report.description)}</div>` : ""}
                    ${report.ride_id ? `<div class="text-muted small">Ride: ${escapeHtml(report.ride_id)}</div>` : ""}
                    <div class="text-secondary small ms-auto me-3">${formatWhen(report.createdAt)}</div>
                    <div class="d-flex align-items-center gap-2">
                        <button class="btn btn-outline-info btn-sm d-inline-flex align-items-center gap-1" data-view-report="${report.id}" type="button">
                            <i class="ti ti-eye"></i> View Details
                        </button>
                        ${report.status === "open"
                            ? `<button class="btn btn-primary btn-sm d-inline-flex align-items-center gap-1" data-resolve-report="${report.id}" type="button"><i class="ti ti-check"></i> Resolve</button>
                               <button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-dismiss-report="${report.id}" type="button"><i class="ti ti-x"></i> Dismiss</button>`
                            : `<button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-reopen-report="${report.id}" type="button"><i class="ti ti-rotate-clockwise"></i> Reopen</button>`}
                    </div>
                </div>
            </div>
        </div>`)
        .join("");

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
}

// ---------------------------------------------------------------------
// Safety Report Details Window / Drawer
// ---------------------------------------------------------------------

async function openReportDetailDrawer(reportId) {
    showReadOnlyDrawer("Safety Report Details", `
        <div class="text-center py-5">
            <div class="spinner-border text-warning mb-2" role="status"></div>
            <div class="text-secondary small">Loading safety report details...</div>
        </div>
    `);

    try {
        const reportSnap = await getDoc(doc(db, "safetyReports", reportId));
        if (!reportSnap.exists()) {
            showReadOnlyDrawer("Safety Report Details", `<p class="text-danger text-center py-4 my-0">Safety report record not found.</p>`);
            return;
        }
        const rep = reportSnap.data();

        // Fetch Passenger & Driver docs if present
        let passenger = {};
        const passengerId = rep.passenger_id || rep.reporter_id;
        if (passengerId) {
            const pSnap = await getDoc(doc(db, "users", passengerId));
            if (pSnap.exists()) passenger = pSnap.data();
        }

        let driver = {};
        const driverId = rep.driver_id;
        if (driverId) {
            const dSnap = await getDoc(doc(db, "users", driverId));
            if (dSnap.exists()) driver = dSnap.data();
        }

        let ride = {};
        if (rep.ride_id) {
            const rSnap = await getDoc(doc(db, "rides", rep.ride_id));
            if (rSnap.exists()) ride = rSnap.data();
        }

        const emergencyContacts = passenger.emergencyContacts || passenger.emergency_contacts || passenger.emergencyPhone || [];
        let contactsHtml = "None registered";
        if (Array.isArray(emergencyContacts) && emergencyContacts.length > 0) {
            contactsHtml = emergencyContacts.map(c => typeof c === 'object' ? `${escapeHtml(c.name || 'Contact')}: ${escapeHtml(c.phone || c.number || '')}` : escapeHtml(c)).join(", ");
        } else if (typeof emergencyContacts === 'string' && emergencyContacts.trim()) {
            contactsHtml = escapeHtml(emergencyContacts);
        }

        const html = `
            <div class="alert alert-warning border-warning shadow-xs mb-3" role="alert">
                <div class="d-flex align-items-center justify-content-between">
                    <div>
                        <h4 class="alert-title fw-bold mb-1"><i class="ti ti-report me-1"></i>SAFETY REPORT</h4>
                        <div class="small">Category: <strong>${escapeHtml(rep.category || "General").toUpperCase()}</strong> &bull; ${formatWhen(rep.createdAt)}</div>
                    </div>
                    <span class="badge ${rep.status === "open" ? 'bg-warning text-dark' : 'bg-secondary text-white'} p-2">${(rep.status || "open").toUpperCase()}</span>
                </div>
                ${rep.description ? `<div class="mt-2 text-dark font-weight-bold">Description: "${escapeHtml(rep.description)}"</div>` : ""}
            </div>

            <h4 class="admin-drawer-subsection text-warning"><i class="ti ti-user-check me-1"></i>Reporter &amp; Passenger Info</h4>
            <div class="admin-detail-row"><span>Passenger Name</span><strong>${escapeHtml(passenger.name || rep.reporter_name || "Unknown")}</strong></div>
            <div class="admin-detail-row"><span>Mobile Number</span><a href="tel:${escapeHtml(passenger.phone || rep.reporter_phone || "")}" class="fw-bold text-primary"><i class="ti ti-phone me-1"></i>${escapeHtml(passenger.phone || rep.reporter_phone || "Not recorded")}</a></div>
            <div class="admin-detail-row"><span>Emergency Contacts</span><strong class="text-danger">${contactsHtml}</strong></div>

            <h4 class="admin-drawer-subsection text-primary"><i class="ti ti-steering-wheel me-1"></i>Driver Details</h4>
            <div class="admin-detail-row"><span>Driver Name</span><strong>${escapeHtml(driver.name || ride.driver_name || "Unassigned / N/A")}</strong></div>
            <div class="admin-detail-row"><span>Mobile Number</span><a href="tel:${escapeHtml(driver.phone || "")}" class="fw-bold text-primary"><i class="ti ti-phone me-1"></i>${escapeHtml(driver.phone || "Not recorded")}</a></div>
            <div class="admin-detail-row"><span>Vehicle Info</span><strong>${escapeHtml((driver.vehicleType || ride.vehicle_type || "").toUpperCase())} ${escapeHtml(driver.vehicleNumber || ride.vehicle_number || "")}</strong></div>

            <h4 class="admin-drawer-subsection text-secondary"><i class="ti ti-map-pins me-1"></i>Associated Ride Information</h4>
            <div class="admin-detail-row"><span>Ride ID</span><strong>${escapeHtml(rep.ride_id || "N/A")}</strong></div>
            <div class="admin-detail-row"><span>Pickup Location</span><strong>${escapeHtml(ride.pickup_name || "N/A")}</strong></div>
            <div class="admin-detail-row"><span>Drop-off Location</span><strong>${escapeHtml(ride.drop_name || "N/A")}</strong></div>
            <div class="admin-detail-row"><span>Ride Status</span><strong>${(ride.status || "N/A").toUpperCase()}</strong></div>
        `;

        showReadOnlyDrawer("Safety Report Details", html);
    } catch (error) {
        showReadOnlyDrawer("Safety Report Details", `<p class="text-danger text-center py-4 my-0">${escapeHtml(error.message)}</p>`);
    }
}

async function actOnReport(reportId, action) {
    try {
        await adminPatch(`/safety/reports/${reportId}`, { action });
        toast(`Report ${action === "resolve" ? "resolved" : action === "dismiss" ? "dismissed" : "reopened"}.`);
        loadSafetyReports();
        refreshSafetyBadge();
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Section wiring & Realtime Badges
// ---------------------------------------------------------------------

export function loadSafety() {
    loadSosAlerts();
    loadSafetyReports();
    refreshSafetyBadge();
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
    const q = query(collection(db, "sosAlerts"), where("status", "==", "open"), orderBy("createdAt", "desc"));
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
            if (!auth.currentUser) return; // Suppress error on logout
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

$("safety-sos-status-filter")?.addEventListener("change", loadSosAlerts);
$("safety-reports-status-filter")?.addEventListener("change", loadSafetyReports);
