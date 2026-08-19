/**
 * passenger-feedback.js
 * Passenger Ride Feedback & Rating System
 *
 * Renders a multi-step feedback UI after a ride is completed.
 * Compatible with both web-PWA and Android Capacitor WebView.
 *
 * API: window.LiphtUpFeedback = { schedulePrompt(rideId, rideData) }
 *
 * Steps:
 *   Step 1 – Thank you (injected into payment receipt card)
 *   Step 2 – Choose experience (Poor / Decent / Good / Loved it!)
 *   Step 3 – Select secondary reasons (up to 3)
 *   Step 4 – Loading / submitting
 *   Step 5 – Success confirmation
 *
 * Minimized state: thin floating banner over the map.
 * Dismissed state: banner closed, never shown again this session.
 */

import { auth } from '../platform/firebase-init.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPERIENCES = [
    {
        key: 'poor',
        label: 'Poor',
        icon: 'assets/icons/webicons/feedback-poor.svg',
        title: "We're sorry to hear that.",
        subtitle: 'What went wrong? (Select up to 3)',
        titleColor: '#E53E3E',
    },
    {
        key: 'decent',
        label: 'Decent',
        icon: 'assets/icons/webicons/feedback-decent.svg',
        title: "Thanks for the feedback!",
        subtitle: 'What could be better? (Select up to 3)',
        titleColor: '#D97706',
    },
    {
        key: 'good',
        label: 'Good',
        icon: 'assets/icons/webicons/feedback-good.svg',
        title: "Glad you had a good ride!",
        subtitle: 'What did you like? (Select up to 3)',
        titleColor: '#16A34A',
    },
    {
        key: 'loved',
        label: 'Loved it!',
        icon: 'assets/icons/webicons/feedback-loved.svg',
        title: "Awesome! Thanks for the love! 💚",
        subtitle: 'What made it great? (Select up to 3)',
        titleColor: '#1A7A2E',
    },
];

/** All valid reason keys per experience level — must match api/routers/rides.py */
const REASONS = {
    poor: [
        { key: 'driver_was_late',     label: 'Driver was late' },
        { key: 'driver_misbehaved',   label: 'Misbehaved' },
        { key: 'driver_was_rude',     label: 'Rude' },
        { key: 'unsafe_driving',      label: 'Unsafe driving' },
        { key: 'vehicle_issue',       label: 'Vehicle issue' },
        { key: 'bad_app_experience',  label: 'Bad app experience' },
        { key: 'app_glitches',        label: 'App glitches' },
        { key: 'payment_issue',       label: 'Payment issue' },
        { key: 'booking_problem',     label: 'Booking problem' },
        { key: 'other',              label: 'Other' },
    ],
    decent: [
        { key: 'driver_was_late',              label: 'Driver was late' },
        { key: 'long_waiting_time',            label: 'Long waiting time' },
        { key: 'vehicle_could_be_better',      label: 'Vehicle could be better' },
        { key: 'app_experience_could_improve', label: 'App could improve' },
        { key: 'booking_was_confusing',        label: 'Booking was confusing' },
        { key: 'payment_issue',                label: 'Payment issue' },
        { key: 'route_destination_issue',      label: 'Route/destination issue' },
        { key: 'other',                       label: 'Other' },
    ],
    good: [
        { key: 'friendly_driver',     label: 'Friendly driver' },
        { key: 'smooth_ride',         label: 'Smooth ride' },
        { key: 'quick_pickup',        label: 'Quick pickup' },
        { key: 'easy_booking',        label: 'Easy booking' },
        { key: 'good_vehicle',        label: 'Good vehicle' },
        { key: 'good_app_experience', label: 'Good app experience' },
        { key: 'fair_price',          label: 'Fair price' },
        { key: 'easy_payment',        label: 'Easy payment' },
    ],
    loved: [
        { key: 'excellent_driver',      label: 'Excellent driver' },
        { key: 'very_smooth_ride',      label: 'Very smooth ride' },
        { key: 'quick_pickup',          label: 'Quick pickup' },
        { key: 'great_vehicle',         label: 'Great vehicle' },
        { key: 'easy_booking',          label: 'Easy booking' },
        { key: 'great_app_experience',  label: 'Great app experience' },
        { key: 'fair_price',            label: 'Fair price' },
        { key: 'would_ride_again',      label: 'Would ride again' },
    ],
};

const MAX_REASONS = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _rideId = null;
let _rideData = {};
let _selectedExp = null;         // 'poor' | 'decent' | 'good' | 'loved'
let _selectedReasons = [];       // string[]
let _submitting = false;
let _feedbackSubmitted = false;
let _dismissed = false;          // permanently dismissed this session

// DOM refs (populated on first render)
let _modalLayer = null;
let _miniBanner = null;

// ---------------------------------------------------------------------------
// Public API (exposed on window.LiphtUpFeedback)
// ---------------------------------------------------------------------------

/**
 * Called after ride completion.  Shows the "Rate your experience" button
 * inside the payment receipt card.
 *
 * @param {string} rideId
 * @param {Object} rideData  — the full ride Firestore document object
 */
function schedulePrompt(rideId, rideData) {
    if (!rideId) return;

    // Already submitted feedback for this ride (checked via ride document)
    if (rideData?.feedback?.submitted === true) return;

    _rideId = rideId;
    _rideData = rideData || {};
    _selectedExp = null;
    _selectedReasons = [];
    _submitting = false;
    _feedbackSubmitted = false;
    _dismissed = false;

    // Directly open feedback modal starting at Step 1 (Thank You popup)
    _openFeedbackModal('step-thankyou');
}

// ---------------------------------------------------------------------------
// Minimized banner
// ---------------------------------------------------------------------------

function _getOrCreateMiniBanner() {
    if (_miniBanner) return _miniBanner;
    _miniBanner = document.getElementById('feedback-minimized-banner');
    return _miniBanner;
}

function _showMinimizedBanner() {
    if (_feedbackSubmitted || _dismissed) return;
    const banner = _getOrCreateMiniBanner();
    if (!banner) return;
    banner.classList.remove('d-none');
}

function _hideMinimizedBanner() {
    const banner = _getOrCreateMiniBanner();
    if (banner) banner.classList.add('d-none');
}

function _initMiniBannerEvents() {
    const banner = _getOrCreateMiniBanner();
    if (!banner || banner.dataset.fbEventsInit) return;
    banner.dataset.fbEventsInit = '1';

    // Clicking the banner body reopens feedback at experience or reasons step
    banner.addEventListener('click', (e) => {
        if (e.target.closest('.fb-minimized-close')) return; // handled below
        _hideMinimizedBanner();
        _openFeedbackModal(_selectedExp ? 'step-reasons' : 'step-exp');
    });

    // The small × inside the banner permanently dismisses it this session
    const closeBtn = banner.querySelector('.fb-minimized-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _dismissed = true;
            _hideMinimizedBanner();
        });
    }
}

// ---------------------------------------------------------------------------
// Feedback modal
// ---------------------------------------------------------------------------

function _getOrCreateModal() {
    if (_modalLayer && document.body.contains(_modalLayer)) return _modalLayer;
    _modalLayer = document.getElementById('passenger-payment-view') || document.getElementById('feedback-modal-layer');
    return _modalLayer;
}

function _openFeedbackModal(startStep) {
    if (_feedbackSubmitted) return;
    const modal = _getOrCreateModal();
    if (!modal) return;

    _renderModal(modal, startStep || 'step-thankyou');
    modal.classList.remove('d-none');
    // Trap focus inside modal for accessibility
    _trapFocus(modal);
}

function _closeFeedbackModal() {
    const modal = _getOrCreateModal();
    if (modal) modal.classList.add('d-none');
    _releaseFocus();
}

function _renderModal(modal, step) {
    modal.innerHTML = `
        <div class="fb-card" role="dialog" aria-modal="true" aria-label="Ride feedback">
            <div class="fb-card-scroll">

                <!-- Step 1: Thank you popup (Screen 1 in mockup) -->
                <div id="fb-step-thankyou" class="fb-step${step === 'step-thankyou' ? ' fb-active' : ''}">
                    <div class="fb-header">
                        <button class="fb-back-btn d-invisible" type="button" aria-label="Back">&#8592;</button>
                        <button class="fb-close-btn" id="fb-close-thankyou" type="button" aria-label="Close feedback">&times;</button>
                    </div>
                    <img src="assets/icons/webicons/feedback-thankyou-illustration.svg"
                         class="fb-illustration" alt="" aria-hidden="true" width="96" height="96" style="width:96px;height:96px;margin-bottom:16px;">
                    <h2 class="fb-title" style="font-size:20px;font-weight:800;margin-bottom:8px;">Thank you<br>for riding with us! 💚</h2>
                    <p class="fb-subtitle" style="font-size:13px;color:var(--gy-muted);margin-bottom:24px;line-height:1.4;">We hope you had a great ride.<br>Please share your experience.</p>
                    <button class="fb-rate-btn" id="fb-thankyou-rate-btn" type="button">Rate your experience</button>
                    <button class="fb-maybe-later-btn" id="fb-thankyou-later-btn" type="button">Maybe later</button>
                </div>

                <!-- Step 2: Choose experience (Screen 2 in mockup) -->
                <div id="fb-step-exp" class="fb-step${step === 'step-exp' ? ' fb-active' : ''}">
                    <div class="fb-header">
                        <button class="fb-back-btn" id="fb-back-exp" type="button" aria-label="Back">&#8592;</button>
                        <button class="fb-close-btn" id="fb-close-exp" type="button" aria-label="Close feedback">&times;</button>
                    </div>
                    <img src="assets/icons/webicons/feedback-loved.svg" class="fb-illustration" alt="" aria-hidden="true">
                    <h2 class="fb-title">How was your experience?</h2>
                    <p class="fb-subtitle">Please select one option</p>
                    <div class="fb-exp-grid" id="fb-exp-grid">
                        ${EXPERIENCES.map(exp => `
                            <button class="fb-exp-chip" data-exp="${exp.key}" type="button" aria-label="${exp.label}">
                                <img src="${exp.icon}" alt="${exp.label}" width="44" height="44">
                                <span>${exp.label}</span>
                            </button>
                        `).join('')}
                    </div>
                    <p id="fb-exp-validation" class="fb-validation-msg" aria-live="polite"></p>
                    <div class="fb-anon-note">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#1A7A2E" opacity="0.2"/>
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#1A7A2E" stroke-width="2" fill="none"/>
                            <path d="M9 12l2 2 4-4" stroke="#1A7A2E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>Your feedback is anonymous and helps us improve LightUp.</span>
                    </div>
                </div>

                <!-- Step: Select reasons -->
                <div id="fb-step-reasons" class="fb-step${step === 'step-reasons' ? ' fb-active' : ''}">
                    <div class="fb-header">
                        <button class="fb-back-btn" id="fb-back-reasons" type="button" aria-label="Back">&#8592;</button>
                        <button class="fb-close-btn" id="fb-close-reasons" type="button" aria-label="Close feedback">&times;</button>
                    </div>
                    <div id="fb-reasons-exp-icon" style="margin:0 auto 12px;width:56px;height:56px;display:block;"></div>
                    <h2 class="fb-reasons-title" id="fb-reasons-title" style="text-align:center;width:100%;"></h2>
                    <p class="fb-reasons-subtitle" id="fb-reasons-subtitle" style="text-align:center;width:100%;"></p>
                    <p class="fb-count-label" id="fb-count-label" aria-live="polite">0 of ${MAX_REASONS} selected</p>
                    <div class="fb-reasons-grid" id="fb-reasons-grid"></div>
                    <p id="fb-reasons-validation" class="fb-validation-msg" aria-live="polite"></p>
                    <button class="fb-submit-btn" id="fb-submit-btn" type="button">Submit Feedback</button>
                </div>

                <!-- Step: Loading -->
                <div id="fb-step-loading" class="fb-step${step === 'step-loading' ? ' fb-active' : ''}">
                    <div class="fb-header">
                        <button class="fb-back-btn d-invisible" type="button" aria-label="Back">&#8592;</button>
                        <span></span>
                    </div>
                    <div class="fb-loading-wrap">
                        <img src="assets/icons/webicons/feedback-submit-illustration.svg"
                             class="fb-illustration fb-illustration-spin"
                             alt="" aria-hidden="true" width="88" height="88">
                        <h2 class="fb-title">Submitting your feedback...</h2>
                        <p class="fb-subtitle">Please wait a moment.</p>
                        <p style="font-size:11px;color:var(--gy-muted);display:flex;align-items:center;gap:6px;margin:8px 0 0;">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="#1A7A2E" aria-hidden="true">
                                <rect x="3" y="11" width="18" height="10" rx="2" stroke="#1A7A2E" stroke-width="2" fill="none"/>
                                <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="#1A7A2E" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            This will only take a few seconds.
                        </p>
                    </div>
                </div>

                <!-- Step: Success -->
                <div id="fb-step-success" class="fb-step${step === 'step-success' ? ' fb-active' : ''}">
                    <div class="fb-header">
                        <button class="fb-back-btn d-invisible" type="button" aria-label="Back">&#8592;</button>
                        <span></span>
                    </div>
                    <div class="fb-success-wrap">
                        <img src="assets/icons/webicons/feedback-success-illustration.svg"

                             class="fb-illustration"
                             alt="" aria-hidden="true" width="88" height="88">
                        <h2 class="fb-success-title">Thanks for your feedback! 💚</h2>
                        <p class="fb-success-sub">You're helping us improve LightUp for everyone.</p>
                        <button class="fb-done-btn" id="fb-done-btn" type="button">Done</button>
                    </div>
                </div>

            </div>
        </div>
    `;

    _bindModalEvents(modal);
    // If we're jumping straight to reasons (re-open from minimized after selection)
    if (step === 'step-reasons' && _selectedExp) {
        _renderReasonsStep(modal);
    } else if (step === 'step-exp' && _selectedExp) {
        // Pre-highlight the previously selected chip
        _highlightExpChip(modal, _selectedExp);
    }
}

function _goToStep(modal, stepId) {
    modal.querySelectorAll('.fb-step').forEach(s => s.classList.remove('fb-active'));
    const target = modal.querySelector(`#fb-${stepId}`);
    if (target) target.classList.add('fb-active');
}

function _bindModalEvents(modal) {
    // Step 1 (Thank You) buttons
    modal.querySelector('#fb-close-thankyou')?.addEventListener('click', () => {
        _closeFeedbackModal();
        _showMinimizedBanner();
    });
    modal.querySelector('#fb-thankyou-rate-btn')?.addEventListener('click', () => {
        _goToStep(modal, 'step-exp');
    });
    modal.querySelector('#fb-thankyou-later-btn')?.addEventListener('click', () => {
        _closeFeedbackModal();
        _showMinimizedBanner();
    });

    // Step 2 (Choose Experience) buttons
    modal.querySelector('#fb-close-exp')?.addEventListener('click', () => {
        _closeFeedbackModal();
        _showMinimizedBanner();
    });
    modal.querySelector('#fb-back-exp')?.addEventListener('click', () => {
        _goToStep(modal, 'step-thankyou');
    });

    // Step 3 (Select Reasons) buttons
    modal.querySelector('#fb-close-reasons')?.addEventListener('click', () => {
        _closeFeedbackModal();
        _showMinimizedBanner();
    });
    modal.querySelector('#fb-back-reasons')?.addEventListener('click', () => {
        _goToStep(modal, 'step-exp');
    });

    // Experience chip selection
    modal.querySelectorAll('.fb-exp-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const exp = chip.dataset.exp;
            if (_selectedExp === exp) {
                // Toggle off
                _selectedExp = null;
                chip.classList.remove('fb-selected');
            } else {
                _selectedExp = exp;
                _selectedReasons = [];
                _highlightExpChip(modal, exp);
                // Brief delay then go to reasons
                setTimeout(() => {
                    _renderReasonsStep(modal);
                    _goToStep(modal, 'step-reasons');
                }, 120);
            }
            // Clear validation
            const v = modal.querySelector('#fb-exp-validation');
            if (v) v.textContent = '';
        });
    });

    // Backdrop click → close + minimize
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            _closeFeedbackModal();
            _showMinimizedBanner();
        }
    });

    // Submit button
    modal.querySelector('#fb-submit-btn')?.addEventListener('click', () => _handleSubmit(modal));

    // Done button (after success)
    modal.querySelector('#fb-done-btn')?.addEventListener('click', () => {
        _feedbackSubmitted = true;
        _closeFeedbackModal();
        _hideMinimizedBanner();
        // Restore the "Book Again" button and reload
        const existingBtn = document.getElementById('close-passenger-payment-btn');
        if (existingBtn) existingBtn.style.display = '';
        // Trigger page reload to clear completed ride state
        setTimeout(() => window.location.reload(), 300);
    });
}

function _highlightExpChip(modal, expKey) {
    modal.querySelectorAll('.fb-exp-chip').forEach(c => {
        c.classList.toggle('fb-selected', c.dataset.exp === expKey);
    });
}

function _renderReasonsStep(modal) {
    if (!_selectedExp) return;
    const exp = EXPERIENCES.find(e => e.key === _selectedExp);
    if (!exp) return;

    // Update icon
    const iconEl = modal.querySelector('#fb-reasons-exp-icon');
    if (iconEl) iconEl.innerHTML = `<img src="${exp.icon}" alt="${exp.label}" width="56" height="56" style="width:56px;height:56px;">`;

    // Update title / subtitle
    const titleEl = modal.querySelector('#fb-reasons-title');
    if (titleEl) { titleEl.textContent = exp.title; titleEl.style.color = exp.titleColor; }
    const subEl = modal.querySelector('#fb-reasons-subtitle');
    if (subEl) subEl.textContent = exp.subtitle;

    // Render reason chips
    const grid = modal.querySelector('#fb-reasons-grid');
    if (grid) {
        const reasons = REASONS[_selectedExp] || [];
        grid.innerHTML = reasons.map(r => {
            const sel = _selectedReasons.includes(r.key);
            const disabled = !sel && _selectedReasons.length >= MAX_REASONS;
            return `<button
                class="fb-reason-chip${sel ? ' fb-selected' : ''}${disabled ? ' fb-disabled' : ''}"
                data-reason="${r.key}"
                type="button"
                aria-pressed="${sel}"
                ${disabled ? 'tabindex="-1"' : ''}
            >${r.label}</button>`;
        }).join('');

        grid.querySelectorAll('.fb-reason-chip').forEach(chip => {
            chip.addEventListener('click', () => _toggleReason(modal, chip.dataset.reason));
        });
    }
    _updateCountLabel(modal);
}

function _toggleReason(modal, reasonKey) {
    const idx = _selectedReasons.indexOf(reasonKey);
    if (idx > -1) {
        _selectedReasons.splice(idx, 1);
    } else {
        if (_selectedReasons.length >= MAX_REASONS) return;
        _selectedReasons.push(reasonKey);
    }
    _renderReasonsStep(modal);
    _goToStep(modal, 'step-reasons');
}

function _updateCountLabel(modal) {
    const label = modal.querySelector('#fb-count-label');
    if (!label) return;
    const count = _selectedReasons.length;
    label.textContent = `${count} of ${MAX_REASONS} selected`;
    label.classList.toggle('fb-maxed', count >= MAX_REASONS);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function _handleSubmit(modal) {
    if (_submitting) return;

    // Require a primary experience
    if (!_selectedExp) {
        const v = modal.querySelector('#fb-reasons-validation') || modal.querySelector('#fb-exp-validation');
        if (v) {
            v.textContent = 'Please select an experience first.';
            setTimeout(() => { if (v) v.textContent = ''; }, 3000);
        }
        return;
    }

    _submitting = true;
    _goToStep(modal, 'step-loading');

    try {
        const user = auth.currentUser;
        if (!user) throw new Error('Please sign in to submit feedback.');
        const idToken = await user.getIdToken();

        const response = await fetch(`/api/rides/${encodeURIComponent(_rideId)}/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                experience: _selectedExp,
                reasons: _selectedReasons,
            }),
        });

        if (response.status === 409) {
            // Already submitted — treat as success silently
            _feedbackSubmitted = true;
            _goToStep(modal, 'step-success');
            return;
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `Submission failed (${response.status}).`);
        }

        _feedbackSubmitted = true;
        _goToStep(modal, 'step-success');

    } catch (err) {
        console.error('[feedback] submit error:', err);
        _submitting = false;
        // Go back to reasons step and show error
        _goToStep(modal, 'step-reasons');
        _renderReasonsStep(modal);
        const v = modal.querySelector('#fb-reasons-validation');
        if (v) {
            v.textContent = err.message || 'Could not submit. Please try again.';
            setTimeout(() => { if (v) v.textContent = ''; }, 5000);
        }
    }
}

// ---------------------------------------------------------------------------
// Focus trap (accessibility + Android back-button safety)
// ---------------------------------------------------------------------------

let _prevFocused = null;
const FOCUSABLE = 'a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])';

function _trapFocus(container) {
    _prevFocused = document.activeElement;
    const focusable = container.querySelectorAll(FOCUSABLE);
    if (focusable.length) focusable[0].focus();

    container._fbKeydownHandler = (e) => {
        if (e.key !== 'Tab') return;
        const els = [...container.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.offsetParent !== null);
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', container._fbKeydownHandler);

    // Android Capacitor hardware back-button: treat as "close + minimize"
    container._fbBackButtonHandler = (e) => {
        if (e.key === 'Escape' || (window.LIPHTUP_IS_NATIVE && e.type === 'backbutton')) {
            _closeFeedbackModal();
            _showMinimizedBanner();
        }
    };
    document.addEventListener('keydown', container._fbBackButtonHandler);
}

function _releaseFocus() {
    const modal = _getOrCreateModal();
    if (modal?._fbKeydownHandler) {
        document.removeEventListener('keydown', modal._fbKeydownHandler);
        delete modal._fbKeydownHandler;
    }
    if (modal?._fbBackButtonHandler) {
        document.removeEventListener('keydown', modal._fbBackButtonHandler);
        delete modal._fbBackButtonHandler;
    }
    if (_prevFocused && typeof _prevFocused.focus === 'function') {
        _prevFocused.focus();
        _prevFocused = null;
    }
}

// ---------------------------------------------------------------------------
// Initialise minimized banner events once DOM is ready
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initMiniBannerEvents);
} else {
    _initMiniBannerEvents();
}

window.LiphtUpFeedback = { schedulePrompt };
export { schedulePrompt };
