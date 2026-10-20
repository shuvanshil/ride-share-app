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
import { t, translateDOM } from '../shared/i18n.js';
import { registerDriverPushToken } from '../shared/messaging.js';
import { buildUpiUri } from '../shared/upi-qr-helper.js';

let currentAuthUser = null;
let currentPaymentData = null;
let realtimeUnsubscribe = null;
let currentTotalAmount = 0;
let currentBaseFee = 0;
let currentOverdueAmount = 0;

// DOM Elements
const backBtn = document.getElementById('payments-back-btn');
const headerTitle = document.getElementById('fee-header-title');

const loadingScreen = document.getElementById('payments-loading-screen');
const mainContainer = document.getElementById('payments-container');

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

// Unified Payment Details & Recent Elements
const paymentDetailsCard = document.getElementById('fee-payment-details-card');
const paymentDetailsToggle = document.getElementById('fee-payment-details-toggle');
const paymentDetailsBody = document.getElementById('fee-payment-details-body');
const paymentDetailsChevron = document.getElementById('fee-payment-details-chevron');
const weekRangeHeader = document.getElementById('fee-week-range-header');
const weekDaysList = document.getElementById('fee-week-days-list');
const summaryTotalPaid = document.getElementById('fee-summary-total-paid');
const summaryUnderReviewRow = document.getElementById('fee-summary-under-review-row');
const summaryUnderReviewLabel = document.getElementById('fee-summary-under-review-label');
const summaryUnderReviewAmount = document.getElementById('fee-summary-under-review-amount');
const summaryRemaining = document.getElementById('fee-summary-remaining');
const lastVerifiedCard = document.getElementById('fee-last-verified-card');
const lastVerifiedText = document.getElementById('fee-last-verified-text');
const underReviewCard = document.getElementById('fee-under-review-card');
const underReviewCardToggle = document.getElementById('fee-under-review-card-toggle');
const underReviewCardTitle = document.getElementById('fee-under-review-card-title');
const underReviewCardBody = document.getElementById('fee-under-review-card-body');
const underReviewCardChevron = document.getElementById('fee-under-review-card-chevron');
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

// Format date helpers
function parseYMD(dateStr) {
    if (!dateStr) return null;
    const parts = String(dateStr).slice(0, 10).split('-');
    if (parts.length === 3) {
        return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    return new Date(dateStr);
}

function formatShortDate(dateStr) {
    if (!dateStr) return '';
    const d = parseYMD(dateStr);
    if (!d || isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const month = d.toLocaleString('en-US', { month: 'short' });
    return `${day} ${month}`;
}

function formatShortMonth(dateStr) {
    if (!dateStr) return '';
    const d = parseYMD(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month: 'short' });
}

function getWeekDaysIST(serverNowStr) {
    let now;
    if (serverNowStr) {
        now = new Date(serverNowStr);
    } else {
        now = new Date();
    }
    // Shift to IST (UTC+05:30)
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istMs = utcMs + (5.5 * 3600 * 1000);
    const istDate = new Date(istMs);

    const year = istDate.getFullYear();
    const month = istDate.getMonth();
    const date = istDate.getDate();
    const dayOfWeek = istDate.getDay(); // 0 is Sun, 1 is Mon...
    const monDiff = (dayOfWeek + 6) % 7; // Mon is 0

    const days = [];
    const shortDaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const shortDayKeys = ['mon_short', 'tue_short', 'wed_short', 'thu_short', 'fri_short', 'sat_short', 'sun_short'];
    const fullDayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    for (let i = 0; i < 7; i++) {
        const d = new Date(year, month, date - monDiff + i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        days.push({
            dateStr: dateStr,
            year: yyyy,
            month: d.getMonth(),
            dayNum: d.getDate(),
            shortDayKey: shortDayKeys[i],
            fullDayKey: fullDayKeys[i],
            defaultShortName: shortDaysEn[i]
        });
    }
    return days;
}

function isDayClosedIST(dateStr, serverNowStr) {
    if (!dateStr) return false;
    let now;
    if (serverNowStr) {
        now = new Date(serverNowStr);
    } else {
        now = new Date();
    }
    // A service day for dateStr closes at 20:00:00 IST on that date (14:30:00 UTC)
    const closeTimeUtc = new Date(`${dateStr}T14:30:00.000Z`).getTime();
    return now.getTime() >= closeTimeUtc;
}

function formatDayWithDate(dayObj) {
    const shortDayName = t(`driver.${dayObj.shortDayKey}`, dayObj.defaultShortName);
    const shortMonth = formatShortMonth(dayObj.dateStr);
    return `${shortDayName}, ${dayObj.dayNum} ${shortMonth}`;
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

        const response = await fetch('/api/fees/summary', {
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
        if (mainContainer) mainContainer.classList.remove('d-none');
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
            collection(db, "feePaymentBatches"),
            where("uid", "==", uid)
        );

        realtimeUnsubscribe = onSnapshot(q, () => {
            fetchPaymentStatus();
        }, (err) => {
            console.warn("Driver fees realtime listener error:", err);
        });
    } catch (err) {
        console.warn("Failed to attach realtime snapshot listener:", err);
    }
}

// -------------------------------------------------------------
// UI State Rendering
// -------------------------------------------------------------
function renderPaymentPage(data) {
    const isPaused = Boolean(data.isPaused);
    const pauseMessage = data.pauseMessage || "Weekly payments are currently paused. Chill and relax — no payment is required during this period.";

    const payablePaise = data.payable_paise || 0;
    const overduePaise = data.restriction?.overdue_paise || 0;
    const underReviewPaise = data.under_review_paise || 0;
    const isRestricted = Boolean(data.restriction?.is_restricted);

    const totalAmount = data.payable_inr !== undefined ? data.payable_inr : (payablePaise / 100);
    const overdueAmount = overduePaise / 100;
    const baseFee = Math.max(0, totalAmount - overdueAmount);

    currentTotalAmount = totalAmount;
    currentBaseFee = baseFee;
    currentOverdueAmount = overdueAmount;

    // Determine normalized current state: 'due', 'submitted', 'approved', 'declined', 'paused', 'no_dues'
    const hasPaidFees = (data.fees || []).some(f => (f.paid_paise || 0) > 0);
    const hasApprovedHistory = (data.history || []).some(h => h.status === 'approved');

    let state = 'due';
    if (isPaused) {
        state = 'paused';
    } else if (isRestricted) {
        state = 'declined';
    } else if (totalAmount === 0 && underReviewPaise === 0) {
        if (hasPaidFees || hasApprovedHistory) {
            state = 'approved';
        } else {
            state = 'no_dues';
        }
    } else if (totalAmount === 0 && underReviewPaise > 0) {
        state = 'submitted';
    } else {
        state = 'due';
    }

    // Apply translations to static DOM elements
    translateDOM(document);

    // 1. Render Status Banner
    renderStatusBanner(state, totalAmount, data, pauseMessage);

    // 2. Render Timeline Axis Nodes
    renderTimelineNodes(state);

    // 3. Step 1: Remaining / This week range
    const weekDays = getWeekDaysIST(data.server_now);
    const monDay = weekDays[0];
    const sunDay = weekDays[6];
    const weekRangeStr = `${formatShortDate(monDay.dateStr)} – ${formatShortDate(sunDay.dateStr)}`;
    const weekSubtext = t('driver.this_week_range', 'This week ({range})', { range: weekRangeStr });

    const closedUnpaidDates = [];
    weekDays.forEach(day => {
        if (isDayClosedIST(day.dateStr, data.server_now)) {
            const fee = (data.fees || []).find(f => f.serviceDate === day.dateStr);
            if (fee && (fee.remaining_paise || 0) > 0) {
                closedUnpaidDates.push(day.dateStr);
            }
        }
    });

    let remainingHeading = '';
    if (closedUnpaidDates.length > 0) {
        const firstD = closedUnpaidDates[0];
        const lastD = closedUnpaidDates[closedUnpaidDates.length - 1];
        const rangeStr = firstD === lastD ? formatShortDate(firstD) : `${formatShortDate(firstD)} – ${formatShortDate(lastD)}`;
        remainingHeading = t('driver.remaining_range', 'Remaining: {range}', { range: rangeStr });
    } else {
        remainingHeading = t('driver.remaining_none', 'Remaining: None');
    }

    const step1Title = document.getElementById('fee-step-1-title');
    if (step1Title) step1Title.innerText = `1. ${remainingHeading}`;
    if (step1Dates) step1Dates.innerText = weekSubtext;

    // 4. Step 2: Under review / Due / Completed
    renderStep2(state, totalAmount, overdueAmount, baseFee, data);

    // 5. Step 3: Payment verified
    renderStep3(state, data);

    // 6. Render Unified Payment Details (shown on ALL states)
    renderUnifiedPaymentDetails(data, weekDays);

    // 7. Render Recent Payments
    renderRecentPayments(data.history || []);
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
        bannerTitleEl.innerText = t('driver.status_verified_title', 'Payment verified');
        bannerDescEl.innerText = t('driver.status_verified_desc', "Your payment has been confirmed. You're all set for this week.");
    } else if (state === 'no_dues') {
        bannerEl.classList.add('verified');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        `;
        bannerTitleEl.innerText = t('driver.no_payment_due_title', 'No payment due');
        bannerDescEl.innerText = t('driver.no_payment_due_sub', "You have no outstanding fees. You're all clear to drive.");
    } else if (state === 'submitted') {
        bannerEl.classList.add('submitted');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
        `;
        bannerTitleEl.innerText = t('driver.status_review_title', 'Payment under review');
        bannerDescEl.innerText = t('driver.status_review_desc', "Your payment has been submitted and is being checked. Please don't make another payment.");
    } else if (state === 'declined') {
        bannerEl.classList.add('declined');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
        `;
        bannerTitleEl.innerText = t('driver.status_declined_title', 'Payment declined');
        const reasonPart = activeSub?.declineReason ? ` [${t('driver.decline_reason_tag', 'Reason: {reason}', { reason: activeSub.declineReason })}]` : '';
        bannerDescEl.innerText = `${t('driver.status_declined_desc', 'Your previous payment could not be verified. Please make the payment again.')}${reasonPart}`;
    } else if (state === 'paused') {
        bannerEl.classList.add('submitted');
        bannerIconWrapEl.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="10" y1="15" x2="10" y2="9"></line>
                <line x1="14" y1="15" x2="14" y2="9"></line>
            </svg>
        `;
        bannerTitleEl.innerText = t('driver.payments_paused_title', 'Weekly Payments Paused');
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
        bannerTitleEl.innerText = t('driver.status_due_title', 'Payment due');
        bannerDescEl.innerText = t('driver.status_due_desc', "Please complete this week's service fee.");
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

    // Step 2: completed when approved or no_dues, active (blue dot) otherwise
    if (node2) {
        if (state === 'approved' || state === 'no_dues') {
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

    // Step 3: completed when approved or no_dues, pending (gray ring) otherwise
    if (node3) {
        if (state === 'approved' || state === 'no_dues') {
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

function renderStep2(state, totalAmount, overdueAmount, baseFee, data) {
    if (!step2Wrapper) return;

    if (state === 'approved') {
        // Verified state
        step2Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title">${t('driver.step_under_review', '2. Under review')}</h4>
                <p class="fee-step-subtitle">${t('driver.step_review_done', 'Your payment has been reviewed.')}</p>
            </div>
        `;
        return;
    }

    if (state === 'no_dues') {
        // No dues / reset state
        step2Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title text-success">${t('driver.no_payment_due_step_title', '2. No payment due')}</h4>
                <p class="fee-step-subtitle">${t('driver.no_payment_due_step_sub', 'You have no outstanding fees for this week.')}</p>
            </div>
        `;
        return;
    }

    if (state === 'submitted') {
        // Under Review state
        const paidTimeStr = data?.submittedAt ? formatFullDateTime(data.submittedAt) : 'Recently submitted';
        const overdueHtml = overdueAmount > 0 ? `
            <div class="fee-overdue-pill">
                <strong>${t('driver.includes_overdue', 'Includes ₹{amount} overdue', { amount: overdueAmount })}</strong>
                <span>${t('driver.from_previous_week', 'from previous week')}</span>
            </div>
        ` : '';

        step2Wrapper.innerHTML = `
            <div class="fee-step-active-container">
                <h4 class="fee-step-title">${t('driver.step_under_review', '2. Under review')}</h4>
                <p class="fee-step-subtitle mb-0">${t('driver.step_review_waiting', 'We are confirming your payment. This usually takes a few minutes.')}</p>
                <div class="fee-inner-white-card">
                    <div class="fee-card-label">${t('driver.paid_amount', 'Paid amount')}</div>
                    <div class="fee-card-amount">₹${totalAmount}</div>
                    <div class="small text-muted mb-3" style="font-size: 0.8rem;">${t('driver.paid_on', 'Paid on {date}', { date: paidTimeStr })}</div>
                    ${overdueHtml}
                    <div class="fee-callout-warning">
                        <div class="fee-callout-icon">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                        </div>
                        <div class="fee-callout-text">
                            <strong>${t('driver.please_dont_pay_again', "Please don't make another payment.")}</strong>
                            <p>${t('driver.will_notify_confirmed', 'We will notify you once your payment is confirmed.')}</p>
                        </div>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    // DUE or DECLINED state (Mockup 1, 2, and 3)
    const fees = data?.fees || [];
    const hasPendingDistanceFees = fees.some(f => f.needs_attention || String(f.status).toUpperCase() === 'UNDER_REVIEW');
    
    let warningBannerHtml = '';
    if (hasPendingDistanceFees) {
        warningBannerHtml = `
            <div class="fee-overdue-pill">
                <strong>${t('driver.includes_pending_distance_fees', 'Includes pending distance fees (under review)')}</strong>
                <span>${t('driver.from_this_weeks_rides', "from this week's rides")}</span>
            </div>
        `;
    } else if (overdueAmount > 0) {
        warningBannerHtml = `
            <div class="fee-overdue-pill">
                <strong>${t('driver.includes_overdue', 'Includes ₹{amount} overdue', { amount: overdueAmount })}</strong>
                <span>${t('driver.from_previous_week', 'from previous week')}</span>
            </div>
        `;
    }

    const btnLabel = state === 'declined'
        ? t('driver.repay_now_btn', 'RE-PAY ₹{amount} NOW', { amount: totalAmount })
        : t('driver.pay_now_btn', 'PAY ₹{amount} NOW', { amount: totalAmount });

    // Build Daily breakdown rows for Mockup 3
    let dailyRowsHtml = '';
    let totalKm = 0;
    let totalFeeSum = 0;
    fees.forEach(f => {
        const sDate = f.serviceDate || '--';
        let dayName = '';
        let dateStr = '';
        try {
            const dt = new Date(sDate + 'T12:00:00');
            dayName = dt.toLocaleDateString('en-US', { weekday: 'long' });
            dateStr = dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        } catch (e) {
            dayName = sDate;
            dateStr = '';
        }
        const distNum = typeof f.distance_km === 'number' ? f.distance_km : parseFloat(f.distance_km || 0);
        totalKm += distNum;
        const feePaise = f.fee_paise || 0;
        const feeInr = Math.round(feePaise / 100);
        totalFeeSum += feeInr;

        dailyRowsHtml += `
            <div class="fee-breakdown-table-row" data-date="${sDate}" role="button" tabindex="0">
                <div class="fee-breakdown-day-col">
                    <span class="fee-breakdown-day-name">${dayName}</span>
                    <span class="fee-breakdown-day-date">${dateStr}</span>
                </div>
                <div class="fee-breakdown-dist-col">${distNum.toFixed(1)} km</div>
                <div class="fee-breakdown-fee-col">₹${feeInr}</div>
            </div>
        `;
    });

    // Overdue pill inside breakdown (Mockup 3)
    let overdueBreakdownPillHtml = '';
    if (overdueAmount > 0 || (data && data.overdue_paise > 0)) {
        const days = data?.overdue_days || 1;
        const dueOn = data?.earliest_overdue_due_date || 'earlier';
        const daysText = days === 1
            ? t('driver.overdue_by_1_day', 'Overdue by 1 day')
            : t('driver.overdue_by_days', 'Overdue by {days} days', { days });
        const dueOnText = t('driver.payment_was_due_on', 'Payment was due on {date}.', { date: dueOn });

        overdueBreakdownPillHtml = `
            <div class="fee-overdue-alert-pill">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#DC2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <div>
                    <div class="fee-overdue-alert-title">${daysText}</div>
                    <div class="fee-overdue-alert-desc">${dueOnText}</div>
                </div>
            </div>
        `;
    }

    step2Wrapper.innerHTML = `
        <div class="fee-step-active-container">
            <h4 class="fee-step-title">${t('driver.step_under_review', '2. Under review')}</h4>
            <p class="fee-step-subtitle mb-0">${t('driver.step_review_pending', 'Make the payment for this week.')}</p>
            <div class="fee-inner-white-card">
                <div class="fee-card-label">${t('driver.total_to_pay', 'Total to pay')}</div>
                <div class="fee-card-amount">₹${totalAmount}</div>
                ${warningBannerHtml}
                <button id="fee-pay-now-btn" type="button" class="fee-pay-cta-btn">
                    ${btnLabel}
                </button>
                <button id="fee-toggle-details-btn" type="button" class="fee-details-toggle">
                    <span>${t('driver.payment_details_label', 'Payment details')}</span>
                    <svg id="fee-toggle-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div id="fee-collapsible-breakdown" class="fee-collapsible-breakdown d-none">
                    <div class="fw-bold text-dark fs-6 mb-1">${t('driver.daily_breakdown', 'Daily breakdown')}</div>
                    <div class="fee-breakdown-subtext">${t('driver.daily_breakdown_desc', 'Fees are calculated at ₹1 per km, based on your daily distance.')}</div>
                    
                    <div class="fee-breakdown-table">
                        ${dailyRowsHtml || `<div class="text-secondary small py-2">No closed service days yet.</div>`}
                        
                        <div class="fee-breakdown-total-row">
                            <span class="text-dark">${t('driver.total_this_week', 'Total (this week)')}</span>
                            <span class="text-secondary fw-normal">${totalKm.toFixed(1)} km</span>
                            <span class="text-dark">₹${totalAmount}</span>
                        </div>
                    </div>

                    ${overdueBreakdownPillHtml}

                    <div>
                        <button type="button" id="fee-view-per-day-btn" class="fee-per-day-link">
                            &gt; ${t('driver.view_per_day_details', 'View per-day details')}
                        </button>
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

    const viewPerDayBtn = document.getElementById('fee-view-per-day-btn');
    if (viewPerDayBtn) {
        viewPerDayBtn.addEventListener('click', () => {
            const firstDate = fees.length > 0 ? fees[0].serviceDate : null;
            if (firstDate) {
                openCalculationModal(firstDate);
            }
        });
    }

    if (breakdownEl) {
        breakdownEl.querySelectorAll('.fee-breakdown-table-row').forEach(row => {
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                const d = row.getAttribute('data-date');
                if (d && d !== '--') openCalculationModal(d);
            });
        });
    }
}

function renderStep3(state, activeSub) {
    if (!step3Wrapper) return;

    if (state === 'approved') {
        const paidTimeStr = activeSub?.verifiedAt ? formatFullDateTime(activeSub.verifiedAt) : (activeSub?.submittedAt ? formatFullDateTime(activeSub.submittedAt) : 'Recently confirmed');
        step3Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title">${t('driver.step_payment_verified', '3. Payment verified')}</h4>
                <p class="fee-step-subtitle">${t('driver.paid_on', 'Paid on {date}', { date: paidTimeStr })}</p>
            </div>
        `;
    } else if (state === 'no_dues') {
        step3Wrapper.innerHTML = `
            <div class="fee-step-card green-bg">
                <h4 class="fee-step-title text-success">${t('driver.account_in_good_standing', '3. Account in good standing')}</h4>
                <p class="fee-step-subtitle">${t('driver.account_in_good_standing_sub', 'Your account is active with zero pending fees.')}</p>
            </div>
        `;
    } else {
        step3Wrapper.innerHTML = `
            <div class="fee-step-card gray-bg">
                <h4 class="fee-step-title">${t('driver.step_payment_verified', '3. Payment verified')}</h4>
                <p class="fee-step-subtitle">${t('driver.step_verified_waiting', "We’ll confirm your payment and update your status here.")}</p>
            </div>
        `;
    }
}

// -------------------------------------------------------------
// Unified Payment Details Section (Mockup Matching)
// -------------------------------------------------------------
function renderUnifiedPaymentDetails(data, weekDays) {
    const listEl = document.getElementById('fee-week-days-list');
    const weekHeaderEl = document.getElementById('fee-week-range-header');
    const summaryTotalPaid = document.getElementById('fee-summary-total-paid');
    const summaryUnderReviewRow = document.getElementById('fee-summary-under-review-row');
    const summaryUnderReviewLabel = document.getElementById('fee-summary-under-review-label');
    const summaryUnderReviewAmount = document.getElementById('fee-summary-under-review-amount');
    const summaryRemaining = document.getElementById('fee-summary-remaining');
    const lastVerifiedCard = document.getElementById('fee-last-verified-card');
    const lastVerifiedText = document.getElementById('fee-last-verified-text');
    const underReviewCard = document.getElementById('fee-under-review-card');
    const underReviewCardTitle = document.getElementById('fee-under-review-card-title');
    const underReviewCardBody = document.getElementById('fee-under-review-card-body');

    if (!listEl) return;

    const monDay = weekDays[0];
    const sunDay = weekDays[6];
    const weekRangeStr = `${formatShortDate(monDay.dateStr)} – ${formatShortDate(sunDay.dateStr)}`;
    if (weekHeaderEl) {
        weekHeaderEl.innerText = t('driver.this_week_range', 'This week ({range})', { range: weekRangeStr });
    }

    // 1. Generate 7 day rows
    let html = '';
    const fees = Array.isArray(data?.fees) ? data.fees : [];

    weekDays.forEach(day => {
        const isClosed = isDayClosedIST(day.dateStr, data.server_now);
        const dayLabel = formatDayWithDate(day);
        const fee = fees.find(f => f.serviceDate === day.dateStr);

        let distText = '—';
        let badgeHtml = '';
        let amountText = '—';
        let isClickable = false;

        if (!isClosed) {
            // Not closed yet (e.g. today before 8PM or future days of week)
            badgeHtml = `<span class="badge" style="background: #F1F5F9; color: #64748B; font-size: 0.74rem; font-weight: 600; border-radius: 9999px; padding: 4px 9px;">${t('driver.not_due_yet', 'Not due yet')}</span>`;
        } else if (fee) {
            const distKm = typeof fee.distance_km === 'number' ? fee.distance_km.toFixed(1) : (fee.distance_km || '0.0');
            distText = `${distKm} km`;
            isClickable = true;

            const isPaid = (fee.status || '').toUpperCase() === 'PAID' || ((fee.remaining_paise || 0) === 0 && (fee.review_paise || 0) === 0 && (fee.paid_paise || 0) > 0);
            const isUnderReview = (fee.status || '').toUpperCase() === 'UNDER_REVIEW' || (fee.review_paise || 0) > 0;
            const feeInr = Math.round((fee.fee_paise || 0) / 100);

            if (isPaid) {
                badgeHtml = `
                    <span class="badge" style="background: #DCFCE7; color: #15803D; font-size: 0.74rem; font-weight: 700; border-radius: 9999px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 4px;">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        ${t('driver.paid_badge', 'Paid')}
                    </span>
                `;
                amountText = `₹${feeInr}`;
            } else if (isUnderReview) {
                badgeHtml = `
                    <span class="badge" style="background: #FEF3C7; color: #B45309; font-size: 0.74rem; font-weight: 700; border-radius: 9999px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 4px;">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        ${t('driver.under_review_badge', 'Under review')}
                    </span>
                `;
                amountText = `₹${feeInr}`;
            } else {
                const remInr = Math.round((fee.remaining_paise || 0) / 100);
                badgeHtml = `
                    <span class="badge" style="background: #FEE2E2; color: #B91C1C; font-size: 0.74rem; font-weight: 700; border-radius: 9999px; padding: 4px 9px;">
                        ${t('driver.unpaid_badge', 'Unpaid')}
                    </span>
                `;
                amountText = `₹${remInr}`;
            }
        } else {
            // Closed with 0 km
            distText = '0.0 km';
            badgeHtml = `<span class="badge" style="background: #F1F5F9; color: #64748B; font-size: 0.74rem; font-weight: 600; border-radius: 9999px; padding: 4px 9px;">₹0</span>`;
            amountText = '₹0';
        }

        const cursorStyle = isClickable ? 'cursor: pointer;' : 'cursor: default;';
        const clickAttr = isClickable ? `role="button" tabindex="0" data-date="${day.dateStr}" class="fee-day-click-row"` : '';
        const arrowSpan = isClickable ? `<span class="text-secondary ms-1 fw-bold" style="font-size: 0.9rem;">&gt;</span>` : '';

        html += `
            <div class="d-flex justify-content-between align-items-center py-2 border-bottom" style="${cursorStyle}" ${clickAttr}>
                <div>
                    <div class="fw-semibold text-dark" style="font-size: 0.88rem;">${dayLabel}</div>
                    <div class="text-secondary small" style="font-size: 0.78rem;">${distText}</div>
                </div>
                <div class="d-flex align-items-center gap-3">
                    ${badgeHtml}
                    <div class="d-flex align-items-center text-dark fw-bold" style="font-size: 0.92rem; min-width: 44px; justify-content: flex-end;">
                        <span>${amountText}</span>
                        ${arrowSpan}
                    </div>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html;

    listEl.querySelectorAll('.fee-day-click-row').forEach(row => {
        row.addEventListener('click', () => {
            const d = row.getAttribute('data-date');
            if (d) openCalculationModal(d);
        });
    });

    // 2. Summary Rows
    const totalPaidPaise = fees.reduce((sum, f) => sum + (f.paid_paise || 0), 0);
    const totalPaidInr = Math.round(totalPaidPaise / 100);
    if (summaryTotalPaid) summaryTotalPaid.innerText = `₹${totalPaidInr}`;

    const underReviewFees = fees.filter(f => (f.review_paise || 0) > 0 || (f.status || '').toUpperCase() === 'UNDER_REVIEW');
    const underReviewTotalPaise = fees.reduce((sum, f) => sum + (f.review_paise || 0), 0);
    if (underReviewTotalPaise > 0) {
        summaryUnderReviewRow?.classList.remove('d-none');
        const count = underReviewFees.length;
        const countKey = count === 1 ? 'driver.under_review_days_count' : 'driver.under_review_days_count_plural';
        const defaultText = count === 1 ? `Under review (1 day)` : `Under review (${count} days)`;
        if (summaryUnderReviewLabel) summaryUnderReviewLabel.innerText = t(countKey, defaultText, { days: count });
        if (summaryUnderReviewAmount) summaryUnderReviewAmount.innerText = `₹${Math.round(underReviewTotalPaise / 100)}`;
    } else {
        summaryUnderReviewRow?.classList.add('d-none');
    }

    const remainingThisWeekPaise = fees.filter(f => weekDays.some(wd => wd.dateStr === f.serviceDate)).reduce((sum, f) => sum + (f.remaining_paise || 0), 0);
    if (summaryRemaining) summaryRemaining.innerText = `₹${Math.round(remainingThisWeekPaise / 100)}`;

    // 3. Last Payment Verified Card
    const approvedHistory = (data.history || []).filter(h => h.status === 'approved');
    if (approvedHistory.length > 0) {
        lastVerifiedCard?.classList.remove('d-none');
        const latest = approvedHistory[0];
        const vDate = latest.verifiedAt ? new Date(latest.verifiedAt) : (latest.submittedAt ? new Date(latest.submittedAt) : new Date());
        const dayIdx = vDate.getDay();
        const fullDayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const fullDaysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = t(`driver.${fullDayKeys[dayIdx]}`, fullDaysEn[dayIdx]);
        const shortDate = formatShortDate(vDate.toISOString());
        const amount = Math.round(latest.amount || 0);

        if (lastVerifiedText) {
            lastVerifiedText.innerText = t('driver.last_payment_verified_desc', 'Your payment for {day}, {date} (₹{amount}) has been verified.', {
                day: dayName,
                date: shortDate,
                amount: amount
            });
        }
    } else {
        lastVerifiedCard?.classList.add('d-none');
    }

    // 4. Under review payments sub-card
    const underReviewItems = data.under_review_items || [];
    if (underReviewItems.length > 0) {
        underReviewCard?.classList.remove('d-none');
        if (underReviewCardTitle) {
            underReviewCardTitle.innerText = t('driver.under_review_payments_count', 'Under review payments ({count})', { count: underReviewItems.length });
        }
        if (underReviewCardBody) {
            underReviewCardBody.innerHTML = underReviewItems.map(item => {
                const sDate = item.serviceDate || item.formatted_date || '--';
                const distKm = item.distance_km !== undefined ? (typeof item.distance_km === 'number' ? item.distance_km.toFixed(1) : item.distance_km) : '0.0';
                const amt = Math.round(item.amount_inr || (item.amount_paise ? item.amount_paise / 100 : 0));
                return `
                    <div class="d-flex justify-content-between align-items-center py-2 border-bottom fee-under-review-row" data-date="${sDate}" role="button" tabindex="0" style="cursor: pointer;">
                        <div>
                            <div class="fw-semibold text-dark" style="font-size: 0.88rem;">${formatShortDate(sDate)}</div>
                            <div class="text-secondary small" style="font-size: 0.78rem;">${distKm} km • ₹${amt}</div>
                        </div>
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge" style="background: #FEF3C7; color: #B45309; font-size: 0.72rem; font-weight: 700; border-radius: 9999px; padding: 3px 8px;">
                                ${t('driver.under_review_badge', 'Under review')}
                            </span>
                            <span class="text-secondary ms-1 fw-bold">&gt;</span>
                        </div>
                    </div>
                `;
            }).join('');

            underReviewCardBody.querySelectorAll('.fee-under-review-row').forEach(row => {
                row.addEventListener('click', () => {
                    const d = row.getAttribute('data-date');
                    if (d && d !== '--') openCalculationModal(d);
                });
            });
        }
    } else {
        underReviewCard?.classList.add('d-none');
    }
}

// -------------------------------------------------------------
// Recent Payments List
// -------------------------------------------------------------
function renderRecentPayments(history) {
    const listEl = document.getElementById('fee-recent-list');
    if (!listEl) return;

    const approvedHistory = (Array.isArray(history) ? history : []).filter(h => h.status === 'approved');
    if (!approvedHistory.length) {
        listEl.innerHTML = `<p class="small text-muted mb-0">No past verified payments recorded.</p>`;
    } else {
        listEl.innerHTML = approvedHistory.slice(0, 3).map(item => {
            const itemDate = item.verifiedAt ? formatShortDate(item.verifiedAt) : (item.submittedAt ? formatShortDate(item.submittedAt) : '');
            return `
                <div class="fee-recent-item">
                    <div>
                        <div class="fee-recent-item-dates">${item.weekLabel || item.weekId}</div>
                        <div class="fee-recent-item-amount">₹${item.amount || 0}</div>
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

// -------------------------------------------------------------
// Calculation Breakdown Modal
// -------------------------------------------------------------
async function openCalculationModal(serviceDate) {
    const modal = document.getElementById('fee-calc-modal');
    if (!modal) return;
    const subTitle = document.getElementById('fee-calc-subtitle');
    const distEl = document.getElementById('fee-calc-dist');
    const ridesCountEl = document.getElementById('fee-calc-rides-count');
    const feeEl = document.getElementById('fee-calc-fee');
    const ridesWrap = document.getElementById('fee-calc-rides-wrap');
    const ridesList = document.getElementById('fee-calc-rides-list');
    const adjWrap = document.getElementById('fee-calc-adjustments-wrap');
    const adjList = document.getElementById('fee-calc-adjustments-list');

    if (subTitle) subTitle.innerText = `Service Day: ${serviceDate}`;
    if (distEl) distEl.innerText = 'Loading...';
    modal.classList.remove('d-none');

    try {
        const token = await getAuthToken();
        const res = await fetch(`/api/fees/${serviceDate}/calculation`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to load calculation details.');
        const data = await res.json();

        if (distEl) distEl.innerText = `${(data.finalized_km || 0).toFixed(2)} km (${data.billed_metres || 0} m)`;
        if (ridesCountEl) ridesCountEl.innerText = `${(data.counted_rides || []).length}`;
        if (feeEl) feeEl.innerText = `₹${((data.fee_paise || 0) / 100).toFixed(2)}`;

        if (ridesList) {
            const counted = data.counted_rides || [];
            if (counted.length === 0) {
                ridesList.innerHTML = `<div class="text-muted fst-italic">No completed rides recorded on this service day.</div>`;
            } else {
                ridesList.innerHTML = counted.map(r => `
                    <div class="d-flex justify-content-between py-1 border-bottom">
                        <span class="text-truncate" style="max-width: 200px;">Ride #${(r.ride_id || '').slice(-6)}</span>
                        <span>${(r.distance_km || 0).toFixed(2)} km</span>
                    </div>
                `).join('');
            }
        }

        if (adjWrap && adjList) {
            const adjs = data.adjustments || [];
            if (adjs.length > 0) {
                adjWrap.classList.remove('d-none');
                adjList.innerHTML = adjs.map(a => `
                    <div class="d-flex justify-content-between py-1 text-info-emphasis border-bottom">
                        <span>${a.source || 'Adjustment'}: ${a.from_metres}m → ${a.to_metres}m</span>
                        <span>+₹${((a.delta_paise || 0) / 100).toFixed(2)}</span>
                    </div>
                `).join('');
            } else {
                adjWrap.classList.add('d-none');
            }
        }
    } catch (err) {
        console.error("Calculation modal load error:", err);
        if (distEl) distEl.innerText = 'Error loading details';
    }
}

document.getElementById('fee-calc-close-btn')?.addEventListener('click', () => {
    document.getElementById('fee-calc-modal')?.classList.add('d-none');
});

// -------------------------------------------------------------
// Payment Modal & QR Code Generation
// -------------------------------------------------------------
async function openPaymentModal() {
    if (!currentPaymentData) return;

    const totalAmount = currentTotalAmount || 0;
    const overdueAmount = currentOverdueAmount || 0;

    if (modalTotalAmount) modalTotalAmount.innerText = `₹${totalAmount.toFixed(2)}`;

    if (overdueAmount > 0) {
        modalOverduePill?.classList.remove('d-none');
        if (modalOverdueText) modalOverdueText.innerText = `Includes ₹${overdueAmount.toFixed(2)} overdue`;
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

        let downloadUrl = '';
        try {
            downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
        } catch (urlErr) {
            console.warn("Could not get direct downloadURL:", urlErr);
            const bucket = storage?.app?.options?.storageBucket;
            if (bucket && storagePath) {
                downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}?alt=media`;
            }
        }
        const token = await getAuthToken();

        // Build allocations: distribute currentTotalAmount across unpaid fees
        const unpaidFees = (currentPaymentData?.fees || [])
            .filter(f => (f.remaining_paise || 0) > 0)
            .sort((a, b) => (a.serviceDate || '').localeCompare(b.serviceDate || ''));

        let remPaise = Math.round(currentTotalAmount * 100);
        const allocations = [];
        for (const uf of unpaidFees) {
            if (remPaise <= 0) break;
            const alloc = Math.min(uf.remaining_paise, remPaise);
            if (alloc > 0) {
                allocations.push({
                    feeId: uf.feeId,
                    amount_paise: alloc,
                });
                remPaise -= alloc;
            }
        }

        const submitResponse = await fetch('/api/fees/payments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                amount: currentTotalAmount,
                proofStoragePath: storagePath,
                proofDownloadUrl: downloadUrl,
                proofFileName: cleanFileName,
                proofFileSize: file.size,
                proofContentType: file.type,
                allocations: allocations,
            })
        });

        if (!submitResponse.ok) {
            const errData = await submitResponse.json().catch(() => ({}));
            throw new Error(formatErrorMessage(errData, t('driver.submission_failed', 'Failed to submit payment verification request.')));
        }

        if (uploadProgressBar) uploadProgressBar.style.width = '100%';

        closePaymentModal();
        showAlert(t('driver.proof_submitted_alert', 'Payment screenshot submitted successfully! Your payment is now under review.'));

        // Re-fetch payment status immediately
        await fetchPaymentStatus();

        if (window.LiphtUpPaymentReminder) {
            window.LiphtUpPaymentReminder.hideModal();
        }

    } catch (err) {
        console.error("Screenshot upload/submission error:", err);
        showAlert(err.message || t('driver.upload_failed_retry', 'Failed to upload screenshot. Please try again.'));
    } finally {
        if (uploadProgressWrap) uploadProgressWrap.classList.add('d-none');
        if (screenshotFileInput) screenshotFileInput.value = '';
    }
}

// -------------------------------------------------------------
// History Modal
// -------------------------------------------------------------
let historyDisplayLimit = 10;

function renderHistoryModalList(history) {
    const fullHistoryList = document.getElementById('py-full-history-list');
    if (!fullHistoryList) return;

    const historyArr = Array.isArray(history) ? history : [];
    if (!historyArr.length) {
        fullHistoryList.innerHTML = `<p class="text-center text-muted py-4">${t('driver.no_payment_records', 'No payment records found.')}</p>`;
        return;
    }

    const visibleItems = historyArr.slice(0, historyDisplayLimit);
    let html = visibleItems.map(item => {
        let badgeClass = 'text-warning';
        let statusLabel = t('driver.step_under_review', 'Under review');
        if (item.status === 'approved') {
            badgeClass = 'text-success';
            statusLabel = t('driver.step_payment_verified', 'Payment verified');
        } else if (item.status === 'declined') {
            badgeClass = 'text-danger';
            statusLabel = t('driver.status_declined', 'Payment declined');
        }

        const subDate = item.submittedAt ? formatFullDateTime(item.submittedAt) : '--';
        return `
            <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
                <div>
                    <strong class="d-block text-dark" style="font-size: 0.9rem;">${item.weekLabel || item.weekId}</strong>
                    <small class="text-muted">${subDate}</small>
                    ${item.declineReason ? `<div class="small text-danger mt-1">${t('driver.reason', 'Reason')}: ${item.declineReason}</div>` : ''}
                </div>
                <div class="text-end">
                    <strong class="d-block" style="font-size: 0.95rem;">₹${item.amount || 0}</strong>
                    <span class="small fw-bold ${badgeClass}">${statusLabel}</span>
                </div>
            </div>
        `;
    }).join('');

    if (historyArr.length > historyDisplayLimit) {
        html += `
            <div class="text-center pt-3 pb-2" id="py-load-more-wrap">
                <button id="py-load-more-btn" type="button" class="btn btn-outline-primary btn-sm px-4 fw-bold">
                    ${t('driver.load_more_10', 'Load more 10')}
                </button>
            </div>
        `;
    }

    fullHistoryList.innerHTML = html;

    const loadMoreBtn = document.getElementById('py-load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            historyDisplayLimit += 10;
            renderHistoryModalList(historyArr);
        });
    }
}

function openHistoryModal() {
    if (!currentPaymentData) return;
    const history = currentPaymentData.history || [];
    historyDisplayLimit = 10;
    renderHistoryModalList(history);
    historyModal?.classList.remove('d-none');
}

function closeHistoryModal() {
    historyModal?.classList.add('d-none');
}

// -------------------------------------------------------------
// Event Listeners & Initialization
// -------------------------------------------------------------
let listenersInitialized = false;
function setupEventListeners() {
    if (listenersInitialized) return;
    listenersInitialized = true;

    backBtn?.addEventListener('click', () => {
        if (window.history.length > 1) {
            window.history.back();
        } else {
            window.location.href = 'driver-dashboard.html';
        }
    });

    modalCloseBtn?.addEventListener('click', closePaymentModal);
    sheetModal?.addEventListener('click', (e) => {
        if (e.target === sheetModal) closePaymentModal();
    });

    downloadQrBtn?.addEventListener('click', handleDownloadQr);

    uploadScreenshotBtn?.addEventListener('click', () => {
        screenshotFileInput?.click();
    });

    screenshotFileInput?.addEventListener('change', handleScreenshotSelected);

    // Toggle Unified Payment details
    const detailsToggle = document.getElementById('fee-payment-details-toggle');
    const detailsBody = document.getElementById('fee-payment-details-body');
    const detailsChevron = document.getElementById('fee-payment-details-chevron');
    if (detailsToggle && detailsBody && !detailsToggle.dataset.bound) {
        detailsToggle.dataset.bound = 'true';
        detailsToggle.addEventListener('click', () => {
            const isHidden = detailsBody.classList.contains('d-none');
            detailsBody.classList.toggle('d-none', !isHidden);
            if (detailsChevron) {
                detailsChevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });
    }

    // Toggle Under review sub-card
    const underReviewToggle = document.getElementById('fee-under-review-card-toggle');
    const underReviewBody = document.getElementById('fee-under-review-card-body');
    const underReviewChevron = document.getElementById('fee-under-review-card-chevron');
    if (underReviewToggle && underReviewBody && !underReviewToggle.dataset.bound) {
        underReviewToggle.dataset.bound = 'true';
        underReviewToggle.addEventListener('click', () => {
            const isHidden = underReviewBody.classList.contains('d-none');
            underReviewBody.classList.toggle('d-none', !isHidden);
            if (underReviewChevron) {
                underReviewChevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });
    }

    recentViewAllBtn?.addEventListener('click', openHistoryModal);
    historyModalCloseBtn?.addEventListener('click', closeHistoryModal);
    historyModal?.addEventListener('click', (e) => {
        if (e.target === historyModal) closeHistoryModal();
    });

    holdPayNowBtn?.addEventListener('click', openPaymentModal);
}

window.addEventListener('languageChanged', () => {
    translateDOM();
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
        if (urlParams.get('tab') === 'wallet') {
            window.location.href = 'profile.html?open=wallet';
            return;
        }

        await fetchPaymentStatus();
    } else {
        currentAuthUser = null;
        if (realtimeUnsubscribe) realtimeUnsubscribe();
        window.location.href = 'login.html';
    }
});

