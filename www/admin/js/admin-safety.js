import { adminGet, adminPatch } from "./admin-api.js";
import { showConfirm } from "../../js/shared/dialog.js";
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

// ---------------------------------------------------------------------
// SOS Alerts
// ---------------------------------------------------------------------

async function loadSosAlerts() {
    const list = $("safety-sos-list");
    const status = $("safety-sos-status-filter")?.value || "open";
    list.innerHTML = `<div class="admin-empty-row">Loading...</div>`;
    try {
        const data = await adminGet("/safety/sos-alerts", { status });
        renderSosAlerts(data.alerts || []);
    } catch (error) {
        list.innerHTML = `<p class="admin-empty-row">${escapeHtml(error.message)}</p>`;
    }
}

function renderSosAlerts(alerts) {
    const list = $("safety-sos-list");
    if (!alerts.length) {
        list.innerHTML = `<p class="admin-empty-row">No SOS alerts in this view.</p>`;
        return;
    }
    list.innerHTML = alerts
        .map((alert) => {
            const link = mapLink(alert.location);
            return `<div class="admin-ride-card admin-safety-card ${alert.status === "open" ? "is-urgent" : ""}">
                <span class="status-pill status-pill-${alert.status === "open" ? "red" : "grey"}">${escapeHtml(alert.status || "open")}</span>
                <span><strong>${escapeHtml(alert.reporter_name || "Reporter")}</strong> (${escapeHtml(alert.reporter_role || "unknown")})</span>
                <span>${escapeHtml(alert.pickup_name || "")} &rarr; ${escapeHtml(alert.drop_name || "")}</span>
                ${alert.note ? `<span>"${escapeHtml(alert.note)}"</span>` : ""}
                <span class="admin-muted-line">${formatWhen(alert.createdAt)}</span>
                <div class="admin-ride-card-actions">
                    ${link ? `<a class="admin-btn-outline" href="${link}" target="_blank" rel="noopener">Open Location</a>` : ""}
                    ${alert.status === "open"
                        ? `<button class="admin-btn-primary" data-resolve-sos="${alert.id}" type="button">Mark Resolved</button>`
                        : `<button class="admin-btn-outline" data-reopen-sos="${alert.id}" type="button">Reopen</button>`}
                </div>
            </div>`;
        })
        .join("");

    list.querySelectorAll("[data-resolve-sos]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            if (!(await showConfirm("Mark this SOS alert as resolved?"))) return;
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
    list.querySelectorAll("[data-reopen-sos]").forEach((btn) => {
        btn.addEventListener("click", async () => {
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
}

// ---------------------------------------------------------------------
// Safety Reports
// ---------------------------------------------------------------------

async function loadSafetyReports() {
    const list = $("safety-reports-list");
    const status = $("safety-reports-status-filter")?.value || "open";
    list.innerHTML = `<div class="admin-empty-row">Loading...</div>`;
    try {
        const data = await adminGet("/safety/reports", { status });
        renderSafetyReports(data.reports || []);
    } catch (error) {
        list.innerHTML = `<p class="admin-empty-row">${escapeHtml(error.message)}</p>`;
    }
}

function renderSafetyReports(reports) {
    const list = $("safety-reports-list");
    if (!reports.length) {
        list.innerHTML = `<p class="admin-empty-row">No safety reports in this view.</p>`;
        return;
    }
    list.innerHTML = reports
        .map((report) => `<div class="admin-ride-card admin-safety-card">
            <span class="status-pill status-pill-${report.status === "open" ? "red" : "grey"}">${escapeHtml(report.status || "open")}</span>
            <span><strong>${escapeHtml(report.category || "other").replace(/_/g, " ")}</strong> by ${escapeHtml(report.reporter_name || report.reporter_role || "user")}</span>
            ${report.description ? `<span>${escapeHtml(report.description)}</span>` : ""}
            ${report.ride_id ? `<span class="admin-muted-line">Ride: ${escapeHtml(report.ride_id)}</span>` : ""}
            <span class="admin-muted-line">${formatWhen(report.createdAt)}</span>
            <div class="admin-ride-card-actions">
                ${report.status === "open"
                    ? `<button class="admin-btn-primary" data-resolve-report="${report.id}" type="button">Resolve</button>
                       <button class="admin-btn-outline" data-dismiss-report="${report.id}" type="button">Dismiss</button>`
                    : `<button class="admin-btn-outline" data-reopen-report="${report.id}" type="button">Reopen</button>`}
            </div>
        </div>`)
        .join("");

    list.querySelectorAll("[data-resolve-report]").forEach((btn) => {
        btn.addEventListener("click", () => actOnReport(btn.dataset.resolveReport, "resolve"));
    });
    list.querySelectorAll("[data-dismiss-report]").forEach((btn) => {
        btn.addEventListener("click", () => actOnReport(btn.dataset.dismissReport, "dismiss"));
    });
    list.querySelectorAll("[data-reopen-report]").forEach((btn) => {
        btn.addEventListener("click", () => actOnReport(btn.dataset.reopenReport, "reopen"));
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
        badge.innerText = count;
        badge.classList.toggle("d-none", count === 0);
    } catch {
        badge.classList.add("d-none");
    }
}

// Real-time: an SOS is an emergency, so this listens directly on Firestore
// (permitted by firestore.rules' isAdmin() read grant on sosAlerts) instead
// of waiting for the next poll -- a new open alert instantly bumps the nav
// badge and pops a toast, even if the admin is on another section.
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
                badge.innerText = snap.size;
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
