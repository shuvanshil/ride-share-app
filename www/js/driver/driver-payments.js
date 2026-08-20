import { auth, db } from '../platform/firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { showAlert } from '../shared/dialog.js';

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
        showAlert(error.message || "Failed to load payment details.");
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
            element.classList.add('due');
            element.innerHTML = '<span>DUE</span>';
            break;
        case 'submitted':
            element.classList.add('submitted');
            element.innerHTML = '<span>UNDER VERIFICATION</span>';
            break;
        case 'approved':
            element.classList.add('approved');
            element.innerHTML = '<span>APPROVED</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            break;
        case 'declined':
            element.classList.add('declined');
            element.innerHTML = '<span>DECLINED</span>';
            break;
        case 'overdue':
            element.classList.add('overdue');
            element.innerHTML = '<span>OVERDUE</span>';
            break;
        case 'paused':
            element.classList.add('approved');
            element.innerHTML = '<span>PAUSED</span>';
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
        lastDueDateEl.innerText = isPaused ? 'Paused' : (weekInfo.shortWeekLabel ? weekInfo.shortWeekLabel.split('-')[1].trim() : '23 Aug 2026 (Sun)');
    }

    const lastPaidDateEl = document.getElementById('py-last-paid-date');
    if (lastPaidDateEl) {
        if (activeSub?.submittedAt) {
            lastPaidDateEl.innerText = new Date(activeSub.submittedAt).toLocaleString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } else {
            lastPaidDateEl.innerText = currentStatus === 'approved' ? 'Verified' : 'Not paid yet';
        }
    }

    const totalAmountEl = document.getElementById('py-total-amount');
    if (totalAmountEl) {
        const total = duesSummary.totalAmountToBePaid !== undefined ? duesSummary.totalAmountToBePaid : (weekInfo.amount || 140);
        totalAmountEl.innerText = `₹${total}`;
    }

    const prevDuesEl = document.getElementById('py-prev-dues-text');
    if (prevDuesEl) {
        prevDuesEl.innerText = duesSummary.previousDuesText || 'No previous dues';
        prevDuesEl.className = duesSummary.previousDuesIncluded ? 'py-footer-val danger' : 'py-footer-val green';
    }

    // Timer
    if (isPaused) {
        if (countdownTimer) clearInterval(countdownTimer);
        const timeEl = document.getElementById('py-time-left');
        if (timeEl) timeEl.innerText = 'Paused';
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
            noticeTitle.innerText = 'Weekly Payments Paused.';
            noticeDesc.innerText = pauseMsg;
        } else if (currentStatus === 'submitted') {
            noticeCard.className = 'py-general-notice-card submitted';
            noticeTitle.innerText = 'Payment under verification.';
            noticeDesc.innerText = 'Your weekly fee payment has been submitted and is currently being verified by our accounts team.';
        } else if (currentStatus === 'approved') {
            noticeCard.className = 'py-general-notice-card approved';
            noticeTitle.innerText = 'Weekly fee paid & verified.';
            noticeDesc.innerText = 'Your weekly fee payment of ₹140 has been verified and approved. You are active to receive ride requests.';
        } else if (currentStatus === 'declined') {
            noticeCard.className = 'py-general-notice-card declined';
            const reason = activeSub?.declineReason ? ` (${activeSub.declineReason})` : '';
            noticeTitle.innerText = 'Payment verification needed.';
            noticeDesc.innerText = `Your previous payment submission could not be verified${reason}. Please scan the QR code and re-submit your payment.`;
        } else if (currentStatus === 'overdue') {
            noticeCard.className = 'py-general-notice-card overdue';
            noticeTitle.innerText = 'Payment Overdue.';
            noticeDesc.innerText = `Your payment deadline has passed. Please complete the payment of ₹${duesSummary.totalAmountToBePaid || 140} to continue accepting ride requests cleanly.`;
        } else {
            noticeCard.className = 'py-general-notice-card';
            noticeTitle.innerText = 'Weekly payment due.';
            noticeDesc.innerText = 'Please pay your weekly fee before Sunday 12:00 PM to keep your driver account active and accept ride requests.';
        }
    }

    // 4) Main Pay Button
    if (payBtn) {
        const total = duesSummary.totalAmountToBePaid || weekInfo.amount || 140;
        if (isPaused) {
            payBtn.innerHTML = '<span>Weekly Payments Paused (No Fee Due)</span>';
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn disabled';
        } else if (currentStatus === 'submitted') {
            payBtn.innerHTML = '<span>Payment Submitted — Under Verification</span>';
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn disabled';
        } else if (currentStatus === 'approved') {
            payBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>Weekly Fee Paid (Verified ✓)</span>';
            payBtn.disabled = true;
            payBtn.className = 'py-main-pay-btn verified';
        } else if (currentStatus === 'declined') {
            payBtn.innerHTML = `<span>Re-pay Weekly Fee (₹${total})</span>`;
            payBtn.disabled = false;
            payBtn.className = 'py-main-pay-btn danger';
        } else {
            payBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg><span>Pay Weekly Fee (₹${total})</span>`;
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
            timeEl.innerText = 'Overdue';
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
    let badgeText = (item.status || 'due').toUpperCase();

    if (item.status === 'submitted') {
        badgeClass = 'submitted';
        badgeText = 'UNDER VERIFICATION';
    } else if (item.status === 'approved') {
        badgeClass = 'approved';
        badgeText = 'APPROVED';
    } else if (item.status === 'declined') {
        badgeClass = 'declined';
        badgeText = 'DECLINED';
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
        listEl.innerHTML = '<p class="text-muted text-center py-3 mb-0" style="font-size: 0.88rem;">No payment history records found.</p>';
        return;
    }

    listEl.innerHTML = recentList.map(renderHistoryItemHtml).join('');
}

function renderFullHistory(fullList) {
    const fullListEl = document.getElementById('py-full-history-list');
    if (!fullListEl) return;

    if (!fullList.length) {
        fullListEl.innerHTML = '<p class="text-muted text-center py-4 mb-0">No payment records found.</p>';
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
    paymentDoneBtn.innerText = 'Submitting verification...';

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
            throw new Error(formatErrorMessage(data, 'Could not submit payment verification.'));
        }

        closeQrModal();
        await showAlert("Payment submitted! Your payment is now under manual verification by the Ride Share Accounts team.");
        await fetchPaymentStatus();
    } catch (error) {
        console.error("Error submitting payment verification:", error);
        showAlert(error.message || "Could not submit payment verification.");
    } finally {
        paymentDoneBtn.disabled = false;
        paymentDoneBtn.innerText = 'Payment done';
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

// History Modal Listeners
seeAllTopBtn?.addEventListener('click', () => historyModal?.classList.remove('d-none'));
seeAllFullBtn?.addEventListener('click', () => historyModal?.classList.remove('d-none'));
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
});
