import { auth, db } from '../platform/firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { showAlert } from '../shared/dialog.js';
import { t } from '../shared/i18n.js';

let currentAuthUser = null;
let currentPaymentData = null;
let realtimeUnsubscribe = null;
let countdownTimer = null;

const backBtn = document.getElementById('payments-back-btn');
const payBtn = document.getElementById('pay-weekly-fee-btn');
const qrModal = document.getElementById('qr-payment-modal');
const qrModalCloseBtn = document.getElementById('qr-modal-close-btn');
const qrModalCancelBtn = document.getElementById('qr-modal-cancel-btn');
const paymentDoneBtn = document.getElementById('payment-done-btn');
const upiQrImage = document.getElementById('upi-qr-image');

const seeAllTopBtn = document.getElementById('py-see-all-top-btn');
const seeAllFullBtn = document.getElementById('py-see-all-btn');
const historyModal = document.getElementById('py-history-modal');
const modalCloseBtn = document.getElementById('py-modal-close-btn');

async function getAuthToken() {
    if (!currentAuthUser) return null;
    return await currentAuthUser.getIdToken();
}

function formatErrorMessage(errData, fallback = 'An error occurred') {
    if (!errData) return fallback;
    if (typeof errData.error === 'string') return errData.error;
    if (typeof errData.error === 'object' && errData.error !== null) {
        return errData.error.message || JSON.stringify(errData.error);
    }
    if (typeof errData.detail === 'string') return errData.detail;
    return fallback;
}

async function fetchPaymentStatus() {
    const loadingScreen = document.getElementById('payments-loading-screen');
    const container = document.getElementById('payments-container');

    try {
        const token = await getAuthToken();
        if (!token) return;

        const response = await fetch('/api/account/driver-payments/status', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(formatErrorMessage(errData, 'Failed to fetch payment status'));
        }

        const data = await response.json();
        currentPaymentData = data;
        renderPaymentUI(data);
    } catch (error) {
        console.error("Error fetching payment status:", error);
        showAlert(error.message || t('driver.fetch_payment_error', "Failed to load payment details."));
    } finally {
        if (loadingScreen) loadingScreen.classList.add('d-none');
        if (container) container.classList.remove('d-none');
    }
}

function renderStatusBadge(element, statusCode) {
    if (!element) return;
    element.className = 'py-status-badge';
    
    switch (statusCode) {
        case 'due':
        case 'pending':
            element.classList.add('due');
            element.innerHTML = `<span>${t('driver.status_pending', 'PENDING')}</span>`;
            break;
        case 'submitted':
        case 'under_review':
            element.classList.add('submitted');
            element.innerHTML = `<span>${t('driver.status_under_review', 'UNDER REVIEW')}</span>`;
            break;
        case 'approved':
        case 'verified':
            element.classList.add('approved');
            element.innerHTML = `<span>${t('driver.status_verified', 'VERIFIED')}</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            break;
        case 'declined':
            element.classList.add('declined');
            element.innerHTML = `<span>${t('driver.status_declined', 'DECLINED')}</span>`;
            break;
        case 'overdue':
            element.classList.add('overdue');
            element.innerHTML = `<span>${t('driver.status_pending', 'PENDING')}</span>`;
            break;
        case 'paused':
            element.classList.add('approved');
            element.innerHTML = `<span>${t('driver.paused', 'PAUSED')}</span>`;
            break;
        default:
            element.classList.add('due');
            element.innerHTML = `<span>${statusCode.toUpperCase()}</span>`;
    }
}

function renderPaymentUI(data) {
    const weekInfo = data.weekInfo || {};
    const currentStatus = data.currentStatus || 'due';
    const activeSub = data.activeSubmission;
    const duesSummary = data.duesSummary || {};
    const upcomingWeek = data.upcomingWeek || {};
    const isPaused = Boolean(data.isPaused);
    const pauseMsg = data.pauseMessage || "Weekly payments are currently paused. Chill and relax — no payment is required during this period.";

    // 1) Top Current Week Card
    const weekLabelEl = document.getElementById('current-week-label');
    if (weekLabelEl) weekLabelEl.innerText = weekInfo.weekLabel || 'Current Week';

    renderStatusBadge(document.getElementById('current-week-status-badge'), currentStatus);
    renderStatusBadge(document.getElementById('py-current-status-badge'), currentStatus);

    // 2) Last/Current Week Details
    const lastDueDateEl = document.getElementById('py-last-due-date');
    if (lastDueDateEl) {
        lastDueDateEl.innerText = isPaused ? t('driver.paused', 'Paused') : (weekInfo.shortWeekLabel ? weekInfo.shortWeekLabel.split('-')[1].trim() : '23 Aug 2026 (Sun)');
    }

    const lastPaidDateEl = document.getElementById('py-last-paid-date');
    if (lastPaidDateEl) {
        if (activeSub?.submittedAt) {
            lastPaidDateEl.innerText = new Date(activeSub.submittedAt).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } else {
            lastPaidDateEl.innerText = currentStatus === 'approved' ? t('driver.status_verified', 'Verified') : t('driver.not_paid_yet', 'Not paid yet');
        }
    }

    const totalAmountEl = document.getElementById('py-total-amount');
    if (totalAmountEl) {
        const total = duesSummary.totalAmountToBePaid !== undefined ? duesSummary.totalAmountToBePaid : (weekInfo.amount || 140);
        totalAmountEl.innerText = `₹${total}`;
    }

    const prevDuesEl = document.getElementById('py-prev-dues-text');
    if (prevDuesEl) {
        prevDuesEl.innerText = duesSummary.previousDuesText || t('driver.no_prev_dues', 'No previous dues');
        prevDuesEl.className = duesSummary.previousDuesIncluded ? 'py-footer-val danger' : 'py-footer-val green';
    }

    // Timer
    if (isPaused) {
        if (countdownTimer) clearInterval(countdownTimer);
        const timeEl = document.getElementById('py-time-left');
        if (timeEl) timeEl.innerText = t('driver.paused', 'Paused');
    } else {
        startCountdown(weekInfo.sundayDeadline);
    }

    // 3) General Message Card
    const noticeTitle = document.getElementById('py-notice-title');
    const noticeDesc = document.getElementById('py-notice-desc');
    const noticeCard = document.getElementById('py-general-notice-card');

    if (noticeCard && noticeTitle && noticeDesc) {
        if (isPaused) {
            noticeCard.className = 'py-general-notice-card approved';
            noticeTitle.innerText = t('driver.payments_paused_title', 'Weekly Payments Paused.');
            noticeDesc.innerText = pauseMsg;
        } else if (currentStatus === 'submitted') {
            noticeCard.className = 'py-general-notice-card submitted';
            noticeTitle.innerText = t('driver.payment_under_review_title', 'Payment under review.');
            noticeDesc.innerText = t('driver.payment_under_review_desc', 'Your weekly fee payment has been submitted and is currently under review by our accounts team.');
        } else if (currentStatus === 'approved') {
            noticeCard.className = 'py-general-notice-card approved';
            noticeTitle.innerText = t('driver.payment_verified_title', 'Weekly fee paid & verified.');
            noticeDesc.innerText = t('driver.payment_verified_desc', 'Your weekly fee payment of ₹140 has been verified and approved. You are active to receive ride requests.');
        } else if (currentStatus === 'declined') {
            noticeCard.className = 'py-general-notice-card declined';
            const reason = activeSub?.declineReason ? ` (${activeSub.declineReason})` : '';
            noticeTitle.innerText = t('driver.payment_declined_title', 'Payment declined.');
            noticeDesc.innerText = `${t('driver.payment_declined_desc', 'Your previous payment submission was declined')}${reason}.`;
        } else {
            noticeCard.className = 'py-general-notice-card';
            noticeTitle.innerText = t('driver.payment_pending_title', 'Weekly payment pending.');
            noticeDesc.innerText = t('driver.payment_pending_desc', 'Please pay your weekly fee before Sunday 12:00 PM to keep your driver account active and accept ride requests.');
        }
    }

    // 4) Main Pay Button
    if (payBtn) {
        const total = duesSummary.totalAmountToBePaid || weekInfo.amount || 140;
        if (isPaused) {
            payBtn.innerHTML = `<span>${t('driver.payments_paused_btn', 'Weekly Payments Paused (No Fee Due)')}</span>`;
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn disabled';
        } else if (currentStatus === 'submitted') {
            payBtn.innerHTML = `<span>${t('driver.payment_submitted_btn', 'Payment Submitted — Under Review')}</span>`;
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn disabled';
        } else if (currentStatus === 'approved') {
            payBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>${t('driver.payment_verified_btn', 'Weekly Fee Paid (Verified ✓)')}</span>`;
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn verified';
        } else if (currentStatus === 'declined') {
            payBtn.innerHTML = `<span>${t('driver.repay_fee_btn', 'Re-pay Weekly Fee')} (₹${total})</span>`;
            payBtn.disabled = false;
            payBtn.className = 'py-main-pay-btn danger';
        } else {
            payBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg><span>${t('driver.pay_weekly_fee', 'Pay Weekly Fee')} (₹${total})</span>`;
            payBtn.disabled = false;
            payBtn.className = 'py-main-pay-btn';
        }
    }

    // 5) Upcoming Week Details
    const nextDueDateEl = document.getElementById('py-next-due-date');
    if (nextDueDateEl) {
        nextDueDateEl.innerText = upcomingWeek.dueDateLabel || '30 Aug 2026 (Sun)';
    }
    const nextAmountEl = document.getElementById('py-next-amount');
    if (nextAmountEl) {
        nextAmountEl.innerText = upcomingWeek.amount || 140;
    }

    // 6) History Lists
    const history = data.history || [];
    renderRecentHistory(history.slice(0, 3));
    renderFullHistory(history);

    // Account Hold Banner & Modal
    const holdBanner = document.getElementById('account-hold-banner');
    const holdOverlay = document.getElementById('account-hold-modal-overlay');
    if (data.isAccountOnHold) {
        if (holdBanner) holdBanner.classList.remove('d-none');
        if (holdOverlay) holdOverlay.classList.remove('d-none');
    } else {
        if (holdBanner) holdBanner.classList.add('d-none');
        if (holdOverlay) holdOverlay.classList.add('d-none');
    }
}

function startCountdown(deadlineIso) {
    if (countdownTimer) clearInterval(countdownTimer);
    const timeEl = document.getElementById('py-time-left');
    if (!timeEl || !deadlineIso) return;

    const updateTimer = () => {
        const now = new Date().getTime();
        const deadline = new Date(deadlineIso).getTime();
        const diff = deadline - now;

        if (diff <= 0) {
            timeEl.innerText = t('driver.overdue', 'Overdue');
            timeEl.style.color = '#dc2626';
            clearInterval(countdownTimer);
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (days > 0) {
            timeEl.innerText = `${days}d ${hours}h ${minutes}m`;
        } else if (hours > 0) {
            timeEl.innerText = `${hours}h ${minutes}m`;
        } else {
            timeEl.innerText = `${minutes}m`;
        }
    };

    updateTimer();
    countdownTimer = setInterval(updateTimer, 1000);
}

function renderHistoryItemHtml(item) {
    const amountStr = `₹${item.amount || 140}`;
    const weekStr = item.weekLabel || item.weekId;
    const subDate = item.submittedAt ? new Date(item.submittedAt).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : '--';

    let badgeClass = 'due';
    let badgeText = t('driver.status_pending', 'PENDING');

    if (item.status === 'submitted') {
        badgeClass = 'submitted';
        badgeText = t('driver.status_under_review', 'UNDER VERIFICATION');
    } else if (item.status === 'approved') {
        badgeClass = 'approved';
        badgeText = t('driver.status_approved', 'APPROVED');
    } else if (item.status === 'declined') {
        badgeClass = 'declined';
        badgeText = t('driver.status_declined', 'DECLINED');
    }

    return `
        <div class="py-history-item">
            <div class="py-history-item-left">
                <div class="py-history-check-circle ${item.status === 'approved' ? 'approved' : ''}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="py-history-item-info">
                    <strong>Week ${item.weekId || '2026-W34'}</strong>
                    <span>${weekStr}</span>
                    <div class="py-history-sub-status">
                        <strong>${amountStr}</strong> • <span class="py-sub-badge ${badgeClass}">${badgeText}</span>
                    </div>
                </div>
            </div>
            <div class="py-history-item-right">
                <span class="py-history-date">${subDate}</span>
                <span class="py-history-chevron">›</span>
            </div>
        </div>
    `;
}

function renderRecentHistory(recentList) {
    const listEl = document.getElementById('payments-history-list');
    if (!listEl) return;

    if (!recentList.length) {
        listEl.innerHTML = `<p class="text-muted text-center py-3 mb-0" style="font-size: 0.88rem;">${t('driver.no_payment_records', 'No payment history records found.')}</p>`;
        return;
    }

    listEl.innerHTML = recentList.map(renderHistoryItemHtml).join('');
}

function renderFullHistory(fullList) {
    const fullListEl = document.getElementById('py-full-history-list');
    if (!fullListEl) return;

    if (!fullList.length) {
        fullListEl.innerHTML = `<p class="text-muted text-center py-4 mb-0">${t('driver.no_payment_records', 'No payment records found.')}</p>`;
        return;
    }

    fullListEl.innerHTML = fullList.map(renderHistoryItemHtml).join('');
}

function openQrModal() {
    if (!currentPaymentData) return;
    const weekInfo = currentPaymentData.weekInfo || {};
    const duesSummary = currentPaymentData.duesSummary || {};
    const payeeUpi = weekInfo.payeeUpiId || "shuvanshil@oksbi";
    const amount = duesSummary.totalAmountToBePaid || weekInfo.amount || 140;
    const payeeName = encodeURIComponent(weekInfo.payeeName || "Ride Share Accounts");

    const upiUri = `upi://pay?pa=${payeeUpi}&pn=${payeeName}&am=${amount}&cu=INR`;
    const encodedUpi = encodeURIComponent(upiUri);

    if (upiQrImage) {
        upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodedUpi}`;
    }

    const qrAmountEl = document.getElementById('qr-modal-amount');
    if (qrAmountEl) qrAmountEl.innerText = `₹${amount}`;

    if (qrModal) {
        qrModal.classList.remove('d-none');
    }
}

function closeQrModal() {
    if (qrModal) {
        qrModal.classList.add('d-none');
    }
}

async function handlePaymentDone() {
    if (!paymentDoneBtn) return;
    paymentDoneBtn.disabled = true;
    paymentDoneBtn.innerText = t('driver.submitting_verification', 'Submitting verification...');

    try {
        const token = await getAuthToken();
        const response = await fetch('/api/account/driver-payments/submit', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                paymentMethod: 'upi',
                paymentReference: 'UPI QR Payment'
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(formatErrorMessage(data, t('driver.submit_payment_failed', 'Could not submit payment verification.')));
        }

        closeQrModal();
        await showAlert(t('driver.payment_submitted_alert', "Payment submitted! Your payment is now under manual verification by the Ride Share Accounts team."));
        await fetchPaymentStatus();
    } catch (error) {
        console.error("Error submitting payment verification:", error);
        showAlert(error.message || t('driver.submit_payment_failed', "Could not submit payment verification."));
    } finally {
        paymentDoneBtn.disabled = false;
        paymentDoneBtn.innerText = t('driver.payment_done', 'Payment done');
    }
}

function setupRealtimeListener(uid) {
    if (realtimeUnsubscribe) realtimeUnsubscribe();

    try {
        const q = query(
            collection(db, 'driverPayments'),
            where('driverId', '==', uid)
        );

        realtimeUnsubscribe = onSnapshot(q, () => {
            fetchPaymentStatus();
        }, (err) => {
            console.warn("Realtime payment listener error:", err);
        });
    } catch (e) {
        console.warn("Could not attach Firestore realtime listener:", e);
    }
}

// --- Tab Switching Logic ---
const serviceFeeTabBtn = document.getElementById('tab-btn-service-fee');
const walletTabBtn = document.getElementById('tab-btn-wallet');
const serviceFeeContent = document.getElementById('driver-service-fee-tab-content');
const walletContent = document.getElementById('driver-wallet-tab-content');

function switchDriverTab(targetTab) {
    if (targetTab === 'wallet') {
        serviceFeeTabBtn?.classList.remove('active');
        walletTabBtn?.classList.add('active');
        serviceFeeContent?.classList.add('d-none');
        walletContent?.classList.remove('d-none');
        fetchDriverWalletData();
    } else {
        walletTabBtn?.classList.remove('active');
        serviceFeeTabBtn?.classList.add('active');
        walletContent?.classList.add('d-none');
        serviceFeeContent?.classList.remove('d-none');
    }
}

serviceFeeTabBtn?.addEventListener('click', () => switchDriverTab('service-fee'));
walletTabBtn?.addEventListener('click', () => switchDriverTab('wallet'));

async function fetchDriverWalletData() {
    if (!currentAuthUser) return;
    const balanceEl = document.getElementById('driver-wallet-balance-val');
    const nextSettleEl = document.getElementById('driver-wallet-next-settlement-date');
    const txListEl = document.getElementById('driver-wallet-tx-list');

    try {
        const token = await getAuthToken();
        if (!token) return;

        // 1. Fetch balance & settlement info in parallel
        const [walletRes, settleRes, txRes] = await Promise.all([
            fetch('/api/wallet', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }),
            fetch('/api/wallet/driver/settlement-info', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }),
            fetch('/api/wallet/transactions?limit=30', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
        ]);

        const walletData = await walletRes.json().catch(() => ({}));
        const settleData = await settleRes.json().catch(() => ({}));
        const txData = await txRes.json().catch(() => ({}));

        if (balanceEl && walletData?.wallet) {
            const balNum = Number(walletData.wallet.balance ?? 0);
            balanceEl.innerText = `₹${balNum.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }

        if (nextSettleEl) {
            const rawDate = settleData?.nextSettlementDate || settleData?.nextSettlementDateFormatted;
            let formattedDate = 'To be scheduled';
            if (rawDate && rawDate !== 'To be scheduled') {
                try {
                    const parsed = new Date(rawDate);
                    if (!isNaN(parsed.getTime())) {
                        const day = String(parsed.getDate()).padStart(2, '0');
                        const month = parsed.toLocaleString('en-US', { month: 'short' });
                        const year = parsed.getFullYear();
                        formattedDate = `${day} ${month} ${year}`;
                    } else {
                        formattedDate = rawDate;
                    }
                } catch {
                    formattedDate = rawDate;
                }
            }
            nextSettleEl.innerText = formattedDate;
        }

        // Check and display driver settlement payout celebration modal if new payout resolved by admin
        checkAndShowDriverSettlementModal();

        if (txListEl) {
            const txs = txData?.transactions || [];
            if (!txs.length) {
                txListEl.innerHTML = `
                    <div class="text-center py-4 text-muted">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#9CA3AF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="mb-2">
                            <rect x="2" y="5" width="20" height="14" rx="2"></rect>
                            <line x1="2" y1="10" x2="22" y2="10"></line>
                        </svg>
                        <p class="small mb-0" data-i18n="wallet.no_transactions">${t('wallet.no_transactions', 'No transactions yet')}</p>
                    </div>
                `;
            } else {
                txListEl.innerHTML = txs.map(tx => {
                    const isCredit = tx.direction === 'credit';
                    const sign = isCredit ? '+' : '-';
                    const amtColor = isCredit ? '#16A34A' : '#1F2937';
                    const statusLabel = tx.isReversed ? t('wallet.reversed', 'Reversed') : (tx.status === 'completed' ? t('wallet.completed', 'Completed') : tx.status);
                    const dateStr = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

                    return `
                        <div class="d-flex justify-content-between align-items-center py-2.5 border-bottom" style="padding: 10px 0;">
                            <div class="d-flex align-items-center gap-2">
                                <div style="width:32px; height:32px; border-radius:8px; background:${isCredit ? '#DCFCE7' : '#F3F4F6'}; display:flex; align-items:center; justify-content:center;">
                                    ${isCredit ? `
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#16A34A" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
                                    ` : `
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#6B7280" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
                                    `}
                                </div>
                                <div>
                                    <strong class="d-block text-dark" style="font-size:12.5px;">${tx.description || t('wallet.title', 'Wallet')}</strong>
                                    <small class="text-muted" style="font-size:11px;">${dateStr}</small>
                                </div>
                            </div>
                            <div class="text-end">
                                <strong style="font-size:13px; color:${amtColor};">${sign}₹${(tx.amount ?? 0).toLocaleString('en-IN')}</strong>
                                <span class="badge ${tx.isReversed ? 'bg-danger-subtle text-danger' : 'bg-success-subtle text-success'} d-block mt-0.5" style="font-size:9px;">${statusLabel}</span>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        console.error('Error fetching driver wallet:', err);
    }
}

async function checkAndShowDriverSettlementModal() {
    if (!currentAuthUser) return;
    try {
        const token = await getAuthToken();
        if (!token) return;

        const res = await fetch('/api/wallet/unacknowledged-credits', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) return;

        const list = data.unacknowledgedCredits || [];
        if (!list.length) return;

        const item = list[0];
        const modal = document.getElementById('driver-wallet-celebration-modal');
        const titleEl = document.getElementById('driver-celebration-title');
        const amtVal = document.getElementById('driver-celebration-amount-val');
        const descEl = document.getElementById('driver-celebration-desc');
        const dismissBtn = document.getElementById('driver-celebration-dismiss-btn');

        if (!modal) return;

        const isSettlement = item.modalType === 'driver_settlement' || item.type === 'DRIVER_SETTLEMENT';
        if (titleEl) {
            titleEl.innerText = isSettlement ? "Wallet Settlement Transferred!" : "Wallet Credit Received!";
        }
        if (amtVal) {
            amtVal.innerText = `₹${(item.settlementAmount ?? item.amount ?? 0).toLocaleString('en-IN')}`;
        }
        if (descEl) {
            descEl.innerText = isSettlement
                ? `Admin has approved and transferred ₹${(item.settlementAmount ?? item.amount ?? 0).toLocaleString('en-IN')} directly to your registered UPI ID. Your wallet balance has been settled.`
                : `₹${(item.amount ?? 0).toLocaleString('en-IN')} credit has been added to your Driver Wallet.`;
        }

        modal.classList.remove('d-none');

        if (dismissBtn) {
            dismissBtn.onclick = async () => {
                modal.classList.add('d-none');
                try {
                    const idToken = await currentAuthUser.getIdToken();
                    await fetch('/api/wallet/acknowledge-credit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                        body: JSON.stringify({ transactionId: item.transactionId })
                    });
                } catch (ackErr) {
                    console.warn('Driver settlement ack error:', ackErr);
                }
                fetchDriverWalletData();
            };
        }
    } catch (e) {
        console.warn('Driver settlement modal check error:', e);
    }
}

// History Modal Listeners
seeAllTopBtn?.addEventListener('click', () => historyModal?.classList.remove('d-none'));
seeAllFullBtn?.addEventListener('click', () => historyModal?.classList.remove('d-none'));
document.getElementById('py-see-all-wallet-tx')?.addEventListener('click', () => historyModal?.classList.remove('d-none'));
modalCloseBtn?.addEventListener('click', () => historyModal?.classList.add('d-none'));
historyModal?.addEventListener('click', (e) => {
    if (e.target === historyModal) historyModal.classList.add('d-none');
});

// Event Listeners
backBtn?.addEventListener('click', () => {
    if (window.history.length > 1 && document.referrer) {
        window.history.back();
    } else {
        window.location.href = '/driver-service.html';
    }
});

payBtn?.addEventListener('click', openQrModal);
qrModalCloseBtn?.addEventListener('click', closeQrModal);
qrModalCancelBtn?.addEventListener('click', closeQrModal);
paymentDoneBtn?.addEventListener('click', handlePaymentDone);

onAuthStateChanged(auth, (user) => {
    if (!user) {
        window.location.href = '/login.html';
        return;
    }
    currentAuthUser = user;
    fetchPaymentStatus();
    setupRealtimeListener(user.uid);

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tab') === 'wallet') {
        switchDriverTab('wallet');
    }
});

window.addEventListener('languageChanged', () => {
    if (currentPaymentData) {
        renderPaymentUI(currentPaymentData);
    }
});
