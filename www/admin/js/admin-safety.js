import { adminGet, adminPatch } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";
import { db } from "../../js/platform/firebase-init.js";
import { collection, onSnapshot, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
        await actionFn();
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ---------------------------------------------------------------------
// SOS Alerts
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
// Safety Reports
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
                        ${report.status === "open"
                            ? `<button class="btn btn-primary btn-sm d-inline-flex align-items-center gap-1" data-resolve-report="${report.id}" type="button"><i class="ti ti-check"></i> Resolve</button>
                               <button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-dismiss-report="${report.id}" type="button"><i class="ti ti-x"></i> Dismiss</button>`
                            : `<button class="btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-1" data-reopen-report="${report.id}" type="button"><i class="ti ti-rotate-clockwise"></i> Reopen</button>`}
                    </div>
                </div>
            </div>
        </div>`)
        .join("");

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
// Section wiring
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
