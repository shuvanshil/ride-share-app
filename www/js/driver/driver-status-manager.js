/**
 * Driver Account Status Modal & Lifecycle Manager
 * Handles: Pending Approval, Approved, Rejected, Suspended, Blocked
 * Features: Server persistence, live realtime sync, i18n support, pixel-accurate modals.
 */

import { getAuthToken } from "../shared/auth.js";

function getI18nText(key, fallback) {
    if (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === "function") {
        return window.LiphtUpI18n.t(key, fallback);
    }
    return fallback;
}

export function buildDriverStatusSvg(state) {
    let badgeSvg = "";

    switch (state) {
        case "approved":
            badgeSvg = `
                <circle cx="138" cy="98" r="18" fill="#22C55E"/>
                <path d="M130 98 L135 103 L146 92" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
            `;
            break;
        case "rejected":
            badgeSvg = `
                <circle cx="138" cy="98" r="18" fill="#EF4444"/>
                <path d="M131 91 L145 105 M145 91 L131 105" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>
            `;
            break;
        case "suspended":
            badgeSvg = `
                <circle cx="138" cy="98" r="18" fill="#F97316"/>
                <path d="M134 91 V105 M142 91 V105" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/>
            `;
            break;
        case "blocked":
            badgeSvg = `
                <circle cx="138" cy="98" r="18" fill="#DC2626"/>
                <circle cx="138" cy="98" r="11" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
                <path d="M130 90 L146 106" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"/>
            `;
            break;
        case "pending_review":
        default:
            badgeSvg = `
                <circle cx="138" cy="98" r="18" fill="#FBBF24"/>
                <circle cx="138" cy="98" r="1.5" fill="#FFFFFF"/>
                <path d="M138 88 V98 H145" stroke="#FFFFFF" stroke-width="2.75" stroke-linecap="round"/>
            `;
            break;
    }

    return `
        <svg viewBox="0 0 195 130" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="lu-badge-shadow" x="110" y="70" width="60" height="60" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                    <feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#0F172A" flood-opacity="0.12"/>
                </filter>
            </defs>
            <!-- Background Cloud Backdrop -->
            <path d="M45,115 C20,115 10,95 15,70 C10,45 30,25 55,25 C75,10 115,10 135,25 C160,20 185,40 180,70 C188,95 175,115 150,115 Z" fill="#E8F8EE" opacity="0.95"/>
            
            <!-- Sparkles & Plus Accents -->
            <path d="M42 42 L42 48 M39 45 L45 45" stroke="#86EFAC" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M165 46 L165 52 M162 49 L168 49" stroke="#86EFAC" stroke-width="2.2" stroke-linecap="round"/>

            <!-- Main Rounded ID Badge Card -->
            <rect x="36" y="24" width="124" height="88" rx="14" fill="#FFFFFF" stroke="#22C55E" stroke-width="3"/>
            
            <!-- Top Tab -->
            <path d="M38 38 C38 28 42 26 50 26 L66 26 C72 26 76 30 76 38 L38 38 Z" fill="#22C55E"/>
            
            <!-- Avatar Silhouette inside ID -->
            <circle cx="68" cy="56" r="13" fill="#15803D"/>
            <path d="M52,84 C52,72 59,68 68,68 C77,68 84,72 84,84 Z" fill="#15803D"/>

            <!-- Details Lines -->
            <rect x="94" y="48" width="46" height="6" rx="3" fill="#15803D"/>
            <rect x="94" y="60" width="38" height="5" rx="2.5" fill="#86EFAC"/>
            <rect x="94" y="72" width="28" height="5" rx="2.5" fill="#15803D"/>
            <rect x="52" y="92" width="54" height="4" rx="2" fill="#DCFCE7"/>

            <!-- Corner Badge Ring and Status Symbol -->
            <g filter="url(#lu-badge-shadow)">
                <circle cx="138" cy="98" r="22" fill="#FFFFFF"/>
                ${badgeSvg}
            </g>
        </svg>
    `;
}

class DriverStatusManager {
    constructor() {
        this.overlayEl = null;
        this.currentProfile = null;
        this.onAcknowledgedCallback = null;
        this.onReappliedCallback = null;
    }

    ensureOverlay() {
        if (this.overlayEl && document.body.contains(this.overlayEl)) {
            return this.overlayEl;
        }

        const existing = document.getElementById("driver-status-modal-overlay");
        if (existing) {
            this.overlayEl = existing;
            return this.overlayEl;
        }

        const overlay = document.createElement("div");
        overlay.id = "driver-status-modal-overlay";
        overlay.className = "driver-status-modal-overlay d-none";
        document.body.appendChild(overlay);
        this.overlayEl = overlay;
        return this.overlayEl;
    }

    hideModal() {
        if (this.overlayEl) {
            this.overlayEl.classList.add("d-none");
            this.overlayEl.innerHTML = "";
        }
    }

    /**
     * Evaluates the driver profile status and renders the appropriate modal.
     * Returns true if a blocking modal is active, false if driver is approved and ready.
     */
    evaluateStatus(profile, { onAcknowledged, onReapplied } = {}) {
        this.currentProfile = profile;
        this.onAcknowledgedCallback = onAcknowledged;
        this.onReappliedCallback = onReapplied;

        const status = profile?.verificationStatus || "pending_review";
        const isAcknowledged = profile?.approvalAcknowledged === true || (profile?.approvalAcknowledged === undefined && (Number(profile?.total_completed_trips || profile?.totalCompletedTrips || 0) > 0 || Number(profile?.lifetime_earnings || profile?.lifetimeEarnings || 0) > 0));

        if (status === "approved" && isAcknowledged) {
            this.hideModal();
            return false;
        }

        this.renderModal(status, profile);
        return true;
    }

    renderModal(status, profile) {
        const overlay = this.ensureOverlay();
        const t = (key, fallback) => getI18nText(key, fallback);

        let title = "";
        let messageHtml = "";
        let actionsHtml = "";

        switch (status) {
            case "approved":
                title = t("driver.status_approved_title", "Registration Approved!");
                messageHtml = `<p class="driver-status-message">${t("driver.status_approved_msg", "Congratulations! Your driver registration has been approved. You can now use the platform and start accepting trips.")}</p>`;
                actionsHtml = `
                    <div class="driver-status-actions">
                        <button id="driver-status-ack-btn" type="button" class="driver-status-btn driver-status-btn-primary">
                            ${t("driver.status_approved_btn", "OK")}
                        </button>
                    </div>
                `;
                break;

            case "rejected":
                const reason = profile?.rejectionReason || t("driver.default_rejection_reason", "Application requirements were not met.");
                title = t("driver.status_rejected_title", "Registration Rejected");
                messageHtml = `
                    <p class="driver-status-message">${t("driver.status_rejected_msg_intro", "Unfortunately, your driver registration could not be approved at this time.")}</p>
                    <div class="driver-status-reason-box">
                        <div class="driver-status-reason-title">${t("driver.status_reason_label", "Reason:")}</div>
                        <div class="driver-status-reason-text">${this.escapeHtml(reason)}</div>
                    </div>
                    <p class="driver-status-prompt">${t("driver.status_rejected_msg_outro", "Please review the reason above and submit a new application.")}</p>
                `;
                actionsHtml = `
                    <div class="driver-status-actions">
                        <button id="driver-status-reapply-btn" type="button" class="driver-status-btn driver-status-btn-primary">
                            ${t("driver.status_rejected_btn", "Re-apply")}
                        </button>
                    </div>
                `;
                break;

            case "suspended":
                title = t("driver.status_suspended_title", "Account Suspended");
                const suspensionReason = profile?.suspensionReason;
                messageHtml = `
                    <p class="driver-status-message">${t("driver.status_suspended_msg", "Your driver account has been suspended by the administration. You are currently unable to use the driver services. Please contact the administration for further assistance.")}</p>
                    ${suspensionReason ? `
                        <div class="driver-status-reason-box">
                            <div class="driver-status-reason-title">${t("driver.status_reason_label", "Reason:")}</div>
                            <div class="driver-status-reason-text">${this.escapeHtml(suspensionReason)}</div>
                        </div>
                    ` : ""}
                `;
                actionsHtml = ""; // No button
                break;

            case "blocked":
                title = t("driver.status_blocked_title", "Account Blocked");
                const blockingReason = profile?.blockingReason;
                messageHtml = `
                    <p class="driver-status-message">${t("driver.status_blocked_msg", "Your driver account has been blocked by the administration. You are currently unable to access driver services. Please contact the administration for further assistance.")}</p>
                    ${blockingReason ? `
                        <div class="driver-status-reason-box">
                            <div class="driver-status-reason-title">${t("driver.status_reason_label", "Reason:")}</div>
                            <div class="driver-status-reason-text">${this.escapeHtml(blockingReason)}</div>
                        </div>
                    ` : ""}
                `;
                actionsHtml = ""; // No button
                break;

            case "pending_review":
            default:
                title = t("driver.status_pending_title", "Registration Under Review");
                messageHtml = `<p class="driver-status-message">${t("driver.status_pending_msg", "Your driver registration has been submitted successfully and is currently waiting for approval. Please wait while our administration team reviews your application.")}</p>`;
                actionsHtml = ""; // No button
                break;
        }

        const svgIllustration = buildDriverStatusSvg(status);

        overlay.innerHTML = `
            <div class="driver-status-modal-card" role="dialog" aria-modal="true" aria-labelledby="driver-status-modal-title">
                <div class="driver-status-illustration-wrap">
                    ${svgIllustration}
                </div>
                <h2 id="driver-status-modal-title" class="driver-status-title">${title}</h2>
                ${messageHtml}
                ${actionsHtml}
            </div>
        `;
        overlay.classList.remove("d-none");

        // Attach action handlers
        if (status === "approved") {
            const ackBtn = document.getElementById("driver-status-ack-btn");
            if (ackBtn) {
                ackBtn.addEventListener("click", () => this.handleAcknowledgeApproval(ackBtn));
            }
        } else if (status === "rejected") {
            const reapplyBtn = document.getElementById("driver-status-reapply-btn");
            if (reapplyBtn) {
                reapplyBtn.addEventListener("click", () => this.handleReapply(reapplyBtn));
            }
        }
    }

    async handleAcknowledgeApproval(buttonEl) {
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.innerText = getI18nText("common.loading", "Loading...");
        }

        try {
            const token = await getAuthToken();
            const response = await fetch("/api/account/driver-acknowledge-approval", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || errorData.message || "Failed to acknowledge approval.");
            }

            const data = await response.json();
            if (data.profile) {
                this.currentProfile = data.profile;
            }

            this.hideModal();
            if (typeof this.onAcknowledgedCallback === "function") {
                this.onAcknowledgedCallback(this.currentProfile);
            }
        } catch (error) {
            console.error("Error acknowledging approval:", error);
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.innerText = getI18nText("driver.status_approved_btn", "OK");
            }
            alert(error.message || "Could not complete request. Please try again.");
        }
    }

    async handleReapply(buttonEl) {
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.innerText = getI18nText("driver.status_reapplying", "Re-applying...");
        }

        try {
            const token = await getAuthToken();
            const response = await fetch("/api/account/driver-reapply", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || errorData.message || "Failed to re-apply.");
            }

            const data = await response.json();
            if (data.profile) {
                this.currentProfile = data.profile;
            } else if (this.currentProfile) {
                this.currentProfile.verificationStatus = "pending_review";
                this.currentProfile.rejectionReason = null;
            }

            // Immediately switch UI to Pending Review
            this.renderModal("pending_review", this.currentProfile);

            if (typeof this.onReappliedCallback === "function") {
                this.onReappliedCallback(this.currentProfile);
            }
        } catch (error) {
            console.error("Error re-applying:", error);
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.innerText = getI18nText("driver.status_rejected_btn", "Re-apply");
            }
            alert(error.message || "Could not submit re-application. Please try again.");
        }
    }

    escapeHtml(str) {
        return String(str || "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }
}

export const driverStatusManager = new DriverStatusManager();
