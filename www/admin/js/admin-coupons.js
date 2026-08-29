import { adminGet, adminPost, adminPatch, adminDelete } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";

let cachedCoupons = [];
let currentCategoryFilter = "all";

export function initAdminCoupons() {
    const searchInput = document.getElementById("admin-coupon-search");
    searchInput?.addEventListener("input", renderCouponsTable);

    document.getElementById("admin-coupon-filter-all")?.addEventListener("click", () => setCouponFilter("all"));
    document.getElementById("admin-coupon-filter-active")?.addEventListener("click", () => setCouponFilter("active"));
    document.getElementById("admin-coupon-filter-default")?.addEventListener("click", () => setCouponFilter("default"));
    document.getElementById("admin-coupon-filter-inactive")?.addEventListener("click", () => setCouponFilter("inactive"));

    // Create Modal triggers
    document.getElementById("btn-open-create-coupon")?.addEventListener("click", openCreateCouponModal);
    document.getElementById("btn-close-create-coupon")?.addEventListener("click", closeCreateCouponModal);
    document.getElementById("btn-cancel-create-coupon")?.addEventListener("click", closeCreateCouponModal);

    // Form submit
    document.getElementById("form-create-coupon")?.addEventListener("submit", handleCreateCouponSubmit);

    // Redemptions Modal
    document.getElementById("btn-close-coupon-redemptions")?.addEventListener("click", closeRedemptionsModal);
}

function setCouponFilter(filter) {
    currentCategoryFilter = filter;
    ["all", "active", "default", "inactive"].forEach(f => {
        const btn = document.getElementById(`admin-coupon-filter-${f}`);
        if (btn) {
            btn.classList.toggle("btn-primary", f === filter);
            btn.classList.toggle("btn-outline-secondary", f !== filter);
        }
    });
    renderCouponsTable();
}

export async function loadAdminCoupons() {
    try {
        const res = await adminGet("/admin/coupons");
        if (!res || !res.ok) {
            throw new Error(res?.error || "Failed to load coupons");
        }

        cachedCoupons = res.coupons || [];
        updateCouponMetrics();
        renderCouponsTable();
    } catch (err) {
        console.error("Error loading coupons:", err);
        toast(err.message || "Failed to load coupons", "error");
    }
}

function updateCouponMetrics() {
    const totalCount = cachedCoupons.length;
    const activeCount = cachedCoupons.filter(c => c.status === "active").length;
    const totalRedemptions = cachedCoupons.reduce((sum, c) => sum + (c.redemptionsCount || 0), 0);
    const totalSubsidies = cachedCoupons.reduce((sum, c) => sum + (c.totalSubsidiesINR || 0), 0);

    const elTotal = document.getElementById("metric-total-coupons");
    const elActive = document.getElementById("metric-active-coupons");
    const elRedemptions = document.getElementById("metric-total-redemptions");
    const elSubsidies = document.getElementById("metric-total-subsidies");

    if (elTotal) elTotal.innerText = totalCount;
    if (elActive) elActive.innerText = activeCount;
    if (elRedemptions) elRedemptions.innerText = totalRedemptions;
    if (elSubsidies) elSubsidies.innerText = `₹${Math.round(totalSubsidies).toLocaleString("en-IN")}`;
}

function renderCouponsTable() {
    const tbody = document.getElementById("admin-coupons-table-body");
    if (!tbody) return;

    const searchTerm = (document.getElementById("admin-coupon-search")?.value || "").trim().toLowerCase();

    const filtered = cachedCoupons.filter(c => {
        if (currentCategoryFilter === "active" && c.status !== "active") return false;
        if (currentCategoryFilter === "inactive" && c.status === "active") return false;
        if (currentCategoryFilter === "default" && c.source !== "default") return false;

        if (searchTerm) {
            const matchCode = (c.code || "").toLowerCase().includes(searchTerm);
            const matchDesc = (c.description || "").toLowerCase().includes(searchTerm);
            const matchCategory = (c.eligibilityCategory || "").toLowerCase().includes(searchTerm);
            if (!matchCode && !matchDesc && !matchCategory) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="text-center py-4 text-muted">
                    <i class="ti ti-ticket-off fs-2 mb-2 d-block"></i>
                    No promotional coupons found.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(coupon => {
        const isDefault = coupon.source === "default";
        const isActive = coupon.status === "active";
        const isFixed = coupon.discountType === "fixed";
        const valueDisplay = isFixed ? `₹${coupon.discountValue}` : `${coupon.discountValue}%`;

        let categoryLabel = coupon.eligibilityCategory;
        if (categoryLabel === "all_passengers") categoryLabel = "All Passengers";
        else if (categoryLabel === "first_ride") categoryLabel = "1st Completed Ride";
        else if (categoryLabel === "tenth_ride") categoryLabel = "11th Ride Milestone";
        else if (categoryLabel === "at_least_1_ride") categoryLabel = "1+ Completed Rides";
        else if (categoryLabel === "at_least_10_rides") categoryLabel = "10+ Completed Rides";
        else if (categoryLabel === "at_least_20_rides") categoryLabel = "20+ Completed Rides";
        else if (categoryLabel === "at_least_50_rides") categoryLabel = "50+ Completed Rides";

        const restrictionsCount = (coupon.restrictedPassengerIds || []).length;
        const restrictionsBadge = restrictionsCount > 0
            ? `<span class="badge bg-warning-lt" title="${coupon.restrictedPassengerIds.join(', ')}">${restrictionsCount} User(s)</span>`
            : `<span class="badge bg-light text-muted">Unrestricted</span>`;

        return `
            <tr>
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <span class="badge ${isDefault ? 'bg-purple-lt text-purple' : 'bg-blue-lt text-blue'} fw-bold px-2 py-1" style="font-size: 13px; letter-spacing: 0.5px;">
                            ${coupon.code}
                        </span>
                        ${isDefault ? '<span class="badge bg-purple text-white" style="font-size:10px;">DEFAULT</span>' : ''}
                    </div>
                    <small class="text-muted d-block mt-1">${coupon.description || 'Promotional coupon discount'}</small>
                </td>
                <td>
                    <span class="badge ${isFixed ? 'bg-success-lt' : 'bg-cyan-lt'} fw-bold">
                        ${isFixed ? 'Fixed ₹' : 'Percentage %'}
                    </span>
                    <strong class="d-block text-dark mt-1" style="font-size: 14px;">${valueDisplay}</strong>
                </td>
                <td>
                    <span class="text-dark fw-semibold">${categoryLabel}</span>
                </td>
                <td>
                    ${restrictionsBadge}
                </td>
                <td>
                    <button class="btn btn-sm btn-ghost-primary px-2 btn-view-redemptions" data-id="${coupon.couponId}" data-code="${coupon.code}">
                        <i class="ti ti-users me-1"></i> ${coupon.redemptionsCount || 0} uses
                    </button>
                    <small class="text-muted d-block mt-1">₹${Math.round(coupon.totalSubsidiesINR || 0).toLocaleString('en-IN')} subsidy</small>
                </td>
                <td>
                    <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'} text-white">
                        ${isActive ? 'Active' : 'Inactive'}
                    </span>
                </td>
                <td>
                    <div class="d-flex align-items-center gap-1">
                        <button class="btn btn-sm ${isActive ? 'btn-outline-warning' : 'btn-outline-success'} btn-toggle-status" data-id="${coupon.couponId}" data-status="${coupon.status}">
                            ${isActive ? '<i class="ti ti-power me-1"></i>Deactivate' : '<i class="ti ti-check me-1"></i>Activate'}
                        </button>
                        ${coupon.isDeletable ? `
                            <button class="btn btn-sm btn-outline-danger btn-delete-coupon" data-id="${coupon.couponId}" data-code="${coupon.code}">
                                <i class="ti ti-trash"></i>
                            </button>
                        ` : `
                            <span class="badge bg-light text-muted" title="Default platform coupons cannot be deleted">Locked</span>
                        `}
                    </div>
                </td>
            </tr>
        `;
    }).join("");

    // Attach row button handlers
    tbody.querySelectorAll(".btn-toggle-status").forEach(btn => {
        btn.addEventListener("click", () => handleToggleStatus(btn.dataset.id, btn.dataset.status));
    });

    tbody.querySelectorAll(".btn-delete-coupon").forEach(btn => {
        btn.addEventListener("click", () => handleDeleteCoupon(btn.dataset.id, btn.dataset.code));
    });

    tbody.querySelectorAll(".btn-view-redemptions").forEach(btn => {
        btn.addEventListener("click", () => openRedemptionsModal(btn.dataset.id, btn.dataset.code));
    });
}

async function handleToggleStatus(couponId, currentStatus) {
    const isActivating = currentStatus !== "active";
    const endpoint = isActivating ? `/admin/coupons/${couponId}/activate` : `/admin/coupons/${couponId}/deactivate`;
    try {
        const res = await adminPost(endpoint, {});
        if (!res || !res.ok) throw new Error(res?.error || "Failed to update coupon status");
        toast(isActivating ? "Coupon activated successfully" : "Coupon deactivated", "success");
        await loadAdminCoupons();
    } catch (err) {
        console.error("Status toggle error:", err);
        toast(err.message || "Failed to update status", "error");
    }
}

async function handleDeleteCoupon(couponId, code) {
    const confirmed = await showTablerConfirm({
        title: `Archive Coupon ${code}?`,
        message: `Are you sure you want to archive coupon <strong>${code}</strong>? It will no longer be available for new applications. Historical redemptions will remain preserved for accounting audits.`,
        confirmText: "Archive Coupon",
        confirmBtnClass: "btn-danger",
    });

    if (!confirmed) return;

    try {
        const res = await adminDelete(`/admin/coupons/${couponId}`);
        if (!res || !res.ok) throw new Error(res?.error || "Failed to archive coupon");
        toast(`Coupon ${code} archived successfully`, "success");
        await loadAdminCoupons();
    } catch (err) {
        console.error("Delete error:", err);
        toast(err.message || "Failed to archive coupon", "error");
    }
}

function openCreateCouponModal() {
    const form = document.getElementById("form-create-coupon");
    if (form) form.reset();
    document.getElementById("modal-create-coupon")?.classList.remove("d-none");
}

function closeCreateCouponModal() {
    document.getElementById("modal-create-coupon")?.classList.add("d-none");
}

async function handleCreateCouponSubmit(e) {
    e.preventDefault();
    const code = (document.getElementById("input-coupon-code")?.value || "").trim().toUpperCase();
    const discountType = document.getElementById("select-coupon-type")?.value || "fixed";
    const discountValue = parseFloat(document.getElementById("input-coupon-value")?.value || "0");
    const eligibilityCategory = document.getElementById("select-coupon-category")?.value || "all_passengers";
    const rawUsers = (document.getElementById("input-coupon-users")?.value || "").trim();
    const description = (document.getElementById("input-coupon-desc")?.value || "").trim();

    if (!code || code.length < 2) {
        toast("Coupon code must be at least 2 characters long", "error");
        return;
    }
    if (discountValue <= 0) {
        toast("Discount value must be greater than 0", "error");
        return;
    }
    if (discountType === "percentage" && discountValue > 100) {
        toast("Percentage discount cannot exceed 100%", "error");
        return;
    }

    const restrictedPassengerIds = rawUsers ? rawUsers.split(",").map(u => u.trim()).filter(Boolean) : [];

    const submitBtn = document.getElementById("btn-submit-create-coupon");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = "Creating...";
    }

    try {
        const payload = {
            code,
            discountType,
            discountValue,
            eligibilityCategory,
            restrictedPassengerIds,
            description,
            status: "active",
        };

        const res = await adminPost("/admin/coupons", payload);
        if (!res || !res.ok) {
            throw new Error(res?.error || "Failed to create coupon");
        }

        toast(`Coupon ${code} created successfully!`, "success");
        closeCreateCouponModal();
        await loadAdminCoupons();
    } catch (err) {
        console.error("Create coupon error:", err);
        toast(err.message || "Failed to create coupon", "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = "Create Coupon";
        }
    }
}

async function openRedemptionsModal(couponId, code) {
    const modal = document.getElementById("modal-view-coupon-redemptions");
    if (!modal) return;

    document.getElementById("redemptions-modal-title").innerText = `Redemptions for ${code}`;
    const tbody = document.getElementById("table-coupon-redemptions-body");
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">Loading redemptions...</td></tr>`;
    }

    modal.classList.remove("d-none");

    try {
        const res = await adminGet(`/admin/coupons/${couponId}/redemptions`);
        if (!res || !res.ok) throw new Error(res?.error || "Failed to load redemptions");

        const redemptions = res.redemptions || [];
        if (redemptions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No redemptions recorded yet for this coupon.</td></tr>`;
            return;
        }

        tbody.innerHTML = redemptions.map(r => {
            const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleString("en-IN") : "N/A";
            return `
                <tr>
                    <td><code>${r.redemptionId}</code></td>
                    <td><code>${r.passengerId}</code></td>
                    <td><code>${r.driverId}</code></td>
                    <td><strong class="text-success">₹${r.calculatedDiscountINR}</strong></td>
                    <td>₹${r.originalFareINR} &rarr; ₹${r.remainingFareAfterINR}</td>
                    <td><small class="text-muted">${dateStr}</small></td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("Redemptions fetch error:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-danger">${err.message || 'Failed to load redemptions'}</td></tr>`;
        }
    }
}

function closeRedemptionsModal() {
    document.getElementById("modal-view-coupon-redemptions")?.classList.add("d-none");
}
