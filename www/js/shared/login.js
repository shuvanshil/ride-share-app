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
        authEntryTitle.textContent = "Create your account";
        authEntryCopy.textContent = "Verify your mobile number, then complete your passenger or driver profile.";
        sendOtpBtn.textContent = "Send Registration OTP";
        verifyOtpBtn.textContent = "Verify & Continue";
        return;
    }

    if (isReset) {
        authEntryTitle.textContent = "Reset your password";
        authEntryCopy.textContent = "Verify your registered mobile number, then create a new password.";
        sendOtpBtn.textContent = "Send Reset OTP";
        verifyOtpBtn.textContent = "Verify OTP";
        return;
    }

    authEntryTitle.textContent = "Welcome back";
    authEntryCopy.textContent = "Login with your phone or email and password.";
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
            "auth/email-already-in-use": "This email is already linked to another account.",
            "auth/invalid-credential": "Phone/email or password is incorrect.",
            "auth/invalid-email": "Enter a valid email address.",
            "auth/invalid-phone-number": "Enter a valid 10-digit Indian mobile number.",
            "auth/missing-password": "Enter your password.",
            "auth/missing-phone-number": "Enter your mobile number first.",
            "auth/provider-already-linked": "Password login is already enabled for this account.",
            "auth/requires-recent-login": "Please verify OTP again before changing your password.",
            "auth/user-not-found": "No LiphtUp account was found for this phone or email.",
            "auth/wrong-password": "Phone/email or password is incorrect.",
            "auth/weak-password": "Use a password with at least 6 characters.",
            "auth/invalid-verification-code": "That OTP is incorrect. Check the SMS and try again.",
            "auth/code-expired": "That OTP has expired. Request a new OTP.",
            "auth/session-expired": "This verification session has expired. Request a new OTP.",
            "auth/too-many-requests": "Too many attempts were made. Please wait before trying again.",
            "auth/quota-exceeded": "The SMS sending limit has been reached. Please try again later.",
            "auth/captcha-check-failed": "The security check failed. Refresh the page and try again.",
            "auth/missing-app-credential": "The security check could not start. Refresh the page and try again.",
            "auth/operation-not-allowed": "Email/password or phone login is not enabled for this Firebase project.",
            "auth/unauthorized-domain": "This website domain is not authorized for phone login.",
            "auth/network-request-failed": "Check your internet connection and try again."
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
            const message = "Enter a valid 10-digit Indian mobile number.";
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
    resendOtpBtn.textContent = `Resend OTP in ${secondsRemaining}s`;

    resendTimerId = window.setInterval(() => {
        secondsRemaining -= 1;
        if (secondsRemaining <= 0) {
            clearResendTimer();
            resendOtpBtn.disabled = false;
            resendOtpBtn.textContent = "Resend OTP";
            return;
        }
        resendOtpBtn.textContent = `Resend OTP in ${secondsRemaining}s`;
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
    if (registerBtn.textContent === "Creating account...") return;
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
    setVisible(passwordLoginContainer, authMode === "login");
    setVisible(phoneInputContainer, authMode === "register" || authMode === "reset");
    setVisible(otpInputContainer, false);
    setVisible(resetPasswordContainer, false);
    setVisible(registrationContainer, false);

    sendOtpBtn.disabled = false;
    verifyOtpBtn.disabled = false;
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = "Resend OTP";
    registerBtn.disabled = false;
    registerBtn.textContent = "Create Account";
    driverAgreementCheckbox.checked = false;
    updateRegistrationSubmitState();
    resetPasswordBtn.disabled = false;
    resetPasswordBtn.textContent = "Update Password";
    setAuthStatus();

    window.setTimeout(() => {
        if (authMode === "login") {
            document.getElementById('login-identifier').focus();
        } else {
            document.getElementById('phone-number').focus();
        }
    }, 50);
}

async function sendOTP() {
    if (otpRequestInProgress) return;

    const phoneNumber = getFormattedPhoneNumber();
    if (!phoneNumber) return;

    otpRequestInProgress = true;
    loginFlowStarted = true;
    sendOtpBtn.disabled = true;
    resendOtpBtn.disabled = true;
    sendOtpBtn.textContent = "Sending OTP...";
    resendOtpBtn.textContent = "Sending OTP...";
    setAuthStatus("Requesting a secure verification code...");
    otpSessionId = null;
    otpVerificationToken = null;

    try {
        const response = await fetch("/api/send-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                phone: phoneNumber,
                purpose: authMode === "reset" ? "reset" : "register"
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok || !data.otpSessionId) {
            throw new Error(data.error || data.message || "Could not send the OTP. Please try again.");
        }

        otpSessionId = data.otpSessionId;
        requestedPhoneNumber = phoneNumber;
        console.log(`2Factor OTP sent to ${phoneNumber}`);
        setVisible(phoneInputContainer, false);
        setVisible(otpInputContainer, true);
        document.getElementById('otp-destination').textContent = `We sent a 6-digit OTP to ${maskPhoneNumber(phoneNumber)}.`;
        sendOtpBtn.textContent = authMode === "register" ? "Send Registration OTP" : "Send Reset OTP";
        setAuthStatus("OTP sent. It may take a few moments to arrive.");
        startResendTimer();
        document.getElementById('otp-code').focus();
    } catch (error) {
        console.error("2Factor OTP send failed:", error);
        const message = getAuthErrorMessage(error, "Could not send the OTP. Please try again.");
        setAuthStatus(message, true);
        await showAppAlert(message);
        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = authMode === "register" ? "Send Registration OTP" : "Send Reset OTP";
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = "Resend OTP";
    } finally {
        otpRequestInProgress = false;
    }
}

async function resendOTP() {
    if (!requestedPhoneNumber || resendOtpBtn.disabled) return;
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
        throw new Error("No LiphtUp account was found for this mobile number. Please register first.");
    }

    return normalizeEmail(loginIndex.email);
}

async function loginWithPassword() {
    if (passwordLoginBtn.disabled) return;

    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;

    if (!identifier) {
        await showAppAlert("Enter your phone number or email address.");
        return;
    }

    if (!password) {
        await showAppAlert("Enter your password.");
        return;
    }

    passwordLoginBtn.disabled = true;
    passwordLoginBtn.textContent = "Logging in...";
    setAuthStatus("Checking your account...");
    loginFlowStarted = true;

    try {
        const email = await getLoginEmail(identifier);
        const result = await signInWithEmailAndPassword(auth, email, password);
        const userDocSnap = await getDoc(doc(db, "users", result.user.uid));

        if (!userDocSnap.exists()) {
            await signOut(auth);
            throw new Error("Your login worked, but no LiphtUp profile was found. Please contact support.");
        }

        routeToHome(userDocSnap.data());
    } catch (error) {
        console.error("Password login failed:", error);
        const message = getAuthErrorMessage(error, error.message || "Could not login. Please try again.");
        setAuthStatus(message, true);
        await showAppAlert(message);
        passwordLoginBtn.disabled = false;
        passwordLoginBtn.textContent = "Login";
    }
}

async function verifyOTP() {
    if (verifyOtpBtn.disabled) return;

    const code = document.getElementById('otp-code').value.trim();

    if (!/^\d{6}$/.test(code)) {
        await showAppAlert("Enter the full 6-digit confirmation pin.");
        return;
    }

    if (!otpSessionId || !requestedPhoneNumber) {
        await showAppAlert("Please request an OTP first.");
        return;
    }

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = "Verifying...";
    setAuthStatus("Verifying your OTP...");

    try {
        const response = await fetch("/api/verify-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                phone: requestedPhoneNumber,
                otpSessionId,
                otp: code,
                purpose: authMode === "reset" ? "reset" : "register"
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok || !data.verificationToken) {
            throw new Error(data.error || data.message || "Could not verify the OTP. Please try again.");
        }

        verifiedPhoneNumber = data.phone || requestedPhoneNumber;
        otpVerificationToken = data.verificationToken;
        clearResendTimer();
        setAuthStatus("Phone number verified successfully.");

        if (authMode === "register") {
            const existingPhoneLogin = await resolvePhoneLogin(verifiedPhoneNumber);
            if (existingPhoneLogin?.email) {
                await showAppAlert("An account already exists for this mobile number. Please login or use forgot password.");
                setAuthMode("login");
                return;
            }

            setVisible(otpInputContainer, false);
            setVisible(registrationContainer, true);
            authEntryTitle.textContent = "Complete your profile";
            authEntryCopy.textContent = "Add your email and password for future logins.";
            document.getElementById('user-name').focus();
            return;
        }

        if (authMode === "reset") {
            setVisible(otpInputContainer, false);
            setVisible(resetPasswordContainer, true);
            authEntryTitle.textContent = "Create new password";
            authEntryCopy.textContent = "Use this password for phone/email login from now on.";
            document.getElementById('reset-password').focus();
        }
    } catch (error) {
        console.error("OTP verification failed:", error);
        const message = getAuthErrorMessage(error, error.message || "Could not verify the OTP. Please try again.");
        setAuthStatus(message, true);
        await showAppAlert(message);
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = authMode === "register" ? "Verify & Continue" : "Verify OTP";
    }
}

function validatePasswordPair(password, confirmPassword) {
    if (password.length < 6) return "Password must be at least 6 characters.";
    if (password !== confirmPassword) return "Password and confirm password do not match.";
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
        await showAppAlert("Your phone verification session is missing. Please verify OTP again.");
        return;
    }

    if (name.length < 2) {
        await showAppAlert("Enter your full name.");
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await showAppAlert("Please enter a valid email address.");
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
            await showAppAlert("Drivers must select Bike or Auto and add all required vehicle and payment details.");
            return;
        }

        if (!driverAgreementCheckbox.checked) {
            await showAppAlert("Please agree to LiphtUp's Terms and Conditions & Privacy Policy to create a driver account.");
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
    registerBtn.textContent = "Creating account...";
    setAuthStatus("Creating your LiphtUp account...");

    try {
        const existingPhoneLogin = await resolvePhoneLogin(verifiedPhoneNumber);
        if (existingPhoneLogin?.email) {
            throw new Error("An account already exists for this mobile number. Please login instead.");
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
            throw new Error(data.error || data.message || "Could not create account. Please try again.");
        }

        const result = await signInWithCustomToken(auth, data.customToken);
        verifiedFirebaseUser = result.user;
        const createdProfile = data.profile;
        console.log(`Saved profile to Firestore: ${name} as ${role}`);
        routeToHome(createdProfile);
    } catch (error) {
        console.error("Registration failed:", error);
        const message = getAuthErrorMessage(error, error.message || "Your phone was verified, but the account could not be created. Please try again.");
        setAuthStatus(message, true);
        await showAppAlert(message);
        registerBtn.disabled = false;
        registerBtn.textContent = "Create Account";
        updateRegistrationSubmitState();
    }
}

async function updateForgottenPassword() {
    if (resetPasswordBtn.disabled) return;

    const newPassword = document.getElementById('reset-password').value;
    const confirmPassword = document.getElementById('reset-confirm-password').value;
    const passwordError = validatePasswordPair(newPassword, confirmPassword);

    if (!verifiedPhoneNumber || !otpVerificationToken) {
        await showAppAlert("Your OTP session is missing. Please verify again.");
        return;
    }

    if (passwordError) {
        await showAppAlert(passwordError);
        return;
    }

    resetPasswordBtn.disabled = true;
    resetPasswordBtn.textContent = "Updating...";
    setAuthStatus("Updating your password...");

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
            throw new Error(data.error || data.message || "Could not update your password. Please try again.");
        }

        await showAppAlert("Password updated successfully.");
        document.getElementById('login-identifier').value = data.email || verifiedPhoneNumber;
        document.getElementById('login-password').value = "";
        setAuthMode("login");
    } catch (error) {
        console.error("Password reset failed:", error);
        const message = getAuthErrorMessage(error, error.message || "Could not update your password. Please try again.");
        setAuthStatus(message, true);
        await showAppAlert(message);
        resetPasswordBtn.disabled = false;
        resetPasswordBtn.textContent = "Update Password";
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
