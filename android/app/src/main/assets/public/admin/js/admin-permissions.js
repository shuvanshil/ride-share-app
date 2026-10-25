import { adminGet, adminPost, adminDelete } from "./admin-api.js?v=2.7.0";
import { showTablerConfirm } from "./admin-confirm.js?v=2.7.0";
import { toast } from "./admin-toast.js?v=2.7.0";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function formatDate(isoStr) {
    if (!isoStr) return "N/A";
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        return d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric"
        }) + " " + d.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit"
        });
    } catch (_) {
        return isoStr;
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

let cachedAdminRoles = [];
let cachedActiveInvitations = [];
let pendingRevokeInvitationId = null;
let pendingDowngradeUid = null;

// =====================================================================
// MAIN LOADER & RENDERER
// =====================================================================

export async function loadPermissions() {
    const wrap = $("admin-permissions-table-wrap");
    if (!wrap) return;

    wrap.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading administrative roles & invitations...</div>
        </div>
    `;

    try {
        const data = await adminGet("/permissions");
        cachedAdminRoles = data.adminRoles || [];
        cachedActiveInvitations = data.activeInvitations || [];

        renderFullPermissionsView();
    } catch (error) {
        wrap.innerHTML = `<div class="card border-0 shadow-xs p-4 text-center text-danger">${escapeHtml(error.message)}</div>`;
    }
}

function roleBadge(role) {
    const r = String(role || "admin").toLowerCase();
    if (r === "super_admin") {
        return `<span class="badge bg-purple-lt text-purple fw-bold"><i class="ti ti-shield-check me-1"></i>Super Admin</span>`;
    }
    if (r === "manager") {
        return `<span class="badge bg-success-lt text-success fw-bold"><i class="ti ti-user me-1"></i>Manager</span>`;
    }
    return `<span class="badge bg-danger-lt text-danger fw-bold"><i class="ti ti-user-check me-1"></i>Administrator</span>`;
}

function renderFullPermissionsView() {
    const wrap = $("admin-permissions-table-wrap");
    if (!wrap) return;

    let html = "";

    // 1. SECTION: Pending Invitations
    const pendingInvitations = cachedActiveInvitations.filter(i => {
        const s = (i.status || "").toLowerCase();
        return s === "pending" || s === "awaiting_claim";
    });

    html += `
        <div class="card border-0 shadow-xs mb-4">
            <div class="card-header bg-white py-3 border-bottom d-flex align-items-center justify-content-between">
                <div>
                    <h4 class="card-title fw-bold text-dark m-0 d-flex align-items-center gap-2">
                        <i class="ti ti-mail-fast text-primary"></i> Pending Invitations
                        <span class="badge bg-secondary-lt text-secondary rounded-pill">${pendingInvitations.length}</span>
                    </h4>
                    <div class="text-secondary small mt-1">Pending invitations awaiting user acceptance. You can copy the link again or withdraw an invitation before expiration.</div>
                </div>
                <button type="button" class="btn btn-primary btn-sm d-flex align-items-center gap-1 btn-open-assign-role">
                    <i class="ti ti-user-plus"></i> Invite Admin / Manager
                </button>
            </div>
            ${!pendingInvitations.length ? `
                <div class="card-body text-center py-4 text-muted small">
                    <i class="ti ti-circle-check text-success d-block mb-1" style="font-size: 2rem;"></i>
                    No pending invitations. Click <strong>Invite Admin / Manager</strong> to generate a new invitation link.
                </div>
            ` : `
                <div class="table-responsive">
                    <table class="table table-vcenter card-table table-striped table-hover m-0">
                        <thead class="bg-light">
                            <tr>
                                <th>Invitee Email</th>
                                <th>Intended Role</th>
                                <th>Created By</th>
                                <th>Created Date</th>
                                <th>Expiration Date</th>
                                <th>Status</th>
                                <th class="text-end">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${pendingInvitations.map(inv => `
                                <tr>
                                    <td>
                                        <div class="fw-bold text-dark">${escapeHtml(inv.targetEmail || "N/A")}</div>
                                        <div class="text-secondary small">${escapeHtml(inv.targetName || "Invited User")}</div>
                                    </td>
                                    <td>${roleBadge(inv.requestedRole)}</td>
                                    <td><span class="small text-secondary">${escapeHtml(inv.createdByEmail || "Super Admin")}</span></td>
                                    <td><span class="small text-secondary">${formatDate(inv.createdAt)}</span></td>
                                    <td><span class="small text-secondary">${formatDate(inv.expiresAt)}</span></td>
                                    <td><span class="badge bg-warning-lt text-warning"><i class="ti ti-clock me-1"></i>Pending</span></td>
                                    <td class="text-end">
                                        <div class="d-inline-flex align-items-center gap-2">
                                            <button type="button" class="btn btn-outline-primary btn-sm d-inline-flex align-items-center gap-1 btn-copy-invitation-link-row"
                                                data-invitation-id="${escapeHtml(inv.invitationId || inv.id)}"
                                                data-email="${escapeHtml(inv.targetEmail || "")}"
                                                data-role="${escapeHtml(inv.requestedRole || "")}"
                                                title="Re-copy the secure invitation link">
                                                <i class="ti ti-copy"></i> Copy Link
                                            </button>
                                            <button type="button" class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1 btn-trigger-revoke"
                                                data-invitation-id="${escapeHtml(inv.invitationId || inv.id)}"
                                                data-email="${escapeHtml(inv.targetEmail || "")}"
                                                data-role="${escapeHtml(inv.requestedRole || "")}"
                                                title="Withdraw this invitation">
                                                <i class="ti ti-ban"></i> Revoke
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `}
        </div>
    `;

    // 2. SECTION: Existing Administrators and Managers
    html += `
        <div class="card border-0 shadow-xs mb-3">
            <div class="card-header bg-white py-3 border-bottom d-flex align-items-center justify-content-between">
                <div>
                    <h4 class="card-title fw-bold text-dark m-0 d-flex align-items-center gap-2">
                        <i class="ti ti-shield-check text-primary"></i> Existing Administrators &amp; Managers
                        <span class="badge bg-secondary-lt text-secondary rounded-pill">${cachedAdminRoles.length}</span>
                    </h4>
                    <div class="text-secondary small mt-1">Active platform administrative accounts. Super Admin accounts are locked. Controlled transitions are enforced.</div>
                </div>
            </div>
            ${!cachedAdminRoles.length ? `
                <div class="card-body text-center py-5 text-secondary">
                    <i class="ti ti-shield-x text-muted mb-2" style="font-size: 2.5rem; display: block;"></i>
                    No administrative roles found.
                </div>
            ` : `
                <div class="table-responsive">
                    <table class="table table-vcenter card-table table-striped table-hover m-0">
                        <thead class="bg-light">
                            <tr>
                                <th>User</th>
                                <th>Email</th>
                                <th>Current Role</th>
                                <th>Assigned By</th>
                                <th>Last Updated</th>
                                <th class="text-end">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${cachedAdminRoles.map(r => {
                                const isSuperAdmin = r.role === "super_admin";
                                const isAdmin = r.role === "admin";
                                const isManager = r.role === "manager";

                                return `
                                    <tr>
                                        <td>
                                            <div class="fw-bold">${escapeHtml(r.name || r.email || "Admin User")}</div>
                                            <div class="text-secondary small">UID: ${escapeHtml((r.uid || "").slice(0, 12))}...</div>
                                        </td>
                                        <td>${escapeHtml(r.email || "N/A")}</td>
                                        <td>${roleBadge(r.role)}</td>
                                        <td><span class="small text-secondary">${escapeHtml(r.assignedByEmail || r.assignedBy || "System")}</span></td>
                                        <td><span class="small text-secondary">${r.updatedAt ? formatDate(r.updatedAt) : "Initial"}</span></td>
                                        <td class="text-end">
                                            ${isSuperAdmin ? `
                                                <span class="badge bg-secondary-lt text-secondary">Super Admin Locked</span>
                                            ` : `
                                                <div class="d-inline-flex align-items-center gap-2">
                                                    ${isAdmin ? `
                                                        <button type="button" class="btn btn-outline-warning btn-sm d-inline-flex align-items-center gap-1 btn-trigger-downgrade"
                                                            data-uid="${escapeHtml(r.uid)}"
                                                            data-email="${escapeHtml(r.email || "")}">
                                                            <i class="ti ti-arrow-down-circle"></i> Change to Manager
                                                        </button>
                                                    ` : ''}

                                                    ${isManager ? `
                                                        <button type="button" class="btn btn-outline-primary btn-sm d-inline-flex align-items-center gap-1 btn-trigger-promotion"
                                                            data-uid="${escapeHtml(r.uid)}"
                                                            data-email="${escapeHtml(r.email || "")}">
                                                            <i class="ti ti-arrow-up-circle"></i> Promote to Administrator
                                                        </button>
                                                    ` : ''}

                                                    <button class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1 btn-revoke-role-direct"
                                                        data-revoke-role="${escapeHtml(r.uid)}"
                                                        data-user-email="${escapeHtml(r.email || '')}"
                                                        type="button" title="Revoke all administrative access">
                                                        <i class="ti ti-trash"></i> Revoke Access
                                                    </button>
                                                </div>
                                            `}
                                        </td>
                                    </tr>
                                `;
                            }).join("")}
                        </tbody>
                    </table>
                </div>
            `}
        </div>
    `;

    wrap.innerHTML = html;
    bindPermissionActionHandlers(wrap);
}

// =====================================================================
// EVENT BINDINGS
// =====================================================================

function bindPermissionActionHandlers(container) {
    container.querySelectorAll(".btn-open-assign-role").forEach(btn => {
        btn.addEventListener("click", openAssignRoleModal);
    });

    // Re-copy Invitation Link from Table Row
    container.querySelectorAll(".btn-copy-invitation-link-row").forEach(btn => {
        btn.addEventListener("click", async () => {
            const invId = btn.dataset.invitationId;
            const email = btn.dataset.email;
            const role = btn.dataset.role;

            await withButtonSpinner(btn, async () => {
                try {
                    const res = await adminGet(`/invitations/${invId}/link`);
                    const url = res.invitationUrl;
                    if (url && navigator.clipboard) {
                        await navigator.clipboard.writeText(url);
                        const orig = btn.innerHTML;
                        btn.innerHTML = `<i class="ti ti-check"></i> Copied!`;
                        setTimeout(() => { if (btn) btn.innerHTML = orig; }, 2000);
                        toast("Invitation link copied to clipboard!", "success");
                    } else if (url) {
                        showGeneratedLinkModal(url, email, role);
                    }
                } catch (err) {
                    toast(err.message || "Failed to retrieve invitation link", "error");
                }
            });
        });
    });

    // Revoke Invitation Trigger
    container.querySelectorAll(".btn-trigger-revoke").forEach(btn => {
        btn.addEventListener("click", () => {
            const invId = btn.dataset.invitationId;
            const email = btn.dataset.email;
            const role = btn.dataset.role;
            openRevokeInvitationModal(invId, email, role);
        });
    });

    // Downgrade Trigger
    container.querySelectorAll(".btn-trigger-downgrade").forEach(btn => {
        btn.addEventListener("click", () => {
            const uid = btn.dataset.uid;
            const email = btn.dataset.email;
            openDowngradeModal(uid, email);
        });
    });

    // Promotion Trigger (Manager -> Administrator)
    container.querySelectorAll(".btn-trigger-promotion").forEach(btn => {
        btn.addEventListener("click", () => handleInitiatePromotion(btn));
    });

    // Direct Revoke Access button
    container.querySelectorAll(".btn-revoke-role-direct").forEach(btn => {
        btn.addEventListener("click", async () => {
            const uid = btn.dataset.revokeRole;
            const email = btn.dataset.userEmail || "this user";

            const confirmed = await showTablerConfirm(`Are you sure you want to revoke administrative access for ${email}? They will no longer be able to log in to the admin panel.`, {
                title: "Revoke Administrative Access",
                variant: "danger",
                confirmText: "Revoke Access"
            });

            if (!confirmed) return;

            await withButtonSpinner(btn, async () => {
                try {
                    await adminDelete(`/permissions/${uid}`);
                    toast(`Administrative access revoked for ${email}.`);
                    loadPermissions();
                } catch (error) {
                    toast(error.message, "error");
                }
            });
        });
    });
}

// =====================================================================
// MODAL CONTROLS: ASSIGN ROLE & INVITATION LINK GENERATION
// =====================================================================

function openAssignRoleModal() {
    const modal = $("admin-assign-role-modal");
    if (!modal) return;
    const form = $("admin-invite-code-form");
    if (form) form.reset();

    modal.classList.remove("d-none");
    modal.style.display = "block";
    setTimeout(() => $("invite-admin-email")?.focus(), 50);
}

function closeAssignRoleModal() {
    const modal = $("admin-assign-role-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

// Display Generated Link Modal
function showGeneratedLinkModal(url, email, role, isPromotion = false) {
    const modal = $("admin-link-display-modal");
    if (!modal) return;

    const titleEl = $("display-link-modal-title");
    const emailEl = $("display-link-target-email");
    const roleEl = $("display-link-target-role");
    const linkInput = $("display-invitation-link-val");

    if (titleEl) titleEl.textContent = isPromotion ? "Promotion Invitation Link Generated" : "Invitation Link Generated";
    if (emailEl) emailEl.textContent = email;
    if (roleEl) roleEl.textContent = (role || "Admin").toUpperCase();
    if (linkInput) {
        linkInput.value = url;
    }

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

function closeGeneratedLinkModal() {
    const modal = $("admin-link-display-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

// Revoke Invitation Modal
function openRevokeInvitationModal(invitationId, email, role) {
    pendingRevokeInvitationId = invitationId;
    const modal = $("admin-revoke-invitation-modal");
    if (!modal) return;

    const emailEl = $("revoke-modal-target-email");
    const roleEl = $("revoke-modal-target-role");
    const reasonInput = $("revoke-modal-reason-input");

    if (emailEl) emailEl.textContent = email;
    if (roleEl) roleEl.textContent = (role || "Admin").toUpperCase();
    if (reasonInput) reasonInput.value = "";

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

function closeRevokeInvitationModal() {
    pendingRevokeInvitationId = null;
    const modal = $("admin-revoke-invitation-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

// Downgrade Modal
function openDowngradeModal(uid, email) {
    pendingDowngradeUid = uid;
    const modal = $("admin-downgrade-modal");
    if (!modal) return;

    const emailEl = $("downgrade-modal-target-email");
    const reasonInput = $("downgrade-modal-reason-input");

    if (emailEl) emailEl.textContent = email;
    if (reasonInput) reasonInput.value = "";

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

function closeDowngradeModal() {
    pendingDowngradeUid = null;
    const modal = $("admin-downgrade-modal");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

// Manager -> Administrator Promotion Workflow
async function handleInitiatePromotion(btn) {
    const uid = btn.dataset.uid;
    const email = btn.dataset.email;

    const confirmed = await showTablerConfirm(`Initiate promotion for Manager ${email} to Administrator? This will generate a secure invitation link that the user must accept.`, {
        title: "Initiate Administrator Promotion",
        variant: "primary",
        confirmText: "Generate Promotion Link"
    });

    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost("/permissions/initiate-promotion", { uid });
            showGeneratedLinkModal(res.invitationUrl, email, "Administrator", true);
            await loadPermissions();
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

// =====================================================================
// INITIALIZATION
// =====================================================================

export function initPermissionsModal() {
    // Open Assign Role Modal
    $("admin-open-assign-role-btn")?.addEventListener("click", openAssignRoleModal);
    $("assign-role-close-btn")?.addEventListener("click", closeAssignRoleModal);
    $("assign-role-cancel-btn")?.addEventListener("click", closeAssignRoleModal);

    // Form Submission: Generate Invitation Link
    const inviteForm = $("admin-invite-code-form");
    inviteForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = $("btn-generate-invite-link") || $("btn-generate-invite-code");
        const email = ($("invite-admin-email")?.value || "").trim();
        const role = $("invite-admin-role")?.value || "admin";

        if (!email) {
            toast("Please enter the user's registered email.", "warning");
            return;
        }

        await withButtonSpinner(submitBtn, async () => {
            try {
                const res = await adminPost("/permissions/invite", { email, role });
                closeAssignRoleModal();
                showGeneratedLinkModal(res.invitationUrl, email, role, false);
                await loadPermissions();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });

    // Copy Generated Link Button in Display Modal
    $("btn-copy-invitation-link")?.addEventListener("click", async () => {
        const valEl = $("display-invitation-link-val");
        const copyBtn = $("btn-copy-invitation-link");
        const linkToCopy = valEl?.value?.trim() || valEl?.textContent.trim();

        if (linkToCopy && navigator.clipboard) {
            try {
                await navigator.clipboard.writeText(linkToCopy);
                if (copyBtn) {
                    const originalText = copyBtn.innerHTML;
                    copyBtn.innerHTML = `<i class="ti ti-check"></i> Copied!`;
                    setTimeout(() => { if (copyBtn) copyBtn.innerHTML = originalText; }, 2000);
                }
                toast("Invitation link copied to clipboard!", "success");
            } catch (_) {
                toast("Could not copy automatically. Please copy the link manually.", "info");
            }
        }
    });

    $("link-display-close-btn")?.addEventListener("click", closeGeneratedLinkModal);
    $("btn-done-invitation-link")?.addEventListener("click", closeGeneratedLinkModal);

    // Confirm Revoke Invitation
    $("revoke-invitation-close-btn")?.addEventListener("click", closeRevokeInvitationModal);
    $("revoke-invitation-cancel-btn")?.addEventListener("click", closeRevokeInvitationModal);
    $("btn-confirm-revoke-invitation")?.addEventListener("click", async () => {
        if (!pendingRevokeInvitationId) return;
        const confirmBtn = $("btn-confirm-revoke-invitation");
        const reason = ($("revoke-modal-reason-input")?.value || "").trim();

        await withButtonSpinner(confirmBtn, async () => {
            try {
                await adminPost("/permissions/revoke-invitation", {
                    invitationId: pendingRevokeInvitationId,
                    reason: reason
                });
                toast("Invitation withdrawn successfully. The link is now invalid.", "success");
                closeRevokeInvitationModal();
                await loadPermissions();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });

    // Confirm Downgrade Administrator
    $("downgrade-close-btn")?.addEventListener("click", closeDowngradeModal);
    $("downgrade-cancel-btn")?.addEventListener("click", closeDowngradeModal);
    $("btn-confirm-downgrade")?.addEventListener("click", async () => {
        if (!pendingDowngradeUid) return;
        const confirmBtn = $("btn-confirm-downgrade");
        const reason = ($("downgrade-modal-reason-input")?.value || "").trim();

        await withButtonSpinner(confirmBtn, async () => {
            try {
                await adminPost("/permissions/downgrade-admin", {
                    uid: pendingDowngradeUid,
                    reason: reason
                });
                toast("Administrator downgraded to Manager successfully.", "success");
                closeDowngradeModal();
                await loadPermissions();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });
}
