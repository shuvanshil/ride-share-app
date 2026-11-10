/**
 * passenger-fare-summary.js
 * Passenger Fare Summary Modal
 *
 * Displays an authoritative financial summary of a completed ride (base fare,
 * coupon discount, wallet credit applied, and final amount payable to the driver)
 * BEFORE transitioning to the feedback prompt.
 *
 * Compatible with web-PWA and Android Capacitor WebView.
 */

import { t } from '../shared/i18n.js';

let _activeRideId = null;
let _activeRideData = null;
let _onCloseCallback = null;
let _modalLayer = null;

function formatInr(val) {
    const num = Math.max(0, Number(val) || 0);
    return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getOrCreateModal() {
    if (_modalLayer && document.body.contains(_modalLayer)) return _modalLayer;
    _modalLayer = document.getElementById('passenger-fare-summary-view');
    if (!_modalLayer) {
        _modalLayer = document.createElement('div');
        _modalLayer.id = 'passenger-fare-summary-view';
        _modalLayer.className = 'modal-layer d-none';
        _modalLayer.setAttribute('aria-live', 'assertive');
        document.body.appendChild(_modalLayer);
    }
    return _modalLayer;
}

export function showFareSummaryModal(rideId, rideData, onCloseCallback) {
    if (!rideId) {
        onCloseCallback?.();
        return;
    }

    const shownKey = `liphtup_fare_summary_shown_${rideId}`;
    if (sessionStorage.getItem(shownKey) === 'true') {
        onCloseCallback?.();
        return;
    }

    _activeRideId = rideId;
    _activeRideData = rideData || {};
    _onCloseCallback = onCloseCallback;

    sessionStorage.setItem(shownKey, 'true');

    const modal = getOrCreateModal();
    renderFareSummary(modal, _activeRideData);
    modal.classList.remove('d-none');
}

export function closeFareSummaryModal() {
    if (_modalLayer) {
        _modalLayer.classList.add('d-none');
    }
    const cb = _onCloseCallback;
    _onCloseCallback = null;
    if (typeof cb === 'function') {
        cb();
    }
}

function renderFareSummary(container, ride) {
    // 1. Authoritative Total Trip Fare
    let totalFare = 0;
    if (ride.farePaise !== undefined && ride.farePaise !== null) {
        totalFare = Number(ride.farePaise) / 100;
    } else {
        totalFare = Number(ride.fare || 0);
    }

    // 2. Coupon Discount
    let couponDiscount = 0;
    if (ride.couponApplied?.discountAmount !== undefined && ride.couponApplied?.discountAmount !== null) {
        couponDiscount = Number(ride.couponApplied.discountAmount);
    } else if (ride.couponApplied?.discountPaise !== undefined && ride.couponApplied?.discountPaise !== null) {
        couponDiscount = Number(ride.couponApplied.discountPaise) / 100;
    } else if (ride.couponDiscountAmountPaise !== undefined && ride.couponDiscountAmountPaise !== null) {
        couponDiscount = Number(ride.couponDiscountAmountPaise) / 100;
    }

    // 3. Wallet Credit Applied
    let walletCredit = 0;
    if (ride.walletPaidAmountPaise !== undefined && ride.walletPaidAmountPaise !== null) {
        walletCredit = Number(ride.walletPaidAmountPaise) / 100;
    } else if (ride.wallet_paid_amount !== undefined && ride.wallet_paid_amount !== null) {
        walletCredit = Number(ride.wallet_paid_amount);
    }

    // 4. Authoritative Amount Payable to Driver
    let amountPayable = 0;
    if (ride.remainingFarePaise !== undefined && ride.remainingFarePaise !== null) {
        amountPayable = Number(ride.remainingFarePaise) / 100;
    } else if (ride.remaining_fare !== undefined && ride.remaining_fare !== null) {
        amountPayable = Number(ride.remaining_fare);
    } else {
        amountPayable = Math.max(0, totalFare - couponDiscount - walletCredit);
    }
    amountPayable = Math.max(0, amountPayable);

    // 5. Optional adjustment notes
    let adjustmentNote = "";
    if (ride.fare_adjustment?.note) {
        adjustmentNote = ride.fare_adjustment.note;
    }

    const payableIsZero = (amountPayable <= 0.001);

    container.innerHTML = `
        <div class="fb-card fare-summary-card" role="dialog" aria-modal="true" aria-label="${t('fare_summary.title', 'Trip Completed')}">
            <div class="fb-card-scroll">
                <div class="fb-header">
                    <span></span>
                    <button class="fb-close-btn" id="fare-summary-header-close-btn" type="button" aria-label="${t('common.close', 'Close')}">&times;</button>
                </div>

                <div class="fs-badge-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#1A7A2E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                </div>

                <h2 class="fs-title">${t('fare_summary.title', 'Trip Completed')}</h2>
                <p class="fs-subtitle">${t('fare_summary.subtitle', 'Your trip has ended. Here is your fare summary.')}</p>

                <!-- Prominently Highlighted Amount Payable Section -->
                <div class="fs-payable-box">
                    <div class="fs-payable-label">${t('fare_summary.amount_payable_to_driver', 'Amount to Pay the Driver')}</div>
                    <div class="fs-payable-amount">₹${formatInr(amountPayable)}</div>
                    ${payableIsZero ? `
                        <div class="fs-payable-settled-pill">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#15803D" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                            <span>${t('fare_summary.paid_digitally_note', 'Paid digitally — no cash required')}</span>
                        </div>
                    ` : ''}
                </div>

                <!-- Structured Fare Breakdown Section -->
                <div class="fs-breakdown-card">
                    <div class="fs-breakdown-title">${t('fare_summary.fare_breakdown', 'Fare Breakdown')}</div>
                    <div class="fs-breakdown-row">
                        <span class="fs-label">${t('fare_summary.total_trip_fare', 'Total Trip Fare')}</span>
                        <span class="fs-value">₹${formatInr(totalFare)}</span>
                    </div>
                    ${couponDiscount > 0 ? `
                        <div class="fs-breakdown-row fs-discount-row">
                            <span class="fs-label">${t('fare_summary.coupon_discount', 'Coupon Discount')}</span>
                            <span class="fs-value">−₹${formatInr(couponDiscount)}</span>
                        </div>
                    ` : ''}
                    ${walletCredit > 0 ? `
                        <div class="fs-breakdown-row fs-discount-row">
                            <span class="fs-label">${t('fare_summary.wallet_credit_used', 'Wallet Credit Used')}</span>
                            <span class="fs-value">−₹${formatInr(walletCredit)}</span>
                        </div>
                    ` : ''}
                    ${adjustmentNote ? `
                        <div class="fs-adjustment-note">
                            <small>${adjustmentNote}</small>
                        </div>
                    ` : ''}
                </div>

                <button class="fb-rate-btn fs-close-btn" id="fare-summary-action-btn" type="button">
                    ${t('fare_summary.close_btn', 'Close')}
                </button>
            </div>
        </div>
    `;

    container.querySelector('#fare-summary-header-close-btn')?.addEventListener('click', closeFareSummaryModal);
    container.querySelector('#fare-summary-action-btn')?.addEventListener('click', closeFareSummaryModal);

    // Backdrop click
    container.addEventListener('click', (e) => {
        if (e.target === container) {
            closeFareSummaryModal();
        }
    });
}

window.LiphtUpFareSummary = {
    showFareSummaryModal,
    closeFareSummaryModal
};
