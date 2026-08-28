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
        return await actionFn();
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
            badgeEl.innerText = `(${pending})`;
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
        btn.addEventListener('click', () => handleApprovePayment(btn.dataset.id, btn));
    });

    container.querySelectorAll('.decline-pay-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeclinePayment(btn.dataset.id, btn));
    });
}

async function handleApprovePayment(paymentId, btn) {
    const confirmed = await showTablerConfirm("Are you sure you want to APPROVE this driver's weekly fee payment?", {
        title: "Approve Payment",
        variant: "success",
        confirmText: "Approve Payment"
    });
    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            await adminPost(`/driver-payments/${paymentId}/approve`);
            showToast("Payment approved successfully!", "success");
            await loadAdminPayments();
        } catch (error) {
            console.error("Error approving payment:", error);
            showToast(error.message || "Could not approve payment", "error");
        }
    });
}

async function handleDeclinePayment(paymentId, btn) {
    const reason = prompt("Enter decline reason for driver (optional):", "Payment could not be verified by accounts team.");
    if (reason === null) return;

    await withButtonSpinner(btn, async () => {
        try {
            await adminPost(`/driver-payments/${paymentId}/decline`, { declineReason: reason });
            showToast("Payment submission declined.", "warning");
            await loadAdminPayments();
        } catch (error) {
            console.error("Error declining payment:", error);
            showToast(error.message || "Could not decline payment", "error");
        }
    });
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

    modal.style.display = 'block';
    modal.classList.remove('d-none');
}

function closePauseModal() {
    const modal = document.getElementById('admin-pause-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
    }
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
    modal.style.display = 'block';
    modal.classList.remove('d-none');
}

function closeManualPayModal() {
    const modal = document.getElementById('admin-manual-payment-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
    }
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

    // Initialize Wallet Credit Admin UI
    initAdminWalletCredit();
}

// =========================================================================
// WALLET CREDIT ADMIN PORTAL
// =========================================================================

let cachedPassengerWallets = [];
let cachedDriverSettlements = [];

export function initAdminWalletCredit() {
    // 1. Top Tabs (Service Fee vs Wallet Credit)
    const tabServiceFee = document.getElementById('admin-tab-btn-service-fee');
    const tabWalletCredit = document.getElementById('admin-tab-btn-wallet-credit');
    const paneServiceFee = document.getElementById('admin-pane-service-fee');
    const paneWalletCredit = document.getElementById('admin-pane-wallet-credit');

    tabServiceFee?.addEventListener('click', () => {
        tabServiceFee.classList.add('active');
        tabWalletCredit?.classList.remove('active');
        paneServiceFee?.classList.remove('d-none');
        paneWalletCredit?.classList.add('d-none');
    });

    tabWalletCredit?.addEventListener('click', () => {
        tabWalletCredit.classList.add('active');
        tabServiceFee?.classList.remove('active');
        paneWalletCredit?.classList.remove('d-none');
        paneServiceFee?.classList.add('d-none');
        loadAdminPassengerWallets();
    });

    // 2. Sub Tabs (Passenger vs Driver)
    const subtabPassenger = document.getElementById('admin-subtab-passenger');
    const subtabDriver = document.getElementById('admin-subtab-driver');
    const viewPassenger = document.getElementById('admin-wallet-passenger-view');
    const viewDriver = document.getElementById('admin-wallet-driver-view');

    subtabPassenger?.addEventListener('click', () => {
        subtabPassenger.classList.add('active');
        subtabDriver?.classList.remove('active');
        viewPassenger?.classList.remove('d-none');
        viewDriver?.classList.add('d-none');
        loadAdminPassengerWallets();
    });

    subtabDriver?.addEventListener('click', () => {
        subtabDriver.classList.add('active');
        subtabPassenger?.classList.remove('active');
        viewDriver?.classList.remove('d-none');
        viewPassenger?.classList.add('d-none');
        loadAdminDriverSettlements();
    });

    // 3. Passenger Search
    document.getElementById('admin-passenger-search')?.addEventListener('input', renderPassengerWalletsTable);

    // 4. Grant Credit Modal
    document.getElementById('admin-open-grant-credit-btn')?.addEventListener('click', openGrantCreditModal);
    document.getElementById('grant-credit-close-btn')?.addEventListener('click', closeGrantCreditModal);
    document.getElementById('grant-credit-cancel-btn')?.addEventListener('click', closeGrantCreditModal);
    document.getElementById('admin-grant-credit-form')?.addEventListener('submit', handleGrantCreditSubmit);

    // 5. Reverse Credit Modal
    document.getElementById('reverse-credit-close-btn')?.addEventListener('click', closeReverseCreditModal);
    document.getElementById('reverse-credit-cancel-btn')?.addEventListener('click', closeReverseCreditModal);
    document.getElementById('admin-reverse-credit-form')?.addEventListener('submit', handleReverseCreditSubmit);

    // 6. Passenger History Modal
    document.getElementById('passenger-wallet-modal-close-btn')?.addEventListener('click', closePassengerWalletHistoryModal);

    // 7. Driver Settlement Actions & Modals
    document.getElementById('admin-driver-wallet-search')?.addEventListener('input', renderDriverSettlementsTable);
    document.getElementById('admin-save-settlement-date-btn')?.addEventListener('click', handleSaveSettlementDate);
    document.getElementById('resolve-settlement-close-btn')?.addEventListener('click', closeResolveSettlementModal);
    document.getElementById('resolve-settlement-cancel-btn')?.addEventListener('click', closeResolveSettlementModal);
    document.getElementById('admin-resolve-settlement-form')?.addEventListener('submit', handleResolveSettlementSubmit);
    document.getElementById('copy-driver-upi-btn')?.addEventListener('click', () => {
        const upiVal = document.getElementById('resolve-driver-upi-val')?.value;
        if (upiVal) {
            navigator.clipboard?.writeText(upiVal);
            showToast("UPI ID copied to clipboard!", "info");
        }
    });
}

// --- PASSENGER CREDIT MANAGEMENT ---

export async function loadAdminPassengerWallets() {
    const container = document.getElementById('admin-passengers-wallet-table-container');
    if (!container) return;

    container.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-success mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading passenger wallets...</div>
        </div>
    `;

    try {
        const data = await adminGet('/wallet/passengers');
        cachedPassengerWallets = data.passengers || [];
        renderPassengerWalletsTable();
    } catch (error) {
        console.error("Error loading passenger wallets:", error);
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <div class="text-danger small">${error.message || "Failed to load passenger wallets"}</div>
            </div>
        `;
    }
}

function renderPassengerWalletsTable() {
    const container = document.getElementById('admin-passengers-wallet-table-container');
    if (!container) return;

    const query = (document.getElementById('admin-passenger-search')?.value || '').toLowerCase().trim();
    const filtered = cachedPassengerWallets.filter(p => {
        if (!query) return true;
        const name = (p.name || '').toLowerCase();
        const phone = (p.phone || '').toLowerCase();
        const email = (p.email || '').toLowerCase();
        return name.includes(query) || phone.includes(query) || email.includes(query);
    });

    if (!filtered.length) {
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <p class="text-secondary mb-0">No passenger wallets found.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="card shadow-xs border-0">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-hover">
                    <thead>
                        <tr>
                            <th>Passenger</th>
                            <th>Contact</th>
                            <th>Wallet Balance</th>
                            <th class="text-end">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${filtered.map(p => `
                            <tr>
                                <td>
                                    <div class="d-flex align-items-center">
                                        <div class="avatar avatar-sm rounded-circle me-2 bg-primary-lt text-primary fw-bold">
                                            ${(p.name || 'P').charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                            <div class="font-weight-bold">${p.name || 'Passenger'}</div>
                                            <div class="text-secondary small font-monospace">${p.userId || p.passengerId}</div>
                                        </div>
                                    </div>
                                </td>
                                <td>
                                    <div>${p.phone || '--'}</div>
                                    <div class="text-secondary small">${p.email || '--'}</div>
                                </td>
                                <td>
                                    <span class="badge ${p.balance > 0 ? 'bg-success-lt text-success' : 'bg-secondary-lt text-secondary'} font-weight-bold fs-6">
                                        ₹${(p.balance ?? 0).toLocaleString('en-IN')}
                                    </span>
                                </td>
                                <td class="text-end">
                                    <div class="btn-list justify-content-end">
                                        <button class="btn btn-outline-primary btn-sm btn-view-pass-history" data-uid="${p.userId || p.passengerId}" data-name="${p.name || ''}" data-phone="${p.phone || ''}" data-bal="${p.balance || 0}" type="button">
                                            <i class="ti ti-history me-1"></i> Ledger
                                        </button>
                                        <button class="btn btn-outline-success btn-sm btn-grant-pass-credit" data-uid="${p.userId || p.passengerId}" type="button">
                                            <i class="ti ti-plus me-1"></i> Grant
                                        </button>
                                        <button class="btn btn-outline-secondary btn-sm btn-reconcile-wallet" data-uid="${p.userId || p.passengerId}" data-role="passenger" type="button" title="Audit & Reconcile">
                                            <i class="ti ti-check"></i>
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Attach row button events
    container.querySelectorAll('.btn-view-pass-history').forEach(btn => {
        btn.addEventListener('click', () => {
            openPassengerWalletHistoryModal(btn.dataset.uid, btn.dataset.name, btn.dataset.phone, btn.dataset.bal);
        });
    });

    container.querySelectorAll('.btn-grant-pass-credit').forEach(btn => {
        btn.addEventListener('click', () => {
            openGrantCreditModal(btn.dataset.uid);
        });
    });

    container.querySelectorAll('.btn-reconcile-wallet').forEach(btn => {
        btn.addEventListener('click', () => {
            handleReconcileWallet(btn.dataset.uid, btn.dataset.role, btn);
        });
    });
}

async function openGrantCreditModal(preselectedUserId = '') {
    const modal = document.getElementById('admin-grant-credit-modal');
    const select = document.getElementById('grant-credit-passenger-select');
    const amountInput = document.getElementById('grant-credit-amount-input');
    const descInput = document.getElementById('grant-credit-desc-input');
    if (!modal || !select) return;

    select.innerHTML = `<option value="">Loading passenger accounts...</option>`;
    if (amountInput) amountInput.value = '';
    if (descInput) descInput.value = 'Promotional bonus credit';

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');

    try {
        if (!cachedPassengerWallets.length) {
            const data = await adminGet('/wallet/passengers');
            cachedPassengerWallets = data.passengers || [];
        }

        select.innerHTML = `
            <option value="">Select a passenger...</option>
            ${cachedPassengerWallets.map(p => {
                const uid = p.userId || p.passengerId || '';
                return `
                    <option value="${uid}" ${uid === preselectedUserId ? 'selected' : ''}>
                        ${p.name || 'Passenger'} (${p.phone || p.email || uid}) · Balance: ₹${p.balance || 0}
                    </option>
                `;
            }).join('')}
        `;
        if (amountInput) setTimeout(() => amountInput.focus(), 100);
    } catch (e) {
        console.error("Error populating passengers:", e);
    }
}

function closeGrantCreditModal() {
    const modal = document.getElementById('admin-grant-credit-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
}

async function handleGrantCreditSubmit(e) {
    e.preventDefault();
    const select = document.getElementById('grant-credit-passenger-select');
    const amountInput = document.getElementById('grant-credit-amount-input');
    const tagSelect = document.getElementById('grant-credit-tag-select');
    const descInput = document.getElementById('grant-credit-desc-input');
    const submitBtn = document.getElementById('grant-credit-submit-btn');

    const passengerId = select?.value;
    const amount = parseFloat(amountInput?.value || '0');
    const tag = tagSelect?.value || 'Bonus';
    const description = descInput?.value?.trim() || 'Promotional credit';

    if (!passengerId || amount <= 0) {
        showToast("Please select a passenger and valid credit amount.", "warning");
        return;
    }

    await withButtonSpinner(submitBtn, async () => {
        try {
            const res = await adminPost('/wallet/passenger/grant-credit', {
                passengerId,
                amount,
                tags: [tag],
                description
            });
            showToast(res.message || "Credits granted successfully!", "success");
            closeGrantCreditModal();
            await loadAdminPassengerWallets();
        } catch (error) {
            console.error("Grant credit error:", error);
            showToast(error.message || "Failed to grant credits", "error");
        }
    });
}

function closePassengerWalletHistoryModal() {
    const modal = document.getElementById('admin-passenger-wallet-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
}

async function openPassengerWalletHistoryModal(userId, name, phone, balance) {
    const modal = document.getElementById('admin-passenger-wallet-modal');
    const nameEl = document.getElementById('admin-modal-passenger-name');
    const phoneEl = document.getElementById('admin-modal-passenger-phone');
    const balEl = document.getElementById('admin-modal-passenger-balance');
    const tableContainer = document.getElementById('admin-modal-tx-table-container');

    if (!modal) return;
    if (nameEl) nameEl.innerText = name || 'Passenger';
    if (phoneEl) phoneEl.innerText = phone || userId;
    if (balEl) balEl.innerText = `₹${parseFloat(balance || 0).toLocaleString('en-IN')}`;

    if (tableContainer) {
        tableContainer.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
                <div class="text-secondary small mt-1">Loading ledger transactions...</div>
            </div>
        `;
    }

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');

    try {
        const data = await adminGet(`/wallet/user/${encodeURIComponent(userId)}/transactions?limit=50`);
        const txs = data.transactions || [];

        if (!txs.length) {
            tableContainer.innerHTML = `<p class="text-secondary text-center py-3 mb-0">No transactions recorded for this wallet.</p>`;
            return;
        }

        tableContainer.innerHTML = `
            <table class="table table-sm table-vcenter">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Type / Description</th>
                        <th>Amount</th>
                        <th>Balance After</th>
                        <th>Status</th>
                        <th class="text-end">Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${txs.map(tx => {
                        const isCredit = tx.direction === 'credit';
                        const sign = isCredit ? '+' : '-';
                        const isReversible = tx.isReversible && !tx.isReversed;
                        const dateStr = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

                        return `
                            <tr>
                                <td class="text-secondary small">${dateStr}</td>
                                <td>
                                    <strong>${tx.description || tx.transactionType}</strong>
                                    ${tx.tags && tx.tags.length ? `
                                        <div class="mt-0.5">${tx.tags.map(tg => `<span class="badge bg-success-subtle text-success me-1 px-1.5 py-0.5" style="font-size:9px;">${tg}</span>`).join('')}</div>
                                    ` : ''}
                                </td>
                                <td class="${isCredit ? 'text-success font-weight-bold' : 'text-dark'}">${sign}₹${(tx.amount ?? 0).toLocaleString('en-IN')}</td>
                                <td class="text-secondary font-monospace small">₹${(tx.balanceAfter ?? 0).toLocaleString('en-IN')}</td>
                                <td>
                                    <span class="badge ${tx.isReversed ? 'bg-danger-subtle text-danger' : (isCredit ? 'bg-success-subtle text-success' : 'bg-light text-secondary')}">
                                        ${tx.isReversed ? 'Reversed' : tx.status}
                                    </span>
                                </td>
                                <td class="text-end">
                                    ${isReversible ? `
                                        <button class="btn btn-outline-danger btn-xs btn-trigger-reversal" data-txid="${tx.transactionId}" data-amt="${tx.amount}" data-user="${name || userId}" type="button">
                                            <i class="ti ti-rotate-2"></i> Reverse
                                        </button>
                                    ` : (tx.amount > 1000 && isCredit ? '<small class="text-muted">Non-reversible</small>' : '--')}
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;

        tableContainer.querySelectorAll('.btn-trigger-reversal').forEach(btn => {
            btn.addEventListener('click', () => {
                openReverseCreditModal(btn.dataset.txid, btn.dataset.amt, btn.dataset.user);
            });
        });
    } catch (error) {
        console.error("Error loading transactions:", error);
        tableContainer.innerHTML = `<p class="text-danger text-center py-3 mb-0">${error.message || "Failed to load transactions"}</p>`;
    }
}

function openReverseCreditModal(txId, amount, recipient) {
    const modal = document.getElementById('admin-reverse-credit-modal');
    const txIdInput = document.getElementById('reverse-tx-id-input');
    const amtVal = document.getElementById('reverse-amount-val');
    const recipVal = document.getElementById('reverse-recipient-val');
    const reasonInput = document.getElementById('reverse-reason-input');

    if (!modal) return;
    if (txIdInput) txIdInput.value = txId;
    if (amtVal) amtVal.innerText = `₹${parseFloat(amount || 0).toLocaleString('en-IN')}`;
    if (recipVal) recipVal.innerText = recipient || '--';
    if (reasonInput) reasonInput.value = '';

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');
}

function closeReverseCreditModal() {
    const modal = document.getElementById('admin-reverse-credit-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
}

async function handleReverseCreditSubmit(e) {
    e.preventDefault();
    const txId = document.getElementById('reverse-tx-id-input')?.value;
    const reason = document.getElementById('reverse-reason-input')?.value?.trim();
    const submitBtn = document.getElementById('reverse-credit-submit-btn');

    if (!txId || !reason) {
        showToast("Please enter a reason for reversal.", "warning");
        return;
    }

    await withButtonSpinner(submitBtn, async () => {
        try {
            const res = await adminPost('/wallet/passenger/reverse-credit', {
                transactionId: txId,
                reason
            });
            showToast(res.message || "Credit reversed successfully!", "success");
            closeReverseCreditModal();
            closePassengerWalletHistoryModal();
            await loadAdminPassengerWallets();
        } catch (error) {
            console.error("Reversal failed:", error);
            showToast(error.message || "Failed to reverse credit", "error");
        }
    });
}

// --- DRIVER CREDIT MANAGEMENT ---

export async function loadAdminDriverSettlements() {
    const container = document.getElementById('admin-drivers-settlement-table-container');
    const dateInput = document.getElementById('admin-driver-settlement-date-input');
    if (!container) return;

    container.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-success mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading driver settlement accounts...</div>
        </div>
    `;

    try {
        const [configData, summaryData] = await Promise.all([
            adminGet('/wallet/driver/settlement-config'),
            adminGet('/wallet/driver/settlements-summary')
        ]);

        if (dateInput && configData?.nextSettlementDate) {
            dateInput.value = configData.nextSettlementDate;
        }

        cachedDriverSettlements = summaryData.driverSettlements || [];
        renderDriverSettlementsTable();
    } catch (error) {
        console.error("Error loading driver settlements:", error);
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <div class="text-danger small">${error.message || "Failed to load driver settlements"}</div>
            </div>
        `;
    }
}

function renderDriverSettlementsTable() {
    const container = document.getElementById('admin-drivers-settlement-table-container');
    if (!container) return;

    const query = (document.getElementById('admin-driver-wallet-search')?.value || '').toLowerCase().trim();
    const filtered = cachedDriverSettlements.filter(d => {
        if (!query) return true;
        const name = (d.name || '').toLowerCase();
        const phone = (d.phone || '').toLowerCase();
        const upi = (d.upiId || '').toLowerCase();
        return name.includes(query) || phone.includes(query) || upi.includes(query);
    });

    if (!filtered.length) {
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <p class="text-secondary mb-0">No driver accounts found.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="card shadow-xs border-0">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-hover">
                    <thead>
                        <tr>
                            <th>Driver</th>
                            <th>Contact &amp; UPI ID</th>
                            <th>Wallet Balance</th>
                            <th>Settlement Status</th>
                            <th class="text-end">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${filtered.map(d => {
                            const hasBalance = (d.balance || 0) > 0;

                            return `
                                <tr>
                                    <td>
                                        <div class="d-flex align-items-center">
                                            <div class="avatar avatar-sm rounded-circle me-2 bg-success-lt text-success fw-bold">
                                                ${(d.name || 'D').charAt(0).toUpperCase()}
                                            </div>
                                            <div>
                                                <div class="font-weight-bold">${d.name || 'Driver'}</div>
                                                <div class="text-secondary small font-monospace">${d.driverId}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <div>${d.phone || '--'}</div>
                                        <div class="text-success small font-monospace">${d.upiId || '<span class="text-danger">No UPI Registered</span>'}</div>
                                    </td>
                                    <td>
                                        <strong class="h4 mb-0 text-dark">₹${(d.balance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                    </td>
                                    <td>
                                        ${hasBalance ? `
                                            <span class="badge bg-success-subtle text-success p-1.5">
                                                Ready to Settle
                                            </span>
                                        ` : `
                                            <span class="badge bg-light text-secondary p-1.5">
                                                Settled / Zero Balance
                                            </span>
                                        `}
                                    </td>
                                    <td class="text-end">
                                        <div class="btn-list justify-content-end">
                                            <button class="btn btn-success btn-sm btn-resolve-settlement" data-driver-id="${d.driverId}" data-amt="${d.balance || 0}" data-upi="${d.upiId || ''}" ${!hasBalance ? 'disabled' : ''} type="button">
                                                <i class="ti ti-check me-1"></i> Resolve
                                            </button>
                                            <button class="btn btn-outline-secondary btn-sm btn-reconcile-wallet" data-uid="${d.driverId}" data-role="driver" type="button" title="Audit & Reconcile">
                                                <i class="ti ti-check"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.querySelectorAll('.btn-resolve-settlement').forEach(btn => {
        btn.addEventListener('click', () => {
            openResolveSettlementModal(btn.dataset.driverId, btn.dataset.amt, btn.dataset.upi);
        });
    });

    container.querySelectorAll('.btn-reconcile-wallet').forEach(btn => {
        btn.addEventListener('click', () => {
            handleReconcileWallet(btn.dataset.uid, btn.dataset.role, btn);
        });
    });
}

async function handleSaveSettlementDate() {
    const input = document.getElementById('admin-driver-settlement-date-input');
    const btn = document.getElementById('admin-save-settlement-date-btn');
    const dateVal = input?.value;

    if (!dateVal) {
        showToast("Please choose a valid settlement date.", "warning");
        return;
    }

    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost('/wallet/driver/settlement-config', { nextSettlementDate: dateVal });
            showToast(res.message || "Settlement date updated successfully!", "success");
        } catch (e) {
            console.error("Save settlement date failed:", e);
            showToast(e.message || "Failed to update settlement date", "error");
        }
    });
}

function openResolveSettlementModal(driverId, amount, upiId) {
    const modal = document.getElementById('admin-resolve-settlement-modal');
    const driverIdInput = document.getElementById('resolve-driver-id-input');
    const idInput = document.getElementById('resolve-settlement-id-input');
    const amtVal = document.getElementById('resolve-settlement-amount-val');
    const upiVal = document.getElementById('resolve-driver-upi-val');
    const qrImg = document.getElementById('resolve-settlement-qr-img');
    const noteInput = document.getElementById('resolve-admin-note-input');

    if (!modal) return;
    if (driverIdInput) driverIdInput.value = driverId || '';
    if (idInput) idInput.value = '';
    if (amtVal) amtVal.innerText = `₹${parseFloat(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (upiVal) upiVal.value = upiId || 'No UPI ID';
    if (noteInput) noteInput.value = 'UPI transfer completed';

    if (qrImg) {
        if (upiId && parseFloat(amount || 0) > 0) {
            const upiString = encodeURIComponent(`upi://pay?pa=${upiId}&pn=DriverSettlement&am=${amount}&cu=INR`);
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
            qrImg.classList.remove('d-none');
        } else {
            qrImg.classList.add('d-none');
        }
    }

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');
}

function closeResolveSettlementModal() {
    const modal = document.getElementById('admin-resolve-settlement-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
}

async function handleResolveSettlementSubmit(e) {
    e.preventDefault();
    const driverId = document.getElementById('resolve-driver-id-input')?.value;
    const settlementId = document.getElementById('resolve-settlement-id-input')?.value;
    const adminNote = document.getElementById('resolve-admin-note-input')?.value?.trim() || 'UPI transfer completed';
    const submitBtn = document.getElementById('resolve-settlement-submit-btn');

    if (!driverId && !settlementId) {
        showToast("Driver ID or Settlement ID is missing.", "warning");
        return;
    }

    await withButtonSpinner(submitBtn, async () => {
        try {
            const res = await adminPost('/wallet/driver/resolve-settlement', { driverId, settlementId, adminNote });
            showToast(`Settlement resolved! Deducted ₹${res.settlement?.settledAmount}. Wallet reset to zero.`, "success");
            closeResolveSettlementModal();
            await loadAdminDriverSettlements();
        } catch (e) {
            console.error("Resolve settlement failed:", e);
            showToast(e.message || "Failed to resolve settlement", "error");
        }
    });
}

async function handleReconcileWallet(userId, role, btn) {
    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminGet(`/wallet/reconcile/${encodeURIComponent(userId)}`);
            const rep = res.reconciliationReport || {};
            if (rep.isBalanced) {
                showToast(`✅ Wallet is in PERFECT BALANCE: Materialized ₹${rep.materializedBalance} matches calculated ₹${rep.expectedBalance}.`, "success");
            } else {
                showToast(`⚠️ DISCREPANCY DETECTED: Materialized ₹${rep.materializedBalance} vs Expected ₹${rep.expectedBalance}. Discrepancy: ₹${rep.discrepancy}.`, "error");
            }
        } catch (e) {
            console.error("Reconciliation failed:", e);
            showToast(e.message || "Failed to reconcile wallet", "error");
        }
    });
}
