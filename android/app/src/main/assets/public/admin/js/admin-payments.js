import { adminGet, adminPost, adminDelete } from './admin-api.js?v=2.7.0';
import { toast as showToast } from './admin-toast.js?v=2.7.0';
import { showTablerConfirm } from './admin-confirm.js?v=2.7.0';
import { storage, ref, getDownloadURL, listAll } from '../../js/platform/firebase-init.js';

let cachedPayments = [];
let cachedPauseConfig = null;
let cachedDriversList = [];
let cachedDistanceReviews = [];
let currentDistReviewAction = null;

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

        // Fetch Phase 2 Fee Batches and merge into cachedPayments
        try {
            const batchRes = await adminGet('/fee-batches');
            const feeBatches = batchRes.batches || [];
            const seenBatchIds = new Set(feeBatches.map(b => b.batchId || b.id).filter(Boolean));
            if (seenBatchIds.size > 0) {
                cachedPayments = cachedPayments.filter(p => !p.batchId || !seenBatchIds.has(p.batchId));
            }
            feeBatches.forEach(b => {
                const allocs = b.allocations || [];
                const bBatchId = b.batchId || b.id;
                allocs.forEach(a => {
                    const aFeeId = a.fee_id || a.feeId || a.id;
                    const rawStatus = (a.status || 'PENDING').toLowerCase();
                    let normStatus = 'submitted';
                    if (rawStatus === 'approved') normStatus = 'approved';
                    else if (rawStatus === 'declined') normStatus = 'declined';
                    else normStatus = 'submitted';

                    cachedPayments.push({
                        paymentId: `${bBatchId}_${aFeeId}`,
                        batchId: bBatchId,
                        feeId: aFeeId,
                        driverId: b.uid,
                        driverName: b.driverName || b.driver_name || 'Driver',
                        driverPhone: b.driverPhone || b.driver_phone || '',
                        weekId: a.serviceDate || bBatchId,
                        weekLabel: `Service Day ${a.serviceDate || ''}`,
                        amount: ((a.amount_paise || 0) / 100),
                        status: normStatus,
                        rawStatus: a.status || 'PENDING',
                        paymentMethod: b.paymentMethod || b.payment_method || 'upi',
                        paymentReference: b.paymentReference || b.payment_reference || 'Daily fee payment',
                        proofDownloadUrl: b.proofDownloadUrl || b.proof_download_url || b.screenshot_url || b.screenshot_path,
                        proofStoragePath: b.proofStoragePath || b.screenshot_path,
                        submittedAt: b.created_at,
                        verifiedAt: a.decided_at,
                        verifiedByAdminEmail: a.decided_by,
                        declineReason: a.note,
                        isFeeBatchAllocation: true,
                        batchAllocations: allocs,
                    });
                });
            });
        } catch (bErr) {
            console.warn("Could not load fee batches:", bErr);
        }

        // Render Pause Strip
        renderAdminPauseStrip(cachedPauseConfig);

        // Update KPI strip
        const summary = data.summary || {};
        const pendingAllocCount = cachedPayments.filter(p => p.status === 'submitted' || p.status === 'under_review').length;
        const pendingEl = document.getElementById('admin-kpi-pending-count');
        const approvedEl = document.getElementById('admin-kpi-approved-count');
        const declinedEl = document.getElementById('admin-kpi-declined-count');
        const badgeEl = document.getElementById('admin-payments-nav-badge');

        if (pendingEl) pendingEl.innerText = pendingAllocCount;
        if (approvedEl) approvedEl.innerText = summary.approvedCount || 0;
        if (declinedEl) declinedEl.innerText = summary.declinedCount || 0;

        if (badgeEl) {
            badgeEl.innerText = `(${pendingAllocCount})`;
            badgeEl.classList.toggle('d-none', pendingAllocCount === 0);
        }

        // Update Distance Reviews count badge
        try {
            const distRes = await adminGet('/distance-reviews?status=PENDING&limit=100');
            const distItems = distRes.reviews || distRes.items || [];
            const distBadge = document.getElementById('admin-distance-reviews-badge');
            if (distBadge) {
                distBadge.innerText = distItems.length;
                distBadge.classList.toggle('d-none', distItems.length === 0);
            }
        } catch (dErr) {
            console.warn("Could not load distance reviews badge:", dErr);
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
                    <button class="btn btn-primary btn-sm verify-pay-btn d-inline-flex align-items-center gap-1" data-id="${p.paymentId}" type="button">
                        <i class="ti ti-receipt"></i> Verify
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
        const rowProofUrl = p.proofDownloadUrl || p.proof_download_url || p.proofUrl || p.downloadUrl;
        const proofLink = rowProofUrl ? `<br><a href="${rowProofUrl}" target="_blank" rel="noopener noreferrer" class="small text-primary text-decoration-none" style="font-size: 11px;"><i class="ti ti-photo me-1"></i>View Screenshot</a>` : (p.proofStoragePath ? `<br><span class="small text-secondary" style="font-size: 11px;"><i class="ti ti-photo me-1"></i>Proof Attached</span>` : '');

        const instanceBadge = (p.instanceCount && p.instanceCount > 1)
            ? `<br><span class="badge bg-blue-subtle text-primary border border-primary-subtle" style="font-size: 10px;">Part of ₹${Math.round(p.submissionTotalAmount || (p.amount * p.instanceCount))} (${p.instanceIndex || 1}/${p.instanceCount})</span>`
            : '';

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
                    <strong class="text-success">₹${p.amount || 140}</strong>${instanceBadge}
                    ${p.overdueAmount > 0 ? `<br><span class="badge bg-danger-subtle text-danger" style="font-size: 10px;">Incl. ₹${p.overdueAmount} overdue</span>` : ''}<br>
                    <small class="text-secondary">${methodLabel}</small>${refNote}${proofLink}
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

    // Bind Verify and Decline buttons
    container.querySelectorAll('.verify-pay-btn').forEach(btn => {
        btn.addEventListener('click', () => openVerifyProofModal(btn.dataset.id));
    });

    container.querySelectorAll('.decline-pay-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeclinePayment(btn.dataset.id, btn));
    });
}

// ============ VERIFY PROOF MODAL ============

let activeVerifyingPaymentId = null;

async function openVerifyProofModal(paymentId) {
    const modal = document.getElementById('admin-verify-proof-modal');
    if (!modal) return;

    const payment = cachedPayments.find(p => p.paymentId === paymentId);
    if (!payment) return;

    activeVerifyingPaymentId = paymentId;

    const nameEl = document.getElementById('verify-modal-driver-name');
    const phoneEl = document.getElementById('verify-modal-driver-phone');
    const weekEl = document.getElementById('verify-modal-week-label');
    const amountEl = document.getElementById('verify-modal-amount');
    const imgEl = document.getElementById('verify-modal-proof-img');
    const noImgEl = document.getElementById('verify-modal-no-img');
    const linkEl = document.getElementById('verify-modal-open-link');
    const declineReasonInput = document.getElementById('verify-modal-decline-reason');

    if (nameEl) nameEl.innerText = payment.driverName || 'Driver';
    if (phoneEl) phoneEl.innerText = payment.driverPhone || payment.driverId || '--';
    if (weekEl) weekEl.innerText = payment.weekLabel || payment.weekId || '--';
    if (amountEl) {
        let multiNote = '';
        if (payment.instanceCount && payment.instanceCount > 1) {
            multiNote = `<br><span class="badge bg-blue-subtle text-primary border border-primary-subtle mt-1" style="font-size: 11px;">Week ${payment.instanceIndex || 1} of ${payment.instanceCount} (Total submitted: ₹${Math.round(payment.submissionTotalAmount || (payment.amount * payment.instanceCount))})</span>`;
        }
        amountEl.innerHTML = `₹${payment.amount || 140}${multiNote}${payment.overdueAmount > 0 ? `<br><small class="text-danger fs-6 fw-normal">(Incl. ₹${payment.overdueAmount} overdue)</small>` : ''}`;
    }
    if (declineReasonInput) declineReasonInput.value = '';

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');

    // Reset image display state
    if (imgEl) {
        imgEl.classList.add('d-none');
        imgEl.removeAttribute('src');
    }
    if (linkEl) {
        linkEl.classList.add('d-none');
        linkEl.removeAttribute('href');
    }
    if (noImgEl) {
        noImgEl.classList.remove('d-none');
        noImgEl.innerHTML = `<span class="spinner-border spinner-border-sm me-2 text-primary" role="status"></span>Loading proof image...`;
    }

    const rawUrl = payment.proofDownloadUrl || payment.proof_download_url || payment.proofUrl || payment.proof_url || payment.downloadUrl || payment.imageUrl || payment.screenshotUrl;
    let storagePath = payment.proofStoragePath || payment.proof_storage_path || payment.storagePath || payment.storage_path;

    const applyImageSuccess = (url) => {
        if (imgEl) {
            imgEl.src = url;
            imgEl.onload = () => {
                imgEl.classList.remove('d-none');
                if (noImgEl) noImgEl.classList.add('d-none');
            };
            imgEl.onerror = () => {
                console.warn("Direct image render failed for URL:", url);
                tryStoragePathFallback();
            };
        }
        if (linkEl) {
            linkEl.href = url;
            linkEl.classList.remove('d-none');
        }
    };

    const tryStoragePathFallback = async () => {
        const driverId = payment.driverId;
        const pId = payment.paymentId;
        const weekId = payment.weekId;

        if (noImgEl) {
            noImgEl.innerHTML = `<span class="spinner-border spinner-border-sm me-2 text-primary" role="status"></span>Checking Firebase Storage for screenshot...`;
            noImgEl.classList.remove('d-none');
        }

        const candidatePaths = [];
        if (storagePath) candidatePaths.push(storagePath);
        if (driverId && pId) candidatePaths.push(`payment-proofs/${driverId}/${pId}`);
        if (driverId) candidatePaths.push(`payment-proofs/${driverId}`);

        for (const cPath of candidatePaths) {
            try {
                if (/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(cPath)) {
                    const directUrl = await getDownloadURL(ref(storage, cPath));
                    if (directUrl) {
                        applyImageSuccess(directUrl);
                        return true;
                    }
                }

                const folderRef = ref(storage, cPath);
                const listRes = await listAll(folderRef);

                if (listRes.items && listRes.items.length > 0) {
                    const item = listRes.items[listRes.items.length - 1];
                    const url = await getDownloadURL(item);
                    if (url) {
                        applyImageSuccess(url);
                        return true;
                    }
                }

                if (listRes.prefixes && listRes.prefixes.length > 0) {
                    let targetFolder = listRes.prefixes.find(p => (pId && p.name.includes(pId)) || (weekId && p.name.includes(weekId)));
                    if (!targetFolder) targetFolder = listRes.prefixes[listRes.prefixes.length - 1];
                    const subList = await listAll(targetFolder);
                    if (subList.items && subList.items.length > 0) {
                        const item = subList.items[subList.items.length - 1];
                        const url = await getDownloadURL(item);
                        if (url) {
                            applyImageSuccess(url);
                            return true;
                        }
                    }
                }
            } catch (err) {
                console.warn("Storage search error on path:", cPath, err);
            }
        }

        const bucket = storage?.app?.options?.storageBucket;
        if (bucket && storagePath) {
            const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}?alt=media`;
            applyImageSuccess(publicUrl);
            return true;
        }

        if (imgEl) imgEl.classList.add('d-none');
        if (noImgEl) {
            noImgEl.innerHTML = `No screenshot proof uploaded with this payment.`;
            noImgEl.classList.remove('d-none');
        }
        if (linkEl) linkEl.classList.add('d-none');
        return false;
    };

    if (rawUrl) {
        applyImageSuccess(rawUrl);
    } else {
        await tryStoragePathFallback();
    }

    // Render batch allocations if available
    const allocContainer = document.getElementById('verify-modal-allocations-container');
    if (allocContainer) {
        if (payment.isFeeBatchAllocation && payment.batchAllocations && payment.batchAllocations.length > 0) {
            allocContainer.classList.remove('d-none');
            allocContainer.innerHTML = `
                <div class="fw-bold small text-secondary mb-2">Batch Day Allocations (${payment.batchAllocations.length}):</div>
                <div class="list-group list-group-flush border rounded mb-2">
                    ${payment.batchAllocations.map(al => {
                        const alFeeId = al.fee_id || al.feeId;
                        const alAmt = ((al.amount_paise || 0) / 100).toFixed(2);
                        const alRaw = (al.status || 'PENDING').toUpperCase();
                        let bClass = 'bg-warning-lt text-warning';
                        if (alRaw === 'APPROVED') bClass = 'bg-success-lt text-success';
                        else if (alRaw === 'DECLINED') bClass = 'bg-danger-lt text-danger';

                        const isPending = alRaw === 'PENDING';
                        return `
                            <div class="list-group-item d-flex justify-content-between align-items-center py-2 px-3">
                                <div>
                                    <div class="fw-bold text-dark">${al.serviceDate || alFeeId}</div>
                                    <div class="text-secondary small">₹${alAmt}</div>
                                </div>
                                <div class="d-flex align-items-center gap-2">
                                    <span class="badge ${bClass} fw-bold">${alRaw}</span>
                                    ${isPending ? `
                                        <button type="button" class="btn btn-sm btn-outline-success btn-batch-alloc-approve p-1" data-batch-id="${payment.batchId}" data-fee-id="${alFeeId}" title="Approve day ${al.serviceDate || alFeeId}">
                                            <i class="ti ti-check"></i> Approve
                                        </button>
                                        <button type="button" class="btn btn-sm btn-outline-danger btn-batch-alloc-decline p-1" data-batch-id="${payment.batchId}" data-fee-id="${alFeeId}" title="Decline day ${al.serviceDate || alFeeId}">
                                            <i class="ti ti-x"></i> Decline
                                        </button>
                                    ` : ''}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            allocContainer.querySelectorAll('.btn-batch-alloc-approve').forEach(b => {
                b.addEventListener('click', () => handleApproveAllocation(b.dataset.batchId, b.dataset.feeId, b));
            });
            allocContainer.querySelectorAll('.btn-batch-alloc-decline').forEach(b => {
                b.addEventListener('click', () => handleDeclineAllocation(b.dataset.batchId, b.dataset.feeId, b));
            });
        } else {
            allocContainer.classList.add('d-none');
            allocContainer.innerHTML = '';
        }
    }
}

async function handleApproveAllocation(batchId, feeId, btn) {
    await withButtonSpinner(btn, async () => {
        try {
            await adminPost(`/fee-batches/${batchId}/allocations/${feeId}/decision`, { decision: "approve" });
            showToast(`Allocation ${feeId} approved!`, "success");
            closeVerifyProofModal();
            await loadAdminPayments();
        } catch (e) {
            showToast(e.message || "Failed to approve allocation", "error");
        }
    });
}

async function handleDeclineAllocation(batchId, feeId, btn) {
    const reason = prompt("Enter decline reason for this allocation:", "Payment could not be verified by accounts team.");
    if (reason === null) return;
    await withButtonSpinner(btn, async () => {
        try {
            await adminPost(`/fee-batches/${batchId}/allocations/${feeId}/decision`, {
                decision: "decline",
                note: (reason || "").trim() || "Declined by admin"
            });
            showToast(`Allocation ${feeId} declined.`, "warning");
            closeVerifyProofModal();
            await loadAdminPayments();
        } catch (e) {
            showToast(e.message || "Failed to decline allocation", "error");
        }
    });
}

function closeVerifyProofModal() {
    const modal = document.getElementById('admin-verify-proof-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
    activeVerifyingPaymentId = null;
}

async function handleModalApprovePayment(btn) {
    if (!activeVerifyingPaymentId) return;
    const paymentId = activeVerifyingPaymentId;
    const payment = cachedPayments.find(p => p.paymentId === paymentId);

    await withButtonSpinner(btn, async () => {
        try {
            if (payment && payment.isFeeBatchAllocation) {
                await adminPost(`/fee-batches/${payment.batchId}/allocations/${payment.feeId}/decision`, {
                    decision: "approve"
                });
            } else {
                await adminPost(`/driver-payments/${paymentId}/approve`);
            }
            showToast("Payment approved and verified successfully!", "success");
            closeVerifyProofModal();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error approving payment:", error);
            showToast(error.message || "Could not approve payment", "error");
        }
    });
}

async function handleModalDeclinePayment(btn) {
    if (!activeVerifyingPaymentId) return;
    const paymentId = activeVerifyingPaymentId;
    const payment = cachedPayments.find(p => p.paymentId === paymentId);
    const reasonInput = document.getElementById('verify-modal-decline-reason');
    const reason = (reasonInput?.value || "Payment could not be verified by accounts team.").trim();

    await withButtonSpinner(btn, async () => {
        try {
            if (payment && payment.isFeeBatchAllocation) {
                await adminPost(`/fee-batches/${payment.batchId}/allocations/${payment.feeId}/decision`, {
                    decision: "decline",
                    note: reason
                });
            } else {
                await adminPost(`/driver-payments/${paymentId}/decline`, { declineReason: reason });
            }
            showToast("Payment submission declined.", "warning");
            closeVerifyProofModal();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error declining payment:", error);
            showToast(error.message || "Could not decline payment", "error");
        }
    });
}

async function handleApprovePayment(paymentId, btn) {
    const payment = cachedPayments.find(p => p.paymentId === paymentId);
    const confirmed = await showTablerConfirm("Are you sure you want to APPROVE this payment allocation?", {
        title: "Approve Payment",
        variant: "success",
        confirmText: "Approve Payment"
    });
    if (!confirmed) return;

    await withButtonSpinner(btn, async () => {
        try {
            if (payment && payment.isFeeBatchAllocation) {
                await adminPost(`/fee-batches/${payment.batchId}/allocations/${payment.feeId}/decision`, {
                    decision: "approve"
                });
            } else {
                await adminPost(`/driver-payments/${paymentId}/approve`);
            }
            showToast("Payment approved successfully!", "success");
            await loadAdminPayments();
        } catch (error) {
            console.error("Error approving payment:", error);
            showToast(error.message || "Could not approve payment", "error");
        }
    });
}

async function handleDeclinePayment(paymentId, btn) {
    const payment = cachedPayments.find(p => p.paymentId === paymentId);
    const reason = prompt("Enter decline reason for driver (optional):", "Payment could not be verified by accounts team.");
    if (reason === null) return;

    await withButtonSpinner(btn, async () => {
        try {
            if (payment && payment.isFeeBatchAllocation) {
                await adminPost(`/fee-batches/${payment.batchId}/allocations/${payment.feeId}/decision`, {
                    decision: "decline",
                    note: reason
                });
            } else {
                await adminPost(`/driver-payments/${paymentId}/decline`, { declineReason: reason });
            }
            showToast("Payment submission declined.", "warning");
            await loadAdminPayments();
        } catch (error) {
            console.error("Error declining payment:", error);
            showToast(error.message || "Could not decline payment", "error");
        }
    });
}



// ============ DISTANCE CONFLICT REVIEWS ============

export async function loadAdminDistanceReviews() {
    const container = document.getElementById('admin-dist-reviews-table-container');
    if (!container) return;

    container.innerHTML = `
        <div class="card shadow-xs border-0 text-center py-5">
            <div class="spinner-border text-primary mx-auto mb-2" role="status"></div>
            <div class="text-secondary small">Loading distance disparity reviews...</div>
        </div>
    `;

    const statusFilter = document.getElementById('admin-dist-review-status-filter')?.value || '';
    try {
        const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}&limit=100` : '?limit=100';
        const data = await adminGet(`/distance-reviews${query}`);
        cachedDistanceReviews = data.reviews || data.items || [];

        // Update badge
        const pendingCount = cachedDistanceReviews.filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
        const distBadge = document.getElementById('admin-distance-reviews-badge');
        if (distBadge) {
            distBadge.innerText = pendingCount;
            distBadge.classList.toggle('d-none', pendingCount === 0);
        }

        renderDistanceReviewsTable();
    } catch (error) {
        console.error("Error loading distance reviews:", error);
        container.innerHTML = `<div class="card shadow-xs border-0 text-center py-4 text-danger">Error loading distance disparity reviews: ${error.message}</div>`;
    }
}

export function renderDistanceReviewsTable() {
    const container = document.getElementById('admin-dist-reviews-table-container');
    if (!container) return;

    const statusFilter = document.getElementById('admin-dist-review-status-filter')?.value || '';
    const searchVal = document.getElementById('admin-dist-review-search')?.value?.toLowerCase().trim() || '';

    let filtered = cachedDistanceReviews.filter(r => {
        if (statusFilter && (r.status || '').toUpperCase() !== statusFilter.toUpperCase()) return false;
        if (searchVal) {
            const rideId = (r.rideId || r.id || '').toLowerCase();
            const driverId = (r.driverId || '').toLowerCase();
            const dayKey = (r.dayKey || '').toLowerCase();
            if (!rideId.includes(searchVal) && !driverId.includes(searchVal) && !dayKey.includes(searchVal)) {
                return false;
            }
        }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="card shadow-xs border-0 text-center py-5">
                <i class="ti ti-route text-secondary display-6 mb-2"></i>
                <div class="fw-bold">No distance conflict reviews found</div>
                <div class="text-secondary small">There are currently no distance disparity items matching the selected criteria.</div>
            </div>
        `;
        return;
    }

    const rowsHtml = filtered.map(r => {
        const plannedKm = Number(r.planned_km || 0);
        const provKm = Number(r.provisional_km || 0);
        const diffKm = provKm - plannedKm;
        const diffSign = diffKm >= 0 ? '+' : '';
        const status = (r.status || 'PENDING').toUpperCase();

        let statusBadge = '';
        if (status === 'PENDING') {
            statusBadge = '<span class="badge bg-warning-lt text-warning fw-bold">PENDING REVIEW</span>';
        } else if (status === 'APPROVED') {
            const decidedKm = Number(r.decided_km || 0).toFixed(2);
            statusBadge = `<span class="badge bg-success-lt text-success fw-bold">APPROVED (${decidedKm} km)</span>`;
        } else {
            statusBadge = '<span class="badge bg-danger-lt text-danger fw-bold">DECLINED (0 km)</span>';
        }

        let actionsHtml = '';
        if (status === 'PENDING') {
            actionsHtml = `
                <div class="d-flex flex-wrap gap-1">
                    <button class="btn btn-sm btn-outline-primary btn-dist-action" data-ride-id="${r.rideId}" data-action="approve_estimated" title="Approve estimated planned distance">
                        <i class="ti ti-check me-1"></i>Approve Est. (${plannedKm.toFixed(1)} km)
                    </button>
                    <button class="btn btn-sm btn-outline-success btn-dist-action" data-ride-id="${r.rideId}" data-action="approve_counter" title="Approve driver GPS counter distance">
                        <i class="ti ti-check-double me-1"></i>Approve Counter (${provKm.toFixed(1)} km)
                    </button>
                    <button class="btn btn-sm btn-outline-danger btn-dist-action" data-ride-id="${r.rideId}" data-action="decline" title="Decline entire distance disparity (0 km)">
                        <i class="ti ti-x me-1"></i>Decline (0 km)
                    </button>
                </div>
            `;
        } else {
            actionsHtml = `
                <div class="small">
                    <span class="text-secondary">Decided by:</span> <strong>${r.decided_by || 'Admin'}</strong>
                    ${r.note ? `<br><span class="text-muted fst-italic">"${r.note}"</span>` : ''}
                </div>
            `;
        }

        return `
            <tr>
                <td>
                    <strong class="text-dark font-monospace">${r.rideId}</strong><br>
                    <small class="text-secondary"><i class="ti ti-calendar me-1"></i>${r.dayKey || '--'}</small>
                </td>
                <td>
                    <span class="font-monospace small text-primary">${r.driverId}</span>
                </td>
                <td>
                    <span class="fw-bold">${plannedKm.toFixed(2)} km</span>
                </td>
                <td>
                    <span class="fw-bold">${provKm.toFixed(2)} km</span>
                </td>
                <td>
                    <span class="badge ${diffKm > 0 ? 'bg-danger-lt text-danger' : 'bg-info-lt text-info'} fw-bold">
                        ${diffSign}${diffKm.toFixed(2)} km
                    </span>
                </td>
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
                            <th>Ride &amp; Service Day</th>
                            <th>Driver UID</th>
                            <th>Estimated Distance</th>
                            <th>Counter Distance</th>
                            <th>Disparity</th>
                            <th>Status</th>
                            <th>Decision Actions / Audit</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Bind action buttons
    container.querySelectorAll('.btn-dist-action').forEach(btn => {
        btn.addEventListener('click', () => {
            const rideId = btn.dataset.rideId;
            const action = btn.dataset.action;
            const review = cachedDistanceReviews.find(r => r.rideId === rideId);
            if (review) {
                openDistanceDecisionModal(review, action);
            }
        });
    });
}

function openDistanceDecisionModal(review, actionType) {
    const modal = document.getElementById('admin-dist-review-decision-modal');
    if (!modal) return;

    const titleEl = document.getElementById('dist-review-modal-title');
    const descEl = document.getElementById('dist-review-modal-desc');
    const noteEl = document.getElementById('dist-review-note-input');
    const plannedKm = Number(review.planned_km || 0);
    const provKm = Number(review.provisional_km || 0);

    if (actionType === 'approve_estimated') {
        currentDistReviewAction = {
            rideId: review.rideId,
            decision: 'approve',
            approved_km: plannedKm
        };
        if (titleEl) {
            titleEl.innerHTML = `<i class="ti ti-check me-2 text-primary"></i>Approve Estimated Distance (${plannedKm.toFixed(2)} km)`;
        }
        if (descEl) {
            descEl.innerHTML = `You are approving the <strong>Estimated Planned Distance</strong> of <strong>${plannedKm.toFixed(2)} km</strong> for Ride <code>${review.rideId}</code> (Driver <code>${review.driverId}</code>, Day: ${review.dayKey}). The daily fee will be reconciled to this distance.`;
        }
        if (noteEl) noteEl.value = `Approved estimated planned distance of ${plannedKm.toFixed(2)} km.`;
    } else if (actionType === 'approve_counter') {
        currentDistReviewAction = {
            rideId: review.rideId,
            decision: 'approve',
            approved_km: provKm
        };
        if (titleEl) {
            titleEl.innerHTML = `<i class="ti ti-check-double me-2 text-success"></i>Approve Counter Distance (${provKm.toFixed(2)} km)`;
        }
        if (descEl) {
            descEl.innerHTML = `You are approving the <strong>Driver GPS Counter Distance</strong> of <strong>${provKm.toFixed(2)} km</strong> for Ride <code>${review.rideId}</code> (Driver <code>${review.driverId}</code>, Day: ${review.dayKey}). The daily fee will be reconciled to this distance.`;
        }
        if (noteEl) noteEl.value = `Approved driver GPS counter distance of ${provKm.toFixed(2)} km.`;
    } else {
        currentDistReviewAction = {
            rideId: review.rideId,
            decision: 'decline',
            approved_km: 0.0
        };
        if (titleEl) {
            titleEl.innerHTML = `<i class="ti ti-x me-2 text-danger"></i>Decline Entire Distance`;
        }
        if (descEl) {
            descEl.innerHTML = `You are declining the distance for Ride <code>${review.rideId}</code> (billable km = 0). This ride distance will not accrue platform fees.`;
        }
        if (noteEl) noteEl.value = `Declined distance disparity; zero billable distance.`;
    }

    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');
}

function closeDistanceDecisionModal() {
    const modal = document.getElementById('admin-dist-review-decision-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
    currentDistReviewAction = null;
}

async function handleConfirmDistanceDecision(btn) {
    if (!currentDistReviewAction) return;

    const noteEl = document.getElementById('dist-review-note-input');
    const note = (noteEl?.value || '').trim();
    if (!note || note.length > 500) {
        showToast("Please provide an admin audit note (1–500 characters).", "warning");
        noteEl?.focus();
        return;
    }

    await withButtonSpinner(btn, async () => {
        try {
            const payload = {
                decision: currentDistReviewAction.decision,
                note: note
            };
            if (currentDistReviewAction.decision === 'approve') {
                payload.approved_km = currentDistReviewAction.approved_km;
            }

            await adminPost(`/distance-reviews/${currentDistReviewAction.rideId}/decision`, payload);
            showToast("Distance review decision applied and fee reconciled successfully!", "success");
            closeDistanceDecisionModal();
            await loadAdminDistanceReviews();
            await loadAdminPayments();
        } catch (error) {
            console.error("Error confirming distance review decision:", error);
            showToast(error.message || "Failed to submit distance review decision.", "error");
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

let manualPayPendingDays = [];
let manualPaySelectedDays = new Set();

function formatServiceDateShort(dateStr) {
    if (!dateStr) return 'Unknown Day';
    try {
        const parts = String(dateStr).split('-');
        if (parts.length === 3) {
            const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
            return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
        }
        return dateStr;
    } catch (_) {
        return dateStr;
    }
}

function formatInrAmount(paise) {
    const inr = Number(paise || 0) / 100;
    return Number.isInteger(inr) ? `₹${inr}` : `₹${inr.toFixed(2)}`;
}

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

        if (!select.dataset.boundChange) {
            select.dataset.boundChange = 'true';
            select.addEventListener('change', onManualPayDriverChange);
        }
    } catch (error) {
        console.error("Error loading drivers for manual payment:", error);
        select.innerHTML = '<option value="">Error loading drivers list</option>';
    }
}

function renderManualPayDaysUI() {
    const listEl = document.getElementById('manual-pay-days-list');
    const summaryEl = document.getElementById('manual-pay-selected-summary');
    const countEl = document.getElementById('manual-pay-selected-count');
    const totalEl = document.getElementById('manual-pay-total-display');
    const pillsEl = document.getElementById('manual-pay-selected-pills');
    const amountInput = document.getElementById('manual-pay-amount-input');
    const submitBtn = document.getElementById('manual-pay-submit-btn');

    if (!listEl) return;

    if (!manualPayPendingDays.length) {
        listEl.innerHTML = '<div class="p-3 text-center text-muted small">No unpaid or due days found for this driver.</div>';
        if (summaryEl) summaryEl.classList.add('d-none');
        if (amountInput) amountInput.value = '0';
        if (submitBtn) submitBtn.disabled = true;
        return;
    }

    listEl.innerHTML = manualPayPendingDays.map(day => {
        const sDate = day.serviceDate;
        const isSelected = manualPaySelectedDays.has(sDate);
        const label = formatServiceDateShort(sDate);
        const distKm = ((Number(day.distance_m || 0)) / 1000).toFixed(1);
        const amtStr = formatInrAmount(day.remaining_paise);

        return `
            <div class="d-flex align-items-center justify-content-between px-3 py-2 border-bottom manual-pay-day-row" data-service-date="${sDate}" style="background:${isSelected ? '#f8fafc' : '#fff'};">
                <div class="d-flex align-items-center gap-2">
                    <input type="checkbox" class="form-check-input m-0 manual-pay-day-checkbox" data-service-date="${sDate}" ${isSelected ? 'checked' : ''} style="cursor:pointer;">
                    <div class="ms-1">
                        <div class="fw-semibold text-dark" style="font-size:0.9rem; line-height:1.2;">${label}</div>
                        <div class="text-muted" style="font-size:0.78rem;">${distKm} km</div>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-3">
                    <span class="fw-bold text-dark" style="font-size:0.95rem;">${amtStr}</span>
                    ${isSelected
                        ? `<button type="button" class="btn btn-sm btn-light border text-muted px-2 py-1 manual-pay-toggle-btn" data-service-date="${sDate}" style="min-width:68px; font-size:0.78rem;">Added</button>`
                        : `<button type="button" class="btn btn-sm btn-outline-secondary px-2 py-1 manual-pay-toggle-btn" data-service-date="${sDate}" style="min-width:68px; font-size:0.78rem;"><i class="ti ti-plus me-1"></i>Add</button>`
                    }
                </div>
            </div>
        `;
    }).join('');

    listEl.querySelectorAll('.manual-pay-day-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const sDate = e.target.getAttribute('data-service-date');
            if (!sDate) return;
            if (e.target.checked) manualPaySelectedDays.add(sDate);
            else manualPaySelectedDays.delete(sDate);
            renderManualPayDaysUI();
        });
    });

    listEl.querySelectorAll('.manual-pay-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sDate = btn.getAttribute('data-service-date');
            if (!sDate) return;
            if (manualPaySelectedDays.has(sDate)) manualPaySelectedDays.delete(sDate);
            else manualPaySelectedDays.add(sDate);
            renderManualPayDaysUI();
        });
    });

    const selectedItems = manualPayPendingDays.filter(d => manualPaySelectedDays.has(d.serviceDate));
    const totalPaise = selectedItems.reduce((acc, d) => acc + Number(d.remaining_paise || 0), 0);
    const totalInr = totalPaise / 100;

    if (summaryEl) summaryEl.classList.remove('d-none');
    if (countEl) countEl.textContent = String(selectedItems.length);
    if (totalEl) totalEl.textContent = formatInrAmount(totalPaise);
    if (amountInput) amountInput.value = totalInr > 0 ? String(totalInr) : '0';
    if (submitBtn) submitBtn.disabled = selectedItems.length === 0 || totalPaise <= 0;

    if (pillsEl) {
        if (!selectedItems.length) {
            pillsEl.innerHTML = '<span class="text-muted small fst-italic">Click "+ Add" on one or more pending days above to include them.</span>';
        } else {
            pillsEl.innerHTML = selectedItems.map(d => {
                const label = formatServiceDateShort(d.serviceDate);
                const amtStr = formatInrAmount(d.remaining_paise);
                return `
                    <span class="badge bg-white text-dark border d-inline-flex align-items-center gap-1 px-2 py-1" style="font-size:0.78rem; font-weight:500;">
                        <span>${label} &middot; <strong>${amtStr}</strong></span>
                        <a href="javascript:void(0)" class="text-muted ms-1 manual-pay-remove-pill" data-service-date="${d.serviceDate}" style="text-decoration:none; font-weight:bold;">&times;</a>
                    </span>
                `;
            }).join('');

            pillsEl.querySelectorAll('.manual-pay-remove-pill').forEach(rem => {
                rem.addEventListener('click', (e) => {
                    e.preventDefault();
                    const sDate = rem.getAttribute('data-service-date');
                    if (sDate) {
                        manualPaySelectedDays.delete(sDate);
                        renderManualPayDaysUI();
                    }
                });
            });
        }
    }
}

async function onManualPayDriverChange() {
    const select = document.getElementById('manual-pay-driver-select');
    const duesInfo = document.getElementById('manual-pay-driver-dues-info');
    const listEl = document.getElementById('manual-pay-days-list');
    const summaryEl = document.getElementById('manual-pay-selected-summary');
    const amountInput = document.getElementById('manual-pay-amount-input');
    const submitBtn = document.getElementById('manual-pay-submit-btn');

    manualPayPendingDays = [];
    manualPaySelectedDays.clear();

    const uid = select?.value;
    if (!uid) {
        if (duesInfo) duesInfo.classList.add('d-none');
        if (listEl) listEl.innerHTML = '<div class="p-3 text-center text-muted small">Select a driver above to view pending daily fees.</div>';
        if (summaryEl) summaryEl.classList.add('d-none');
        if (amountInput) amountInput.value = '';
        if (submitBtn) submitBtn.disabled = true;
        return;
    }

    if (duesInfo) duesInfo.classList.add('d-none');
    if (listEl) {
        listEl.innerHTML = '<div class="p-3 text-center text-muted small"><span class="spinner-border spinner-border-sm me-2"></span>Loading driver pending daily fees...</div>';
    }
    if (summaryEl) summaryEl.classList.add('d-none');
    if (submitBtn) submitBtn.disabled = true;

    try {
        const sum = await adminGet(`/drivers/${encodeURIComponent(uid)}/fees-summary`);
        const allFees = sum.fees || [];
        // Exclude days that are PAID or UNDER_REVIEW; only include days with remaining_paise > 0
        manualPayPendingDays = allFees.filter(f => {
            const st = String(f.status || '').toUpperCase();
            const rem = Number(f.remaining_paise || 0);
            return rem > 0 && st !== 'PAID' && st !== 'UNDER_REVIEW';
        }).sort((a, b) => String(a.serviceDate || '').localeCompare(String(b.serviceDate || '')));

        renderManualPayDaysUI();
    } catch (e) {
        console.warn("Could not fetch driver fee summary:", e);
        if (listEl) {
            listEl.innerHTML = '<div class="p-3 text-center text-danger small">Could not load pending daily fees for this driver.</div>';
        }
    }
}

function openManualPayModal() {
    const modal = document.getElementById('admin-manual-payment-modal');
    if (!modal) return;

    manualPayPendingDays = [];
    manualPaySelectedDays.clear();

    fetchDriversList();
    const duesInfo = document.getElementById('manual-pay-driver-dues-info');
    if (duesInfo) {
        duesInfo.classList.add('d-none');
        duesInfo.innerHTML = '';
    }
    const listEl = document.getElementById('manual-pay-days-list');
    if (listEl) {
        listEl.innerHTML = '<div class="p-3 text-center text-muted small">Select a driver above to view pending daily fees.</div>';
    }
    const summaryEl = document.getElementById('manual-pay-selected-summary');
    if (summaryEl) summaryEl.classList.add('d-none');
    const amountInput = document.getElementById('manual-pay-amount-input');
    if (amountInput) amountInput.value = '';
    const submitBtn = document.getElementById('manual-pay-submit-btn');
    if (submitBtn) submitBtn.disabled = true;

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
        const methodSelect = document.getElementById('manual-pay-method-select');
        const refInput = document.getElementById('manual-pay-ref-input');

        const driverId = driverSelect ? driverSelect.value : '';
        if (!driverId) {
            showToast("Please select a driver.", "warning");
            return;
        }

        const selectedDays = Array.from(manualPaySelectedDays);
        if (!selectedDays.length) {
            showToast("Please add at least one pending day to record payment.", "warning");
            return;
        }

        const selectedItems = manualPayPendingDays.filter(d => manualPaySelectedDays.has(d.serviceDate));
        const totalPaise = selectedItems.reduce((acc, d) => acc + Number(d.remaining_paise || 0), 0);
        const totalInr = totalPaise / 100;

        if (totalPaise <= 0) {
            showToast("Selected days have zero payable amount.", "warning");
            return;
        }

        const payload = {
            driverId: driverId,
            selectedDays: selectedDays,
            amount: totalInr,
            paymentMethod: methodSelect ? methodSelect.value : 'cash',
            paymentReference: (refInput && refInput.value.trim()) ? refInput.value.trim() : 'Collected offline in cash'
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

// ============ CLEANUP STORAGE MODAL ============

function openCleanupStorageModal() {
    const modal = document.getElementById('admin-cleanup-storage-modal');
    if (!modal) return;
    const previewBox = document.getElementById('cleanup-preview-box');
    if (previewBox) {
        previewBox.classList.add('d-none');
        previewBox.innerHTML = '';
    }
    modal.style.display = 'block';
    modal.classList.remove('d-none');
    modal.classList.add('show');
}

function closeCleanupStorageModal() {
    const modal = document.getElementById('admin-cleanup-storage-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('d-none');
        modal.classList.remove('show');
    }
}

async function handleScanStorage(btn) {
    const start = document.getElementById('cleanup-start-date')?.value || null;
    const end = document.getElementById('cleanup-end-date')?.value || null;
    const previewBox = document.getElementById('cleanup-preview-box');

    await withButtonSpinner(btn, async () => {
        try {
            const res = await adminPost('/driver-payments/cleanup-storage', {
                startDate: start,
                endDate: end,
                dryRun: true
            });
            if (previewBox) {
                previewBox.classList.remove('d-none');
                previewBox.innerHTML = `<strong>Scan Results:</strong> Found <strong>${res.matchedCount || 0}</strong> payment proof screenshot file(s) matching criteria.`;
            }
        } catch (err) {
            console.error("Storage scan error:", err);
            showToast(err.message || "Failed to scan storage", "error");
        }
    });
}

function showCleanupLoading(text = "Deleting payment proof files from Firebase Storage...") {
    let overlay = document.getElementById("admin-cleanup-loading-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "admin-cleanup-loading-overlay";
        overlay.style.cssText = "position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 2100; display: flex; align-items: center; justify-content: center;";
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div class="card p-4 shadow-lg border-0 text-center" style="max-width: 400px; background: #ffffff; border-radius: 12px;">
            <div class="spinner-border text-danger mx-auto mb-3" style="width: 3rem; height: 3rem;" role="status"></div>
            <h4 class="fw-bold mb-2">${text}</h4>
            <p class="text-secondary small mb-0">Permanently deleting matching screenshots from storage bucket. Please do not close this window...</p>
        </div>
    `;
    overlay.style.display = "flex";
}

function hideCleanupLoading() {
    const overlay = document.getElementById("admin-cleanup-loading-overlay");
    if (overlay) overlay.style.display = "none";
}

async function handleConfirmCleanupStorage(btn) {
    const start = document.getElementById('cleanup-start-date')?.value || null;
    const end = document.getElementById('cleanup-end-date')?.value || null;

    closeCleanupStorageModal();

    const confirmed = await showTablerConfirm("Are you sure you want to PERMANENTLY DELETE matching payment proof images from Firebase Storage? This action cannot be undone.", {
        title: "Confirm Storage Cleanup",
        variant: "danger",
        confirmText: "Delete Files",
        cancelText: "Cancel"
    });
    if (!confirmed) {
        openCleanupStorageModal();
        return;
    }

    showCleanupLoading("Deleting payment proofs from Firebase Storage...");
    try {
        const res = await adminPost('/driver-payments/cleanup-storage', {
            startDate: start,
            endDate: end,
            dryRun: false
        });
        hideCleanupLoading();
        showToast(res.message || "Storage cleanup completed successfully!", "success");
        await loadAdminPayments();
    } catch (err) {
        hideCleanupLoading();
        console.error("Storage cleanup error:", err);
        showToast(err.message || "Failed to cleanup storage", "error");
        openCleanupStorageModal();
    }
}

let paymentsInitialized = false;
export function initAdminPayments() {
    if (paymentsInitialized) return;
    paymentsInitialized = true;

    const statusFilter = document.getElementById('admin-payment-status-filter');
    const searchInput = document.getElementById('admin-payment-search');

    statusFilter?.addEventListener('change', renderPaymentsTable);
    searchInput?.addEventListener('input', renderPaymentsTable);

    const resetBtn = document.getElementById('admin-reset-all-payments-btn');
    resetBtn?.addEventListener('click', () => handleResetAllPayments(resetBtn));

    // Verify Proof Modal Triggers
    document.getElementById('verify-proof-close-btn')?.addEventListener('click', closeVerifyProofModal);
    document.getElementById('admin-verify-proof-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'admin-verify-proof-modal') closeVerifyProofModal();
    });
    const verifyApproveBtn = document.getElementById('verify-modal-approve-btn');
    verifyApproveBtn?.addEventListener('click', () => handleModalApprovePayment(verifyApproveBtn));
    const verifyDeclineBtn = document.getElementById('verify-modal-decline-btn');
    verifyDeclineBtn?.addEventListener('click', () => handleModalDeclinePayment(verifyDeclineBtn));

    // Cleanup Storage Modal Triggers
    document.getElementById('admin-open-cleanup-storage-btn')?.addEventListener('click', openCleanupStorageModal);
    document.getElementById('cleanup-storage-close-btn')?.addEventListener('click', closeCleanupStorageModal);
    document.getElementById('admin-cleanup-storage-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'admin-cleanup-storage-modal') closeCleanupStorageModal();
    });
    const scanBtn = document.getElementById('cleanup-scan-btn');
    scanBtn?.addEventListener('click', () => handleScanStorage(scanBtn));
    const confirmCleanupBtn = document.getElementById('cleanup-confirm-btn');
    confirmCleanupBtn?.addEventListener('click', () => handleConfirmCleanupStorage(confirmCleanupBtn));

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

    // Sub-Tabs: Payment Submissions vs Distance Conflict Reviews
    const tabSubmissions = document.getElementById('admin-tab-submissions');
    const tabDistance = document.getElementById('admin-tab-distance-reviews');
    const viewSubmissions = document.getElementById('admin-payments-submissions-view');
    const viewDistance = document.getElementById('admin-payments-distance-reviews-view');

    tabSubmissions?.addEventListener('click', () => {
        tabSubmissions.classList.add('active');
        tabDistance?.classList.remove('active');
        viewSubmissions?.classList.remove('d-none');
        viewDistance?.classList.add('d-none');
    });

    tabDistance?.addEventListener('click', () => {
        tabDistance?.classList.add('active');
        tabSubmissions?.classList.remove('active');
        viewDistance?.classList.remove('d-none');
        viewSubmissions?.classList.add('d-none');
        loadAdminDistanceReviews();
    });

    // Distance Reviews Filters & Search
    document.getElementById('admin-dist-review-status-filter')?.addEventListener('change', loadAdminDistanceReviews);
    document.getElementById('admin-dist-review-search')?.addEventListener('input', renderDistanceReviewsTable);

    // Distance Decision Modal Triggers
    document.getElementById('dist-review-close-btn')?.addEventListener('click', closeDistanceDecisionModal);
    document.getElementById('dist-review-cancel-btn')?.addEventListener('click', closeDistanceDecisionModal);
    document.getElementById('admin-dist-review-decision-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'admin-dist-review-decision-modal') closeDistanceDecisionModal();
    });
    const distConfirmBtn = document.getElementById('dist-review-confirm-submit-btn');
    distConfirmBtn?.addEventListener('click', () => handleConfirmDistanceDecision(distConfirmBtn));

    // Initialize Wallet Credit Admin UI
    initAdminWalletCredit();
}


// =========================================================================
// WALLET CREDIT ADMIN PORTAL
// =========================================================================

let cachedPassengerWallets = [];
let cachedDriverSettlements = [];
let walletCreditInitialized = false;

export function initAdminWalletCredit() {
    if (walletCreditInitialized) return;
    walletCreditInitialized = true;

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
