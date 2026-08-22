import { adminGet, adminPost, adminDelete } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
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

let cachedEligibleUsers = [];

export async function loadPermissions() {
    const wrap = $("admin-permissions-table-wrap");
    if (!wrap) return;

    wrap.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading administrative roles...</div>
        </div>
    `;

    try {
        const data = await adminGet("/permissions");
        cachedEligibleUsers = data.eligibleUsers || [];
        renderPermissionsTable(data.adminRoles || []);
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
        return `<span class="badge bg-warning-lt text-warning fw-bold"><i class="ti ti-user me-1"></i>Manager</span>`;
    }
    return `<span class="badge bg-blue-lt text-blue fw-bold"><i class="ti ti-user-check me-1"></i>Admin</span>`;
}

function renderPermissionsTable(roles) {
    const wrap = $("admin-permissions-table-wrap");
    if (!roles.length) {
        wrap.innerHTML = `
            <div class="card border-0 shadow-xs text-center py-5 text-secondary">
                <i class="ti ti-shield-x text-muted mb-2" style="font-size: 2.5rem; display: block;"></i>
                No administrative roles assigned yet.
            </div>
        `;
        return;
    }

    wrap.innerHTML = `
        <div class="card border-0 shadow-xs">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-striped table-hover m-0">
                    <thead>
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
                        ${roles.map(r => `
                            <tr>
                                <td>
                                    <div class="fw-bold">${escapeHtml(r.name || r.email || "Admin User")}</div>
                                    <div class="text-secondary small">UID: ${escapeHtml((r.uid || "").slice(0, 12))}...</div>
                                </td>
                                <td>${escapeHtml(r.email || "N/A")}</td>
                                <td>${roleBadge(r.role)}</td>
                                <td><span class="small text-secondary">${escapeHtml(r.assignedByEmail || r.assignedBy || "System")}</span></td>
                                <td><span class="small text-secondary">${r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "Initial"}</span></td>
                                <td class="text-end">
                                    ${r.role === "super_admin" 
                                        ? `<span class="badge bg-secondary-lt text-secondary">Super Admin Locked</span>` 
                                        : `
                                        <div class="d-inline-flex align-items-center gap-2">
                                            <select class="form-select form-select-sm w-auto" data-change-role="${escapeHtml(r.uid)}" data-current-role="${escapeHtml(r.role)}">
                                                <option value="admin" ${r.role === "admin" ? "selected" : ""}>Admin</option>
                                                <option value="manager" ${r.role === "manager" ? "selected" : ""}>Manager</option>
                                            </select>
                                            <button class="btn btn-outline-danger btn-sm d-inline-flex align-items-center gap-1" data-revoke-role="${escapeHtml(r.uid)}" data-user-email="${escapeHtml(r.email)}" type="button">
                                                <i class="ti ti-trash"></i> Revoke
                                            </button>
                                        </div>
                                        `}
                                </td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Bind role change selects
    wrap.querySelectorAll("[data-change-role]").forEach((select) => {
        select.addEventListener("change", async () => {
            const uid = select.dataset.changeRole;
            const currentRole = select.dataset.currentRole;
            const newRole = select.value;
            if (newRole === currentRole) return;

            const confirmed = await showTablerConfirm(`Change this user's role from ${currentRole.toUpperCase()} to ${newRole.toUpperCase()}?`, {
                title: "Change Administrative Role",
                variant: "primary",
                confirmText: "Update Role"
            });

            if (!confirmed) {
                select.value = currentRole;
                return;
            }

            try {
                await adminPost("/permissions/assign", { uid, role: newRole });
                toast(`User role updated to ${newRole.toUpperCase()}.`);
                loadPermissions();
            } catch (error) {
                toast(error.message, "error");
                select.value = currentRole;
            }
        });
    });

    // Bind revoke buttons
    wrap.querySelectorAll("[data-revoke-role]").forEach((btn) => {
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

// ---------------------------------------------------------------------
// Assign Role Modal
// ---------------------------------------------------------------------

export function initPermissionsModal() {
    const openBtn = $("admin-open-assign-role-btn");
    const modal = $("admin-assign-role-modal");
    const closeBtn = $("assign-role-close-btn");
    const cancelBtn = $("assign-role-cancel-btn");
    const form = $("admin-assign-role-form");
    const userSelect = $("assign-role-user-select");

    if (!modal) return;

    function openModal() {
        // Populate user select
        if (userSelect) {
            userSelect.innerHTML = `<option value="">Select a user...</option>` +
                cachedEligibleUsers.map(u => `
                    <option value="${escapeHtml(u.uid)}" data-email="${escapeHtml(u.email)}">
                        ${escapeHtml(u.name)} (${escapeHtml(u.email || u.phone || u.uid)})
                    </option>
                `).join("");
        }
        modal.classList.remove("d-none");
        modal.style.display = "block";
    }

    function closeModal() {
        modal.classList.add("d-none");
        modal.style.display = "none";
        form?.reset();
    }

    openBtn?.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);

    form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = $("assign-role-submit-btn");
        const uid = userSelect.value;
        const role = $("assign-role-select").value;
        const selectedOpt = userSelect.options[userSelect.selectedIndex];
        const email = selectedOpt ? selectedOpt.dataset.email : "";

        if (!uid) return toast("Select a user account.", "error");

        await withButtonSpinner(submitBtn, async () => {
            try {
                await adminPost("/permissions/assign", { uid, email, role });
                toast(`Role ${role.toUpperCase()} granted successfully.`);
                closeModal();
                loadPermissions();
            } catch (error) {
                toast(error.message, "error");
            }
        });
    });
}
