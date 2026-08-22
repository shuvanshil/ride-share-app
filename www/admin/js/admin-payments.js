import { adminGet, adminPost, adminDelete } from './admin-api.js';
import { toast as showToast } from './admin-toast.js';
import { showTablerConfirm } from './admin-confirm.js';

let cachedPayments = [];
let cachedPauseConfig = null;
let cachedDriversList = [];

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

export async function loadAdminPayments() {
    const container = document.getElementById('admin-payments-table-container');
    if (!container) return;

    container.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading payment submissions...</div>
        </div>
    `;

    try {
        const data = await adminGet('/driver-payments');
        cachedPayments = data.payments || [];
        cachedPauseConfig = data.pauseConfig || null;

        // Render Pause Strip
        renderAdminPauseStrip(cachedPauseConfig);

        // Update KPI strip
        const summary = data.summary || {};
        const pendingEl = document.getElementById('admin-kpi-pending-count');
        const approvedEl = document.getElementById('admin-kpi-approved-count');
        const declinedEl = document.getElementById('admin-kpi-declined-count');
        const badgeEl = document.getElementById('admin-payments-nav-badge');

        if (pendingEl) pendingEl.innerText = summary.pendingCount || 0;
        if (approvedEl) approvedEl.innerText = summary.approvedCount || 0;
        if (declinedEl) declinedEl.innerText = summary.declinedCount || 0;

        if (badgeEl) {
            const pending = summary.pendingCount || 0;
            badgeEl.innerText = pending;
            badgeEl.classList.toggle('d-none', pending === 0);
        }

        renderPaymentsTable();
    } catch (error) {
        console.error("Error loading admin payments:", error);
        if (container) {
            container.innerHTML = `<div class="card shadow-xs border-0 text-center py-4 text-danger">Error loading payments: ${error.message}</div>`;
        }
    }
}

function renderAdminPauseStrip(pauseConfig) {
    const strip = document.getElementById('admin-pause-status-strip');
    const titleEl = document.getElementById('admin-pause-status-title');
    const subEl = document.getElementById('admin-pause-status-sub');
    if (!strip) return;

    if (pauseConfig && pauseConfig.isPaused) {
        const start = pauseConfig.startDate || 'Start';
        const end = pauseConfig.endDate || 'Ongoing';
        if (titleEl) titleEl.innerText = 'Weekly Driver Payments Currently PAUSED';
        if (subEl) subEl.innerText = `Active Date Range: ${start} → ${end} | Drivers are not asked to pay during this period.`;
        strip.classList.remove('d-none');
    } else {
        strip.classList.add('d-none');
    }
}

export function renderPaymentsTable() {
    const container = document.getElementById('admin-payments-table-container');
    const statusFilter = document.getElementById('admin-payment-status-filter')?.value || '';
    const searchVal = document.getElementById('admin-payment-search')?.value?.toLowerCase().trim() || '';

    if (!container) return;

    let filtered = cachedPayments.filter(p => {
        if (statusFilter && p.status !== statusFilter) return false;
        if (searchVal) {
            const name = (p.driverName || '').toLowerCase();
            const phone = (p.driverPhone || '').toLowerCase();
            const week = (p.weekLabel || p.weekId || '').toLowerCase();
            const ref = (p.paymentReference || '').toLowerCase();
            if (!name.includes(searchVal) && !phone.includes(searchVal) && !week.includes(searchVal) && !ref.includes(searchVal)) {
                return false;
            }
        }
        return true;
    });

    if (!filtered.length) {
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5 text-secondary">
                <i class="ti ti-inbox text-muted mb-2" style="font-size: 2.5rem; display: block;"></i>
                No payment submissions found matching the criteria.
            </div>
        `;
        return;
    }

    let rowsHtml = filtered.map(p => {
        const subDate = p.submittedAt ? new Date(p.submittedAt).toLocaleString('en-IN', {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '--';

        const verDate = p.verifiedAt ? new Date(p.verifiedAt).toLocaleString('en-IN', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        }) : '';

        let statusBadge = `<span class="badge bg-secondary-lt">${(p.status || '').toUpperCase()}</span>`;
        if (p.status === 'submitted' || p.status === 'under_review') {
            statusBadge = '<span class="badge bg-warning-lt text-warning"><i class="ti ti-clock me-1"></i>UNDER REVIEW</span>';
        } else if (p.status === 'approved' || p.status === 'verified') {
            statusBadge = '<span class="badge bg-success-lt text-success"><i class="ti ti-circle-check me-1"></i>VERIFIED</span>';
        } else if (p.status === 'declined') {
            statusBadge = '<span class="badge bg-danger-lt text-danger"><i class="ti ti-circle-x me-1"></i>DECLINED</span>';
        }

        const manualBadge = p.isManualRecord
            ? `<span class="badge bg-purple-lt text-purple ms-1">OFFLINE / CASH</span>`
            : '';

        let actionsHtml = '';
        if (p.status === 'submitted') {
            actionsHtml = `
                <div class="d-flex gap-2">
                    <button class="btn btn-success btn-sm approve-pay-btn d-inline-flex align-items-center gap-1" data-id="${p.paymentId}" type="button">
                        <i class="ti ti-check"></i> Approve
                    </button>
                    <button class="btn btn-outline-danger btn-sm decline-pay-btn d-inline-flex align-items-center gap-1" data-id="${p.paymentId}" type="button">
                        <i class="ti ti-x"></i> Decline
                    </button>
                </div>
            `;
        } else if (p.status === 'approved') {
            actionsHtml = `<small class="text-success fw-bold"><i class="ti ti-check me-1"></i>Approved by ${p.verifiedByAdminEmail || 'Admin'}<br>${verDate}</small>`;
        } else if (p.status === 'declined') {
            actionsHtml = `<small class="text-danger fw-bold"><i class="ti ti-x me-1"></i>Declined by ${p.verifiedByAdminEmail || 'Admin'}<br>${p.declineReason || ''}</small>`;
        }

        const methodLabel = (p.paymentMethod || 'upi').toUpperCase();
        const refNote = p.paymentReference ? `<br><small class="text-secondary">Ref: ${p.paymentReference}</small>` : '';

        return `
            <tr>
                <td>
                    <strong>${p.driverName || 'Driver'}</strong>${manualBadge}<br>
                    <small class="text-secondary">${p.driverPhone || p.driverId || ''}</small>
                </td>
                <td>
                    <strong>${p.weekLabel || p.weekId}</strong><br>
                    <small class="text-secondary">Week ID: ${p.weekId}</small>
                </td>
                <td>
                    <strong class="text-success">₹${p.amount || 140}</strong><br>
                    <small class="text-secondary">${methodLabel}</small>${refNote}
                </td>
                <td>${subDate}</td>
                <td>${statusBadge}</td>
                <td>${actionsHtml}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="card shadow-xs border-0">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-striped table-hover m-0">
                    <thead>
                        <tr>
                            <th>Driver Details</th>
                            <th>Payment Week</th>
                            <th>Amount &amp; Method</th>
                            <th>Submitted At</th>
                            <th>Status</th>
                            <th>Actions / Verification</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Bind Approve and Decline buttons
    container.querySelectorAll('.approve-pay-btn').forEach(btn => {
        btn.addEventListener('click', () => withButtonSpinner(btn, () => handleApprovePayment(btn.dataset.id)));
    });

    container.querySelectorAll('.decline-pay-btn').forEach(btn => {
        btn.addEventListener('click', () => withButtonSpinner(btn, () => handleDeclinePayment(btn.dataset.id)));
    });
}

async function handleApprovePayment(paymentId) {
    const confirmed = await showTablerConfirm("Are you sure you want to APPROVE this driver's weekly fee payment?", {
        title: "Approve Payment",
        variant: "success",
        confirmText: "Approve Payment"
    });
    if (!confirmed) return;

    try {
        await adminPost(`/driver-payments/${paymentId}/approve`);
        showToast("Payment approved successfully!", "success");
        await loadAdminPayments();
    } catch (error) {
        console.error("Error approving payment:", error);
        showToast(error.message || "Could not approve payment", "error");
    }
}

async function handleDeclinePayment(paymentId) {
    const reason = prompt("Enter decline reason for driver (optional):", "Payment could not be verified by accounts team.");
    if (reason === null) return;

    try {
        await adminPost(`/driver-payments/${paymentId}/decline`, { declineReason: reason });
        showToast("Payment submission declined.", "warning");
        await loadAdminPayments();
    } catch (error) {
        console.error("Error declining payment:", error);
        showToast(error.message || "Could not decline payment", "error");
    }
}

// ============ PAUSE SETTINGS MODAL ============

function openPauseModal() {
    const modal = document.getElementById('admin-pause-modal');
    if (!modal) return;

    const switchEl = document.getElementById('pause-enable-switch');
    const startEl = document.getElementById('pause-start-date');
    const endEl = document.getElementById('pause-end-date');
    const msgEl = document.getElementById('pause-message-input');

    if (cachedPauseConfig) {
        if (switchEl) switchEl.checked = Boolean(cachedPauseConfig.configuredPaused || cachedPauseConfig.isPaused);
        if (startEl) startEl.value = cachedPauseConfig.startDate || '';
        if (endEl) endEl.value = cachedPauseConfig.endDate || '';
        if (msgEl) msgEl.value = cachedPauseConfig.message || '';
    }

    modal.classList.remove('d-none');
}

function closePauseModal() {
    const modal = document.getElementById('admin-pause-modal');
    if (modal) modal.classList.add('d-none');
}

async function handleSavePauseSettings(e) {
    e.preventDefault();
    const saveBtn = document.getElementById('pause-save-btn');
    await withButtonSpinner(saveBtn, async () => {
        const switchEl = document.getElementById('pause-enable-switch');
        const startEl = document.getElementById('pause-start-date');
        const endEl = document.getElementById('pause-end-date');
        const msgEl = document.getElementById('pause-message-input');

        const payload = {
            isPaused: switchEl ? switchEl.checked : true,
            startDate: startEl ? startEl.value : null,
            endDate: endEl ? endEl.value : null,
            message: msgEl ? msgEl.value : "Weekly payments are currently paused. Chill and relax — no payment is required during this period."
        };

        try {
            await adminPost('/driver-payments/pause', payload);
            showToast("Payment pause settings updated successfully!", "success");
            closePauseModal();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error saving pause settings:", error);
            showToast(error.message || "Could not update pause settings", "error");
        }
    });
}

async function handleClearPauseSettings(btn) {
    const confirmed = await showTablerConfirm("Are you sure you want to END the weekly payment pause and resume normal payment requirements?", {
        title: "End Payment Pause",
        variant: "warning",
        confirmText: "End Pause"
    });
    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            await adminDelete('/driver-payments/pause');
            showToast("Payment pause ended. Normal payment schedule resumed.", "info");
            closePauseModal();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error clearing pause settings:", error);
            showToast(error.message || "Could not end payment pause", "error");
        }
    });
}

// ============ RECORD MANUAL PAYMENT MODAL ============

async function fetchDriversList() {
    const select = document.getElementById('manual-pay-driver-select');
    if (!select) return;

    try {
        select.innerHTML = '<option value="">Loading drivers list...</option>';
        const data = await adminGet('/drivers', { limit: 200 });
        cachedDriversList = data.drivers || data.items || [];

        if (!cachedDriversList.length) {
            select.innerHTML = '<option value="">No drivers found</option>';
            return;
        }

        select.innerHTML = '<option value="">Select a driver...</option>' + cachedDriversList.map(d => {
            const name = d.name || d.displayName || 'Driver';
            const phone = d.phone || d.phoneNumber || '';
            const uid = d.uid || d.id;
            return `<option value="${uid}">${name} (${phone})</option>`;
        }).join('');
    } catch (error) {
        console.error("Error loading drivers for manual payment:", error);
        select.innerHTML = '<option value="">Error loading drivers list</option>';
    }
}

function openManualPayModal() {
    const modal = document.getElementById('admin-manual-payment-modal');
    if (!modal) return;

    fetchDriversList();
    modal.classList.remove('d-none');
}

function closeManualPayModal() {
    const modal = document.getElementById('admin-manual-payment-modal');
    if (modal) modal.classList.add('d-none');
}

async function handleSaveManualPayment(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('manual-pay-submit-btn');
    await withButtonSpinner(submitBtn, async () => {
        const driverSelect = document.getElementById('manual-pay-driver-select');
        const weekInput = document.getElementById('manual-pay-week-input');
        const amountInput = document.getElementById('manual-pay-amount-input');
        const methodSelect = document.getElementById('manual-pay-method-select');
        const refInput = document.getElementById('manual-pay-ref-input');

        const driverId = driverSelect ? driverSelect.value : '';
        if (!driverId) {
            showToast("Please select a driver.", "warning");
            return;
        }

        const payload = {
            driverId: driverId,
            weekId: weekInput ? weekInput.value.trim() : null,
            amount: amountInput ? parseFloat(amountInput.value) || 140 : 140,
            paymentMethod: methodSelect ? methodSelect.value : 'cash',
            paymentReference: refInput ? refInput.value.trim() : 'Collected offline in cash'
        };

        try {
            await adminPost('/driver-payments/record-manual', payload);
            showToast("Offline payment recorded and approved successfully!", "success");
            closeManualPayModal();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error recording manual payment:", error);
            showToast(error.message || "Could not record manual payment", "error");
        }
    });
}

async function handleResetAllPayments(btn) {
    const confirmed = await showTablerConfirm("⚠️ WARNING: Are you sure you want to RESET ALL DRIVER PAYMENTS?\n\nThis will remove all existing payment records and restart everyone from zeroth week with NO due amount.", {
        title: "Reset All Driver Payments",
        variant: "danger",
        confirmText: "Reset All Payments"
    });
    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost('/driver-payments/reset-all');
            showToast(res.message || "All driver payments reset successfully!", "success");
            await loadAdminPayments();
        } catch (error) {
            console.error("Error resetting all driver payments:", error);
            showToast(error.message || "Could not reset driver payments", "error");
        }
    });
}

export function initAdminPayments() {
    const statusFilter = document.getElementById('admin-payment-status-filter');
    const searchInput = document.getElementById('admin-payment-search');

    statusFilter?.addEventListener('change', renderPaymentsTable);
    searchInput?.addEventListener('input', renderPaymentsTable);

    const resetBtn = document.getElementById('admin-reset-all-payments-btn');
    resetBtn?.addEventListener('click', () => handleResetAllPayments(resetBtn));

    // Pause Modal Triggers
    document.getElementById('admin-open-pause-modal-btn')?.addEventListener('click', openPauseModal);
    document.getElementById('pause-modal-close-btn')?.addEventListener('click', closePauseModal);
    document.getElementById('admin-pause-form')?.addEventListener('submit', handleSavePauseSettings);
    
    const pauseClearBtn = document.getElementById('pause-clear-btn');
    pauseClearBtn?.addEventListener('click', () => handleClearPauseSettings(pauseClearBtn));
    
    const quickClearBtn = document.getElementById('admin-quick-end-pause-btn');
    quickClearBtn?.addEventListener('click', () => handleClearPauseSettings(quickClearBtn));

    // Manual Pay Modal Triggers
    document.getElementById('admin-open-manual-pay-btn')?.addEventListener('click', openManualPayModal);
    document.getElementById('manual-pay-close-btn')?.addEventListener('click', closeManualPayModal);
    document.getElementById('manual-pay-cancel-btn')?.addEventListener('click', closeManualPayModal);
    document.getElementById('admin-manual-pay-form')?.addEventListener('submit', handleSaveManualPayment);
}
