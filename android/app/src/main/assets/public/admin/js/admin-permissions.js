import { adminGet, adminPost, adminDelete } from "./admin-api.js?v=2.7.0";
import { showTablerConfirm } from "./admin-confirm.js?v=2.7.0";
import { toast } from "./admin-toast.js?v=2.7.0";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function maskEmail(email) {
    if (!email || !email.includes("@")) return email || "";
    const [user, domain] = email.split("@");
    if (user.length <= 3) return `${user.slice(0, 1)}***@${domain}`;
    return `${user.slice(0, 3)}******@${domain}`;
}

function getInitials(name, email) {
    if (name && name.trim()) {
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return parts[0].slice(0, 2).toUpperCase();
    }
    if (email && email.trim()) return email.slice(0, 2).toUpperCase();
    return "AD";
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
let cachedPendingRequests = [];
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
        cachedPendingRequests = data.pendingRequests || [];

        renderFullPermissionsView();
        renderModalAwaitingApprovalList();
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

    // 1. SECTION: Verified Users Awaiting Approval (Prominent if any exist)
    if (cachedPendingRequests.length > 0) {
        html += `
            <div class="card border-0 shadow-xs mb-4">
                <div class="card-header bg-white py-3 border-bottom d-flex align-items-center justify-content-between">
                    <div>
                        <h4 class="card-title fw-bold text-dark m-0 d-flex align-items-center gap-2">
                            <i class="ti ti-users text-primary"></i> Verified Users Awaiting Approval
                            <span class="badge bg-primary text-white rounded-pill">${cachedPendingRequests.length}</span>
                        </h4>
                        <div class="text-secondary small mt-1">These users have entered their invitation code and verified their identity. Review and approve or reject their requested role.</div>
                    </div>
                </div>
                <div class="table-responsive">
                    <table class="table table-vcenter card-table table-hover m-0">
                        <thead class="bg-light">
                            <tr>
                                <th>User</th>
                                <th>Requested Role</th>
                                <th>Verification Date</th>
                                <th>Invitation Type</th>
                                <th class="text-end">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${cachedPendingRequests.map(renderPendingRequestRow).join("")}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // 2. SECTION: Active Invitations
    const unclaimedInvitations = cachedActiveInvitations.filter(i => (i.status || "").toLowerCase() === "awaiting_claim");
    html += `
        <div class="card border-0 shadow-xs mb-4">
            <div class="card-header bg-white py-3 border-bottom d-flex align-items-center justify-content-between">
                <div>
                    <h4 class="card-title fw-bold text-dark m-0 d-flex align-items-center gap-2">
                        <i class="ti ti-mail-fast text-primary"></i> Active Invitations
                        <span class="badge bg-secondary-lt text-secondary rounded-pill">${unclaimedInvitations.length}</span>
                    </h4>
                    <div class="text-secondary small mt-1">Pending invitations awaiting user code entry at <code>/authPermissions</code>. Unclaimed codes can be revoked.</div>
                </div>
                <button type="button" class="btn btn-primary btn-sm d-flex align-items-center gap-1 btn-open-assign-role">
                    <i class="ti ti-user-plus"></i> Invite Admin / Manager
                </button>
            </div>
            ${!unclaimedInvitations.length ? `
                <div class="card-body text-center py-4 text-muted small">
                    <i class="ti ti-circle-check text-success d-block mb-1" style="font-size: 2rem;"></i>
                    No active unclaimed invitations. Click <strong>Invite Admin / Manager</strong> to issue a new code.
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
                            ${unclaimedInvitations.map(inv => `
                                <tr>
                                    <td>
                                        <div class="fw-bold">${escapeHtml(inv.targetEmail || "N/A")}</div>
                                        <div class="text-secondary small">${escapeHtml(inv.targetName || "Invited User")}</div>
                                    </td>
                                    <td>${roleBadge(inv.requestedRole)}</td>
                                    <td><span class="small text-secondary">${escapeHtml(inv.createdByEmail || "Super Admin")}</span></td>
                                    <td><span class="small text-secondary">${formatDate(inv.createdAt)}</span></td>
                                    <td><span class="small text-secondary">${formatDate(inv.expiresAt)}</span></td>
                                    <td><span class="badge bg-warning-lt text-warning"><i class="ti ti-clock me-1"></i>Awaiting Claim</span></td>
                                    <td class="text-end">
                                        <button type="button" class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1 btn-trigger-revoke"
                                            data-invitation-id="${escapeHtml(inv.invitationId || inv.id)}"
                                            data-email="${escapeHtml(inv.targetEmail || "")}"
                                            data-role="${escapeHtml(inv.requestedRole || "")}">
                                            <i class="ti ti-ban"></i> Revoke Invitation
                                        </button>
                                    </td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `}
        </div>
    `;

    // 3. SECTION: Existing Administrators and Managers
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
                                                            <i class="ti ti-arrow-up-circle"></i> Request Promotion to Administrator
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

function renderPendingRequestRow(req) {
    const initials = getInitials(req.targetName, req.targetEmail);
    const maskedEmail = maskEmail(req.targetEmail);
    const isPromotion = (req.requestType || "") === "manager_promotion";

    return `
        <tr>
            <td>
                <div class="d-flex align-items-center gap-2">
                    <span class="avatar avatar-sm rounded-circle ${isPromotion ? 'bg-purple-lt text-purple' : 'bg-blue-lt text-primary'} fw-bold" style="width:36px; height:36px; font-size:13px;">
                        ${initials}
                    </span>
                    <div>
                        <div class="fw-bold text-dark">${escapeHtml(req.targetName || "Verified User")}</div>
                        <div class="text-secondary small">${escapeHtml(maskedEmail)}</div>
                    </div>
                </div>
            </td>
            <td>
                ${roleBadge(req.requestedRole)}
            </td>
            <td>
                <span class="small text-secondary">${formatDate(req.verifiedAt || req.createdAt)}</span>
            </td>
            <td>
                ${isPromotion ? `
                    <span class="badge bg-purple-lt text-purple fw-semibold px-2 py-1">Manager-to-Administrator Promotion</span>
                ` : `
                    <span class="badge bg-blue-lt text-blue fw-semibold px-2 py-1">New Invitation</span>
                `}
            </td>
            <td class="text-end">
                <div class="d-inline-flex align-items-center gap-2">
                    <button type="button" class="btn btn-primary btn-sm px-3 d-inline-flex align-items-center gap-1 btn-grant-request"
                        data-request-id="${escapeHtml(req.requestId || req.id)}"
                        data-email="${escapeHtml(req.targetEmail || '')}"
                        data-role="${escapeHtml(req.requestedRole || '')}">
                        <i class="ti ti-check"></i> Grant
                    </button>
                    <button type="button" class="btn btn-outline-danger btn-sm px-3 d-inline-flex align-items-center gap-1 btn-reject-request"
                        data-request-id="${escapeHtml(req.requestId || req.id)}"
                        data-email="${escapeHtml(req.targetEmail || '')}">
                        <i class="ti ti-x"></i> Reject
                    </button>
                </div>
            </td>
        </tr>
    `;
}

function renderModalAwaitingApprovalList() {
    const wrap = $("modal-awaiting-approval-wrap");
    const countBadge = $("modal-awaiting-approval-count");
    if (countBadge) countBadge.textContent = String(cachedPendingRequests.length);

    if (!wrap) return;

    if (!cachedPendingRequests.length) {
        wrap.innerHTML = `
            <div class="text-center py-4 text-muted small bg-light rounded-2 border">
                <i class="ti ti-circle-check text-muted d-block mb-1" style="font-size: 1.8rem;"></i>
                No verified users currently awaiting approval.
            </div>
        `;
        return;
    }

    wrap.innerHTML = `
        <div class="table-responsive border rounded-2">
            <table class="table table-vcenter card-table table-hover m-0">
                <thead class="bg-light">
                    <tr>
                        <th>User</th>
                        <th>Requested Role</th>
                        <th>Verification Date</th>
                        <th>Invitation Type</th>
                        <th class="text-end">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${cachedPendingRequests.map(renderPendingRequestRow).join("")}
                </tbody>
            </table>
        </div>
        <div class="text-secondary small mt-2">Showing ${cachedPendingRequests.length} of ${cachedPendingRequests.length} verified users</div>
    `;

    bindPendingRequestButtons(wrap);
}

// =====================================================================
// EVENT BINDINGS
// =====================================================================

function bindPermissionActionHandlers(container) {
    container.querySelectorAll(".btn-open-assign-role").forEach(btn => {
        btn.addEventListener("click", openAssignRoleModal);
    });

    bindPendingRequestButtons(container);

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

function bindPendingRequestButtons(container) {
    // Grant Request
    container.querySelectorAll(".btn-grant-request").forEach(btn => {
        btn.addEventListener("click", async () => {
            const reqId = btn.dataset.requestId;
            const email = btn.dataset.email;
            const role = (btn.dataset.role || "admin").toUpperCase();

            const confirmed = await showTablerConfirm(`Grant ${role} role to ${email}? This will activate administrative access immediately.`, {
                title: "Grant Administrative Role",
                variant: "primary",
                confirmText: "Grant Role"
            });

            if (!confirmed) return;

            await withButtonSpinner(btn, async () => {
                try {
                    await adminPost(`/permissions/requests/${reqId}/approve`, {});
                    toast(`Role ${role} granted to ${email} successfully!`, "success");
                    await loadPermissions();
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });
    });

    // Reject Request
    container.querySelectorAll(".btn-reject-request").forEach(btn => {
        btn.addEventListener("click", async () => {
            const reqId = btn.dataset.requestId;
            const email = btn.dataset.email;

            const confirmed = await showTablerConfirm(`Reject administrative role request for ${email}? The invitation will be marked rejected and access will not be granted.`, {
                title: "Reject Role Request",
                variant: "danger",
                confirmText: "Reject Request"
            });

            if (!confirmed) return;

            await withButtonSpinner(btn, async () => {
                try {
                    await adminPost(`/permissions/requests/${reqId}/reject`, { notes: "Rejected by Super Admin" });
                    toast(`Role request for ${email} has been rejected.`, "info");
                    await loadPermissions();
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });
    });
}

// =====================================================================
// MODAL CONTROLS: ASSIGN ROLE & INVITATION CODE GENERATION
// =====================================================================

function openAssignRoleModal() {
    const modal = $("admin-assign-role-modal");
    if (!modal) return;
    const form = $("admin-invite-code-form");
    if (form) form.reset();
    renderModalAwaitingApprovalList();

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

// Display Generated Code Modal
function showGeneratedCodeModal(code, email, role, isPromotion = false) {
    const modal = $("admin-code-display-modal");
    if (!modal) return;

    const formattedCode = code.length === 10 ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;

    const titleEl = $("display-code-modal-title");
    const emailEl = $("display-code-target-email");
    const roleEl = $("display-code-target-role");
    const valEl = $("display-invitation-code-val");

    if (titleEl) titleEl.textContent = isPromotion ? "Promotion Code Generated" : "Invitation Code Generated";
    if (emailEl) emailEl.textContent = email;
    if (roleEl) roleEl.textContent = role.toUpperCase();
    if (valEl) {
        valEl.textContent = formattedCode;
        valEl.dataset.rawCode = code;
    }

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

function closeGeneratedCodeModal() {
    const modal = $("admin-code-display-modal");
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

    const confirmed = await showTablerConfirm(`Initiate promotion for Manager ${email} to Administrator? This will generate a separate promotion verification code that the user must verify.`, {
        title: "Initiate Administrator Promotion",
        variant: "primary",
        confirmText: "Generate Promotion Code"
    });

    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost("/permissions/initiate-promotion", { uid });
            showGeneratedCodeModal(res.code, email, "Administrator", true);
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

    // Form Submission: Generate Invitation Code
    const inviteForm = $("admin-invite-code-form");
    inviteForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = $("btn-generate-invite-code");
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
                showGeneratedCodeModal(res.code, email, role, false);
                await loadPermissions();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });

    // Copy Generated Code Button
    $("btn-copy-invitation-code")?.addEventListener("click", async () => {
        const valEl = $("display-invitation-code-val");
        const copyBtn = $("btn-copy-invitation-code");
        const codeToCopy = valEl?.dataset.rawCode || valEl?.textContent.trim();

        if (codeToCopy && navigator.clipboard) {
            try {
                await navigator.clipboard.writeText(codeToCopy);
                if (copyBtn) {
                    const originalText = copyBtn.innerHTML;
                    copyBtn.innerHTML = `<i class="ti ti-check"></i> Copied!`;
                    setTimeout(() => { if (copyBtn) copyBtn.innerHTML = originalText; }, 2000);
                }
                toast("Invitation code copied to clipboard!", "success");
            } catch (_) {
                toast("Could not copy automatically. Please copy the code manually.", "info");
            }
        }
    });

    $("code-display-close-btn")?.addEventListener("click", closeGeneratedCodeModal);
    $("btn-done-invitation-code")?.addEventListener("click", closeGeneratedCodeModal);

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
                toast("Invitation revoked successfully. The code is now invalid.", "success");
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
