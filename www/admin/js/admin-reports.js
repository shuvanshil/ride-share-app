import { adminGet, adminPatch, adminPost, adminDelete } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";

const $ = (id) => document.getElementById(id);

let reportsState = {
    reports: [],
    selectedIds: new Set(),
    statusFilter: "open",
    severityFilter: "",
    sortOrder: "desc",
    searchQuery: "",
    cursor: null,
    nextCursor: null,
    loading: false,
    currentReport: null,
};

export function initAdminReports() {
    $("reports-status-filter")?.addEventListener("change", (e) => {
        reportsState.statusFilter = e.target.value;
        loadAdminReports(true);
    });

    $("reports-severity-filter")?.addEventListener("change", (e) => {
        reportsState.severityFilter = e.target.value;
        loadAdminReports(true);
    });

    $("reports-sort-filter")?.addEventListener("change", (e) => {
        reportsState.sortOrder = e.target.value;
        loadAdminReports(true);
    });

    $("reports-search-input")?.addEventListener("input", (e) => {
        reportsState.searchQuery = e.target.value.trim().toLowerCase();
        renderReportsTable();
    });

    $("reports-refresh-btn")?.addEventListener("click", () => {
        loadAdminReports(true);
    });

    // Bulk actions
    $("reports-select-all")?.addEventListener("change", (e) => {
        const checked = e.target.checked;
        const visibleReports = getFilteredReports();
        if (checked) {
            visibleReports.forEach((r) => reportsState.selectedIds.add(r.failureId || r.id));
        } else {
            reportsState.selectedIds.clear();
        }
        updateBulkBar();
        renderReportsTable();
    });

    $("reports-bulk-resolve-btn")?.addEventListener("click", handleBulkResolve);
    $("reports-bulk-delete-btn")?.addEventListener("click", handleBulkDelete);

    // Detail Modal actions
    $("report-detail-resolve-btn")?.addEventListener("click", handleModalResolve);
    $("report-detail-delete-btn")?.addEventListener("click", handleModalDelete);
    $("report-detail-close-btn")?.addEventListener("click", closeReportModal);
    $("report-detail-modal-backdrop")?.addEventListener("click", closeReportModal);
    $("report-detail-copy-trace-btn")?.addEventListener("click", handleCopyTrace);
}

export async function loadAdminReports(resetCursor = false) {
    if (reportsState.loading) return;
    reportsState.loading = true;

    if (resetCursor) {
        reportsState.cursor = null;
        reportsState.selectedIds.clear();
        updateBulkBar();
    }

    const wrap = $("admin-reports-table-wrap");
    if (resetCursor && wrap) {
        wrap.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
                <div class="text-secondary small">Loading backend failure reports...</div>
            </div>
        `;
    }

    try {
        const params = {
            status: reportsState.statusFilter || undefined,
            severity: reportsState.severityFilter || undefined,
            sort_order: reportsState.sortOrder,
            cursor: reportsState.cursor || undefined,
            limit: 50,
        };

        const res = await adminGet("/failures", params);
        reportsState.reports = res.reports || [];
        reportsState.nextCursor = res.nextCursor || null;

        // Update navigation badge
        const badge = $("admin-reports-nav-badge");
        if (badge) {
            const count = res.openCount || 0;
            badge.textContent = count > 99 ? "99+" : count;
            badge.classList.toggle("d-none", count <= 0);
        }

        renderReportsTable();
    } catch (err) {
        toast(`Failed to load failure reports: ${err.message}`, "error");
        if (wrap) {
            wrap.innerHTML = `
                <div class="card shadow-xs border-0 text-center py-5">
                    <div class="text-danger mb-2"><i class="ti ti-alert-triangle fs-1"></i></div>
                    <div class="text-secondary small">Failed to load failure reports.</div>
                    <button class="btn btn-outline-primary btn-sm mx-auto mt-3" onclick="window.reloadReports()">Retry</button>
                </div>
            `;
        }
    } finally {
        reportsState.loading = false;
    }
}

window.reloadReports = () => loadAdminReports(true);

function getFilteredReports() {
    let list = [...reportsState.reports];
    if (reportsState.searchQuery) {
        const q = reportsState.searchQuery;
        list = list.filter((r) => {
            return (
                (r.service || "").toLowerCase().includes(q) ||
                (r.operation || "").toLowerCase().includes(q) ||
                (r.errorMessage || "").toLowerCase().includes(q) ||
                (r.errorType || "").toLowerCase().includes(q) ||
                (r.actorId || "").toLowerCase().includes(q) ||
                (r.resourceId || "").toLowerCase().includes(q) ||
                (r.failureId || r.id || "").toLowerCase().includes(q)
            );
        });
    }
    return list;
}

function updateBulkBar() {
    const bar = $("reports-bulk-bar");
    const countEl = $("reports-bulk-selected-count");
    const selectAllCheckbox = $("reports-select-all");
    const count = reportsState.selectedIds.size;

    if (bar && countEl) {
        if (count > 0) {
            bar.classList.remove("d-none");
            countEl.textContent = `${count} issue${count > 1 ? "s" : ""} selected`;
        } else {
            bar.classList.add("d-none");
        }
    }

    if (selectAllCheckbox) {
        const visible = getFilteredReports();
        selectAllCheckbox.checked = visible.length > 0 && visible.every((r) => reportsState.selectedIds.has(r.failureId || r.id));
        selectAllCheckbox.indeterminate = count > 0 && count < visible.length;
    }
}

function getSeverityBadge(sev) {
    const s = String(sev || "HIGH").toUpperCase();
    if (s === "CRITICAL") return `<span class="badge bg-red-lt text-red fw-bold"><i class="ti ti-flame me-1"></i>CRITICAL</span>`;
    if (s === "HIGH") return `<span class="badge bg-orange-lt text-orange fw-bold"><i class="ti ti-alert-circle me-1"></i>HIGH</span>`;
    if (s === "MEDIUM") return `<span class="badge bg-yellow-lt text-yellow fw-bold"><i class="ti ti-alert-triangle me-1"></i>MEDIUM</span>`;
    return `<span class="badge bg-blue-lt text-blue fw-bold"><i class="ti ti-info-circle me-1"></i>LOW</span>`;
}

function getStatusBadge(status) {
    const s = String(status || "open").toLowerCase();
    if (s === "resolved") return `<span class="badge bg-green-lt text-green fw-bold"><i class="ti ti-check me-1"></i>Resolved</span>`;
    if (s === "acknowledged") return `<span class="badge bg-azure-lt text-azure fw-bold"><i class="ti ti-eye me-1"></i>Acknowledged</span>`;
    return `<span class="badge bg-red text-white fw-bold"><i class="ti ti-alert-triangle me-1"></i>Open</span>`;
}

function formatDate(isoStr) {
    if (!isoStr) return "--";
    try {
        const d = new Date(isoStr);
        return d.toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
        });
    } catch {
        return isoStr;
    }
}

function renderReportsTable() {
    const wrap = $("admin-reports-table-wrap");
    if (!wrap) return;

    const reports = getFilteredReports();

    if (reports.length === 0) {
        wrap.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <div class="text-success mb-2"><i class="ti ti-circle-check fs-1"></i></div>
                <h3 class="h4 fw-bold mb-1">No Failure Reports Found</h3>
                <p class="text-secondary small mb-0">The backend failure reporting system currently has zero issues matching your filters.</p>
            </div>
        `;
        return;
    }

    const rowsHtml = reports
        .map((r) => {
            const fid = r.failureId || r.id;
            const isSelected = reportsState.selectedIds.has(fid);
            const isResolved = (r.status || "").toLowerCase() === "resolved";
            const occCount = r.occurrenceCount || 1;

            return `
            <tr class="${isSelected ? "table-active" : ""}" data-failure-id="${fid}">
                <td style="width: 40px;" onclick="event.stopPropagation();">
                    <input type="checkbox" class="form-check-input report-row-check" data-id="${fid}" ${isSelected ? "checked" : ""}>
                </td>
                <td>
                    ${getSeverityBadge(r.severity)}
                </td>
                <td>
                    <div class="fw-bold text-dark text-truncate" style="max-width: 200px;" title="${r.service || ""} -> ${r.operation || ""}">
                        ${r.service || "--"}&nbsp;<span class="text-secondary">/</span>&nbsp;${r.operation || "--"}
                    </div>
                    <div class="small text-secondary font-monospace text-truncate" style="max-width: 200px;">
                        ${r.endpoint || (r.actorType ? `Actor: ${r.actorType}` : "")}
                    </div>
                </td>
                <td>
                    <div class="fw-semibold text-danger text-truncate" style="max-width: 300px;" title="${r.errorMessage || r.errorType || ""}">
                        ${r.errorType || "Error"}: ${r.errorMessage || "--"}
                    </div>
                    <div class="small text-secondary text-truncate" style="max-width: 300px;">
                        ${r.recommendedAction || "Inspect logs"}
                    </div>
                </td>
                <td>
                    <span class="badge bg-secondary-lt text-dark fw-bold">
                        <i class="ti ti-repeat me-1"></i>${occCount}
                    </span>
                </td>
                <td>
                    <div class="small fw-semibold text-dark">${formatDate(r.lastSeenAt || r.timestamp)}</div>
                    <div class="text-secondary" style="font-size: 0.72rem;">First: ${formatDate(r.firstSeenAt || r.timestamp)}</div>
                </td>
                <td>
                    ${getStatusBadge(r.status)}
                </td>
                <td class="text-end" onclick="event.stopPropagation();">
                    <div class="d-flex justify-content-end gap-1">
                        <button type="button" class="btn btn-outline-primary btn-sm btn-icon report-view-btn" data-id="${fid}" title="View Details">
                            <i class="ti ti-eye"></i>
                        </button>
                        ${
                            isResolved
                                ? `<button type="button" class="btn btn-outline-warning btn-sm btn-icon report-reopen-btn" data-id="${fid}" title="Reopen Issue">
                                    <i class="ti ti-rotate-2"></i>
                                </button>`
                                : `<button type="button" class="btn btn-outline-success btn-sm btn-icon report-resolve-btn" data-id="${fid}" title="Mark Resolved">
                                    <i class="ti ti-check"></i>
                                </button>`
                        }
                        <button type="button" class="btn btn-outline-danger btn-sm btn-icon report-delete-btn" data-id="${fid}" title="Delete Record">
                            <i class="ti ti-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        })
        .join("");

    wrap.innerHTML = `
        <div class="card shadow-xs border-0">
            <div class="table-responsive">
                <table class="table table-vcenter table-hover card-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;"></th>
                            <th>Severity</th>
                            <th>Service / Operation</th>
                            <th>Error Details</th>
                            <th>Occurrences</th>
                            <th>Last Seen</th>
                            <th>Status</th>
                            <th class="text-end">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Bind row click & action events
    wrap.querySelectorAll(".report-row-check").forEach((cb) => {
        cb.addEventListener("change", (e) => {
            const fid = e.target.dataset.id;
            if (e.target.checked) {
                reportsState.selectedIds.add(fid);
            } else {
                reportsState.selectedIds.delete(fid);
            }
            updateBulkBar();
            renderReportsTable();
        });
    });

    wrap.querySelectorAll("tr[data-failure-id]").forEach((row) => {
        row.addEventListener("click", () => {
            const fid = row.dataset.failureId;
            openReportDetail(fid);
        });
    });

    wrap.querySelectorAll(".report-view-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            openReportDetail(btn.dataset.id);
        });
    });

    wrap.querySelectorAll(".report-resolve-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            resolveSingleReport(btn.dataset.id);
        });
    });

    wrap.querySelectorAll(".report-reopen-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            reopenSingleReport(btn.dataset.id);
        });
    });

    wrap.querySelectorAll(".report-delete-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteSingleReport(btn.dataset.id);
        });
    });
}

function openReportDetail(failureId) {
    const report = reportsState.reports.find((r) => (r.failureId || r.id) === failureId);
    if (!report) return;

    reportsState.currentReport = report;
    const isResolved = (report.status || "").toLowerCase() === "resolved";

    $("report-modal-failure-id").textContent = report.failureId || report.id;
    $("report-modal-fingerprint").textContent = report.fingerprint || "--";
    $("report-modal-severity").innerHTML = getSeverityBadge(report.severity);
    $("report-modal-status").innerHTML = getStatusBadge(report.status);
    $("report-modal-occurrences").textContent = report.occurrenceCount || 1;
    $("report-modal-environment").textContent = report.environment || "production";
    $("report-modal-first-seen").textContent = formatDate(report.firstSeenAt || report.timestamp);
    $("report-modal-last-seen").textContent = formatDate(report.lastSeenAt || report.timestamp);

    $("report-modal-service").textContent = report.service || "--";
    $("report-modal-operation").textContent = report.operation || "--";
    $("report-modal-endpoint").textContent = report.endpoint || "--";
    $("report-modal-actor").textContent = report.actorType ? `${report.actorType} (${report.actorId || "anon"})` : "--";
    $("report-modal-resource").textContent = report.resourceId || "--";

    $("report-modal-error-type").textContent = report.errorType || "Error";
    $("report-modal-error-code").textContent = report.errorCode || "500";
    $("report-modal-error-message").textContent = report.errorMessage || "--";
    $("report-modal-recommended-action").textContent = report.recommendedAction || "Inspect server error logs and state machine transitions.";

    // Context formatting
    const contextEl = $("report-modal-context");
    if (contextEl) {
        if (report.context && Object.keys(report.context).length > 0) {
            contextEl.textContent = JSON.stringify(report.context, null, 2);
            $("report-modal-context-wrap").classList.remove("d-none");
        } else {
            $("report-modal-context-wrap").classList.add("d-none");
        }
    }

    // Stack Trace
    const stackEl = $("report-modal-stack-trace");
    if (stackEl) {
        if (report.stackTrace) {
            stackEl.textContent = report.stackTrace;
            $("report-modal-stack-wrap").classList.remove("d-none");
        } else {
            $("report-modal-stack-wrap").classList.add("d-none");
        }
    }

    // Toggle button texts
    const resolveBtn = $("report-detail-resolve-btn");
    if (resolveBtn) {
        if (isResolved) {
            resolveBtn.className = "btn btn-outline-warning";
            resolveBtn.innerHTML = `<i class="ti ti-rotate-2 me-1"></i>Reopen Issue`;
        } else {
            resolveBtn.className = "btn btn-success";
            resolveBtn.innerHTML = `<i class="ti ti-check me-1"></i>Mark as Resolved`;
        }
    }

    const modal = $("admin-report-detail-modal");
    if (modal) {
        modal.classList.remove("d-none");
        modal.classList.add("show");
    }
}

function closeReportModal() {
    const modal = $("admin-report-detail-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.classList.remove("show");
    }
    reportsState.currentReport = null;
}

async function resolveSingleReport(failureId) {
    try {
        await adminPatch(`/failures/${failureId}`, { action: "resolve" });
        toast("Issue marked as resolved.", "success");
        loadAdminReports();
    } catch (err) {
        toast(`Failed to resolve issue: ${err.message}`, "error");
    }
}

async function reopenSingleReport(failureId) {
    try {
        await adminPatch(`/failures/${failureId}`, { action: "reopen" });
        toast("Issue reopened.", "info");
        loadAdminReports();
    } catch (err) {
        toast(`Failed to reopen issue: ${err.message}`, "error");
    }
}

async function deleteSingleReport(failureId) {
    const confirmed = await showTablerConfirm(
        "Delete Failure Report",
        "Are you sure you want to permanently delete this failure report record from the database?",
        "Delete Report",
        true
    );
    if (!confirmed) return;

    try {
        await adminDelete(`/failures/${failureId}`);
        toast("Failure report deleted successfully.", "success");
        reportsState.selectedIds.delete(failureId);
        loadAdminReports();
    } catch (err) {
        toast(`Failed to delete failure report: ${err.message}`, "error");
    }
}

async function handleModalResolve() {
    if (!reportsState.currentReport) return;
    const fid = reportsState.currentReport.failureId || reportsState.currentReport.id;
    const isResolved = (reportsState.currentReport.status || "").toLowerCase() === "resolved";
    const action = isResolved ? "reopen" : "resolve";

    try {
        await adminPatch(`/failures/${fid}`, { action });
        toast(isResolved ? "Issue reopened." : "Issue marked as resolved.", "success");
        closeReportModal();
        loadAdminReports();
    } catch (err) {
        toast(`Failed to update issue: ${err.message}`, "error");
    }
}

async function handleModalDelete() {
    if (!reportsState.currentReport) return;
    const fid = reportsState.currentReport.failureId || reportsState.currentReport.id;
    const confirmed = await showTablerConfirm(
        "Delete Failure Report",
        "Are you sure you want to permanently delete this failure report record from the database?",
        "Delete Report",
        true
    );
    if (!confirmed) return;

    try {
        await adminDelete(`/failures/${fid}`);
        toast("Failure report deleted.", "success");
        reportsState.selectedIds.delete(fid);
        closeReportModal();
        loadAdminReports();
    } catch (err) {
        toast(`Failed to delete report: ${err.message}`, "error");
    }
}

async function handleBulkResolve() {
    const ids = Array.from(reportsState.selectedIds);
    if (ids.length === 0) return;

    try {
        await adminPost("/failures/bulk", { action: "resolve", failureIds: ids });
        toast(`Successfully resolved ${ids.length} selected issue(s).`, "success");
        reportsState.selectedIds.clear();
        loadAdminReports();
    } catch (err) {
        toast(`Failed to resolve selected issues: ${err.message}`, "error");
    }
}

async function handleBulkDelete() {
    const ids = Array.from(reportsState.selectedIds);
    if (ids.length === 0) return;

    const confirmed = await showTablerConfirm(
        `Delete ${ids.length} Failure Reports`,
        `Are you sure you want to permanently delete ${ids.length} selected failure reports from the database? This action cannot be undone.`,
        `Delete ${ids.length} Reports`,
        true
    );
    if (!confirmed) return;

    try {
        await adminPost("/failures/bulk", { action: "delete", failureIds: ids });
        toast(`Successfully deleted ${ids.length} selected report(s).`, "success");
        reportsState.selectedIds.clear();
        loadAdminReports();
    } catch (err) {
        toast(`Failed to delete selected reports: ${err.message}`, "error");
    }
}

function handleCopyTrace() {
    if (!reportsState.currentReport || !reportsState.currentReport.stackTrace) return;
    navigator.clipboard
        .writeText(reportsState.currentReport.stackTrace)
        .then(() => toast("Stack trace copied to clipboard.", "success"))
        .catch(() => toast("Failed to copy stack trace.", "error"));
}
