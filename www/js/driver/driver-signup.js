import { auth, db } from '../platform/firebase-init.js';
import {
    doc,
    getDoc,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    onAuthStateChanged,
    signInWithCustomToken,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert as showAppAlert } from '../shared/dialog.js';
import { hideInitialLoader } from '../shared/loading.js';
import { t } from '../shared/i18n.js';

const OTP_RESEND_DELAY_SECONDS = 60;
const PHONE_INDEX_COLLECTION = "phoneLoginIndex";

// State
let currentStep = 1;
let step1Verified = false;
let verifiedPhoneNumber = null;
let otpVerificationToken = null;
let otpSessionId = null;
let requestedPhoneNumber = null;
let resendTimerId = null;
let otpRequestInProgress = false;
let activeOtpProvider = "existing";
let msg91Config = null;
let msg91ReadyPromise = null;

// Stepper DOM Elements
const stepNode1 = document.getElementById('step-node-1');
const stepNode2 = document.getElementById('step-node-2');
const stepNode3 = document.getElementById('step-node-3');
const stepsProgress = document.getElementById('driver-steps-progress');
const step1Content = document.getElementById('driver-step-1');
const step2Content = document.getElementById('driver-step-2');
const step3Content = document.getElementById('driver-step-3');

// Step 1 DOM Elements
const phoneContainer = document.getElementById('driver-phone-container');
const phoneInput = document.getElementById('driver-phone-number');
const sendOtpBtn = document.getElementById('driver-send-otp-btn');
const otpContainer = document.getElementById('driver-otp-container');
const otpDestination = document.getElementById('driver-otp-destination');
const otpCodeInput = document.getElementById('driver-otp-code');
const verifyOtpBtn = document.getElementById('driver-verify-otp-btn');
const resendOtpBtn = document.getElementById('driver-resend-otp-btn');
const changePhoneBtn = document.getElementById('driver-change-phone-btn');

// Step 2 DOM Elements
const nameInput = document.getElementById('driver-name');
const emailInput = document.getElementById('driver-email');
const genderInput = document.getElementById('driver-gender');
const passwordInput = document.getElementById('driver-password');
const prev2Btn = document.getElementById('driver-prev-2-btn');
const next2Btn = document.getElementById('driver-next-2-btn');

// Step 3 DOM Elements
const customSelectVehicle = document.getElementById('custom-select-driver-vehicle-type');
const vehicleTypeSelect = document.getElementById('driver-vehicle-type');
const vehicleNumberInput = document.getElementById('driver-vehicle-number');
const vehicleModelInput = document.getElementById('driver-vehicle-model');
const licenseNumberInput = document.getElementById('driver-license-number');
const upiIdInput = document.getElementById('driver-upi-id');
const agreementCheckbox = document.getElementById('driver-agreement-checkbox');
const prev3Btn = document.getElementById('driver-prev-3-btn');
const submitBtn = document.getElementById('driver-submit-btn');

// Modal Elements
const accountExistsModal = document.getElementById('account-exists-modal');
const accountExistsCloseBtn = document.getElementById('account-exists-close-btn');
const accountExistsCloseX = document.getElementById('account-exists-close-x');
const accountExistsLoginBtn = document.getElementById('account-exists-login-btn');
const accountExistsPhoneDisplay = document.getElementById('account-exists-phone-display');

async function fetchOtpConfig() {
    try {
        const res = await fetch("/api/otp-config");
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.provider) {
                activeOtpProvider = data.provider;
                if (data.provider === "msg91" && data.widgetId && data.tokenAuth) {
                    msg91Config = data;
                    initMsg91Sdk(data);
                }
            }
        }
    } catch (e) {
        console.warn("Failed to fetch OTP config:", e);
    }
}

function initMsg91Sdk(config) {
    if (msg91ReadyPromise) return msg91ReadyPromise;
    msg91ReadyPromise = new Promise((resolve) => {
        if (window.sendOtp && window.verifyOtp) {
            resolve(true);
            return;
        }
        window.configuration = {
            widgetId: config.widgetId,
            tokenAuth: config.tokenAuth,
            exposeMethods: true,
            success: (data) => {
                console.log("MSG91 Widget success callback event:", data);
            },
            failure: (error) => {
                console.warn("MSG91 Widget failure callback event:", error);
            }
        };

        const scriptId = "msg91-otp-sdk";
        let script = document.getElementById(scriptId);
        if (!script) {
            script = document.createElement("script");
            script.id = scriptId;
            script.type = "text/javascript";
            script.src = "https://verify.msg91.com/otp-provider.js";
            script.onload = () => {
                if (typeof window.initSendOTP === "function") {
                    try {
                        window.initSendOTP(window.configuration);
                    } catch (err) {
                        console.warn("initSendOTP error:", err);
                    }
                }
                resolve(true);
            };
            script.onerror = () => {
                console.error("Failed to load MSG91 SDK script");
                resolve(false);
            };
            document.head.appendChild(script);
        } else {
            resolve(true);
        }
    });
    return msg91ReadyPromise;
}

function toMsg91Identifier(phone) {
    return String(phone || "").replace(/^\+/, "").replace(/\D/g, "");
}

function formatPhoneFromValue(value) {
    const raw = String(value || "").trim().replace(/\D/g, "");
    const national = raw.startsWith("91") && raw.length === 12 ? raw.slice(2) : raw;
    if (!/^[6-9]\d{9}$/.test(national)) {
        return null;
    }
    return `+91${national}`;
}

function maskPhoneNumber(phone) {
    const national = String(phone || "").replace(/^\+91/, "");
    return `+91 ******${national.slice(-4)}`;
}

function showAccountExistsModal(phoneNumber) {
    if (accountExistsPhoneDisplay) {
        const national = phoneNumber.replace(/^\+91/, "");
        accountExistsPhoneDisplay.textContent = `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
    }
    if (accountExistsModal) {
        accountExistsModal.classList.remove('d-none');
        document.addEventListener('keydown', onAccountExistsKeydown);
    }
}

function closeAccountExistsModal() {
    if (accountExistsModal) {
        accountExistsModal.classList.add('d-none');
        document.removeEventListener('keydown', onAccountExistsKeydown);
    }
}

function onAccountExistsKeydown(e) {
    if (e.key === "Escape") closeAccountExistsModal();
}

function goToStep(step) {
    currentStep = step;
    if (step === 1) {
        step1Content.classList.remove('d-none');
        step2Content.classList.add('d-none');
        step3Content.classList.add('d-none');

        stepNode1.className = 'driver-step-item active';
        stepNode2.className = 'driver-step-item';
        stepNode3.className = 'driver-step-item';
        stepNode1.setAttribute('aria-current', 'step');
        stepNode2.removeAttribute('aria-current');
        stepNode3.removeAttribute('aria-current');
        if (stepsProgress) stepsProgress.style.width = '0%';
    } else if (step === 2) {
        step1Content.classList.add('d-none');
        step2Content.classList.remove('d-none');
        step3Content.classList.add('d-none');

        stepNode1.className = 'driver-step-item completed';
        stepNode2.className = 'driver-step-item active';
        stepNode3.className = 'driver-step-item';
        stepNode1.removeAttribute('aria-current');
        stepNode2.setAttribute('aria-current', 'step');
        stepNode3.removeAttribute('aria-current');
        if (stepsProgress) stepsProgress.style.width = '50%';
        if (nameInput) nameInput.focus();
    } else if (step === 3) {
        step1Content.classList.add('d-none');
        step2Content.classList.add('d-none');
        step3Content.classList.remove('d-none');

        stepNode1.className = 'driver-step-item completed';
        stepNode2.className = 'driver-step-item completed';
        stepNode3.className = 'driver-step-item active';
        stepNode1.removeAttribute('aria-current');
        stepNode2.removeAttribute('aria-current');
        stepNode3.setAttribute('aria-current', 'step');
        if (stepsProgress) stepsProgress.style.width = '100%';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startResendTimer() {
    clearResendTimer();
    let remaining = OTP_RESEND_DELAY_SECONDS;
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = `${t('auth.resend_otp_in', 'Resend OTP in')} ${remaining}s`;

    resendTimerId = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearResendTimer();
            resendOtpBtn.disabled = false;
            resendOtpBtn.textContent = t('auth.resend_otp', "Resend OTP");
        } else {
            resendOtpBtn.textContent = `${t('auth.resend_otp_in', 'Resend OTP in')} ${remaining}s`;
        }
    }, 1000);
}

function clearResendTimer() {
    if (resendTimerId) {
        window.clearInterval(resendTimerId);
        resendTimerId = null;
    }
}

async function sendOTP() {
    if (otpRequestInProgress) return;
    const phone = formatPhoneFromValue(phoneInput.value);
    if (!phone) {
        await showAppAlert(t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."));
        phoneInput.focus();
        return;
    }

    otpRequestInProgress = true;
    sendOtpBtn.disabled = true;
    sendOtpBtn.textContent = t('auth.sending_otp', "Sending OTP...");

    try {
        // Fast pre-check: verify if phone number already belongs to a registered driver
        try {
            const checkRes = await fetch("/api/auth/check-phone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone }),
                signal: AbortSignal.timeout(3000)
            });
            if (checkRes.ok) {
                const checkData = await checkRes.json().catch(() => ({}));
                if (checkData.ok && checkData.exists && checkData.role === "driver") {
                    showAccountExistsModal(phone);
                    return;
                }
            }
        } catch (e) {
            console.warn("Check phone error:", e);
        }

        const purpose = "driver_register";

        if (activeOtpProvider === "msg91") {
            if (msg91Config) {
                await initMsg91Sdk(msg91Config);
            }
            if (!window.sendOtp) {
                throw new Error("OTP service is initializing. Please try again in a moment.");
            }

            const reserveRes = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone, purpose, isRetry: false })
            });
            const reserveData = await reserveRes.json().catch(() => ({}));
            if (!reserveRes.ok || !reserveData.ok) {
                if (reserveRes.status === 409 || /already exists/i.test(reserveData.error || reserveData.message || "")) {
                    showAccountExistsModal(phone);
                    return;
                }
                throw new Error(reserveData.error || reserveData.message || t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
            }

            const identifier = toMsg91Identifier(phone);
            await new Promise((resolve, reject) => {
                window.sendOtp(
                    identifier,
                    async (data) => {
                        try {
                            const reqId = typeof data === 'object' && data !== null
                                ? String(data.message || data.reqId || data.data?.reqId || "")
                                : String(data || "");

                            if (reqId) {
                                await fetch("/api/otp/session", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ phone, purpose, reqId })
                                }).catch((err) => console.warn("Session binding warning:", err));
                                otpSessionId = reqId;
                            } else {
                                otpSessionId = `msg91_${Date.now()}`;
                            }
                            resolve(data);
                        } catch (err) {
                            resolve(data);
                        }
                    },
                    (error) => {
                        const errMsg = typeof error === 'object' && error !== null
                            ? (error.message || error.error || JSON.stringify(error))
                            : String(error || "Could not send OTP via MSG91.");
                        reject(new Error(errMsg));
                    }
                );
            });
        } else {
            const response = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone, purpose })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.otpSessionId) {
                if (response.status === 409 || /already exists/i.test(data.error || data.message || "")) {
                    showAccountExistsModal(phone);
                    return;
                }
                throw new Error(data.error || data.message || t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
            }
            otpSessionId = data.otpSessionId;
        }

        requestedPhoneNumber = phone;
        phoneContainer.classList.add('d-none');
        otpContainer.classList.remove('d-none');
        otpDestination.textContent = `${t('auth.sent_otp_to', "We sent a 6-digit OTP to")} ${maskPhoneNumber(phone)}.`;
        startResendTimer();
        otpCodeInput.value = "";
        otpCodeInput.focus();
    } catch (error) {
        console.error("Driver OTP send failed:", error);
        await showAppAlert(error.message || t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
    } finally {
        otpRequestInProgress = false;
        sendOtpBtn.disabled = false;
        sendOtpBtn.innerHTML = `<span>${t('auth.send_registration_otp', "Send Verification OTP")}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>`;
    }
}

async function resendOTP() {
    if (!requestedPhoneNumber || resendOtpBtn.disabled) return;
    if (activeOtpProvider === "msg91" && window.retryOtp) {
        resendOtpBtn.disabled = true;
        try {
            const purpose = "driver_register";
            const checkRes = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: requestedPhoneNumber, purpose, isRetry: true })
            });
            const checkData = await checkRes.json().catch(() => ({}));
            if (!checkRes.ok || !checkData.ok) {
                throw new Error(checkData.error || checkData.message || t('auth.send_otp_failed', "Could not resend OTP. Please wait before trying again."));
            }

            await new Promise((resolve, reject) => {
                window.retryOtp(
                    '11',
                    (data) => resolve(data),
                    (err) => reject(new Error(typeof err === 'object' ? err.message || JSON.stringify(err) : String(err))),
                    otpSessionId || undefined
                );
            });
            startResendTimer();
        } catch (err) {
            console.error("Driver MSG91 retryOtp failed:", err);
            await showAppAlert(err.message || "Could not resend OTP. Please try again.");
            resendOtpBtn.disabled = false;
        }
        return;
    }
    await sendOTP();
}

async function verifyOTP() {
    if (verifyOtpBtn.disabled) return;
    const code = otpCodeInput.value.trim();

    if (!/^\d{6}$/.test(code)) {
        await showAppAlert(t('auth.enter_six_digit_pin', "Enter the full 6-digit confirmation pin."));
        otpCodeInput.focus();
        return;
    }

    if (!requestedPhoneNumber) {
        await showAppAlert(t('auth.request_otp_first', "Please request an OTP first."));
        return;
    }

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = t('auth.verifying', "Verifying...");

    try {
        const purpose = "driver_register";
        let verificationToken = null;
        let phoneVerified = null;

        if (activeOtpProvider === "msg91") {
            if (!window.verifyOtp) {
                throw new Error("OTP verification service is not ready. Please refresh and try again.");
            }

            const verifyResult = await new Promise((resolve, reject) => {
                window.verifyOtp(
                    code,
                    (data) => resolve(data),
                    async (error) => {
                        fetch("/api/otp/report-failure", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ phone: requestedPhoneNumber, purpose, reqId: otpSessionId })
                        }).catch(() => {});
                        const errMsg = typeof error === 'object' && error !== null
                            ? (error.message || error.error || JSON.stringify(error))
                            : String(error || "");
                        if (/provider request failed|invalid|mismatch|incorrect|wrong/i.test(errMsg)) {
                            reject(new Error(t('auth.err_invalid_otp', "That OTP is incorrect. Please check the SMS and try again.")));
                        } else {
                            reject(new Error(errMsg || t('auth.err_invalid_otp', "That OTP is incorrect. Please check the SMS and try again.")));
                        }
                    },
                    otpSessionId || undefined
                );
            });

            const accessToken = typeof verifyResult === 'object' && verifyResult !== null
                ? String(verifyResult.message || verifyResult.token || verifyResult.accessToken || verifyResult.jwt || "")
                : String(verifyResult || "");

            if (!accessToken) {
                throw new Error("Could not retrieve verification confirmation token from MSG91.");
            }

            const response = await fetch("/api/verify-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    phone: requestedPhoneNumber,
                    otpSessionId,
                    accessToken,
                    purpose
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.verificationToken) {
                throw new Error(data.error || data.message || t('auth.verify_otp_failed', "Could not verify the OTP. Please try again."));
            }

            phoneVerified = data.phone || requestedPhoneNumber;
            verificationToken = data.verificationToken;
        } else {
            const response = await fetch("/api/verify-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    phone: requestedPhoneNumber,
                    otpSessionId,
                    otp: code,
                    purpose
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.verificationToken) {
                throw new Error(data.error || data.message || t('auth.verify_otp_failed', "Could not verify the OTP. Please try again."));
            }

            phoneVerified = data.phone || requestedPhoneNumber;
            verificationToken = data.verificationToken;
        }

        verifiedPhoneNumber = phoneVerified;
        otpVerificationToken = verificationToken;
        step1Verified = true;
        clearResendTimer();

        goToStep(2);
    } catch (error) {
        console.error("OTP verification failed:", error);
        await showAppAlert(error.message || t('auth.verify_otp_failed', "Could not verify the OTP. Please try again."));
    } finally {
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.innerHTML = `<span>${t('auth.verify_and_continue', "Verify & Continue")}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>`;
    }
}

function setGender(genderValue) {
    const val = genderValue || "Male";
    if (genderInput) genderInput.value = val;
    const cards = document.querySelectorAll('.auth-gender-card');
    cards.forEach(card => {
        const isActive = card.getAttribute('data-gender') === val;
        card.classList.toggle('active', isActive);
        card.setAttribute('aria-checked', String(isActive));
    });
}

function initGenderCards() {
    const cards = document.querySelectorAll('.auth-gender-card');
    cards.forEach(card => {
        card.addEventListener('click', (e) => {
            e.preventDefault();
            const val = card.getAttribute('data-gender');
            setGender(val);
        });
    });
}

function initCustomSelect(container) {
    if (!container || container.dataset.customSelectInit) return;
    container.dataset.customSelectInit = "true";

    const targetSelectId = container.getAttribute('data-target-select');
    const selectEl = targetSelectId ? document.getElementById(targetSelectId) : container.querySelector('select');
    const trigger = container.querySelector('.liphtup-select-trigger');
    const menu = container.querySelector('.liphtup-select-menu');
    const labelEl = container.querySelector('.liphtup-select-label');
    const iconContainer = container.querySelector('.liphtup-select-icon');
    const options = container.querySelectorAll('.liphtup-select-option');

    if (!selectEl || !trigger || !menu) return;

    function updateDisplay(val) {
        options.forEach(opt => {
            const optVal = opt.getAttribute('data-value');
            const isActive = optVal === val;
            opt.classList.toggle('active', isActive);
            opt.setAttribute('aria-selected', String(isActive));
            if (isActive) {
                const optText = opt.querySelector('.liphtup-option-text');
                const optIcon = opt.querySelector('.liphtup-option-icon svg');
                if (labelEl && optText) {
                    labelEl.textContent = optText.textContent;
                }
                if (iconContainer && optIcon) {
                    iconContainer.innerHTML = optIcon.outerHTML;
                    const innerSvg = iconContainer.querySelector('svg');
                    if (innerSvg) innerSvg.setAttribute('stroke', '#166534');
                }
            }
        });
    }

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = !menu.classList.contains('d-none');
        menu.classList.toggle('d-none', isOpen);
        container.classList.toggle('is-open', !isOpen);
        trigger.setAttribute('aria-expanded', String(!isOpen));
    });

    options.forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const val = opt.getAttribute('data-value');
            selectEl.value = val;
            updateDisplay(val);
            menu.classList.add('d-none');
            container.classList.remove('is-open');
            trigger.setAttribute('aria-expanded', 'false');
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    selectEl.addEventListener('change', () => {
        updateDisplay(selectEl.value);
    });

    container._updateDisplay = updateDisplay;
    updateDisplay(selectEl.value);
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.liphtup-custom-select')) {
        document.querySelectorAll('.liphtup-custom-select').forEach(cs => {
            cs.classList.remove('is-open');
            const m = cs.querySelector('.liphtup-select-menu');
            if (m) m.classList.add('d-none');
            const t = cs.querySelector('.liphtup-select-trigger');
            if (t) t.setAttribute('aria-expanded', 'false');
        });
    }
});

function validateStep2() {
    const name = (nameInput?.value || "").trim();
    if (name.length < 2) {
        showAppAlert(t('profile.enter_full_name', "Enter your full name."));
        nameInput.focus();
        return false;
    }

    const email = (emailInput?.value || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAppAlert(t('profile.enter_valid_email', "Please enter a valid email address."));
        emailInput.focus();
        return false;
    }

    const password = passwordInput?.value || "";
    if (password.length < 6) {
        showAppAlert(t('auth.err_weak_password', "Password must be at least 6 characters."));
        passwordInput.focus();
        return false;
    }

    return true;
}

function validateStep3() {
    const vehicleType = vehicleTypeSelect?.value;
    if (!vehicleType || !["bike", "auto"].includes(vehicleType)) {
        showAppAlert(t('profile.select_vehicle_type', "Please select your vehicle type."));
        return false;
    }

    const vehicleNumber = (vehicleNumberInput?.value || "").trim().toUpperCase();
    if (!vehicleNumber || !/^[A-Z0-9 -]{4,20}$/.test(vehicleNumber)) {
        showAppAlert(t('profile.enter_valid_vehicle_number', "Enter a valid vehicle registration number."));
        vehicleNumberInput.focus();
        return false;
    }

    const vehicleModel = (vehicleModelInput?.value || "").trim();
    if (vehicleModel.length < 2) {
        showAppAlert(t('profile.enter_vehicle_model', "Enter your vehicle model."));
        vehicleModelInput.focus();
        return false;
    }

    const licenseNumber = (licenseNumberInput?.value || "").trim().toUpperCase();
    if (!licenseNumber || !/^[A-Z0-9 -]{5,30}$/.test(licenseNumber)) {
        showAppAlert(t('profile.enter_valid_driving_licence', "Enter a valid driving licence number."));
        licenseNumberInput.focus();
        return false;
    }

    const upiId = (upiIdInput?.value || "").trim().toLowerCase();
    if (!upiId || !/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/.test(upiId)) {
        showAppAlert(t('profile.enter_valid_upi', "Enter a valid UPI ID (e.g. name@upi)."));
        upiIdInput.focus();
        return false;
    }

    if (!agreementCheckbox?.checked) {
        showAppAlert(t('auth.must_accept_terms', "Please agree to LiphtUp's Terms & Conditions and Privacy Policy."));
        agreementCheckbox.focus();
        return false;
    }

    return true;
}

async function createDriverAccount() {
    if (submitBtn.disabled) return;

    if (!verifiedPhoneNumber || !otpVerificationToken) {
        await showAppAlert(t('auth.phone_session_missing', "Your phone verification session is missing. Please verify OTP again."));
        goToStep(1);
        return;
    }

    if (!validateStep2()) {
        goToStep(2);
        return;
    }

    if (!validateStep3()) {
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = t('auth.creating_account', "Creating Driver Account...");

    const name = nameInput.value.trim();
    const email = (emailInput.value || "").trim().toLowerCase();
    const gender = genderInput?.value || "Male";
    const password = passwordInput.value;
    const vehicleType = vehicleTypeSelect.value;
    const vehicleNumber = vehicleNumberInput.value.trim().toUpperCase();
    const vehicleModel = vehicleModelInput.value.trim();
    const drivingLicenseNumber = licenseNumberInput.value.trim().toUpperCase();
    const upiId = upiIdInput.value.trim().toLowerCase();

    const profilePayload = {
        name,
        email: email || "",
        gender,
        role: "driver",
        vehicleType,
        vehicleNumber,
        vehicleModel,
        drivingLicenseNumber,
        upiId,
        termsAccepted: true
    };

    try {
        if (auth.currentUser) {
            try {
                await signOut(auth);
            } catch (e) {}
        }

        const response = await fetch("/api/register-driver", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                verificationToken: otpVerificationToken,
                phone: verifiedPhoneNumber,
                password,
                profile: profilePayload
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok || !data.customToken || !data.profile) {
            if (response.status === 409 || /already exists/i.test(data.error || data.message || "")) {
                showAccountExistsModal(verifiedPhoneNumber);
                return;
            }
            throw new Error(data.error || data.message || t('auth.registration_failed', "Could not create driver account. Please try again."));
        }

        const result = await signInWithCustomToken(auth, data.customToken);
        const createdProfile = data.profile;

        try {
            localStorage.setItem("liphtup_user_profile", JSON.stringify(createdProfile));
            sessionStorage.setItem("liphtup_user_profile", JSON.stringify(createdProfile));
        } catch (e) {
            console.warn("Storage save error:", e);
        }

        const driverHomeUrl = window.getPlatformUrl ? window.getPlatformUrl("/driver.html") : "/driver.html";
        window.location.replace(driverHomeUrl);
    } catch (error) {
        console.error("Driver registration submission failed:", error);
        await showAppAlert(error.message || t('auth.registration_failed', "Could not create driver account. Please try again."));
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>${t('auth.create_driver_account', "Create Driver Account")}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>`;
    }
}

// Event Listeners
if (sendOtpBtn) sendOtpBtn.addEventListener('click', sendOTP);
if (verifyOtpBtn) verifyOtpBtn.addEventListener('click', verifyOTP);
if (resendOtpBtn) resendOtpBtn.addEventListener('click', resendOTP);
if (changePhoneBtn) {
    changePhoneBtn.addEventListener('click', () => {
        clearResendTimer();
        otpContainer.classList.add('d-none');
        phoneContainer.classList.remove('d-none');
        phoneInput.focus();
    });
}

if (phoneInput) {
    phoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendOTP();
        }
    });
}

if (otpCodeInput) {
    otpCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            verifyOTP();
        }
    });
}

if (prev2Btn) {
    prev2Btn.addEventListener('click', () => {
        goToStep(1);
    });
}

if (next2Btn) {
    next2Btn.addEventListener('click', () => {
        if (validateStep2()) {
            goToStep(3);
        }
    });
}

if (prev3Btn) {
    prev3Btn.addEventListener('click', () => {
        goToStep(2);
    });
}

if (submitBtn) {
    submitBtn.addEventListener('click', createDriverAccount);
}

// Modal Listeners
if (accountExistsCloseBtn) accountExistsCloseBtn.addEventListener('click', closeAccountExistsModal);
if (accountExistsCloseX) accountExistsCloseX.addEventListener('click', closeAccountExistsModal);
if (accountExistsLoginBtn) {
    accountExistsLoginBtn.addEventListener('click', () => {
        const loginUrl = window.getPlatformUrl ? window.getPlatformUrl("/login.html") : "/login.html";
        window.location.href = loginUrl;
    });
}

// Passenger Signup navigation handlers
const headerPassengerSignupBtn = document.getElementById('header-passenger-signup-btn');
if (headerPassengerSignupBtn) {
    headerPassengerSignupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const passengerUrl = window.getPlatformUrl ? window.getPlatformUrl("/login.html?mode=register") : "/login.html?mode=register";
        window.location.href = passengerUrl;
    });
}

const passengerSignupCardBtn = document.getElementById('passenger-signup-card-btn');
if (passengerSignupCardBtn) {
    passengerSignupCardBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const passengerUrl = window.getPlatformUrl ? window.getPlatformUrl("/login.html?mode=register") : "/login.html?mode=register";
        window.location.href = passengerUrl;
    });
}

// Initialize
initGenderCards();
if (customSelectVehicle) initCustomSelect(customSelectVehicle);
fetchOtpConfig();

onAuthStateChanged(auth, async (user) => {
    if (!user || step1Verified) {
        hideInitialLoader();
        return;
    }
    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (userDocSnap.exists()) {
            const data = userDocSnap.data() || {};
            if (data.role === "driver") {
                const driverHomeUrl = window.getPlatformUrl ? window.getPlatformUrl("/driver.html") : "/driver.html";
                window.location.replace(driverHomeUrl);
                return;
            }
        }
    } catch (e) {
        console.warn("Auth session check warning on driver-signup:", e);
    }
    hideInitialLoader();
});
