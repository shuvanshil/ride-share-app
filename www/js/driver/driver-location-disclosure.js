/**
 * LiphtUp Driver Location & Background Tracking Prominent Disclosure
 *
 * Compliant with Google Play Location & Background Location Policy:
 * 1. Prominent in-app disclosure displayed prior to runtime permission/tracking.
 * 2. Clear statement that location data is collected in the background / when app is minimized.
 * 3. Specific ride-sharing use cases: live passenger vehicle tracking, ETA calculation, and continuous navigation.
 * 4. Combined with Android battery optimization exemption explanation.
 * 5. Affirmative Allow and Deny actions.
 */

import { isBatteryOptimizationIgnored, requestIgnoreBatteryOptimizations } from '../platform/geolocation.js';

const DISCLOSURE_KEY = "liphtup_driver_location_disclosure_accepted";
const DISCLOSURE_TIMESTAMP_KEY = "liphtup_driver_location_disclosure_at";
const STYLES_ID = "liphtup-driver-location-disclosure-styles";

let activeModalEl = null;

function ensureDisclosureStyles() {
    if (document.getElementById(STYLES_ID)) return;

    const style = document.createElement("style");
    style.id = STYLES_ID;
    style.textContent = `
        .lup-disc-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.72);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            z-index: 1000000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            box-sizing: border-box;
            animation: lupDiscFadeIn 0.22s ease-out forwards;
        }
        @keyframes lupDiscFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        .lup-disc-card {
            background: #ffffff;
            border-radius: 24px;
            width: 100%;
            max-width: 440px;
            max-height: 90vh;
            overflow-y: auto;
            padding: 28px 24px 24px 24px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
            position: relative;
            text-align: left;
            box-sizing: border-box;
            transform: scale(0.96);
            animation: lupDiscPopIn 0.22s ease-out forwards;
        }
        @keyframes lupDiscPopIn {
            from { transform: scale(0.92); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }
        .lup-disc-header {
            text-align: center;
            margin-bottom: 20px;
        }
        .lup-disc-icon-badge {
            width: 72px;
            height: 72px;
            border-radius: 50%;
            background: #e8f5e9;
            margin: 0 auto 14px auto;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 0 6px #f1f8f3;
        }
        .lup-disc-title {
            font-size: 20px;
            font-weight: 700;
            color: #0f172a;
            margin: 0 0 4px 0;
            line-height: 1.3;
            letter-spacing: -0.01em;
        }
        .lup-disc-subtitle {
            font-size: 13px;
            color: #64748b;
            margin: 0;
            font-weight: 500;
        }
        .lup-disc-notice-box {
            background: #f0fdf4;
            border: 1.5px solid #bbf7d0;
            border-radius: 14px;
            padding: 14px 16px;
            margin-bottom: 18px;
        }
        .lup-disc-notice-quote {
            font-size: 13.5px;
            font-weight: 600;
            color: #166534;
            line-height: 1.5;
            margin: 0;
        }
        .lup-disc-features-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 20px;
        }
        .lup-disc-feature-item {
            display: flex;
            align-items: flex-start;
            gap: 12px;
        }
        .lup-disc-feature-icon {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-top: 2px;
        }
        .lup-disc-feature-icon.icon-location {
            background: #dcfce7;
            color: #16a34a;
        }
        .lup-disc-feature-icon.icon-navigation {
            background: #e0f2fe;
            color: #0284c7;
        }
        .lup-disc-feature-icon.icon-battery {
            background: #fef3c7;
            color: #d97706;
        }
        .lup-disc-feature-content {
            flex: 1;
        }
        .lup-disc-feature-title {
            font-size: 13.5px;
            font-weight: 600;
            color: #1e293b;
            margin: 0 0 2px 0;
        }
        .lup-disc-feature-desc {
            font-size: 12.5px;
            color: #64748b;
            line-height: 1.45;
            margin: 0;
        }
        .lup-disc-privacy-note {
            font-size: 11.5px;
            color: #94a3b8;
            background: #f8fafc;
            border-radius: 10px;
            padding: 10px 12px;
            line-height: 1.45;
            margin-bottom: 20px;
            text-align: center;
        }
        .lup-disc-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .lup-disc-btn-allow {
            width: 100%;
            height: 48px;
            background: #16a34a;
            color: #ffffff;
            font-size: 15.5px;
            font-weight: 600;
            border: none;
            border-radius: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            box-shadow: 0 4px 12px rgba(22, 163, 74, 0.25);
            transition: background 0.15s ease, transform 0.1s ease;
        }
        .lup-disc-btn-allow:hover {
            background: #15803d;
        }
        .lup-disc-btn-allow:active {
            transform: scale(0.98);
        }
        .lup-disc-btn-deny {
            width: 100%;
            height: 42px;
            background: transparent;
            color: #64748b;
            font-size: 14.5px;
            font-weight: 600;
            border: 1px solid #e2e8f0;
            border-radius: 14px;
            cursor: pointer;
            transition: background 0.15s ease, color 0.15s ease;
        }
        .lup-disc-btn-deny:hover {
            background: #f1f5f9;
            color: #334155;
        }
        .lup-disc-btn-deny:active {
            transform: scale(0.98);
        }
    `;
    document.head.appendChild(style);
}

export function isDriverLocationDisclosureAccepted() {
    try {
        return localStorage.getItem(DISCLOSURE_KEY) === "1";
    } catch (_) {
        return false;
    }
}

export function shouldShowDriverLocationDisclosure() {
    return !isDriverLocationDisclosureAccepted();
}

export function dismissDriverLocationDisclosureModal() {
    if (activeModalEl) {
        activeModalEl.remove();
        activeModalEl = null;
    }
    try {
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.overflow = '';
        }
    } catch (_) {}
}

/**
 * Displays the Google Play compliant Prominent Disclosure & Consent Modal.
 * Merges background location disclosure with Android battery optimization guidance.
 *
 * @returns {Promise<boolean>} True if allowed by driver, false if denied.
 */
export function showDriverLocationDisclosureModal() {
    return new Promise((resolve) => {
        dismissDriverLocationDisclosureModal();
        ensureDisclosureStyles();

        try {
            if (typeof document !== 'undefined' && document.body) {
                document.body.style.overflow = 'hidden';
            }
        } catch (_) {}

        const backdrop = document.createElement("div");
        backdrop.className = "lup-disc-backdrop";
        backdrop.setAttribute("role", "dialog");
        backdrop.setAttribute("aria-modal", "true");
        backdrop.setAttribute("aria-labelledby", "lup-disc-dialog-title");

        backdrop.innerHTML = `
            <div class="lup-disc-card">
                <!-- Header with Icon Badge -->
                <div class="lup-disc-header">
                    <div class="lup-disc-icon-badge">
                        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"></path>
                            <circle cx="12" cy="10" r="3"></circle>
                        </svg>
                    </div>
                    <h2 class="lup-disc-title" id="lup-disc-dialog-title">Location &amp; Power Access</h2>
                    <p class="lup-disc-subtitle">Prominent Disclosure &amp; Driver Consent</p>
                </div>

                <!-- Google Play Required Prominent Disclosure Callout -->
                <div class="lup-disc-notice-box">
                    <p class="lup-disc-notice-quote">
                        LiphtUp collects your location to share your live location with passengers and help them track your vehicle. Location tracking continues when the app is minimised while Active Mode is enabled.
                    </p>
                </div>

                <!-- Explanatory Features -->
                <div class="lup-disc-features-list">
                    <div class="lup-disc-feature-item">
                        <div class="lup-disc-feature-icon icon-location">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="22" y1="12" x2="18" y2="12"></line>
                                <line x1="6" y1="12" x2="2" y2="12"></line>
                                <line x1="12" y1="6" x2="12" y2="2"></line>
                                <line x1="12" y1="22" x2="12" y2="18"></line>
                            </svg>
                        </div>
                        <div class="lup-disc-feature-content">
                            <div class="lup-disc-feature-title">Live Passenger Tracking &amp; ETAs</div>
                            <p class="lup-disc-feature-desc">Transmits accurate vehicle GPS coordinates to passengers for real-time ride tracking, arrival estimates, and verified fare calculations.</p>
                        </div>
                    </div>

                    <div class="lup-disc-feature-item">
                        <div class="lup-disc-feature-icon icon-navigation">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
                            </svg>
                        </div>
                        <div class="lup-disc-feature-content">
                            <div class="lup-disc-feature-title">Continuous Background Tracking</div>
                            <p class="lup-disc-feature-desc">Maintains continuous tracking while navigating in external navigation apps (e.g. Google Maps), switching apps, or when your phone screen is locked.</p>
                        </div>
                    </div>

                    <div class="lup-disc-feature-item">
                        <div class="lup-disc-feature-icon icon-battery">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="1" y="6" width="18" height="12" rx="2"></rect>
                                <line x1="23" y1="11" x2="23" y2="13"></line>
                                <polygon points="11 8 8 13 11 13 10 16 14 11 11 11 11 8" fill="currentColor"></polygon>
                            </svg>
                        </div>
                        <div class="lup-disc-feature-content">
                            <div class="lup-disc-feature-title">Battery Optimization Exemption</div>
                            <p class="lup-disc-feature-desc">Prevents Android from pausing or terminating background GPS tracking while you are on duty waiting for rides or actively transporting passengers.</p>
                        </div>
                    </div>
                </div>

                <div class="lup-disc-privacy-note">
                    Location tracking is active only when Active Mode is turned ON or during an ongoing trip. It stops immediately when you go offline.
                </div>

                <!-- Action Buttons: Affirmative Allow and Deny -->
                <div class="lup-disc-actions">
                    <button type="button" class="lup-disc-btn-allow" id="btn-lup-disc-allow">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        <span>Allow &amp; Continue</span>
                    </button>
                    <button type="button" class="lup-disc-btn-deny" id="btn-lup-disc-deny">
                        <span>Deny &amp; Stay Offline</span>
                    </button>
                </div>
            </div>
        `;

        const handleAllow = () => {
            try {
                localStorage.setItem(DISCLOSURE_KEY, "1");
                localStorage.setItem(DISCLOSURE_TIMESTAMP_KEY, String(Date.now()));
            } catch (_) {}

            // Request battery optimization exemption on native Android if not already ignored
            if (!isBatteryOptimizationIgnored()) {
                requestIgnoreBatteryOptimizations();
            }

            dismissDriverLocationDisclosureModal();
            resolve(true);
        };

        const handleDeny = () => {
            try {
                localStorage.setItem("liphtup_driver_location_disclosure_denied_at", String(Date.now()));
            } catch (_) {}
            dismissDriverLocationDisclosureModal();
            resolve(false);
        };

        backdrop.querySelector("#btn-lup-disc-allow")?.addEventListener("click", handleAllow);
        backdrop.querySelector("#btn-lup-disc-deny")?.addEventListener("click", handleDeny);

        // Escape key dismisses as deny
        const escListener = (e) => {
            if (e.key === "Escape" && activeModalEl) {
                document.removeEventListener("keydown", escListener);
                handleDeny();
            }
        };
        document.addEventListener("keydown", escListener);

        document.body.appendChild(backdrop);
        activeModalEl = backdrop;
    });
}
