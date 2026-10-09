/**
 * driver-payments.js
 * Redesigned Driver Weekly Service Fee page & End-to-End Verification Flow.
 * Handles state-driven UI (DUE, UNDER_REVIEW, VERIFIED, DECLINED, PAUSED),
 * dynamic UPI QR generation, Firebase Storage screenshot uploads,
 * realtime status synchronization, and Driver Wallet transactions.
 */
import { auth, db, storage, ref, uploadBytesResumable, getDownloadURL } from '../platform/firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { showAlert } from '../shared/dialog.js';
import { t } from '../shared/i18n.js';
import { registerDriverPushToken } from '../shared/messaging.js';
import { buildUpiUri } from '../shared/upi-qr-helper.js';

let currentAuthUser = null;
let currentPaymentData = null;
let realtimeUnsubscribe = null;
let isWalletViewActive = false;

// DOM Elements
const backBtn = document.getElementById('payments-back-btn');
const headerTitle = document.getElementById('fee-header-title');
const walletToggleBtn = document.getElementById('fee-wallet-toggle-btn');
const walletToggleLabel = document.getElementById('fee-wallet-toggle-label');

const loadingScreen = document.getElementById('payments-loading-screen');
const mainContainer = document.getElementById('payments-container');
const walletContainer = document.getElementById('driver-wallet-tab-content');

// Status Banner Elements
const bannerEl = document.getElementById('fee-status-banner');
const bannerTitleEl = document.getElementById('fee-status-title');
const bannerDescEl = document.getElementById('fee-status-desc');
const bannerIconWrapEl = document.getElementById('fee-status-icon-wrap');

// Timeline Nodes & Steps
const node1 = document.getElementById('fee-node-1');
const node2 = document.getElementById('fee-node-2');
const node3 = document.getElementById('fee-node-3');
const step1Card = document.getElementById('fee-step-1-card');
const step1Dates = document.getElementById('fee-step-1-dates');
const step2Wrapper = document.getElementById('fee-step-2-wrapper');
const step3Wrapper = document.getElementById('fee-step-3-wrapper');

// Verified Extensions
const verifiedSectionsWrap = document.getElementById('fee-verified-sections-wrap');
const verifiedDetailsToggle = document.getElementById('fee-verified-details-toggle');
const verifiedDetailsBody = document.getElementById('fee-verified-details-body');
const verifiedChevron = document.getElementById('fee-verified-chevron');
const verifiedBaseAmount = document.getElementById('fee-verified-base-amount');
const verifiedOverdueRow = document.getElementById('fee-verified-overdue-row');
const verifiedOverdueAmount = document.getElementById('fee-verified-overdue-amount');
const verifiedTotalAmount = document.getElementById('fee-verified-total-amount');
const nextWeekDates = document.getElementById('fee-next-week-dates');
const nextWeekFee = document.getElementById('fee-next-week-fee');
const recentList = document.getElementById('fee-recent-list');
const recentViewAllBtn = document.getElementById('fee-recent-view-all-btn');

// Payment Modal Elements
const sheetModal = document.getElementById('fee-payment-sheet-modal');
const modalCloseBtn = document.getElementById('fee-modal-close-btn');
const modalTotalAmount = document.getElementById('fee-modal-total-amount');
const modalOverduePill = document.getElementById('fee-modal-overdue-pill');
const modalOverdueText = document.getElementById('fee-modal-overdue-text');
const qrCanvas = document.getElementById('fee-qr-canvas');
const downloadQrBtn = document.getElementById('fee-download-qr-btn');
const uploadScreenshotBtn = document.getElementById('fee-upload-screenshot-btn');
const screenshotFileInput = document.getElementById('fee-screenshot-file-input');
const uploadProgressWrap = document.getElementById('fee-upload-progress-wrap');
const uploadProgressBar = document.getElementById('fee-upload-progress-bar');
const uploadStatusText = document.getElementById('fee-upload-status-text');

// Account Hold & History Modals
const accountHoldModal = document.getElementById('account-hold-modal-overlay');
const holdPayNowBtn = document.getElementById('hold-pay-now-btn');
const historyModal = document.getElementById('py-history-modal');
const historyModalCloseBtn = document.getElementById('py-modal-close-btn');
const fullHistoryList = document.getElementById('py-full-history-list');

// Auth helper
async function getAuthToken() {
    if (!currentAuthUser) return null;
    return await currentAuthUser.getIdToken();
}

// Format error message
function formatErrorMessage(errData, fallback = 'An error occurred') {
    if (!errData) return fallback;
    if (typeof errData.error === 'string') return errData.error;
    if (typeof errData.error === 'object' && errData.error !== null) {
        return errData.error.message || JSON.stringify(errData.error);
    }
    if (typeof errData.detail === 'string') return errData.detail;
    return fallback;
}

// Format date helper
function formatShortDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const month = d.toLocaleString('en-US', { month: 'short' });
    return `${day} ${month}`;
}

function formatFullDateTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const month = d.toLocaleString('en-US', { month: 'short' });
    const year = d.getFullYear();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${day} ${month} ${year}, ${time}`;
}

// -------------------------------------------------------------
// Status & Data Fetching
// -------------------------------------------------------------
let isFetchingStatus = false;
async function fetchPaymentStatus() {
    if (isFetchingStatus) return;
    isFetchingStatus = true;
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
        renderPaymentPage(data);
    } catch (error) {
        console.error("Error fetching payment status:", error);
        showAlert(error.message || t('driver.fetch_payment_error', "Failed to load payment details."));
    } finally {
        isFetchingStatus = false;
        if (loadingScreen) loadingScreen.classList.add('d-none');
        if (!isWalletViewActive && mainContainer) mainContainer.classList.remove('d-none');
    }
}


// -------------------------------------------------------------
// Realtime Firestore Listener
// -------------------------------------------------------------
function setupRealtimeListener(uid) {
    if (realtimeUnsubscribe) {
        realtimeUnsubscribe();
        realtimeUnsubscribe = null;
    }

    try {
        const q = query(
            collection(db, "driverPayments"),
            where("driverId", "==", uid)
        );

        realtimeUnsubscribe = onSnapshot(q, () => {
            fetchPaymentStatus();
        }, (err) => {
            console.warn("Driver payments realtime listener error:", err);
        });
    } catch (err) {
        console.warn("Failed to attach realtime snapshot listener:", err);
    }
}

// -------------------------------------------------------------
// UI State Rendering
// -------------------------------------------------------------
function renderPaymentPage(data) {
    const weekInfo = data.weekInfo || {};
    const duesSummary = data.duesSummary || {};
    const activeSub = data.activeSubmission;
    const history = data.history || [];
    const isPaused = Boolean(data.isPaused);
    const pauseMessage = data.pauseMessage || "Weekly payments are currently paused. Chill and relax — no payment is required during this period.";

    // Determine normalized current state: 'due', 'submitted', 'approved', 'declined', 'paused'
    let state = data.currentStatus || 'due';
    if (isPaused) {
        state = 'paused';
    } else if (state === 'under_review') {
        state = 'submitted';
    } else if (state === 'verified') {
        state = 'approved';
    } else if (state === 'pending') {
        state = 'due';
    }

    const totalAmount = duesSummary.totalAmountToBePaid !== undefined ? duesSummary.totalAmountToBePaid : (weekInfo.amount || 140);
    const overdueAmount = duesSummary.previousDuesAmount || 0;
    const baseFee = weekInfo.amount || 140;

    // Check Account on Hold (10+ unpaid weeks)
    if (duesSummary.isAccountOnHold && state !== 'approved' && state !== 'submitted') {
        accountHoldModal?.classList.remove('d-none');
    } else {
        accountHoldModal?.classList.add('d-none');
    }

    // 1. Render Status Banner
    renderStatusBanner(state, totalAmount, activeSub, pauseMessage);

    // 2. Render Timeline Axis Nodes
    renderTimelineNodes(state);

    // 3. Step 1: This week
    if (step1Dates) {
        const monStr = formatShortDate(weekInfo.mondayStart);
        const sunStr = formatShortDate(weekInfo.sundayEnd);
        step1Dates.innerText = (monStr && sunStr) ? `${monStr} – ${sunStr}` : (weekInfo.shortWeekLabel || 'Current Week');
    }

    // 4. Step 2: Under review
    renderStep2(state, totalAmount, overdueAmount, baseFee, activeSub);

    // 5. Step 3: Payment verified
    renderStep3(state, activeSub);

    // 6. Verified Extensions (Details breakdown, Next week card, Recent payments)
    if (state === 'approved') {
        verifiedSectionsWrap?.classList.remove('d-none');
        renderVerifiedSections(duesSummary, baseFee, totalAmount, overdueAmount, history, activeSub);
    } else {
        verifiedSectionsWrap?.classList.add('d-none');
    }
}

function renderStatusBanner(state, totalAmount, activeSub, pauseMessage) {
    if (!bannerEl) return;

    bannerEl.className = 'fee-status-banner';

    if (state === 'approved') {
        bannerEl.classList.add('verified');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        `;
        bannerTitleEl.innerText = 'Payment verified';
        bannerDescEl.innerText = "Your payment has been confirmed. You're all set for this week.";
    } else if (state === 'submitted') {
        bannerEl.classList.add('submitted');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
        `;
        bannerTitleEl.innerText = 'Payment under review';
        bannerDescEl.innerText = "Your payment has been submitted and is being checked. Please don't make another payment.";
    } else if (state === 'declined') {
        bannerEl.classList.add('declined');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
        `;
        bannerTitleEl.innerText = 'Payment declined';
        const reasonText = activeSub?.declineReason ? ` (${activeSub.declineReason}).` : '.';
        bannerDescEl.innerText = `Your previous payment could not be verified${reasonText} Please make the payment again.`;
    } else if (state === 'paused') {
        bannerEl.classList.add('submitted');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="10" y1="15" x2="10" y2="9"></line>
                <line x1="14" y1="15" x2="14" y2="9"></line>
            </svg>
        `;
        bannerTitleEl.innerText = 'Weekly Payments Paused';
        bannerDescEl.innerText = pauseMessage;
    } else {
        // DUE state
        bannerEl.classList.add('due');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
        `;
        bannerTitleEl.innerText = 'Payment due';
        bannerDescEl.innerText = "Please complete this week's service fee.";
    }
}


function renderTimelineNodes(state) {
    // Step 1: always completed (green checkmark)
    if (node1) {
        node1.className = 'fee-node completed';
        node1.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        `;
    }

    // Step 2: completed when approved, active (blue dot) otherwise
    if (node2) {
        if (state === 'approved') {
            node2.className = 'fee-node completed';
            node2.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
        } else {
            node2.className = 'fee-node active';
            node2.innerHTML = '';
        }
    }

    // Step 3: completed when approved, pending (gray ring) otherwise
    if (node3) {
        if (state === 'approved') {
            node3.className = 'fee-node completed';
            node3.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
        } else {
            node3.className = 'fee-node pending';
            node3.innerHTML = '';
        }
    }
}

function renderStep2(state, totalAmount, overdueAmount, baseFee, activeSub) {
    if (!step2Wrapper) return;

    if (state === 'approved') {
        // Verified state
        step2Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title">2. Under review</h4>
                <p class="fee-step-subtitle">Your payment has been reviewed.</p>
            </div>
        `;
        return;
    }

    if (state === 'submitted') {
        // Under Review state
        const paidTimeStr = activeSub?.submittedAt ? formatFullDateTime(activeSub.submittedAt) : 'Recently submitted';
        const overdueHtml = overdueAmount > 0 ? `
            <div class="fee-overdue-pill">
                <strong>Includes ₹${overdueAmount} overdue</strong>
                <span>from previous week</span>
            </div>
        ` : '';

        step2Wrapper.innerHTML = `
            <div class="fee-step-active-container">
                <h4 class="fee-step-title">2. Under review</h4>
                <p class="fee-step-subtitle mb-0">We are confirming your payment. This usually takes a few minutes.</p>
                <div class="fee-inner-white-card">
                    <div class="fee-card-label">Paid amount</div>
                    <div class="fee-card-amount">₹${totalAmount}</div>
                    <div class="small text-muted mb-3" style="font-size: 0.8rem;">Paid on ${paidTimeStr}</div>
                    ${overdueHtml}
                    <div class="fee-callout-warning">
                        <div class="fee-callout-icon">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                        </div>
                        <div class="fee-callout-text">
                            <strong>Please don't make another payment.</strong>
                            <p>We will notify you once your payment is confirmed.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    // DUE or DECLINED state
    const overdueHtml = overdueAmount > 0 ? `
        <div class="fee-overdue-pill">
            <strong>Includes ₹${overdueAmount} overdue</strong>
            <span>from previous week</span>
        </div>
    ` : '';

    step2Wrapper.innerHTML = `
        <div class="fee-step-active-container">
            <h4 class="fee-step-title">2. Under review</h4>
            <p class="fee-step-subtitle mb-0">Make the payment for this week.</p>
            <div class="fee-inner-white-card">
                <div class="fee-card-label">Total to pay</div>
                <div class="fee-card-amount">₹${totalAmount}</div>
                ${overdueHtml}
                <button id="fee-pay-now-btn" type="button" class="fee-pay-cta-btn">
                    PAY ₹${totalAmount} NOW
                </button>
                <button id="fee-toggle-details-btn" type="button" class="fee-details-toggle">
                    <span>Payment details</span>
                    <svg id="fee-toggle-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div id="fee-collapsible-breakdown" class="fee-collapsible-breakdown d-none">
                    <div class="fee-breakdown-row">
                        <span>This week’s fee</span>
                        <strong>₹${baseFee}</strong>
                    </div>
                    ${overdueAmount > 0 ? `
                    <div class="fee-breakdown-row">
                        <span>Previous overdue</span>
                        <strong class="text-danger">₹${overdueAmount}</strong>
                    </div>
                    ` : ''}
                    <div class="fee-breakdown-row total-row">
                        <span>Total to pay</span>
                        <strong>₹${totalAmount}</strong>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Bind Pay Button and Details Toggle
    const payBtn = document.getElementById('fee-pay-now-btn');
    if (payBtn) {
        payBtn.addEventListener('click', openPaymentModal);
    }

    const toggleBtn = document.getElementById('fee-toggle-details-btn');
    const breakdownEl = document.getElementById('fee-collapsible-breakdown');
    const toggleChevron = document.getElementById('fee-toggle-chevron');
    if (toggleBtn && breakdownEl) {
        toggleBtn.addEventListener('click', () => {
            const isHidden = breakdownEl.classList.contains('d-none');
            breakdownEl.classList.toggle('d-none', !isHidden);
            if (toggleChevron) {
                toggleChevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });
    }
}

function renderStep3(state, activeSub) {
    if (!step3Wrapper) return;

    if (state === 'approved') {
        const paidTimeStr = activeSub?.verifiedAt ? formatFullDateTime(activeSub.verifiedAt) : (activeSub?.submittedAt ? formatFullDateTime(activeSub.submittedAt) : 'Recently confirmed');
        step3Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title">3. Payment verified</h4>
                <p class="fee-step-subtitle">Paid on ${paidTimeStr}</p>
            </div>
        `;
    } else {
        step3Wrapper.innerHTML = `
            <div class="fee-step-card gray-bg">
                <h4 class="fee-step-title">3. Payment verified</h4>
                <p class="fee-step-subtitle">We’ll confirm your payment and update your status here.</p>
            </div>
        `;
    }
}

function renderVerifiedSections(duesSummary, baseFee, totalAmount, overdueAmount, history, activeSub) {
    // Breakdown
    if (verifiedBaseAmount) verifiedBaseAmount.innerText = `₹${baseFee}`;
    if (verifiedTotalAmount) verifiedTotalAmount.innerText = `₹${totalAmount}`;

    if (overdueAmount > 0) {
        verifiedOverdueRow?.classList.remove('d-none');
        if (verifiedOverdueAmount) verifiedOverdueAmount.innerText = `₹${overdueAmount}`;
    } else {
        verifiedOverdueRow?.classList.add('d-none');
    }

    // Toggle Payment details
    if (verifiedDetailsToggle && verifiedDetailsBody) {
        verifiedDetailsToggle.onclick = () => {
            const isHidden = verifiedDetailsBody.classList.contains('d-none');
            verifiedDetailsBody.classList.toggle('d-none', !isHidden);
            if (verifiedChevron) {
                verifiedChevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
            }
        };
    }

    // Next week card
    const upcoming = duesSummary.upcomingWeek || {};
    if (nextWeekDates && upcoming.dueDateLabel) {
        nextWeekDates.innerText = `Due: ${upcoming.dueDateLabel}`;
    }
    if (nextWeekFee && upcoming.amount) {
        nextWeekFee.innerText = `Expected fee: ₹${upcoming.amount}`;
    }

    // Recent payments list (up to 3 items)
    if (recentList) {
        const approvedHistory = history.filter(h => h.status === 'approved');
        if (!approvedHistory.length) {
            recentList.innerHTML = `<p class="small text-muted mb-0">No past verified payments recorded.</p>`;
        } else {
            recentList.innerHTML = approvedHistory.slice(0, 3).map(item => {
                const itemDate = item.verifiedAt ? formatShortDate(item.verifiedAt) : (item.submittedAt ? formatShortDate(item.submittedAt) : '');
                return `
                    <div class="fee-recent-item">
                        <div>
                            <div class="fee-recent-item-dates">${item.weekLabel || item.weekId}</div>
                            <div class="fee-recent-item-amount">₹${item.amount || 140}</div>
                        </div>
                        <div class="text-end">
                            <span class="fee-recent-item-badge">Paid</span>
                            <div class="small text-muted mt-1" style="font-size: 0.72rem;">${itemDate}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

// -------------------------------------------------------------
// Payment Modal & QR Code Generation
// -------------------------------------------------------------
async function openPaymentModal() {
    if (!currentPaymentData) return;

    const duesSummary = currentPaymentData.duesSummary || {};
    const weekInfo = currentPaymentData.weekInfo || {};
    const totalAmount = duesSummary.totalAmountToBePaid !== undefined ? duesSummary.totalAmountToBePaid : (weekInfo.amount || 140);
    const overdueAmount = duesSummary.previousDuesAmount || 0;

    if (modalTotalAmount) modalTotalAmount.innerText = `₹${totalAmount}`;

    if (overdueAmount > 0) {
        modalOverduePill?.classList.remove('d-none');
        if (modalOverdueText) modalOverdueText.innerText = `Includes ₹${overdueAmount} overdue`;
    } else {
        modalOverduePill?.classList.add('d-none');
    }

    // Hide upload progress
    uploadProgressWrap?.classList.add('d-none');
    if (uploadProgressBar) uploadProgressBar.style.width = '0%';

    // Generate Dynamic UPI URI
    const payeeUpi = weekInfo.payeeUpiId || 'shuvanshil@oksbi';
    const payeeName = weekInfo.payeeName || 'LiphtUp';
    const upiUri = buildUpiUri({
        upiId: payeeUpi,
        name: payeeName,
        amount: totalAmount,
        note: `LiphtUp Fee ${weekInfo.weekId || ''}`
    });

    // Render QR Code onto canvas
    if (qrCanvas && window.QRCode) {
        try {
            await window.QRCode.toCanvas(qrCanvas, upiUri, {
                width: 220,
                margin: 1,
                color: {
                    dark: '#0F172A',
                    light: '#FFFFFF'
                },
                errorCorrectionLevel: 'M'
            });

            // Draw center LiphtUp branding icon badge matching mockup 1
            const ctx = qrCanvas.getContext('2d');
            if (ctx) {
                const logo = new Image();
                logo.src = 'assets/icons/liphtup-icon-192.png';
                await new Promise((resolve) => {
                    logo.onload = () => {
                        const iconSize = 38;
                        const x = (qrCanvas.width - iconSize) / 2;
                        const y = (qrCanvas.height - iconSize) / 2;
                        const pad = 3;
                        ctx.fillStyle = '#FFFFFF';
                        if (typeof ctx.roundRect === 'function') {
                            ctx.beginPath();
                            ctx.roundRect(x - pad, y - pad, iconSize + pad * 2, iconSize + pad * 2, 6);
                            ctx.fill();
                        } else {
                            ctx.fillRect(x - pad, y - pad, iconSize + pad * 2, iconSize + pad * 2);
                        }
                        ctx.drawImage(logo, x, y, iconSize, iconSize);
                        resolve();
                    };
                    logo.onerror = () => resolve();
                });
            }
        } catch (err) {
            console.error("QR Code rendering failed:", err);
        }
    }

    sheetModal?.classList.remove('d-none');
}

function closePaymentModal() {
    sheetModal?.classList.add('d-none');
}

// Download QR Code to Gallery
function handleDownloadQr() {
    if (!qrCanvas) return;
    try {
        const dataUrl = qrCanvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `liphtup-weekly-fee-qr-${currentPaymentData?.weekInfo?.weekId || 'payment'}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showAlert(t('driver.qr_downloaded', 'QR Code saved! You can scan it from your UPI payment app.'));
    } catch (err) {
        console.error("Failed to download QR code:", err);
        showAlert("Could not download QR code. You can take a screenshot of the QR code.");
    }
}


// -------------------------------------------------------------
// Screenshot Upload & Proof Submission
// -------------------------------------------------------------
async function handleScreenshotSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showAlert('Please select an image file (PNG, JPG, JPEG).');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        showAlert('Screenshot image file must be smaller than 10MB.');
        return;
    }

    if (!currentAuthUser) {
        showAlert('Please sign in to upload payment proof.');
        return;
    }

    const weekId = currentPaymentData?.weekInfo?.weekId || 'week';
    const paymentId = `pymt_${currentAuthUser.uid}_${weekId}_${Date.now()}`;
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `payment-proofs/${currentAuthUser.uid}/${paymentId}/${cleanFileName}`;

    try {
        // Show progress indicator
        uploadProgressWrap?.classList.remove('d-none');
        if (uploadStatusText) uploadStatusText.innerText = 'Uploading payment screenshot...';
        if (uploadProgressBar) uploadProgressBar.style.width = '10%';

        const storageReference = ref(storage, storagePath);
        const uploadTask = uploadBytesResumable(storageReference, file);

        await new Promise((resolve, reject) => {
            uploadTask.on(
                'state_changed',
                (snapshot) => {
                    const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 80) + 10;
                    if (uploadProgressBar) uploadProgressBar.style.width = `${progress}%`;
                },
                (error) => {
                    reject(error);
                },
                () => {
                    resolve();
                }
            );
        });

        if (uploadStatusText) uploadStatusText.innerText = 'Submitting verification request...';
        if (uploadProgressBar) uploadProgressBar.style.width = '95%';

        const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
        const token = await getAuthToken();

        const submitResponse = await fetch('/api/account/driver-payments/submit', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                paymentReference: 'UPI Screenshot Proof',
                paymentMethod: 'upi',
                proofStoragePath: storagePath,
                proofDownloadUrl: downloadUrl,
                proofFileName: cleanFileName,
                proofFileSize: file.size,
                proofContentType: file.type
            })
        });

        if (!submitResponse.ok) {
            const errData = await submitResponse.json().catch(() => ({}));
            throw new Error(formatErrorMessage(errData, 'Failed to submit payment verification request.'));
        }

        if (uploadProgressBar) uploadProgressBar.style.width = '100%';

        closePaymentModal();
        showAlert('Payment screenshot submitted successfully! Your payment is now under review.');

        // Re-fetch payment status immediately
        await fetchPaymentStatus();

    } catch (err) {
        console.error("Screenshot upload/submission error:", err);
        showAlert(err.message || 'Failed to upload screenshot. Please try again.');
    } finally {
        if (uploadProgressWrap) uploadProgressWrap.classList.add('d-none');
        if (screenshotFileInput) screenshotFileInput.value = '';
    }
}

// -------------------------------------------------------------
// History Modal
// -------------------------------------------------------------
function openHistoryModal() {
    if (!currentPaymentData) return;
    const history = currentPaymentData.history || [];

    if (fullHistoryList) {
        if (!history.length) {
            fullHistoryList.innerHTML = `<p class="text-center text-muted py-4">No payment records found.</p>`;
        } else {
            fullHistoryList.innerHTML = history.map(item => {
                let badgeClass = 'text-warning';
                let statusLabel = 'UNDER REVIEW';
                if (item.status === 'approved') {
                    badgeClass = 'text-success';
                    statusLabel = 'VERIFIED';
                } else if (item.status === 'declined') {
                    badgeClass = 'text-danger';
                    statusLabel = 'DECLINED';
                }

                const subDate = item.submittedAt ? formatFullDateTime(item.submittedAt) : '--';
                return `
                    <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
                        <div>
                            <strong class="d-block text-dark" style="font-size: 0.9rem;">${item.weekLabel || item.weekId}</strong>
                            <small class="text-muted">${subDate}</small>
                            ${item.declineReason ? `<div class="small text-danger mt-1">Reason: ${item.declineReason}</div>` : ''}
                        </div>
                        <div class="text-end">
                            <strong class="d-block" style="font-size: 0.95rem;">₹${item.amount || 140}</strong>
                            <span class="small fw-bold ${badgeClass}">${statusLabel}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    historyModal?.classList.remove('d-none');
}

function closeHistoryModal() {
    historyModal?.classList.add('d-none');
}

// -------------------------------------------------------------
// Driver Wallet Section
// -------------------------------------------------------------
let driverWalletTxLimit = 10;

function toggleWalletView() {
    isWalletViewActive = !isWalletViewActive;

    if (isWalletViewActive) {
        mainContainer?.classList.add('d-none');
        walletContainer?.classList.remove('d-none');
        if (headerTitle) headerTitle.innerText = 'Driver Wallet';
        if (walletToggleLabel) walletToggleLabel.innerText = 'Service Fee';
        fetchDriverWalletData();
    } else {
        walletContainer?.classList.add('d-none');
        mainContainer?.classList.remove('d-none');
        if (headerTitle) headerTitle.innerText = 'Weekly Service Fee';
        if (walletToggleLabel) walletToggleLabel.innerText = 'Wallet';
    }
}

async function fetchDriverWalletData(isLoadMore = false) {
    if (!currentAuthUser) return;
    const balanceEl = document.getElementById('driver-wallet-balance-val');
    const nextSettleEl = document.getElementById('driver-wallet-next-settlement-date');
    const txListEl = document.getElementById('driver-wallet-tx-list');

    if (!isLoadMore) {
        driverWalletTxLimit = 10;
    }

    try {
        const token = await getAuthToken();
        if (!token) return;

        const [walletRes, settleRes, txRes] = await Promise.all([
            fetch('/api/wallet', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }),
            fetch('/api/wallet/driver/settlement-info', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }),
            fetch(`/api/wallet/transactions?limit=${driverWalletTxLimit}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
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

        if (txListEl) {
            const txs = txData?.transactions || [];
            if (!txs.length) {
                txListEl.innerHTML = `
                    <div class="text-center py-4 text-muted">
                        <p class="small mb-0">${t('wallet.no_transactions', 'No transactions yet')}</p>
                    </div>
                `;
            } else {
                txListEl.innerHTML = txs.map(tx => {
                    const isCredit = tx.direction === 'credit';
                    const sign = isCredit ? '+' : '-';
                    const amtColor = isCredit ? '#16A34A' : '#1F2937';
                    const statusLabel = tx.isReversed ? t('wallet.reversed', 'Reversed') : (tx.status === 'completed' ? t('wallet.completed', 'Completed') : tx.status);
                    const dateStr = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

                    return `
                        <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
                            <div>
                                <strong class="d-block text-dark" style="font-size: 13px;">${tx.description || 'Wallet'}</strong>
                                <small class="text-muted" style="font-size: 11px;">${dateStr}</small>
                            </div>
                            <div class="text-end">
                                <strong style="font-size: 13px; color: ${amtColor};">${sign}₹${(tx.amount ?? 0).toLocaleString('en-IN')}</strong>
                                <span class="badge ${tx.isReversed ? 'bg-danger-subtle text-danger' : 'bg-success-subtle text-success'} d-block mt-1" style="font-size: 9px;">${statusLabel}</span>
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

// -------------------------------------------------------------
// Event Listeners & Initialization
// -------------------------------------------------------------
let listenersInitialized = false;
function setupEventListeners() {
    if (listenersInitialized) return;
    listenersInitialized = true;

    backBtn?.addEventListener('click', () => {
        if (isWalletViewActive) {
            toggleWalletView();
        } else if (window.history.length > 1) {
            window.history.back();
        } else {
            window.location.href = 'driver-dashboard.html';
        }
    });

    walletToggleBtn?.addEventListener('click', toggleWalletView);
    modalCloseBtn?.addEventListener('click', closePaymentModal);
    sheetModal?.addEventListener('click', (e) => {
        if (e.target === sheetModal) closePaymentModal();
    });

    downloadQrBtn?.addEventListener('click', handleDownloadQr);

    uploadScreenshotBtn?.addEventListener('click', () => {
        screenshotFileInput?.click();
    });

    screenshotFileInput?.addEventListener('change', handleScreenshotSelected);

    recentViewAllBtn?.addEventListener('click', openHistoryModal);
    historyModalCloseBtn?.addEventListener('click', closeHistoryModal);
    historyModal?.addEventListener('click', (e) => {
        if (e.target === historyModal) closeHistoryModal();
    });

    holdPayNowBtn?.addEventListener('click', openPaymentModal);

    document.getElementById('py-see-all-wallet-tx')?.addEventListener('click', () => {
        driverWalletTxLimit += 20;
        fetchDriverWalletData(true);
    });
}

window.addEventListener('languageChanged', () => {
    if (currentPaymentData) {
        renderPaymentPage(currentPaymentData);
    }
});

// Firebase Auth Lifecycle
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentAuthUser = user;
        setupEventListeners();
        setupRealtimeListener(user.uid);
        registerDriverPushToken(db, user.uid).catch(() => {});

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('tab') === 'wallet' && !isWalletViewActive) {
            toggleWalletView();
        }

        await fetchPaymentStatus();
    } else {
        currentAuthUser = null;
        if (realtimeUnsubscribe) realtimeUnsubscribe();
        window.location.href = 'login.html';
    }
});

