/**
 * driver-payment-reminder.js
 *
 * Driver Weekly Payment Reminder Modal System for LiphtUp (Web and Capacitor Android).
 * Displays overdue weekly payment reminder and payment decline notices with 4-hour snooze,
 * priority management (declined > overdue), translation support (i18n), and deduplication.
 */

import { waitForAuth, getAuthToken } from '../shared/auth.js';
import { t } from '../shared/i18n.js';

const SNOOZE_STORAGE_KEY = 'liphtup_driver_payment_snooze';
const OVERLAY_ID = 'payment-reminder-modal-overlay';
const STYLES_ID = 'payment-reminder-injected-styles';

class PaymentReminderManager {
    constructor() {
        this.overlayEl = null;
        this.activeType = null;
        this.isChecking = false;
        this.lastCheckedAt = 0;
        this.snoozeTimerId = null;
        this.lifecycleBound = false;
        this.currentUser = null;
    }

    /**
     * Initializes the reminder system for an authenticated driver.
     * @param {Object} user Firebase Auth user instance
     */
    init(user) {
        if (!user) return;
        this.currentUser = user;

        this.injectStyles();
        this.bindLifecycleEvents();

        // Perform initial check
        this.check(user);
    }

    /**
     * Injects scoped styles for the payment reminder modals.
     */
    injectStyles() {
        if (document.getElementById(STYLES_ID)) return;
        const style = document.createElement('style');
        style.id = STYLES_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed;
                inset: 0;
                z-index: 99998;
                background: rgba(15, 23, 42, 0.65);
                backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                opacity: 0;
                transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            }
            #${OVERLAY_ID}.pr-visible {
                opacity: 1;
            }
            .pr-modal-card {
                background: #FFFFFF;
                border-radius: 28px;
                width: 100%;
                max-width: 410px;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
                overflow: hidden;
                position: relative;
                transform: scale(0.92);
                transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            #${OVERLAY_ID}.pr-visible .pr-modal-card {
                transform: scale(1);
            }
            .pr-close-btn {
                position: absolute;
                top: 14px;
                right: 14px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                background: #E2E8F0;
                border: none;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                z-index: 10;
                padding: 0;
                color: #475569;
                transition: background 0.15s ease, transform 0.15s ease;
            }
            .pr-close-btn:hover, .pr-close-btn:active {
                background: #CBD5E1;
                transform: scale(1.05);
            }
            .pr-illustration-wrap {
                width: 100%;
                position: relative;
                background: #ECFDF5;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .pr-illustration-img {
                width: 100%;
                height: auto;
                max-height: 220px;
                object-fit: cover;
                display: block;
            }
            .pr-declined-header-svg {
                width: 100%;
                height: 180px;
                display: block;
            }
            .pr-body {
                padding: 22px 24px 26px 24px;
                text-align: center;
            }
            .pr-title {
                font-size: 1.25rem;
                font-weight: 800;
                color: #0F172A;
                line-height: 1.35;
                margin: 0 0 12px 0;
            }
            .pr-notice {
                font-size: 0.90rem;
                font-weight: 400;
                color: #475569;
                line-height: 1.55;
                margin: 0 0 20px 0;
            }
            .pr-reason-box {
                background: #FEF2F2;
                border: 1px solid #FECACA;
                border-left: 4px solid #DC2626;
                border-radius: 8px;
                padding: 10px 14px;
                text-align: left;
                font-size: 0.84rem;
                color: #991B1B;
                margin-bottom: 20px;
                line-height: 1.45;
            }
            .pr-actions-row {
                display: flex;
                gap: 12px;
                align-items: center;
                justify-content: center;
                width: 100%;
            }
            .pr-btn {
                flex: 1;
                padding: 12px 16px;
                border-radius: 9999px;
                font-size: 0.92rem;
                font-weight: 700;
                cursor: pointer;
                transition: transform 0.12s ease, background 0.15s ease, opacity 0.15s ease;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                text-decoration: none;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .pr-btn:active {
                transform: scale(0.97);
            }
            .pr-btn-outline {
                background: #FFFFFF;
                border: 1.5px solid #22C55E;
                color: #16A34A;
            }
            .pr-btn-outline:hover {
                background: #F0FDF4;
            }
            .pr-btn-primary {
                background: #166534;
                border: 1.5px solid #166534;
                color: #FFFFFF;
                box-shadow: 0 4px 12px rgba(22, 101, 52, 0.25);
            }
            .pr-btn-primary:hover {
                background: #14532D;
                border-color: #14532D;
                color: #FFFFFF;
            }
            .pr-btn-declined-primary {
                background: #DC2626;
                border: 1.5px solid #DC2626;
                color: #FFFFFF;
                box-shadow: 0 4px 12px rgba(220, 38, 38, 0.25);
            }
            .pr-btn-declined-primary:hover {
                background: #B91C1C;
                border-color: #B91C1C;
                color: #FFFFFF;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Binds window focus, document visibility, and Capacitor native app lifecycle listeners.
     */
    bindLifecycleEvents() {
        if (this.lifecycleBound) return;
        this.lifecycleBound = true;

        // Visibility change (switching tabs or unlocking phone)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.check(this.currentUser);
            }
        });

        // Window focus
        window.addEventListener('focus', () => {
            this.check(this.currentUser);
        });

        // Capacitor Android App lifecycle state listener
        try {
            const Cap = window.Capacitor;
            if (Cap && Cap.Plugins && Cap.Plugins.App && typeof Cap.Plugins.App.addListener === 'function') {
                Cap.Plugins.App.addListener('appStateChange', (state) => {
                    if (state && state.isActive) {
                        this.check(this.currentUser);
                    }
                });
            }
        } catch (e) {
            console.warn('[payment-reminder] Capacitor appStateChange registration skipped:', e);
        }
    }

    /**
     * Checks payment status and displays reminder modal if eligible.
     * @param {Object} user Authenticated user object
     * @param {boolean} force If true, bypasses throttle check
     */
    async check(user = this.currentUser, force = false) {
        if (!user) {
            user = await waitForAuth();
        }
        if (!user) return;
        this.currentUser = user;

        // Never show reminders while user is already on driver-payments page
        if (this.isPaymentsPage()) {
            this.hideModal();
            return;
        }

        // Throttle check to avoid redundant requests within 10 seconds unless forced
        const now = Date.now();
        if (!force && this.isChecking) return;
        if (!force && now - this.lastCheckedAt < 10000) return;

        this.isChecking = true;
        this.lastCheckedAt = now;

        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch('/api/account/driver-payments/status', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) return;
            const data = await response.json();
            const reminder = data.reminder;

            if (!reminder) return;

            // Evaluate eligibility
            if (reminder.eligible && reminder.type) {
                // If local snooze is still active, verify with authoritative server state
                if (this.isLocallySnoozed(reminder.type) && reminder.isSnoozed) {
                    this.hideModal();
                    return;
                }
                this.showModal(reminder);
            } else {
                // If modal is open but driver is no longer eligible (e.g. paid, verified, under review), hide it
                this.hideModal();

                // If snooze is active on server, schedule timer to wake up when snooze expires
                if (reminder.isSnoozed && reminder.snoozedUntil) {
                    this.scheduleSnoozeTimer(reminder.snoozedUntil);
                }
            }
        } catch (err) {
            console.warn('[payment-reminder] check error:', err);
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Helper to detect if currently on driver-payments.html.
     */
    isPaymentsPage() {
        const path = window.location.pathname.toLowerCase();
        return path.includes('driver-payments') || (window.isCurrentPage && window.isCurrentPage('driver-payments.html'));
    }

    /**
     * Checks local storage snooze cache.
     */
    isLocallySnoozed(type) {
        try {
            const cached = JSON.parse(localStorage.getItem(SNOOZE_STORAGE_KEY) || '{}');
            const key = type === 'declined' ? 'declinedUntil' : 'overdueUntil';
            const until = cached[key];
            if (until && Date.now() < Number(until)) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    /**
     * Sets local storage snooze timestamp.
     */
    setLocalSnooze(type, snoozeUntilMs) {
        try {
            const cached = JSON.parse(localStorage.getItem(SNOOZE_STORAGE_KEY) || '{}');
            if (type === 'declined') {
                cached.declinedUntil = snoozeUntilMs;
            } else {
                cached.overdueUntil = snoozeUntilMs;
            }
            cached.snoozedAt = Date.now();
            localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(cached));
        } catch (e) {}
    }

    /**
     * Schedules a timer to re-check when snooze duration elapses while app stays open.
     */
    scheduleSnoozeTimer(snoozedUntilStr) {
        if (this.snoozeTimerId) {
            clearTimeout(this.snoozeTimerId);
            this.snoozeTimerId = null;
        }

        try {
            const targetMs = new Date(snoozedUntilStr).getTime();
            const delay = Math.max(5000, targetMs - Date.now());
            // Cap to 24 hours max
            if (delay > 0 && delay <= 24 * 60 * 60 * 1000) {
                this.snoozeTimerId = setTimeout(() => {
                    this.check(this.currentUser, true);
                }, delay + 1000);
            }
        } catch (e) {}
    }

    /**
     * Renders and displays the modal.
     */
    showModal(reminder) {
        const type = reminder.type; // 'overdue' or 'declined'

        // If modal already open with the same notice type, do not duplicate
        if (this.overlayEl && this.activeType === type) {
            return;
        }

        // If open with different notice type, close first
        this.hideModal();

        this.injectStyles();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const isDeclined = type === 'declined';
        this.activeType = type;

        // Texts with translation support and defaults
        const overdueTitle = t('payment_reminder.overdue_title', "A Friendly Reminder About Your Weekly Service Payment");
        const overdueNotice = t('payment_reminder.overdue_notice', "Dear Driver, your service payment for this week is still pending. Your contribution helps us maintain and improve LiphtUp so we can continue serving you and our passengers. Whenever convenient, please complete your payment. Thank you for being a valued part of LiphtUp!");

        const declinedTitle = t('payment_reminder.declined_title', "Action Needed for Your Service Payment");
        const declinedNotice = t('payment_reminder.declined_notice', "Dear Driver, your recent service payment could not be approved. Please visit your payment page to review its current status and any feedback provided by our team. You can then make the necessary corrections and submit your payment again. Thank you for your patience and understanding.");

        const remindLaterText = t('payment_reminder.remind_later', "Remind me later");
        const payNowText = t('payment_reminder.pay_now', "Pay now");
        const reviewPaymentText = t('payment_reminder.review_payment', "Review payment");

        const titleText = isDeclined ? declinedTitle : overdueTitle;
        const noticeText = isDeclined ? declinedNotice : overdueNotice;
        const primaryText = isDeclined ? reviewPaymentText : payNowText;
        const primaryBtnClass = isDeclined ? 'pr-btn-declined-primary' : 'pr-btn-primary';

        // Illustration header
        let illustrationHtml = '';
        if (isDeclined) {
            // Action needed declined alert graphic
            illustrationHtml = `
                <div class="pr-illustration-wrap" style="background: linear-gradient(180deg, #FEF2F2 0%, #FFFFFF 100%); padding: 24px 0 10px 0;">
                    <svg class="pr-declined-header-svg" viewBox="0 0 240 140" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <!-- Soft background halo -->
                        <circle cx="120" cy="70" r="56" fill="#FEE2E2" opacity="0.7"/>
                        <circle cx="120" cy="70" r="42" fill="#FECACA" opacity="0.8"/>
                        <!-- Main Card -->
                        <rect x="70" y="32" width="100" height="74" rx="14" fill="#FFFFFF" stroke="#F87171" stroke-width="2.5" filter="drop-shadow(0 6px 12px rgba(220,38,38,0.12))"/>
                        <!-- Rupee Symbol -->
                        <text x="120" y="76" font-family="'Inter', sans-serif" font-size="28" font-weight="800" fill="#DC2626" text-anchor="middle" dominant-baseline="central">₹</text>
                        <!-- Action Badge / Alert Exclamation -->
                        <circle cx="156" cy="42" r="16" fill="#DC2626" stroke="#FFFFFF" stroke-width="2.5"/>
                        <path d="M156 34V44M156 48V50" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>
                    </svg>
                </div>
            `;
        } else {
            // Friendly driver thumbs up with calendar illustration matching mockup
            const assetSrc = window.getPlatformUrl ? window.getPlatformUrl('assets/branding/payment-reminder-illustration.png') : 'assets/branding/payment-reminder-illustration.png';
            illustrationHtml = `
                <div class="pr-illustration-wrap">
                    <img src="${assetSrc}" alt="Weekly Service Payment Reminder" class="pr-illustration-img">
                </div>
            `;
        }

        // Reason box if declineReason is present
        let reasonHtml = '';
        if (isDeclined && reminder.declineReason) {
            const sanitizedReason = this.escapeHtml(reminder.declineReason);
            const prefix = t('payment_reminder.feedback_reason', "Reason: {reason}").replace('{reason}', sanitizedReason);
            reasonHtml = `<div class="pr-reason-box"><strong>${prefix}</strong></div>`;
        }

        overlay.innerHTML = `
            <div class="pr-modal-card">
                <button type="button" class="pr-close-btn" id="pr-modal-close-btn" aria-label="Close">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
                ${illustrationHtml}
                <div class="pr-body">
                    <h3 class="pr-title">${this.escapeHtml(titleText)}</h3>
                    <p class="pr-notice">${this.escapeHtml(noticeText)}</p>
                    ${reasonHtml}
                    <div class="pr-actions-row">
                        <button type="button" class="pr-btn pr-btn-outline" id="pr-remind-later-btn">
                            ${this.escapeHtml(remindLaterText)}
                        </button>
                        <button type="button" class="pr-btn ${primaryBtnClass}" id="pr-pay-now-btn">
                            <span>${this.escapeHtml(primaryText)}</span>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M5 12h14M12 5l7 7-7 7"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        this.overlayEl = overlay;

        // Force reflow for smooth animation
        overlay.offsetHeight;
        overlay.classList.add('pr-visible');

        // Close button click -> snooze
        overlay.querySelector('#pr-modal-close-btn')?.addEventListener('click', () => {
            this.handleSnooze(type);
        });

        // "Remind me later" button click -> snooze
        overlay.querySelector('#pr-remind-later-btn')?.addEventListener('click', () => {
            this.handleSnooze(type);
        });

        // "Pay now" / "Review payment" button click -> navigate to driver-payments.html
        overlay.querySelector('#pr-pay-now-btn')?.addEventListener('click', () => {
            this.handlePayNow();
        });
    }

    /**
     * Handles driver tapping "Remind me later" or closing the modal.
     * Postpones the reminder for 4 hours both locally and on the server.
     */
    async handleSnooze(type) {
        this.hideModal();

        const fourHoursMs = 4 * 60 * 60 * 1000;
        const snoozeUntilMs = Date.now() + fourHoursMs;

        // 1. Immediately cache locally
        this.setLocalSnooze(type, snoozeUntilMs);

        // 2. Set timer in memory
        this.scheduleSnoozeTimer(new Date(snoozeUntilMs).toISOString());

        // 3. Persist to authoritative backend
        try {
            const token = await getAuthToken();
            if (token) {
                await fetch('/api/account/driver-payments/reminder/snooze', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                        body: JSON.stringify({
                            reminderType: type,
                            snoozeHours: 4.0
                        })
                    });
                }
            }
        } catch (err) {
            console.warn('[payment-reminder] snooze persistence error:', err);
        }
    }

    /**
     * Handles driver tapping "Pay now" / "Review payment".
     * Closes the modal and navigates to driver-payments.html using platform routing.
     */
    handlePayNow() {
        this.hideModal();

        if (typeof window.navigateToPage === 'function') {
            window.navigateToPage('driver-payments.html');
        } else {
            const dest = window.getPlatformUrl ? window.getPlatformUrl('driver-payments.html') : '/driver-payments.html';
            window.location.href = dest;
        }
    }

    /**
     * Hides and removes the current modal from the DOM.
     */
    hideModal() {
        if (this.overlayEl) {
            this.overlayEl.classList.remove('pr-visible');
            const el = this.overlayEl;
            this.overlayEl = null;
            this.activeType = null;
            setTimeout(() => {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            }, 250);
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

// Global Singleton Instance
export const paymentReminderManager = new PaymentReminderManager();
if (typeof window !== 'undefined') {
    window.LiphtUpPaymentReminder = paymentReminderManager;
}
