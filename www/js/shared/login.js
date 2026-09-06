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

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const OTP_RESEND_DELAY_SECONDS = 60;
const PHONE_INDEX_COLLECTION = "phoneLoginIndex";

let verifiedFirebaseUser = null;
let verifiedPhoneNumber = null;
let otpSessionId = null;
let otpVerificationToken = null;
let loginFlowStarted = false;
let requestedPhoneNumber = null;
let resendTimerId = null;
let otpRequestInProgress = false;
let authMode = "login";
let activeOtpProvider = "existing";
let msg91Config = null;
let msg91ReadyPromise = null;

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

const passwordLoginContainer = document.getElementById('password-login-container');
const phoneInputContainer = document.getElementById('phone-input-container');
const otpInputContainer = document.getElementById('otp-input-container');
const resetPasswordContainer = document.getElementById('reset-password-container');
const registrationContainer = document.getElementById('registration-container');
const userRoleSelect = document.getElementById('user-role');
const driverVerificationFields = document.getElementById('driver-verification-fields');
const driverAgreementCheckbox = document.getElementById('driver-agreement-checkbox');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const passwordLoginBtn = document.getElementById('password-login-btn');
const forgotPasswordBtn = document.getElementById('forgot-password-btn');
const resetPasswordBtn = document.getElementById('reset-password-btn');
const resetBackBtn = document.getElementById('reset-back-btn');
const registerBtn = document.getElementById('register-btn');
const changePhoneBtn = document.getElementById('change-phone-btn');
const resendOtpBtn = document.getElementById('resend-otp-btn');
const authStatus = document.getElementById('auth-status');
const loginModeBtn = document.getElementById('login-mode-btn');
const registerModeBtn = document.getElementById('register-mode-btn');
const authEntryTitle = document.getElementById('auth-entry-title');
const authEntryCopy = document.getElementById('auth-entry-copy');

const accountExistsModal = document.getElementById('account-exists-modal');
const accountExistsCloseBtn = document.getElementById('account-exists-close-btn');
const accountExistsCloseX = document.getElementById('account-exists-close-x');
const accountExistsLoginBtn = document.getElementById('account-exists-login-btn');
const accountExistsPhoneDisplay = document.getElementById('account-exists-phone-display');

let modalPhoneTarget = null;

function showAccountExistsModal(phoneNumber) {
    modalPhoneTarget = phoneNumber;
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
    if (e.key === "Escape") {
        closeAccountExistsModal();
    }
}

function setVisible(element, visible) {
    element.classList.toggle('d-none', !visible);
}

function updateAuthModeUi() {
    const isRegistration = authMode === "register";
    const isReset = authMode === "reset";

    loginModeBtn.classList.toggle('active', authMode === "login" || isReset);
    registerModeBtn.classList.toggle('active', isRegistration);
    loginModeBtn.setAttribute('aria-selected', String(authMode === "login" || isReset));
    registerModeBtn.setAttribute('aria-selected', String(isRegistration));

    if (isRegistration) {
        authEntryTitle.textContent = t('auth.create_account_title', "Create your account");
        authEntryCopy.textContent = t('auth.create_account_sub', "Verify your mobile number, then complete your passenger or driver profile.");
        sendOtpBtn.textContent = t('auth.send_registration_otp', "Send Registration OTP");
        verifyOtpBtn.textContent = t('auth.verify_and_continue', "Verify & Continue");
        return;
    }

    if (isReset) {
        authEntryTitle.textContent = t('auth.reset_password_title', "Reset your password");
        authEntryCopy.textContent = t('auth.reset_password_sub', "Verify your registered mobile number, then create a new password.");
        sendOtpBtn.textContent = t('auth.send_reset_otp', "Send Reset OTP");
        verifyOtpBtn.textContent = t('auth.verify_otp', "Verify OTP");
        return;
    }

    authEntryTitle.textContent = t('auth.welcome_back', "Welcome back");
    authEntryCopy.textContent = t('auth.login_sub', "Login with your phone or email and password.");
}

function setAuthMode(mode) {
    if (!["login", "register", "reset"].includes(mode)) return;
    authMode = mode;
    resetAuthStep();
    updateAuthModeUi();
}

function setAuthStatus(message = "", isError = false) {
    authStatus.textContent = message;
    authStatus.classList.toggle('d-none', !message);
    authStatus.classList.toggle('is-error', Boolean(message) && isError);
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
            "auth/provider-already-linked": t('auth.err_provider_linked', "Password login is already enabled for this account."),
            "auth/requires-recent-login": t('auth.err_recent_login', "Please verify OTP again before changing your password."),
            "auth/user-not-found": t('auth.err_user_not_found', "No LiphtUp account was found for this phone or email."),
            "auth/wrong-password": t('auth.err_invalid_credential', "Phone/email or password is incorrect."),
            "auth/weak-password": t('auth.err_weak_password', "Use a password with at least 6 characters."),
            "auth/invalid-verification-code": t('auth.err_invalid_otp', "That OTP is incorrect. Check the SMS and try again."),
            "auth/code-expired": t('auth.err_otp_expired', "That OTP has expired. Request a new OTP."),
            "auth/session-expired": t('auth.err_session_expired', "This verification session has expired. Request a new OTP."),
            "auth/too-many-requests": t('auth.err_too_many_requests', "Too many attempts were made. Please wait before trying again."),
            "auth/quota-exceeded": t('auth.err_quota_exceeded', "The SMS sending limit has been reached. Please try again later."),
            "auth/captcha-check-failed": t('auth.err_security_failed', "The security check failed. Refresh the page and try again."),
            "auth/missing-app-credential": t('auth.err_security_failed', "The security check could not start. Refresh the page and try again."),
            "auth/operation-not-allowed": t('auth.err_operation_not_allowed', "Email/password or phone login is not enabled for this Firebase project."),
            "auth/unauthorized-domain": t('auth.err_unauthorized_domain', "This website domain is not authorized for phone login."),
            "auth/network-request-failed": t('auth.err_network', "Check your internet connection and try again.")
        };
        if (messages[error.code]) return messages[error.code];
    }

    if (typeof error === 'object' && error !== null) {
        return error.message || error.error || fallbackMessage;
    }

    return fallbackMessage;
}

function maskPhoneNumber(phoneNumber) {
    const nationalNumber = phoneNumber.replace(/^\+91/, "");
    return `+91 ******${nationalNumber.slice(-4)}`;
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function formatPhoneFromValue(value, showAlert = true) {
    const rawPhone = String(value || "").trim().replace(/\D/g, "");
    const nationalPhone = rawPhone.startsWith("91") && rawPhone.length === 12
        ? rawPhone.slice(2)
        : rawPhone;

    if (!/^[6-9]\d{9}$/.test(nationalPhone)) {
        if (showAlert) {
            const message = t('auth.enter_valid_phone', "Enter a valid 10-digit Indian mobile number.");
            setAuthStatus(message, true);
            showAppAlert(message);
        }
        return null;
    }

    return `+91${nationalPhone}`;
}

function getFormattedPhoneNumber() {
    return formatPhoneFromValue(document.getElementById('phone-number').value);
}

function clearResendTimer() {
    if (resendTimerId !== null) {
        window.clearInterval(resendTimerId);
        resendTimerId = null;
    }
}

function startResendTimer() {
    clearResendTimer();
    let secondsRemaining = OTP_RESEND_DELAY_SECONDS;
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = `${t('auth.resend_otp_in', 'Resend OTP in')} ${secondsRemaining}s`;

    resendTimerId = window.setInterval(() => {
        secondsRemaining -= 1;
        if (secondsRemaining <= 0) {
            clearResendTimer();
            resendOtpBtn.disabled = false;
            resendOtpBtn.textContent = t('auth.resend_otp', "Resend OTP");
            return;
        }
        resendOtpBtn.textContent = `${t('auth.resend_otp_in', 'Resend OTP in')} ${secondsRemaining}s`;
    }, 1000);
}

function cacheUserProfile(profile) {
    const { createdAt, cachedAt, ...cacheableProfile } = profile;
    try {
        sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        }));
    } catch (error) {
        console.warn("Could not cache profile for fast navigation:", error);
    }
}

function routeToHome(profile) {
    cacheUserProfile(profile);
    window.location.replace(profile.role === "driver" ? "/driver.html" : "/index.html");
}

function isDriverRegistration() {
    return userRoleSelect.value === "driver";
}

function updateRegistrationSubmitState() {
    if (registerBtn.textContent === t('auth.creating_account', "Creating account...")) return;
    registerBtn.disabled = isDriverRegistration() && !driverAgreementCheckbox.checked;
}

function updateRegistrationFieldsForRole() {
    driverVerificationFields.classList.toggle('d-none', !isDriverRegistration());
    updateRegistrationSubmitState();
}

function resetAuthStep() {
    verifiedFirebaseUser = null;
    verifiedPhoneNumber = null;
    otpSessionId = null;
    otpVerificationToken = null;
    requestedPhoneNumber = null;
    clearResendTimer();

    document.getElementById('otp-code').value = "";
    closeAccountExistsModal();
    setVisible(passwordLoginContainer, authMode === "login");
    setVisible(phoneInputContainer, authMode === "register" || authMode === "reset");
    setVisible(otpInputContainer, false);
    setVisible(resetPasswordContainer, false);
    setVisible(registrationContainer, false);

    sendOtpBtn.disabled = false;
    verifyOtpBtn.disabled = false;
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = t('auth.resend_otp', "Resend OTP");
    registerBtn.disabled = false;
    registerBtn.textContent = t('auth.register_btn', "Create Account");
    driverAgreementCheckbox.checked = false;
    updateRegistrationSubmitState();
    resetPasswordBtn.disabled = false;
    resetPasswordBtn.textContent = t('auth.update_password', "Update Password");
    setAuthStatus();

    window.setTimeout(() => {
        if (authMode === "login") {
            document.getElementById('login-identifier').focus();
        } else {
            document.getElementById('phone-number').focus();
        }
    }, 50);
}

async function checkPhoneExists(phoneNumber) {
    let clientChecked = false;
    // Fast path 1: direct Firestore client lookup (instant from local cache / live connection)
    try {
        const docSnap = await Promise.race([
            getDoc(doc(db, PHONE_INDEX_COLLECTION, phoneNumber)),
            new Promise((_, reject) => setTimeout(() => reject(new Error("firestore_timeout")), 600))
        ]);
        clientChecked = true;
        if (docSnap && docSnap.exists()) {
            const data = docSnap.data();
            if (data && (data.email || data.uid)) {
                return true;
            }
        }
        // If Firestore document does not exist, the user definitely does not exist in phoneLoginIndex
        return false;
    } catch (e) {
        console.warn("Direct Firestore check fallback triggered:", e);
    }

    // Fast path 2: Only fallback to backend endpoint if client Firestore connection timed out / errored
    if (!clientChecked) {
        try {
            const response = await fetch("/api/auth/check-phone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: phoneNumber }),
                signal: AbortSignal.timeout(800)
            });
            if (response.ok) {
                const data = await response.json().catch(() => ({}));
                if (data.ok && data.exists) {
                    return true;
                }
            }
        } catch (e) {
            console.warn("Backend check-phone warning:", e);
        }
    }

    return false;
}

async function sendOTP() {
    if (otpRequestInProgress) return;

    const phoneNumber = getFormattedPhoneNumber();
    if (!phoneNumber) return;

    otpRequestInProgress = true;
    loginFlowStarted = true;
    sendOtpBtn.disabled = true;
    resendOtpBtn.disabled = true;
    sendOtpBtn.textContent = t('auth.sending_otp', "Sending OTP...");
    resendOtpBtn.textContent = t('auth.sending_otp', "Sending OTP...");
    setAuthStatus(t('auth.requesting_otp', "Requesting a secure verification code..."));
    otpSessionId = null;
    otpVerificationToken = null;

    try {
        // Fast pre-check for registration: If phone number already exists, do not send OTP
        if (authMode === "register") {
            setAuthStatus(t('auth.checking_account', "Checking your account..."));
            const alreadyExists = await checkPhoneExists(phoneNumber);
            if (alreadyExists) {
                sendOtpBtn.disabled = false;
                resendOtpBtn.disabled = false;
                sendOtpBtn.textContent = t('auth.send_registration_otp', "Send Registration OTP");
                resendOtpBtn.textContent = t('auth.resend_otp', "Resend OTP");
                setAuthStatus();
                otpRequestInProgress = false;
                loginFlowStarted = false;

                showAccountExistsModal(phoneNumber);
                return;
            }
        }

        const purpose = authMode === "reset" ? "reset" : "register";

        if (activeOtpProvider === "msg91") {
            if (msg91Config) {
                await initMsg91Sdk(msg91Config);
            }
            if (!window.sendOtp) {
                throw new Error("OTP service is currently initializing. Please try again in a moment.");
            }

            // 1. Authorize send and reserve cooldown & rate-limit slot with LiphtUP server
            const reserveRes = await fetch("/api/send-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: phoneNumber, purpose, isRetry: false })
            });
            const reserveData = await reserveRes.json().catch(() => ({}));
            if (!reserveRes.ok || !reserveData.ok) {
                throw new Error(reserveData.error || reserveData.message || t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
            }

            // 2. Dispatch OTP via MSG91 Custom UI Web SDK
            const identifier = toMsg91Identifier(phoneNumber);
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
                                    body: JSON.stringify({ phone: phoneNumber, purpose, reqId })
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
                body: JSON.stringify({
                    phone: phoneNumber,
                    purpose
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.otpSessionId) {
                throw new Error(data.error || data.message || t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
            }

            otpSessionId = data.otpSessionId;
        }

        requestedPhoneNumber = phoneNumber;
        setVisible(phoneInputContainer, false);
        setVisible(otpInputContainer, true);
        const otpSentMsg = t('auth.sent_otp_to', "We sent a 6-digit OTP to");
        document.getElementById('otp-destination').textContent = `${otpSentMsg} ${maskPhoneNumber(phoneNumber)}.`;
        sendOtpBtn.textContent = authMode === "register" ? t('auth.send_registration_otp', "Send Registration OTP") : t('auth.send_reset_otp', "Send Reset OTP");
        setAuthStatus(t('auth.otp_sent_status', "OTP sent. It may take a few moments to arrive."));
        startResendTimer();
        document.getElementById('otp-code').focus();
    } catch (error) {
        console.error("OTP send failed:", error);
        const message = getAuthErrorMessage(error, t('auth.send_otp_failed', "Could not send the OTP. Please try again."));
        setAuthStatus(message, true);
        await showAppAlert(message);
        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = authMode === "register" ? t('auth.send_registration_otp', "Send Registration OTP") : t('auth.send_reset_otp', "Send Reset OTP");
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = t('auth.resend_otp', "Resend OTP");
    } finally {
        otpRequestInProgress = false;
    }
}

async function resendOTP() {
    if (!requestedPhoneNumber || resendOtpBtn.disabled) return;
    if (activeOtpProvider === "msg91" && window.retryOtp) {
        resendOtpBtn.disabled = true;
        setAuthStatus(t('auth.requesting_otp', "Requesting a new OTP..."));
        try {
            const purpose = authMode === "reset" ? "reset" : "register";
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
            setAuthStatus(t('auth.otp_sent_status', "New OTP sent. It may take a few moments to arrive."));
            startResendTimer();
        } catch (err) {
            console.error("MSG91 retryOtp failed:", err);
            const message = getAuthErrorMessage(err, "Could not resend OTP. Please try again.");
            setAuthStatus(message, true);
            await showAppAlert(message);
            resendOtpBtn.disabled = false;
        }
        return;
    }
    await sendOTP();
}

async function resolvePhoneLogin(phoneNumber) {
    try {
        const indexSnap = await getDoc(doc(db, PHONE_INDEX_COLLECTION, phoneNumber));
        return indexSnap.exists() ? indexSnap.data() : null;
    } catch (error) {
        console.warn("Phone login index lookup failed:", error);
        return null;
    }
}

async function getLoginEmail(identifier) {
    const trimmed = String(identifier || "").trim();
    if (trimmed.includes("@")) return normalizeEmail(trimmed);

    const phoneNumber = formatPhoneFromValue(trimmed);
    if (!phoneNumber) return null;

    const loginIndex = await resolvePhoneLogin(phoneNumber);
    if (!loginIndex?.email) {
        throw new Error(t('auth.no_account_for_phone', "No LiphtUp account was found for this mobile number. Please register first."));
    }

    return normalizeEmail(loginIndex.email);
}

async function clearActiveAdminOrPriorSession() {
    sessionStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    if (auth.currentUser) {
        try {
            await signOut(auth);
        } catch {
            // Ignore signout errors during session cleanup
        }
    }
}

async function loginWithPassword() {
    if (passwordLoginBtn.disabled) return;

    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;

    if (!identifier) {
        await showAppAlert(t('auth.enter_phone_or_email', "Enter your phone number or email address."));
        return;
    }

    if (!password) {
        await showAppAlert(t('auth.enter_password', "Enter your password."));
        return;
    }

    passwordLoginBtn.disabled = true;
    passwordLoginBtn.textContent = t('common.logging_in', "Logging in...");
    setAuthStatus();
    loginFlowStarted = true;

    try {
        await clearActiveAdminOrPriorSession();
        const email = await getLoginEmail(identifier);
        const result = await signInWithEmailAndPassword(auth, email, password);
        
        const token = await result.user.getIdToken(true);

        let userDocSnap;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                userDocSnap = await getDoc(doc(db, "users", result.user.uid));
                if (userDocSnap.exists()) break;
            } catch (docErr) {
                console.warn(`Direct Firestore profile lookup attempt ${attempt + 1} failed:`, docErr);
            }
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
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
            throw new Error(t('auth.no_profile_found', "Your login worked, but no LiphtUp profile was found. Please contact support."));
        }

        routeToHome(profileData);
    } catch (error) {
        console.error("Password login failed:", error);
        const message = getAuthErrorMessage(error, error.message || t('auth.login_failed', "Could not login. Please try again."));
        setAuthStatus(message, true);
        await showAppAlert(message);
        passwordLoginBtn.disabled = false;
        passwordLoginBtn.textContent = t('auth.login_btn', "Login");
    }
}

async function verifyOTP() {
    if (verifyOtpBtn.disabled) return;

    const code = document.getElementById('otp-code').value.trim();

    if (!/^\d{6}$/.test(code)) {
        await showAppAlert(t('auth.enter_six_digit_pin', "Enter the full 6-digit confirmation pin."));
        return;
    }

    if (!otpSessionId || !requestedPhoneNumber) {
        await showAppAlert(t('auth.request_otp_first', "Please request an OTP first."));
        return;
    }

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = t('auth.verifying', "Verifying...");
    setAuthStatus(t('auth.verifying_otp_status', "Verifying your OTP..."));

    try {
        const purpose = authMode === "reset" ? "reset" : "register";

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
                            : String(error || "That OTP is incorrect or expired.");
                        reject(new Error(errMsg));
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
                throw new Error(data.error || data.message || t('auth.verify_otp_failed', "Could not verify the OTP. Please try again."));
            }

            verifiedPhoneNumber = data.phone || requestedPhoneNumber;
            otpVerificationToken = data.verificationToken;
        }

        clearResendTimer();
        setAuthStatus(t('auth.phone_verified_success', "Phone number verified successfully."));

        if (authMode === "register") {
            setVisible(otpInputContainer, false);
            setVisible(registrationContainer, true);
            authEntryTitle.textContent = t('auth.complete_profile_title', "Complete your profile");
            authEntryCopy.textContent = t('auth.complete_profile_sub', "Add your email and password for future logins.");
            document.getElementById('user-name').focus();
            return;
        }

        if (authMode === "reset") {
            setVisible(otpInputContainer, false);
            setVisible(resetPasswordContainer, true);
            authEntryTitle.textContent = t('auth.create_new_password_title', "Create new password");
            authEntryCopy.textContent = t('auth.create_new_password_sub', "Use this password for phone/email login from now on.");
            document.getElementById('reset-password').focus();
        }
    } catch (error) {
        console.error("OTP verification failed:", error);
        const message = getAuthErrorMessage(error, error.message || t('auth.verify_otp_failed', "Could not verify the OTP. Please try again."));
        setAuthStatus(message, true);
        await showAppAlert(message);
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = authMode === "register" ? t('auth.verify_and_continue', "Verify & Continue") : t('auth.verify_otp', "Verify OTP");
    }
}

function validatePasswordPair(password, confirmPassword) {
    if (password.length < 6) return t('auth.err_weak_password', "Password must be at least 6 characters.");
    if (password !== confirmPassword) return t('auth.passwords_do_not_match', "Password and confirm password do not match.");
    return "";
}

function getRegistrationPasswordError() {
    return validatePasswordPair(
        document.getElementById('user-password').value,
        document.getElementById('user-confirm-password').value
    );
}

async function finalizeRegistration() {
    if (registerBtn.disabled) return;

    const name = document.getElementById('user-name').value.trim();
    const email = normalizeEmail(document.getElementById('user-email').value);
    const role = document.getElementById('user-role').value;
    const password = document.getElementById('user-password').value;

    if (!verifiedPhoneNumber || !otpVerificationToken) {
        await showAppAlert(t('auth.phone_session_missing', "Your phone verification session is missing. Please verify OTP again."));
        return;
    }

    if (name.length < 2) {
        await showAppAlert(t('profile.enter_full_name', "Enter your full name."));
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await showAppAlert(t('profile.enter_valid_email', "Please enter a valid email address."));
        return;
    }

    const passwordError = getRegistrationPasswordError();
    if (passwordError) {
        await showAppAlert(passwordError);
        return;
    }

    const profileData = { name, email, role };

    if (role === "driver") {
        const vehicleType = document.getElementById('driver-vehicle-type').value;
        const vehicleNumber = document.getElementById('driver-vehicle-number').value.trim().toUpperCase();
        const vehicleModel = document.getElementById('driver-vehicle-model').value.trim();
        const licenseNumber = document.getElementById('driver-license-number').value.trim().toUpperCase();
        const upiId = document.getElementById('driver-upi-id').value.trim();

        if (!vehicleType || !vehicleNumber || !vehicleModel || !licenseNumber || !upiId) {
            await showAppAlert(t('auth.driver_details_required', "Drivers must select Bike or Auto and add all required vehicle and payment details."));
            return;
        }

        if (!driverAgreementCheckbox.checked) {
            await showAppAlert(t('auth.driver_agreement_required', "Please agree to LiphtUp's Terms and Conditions & Privacy Policy to create a driver account."));
            return;
        }

        Object.assign(profileData, {
            vehicleType,
            vehicle_type: vehicleType,
            vehicleNumber,
            vehicle_number: vehicleNumber,
            vehicleModel,
            vehicle_model: vehicleModel,
            drivingLicenseNumber: licenseNumber,
            upiId,
            termsAccepted: true,
            verificationStatus: "pending_review",
            driverAvailability: "searching",
            lifetime_earnings: 0,
            total_completed_trips: 0
        });
    }

    registerBtn.disabled = true;
    registerBtn.textContent = t('auth.creating_account', "Creating account...");
    setAuthStatus(t('auth.creating_account_status', "Creating your LiphtUp account..."));

    try {
        await clearActiveAdminOrPriorSession();
        const existingPhoneLogin = await resolvePhoneLogin(verifiedPhoneNumber);
        if (existingPhoneLogin?.email) {
            throw new Error(t('auth.account_exists_login', "An account already exists for this mobile number. Please login instead."));
        }

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
            throw new Error(data.error || data.message || t('auth.registration_failed', "Could not create account. Please try again."));
        }

        const result = await signInWithCustomToken(auth, data.customToken);
        verifiedFirebaseUser = result.user;
        const createdProfile = data.profile;
        console.log(`Saved profile to Firestore: ${name} as ${role}`);
        routeToHome(createdProfile);
    } catch (error) {
        console.error("Registration failed:", error);
        const message = getAuthErrorMessage(error, error.message || t('auth.registration_failed', "Your phone was verified, but the account could not be created. Please try again."));
        setAuthStatus(message, true);
        await showAppAlert(message);
        registerBtn.disabled = false;
        registerBtn.textContent = t('auth.register_btn', "Create Account");
        updateRegistrationSubmitState();
    }
}

async function updateForgottenPassword() {
    if (resetPasswordBtn.disabled) return;

    const newPassword = document.getElementById('reset-password').value;
    const confirmPassword = document.getElementById('reset-confirm-password').value;
    const passwordError = validatePasswordPair(newPassword, confirmPassword);

    if (!verifiedPhoneNumber || !otpVerificationToken) {
        await showAppAlert(t('auth.otp_session_missing', "Your OTP session is missing. Please verify again."));
        return;
    }

    if (passwordError) {
        await showAppAlert(passwordError);
        return;
    }

    resetPasswordBtn.disabled = true;
    resetPasswordBtn.textContent = t('auth.updating_password', "Updating...");
    setAuthStatus(t('auth.updating_password_status', "Updating your password..."));

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
            throw new Error(data.error || data.message || t('auth.update_password_failed', "Could not update your password. Please try again."));
        }

        await showAppAlert(t('auth.password_updated_success', "Password updated successfully."));
        document.getElementById('login-identifier').value = data.email || verifiedPhoneNumber;
        document.getElementById('login-password').value = "";
        setAuthMode("login");
    } catch (error) {
        console.error("Password reset failed:", error);
        const message = getAuthErrorMessage(error, error.message || t('auth.update_password_failed', "Could not update your password. Please try again."));
        setAuthStatus(message, true);
        await showAppAlert(message);
        resetPasswordBtn.disabled = false;
        resetPasswordBtn.textContent = t('auth.update_password', "Update Password");
    }
}

sendOtpBtn.addEventListener('click', sendOTP);
verifyOtpBtn.addEventListener('click', verifyOTP);
passwordLoginBtn.addEventListener('click', loginWithPassword);
forgotPasswordBtn.addEventListener('click', () => setAuthMode("reset"));
resetPasswordBtn.addEventListener('click', updateForgottenPassword);
resetBackBtn.addEventListener('click', async () => {
    if (auth.currentUser) await signOut(auth);
    setAuthMode("login");
});
registerBtn.addEventListener('click', finalizeRegistration);
resendOtpBtn.addEventListener('click', resendOTP);
changePhoneBtn.addEventListener('click', resetAuthStep);
loginModeBtn.addEventListener('click', () => setAuthMode("login"));
registerModeBtn.addEventListener('click', () => setAuthMode("register"));
userRoleSelect.addEventListener('change', updateRegistrationFieldsForRole);
driverAgreementCheckbox.addEventListener('change', updateRegistrationSubmitState);

if (accountExistsCloseBtn) {
    accountExistsCloseBtn.addEventListener('click', closeAccountExistsModal);
}
if (accountExistsCloseX) {
    accountExistsCloseX.addEventListener('click', closeAccountExistsModal);
}
if (accountExistsModal) {
    accountExistsModal.addEventListener('click', (e) => {
        if (e.target === accountExistsModal) {
            closeAccountExistsModal();
        }
    });
}
if (accountExistsLoginBtn) {
    accountExistsLoginBtn.addEventListener('click', () => {
        const phoneToFill = modalPhoneTarget ? modalPhoneTarget.replace(/^\+91/, "") : "";
        closeAccountExistsModal();
        setAuthMode("login");
        if (phoneToFill) {
            const loginIdentifier = document.getElementById('login-identifier');
            if (loginIdentifier) {
                loginIdentifier.value = phoneToFill;
                const loginPassword = document.getElementById('login-password');
                if (loginPassword) loginPassword.focus();
            }
        }
    });
}

document.getElementById('phone-number').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 10);
});
document.getElementById('phone-number').addEventListener('keydown', (event) => {
    if (event.key === "Enter") sendOTP();
});
document.getElementById('otp-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
document.getElementById('otp-code').addEventListener('keydown', (event) => {
    if (event.key === "Enter") verifyOTP();
});
document.getElementById('login-identifier').addEventListener('keydown', (event) => {
    if (event.key === "Enter") loginWithPassword();
});
document.getElementById('login-password').addEventListener('keydown', (event) => {
    if (event.key === "Enter") loginWithPassword();
});
document.getElementById('reset-confirm-password').addEventListener('keydown', (event) => {
    if (event.key === "Enter") updateForgottenPassword();
});

updateRegistrationFieldsForRole();
updateAuthModeUi();
resetAuthStep();
fetchOtpConfig();

window.addEventListener('languageChanged', () => {
    updateAuthModeUi();
});

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
    } catch (error) {
        console.warn("Existing auth session lookup failed:", error);
        hideInitialLoader();
    }
});
