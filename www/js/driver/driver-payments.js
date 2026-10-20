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

    // Determine normalized current state: 'due', 'submitted', 'approved', 'declined', 'paused'
    let state = 'due';
    if (isPaused) {
        state = 'paused';
    } else if (isRestricted) {
        state = 'declined';
    } else if (totalAmount === 0 && underReviewPaise === 0) {
        state = 'approved';
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

    // 3. Step 1: This week
    if (step1Dates) {
        if (data.week_label) {
            step1Dates.innerText = data.week_label;
        } else {
            const now = new Date();
            const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
            const mon = new Date(now);
            mon.setDate(now.getDate() - dayOfWeek);
            const sun = new Date(mon);
            sun.setDate(mon.getDate() + 6);
            const opt = { day: 'numeric', month: 'short' };
            step1Dates.innerText = `${mon.toLocaleDateString('en-US', opt)} – ${sun.toLocaleDateString('en-US', opt)}`;
        }
    }

    // 4. Step 2: Under review
    renderStep2(state, totalAmount, overdueAmount, baseFee, data);

    // 5. Step 3: Payment verified
    renderStep3(state, data);

    // 6. Verified Extensions
    if (state === 'approved') {
        verifiedSectionsWrap?.classList.remove('d-none');
        renderVerifiedSections(data, baseFee, totalAmount, overdueAmount);
    } else {
        verifiedSectionsWrap?.classList.add('d-none');
    }

    // 7. Render Under Review Panel (collapsible, hidden if 0)
    renderUnderReviewPanel(data);

    // 8. Render Daily Breakdown
    renderDailyBreakdown(data.fees || []);
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
    } else {
        step3Wrapper.innerHTML = `
            <div class="fee-step-card gray-bg">
                <h4 class="fee-step-title">${t('driver.step_payment_verified', '3. Payment verified')}</h4>
                <p class="fee-step-subtitle">${t('driver.step_verified_waiting', "We’ll confirm your payment and update your status here.")}</p>
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
}

// -------------------------------------------------------------
// Under Review Payments Panel (Collapsible, hidden if 0)
// -------------------------------------------------------------
function renderUnderReviewPanel(data) {
    const panel = document.getElementById('fee-under-review-panel');
    const body = document.getElementById('fee-under-review-body');
    const chevron = document.getElementById('fee-under-review-chevron');
    const toggle = document.getElementById('fee-under-review-toggle');
    if (!panel || !body) return;

    // Extract items or batches
    const items = (data && data.under_review_items) ? data.under_review_items : (Array.isArray(data) ? [] : []);
    const batches = (data && data.under_review_batches) ? data.under_review_batches : (Array.isArray(data) ? data : []);

    // "Also note that only display this Under review payments section if there is any such listing available, if not, no need to show the section at all."
    if (items.length === 0 && batches.length === 0) {
        panel.classList.add('d-none');
        return;
    }

    panel.classList.remove('d-none');

    let html = '';
    if (items.length > 0) {
        items.forEach(it => {
            const dateStr = it.formatted_date || it.serviceDate || '--';
            const amt = Math.round(it.amount_inr || (it.amount_paise / 100));
            const km = typeof it.distance_km === 'number' ? it.distance_km.toFixed(1) : (it.distance_km || '0.0');
            html += `
                <div class="fee-under-review-item-card" data-date="${it.serviceDate || ''}" role="button" tabindex="0">
                    <div class="fee-item-left">
                        <div class="fee-item-calendar-icon">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                        </div>
                        <div>
                            <div class="fee-item-date">${dateStr}</div>
                            <div class="fee-item-amt-dist">
                                <strong>₹${amt}</strong>
                                <span>${km} km</span>
                            </div>
                        </div>
                    </div>
                    <div class="fee-item-right">
                        <span class="fee-item-badge-review">${t('driver.under_review_badge', 'Under review')}</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                </div>
            `;
        });
    } else {
        batches.forEach(b => {
            const dateStr = b.created_at ? new Date(b.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '--';
            const amt = Math.round(b.total_inr || (b.total_paise / 100));
            html += `
                <div class="fee-under-review-item-card" role="button" tabindex="0">
                    <div class="fee-item-left">
                        <div class="fee-item-calendar-icon">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                        </div>
                        <div>
                            <div class="fee-item-date">${dateStr}</div>
                            <div class="fee-item-amt-dist">
                                <strong>₹${amt}</strong>
                            </div>
                        </div>
                    </div>
                    <div class="fee-item-right">
                        <span class="fee-item-badge-review">${t('driver.under_review_badge', 'Under review')}</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                </div>
            `;
        });
    }
    body.innerHTML = html;

    body.querySelectorAll('.fee-under-review-item-card').forEach(card => {
        card.addEventListener('click', () => {
            const d = card.getAttribute('data-date');
            if (d && d !== '--') openCalculationModal(d);
        });
    });

    if (toggle && !toggle.dataset.bound) {
        toggle.dataset.bound = 'true';
        toggle.addEventListener('click', () => {
            const isHidden = body.classList.contains('d-none');
            body.classList.toggle('d-none', !isHidden);
            if (chevron) {
                chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        });
    }
}

// -------------------------------------------------------------
// Daily Fee Breakdown
// -------------------------------------------------------------
function renderDailyBreakdown(fees) {
    const list = document.getElementById('fee-daily-list');
    if (!list) return;

    if (!fees || fees.length === 0) {
        list.innerHTML = `<div class="text-center text-muted small py-3">No closed service days yet.</div>`;
        return;
    }

    let html = '';
    fees.forEach(f => {
        const sDate = f.serviceDate || '--';
        const distKm = typeof f.distance_km === 'number' ? f.distance_km.toFixed(1) : (f.distance_km || '0.0');
        const feeInr = ((f.fee_paise || 0) / 100).toFixed(2);
        const remInr = ((f.remaining_paise || 0) / 100).toFixed(2);
        const st = (f.status || 'unpaid').toUpperCase();

        let badgeClass = 'fee-badge-unpaid';
        let badgeLabel = 'Unpaid';
        if (st === 'PAID') {
            badgeClass = 'fee-badge-paid';
            badgeLabel = 'Paid';
        } else if (st === 'UNDER_REVIEW') {
            badgeClass = 'fee-badge-review';
            badgeLabel = 'Under Review';
        } else if (st === 'PARTIAL' || st === 'PARTIALLY_PAID') {
            badgeClass = 'fee-badge-partial';
            badgeLabel = `Due ₹${remInr}`;
        }

        html += `
            <div class="fee-daily-row" data-date="${sDate}" tabindex="0" role="button">
                <div>
                    <div class="fee-daily-date">${formatShortDate(sDate)}</div>
                    <div class="fee-daily-meta">${distKm} km driven • <span class="text-primary">${t('driver.view_calculation', 'View calculation')}</span></div>
                </div>
                <div class="fee-daily-right">
                    <span class="fee-daily-amount">₹${feeInr}</span>
                    <span class="${badgeClass}">${badgeLabel}</span>
                </div>
            </div>
        `;
    });
    list.innerHTML = html;

    list.querySelectorAll('.fee-daily-row').forEach(row => {
        row.addEventListener('click', () => {
            const d = row.getAttribute('data-date');
            if (d && d !== '--') openCalculationModal(d);
        });
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
function openHistoryModal() {
    if (!currentPaymentData) return;
    const history = currentPaymentData.history || [];

    if (fullHistoryList) {
        if (!history.length) {
            fullHistoryList.innerHTML = `<p class="text-center text-muted py-4">${t('driver.no_payment_records', 'No payment records found.')}</p>`;
        } else {
            fullHistoryList.innerHTML = history.map(item => {
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
        }
    }

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

