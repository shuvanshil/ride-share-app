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
const qrModal = document.getElementById('qr-modal-card')?.parentElement || document.getElementById('qr-payment-modal');
const qrModalCloseBtn = document.getElementById('qr-modal-close-btn');
const qrModalCancelBtn = document.getElementById('qr-modal-cancel-btn');
const paymentDoneBtn = document.getElementById('payment-done-btn');
const upiQrImage = document.getElementById('upi-qr-image');

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
        const msg = (typeof error.message === 'object' && error.message !== null) ? JSON.stringify(error.message) : (error.message || "Failed to load payment details.");
        showAlert(msg);
    }
}

function renderStatusBadge(element, statusCode) {
    if (!element) return;
    element.className = 'payment-status-badge';
    
    switch (statusCode) {
        case 'due':
            element.classList.add('due');
            element.innerText = 'DUE';
            break;
        case 'submitted':
            element.classList.add('submitted');
            element.innerText = 'UNDER VERIFICATION';
            break;
        case 'approved':
            element.classList.add('approved');
            element.innerText = 'APPROVED';
            break;
        case 'declined':
            element.classList.add('declined');
            element.innerText = 'DECLINED';
            break;
        case 'overdue':
            element.classList.add('overdue');
            element.innerText = 'OVERDUE';
            break;
        case 'paused':
            element.classList.add('approved');
            element.innerText = 'PAUSED';
            break;
        default:
            element.classList.add('due');
            element.innerText = statusCode.toUpperCase();
    }
}

function renderPaymentUI(data) {
    const weekInfo = data.weekInfo || {};
    const currentStatus = data.currentStatus || 'due';
    const activeSub = data.activeSubmission;
    const isPaused = Boolean(data.isPaused);
    const pauseMsg = data.pauseMessage || "Weekly payments are currently paused. Chill and relax — no payment is required during this period.";

    // Render Week Range
    const weekLabelEl = document.getElementById('current-week-label');
    if (weekLabelEl) weekLabelEl.innerText = weekInfo.weekLabel || 'Current Week';

    // Render Status Badges
    renderStatusBadge(document.getElementById('current-week-status-badge'), currentStatus);
    renderStatusBadge(document.getElementById('overall-status-badge'), currentStatus);
    renderStatusBadge(document.getElementById('stat-status-pill'), currentStatus);

    // Render Stats
    const dueDateEl = document.getElementById('current-due-date');
    if (dueDateEl) {
        if (isPaused) {
            dueDateEl.innerText = 'Paused';
        } else if (weekInfo.deadlineFormatted) {
            dueDateEl.innerText = weekInfo.deadlineFormatted.replace(', ', '\n');
        } else {
            dueDateEl.innerText = '--';
        }
    }

    // Render Time Remaining
    if (isPaused) {
        if (countdownTimer) clearInterval(countdownTimer);
        const timeEl = document.getElementById('current-time-remaining');
        if (timeEl) {
            timeEl.innerText = 'Paused';
            timeEl.style.color = '#16a34a';
        }
    } else {
        startCountdown(weekInfo.sundayDeadline);
    }

    // Render Pause Banner vs Top Warning Banner
    const pauseBanner = document.getElementById('payments-pause-banner');
    const pauseMsgEl = document.getElementById('payments-pause-message');
    const topBanner = document.getElementById('payments-top-banner');

    if (isPaused) {
        if (pauseBanner) {
            if (pauseMsgEl) pauseMsgEl.innerText = pauseMsg;
            pauseBanner.classList.remove('d-none');
        }
        if (topBanner) topBanner.classList.add('d-none');
    } else {
        if (pauseBanner) pauseBanner.classList.add('d-none');
        if (topBanner) {
            const titleEl = document.getElementById('payments-banner-title');
            if (currentStatus === 'overdue') {
                topBanner.className = 'payments-top-notice pause';
                if (titleEl) titleEl.innerText = '⚠️ Payment Overdue: Please pay ₹20 now to avoid ride dispatch suspension.';
                topBanner.classList.remove('d-none');
            } else if (currentStatus === 'due') {
                topBanner.className = 'payments-top-notice';
                if (titleEl) titleEl.innerText = `Pay your weekly fee of ₹20 by ${weekInfo.deadlineFormatted || 'Sunday 12:00 PM'}`;
                topBanner.classList.remove('d-none');
            } else {
                topBanner.classList.add('d-none');
            }
        }
    }

    // Render Status Info Box
    const infoBox = document.getElementById('current-status-info-box');
    const infoTitle = document.getElementById('current-status-info-title');
    const infoText = document.getElementById('current-status-info-text');
    const overallDesc = document.getElementById('overall-status-desc');

    if (infoBox && infoText) {
        infoBox.className = 'payments-info-box';
        if (isPaused) {
            infoBox.classList.add('approved');
            if (infoTitle) infoTitle.innerText = 'Weekly Payments Paused.';
            infoText.innerText = pauseMsg;
            if (overallDesc) overallDesc.innerHTML = 'Weekly payments are paused by administration.<br>No fee is due during this period.';
        } else if (currentStatus === 'submitted') {
            infoBox.classList.add('submitted');
            if (infoTitle) infoTitle.innerText = 'Payment Under Verification.';
            infoText.innerText = 'Your payment for this week has been submitted and is currently under verification by the Ride Share Accounts team.';
            if (overallDesc) overallDesc.innerHTML = 'Payment submitted — awaiting verification.<br>Accounts team is reviewing your payment.';
        } else if (currentStatus === 'approved') {
            infoBox.classList.add('approved');
            if (infoTitle) infoTitle.innerText = 'Weekly Fee Paid & Verified.';
            infoText.innerText = 'Your weekly fee payment of ₹20 has been verified and approved. You are active to receive ride requests.';
            if (overallDesc) overallDesc.innerHTML = 'Weekly payment is verified and active.<br>You are ready to accept ride requests.';
        } else if (currentStatus === 'declined') {
            infoBox.classList.add('declined');
            const reason = activeSub?.declineReason ? ` Reason: ${activeSub.declineReason}` : '';
            if (infoTitle) infoTitle.innerText = 'Payment Submission Declined.';
            infoText.innerText = `Your previous payment submission was declined.${reason} Please scan the QR code and pay again.`;
            if (overallDesc) overallDesc.innerHTML = 'Payment declined.<br>Replacement payment required.';
        } else if (currentStatus === 'overdue') {
            infoBox.classList.add('declined');
            if (infoTitle) infoTitle.innerText = 'Payment Overdue!';
            infoText.innerText = 'Your payment deadline has passed. Please pay the weekly fee of ₹20 immediately to continue accepting rides.';
            if (overallDesc) overallDesc.innerHTML = 'Payment overdue.<br>Please complete payment now to continue.';
        } else {
            if (infoTitle) infoTitle.innerText = 'Your payment for this week is due.';
            infoText.innerText = 'Please pay before Sunday 12:00 PM to avoid any interruptions.';
            if (overallDesc) overallDesc.innerHTML = 'You haven\'t paid for this week yet.<br>Complete the payment to keep receiving ride requests.';
        }
    }

    // Configure Primary Pay Button
    if (payBtn) {
        if (isPaused) {
            payBtn.innerText = 'Weekly Payments Paused (No Fee Due)';
            payBtn.disabled = true;
            payBtn.className = 'gy-btn gy-btn-success w-100 py-3 fw-bold';
        } else if (currentStatus === 'submitted') {
            payBtn.innerText = 'Payment Submitted — Under Verification';
            payBtn.disabled = true;
            payBtn.className = 'gy-btn gy-btn-dark w-100 py-3 fw-bold';
        } else if (currentStatus === 'approved') {
            payBtn.innerText = 'Weekly Fee Paid (Verified ✓)';
            payBtn.disabled = true;
            payBtn.className = 'gy-btn gy-btn-success w-100 py-3 fw-bold';
        } else if (currentStatus === 'declined') {
            payBtn.innerText = 'Re-pay Weekly Fee (₹20)';
            payBtn.disabled = false;
            payBtn.className = 'gy-btn gy-btn-danger w-100 py-3 fw-bold';
        } else {
            payBtn.innerText = 'Pay the weekly fee';
            payBtn.disabled = false;
            payBtn.className = 'gy-btn gy-btn-primary w-100 py-3 fw-bold';
        }
    }

    // Render History List
    renderHistoryList(data.history || []);
}

function startCountdown(deadlineIso) {
    if (countdownTimer) clearInterval(countdownTimer);
    const timeEl = document.getElementById('current-time-remaining');
    if (!timeEl || !deadlineIso) return;

    const updateTimer = () => {
        const now = new Date().getTime();
        const deadline = new Date(deadlineIso).getTime();
        const diff = deadline - now;

        if (diff <= 0) {
            timeEl.innerText = 'Passed';
            timeEl.style.color = '#dc2626';
            clearInterval(countdownTimer);
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        if (days > 0) {
            timeEl.innerText = `${days}d ${hours}h ${minutes}m`;
        } else if (hours > 0) {
            timeEl.innerText = `${hours}h ${minutes}m ${seconds}s`;
        } else {
            timeEl.innerText = `${minutes}m ${seconds}s`;
        }
    };

    updateTimer();
    countdownTimer = setInterval(updateTimer, 1000);
}

function renderHistoryList(history) {
    const listEl = document.getElementById('payments-history-list');
    const countBadge = document.getElementById('history-count-badge');
    if (!listEl) return;

    if (countBadge) countBadge.innerText = `${history.length} record${history.length === 1 ? '' : 's'}`;

    if (!history.length) {
        listEl.innerHTML = '<p class="text-muted text-center py-3 mb-0" style="font-size: 0.9rem;">No previous payment records found.</p>';
        return;
    }

    listEl.innerHTML = history.map(item => {
        const amountStr = `₹${item.amount || 20}`;
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
            <div class="payments-history-item">
                <div class="payments-history-left">
                    <span class="payments-history-week">${weekStr}</span>
                    <span class="payments-history-amount">${amountStr}</span>
                </div>
                <div class="payments-history-right">
                    <span class="payment-status-badge ${badgeClass}">${badgeText}</span>
                    <span class="payments-history-date">${subDate}</span>
                </div>
            </div>
        `;
    }).join('');
}

function openQrModal() {
    if (!currentPaymentData) return;
    const weekInfo = currentPaymentData.weekInfo || {};
    const payeeUpi = weekInfo.payeeUpiId || "shuvanshil@oksbi";
    const amount = weekInfo.amount || 20;
    const payeeName = encodeURIComponent(weekInfo.payeeName || "Ride Share Accounts");

    const upiUri = `upi://pay?pa=${payeeUpi}&pn=${payeeName}&am=${amount}&cu=INR`;
    const encodedUpi = encodeURIComponent(upiUri);

    if (upiQrImage) {
        upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodedUpi}`;
    }

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
            // Re-fetch status when Firestore collection changes
            fetchPaymentStatus();
        }, (err) => {
            console.warn("Realtime payment listener error:", err);
        });
    } catch (e) {
        console.warn("Could not attach Firestore realtime listener:", e);
    }
}

// Event Listeners
backBtn?.addEventListener('click', () => {
    window.location.href = '/profile.html';
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
