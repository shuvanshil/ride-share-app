import { auth, db } from '../platform/firebase-init.js';
import {
    doc,
    getDoc,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    onAuthStateChanged,
    signInWithCustomToken,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert as showAppAlert } from './dialog.js';
import { hideInitialLoader } from './loading.js';
import { t } from './i18n.js';
import {
    getRememberedAccount,
    saveRememberedAccount,
    forgetRememberedAccount,
    cleanupExpiredRememberedAccounts
} from './remembered-accounts.js';

// =============================================================================
// Constants & State
// =============================================================================
const PROFILE_CACHE_KEY = "liphtup_user_profile";
const OTP_RESEND_DELAY_SECONDS = 60;
const PHONE_INDEX_COLLECTION = "phoneLoginIndex";
const ACTIVE_OTP_SESSION_KEY = "liphtup_active_otp_session";

let currentPhase = 1;
let authIntent = "passenger"; // "passenger" | "driver" | "reset"
let requestedPhoneNumber = null;
let verifiedPhoneNumber = null;
let otpSessionId = null;
let otpVerificationToken = null;
let resendTimerId = null;
let otpRequestInProgress = false;
let loginFlowStarted = false;
let activeOtpProvider = "existing";
let msg91Config = null;
let msg91ReadyPromise = null;
let avatarBase64 = null;
let existingAccountData = null; // { exists, email, role }

// Phase DOM Containers
const phases = {
    1: document.getElementById('wizard-phase-1'),
    2: document.getElementById('wizard-phase-2'),
    3: document.getElementById('wizard-phase-3'),
    4: document.getElementById('wizard-phase-4'),
    5: document.getElementById('wizard-phase-5'),
    'reset': document.getElementById('wizard-phase-reset')
};

const backBtn = document.getElementById('wizard-back-btn');

// Phase 1 Elements
const phase1ContinueBtn = document.getElementById('phase1-continue-btn');
const phase1ContinueLabel = document.getElementById('phase1-continue-label');
const phase1PassengerSwitchWrap = document.getElementById('phase1-passenger-switch-wrap');
const phase1SwitchPassengerBtn = document.getElementById('phase1-switch-passenger-btn');

const phase1DriverSignupBtn = document.getElementById('phase1-driver-signup-btn');
const phase1DriverSignupLabel = document.getElementById('phase1-driver-signup-label');
const phase1DriverSwitchWrap = document.getElementById('phase1-driver-switch-wrap');
const phase1SwitchDriverBtn = document.getElementById('phase1-switch-driver-btn');

// Phase 2 Elements
const phoneInput = document.getElementById('wizard-phone');
const phase2PasswordContainer = document.getElementById('phase2-password-container');
const loginPasswordInput = document.getElementById('wizard-login-password');
const phase2ContinueBtn = document.getElementById('phase2-continue-btn');
const phase2ContinueLabel = document.getElementById('phase2-continue-label');
const phase2LoginBtn = document.getElementById('phase2-login-btn');
const phase2ForgotPasswordLink = document.getElementById('phase2-forgot-password-link');
const phase2Notice = document.getElementById('phase2-notice');
const phase2NoticeText = document.getElementById('phase2-notice-text');
const phase2Error = document.getElementById('phase2-error');
const phase2ErrorText = document.getElementById('phase2-error-text');

// Phase 3 Elements
const phase3Error = document.getElementById('phase3-error');
const phase3ErrorText = document.getElementById('phase3-error-text');
const phase3PhoneDisplay = document.getElementById('phase3-phone-display');
const phase3EditPhoneBtn = document.getElementById('phase3-edit-phone-btn');
const phase3VerifyBtn = document.getElementById('phase3-verify-btn');
const phase3ResendWrap = document.getElementById('phase3-resend-wrap');
const phase3ResendTimer = document.getElementById('phase3-resend-timer');
const phase3ResendBtn = document.getElementById('phase3-resend-btn');
const otpBoxes = [
    document.getElementById('otp-box-1'),
    document.getElementById('otp-box-2'),
    document.getElementById('otp-box-3'),
    document.getElementById('otp-box-4'),
    document.getElementById('otp-box-5'),
    document.getElementById('otp-box-6')
];

// Phase 4 Elements
const phase4Error = document.getElementById('phase4-error');
const phase4ErrorText = document.getElementById('phase4-error-text');
const avatarPreviewWrap = document.getElementById('avatar-preview-wrap');
const avatarImg = document.getElementById('avatar-img');
const avatarPlaceholder = document.getElementById('avatar-placeholder-icon');
const avatarFileInput = document.getElementById('avatar-file-input');
const avatarPickerBtn = document.getElementById('avatar-picker-btn');
const avatarBtnText = document.getElementById('avatar-btn-text');
const regNameInput = document.getElementById('reg-name');
const regEmailInput = document.getElementById('reg-email');
const regPasswordInput = document.getElementById('reg-password');
const regGenderInput = document.getElementById('reg-gender');
const phase4SubmitBtn = document.getElementById('phase4-submit-btn');
const phase4SubmitLabel = document.getElementById('phase4-submit-label');

// Phase 5 Elements
const phase5Error = document.getElementById('phase5-error');
const phase5ErrorText = document.getElementById('phase5-error-text');
const driverVehicleType = document.getElementById('driver-vehicle-type');
const driverVehicleNumber = document.getElementById('driver-vehicle-number');
const driverVehicleModel = document.getElementById('driver-vehicle-model');
const driverLicenseNumber = document.getElementById('driver-license-number');
const driverUpiId = document.getElementById('driver-upi-id');
const driverAgreement = document.getElementById('driver-agreement');
const phase5SubmitBtn = document.getElementById('phase5-submit-btn');

// Phase Reset Elements
const resetError = document.getElementById('reset-error');
const resetErrorText = document.getElementById('reset-error-text');
const resetPasswordInput = document.getElementById('reset-password');
const resetConfirmPasswordInput = document.getElementById('reset-confirm-password');
const resetSubmitBtn = document.getElementById('reset-submit-btn');

// =============================================================================
// Helper Functions: UI, Messages, Errors
// =============================================================================
const inlineErrorTimers = {};
let phase2NoticeTimer = null;

function showInlineError(phaseId, message) {
    const errorContainer = document.getElementById(`phase${phaseId}-error`) || (phaseId === 'reset' ? resetError : null);
    const textEl = document.getElementById(`phase${phaseId}-error-text`) || (phaseId === 'reset' ? resetErrorText : null);
    if (errorContainer && textEl) {
        textEl.textContent = message;
        errorContainer.classList.add('is-visible');

        if (inlineErrorTimers[phaseId]) {
            clearTimeout(inlineErrorTimers[phaseId]);
        }
        inlineErrorTimers[phaseId] = setTimeout(() => {
            clearInlineError(phaseId);
        }, 15000);
    }
}

function clearInlineError(phaseId) {
    if (inlineErrorTimers[phaseId]) {
        clearTimeout(inlineErrorTimers[phaseId]);
        delete inlineErrorTimers[phaseId];
    }
    const errorContainer = document.getElementById(`phase${phaseId}-error`) || (phaseId === 'reset' ? resetError : null);
    const textEl = document.getElementById(`phase${phaseId}-error-text`) || (phaseId === 'reset' ? resetErrorText : null);
    if (errorContainer && textEl) {
        textEl.textContent = "";
        errorContainer.classList.remove('is-visible');
    }
}

function showPhase2Notice(message) {
    if (phase2Notice && phase2NoticeText) {
        phase2NoticeText.textContent = message;
        phase2Notice.classList.add('is-visible');

        if (phase2NoticeTimer) {
            clearTimeout(phase2NoticeTimer);
        }
        phase2NoticeTimer = setTimeout(() => {
            clearPhase2Notice();
        }, 15000);
    }
}

function clearPhase2Notice() {
    if (phase2NoticeTimer) {
        clearTimeout(phase2NoticeTimer);
        phase2NoticeTimer = null;
    }
    if (phase2Notice && phase2NoticeText) {
        phase2NoticeText.textContent = "";
        phase2Notice.classList.remove('is-visible');
    }
}

function getAuthErrorMessage(error, fallbackMessage) {
    if (error?.code && typeof error.code === 'string') {
        const messages = {
            "auth/email-already-in-use": t('auth.err_email_in_use', "This email is already linked to another account."),
            "auth/invalid-credential": t('auth.err_invalid_credential', "Phone/email or password is incorrect."),
            "auth/invalid-email": t('profile.enter_valid_email', "Enter a valid email address."),
            "auth/invalid-phone-number": t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."),
            "auth/missing-password": t('auth.err_missing_password', "Enter your password."),
            "auth/missing-phone-number": t('auth.err_missing_phone', "Enter your mobile number first."),
            "auth/user-not-found": t('auth.err_user_not_found', "No LiphtUp account was found for this phone or email."),
            "auth/wrong-password": t('auth.err_invalid_credential', "Phone/email or password is incorrect."),
            "auth/weak-password": t('auth.err_weak_password', "Use a password with at least 6 characters."),
            "auth/invalid-verification-code": t('auth.err_invalid_otp', "That OTP is incorrect. Please check the SMS and try again."),
            "auth/code-expired": t('auth.err_otp_expired', "That OTP has expired. Request a new OTP."),
            "auth/session-expired": t('auth.err_session_expired', "This verification session has expired. Request a new OTP."),
            "auth/too-many-requests": t('auth.err_too_many_requests', "Too many attempts were made. Please wait before trying again."),
            "auth/quota-exceeded": t('auth.err_quota_exceeded', "The SMS sending limit has been reached. Please try again later."),
            "auth/network-request-failed": t('auth.err_network', "Check your internet connection and try again.")
        };
        if (messages[error.code]) return messages[error.code];
    }
    const rawMessage = (typeof error === 'object' && error !== null)
        ? (error.message || error.error || fallbackMessage)
        : String(error || fallbackMessage);
    if (/provider request failed|invalid[ -]?otp|otp mismatch|incorrect or expired|wrong otp/i.test(rawMessage)) {
        return t('auth.err_invalid_otp', "That OTP is incorrect. Please check the SMS and try again.");
    }
    return rawMessage || fallbackMessage;
}

function formatPhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    const national = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
    if (!/^[6-9]\d{9}$/.test(national)) return null;
    return `+91${national}`;
}

function maskPhoneNumber(phoneNumber) {
    const national = phoneNumber.replace(/^\+91/, "");
    return `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
}

function formatCountdownTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateWelcomeScreenRememberedAccounts() {
    cleanupExpiredRememberedAccounts();

    const p = getRememberedAccount('passenger');
    if (phase1ContinueLabel) {
        if (p && p.name) {
            phase1ContinueLabel.textContent = t('auth.continue_as', 'Continue as {name}').replace('{name}', p.name);
            if (phase1PassengerSwitchWrap) phase1PassengerSwitchWrap.classList.remove('d-none');
        } else {
            phase1ContinueLabel.textContent = t('auth.btn_continue_mobile', 'Continue with mobile number');
            if (phase1PassengerSwitchWrap) phase1PassengerSwitchWrap.classList.add('d-none');
        }
    }

    const d = getRememberedAccount('driver');
    if (phase1DriverSignupLabel) {
        if (d && d.name) {
            phase1DriverSignupLabel.textContent = t('auth.continue_as', 'Continue as {name}').replace('{name}', d.name);
            if (phase1DriverSwitchWrap) phase1DriverSwitchWrap.classList.remove('d-none');
        } else {
            phase1DriverSignupLabel.textContent = t('auth.btn_driver_signup', 'Captain / Driver Signup');
            if (phase1DriverSwitchWrap) phase1DriverSwitchWrap.classList.add('d-none');
        }
    }
}

// =============================================================================
// Phase Transition Controller & Guards
// =============================================================================
function goToPhase(targetPhase) {
    // Guards
    if (targetPhase === 3 && !requestedPhoneNumber) {
        targetPhase = 2;
    } else if (targetPhase === 4 && (!verifiedPhoneNumber || !otpVerificationToken)) {
        targetPhase = 2;
    } else if (targetPhase === 5 && (authIntent !== "driver" || !verifiedPhoneNumber || !otpVerificationToken)) {
        targetPhase = 4;
    } else if (targetPhase === 'reset' && (!otpVerificationToken || authIntent !== "reset")) {
        targetPhase = 2;
    }

    clearInlineError(currentPhase);
    currentPhase = targetPhase;

    // Toggle active phase classes
    Object.keys(phases).forEach((pKey) => {
        const el = phases[pKey];
        if (el) {
            const isActive = String(pKey) === String(targetPhase);
            el.classList.toggle('active', isActive);
        }
    });

    // Control Back Button visibility
    if (backBtn) {
        backBtn.classList.toggle('d-none', targetPhase === 1);
    }

    // Phase-specific setup
    if (targetPhase === 1) {
        updateWelcomeScreenRememberedAccounts();
    } else if (targetPhase === 2) {
        if (phoneInput) {
            setTimeout(() => phoneInput.focus(), 80);
        }
        updatePhase2UI();
    } else if (targetPhase === 3) {
        if (phase3PhoneDisplay && requestedPhoneNumber) {
            phase3PhoneDisplay.textContent = maskPhoneNumber(requestedPhoneNumber);
        }
        clearOtpBoxes();
        if (otpBoxes[0]) {
            setTimeout(() => otpBoxes[0].focus(), 80);
        }
        // Auto-trigger OTP send on Phase 3 entry if not already in flight or active
        if (!otpSessionId && !otpRequestInProgress) {
            sendOTP();
        }
    } else if (targetPhase === 4) {
        if (phase4SubmitLabel) {
            if (authIntent === "driver") {
                phase4SubmitLabel.textContent = t('auth.btn_continue_to_vehicle', "Continue to Vehicle Details");
            } else {
                phase4SubmitLabel.textContent = t('auth.btn_create_account', "Create Account");
            }
        }
        if (regNameInput) {
            setTimeout(() => regNameInput.focus(), 80);
        }
    } else if (targetPhase === 5) {
        if (driverVehicleNumber) {
            setTimeout(() => driverVehicleNumber.focus(), 80);
        }
    } else if (targetPhase === 'reset') {
        if (resetPasswordInput) {
            setTimeout(() => resetPasswordInput.focus(), 80);
        }
    }
}

function handleBackNavigation() {
    clearInlineError(currentPhase);
    if (currentPhase === 2) {
        goToPhase(1);
    } else if (currentPhase === 3) {
        // Invalidate OTP context and go to Phase 2 to edit number
        clearResendTimer();
        clearActiveOtpSession();
        otpSessionId = null;
        verifiedPhoneNumber = null;
        otpVerificationToken = null;
        goToPhase(2);
    } else if (currentPhase === 4) {
        goToPhase(3);
    } else if (currentPhase === 5) {
        goToPhase(4);
    } else if (currentPhase === 'reset') {
        goToPhase(2);
    }
}

// =============================================================================
// OTP Provider Configuration (MSG91 / Default)
// =============================================================================
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
            success: (data) => console.log("MSG91 success event:", data),
            failure: (error) => console.warn("MSG91 failure event:", error)
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
                    try { window.initSendOTP(window.configuration); } catch (e) {}
                }
                resolve(true);
            };
            script.onerror = () => resolve(false);
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

// =============================================================================
// Account Verification & Precheck (/api/auth/check-phone)
// =============================================================================
const phoneCheckCache = new Map();

async function checkPhoneAccount(formattedPhone) {
    if (!formattedPhone) return { exists: false };
    if (phoneCheckCache.has(formattedPhone)) {
        return phoneCheckCache.get(formattedPhone);
    }

    try {
        const response = await fetch("/api/auth/check-phone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: formattedPhone }),
            signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
            const data = await response.json().catch(() => ({}));
            if (data.ok) {
                const result = {
                    exists: Boolean(data.exists),
                    role: data.role || null,
                    email: data.email || null,
                    name: data.name || null
                };
                phoneCheckCache.set(formattedPhone, result);
                return result;
            }
        }
    } catch (e) {
        console.warn("Backend check-phone fallback warning:", e);
    }

    // Direct Firestore Phone Index Fallback
    try {
        const docSnap = await getDoc(doc(db, PHONE_INDEX_COLLECTION, formattedPhone));
        if (docSnap && docSnap.exists()) {
            const data = docSnap.data();
            const result = {
                exists: true,
                role: data.role || "passenger",
                email: data.email || null,
                name: data.name || null
            };
            phoneCheckCache.set(formattedPhone, result);
            return result;
        }
    } catch (e) {}

    const notFound = { exists: false, role: null, email: null };
    phoneCheckCache.set(formattedPhone, notFound);
    return notFound;
}

function updatePhase2UI() {
    clearInlineError(2);
    clearPhase2Notice();

    if (!existingAccountData || !existingAccountData.exists) {
        // New account signup
        if (phase2PasswordContainer) phase2PasswordContainer.classList.add('d-none');
        if (phase2LoginBtn) phase2LoginBtn.classList.add('d-none');
        if (phase2ContinueBtn) {
            phase2ContinueBtn.classList.remove('d-none');
            phase2ContinueLabel.textContent = t('auth.btn_continue', "Continue");
        }
        return;
    }

    // Existing account handling
    const isDriverAccount = existingAccountData.role === "driver";
    const remembered = getRememberedAccount(authIntent);
    const rawVal = phoneInput ? phoneInput.value.replace(/\D/g, "") : "";
    const welcomeName = (remembered && remembered.phone && remembered.phone.replace(/\D/g, "").endsWith(rawVal))
        ? remembered.name
        : (existingAccountData.name || null);

    if (authIntent === "driver" && !isDriverAccount) {
        // Existing passenger wanting to register as driver
        showPhase2Notice(t('auth.existing_passenger_driver_notice', "Existing passenger account found. Verify your number to register as a Captain / Driver."));
        if (phase2PasswordContainer) phase2PasswordContainer.classList.add('d-none');
        if (phase2LoginBtn) phase2LoginBtn.classList.add('d-none');
        if (phase2ContinueBtn) {
            phase2ContinueBtn.classList.remove('d-none');
            phase2ContinueLabel.textContent = t('auth.btn_continue', "Continue");
        }
    } else if (isDriverAccount) {
        // Existing driver account
        const noticeMsg = welcomeName
            ? t('auth.welcome_back_user', "Welcome back, {name}! Enter your password to continue.").replace('{name}', welcomeName)
            : t('auth.existing_driver_account_notice', "Captain / Driver account found. Enter your password to log in.");
        showPhase2Notice(noticeMsg);
        if (phase2PasswordContainer) phase2PasswordContainer.classList.remove('d-none');
        if (phase2LoginBtn) phase2LoginBtn.classList.remove('d-none');
        if (phase2ContinueBtn) phase2ContinueBtn.classList.add('d-none');
        if (loginPasswordInput) setTimeout(() => loginPasswordInput.focus(), 60);
    } else {
        // Existing passenger account normal login
        if (welcomeName) {
            showPhase2Notice(t('auth.welcome_back_user', "Welcome back, {name}! Enter your password to continue.").replace('{name}', welcomeName));
        }
        if (phase2PasswordContainer) phase2PasswordContainer.classList.remove('d-none');
        if (phase2LoginBtn) phase2LoginBtn.classList.remove('d-none');
        if (phase2ContinueBtn) phase2ContinueBtn.classList.add('d-none');
        if (loginPasswordInput) setTimeout(() => loginPasswordInput.focus(), 60);
    }
}

async function handlePhoneInputEvaluation() {
    const rawVal = phoneInput.value.replace(/\D/g, "").slice(0, 10);
    phoneInput.value = rawVal;
    clearInlineError(2);

    // If phone number is edited, clear password and invalidate previous OTP context
    if (loginPasswordInput) loginPasswordInput.value = "";
    verifiedPhoneNumber = null;
    otpVerificationToken = null;
    otpSessionId = null;
    clearActiveOtpSession();
    clearResendTimer();

    if (rawVal.length === 10) {
        const formatted = `+91${rawVal}`;
        const accountInfo = await checkPhoneAccount(formatted);
        // Ensure input hasn't changed during fetch
        if (phoneInput.value.replace(/\D/g, "") === rawVal) {
            existingAccountData = accountInfo;
            updatePhase2UI();
        }
    } else {
        existingAccountData = null;
        updatePhase2UI();
    }
}

async function handlePhase2Submit() {
    clearInlineError(2);
    const rawPhone = phoneInput.value.replace(/\D/g, "");

    if (!rawPhone || rawPhone.length === 0) {
        showInlineError(2, t('auth.err_missing_phone', "Enter your mobile number first."));
        phoneInput.focus();
        return;
    }

    if (rawPhone.length !== 10) {
        showInlineError(2, t('auth.mobile_number_ten_digits', "Mobile number must be 10 digits."));
        phoneInput.focus();
        return;
    }

    if (!/^[6-9]/.test(rawPhone)) {
        showInlineError(2, t('auth.mobile_number_start_digit', "Mobile number must start with 6, 7, 8, or 9."));
        phoneInput.focus();
        return;
    }

    const formatted = formatPhone(rawPhone);
    if (!formatted) {
        showInlineError(2, t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."));
        phoneInput.focus();
        return;
    }

    // If password container is visible, submit password login
    if (phase2PasswordContainer && !phase2PasswordContainer.classList.contains('d-none')) {
        loginWithPassword();
        return;
    }

    // Ensure account evaluation has completed
    phase2ContinueBtn.disabled = true;
    phase2ContinueLabel.textContent = t('auth.checking_account', "Checking...");

    try {
        let accountInfo = existingAccountData;
        if (!accountInfo) {
            accountInfo = await checkPhoneAccount(formatted);
            existingAccountData = accountInfo;
        }

        if (accountInfo.exists) {
            const isDriver = accountInfo.role === "driver";
            if (authIntent === "driver" && !isDriver) {
                // Existing passenger registering as driver -> proceed to OTP verification
                requestedPhoneNumber = formatted;
                goToPhase(3);
                return;
            }
            // Existing account with matching role -> reveal password login
            updatePhase2UI();
            if (loginPasswordInput) loginPasswordInput.focus();
            return;
        }

        // New account -> proceed to Phase 3 OTP verification
        requestedPhoneNumber = formatted;
        goToPhase(3);
    } catch (e) {
        console.error("Phase 2 submission error:", e);
        showInlineError(2, getAuthErrorMessage(e, "Could not verify phone. Please try again."));
    } finally {
        phase2ContinueBtn.disabled = false;
        phase2ContinueLabel.textContent = t('auth.btn_continue', "Continue");
    }
}

// =============================================================================
// Password Authentication (/login)
// =============================================================================
async function clearActiveAdminOrPriorSession() {
    sessionStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    if (auth.currentUser) {
        try { await signOut(auth); } catch (e) {}
    }
}

async function loginWithPassword() {
    clearInlineError(2);
    const rawPhone = phoneInput.value.replace(/\D/g, "");
    const formattedPhone = formatPhone(rawPhone);
    const password = (loginPasswordInput?.value || "").trim();

    if (!formattedPhone) {
        if (!rawPhone || rawPhone.length === 0) {
            showInlineError(2, t('auth.err_missing_phone', "Enter your mobile number first."));
        } else if (rawPhone.length !== 10) {
            showInlineError(2, t('auth.mobile_number_ten_digits', "Mobile number must be 10 digits."));
        } else {
            showInlineError(2, t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."));
        }
        phoneInput.focus();
        return;
    }

    if (!password) {
        showInlineError(2, t('auth.enter_password', "Enter your password."));
        loginPasswordInput.focus();
        return;
    }

    phase2LoginBtn.disabled = true;
    phase2LoginBtn.firstElementChild.textContent = t('common.logging_in', "Logging in...");
    loginFlowStarted = true;

    try {
        await clearActiveAdminOrPriorSession();

        // Resolve email to authenticate with Firebase Auth
        let email = existingAccountData?.email;
        if (!email) {
            const accountInfo = await checkPhoneAccount(formattedPhone);
            email = accountInfo.email;
        }

        if (!email) {
            email = `${formattedPhone.replace(/\D/g, "")}@user.liphtup.in`;
        }

        const result = await signInWithEmailAndPassword(auth, email, password);
        const token = await result.user.getIdToken(true);

        // Fetch user profile from Firestore or backend
        let userDocSnap;
        try {
            userDocSnap = await getDoc(doc(db, "users", result.user.uid));
        } catch (e) {
            console.warn("Firestore profile fetch error:", e);
        }

        let profileData = userDocSnap?.exists() ? userDocSnap.data() : null;
        if (!profileData) {
            const res = await fetch("/api/profile", {
                headers: { "Authorization": `Bearer ${token}` }
            }).catch(() => null);
            if (res && res.ok) {
                const data = await res.json();
                profileData = data.profile;
            }
        }

        if (!profileData) {
            await signOut(auth);
            throw new Error(t('auth.no_profile_found', "Login successful, but no LiphtUp profile was found. Please contact support."));
        }

        routeToHome(profileData);
    } catch (error) {
        console.error("Login failed:", error);
        const errMsg = getAuthErrorMessage(error, t('auth.login_failed', "Could not login. Please check your credentials and try again."));
        showInlineError(2, errMsg);
        phase2LoginBtn.disabled = false;
        phase2LoginBtn.firstElementChild.textContent = t('auth.btn_login_now', "Login Now");
    }
}

// =============================================================================
// OTP Sending & Resend Logic
// =============================================================================
function clearResendTimer() {
    if (resendTimerId !== null) {
        clearInterval(resendTimerId);
        resendTimerId = null;
    }
}

function startResendTimer(initialSeconds = OTP_RESEND_DELAY_SECONDS) {
    clearResendTimer();
    let secondsRemaining = initialSeconds;

    if (secondsRemaining <= 0) {
        if (phase3ResendWrap) phase3ResendWrap.classList.add('d-none');
        if (phase3ResendBtn) phase3ResendBtn.classList.remove('d-none');
        return;
    }

    if (phase3ResendWrap) phase3ResendWrap.classList.remove('d-none');
    if (phase3ResendBtn) phase3ResendBtn.classList.add('d-none');
    if (phase3ResendTimer) phase3ResendTimer.textContent = formatCountdownTime(secondsRemaining);

    resendTimerId = setInterval(() => {
        secondsRemaining -= 1;
        if (secondsRemaining <= 0) {
            clearResendTimer();
            if (phase3ResendWrap) phase3ResendWrap.classList.add('d-none');
            if (phase3ResendBtn) phase3ResendBtn.classList.remove('d-none');
            return;
        }
        if (phase3ResendTimer) phase3ResendTimer.textContent = formatCountdownTime(secondsRemaining);
    }, 1000);
}

async function sendOTP(purposeOverride = null) {
    if (otpRequestInProgress) return;

    const formatted = requestedPhoneNumber || formatPhone(phoneInput.value);
    if (!formatted) {
        showInlineError(2, t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."));
        goToPhase(2);
        return;
    }

    otpRequestInProgress = true;
    loginFlowStarted = true;
    if (phase3VerifyBtn) {
        phase3VerifyBtn.disabled = true;
        phase3VerifyBtn.firstElementChild.textContent = t('auth.sending_otp', "Sending OTP...");
    }

    const purpose = purposeOverride || (authIntent === "reset" ? "reset" : (authIntent === "driver" ? "driver_register" : "register"));

    try {
        if (activeOtpProvider === "msg91") {
            if (msg91Config) await initMsg91Sdk(msg91Config);
            if (!window.sendOtp) {
                throw new Error("OTP service is initializing. Please try again in a moment.");
            }

            // Reserve slot on server
            const reserveRes = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: formatted, purpose, isRetry: false })
            });
            const reserveData = await reserveRes.json().catch(() => ({}));
            if (!reserveRes.ok || !reserveData.ok) {
                throw new Error(reserveData.error || reserveData.message || t('auth.send_otp_failed', "Could not send OTP."));
            }

            // Dispatch via MSG91
            const identifier = toMsg91Identifier(formatted);
            await new Promise((resolve, reject) => {
                window.sendOtp(
                    identifier,
                    async (data) => {
                        const reqId = typeof data === 'object' && data !== null
                            ? String(data.message || data.reqId || data.data?.reqId || "")
                            : String(data || "");
                        if (reqId) {
                            fetch("/api/otp/session", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ phone: formatted, purpose, reqId })
                            }).catch(() => {});
                            otpSessionId = reqId;
                        } else {
                            otpSessionId = `msg91_${Date.now()}`;
                        }
                        resolve(data);
                    },
                    (err) => reject(new Error(typeof err === 'object' ? err.message || JSON.stringify(err) : String(err)))
                );
            });
        } else {
            const response = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: formatted, purpose })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.otpSessionId) {
                throw new Error(data.error || data.message || t('auth.send_otp_failed', "Could not send OTP."));
            }
            otpSessionId = data.otpSessionId;
        }

        requestedPhoneNumber = formatted;
        saveActiveOtpSession(formatted, otpSessionId, authIntent, activeOtpProvider);
        startResendTimer();
        initWebOtpListener();
    } catch (error) {
        console.error("sendOTP error:", error);
        showInlineError(3, getAuthErrorMessage(error, t('auth.send_otp_failed', "Could not send OTP. Please try again.")));
    } finally {
        otpRequestInProgress = false;
        if (phase3VerifyBtn) {
            phase3VerifyBtn.disabled = false;
            phase3VerifyBtn.firstElementChild.textContent = t('auth.btn_verify_otp', "Verify OTP");
        }
    }
}

async function resendOTP() {
    if (!requestedPhoneNumber) return;
    phase3ResendBtn.disabled = true;
    clearInlineError(3);

    try {
        const purpose = authIntent === "reset" ? "reset" : (authIntent === "driver" ? "driver_register" : "register");
        if (activeOtpProvider === "msg91" && window.retryOtp) {
            const checkRes = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: requestedPhoneNumber, purpose, isRetry: true })
            });
            const checkData = await checkRes.json().catch(() => ({}));
            if (!checkRes.ok || !checkData.ok) {
                throw new Error(checkData.error || checkData.message || "Could not resend OTP.");
            }
            await new Promise((resolve, reject) => {
                window.retryOtp(
                    '11',
                    (data) => resolve(data),
                    (err) => reject(new Error(typeof err === 'object' ? err.message || JSON.stringify(err) : String(err))),
                    otpSessionId || undefined
                );
            });
        } else {
            const response = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: requestedPhoneNumber, purpose })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.otpSessionId) {
                throw new Error(data.error || data.message || "Could not resend OTP.");
            }
            otpSessionId = data.otpSessionId;
        }
        startResendTimer();
    } catch (error) {
        console.error("resendOTP error:", error);
        showInlineError(3, getAuthErrorMessage(error, "Could not resend OTP. Please wait and try again."));
    } finally {
        phase3ResendBtn.disabled = false;
    }
}

// =============================================================================
// OTP Input Boxes (Auto-advance, Backspace, Overwrite, Paste)
// =============================================================================
function clearOtpBoxes() {
    otpBoxes.forEach(box => {
        if (box) {
            box.value = "";
            box.classList.remove('filled');
        }
    });
}

function getEnteredOtp() {
    return otpBoxes.map(b => (b?.value || "")).join("");
}

function setupOtpBoxes() {
    otpBoxes.forEach((box, index) => {
        if (!box) return;

        box.addEventListener('input', (e) => {
            const raw = e.target.value.replace(/\D/g, "");
            // Taking slice(-1) enables overwriting when typing into an already filled box
            const char = raw ? raw.slice(-1) : "";
            e.target.value = char;
            e.target.classList.toggle('filled', Boolean(char));

            if (char && index < otpBoxes.length - 1) {
                otpBoxes[index + 1].focus();
            }

            if (getEnteredOtp().length === 6) {
                verifyOTP();
            }
        });

        box.addEventListener('keydown', (e) => {
            if (e.key === "Backspace") {
                if (!box.value && index > 0) {
                    otpBoxes[index - 1].focus();
                }
            } else if (e.key === "ArrowLeft" && index > 0) {
                otpBoxes[index - 1].focus();
            } else if (e.key === "ArrowRight" && index < otpBoxes.length - 1) {
                otpBoxes[index + 1].focus();
            } else if (e.key === "Enter") {
                verifyOTP();
            }
        });

        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData || window.clipboardData).getData('text');
            const digits = (pasted || "").replace(/\D/g, "").slice(0, 6);
            if (!digits) return;

            digits.split("").forEach((c, i) => {
                if (otpBoxes[i]) {
                    otpBoxes[i].value = c;
                    otpBoxes[i].classList.add('filled');
                }
            });

            const nextIndex = Math.min(digits.length, otpBoxes.length - 1);
            if (otpBoxes[nextIndex]) otpBoxes[nextIndex].focus();

            if (digits.length === 6) {
                verifyOTP();
            }
        });
    });
}

function initWebOtpListener() {
    if ('OTPCredential' in window) {
        const ac = new AbortController();
        navigator.credentials.get({
            otp: { transport: ['sms'] },
            signal: ac.signal
        }).then(otp => {
            if (otp && otp.code && otp.code.length === 6) {
                otp.code.split("").forEach((c, idx) => {
                    if (otpBoxes[idx]) {
                        otpBoxes[idx].value = c;
                        otpBoxes[idx].classList.add('filled');
                    }
                });
                verifyOTP();
            }
        }).catch(() => {});
    }
}

// =============================================================================
// OTP Verification (/api/verify-otp)
// =============================================================================
async function verifyOTP() {
    clearInlineError(3);
    const code = getEnteredOtp();
    if (code.length !== 6) {
        showInlineError(3, t('auth.enter_six_digit_pin', "Enter the full 6-digit confirmation pin."));
        return;
    }

    if (!requestedPhoneNumber) {
        showInlineError(3, t('auth.request_otp_first', "Please request an OTP first."));
        goToPhase(2);
        return;
    }

    phase3VerifyBtn.disabled = true;
    phase3VerifyBtn.firstElementChild.textContent = t('auth.verifying', "Verifying...");

    const purpose = authIntent === "reset" ? "reset" : (authIntent === "driver" ? "driver_register" : "register");

    try {
        if (activeOtpProvider === "msg91") {
            if (!window.verifyOtp) throw new Error("OTP verification service not ready.");

            const verifyResult = await new Promise((resolve, reject) => {
                window.verifyOtp(
                    code,
                    (data) => resolve(data),
                    (err) => reject(new Error(typeof err === 'object' ? err.message || JSON.stringify(err) : String(err))),
                    otpSessionId || undefined
                );
            });

            const accessToken = typeof verifyResult === 'object' && verifyResult !== null
                ? String(verifyResult.message || verifyResult.token || verifyResult.accessToken || verifyResult.jwt || "")
                : String(verifyResult || "");

            if (!accessToken) throw new Error("Could not retrieve verification token from MSG91.");

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
                throw new Error(data.error || data.message || t('auth.verify_otp_failed', "Could not verify OTP."));
            }

            verifiedPhoneNumber = data.phone || requestedPhoneNumber;
            otpVerificationToken = data.verificationToken;
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
                throw new Error(data.error || data.message || t('auth.verify_otp_failed', "Could not verify OTP."));
            }

            verifiedPhoneNumber = data.phone || requestedPhoneNumber;
            otpVerificationToken = data.verificationToken;
        }

        clearResendTimer();
        clearActiveOtpSession();

        if (authIntent === "reset") {
            goToPhase('reset');
        } else {
            goToPhase(4);
        }
    } catch (error) {
        console.error("verifyOTP error:", error);
        showInlineError(3, getAuthErrorMessage(error, t('auth.verify_otp_failed', "Could not verify OTP. Please try again.")));
    } finally {
        phase3VerifyBtn.disabled = false;
        phase3VerifyBtn.firstElementChild.textContent = t('auth.btn_verify_otp', "Verify OTP");
    }
}

// =============================================================================
// Avatar Compression with HTML5 Canvas
// =============================================================================
function setupAvatarUpload() {
    if (!avatarFileInput) return;

    const handleFile = (file) => {
        if (!file || !file.type.startsWith('image/')) {
            showInlineError(4, "Please select an image file (JPG or PNG).");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const maxDim = 320;
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > maxDim) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    }
                } else {
                    if (height > maxDim) {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
                avatarBase64 = compressedDataUrl;

                if (avatarImg) {
                    avatarImg.src = compressedDataUrl;
                    avatarImg.style.display = 'block';
                }
                if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
                if (avatarBtnText) avatarBtnText.textContent = t('auth.change_photo', "Change");
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    };

    avatarFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    if (avatarPreviewWrap) {
        avatarPreviewWrap.addEventListener('click', () => avatarFileInput.click());
        avatarPreviewWrap.addEventListener('keydown', (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                avatarFileInput.click();
            }
        });
    }

    if (avatarPickerBtn) {
        avatarPickerBtn.addEventListener('click', () => avatarFileInput.click());
    }
}

// =============================================================================
// Gender & Vehicle Selection Cards
// =============================================================================
function setupInteractiveCards() {
    // Gender Cards
    const genderCards = document.querySelectorAll('.wizard-gender-card');
    genderCards.forEach(card => {
        card.addEventListener('click', () => {
            genderCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const val = card.getAttribute('data-gender') || "Male";
            if (regGenderInput) regGenderInput.value = val;
        });
    });

    // Vehicle Cards
    const vehicleCards = document.querySelectorAll('.wizard-vehicle-card');
    vehicleCards.forEach(card => {
        card.addEventListener('click', () => {
            vehicleCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const val = card.getAttribute('data-vehicle') || "bike";
            if (driverVehicleType) driverVehicleType.value = val;
        });
    });
}

// =============================================================================
// Password Show/Hide Toggle Controller
// =============================================================================
function setupPasswordToggles() {
    const toggleButtons = document.querySelectorAll('.gy-password-toggle');
    toggleButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const wrapper = btn.closest('.gy-input-wrapper');
            const input = wrapper ? wrapper.querySelector('input') : null;
            if (!input) return;

            const isPassword = input.type === "password";
            input.type = isPassword ? "text" : "password";

            const eyeOpen = btn.querySelector('.eye-open');
            const eyeClosed = btn.querySelector('.eye-closed');

            if (eyeOpen && eyeClosed) {
                eyeOpen.classList.toggle('d-none', isPassword);
                eyeClosed.classList.toggle('d-none', !isPassword);
            }

            btn.setAttribute('aria-label', isPassword ? "Hide password" : "Show password");
            btn.setAttribute('aria-pressed', String(isPassword));
        });
    });
}

// =============================================================================
// Phase 4 & Phase 5 Registration Submission
// =============================================================================
function validatePhase4() {
    clearInlineError(4);
    const name = (regNameInput?.value || "").trim();
    const email = (regEmailInput?.value || "").trim().toLowerCase();
    const password = (regPasswordInput?.value || "").trim();

    if (name.length < 2) {
        showInlineError(4, t('profile.enter_full_name', "Enter your full name."));
        regNameInput?.focus();
        return false;
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showInlineError(4, t('profile.enter_valid_email', "Enter a valid email address."));
        regEmailInput?.focus();
        return false;
    }

    if (password.length < 6) {
        showInlineError(4, t('auth.err_weak_password', "Password must be at least 6 characters."));
        regPasswordInput?.focus();
        return false;
    }

    return true;
}

async function handlePhase4Submit() {
    if (!validatePhase4()) return;

    if (authIntent === "driver") {
        goToPhase(5);
        return;
    }

    // Passenger Account Registration
    if (!verifiedPhoneNumber || !otpVerificationToken) {
        showInlineError(4, t('auth.phone_session_missing', "Phone verification session is missing. Please verify again."));
        goToPhase(2);
        return;
    }

    phase4SubmitBtn.disabled = true;
    phase4SubmitLabel.textContent = t('auth.creating_account', "Creating account...");

    const name = regNameInput.value.trim();
    const email = (regEmailInput.value || "").trim().toLowerCase();
    const password = regPasswordInput.value;
    const gender = regGenderInput?.value || "Male";

    const profileData = {
        name,
        email: email || "",
        role: "passenger",
        gender,
        ...(avatarBase64 ? { photoURL: avatarBase64 } : {})
    };

    try {
        await clearActiveAdminOrPriorSession();

        const response = await fetch("/api/register-account", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                verificationToken: otpVerificationToken,
                password,
                profile: profileData
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok || !data.customToken || !data.profile) {
            throw new Error(data.error || data.message || t('auth.registration_failed', "Could not create account."));
        }

        await signInWithCustomToken(auth, data.customToken);
        routeToHome(data.profile);
    } catch (error) {
        console.error("Passenger registration failed:", error);
        showInlineError(4, getAuthErrorMessage(error, t('auth.registration_failed', "Could not create account. Please try again.")));
        phase4SubmitBtn.disabled = false;
        phase4SubmitLabel.textContent = t('auth.btn_create_account', "Create Account");
    }
}

function validatePhase5() {
    clearInlineError(5);
    const vehicleNumber = (driverVehicleNumber?.value || "").trim().toUpperCase();
    const vehicleModel = (driverVehicleModel?.value || "").trim();
    const licenseNumber = (driverLicenseNumber?.value || "").trim().toUpperCase();
    const upiId = (driverUpiId?.value || "").trim().toLowerCase();

    if (!vehicleNumber || !/^[A-Z0-9 -]{4,20}$/.test(vehicleNumber)) {
        showInlineError(5, t('profile.enter_valid_vehicle_number', "Enter a valid vehicle registration number."));
        driverVehicleNumber?.focus();
        return false;
    }

    if (vehicleModel.length < 2) {
        showInlineError(5, t('profile.enter_vehicle_model', "Enter your vehicle model."));
        driverVehicleModel?.focus();
        return false;
    }

    if (!licenseNumber || !/^[A-Z0-9 -]{5,30}$/.test(licenseNumber)) {
        showInlineError(5, t('profile.enter_valid_driving_licence', "Enter a valid driving licence number."));
        driverLicenseNumber?.focus();
        return false;
    }

    if (!upiId || !/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/.test(upiId)) {
        showInlineError(5, t('profile.enter_valid_upi', "Enter a valid UPI ID (e.g. name@upi)."));
        driverUpiId?.focus();
        return false;
    }

    if (!driverAgreement?.checked) {
        showInlineError(5, t('auth.must_accept_terms', "Please agree to LiphtUp's Terms & Conditions and Privacy Policy."));
        driverAgreement?.focus();
        return false;
    }

    return true;
}

async function handlePhase5Submit() {
    if (!validatePhase5()) return;

    if (!verifiedPhoneNumber || !otpVerificationToken) {
        showInlineError(5, t('auth.phone_session_missing', "Phone verification session is missing. Please verify again."));
        goToPhase(2);
        return;
    }

    phase5SubmitBtn.disabled = true;
    phase5SubmitBtn.firstElementChild.textContent = t('auth.creating_account', "Creating Driver Account...");

    const name = regNameInput.value.trim();
    const email = (regEmailInput.value || "").trim().toLowerCase();
    const gender = regGenderInput?.value || "Male";
    const password = regPasswordInput.value;
    const vehicleType = driverVehicleType.value || "bike";
    const vehicleNumber = driverVehicleNumber.value.trim().toUpperCase();
    const vehicleModel = driverVehicleModel.value.trim();
    const drivingLicenseNumber = driverLicenseNumber.value.trim().toUpperCase();
    const upiId = driverUpiId.value.trim().toLowerCase();

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
        termsAccepted: true,
        ...(avatarBase64 ? { photoURL: avatarBase64 } : {})
    };

    try {
        await clearActiveAdminOrPriorSession();

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
            throw new Error(data.error || data.message || t('auth.registration_failed', "Could not create driver account."));
        }

        await signInWithCustomToken(auth, data.customToken);
        routeToHome(data.profile);
    } catch (error) {
        console.error("Driver registration failed:", error);
        showInlineError(5, getAuthErrorMessage(error, t('auth.registration_failed', "Could not create driver account. Please try again.")));
        phase5SubmitBtn.disabled = false;
        phase5SubmitBtn.firstElementChild.textContent = t('auth.create_driver_account', "Create Account");
    }
}

// =============================================================================
// Password Reset Flow
// =============================================================================
async function handlePasswordResetSubmit() {
    clearInlineError('reset');
    const newPassword = (resetPasswordInput?.value || "").trim();
    const confirmPassword = (resetConfirmPasswordInput?.value || "").trim();

    if (newPassword.length < 6) {
        showInlineError('reset', t('auth.err_weak_password', "Password must be at least 6 characters."));
        resetPasswordInput?.focus();
        return;
    }

    if (newPassword !== confirmPassword) {
        showInlineError('reset', t('auth.passwords_do_not_match', "Passwords do not match."));
        resetConfirmPasswordInput?.focus();
        return;
    }

    if (!otpVerificationToken) {
        showInlineError('reset', t('auth.otp_session_missing', "OTP session missing. Please verify again."));
        goToPhase(2);
        return;
    }

    resetSubmitBtn.disabled = true;
    resetSubmitBtn.firstElementChild.textContent = t('auth.updating_password', "Updating...");

    try {
        const response = await fetch("/api/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                verificationToken: otpVerificationToken,
                password: newPassword
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.error || data.message || t('auth.update_password_failed', "Could not update password."));
        }

        await showAppAlert(t('auth.password_updated_success', "Password updated successfully. You can now login."));
        authIntent = "passenger";
        goToPhase(2);
        if (loginPasswordInput) {
            loginPasswordInput.value = "";
            loginPasswordInput.focus();
        }
    } catch (error) {
        console.error("Password reset error:", error);
        showInlineError('reset', getAuthErrorMessage(error, t('auth.update_password_failed', "Could not update password. Please try again.")));
    } finally {
        resetSubmitBtn.disabled = false;
        resetSubmitBtn.firstElementChild.textContent = t('profile.save_password', "Save Password");
    }
}

// =============================================================================
// Session Cache & Redirection
// =============================================================================
function saveActiveOtpSession(phone, sessionId, intent, provider) {
    try {
        sessionStorage.setItem(ACTIVE_OTP_SESSION_KEY, JSON.stringify({
            phone,
            sessionId,
            intent,
            provider,
            sentAt: Date.now()
        }));
    } catch (e) {}
}

function clearActiveOtpSession() {
    try { sessionStorage.removeItem(ACTIVE_OTP_SESSION_KEY); } catch (e) {}
}

function restoreActiveOtpSession() {
    try {
        const raw = sessionStorage.getItem(ACTIVE_OTP_SESSION_KEY);
        if (!raw) return false;
        const session = JSON.parse(raw);
        const ageMs = Date.now() - Number(session.sentAt || 0);
        if (!session.phone || ageMs > 10 * 60 * 1000) {
            clearActiveOtpSession();
            return false;
        }

        requestedPhoneNumber = session.phone;
        otpSessionId = session.sessionId;
        authIntent = session.intent || "passenger";
        if (session.provider) activeOtpProvider = session.provider;

        if (phoneInput) phoneInput.value = session.phone.replace(/^\+91/, "");
        goToPhase(3);

        const remaining = Math.max(0, OTP_RESEND_DELAY_SECONDS - Math.floor(ageMs / 1000));
        startResendTimer(remaining);
        return true;
    } catch (e) {
        clearActiveOtpSession();
        return false;
    }
}

function cacheUserProfile(profile) {
    const { createdAt, cachedAt, ...cacheable } = profile;
    try {
        const payload = JSON.stringify({ ...cacheable, cachedAt: Date.now() });
        sessionStorage.setItem(PROFILE_CACHE_KEY, payload);
        localStorage.setItem(PROFILE_CACHE_KEY, payload);
    } catch (e) {}
}

function routeToHome(profile) {
    if (profile) {
        saveRememberedAccount(profile);
    }
    cacheUserProfile(profile);
    const urlParams = new URLSearchParams(window.location.search);
    let pendingRideId = urlParams.get('rideId');
    if (!pendingRideId && window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.consumePendingRideId === 'function') {
        pendingRideId = window.LiphtUpNativeStatus.consumePendingRideId();
    }

    const redirectTarget = urlParams.get('redirect') || urlParams.get('url');
    if (redirectTarget) {
        try {
            const cleanTarget = decodeURIComponent(redirectTarget);
            if (/^\/[a-zA-Z0-9_\-\.\/?=&%#]*$/.test(cleanTarget) && !cleanTarget.startsWith('//')) {
                const isDriverTarget = cleanTarget.includes('/driver') || cleanTarget.includes('driver-service') || cleanTarget.includes('driver-payments');
                if (profile.role === "driver" && isDriverTarget) {
                    window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(cleanTarget) : cleanTarget);
                    return;
                } else if (profile.role !== "driver" && !isDriverTarget) {
                    window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(cleanTarget) : cleanTarget);
                    return;
                }
            }
        } catch (e) {}
    }

    if (profile.role === "driver") {
        if (pendingRideId) {
            const target = `/driver-service.html?rideId=${encodeURIComponent(pendingRideId)}&from=push`;
            window.location.replace(window.getPlatformUrl ? window.getPlatformUrl(target) : target);
            return;
        }
        window.location.replace(window.getPlatformUrl ? window.getPlatformUrl("/driver.html") : "/driver.html");
    } else {
        window.location.replace(window.getPlatformUrl ? window.getPlatformUrl("/index.html") : "/index.html");
    }
}

// =============================================================================
// Event Listeners Initialization
// =============================================================================
function initEventListeners() {
    // Back navigation
    if (backBtn) backBtn.addEventListener('click', handleBackNavigation);

    // Phase 1
    if (phase1ContinueBtn) {
        phase1ContinueBtn.addEventListener('click', async () => {
            authIntent = "passenger";
            const remembered = getRememberedAccount('passenger');
            if (remembered && remembered.phone) {
                // If there's an already active user session matching this account, restore it
                if (auth.currentUser && auth.currentUser.uid === remembered.uid) {
                    try {
                        const snap = await getDoc(doc(db, "users", remembered.uid));
                        if (snap.exists()) {
                            routeToHome(snap.data());
                            return;
                        }
                    } catch (e) {}
                }
                phoneInput.value = remembered.phone.replace(/^\+91/, "");
                goToPhase(2);
                await handlePhoneInputEvaluation();
                showPhase2Notice(t('auth.welcome_back_user', 'Welcome back, {name}! Enter your password to continue.').replace('{name}', remembered.name));
                if (loginPasswordInput) {
                    setTimeout(() => loginPasswordInput.focus(), 100);
                }
            } else {
                phoneInput.value = "";
                existingAccountData = null;
                goToPhase(2);
            }
        });
    }

    if (phase1SwitchPassengerBtn) {
        phase1SwitchPassengerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            forgetRememberedAccount('passenger');
            if (phoneInput && authIntent === 'passenger') {
                phoneInput.value = "";
                existingAccountData = null;
            }
            updateWelcomeScreenRememberedAccounts();
        });
    }

    if (phase1DriverSignupBtn) {
        phase1DriverSignupBtn.addEventListener('click', async () => {
            authIntent = "driver";
            const remembered = getRememberedAccount('driver');
            if (remembered && remembered.phone) {
                // If there's an already active user session matching this account, restore it
                if (auth.currentUser && auth.currentUser.uid === remembered.uid) {
                    try {
                        const snap = await getDoc(doc(db, "users", remembered.uid));
                        if (snap.exists()) {
                            routeToHome(snap.data());
                            return;
                        }
                    } catch (e) {}
                }
                phoneInput.value = remembered.phone.replace(/^\+91/, "");
                goToPhase(2);
                await handlePhoneInputEvaluation();
                showPhase2Notice(t('auth.welcome_back_user', 'Welcome back, {name}! Enter your password to continue.').replace('{name}', remembered.name));
                if (loginPasswordInput) {
                    setTimeout(() => loginPasswordInput.focus(), 100);
                }
            } else {
                phoneInput.value = "";
                existingAccountData = null;
                goToPhase(2);
            }
        });
    }

    if (phase1SwitchDriverBtn) {
        phase1SwitchDriverBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            forgetRememberedAccount('driver');
            if (phoneInput && authIntent === 'driver') {
                phoneInput.value = "";
                existingAccountData = null;
            }
            updateWelcomeScreenRememberedAccounts();
        });
    }

    // Phase 2
    if (phoneInput) {
        phoneInput.addEventListener('input', handlePhoneInputEvaluation);
        phoneInput.addEventListener('keydown', (e) => {
            if (e.key === "Enter") {
                handlePhase2Submit();
            }
        });
    }
    if (loginPasswordInput) {
        loginPasswordInput.addEventListener('keydown', (e) => {
            if (e.key === "Enter") loginWithPassword();
        });
    }
    if (phase2ContinueBtn) {
        phase2ContinueBtn.addEventListener('click', handlePhase2Submit);
    }
    if (phase2LoginBtn) {
        phase2LoginBtn.addEventListener('click', loginWithPassword);
    }
    if (phase2ForgotPasswordLink) {
        phase2ForgotPasswordLink.addEventListener('click', () => {
            const formatted = formatPhone(phoneInput.value);
            if (!formatted) {
                showInlineError(2, t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number."));
                phoneInput.focus();
                return;
            }
            requestedPhoneNumber = formatted;
            authIntent = "reset";
            goToPhase(3);
        });
    }

    // Phase 3
    if (phase3EditPhoneBtn) {
        phase3EditPhoneBtn.addEventListener('click', () => {
            clearResendTimer();
            clearActiveOtpSession();
            otpSessionId = null;
            verifiedPhoneNumber = null;
            otpVerificationToken = null;
            goToPhase(2);
        });
    }
    if (phase3VerifyBtn) {
        phase3VerifyBtn.addEventListener('click', verifyOTP);
    }
    if (phase3ResendBtn) {
        phase3ResendBtn.addEventListener('click', resendOTP);
    }

    // Phase 4
    if (phase4SubmitBtn) {
        phase4SubmitBtn.addEventListener('click', handlePhase4Submit);
    }

    // Phase 5
    if (phase5SubmitBtn) {
        phase5SubmitBtn.addEventListener('click', handlePhase5Submit);
    }

    // Reset Phase
    if (resetSubmitBtn) {
        resetSubmitBtn.addEventListener('click', handlePasswordResetSubmit);
    }
}

// =============================================================================
// Initialization on DOM Ready & URL Parsing
// =============================================================================
setupOtpBoxes();
setupAvatarUpload();
setupInteractiveCards();
setupPasswordToggles();
initEventListeners();
fetchOtpConfig();
updateWelcomeScreenRememberedAccounts();
window.addEventListener('language-changed', () => {
    updateWelcomeScreenRememberedAccounts();
});

// URL Query Param Routing
const urlParams = new URLSearchParams(window.location.search);
const paramIntent = urlParams.get('intent') || urlParams.get('role');
const paramMode = urlParams.get('mode');
const paramPhone = urlParams.get('phone');

if (paramPhone && phoneInput) {
    phoneInput.value = paramPhone.replace(/\D/g, "").slice(0, 10);
}

if (paramIntent === 'driver' || paramMode === 'driver') {
    authIntent = "driver";
    goToPhase(2);
    if (paramPhone) handlePhoneInputEvaluation();
} else if (paramMode === 'register' || paramIntent === 'passenger') {
    authIntent = "passenger";
    goToPhase(2);
    if (paramPhone) handlePhoneInputEvaluation();
} else {
    // Check if an existing OTP session can be restored
    const restored = restoreActiveOtpSession();
    if (!restored) {
        goToPhase(1);
    }
}

// Monitor Auth Session
onAuthStateChanged(auth, async (user) => {
    if (!user || loginFlowStarted) {
        hideInitialLoader();
        return;
    }
    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (userDocSnap.exists()) {
            routeToHome(userDocSnap.data());
        } else {
            hideInitialLoader();
        }
    } catch (e) {
        console.warn("Existing auth session lookup failed:", e);
        hideInitialLoader();
    }
});
