import { adminGet, adminPost, adminPut, adminDelete } from "./admin-api.js?v=2.7.0";
import { showTablerConfirm } from "./admin-confirm.js?v=2.7.0";
import { toast } from "./admin-toast.js?v=2.7.0";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function formatLocalDate(isoStr) {
    if (!isoStr) return "N/A";
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        const datePart = d.toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            month: "short",
            day: "numeric",
            year: "numeric"
        });
        const timePart = d.toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true
        });
        return `${datePart}, ${timePart} IST`;
    } catch (_) {
        return isoStr;
    }
}

function toLocalDatetimeInputString(dateOrIso) {
    if (!dateOrIso) return "";
    try {
        const d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
        if (isNaN(d.getTime())) return "";
        // Convert UTC to IST (+5h 30m)
        const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
        const pad = (n) => String(n).padStart(2, "0");
        const year = istDate.getUTCFullYear();
        const month = pad(istDate.getUTCMonth() + 1);
        const day = pad(istDate.getUTCDate());
        const hours = pad(istDate.getUTCHours());
        const minutes = pad(istDate.getUTCMinutes());
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    } catch (_) {
        return "";
    }
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

let cachedNotices = [];

function audienceBadge(aud) {
    const a = String(aud || "both").toLowerCase();
    if (a === "drivers") {
        return `<span class="badge bg-azure-lt text-azure fw-semibold"><i class="ti ti-steering-wheel me-1"></i>Drivers Only</span>`;
    }
    if (a === "passengers") {
        return `<span class="badge bg-teal-lt text-teal fw-semibold"><i class="ti ti-user me-1"></i>Passengers Only</span>`;
    }
    return `<span class="badge bg-purple-lt text-purple fw-semibold"><i class="ti ti-users me-1"></i>Both Audiences</span>`;
}

function statusBadge(status) {
    const s = String(status || "scheduled").toLowerCase();
    if (s === "active") {
        return `<span class="badge bg-green text-white fw-bold"><i class="ti ti-player-play me-1"></i>Active</span>`;
    }
    if (s === "scheduled") {
        return `<span class="badge bg-blue-lt text-blue fw-bold"><i class="ti ti-clock me-1"></i>Scheduled</span>`;
    }
    if (s === "stopped") {
        return `<span class="badge bg-danger-lt text-danger fw-bold"><i class="ti ti-ban me-1"></i>Stopped</span>`;
    }
    return `<span class="badge bg-secondary-lt text-secondary fw-semibold"><i class="ti ti-player-stop me-1"></i>Ended</span>`;
}

export async function loadGlobalNotices() {
    const tbody = $("global-notices-tbody");
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small"><span class="spinner-border spinner-border-sm me-2"></span>Loading notices...</td></tr>`;

    try {
        const res = await adminGet("/notices");
        cachedNotices = res.notices || [];

        const badge = $("notices-total-badge");
        if (badge) badge.textContent = String(cachedNotices.length);

        if (!cachedNotices.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small"><i class="ti ti-info-circle me-1"></i>No global notices created yet. Click <strong>Create Global Notice</strong> to schedule one.</td></tr>`;
            return;
        }

        tbody.innerHTML = cachedNotices.map((n) => {
            const id = escapeHtml(n.noticeId || n.id || "");
            const title = escapeHtml(n.title || "Untitled");
            const hasDriverContent = !!n.driverContentEnabled;
            const closable = n.closable !== false;
            const status = (n.computedStatus || "scheduled").toLowerCase();
            const isStoppable = (status === "active" || status === "scheduled") && n.state === "enabled";

            return `
                <tr>
                    <td>
                        <div class="fw-bold text-dark">${title}</div>
                        ${hasDriverContent ? `
                            <div class="text-azure small mt-1 d-flex align-items-center gap-1">
                                <i class="ti ti-steering-wheel"></i> Driver title: <em>${escapeHtml(n.driverTitle || title)}</em>
                            </div>
                        ` : ''}
                    </td>
                    <td>${audienceBadge(n.audience)}</td>
                    <td>
                        <div class="small fw-semibold text-dark">${formatLocalDate(n.startsAt)}</div>
                        <div class="small text-secondary">to ${formatLocalDate(n.endsAt)}</div>
                    </td>
                    <td>
                        ${closable
                            ? `<span class="badge bg-secondary-lt text-secondary"><i class="ti ti-x me-1"></i>Closable</span>`
                            : `<span class="badge bg-warning-lt text-warning fw-bold"><i class="ti ti-lock me-1"></i>Non-closable</span>`
                        }
                    </td>
                    <td>${statusBadge(status)}</td>
                    <td><span class="small text-secondary">${formatLocalDate(n.updatedAt || n.createdAt)}</span></td>
                    <td class="text-end">
                        <div class="d-inline-flex align-items-center gap-1">
                            <button type="button" class="btn btn-outline-primary btn-sm btn-edit-notice" data-id="${id}" title="Edit notice">
                                <i class="ti ti-edit"></i> Edit
                            </button>
                            ${isStoppable ? `
                                <button type="button" class="btn btn-outline-warning btn-sm btn-stop-notice" data-id="${id}" title="Stop notice immediately">
                                    <i class="ti ti-ban"></i> Stop
                                </button>
                            ` : ''}
                            <button type="button" class="btn btn-outline-danger btn-sm btn-delete-notice" data-id="${id}" title="Delete notice">
                                <i class="ti ti-trash"></i> Delete
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("");

        bindGlobalNoticesTableButtons();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-danger small"><i class="ti ti-alert-circle me-1"></i>${escapeHtml(err.message)}</td></tr>`;
    }
}

function bindGlobalNoticesTableButtons() {
    const tbody = $("global-notices-tbody");
    if (!tbody) return;

    tbody.querySelectorAll(".btn-edit-notice").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            openEditNoticeModal(id);
        });
    });

    tbody.querySelectorAll(".btn-stop-notice").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const confirmed = await showTablerConfirm(
                "This notice will immediately stop appearing to drivers and passengers. Users currently viewing it will have the notice dismissed when the stop update reaches their application.",
                {
                    title: "Stop Global Notice?",
                    variant: "warning",
                    confirmText: "Stop Notice"
                }
            );
            if (!confirmed) return;

            await withButtonSpinner(btn, async () => {
                try {
                    await adminPost(`/notices/${id}/stop`);
                    toast("Global notice stopped successfully.", "success");
                    await loadGlobalNotices();
                } catch (e) {
                    toast(e.message, "error");
                }
            });
        });
    });

    tbody.querySelectorAll(".btn-delete-notice").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const confirmed = await showTablerConfirm(
                "This notice will be removed from normal notice management and will no longer appear to users. This action cannot be undone through the regular interface.",
                {
                    title: "Delete Global Notice?",
                    variant: "danger",
                    confirmText: "Delete Notice"
                }
            );
            if (!confirmed) return;

            await withButtonSpinner(btn, async () => {
                try {
                    await adminDelete(`/notices/${id}`);
                    toast("Global notice deleted successfully.", "success");
                    await loadGlobalNotices();
                } catch (e) {
                    toast(e.message, "error");
                }
            });
        });
    });
}

export function openCreateNoticeModal() {
    const modal = $("admin-notice-modal");
    if (!modal) return;

    const form = $("form-admin-notice");
    if (form) form.reset();

    $("notice-id-input").value = "";
    $("notice-modal-header-title").textContent = "Create Global Notice";
    $("notice-submit-btn-text").textContent = "Create Notice";

    // Set default schedule: starts now, ends in 24 hours
    const now = new Date();
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    $("notice-start-time-input").value = toLocalDatetimeInputString(now);
    $("notice-end-time-input").value = toLocalDatetimeInputString(later);

    $("notice-audience-select").value = "both";
    $("notice-closable-switch").checked = true;
    $("notice-driver-content-switch").checked = false;
    $("notice-driver-fields-wrap")?.classList.add("d-none");
    $("notice-driver-toggle-wrap")?.classList.remove("d-none");

    modal.classList.remove("d-none");
    modal.style.display = "block";
    setTimeout(() => $("notice-title-input")?.focus(), 50);
}

export async function openEditNoticeModal(noticeId) {
    const modal = $("admin-notice-modal");
    if (!modal) return;

    try {
        const res = await adminGet(`/notices/${noticeId}`);
        const n = res.notice;
        if (!n) throw new Error("Notice details not found.");

        $("notice-id-input").value = noticeId;
        $("notice-modal-header-title").textContent = "Edit Global Notice";
        $("notice-submit-btn-text").textContent = "Save Changes";

        $("notice-start-time-input").value = toLocalDatetimeInputString(n.startsAt);
        $("notice-end-time-input").value = toLocalDatetimeInputString(n.endsAt);
        $("notice-audience-select").value = n.audience || "both";
        $("notice-closable-switch").checked = n.closable !== false;

        $("notice-title-input").value = n.title || "";
        $("notice-description-input").value = n.description || "";
        $("notice-callout-input").value = n.callout || "";

        const hasDriver = !!n.driverContentEnabled;
        $("notice-driver-content-switch").checked = hasDriver;
        $("notice-driver-title-input").value = n.driverTitle || "";
        $("notice-driver-description-input").value = n.driverDescription || "";
        $("notice-driver-callout-input").value = n.driverCallout || "";

        if (n.audience === "passengers") {
            $("notice-driver-toggle-wrap")?.classList.add("d-none");
            $("notice-driver-fields-wrap")?.classList.add("d-none");
        } else {
            $("notice-driver-toggle-wrap")?.classList.remove("d-none");
            if (hasDriver) {
                $("notice-driver-fields-wrap")?.classList.remove("d-none");
            } else {
                $("notice-driver-fields-wrap")?.classList.add("d-none");
            }
        }

        modal.classList.remove("d-none");
        modal.style.display = "block";
    } catch (e) {
        toast(e.message, "error");
    }
}

export function closeNoticeModal() {
    const modal = $("admin-notice-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

let eventsInitialized = false;

export function initGlobalNoticesAdminEvents() {
    if (eventsInitialized) return;
    eventsInitialized = true;

    $("btn-open-create-notice-modal")?.addEventListener("click", openCreateNoticeModal);
    $("btn-refresh-global-notices")?.addEventListener("click", loadGlobalNotices);
    $("notice-modal-close-btn")?.addEventListener("click", closeNoticeModal);
    $("notice-modal-cancel-btn")?.addEventListener("click", closeNoticeModal);

    $("notice-audience-select")?.addEventListener("change", (e) => {
        const val = e.target.value;
        const driverToggleWrap = $("notice-driver-toggle-wrap");
        if (val === "passengers") {
            driverToggleWrap?.classList.add("d-none");
            $("notice-driver-content-switch").checked = false;
            $("notice-driver-fields-wrap")?.classList.add("d-none");
        } else {
            driverToggleWrap?.classList.remove("d-none");
        }
    });

    $("notice-driver-content-switch")?.addEventListener("change", (e) => {
        const fieldsWrap = $("notice-driver-fields-wrap");
        if (e.target.checked) {
            fieldsWrap?.classList.remove("d-none");
            setTimeout(() => $("notice-driver-title-input")?.focus(), 50);
        } else {
            fieldsWrap?.classList.add("d-none");
        }
    });

    const form = $("form-admin-notice");
    form?.addEventListener("submit", async (e) => {
        e.preventDefault();

        const submitBtn = $("notice-submit-btn");
        const noticeId = $("notice-id-input")?.value?.trim() || "";
        const startTimeVal = $("notice-start-time-input")?.value;
        const endTimeVal = $("notice-end-time-input")?.value;
        const audience = $("notice-audience-select")?.value || "both";
        const closable = $("notice-closable-switch")?.checked !== false;

        const title = $("notice-title-input")?.value?.trim() || "";
        const description = $("notice-description-input")?.value?.trim() || "";
        const callout = $("notice-callout-input")?.value?.trim() || "";

        const driverContentEnabled = $("notice-driver-content-switch")?.checked && audience !== "passengers";
        const driverTitle = $("notice-driver-title-input")?.value?.trim() || "";
        const driverDescription = $("notice-driver-description-input")?.value?.trim() || "";
        const driverCallout = $("notice-driver-callout-input")?.value?.trim() || "";

        if (!startTimeVal || !endTimeVal) {
            toast("Both start date and end date are required.", "warning");
            return;
        }

        const parseIstInputToDate = (val) => {
            if (!val) return null;
            const normalized = val.length === 16 ? `${val}:00+05:30` : `${val}+05:30`;
            const d = new Date(normalized);
            return isNaN(d.getTime()) ? null : d;
        };

        const startDt = parseIstInputToDate(startTimeVal);
        const endDt = parseIstInputToDate(endTimeVal);
        if (!startDt || !endDt) {
            toast("Invalid schedule date format.", "warning");
            return;
        }
        if (endDt <= startDt) {
            toast("End time must be after start time.", "warning");
            return;
        }

        if (driverContentEnabled) {
            if (!driverTitle || !driverDescription) {
                toast("Driver title and description are required when driver-specific content is enabled.", "warning");
                return;
            }
        }

        const payload = {
            title,
            description,
            callout,
            audience,
            closable,
            driverContentEnabled,
            driverTitle: driverContentEnabled ? driverTitle : "",
            driverDescription: driverContentEnabled ? driverDescription : "",
            driverCallout: driverContentEnabled ? driverCallout : "",
            startsAt: startDt.toISOString(),
            endsAt: endDt.toISOString(),
        };

        await withButtonSpinner(submitBtn, async () => {
            try {
                if (noticeId) {
                    await adminPut(`/notices/${noticeId}`, payload);
                    toast("Global notice updated successfully.", "success");
                } else {
                    await adminPost("/notices", payload);
                    toast("Global notice created successfully.", "success");
                }
                closeNoticeModal();
                await loadGlobalNotices();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });
}
