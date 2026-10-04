import { adminGet, adminPost, adminPatch, adminDelete } from "./admin-api.js";
import { showTablerConfirm } from "./admin-confirm.js";
import { toast } from "./admin-toast.js";

let cachedCoupons = [];
let cachedPassengers = [];
let currentCategoryFilter = "all";
let editingCouponId = null;
let currentRestrictedPassengers = new Map(); // uid -> display label

let couponsInitialized = false;

export function initAdminCoupons() {
    if (couponsInitialized) return;
    couponsInitialized = true;

    const searchInput = document.getElementById("admin-coupon-search");
    searchInput?.addEventListener("input", renderCouponsTable);

    document.getElementById("admin-coupon-filter-all")?.addEventListener("click", () => setCouponFilter("all"));
    document.getElementById("admin-coupon-filter-active")?.addEventListener("click", () => setCouponFilter("active"));
    document.getElementById("admin-coupon-filter-default")?.addEventListener("click", () => setCouponFilter("default"));
    document.getElementById("admin-coupon-filter-inactive")?.addEventListener("click", () => setCouponFilter("inactive"));

    // Create / Edit Modal triggers
    const openBtn = document.getElementById("btn-open-create-coupon");
    if (openBtn) {
        openBtn.onclick = (e) => {
            e.preventDefault();
            openCreateCouponModal();
        };
    }
    const closeBtn = document.getElementById("btn-close-create-coupon");
    if (closeBtn) {
        closeBtn.onclick = (e) => {
            e.preventDefault();
            closeCreateCouponModal();
        };
    }
    const cancelBtn = document.getElementById("btn-cancel-create-coupon");
    if (cancelBtn) {
        cancelBtn.onclick = (e) => {
            e.preventDefault();
            closeCreateCouponModal();
        };
    }

    // Modal backdrop click to dismiss
    const createModal = document.getElementById("modal-create-coupon");
    if (createModal) {
        createModal.onclick = (e) => {
            if (e.target === createModal) closeCreateCouponModal();
        };
    }

    // Form submit
    const form = document.getElementById("form-create-coupon");
    if (form) {
        form.onsubmit = handleCreateCouponSubmit;
    }

    // Passenger picker Add button
    const btnAddPassenger = document.getElementById("btn-add-restricted-passenger");
    if (btnAddPassenger) {
        btnAddPassenger.onclick = handleAddRestrictedPassenger;
    }

    // Redemptions Modal triggers
    const closeRedemptionsBtn = document.getElementById("btn-close-coupon-redemptions");
    if (closeRedemptionsBtn) {
        closeRedemptionsBtn.onclick = (e) => {
            e.preventDefault();
            closeRedemptionsModal();
        };
    }
    const redemptionsModal = document.getElementById("modal-view-coupon-redemptions");
    if (redemptionsModal) {
        redemptionsModal.onclick = (e) => {
            if (e.target === redemptionsModal) closeRedemptionsModal();
        };
    }
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
    initAdminCoupons();
    try {
        const res = await adminGet("/coupons");
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

        const minRides = Number(coupon.minRidesRequired || 0);
        const gender = (coupon.eligibleGender || "all").toLowerCase();

        const restrictionsCount = (coupon.restrictedPassengerIds || []).length;
        const restrictionsBadge = restrictionsCount > 0
            ? `<span class="badge bg-warning-lt" title="${coupon.restrictedPassengerIds.join(', ')}">${restrictionsCount} User(s) Restricted</span>`
            : `<span class="badge bg-light text-muted">All Users</span>`;

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
                    <div class="d-flex flex-column gap-1">
                        <span class="text-dark fw-semibold">${categoryLabel}</span>
                        <div class="d-flex flex-wrap gap-1">
                            ${minRides > 0 ? `<span class="badge bg-cyan-lt text-cyan" style="font-size:10px;">${minRides}+ Rides</span>` : ''}
                            ${gender !== 'all' ? `<span class="badge bg-indigo-lt text-indigo text-capitalize" style="font-size:10px;">${gender} Only</span>` : ''}
                        </div>
                    </div>
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
                        ${!isDefault ? `
                            <button class="btn btn-sm btn-outline-primary btn-edit-coupon" data-id="${coupon.couponId}" title="Edit coupon criteria and restricted passengers">
                                <i class="ti ti-edit"></i>
                            </button>
                        ` : ''}
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

    tbody.querySelectorAll(".btn-edit-coupon").forEach(btn => {
        btn.addEventListener("click", () => {
            const coupon = cachedCoupons.find(c => c.couponId === btn.dataset.id);
            if (coupon) openCreateCouponModal(coupon);
        });
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
    const endpoint = isActivating ? `/coupons/${couponId}/activate` : `/coupons/${couponId}/deactivate`;
    try {
        const res = await adminPost(endpoint, {});
        if (!res || (!res.ok && !res.success)) throw new Error(res?.error || "Failed to update coupon status");
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
        const res = await adminDelete(`/coupons/${couponId}`);
        if (!res || (!res.ok && !res.success)) throw new Error(res?.error || "Failed to archive coupon");
        toast(`Coupon ${code} archived successfully`, "success");
        await loadAdminCoupons();
    } catch (err) {
        console.error("Delete error:", err);
        toast(err.message || "Failed to archive coupon", "error");
    }
}

async function ensurePassengersLoaded() {
    if (cachedPassengers.length > 0) {
        populatePassengerDropdown();
        return;
    }

    try {
        const data = await adminGet("/passengers?limit=100");
        cachedPassengers = data.passengers || data.items || [];
        populatePassengerDropdown();
    } catch (e) {
        console.warn("Could not load passengers for coupon picker:", e);
    }
}

function populatePassengerDropdown() {
    const picker = document.getElementById("select-coupon-passenger-picker");
    if (!picker) return;

    picker.innerHTML = `<option value="">-- Choose passenger to add --</option>` +
        cachedPassengers.map(p => {
            const uid = p.uid || p.id || p.userId;
            const name = p.name || p.displayName || "Passenger";
            const contact = p.phone || p.phoneNumber || p.email || uid;
            return `<option value="${uid}">${escapeHtml(name)} (${escapeHtml(contact)})</option>`;
        }).join("");
}

function handleAddRestrictedPassenger() {
    const picker = document.getElementById("select-coupon-passenger-picker");
    if (!picker) return;

    const uid = (picker.value || "").trim();
    if (!uid) return;

    if (currentRestrictedPassengers.has(uid)) {
        toast("Passenger is already added to restrictions", "info");
        return;
    }

    const selectedOption = picker.options[picker.selectedIndex];
    const label = selectedOption ? selectedOption.textContent : uid;

    currentRestrictedPassengers.set(uid, label);
    picker.value = "";
    renderPassengerChips();
}

function renderPassengerChips() {
    const container = document.getElementById("restricted-passengers-chips-container");
    const countBadge = document.getElementById("restricted-passengers-count-badge");
    const hiddenInput = document.getElementById("input-coupon-users");

    if (!container) return;

    const count = currentRestrictedPassengers.size;
    if (countBadge) {
        countBadge.textContent = count > 0 ? `${count} passenger(s) restricted` : "0 selected (All passengers)";
        countBadge.className = count > 0 ? "badge bg-warning-lt text-warning" : "badge bg-secondary-lt";
    }

    if (hiddenInput) {
        hiddenInput.value = Array.from(currentRestrictedPassengers.keys()).join(",");
    }

    if (count === 0) {
        container.innerHTML = `<span class="text-secondary small fst-italic p-1" id="restricted-passengers-empty-hint">No passengers restricted. Coupon is available to all qualifying passengers.</span>`;
        return;
    }

    container.innerHTML = "";

    currentRestrictedPassengers.forEach((label, uid) => {
        const chip = document.createElement("span");
        chip.className = "badge bg-blue-lt d-inline-flex align-items-center gap-1 py-1 px-2 border";
        chip.style.fontSize = "12px";

        const textSpan = document.createElement("span");
        textSpan.textContent = label;
        chip.appendChild(textSpan);

        const removeBtn = document.createElement("a");
        removeBtn.href = "javascript:void(0)";
        removeBtn.className = "text-danger ms-1 fw-bold";
        removeBtn.style.textDecoration = "none";
        removeBtn.innerHTML = "&times;";
        removeBtn.title = "Remove passenger";
        removeBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentRestrictedPassengers.delete(uid);
            renderPassengerChips();
        };

        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}

async function openCreateCouponModal(couponToEdit = null) {
    const modal = document.getElementById("modal-create-coupon");
    if (!modal) return;
    const form = document.getElementById("form-create-coupon");
    if (form) form.reset();

    await ensurePassengersLoaded();

    currentRestrictedPassengers.clear();
    editingCouponId = couponToEdit ? couponToEdit.couponId : null;

    const modalTitle = modal.querySelector(".modal-title");
    const submitBtn = document.getElementById("btn-submit-create-coupon");
    const codeInput = document.getElementById("input-coupon-code");
    const typeSelect = document.getElementById("select-coupon-type");
    const valInput = document.getElementById("input-coupon-value");
    const minRidesInput = document.getElementById("input-coupon-min-rides");
    const genderSelect = document.getElementById("select-coupon-gender");
    const descInput = document.getElementById("input-coupon-desc");

    if (couponToEdit) {
        if (modalTitle) modalTitle.innerHTML = `<i class="ti ti-edit me-2 text-primary"></i>Edit Promotional Coupon`;
        if (submitBtn) submitBtn.textContent = "Save Changes";

        if (codeInput) {
            codeInput.value = couponToEdit.code;
            codeInput.disabled = true;
        }
        if (typeSelect) {
            typeSelect.value = couponToEdit.discountType || "fixed";
            typeSelect.disabled = true;
        }
        if (valInput) {
            valInput.value = couponToEdit.discountValue || "";
            valInput.disabled = true;
        }
        if (minRidesInput) minRidesInput.value = couponToEdit.minRidesRequired ?? 0;
        if (genderSelect) genderSelect.value = (couponToEdit.eligibleGender || "all").toLowerCase();
        if (descInput) descInput.value = couponToEdit.description || "";

        // Populate restricted passenger chips
        const restricted = couponToEdit.restrictedPassengerIds || [];
        restricted.forEach(uid => {
            const passenger = cachedPassengers.find(p => (p.uid || p.id || p.userId) === uid);
            const label = passenger ? `${passenger.name || 'Passenger'} (${passenger.phone || uid})` : uid;
            currentRestrictedPassengers.set(uid, label);
        });
    } else {
        if (modalTitle) modalTitle.innerHTML = `<i class="ti ti-ticket me-2 text-primary"></i>Create Promotional Coupon`;
        if (submitBtn) submitBtn.textContent = "Create Coupon";

        if (codeInput) {
            codeInput.value = "";
            codeInput.disabled = false;
        }
        if (typeSelect) {
            typeSelect.value = "fixed";
            typeSelect.disabled = false;
        }
        if (valInput) {
            valInput.value = "";
            valInput.disabled = false;
        }
        if (minRidesInput) minRidesInput.value = "0";
        if (genderSelect) genderSelect.value = "all";
        if (descInput) descInput.value = "Promotional coupon discount";
    }

    renderPassengerChips();

    modal.style.display = "block";
    modal.classList.remove("d-none");
    modal.classList.add("show");
    setTimeout(() => {
        if (!couponToEdit) document.getElementById("input-coupon-code")?.focus();
    }, 50);
}

function closeCreateCouponModal() {
    const modal = document.getElementById("modal-create-coupon");
    if (modal) {
        modal.style.display = "none";
        modal.classList.add("d-none");
        modal.classList.remove("show");
    }
    editingCouponId = null;
    currentRestrictedPassengers.clear();
}

async function handleCreateCouponSubmit(e) {
    e.preventDefault();
    const code = (document.getElementById("input-coupon-code")?.value || "").trim().toUpperCase();
    const discountType = document.getElementById("select-coupon-type")?.value || "fixed";
    const discountValue = parseFloat(document.getElementById("input-coupon-value")?.value || "0");
    const eligibilityCategory = document.getElementById("select-coupon-category")?.value || "all_passengers";
    const minRidesRequired = parseInt(document.getElementById("input-coupon-min-rides")?.value || "0", 10) || 0;
    const eligibleGender = (document.getElementById("select-coupon-gender")?.value || "all").toLowerCase();
    const description = (document.getElementById("input-coupon-desc")?.value || "").trim();
    const restrictedPassengerIds = Array.from(currentRestrictedPassengers.keys());

    const submitBtn = document.getElementById("btn-submit-create-coupon");

    if (editingCouponId) {
        // Edit flow
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = "Saving...";
        }

        try {
            const payload = {
                minRidesRequired,
                eligibleGender,
                restrictedPassengerIds,
                description,
            };

            const res = await adminPatch(`/coupons/${editingCouponId}`, payload);
            if (!res || !res.ok) throw new Error(res?.error || "Failed to update coupon");

            toast(`Coupon updated successfully!`, "success");
            closeCreateCouponModal();
            await loadAdminCoupons();
        } catch (err) {
            console.error("Update coupon error:", err);
            toast(err.message || "Failed to update coupon", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = "Save Changes";
            }
        }
        return;
    }

    // Create flow
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
            minRidesRequired,
            eligibleGender,
            restrictedPassengerIds,
            description,
            status: "active",
        };

        const res = await adminPost("/coupons", payload);
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

    modal.style.display = "block";
    modal.classList.remove("d-none");
    modal.classList.add("show");

    try {
        const res = await adminGet(`/coupons/${couponId}/redemptions`);
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
    const modal = document.getElementById("modal-view-coupon-redemptions");
    if (modal) {
        modal.style.display = "none";
        modal.classList.add("d-none");
        modal.classList.remove("show");
    }
}

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
