import { auth, db } from './firebase-init.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "goyatra_user_profile";
const OTP_RESEND_DELAY_SECONDS = 60;

let confirmationResult = null;
let verifiedFirebaseUser = null;
let recaptchaVerifier = null;
let loginFlowStarted = false;
let requestedPhoneNumber = null;
let resendTimerId = null;
let otpRequestInProgress = false;

const phoneInputContainer = document.getElementById('phone-input-container');
const otpInputContainer = document.getElementById('otp-input-container');
const registrationContainer = document.getElementById('registration-container');
const userRoleSelect = document.getElementById('user-role');
const driverVerificationFields = document.getElementById('driver-verification-fields');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const registerBtn = document.getElementById('register-btn');
const changePhoneBtn = document.getElementById('change-phone-btn');
const resendOtpBtn = document.getElementById('resend-otp-btn');
const authStatus = document.getElementById('auth-status');

function setAuthStatus(message = "", isError = false) {
    authStatus.textContent = message;
    authStatus.classList.toggle('d-none', !message);
    authStatus.classList.toggle('is-error', Boolean(message) && isError);
}

function getAuthErrorMessage(error, fallbackMessage) {
    const messages = {
        "auth/invalid-phone-number": "Enter a valid 10-digit Indian mobile number.",
        "auth/missing-phone-number": "Enter your mobile number first.",
        "auth/invalid-verification-code": "That OTP is incorrect. Check the SMS and try again.",
        "auth/code-expired": "That OTP has expired. Request a new OTP.",
        "auth/session-expired": "This verification session has expired. Request a new OTP.",
        "auth/too-many-requests": "Too many attempts were made. Please wait before trying again.",
        "auth/quota-exceeded": "The SMS sending limit has been reached. Please try again later.",
        "auth/captcha-check-failed": "The security check failed. Refresh the page and try again.",
        "auth/missing-app-credential": "The security check could not start. Refresh the page and try again.",
        "auth/operation-not-allowed": "Phone login is not enabled for this Firebase project.",
        "auth/unauthorized-domain": "This website domain is not authorized for phone login.",
        "auth/network-request-failed": "Check your internet connection and try again."
    };

    return messages[error?.code] || fallbackMessage;
}

function maskPhoneNumber(phoneNumber) {
    const nationalNumber = phoneNumber.replace(/^\+91/, "");
    return `+91 ******${nationalNumber.slice(-4)}`;
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

function clearRecaptchaVerifier() {
    if (!recaptchaVerifier) return;

    recaptchaVerifier.clear();
    recaptchaVerifier = null;
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
    window.location.replace(profile.role === "driver" ? "driver.html" : "index.html");
}

function updateRegistrationFieldsForRole() {
    if (userRoleSelect.value === "driver") {
        driverVerificationFields.classList.remove('d-none');
    } else {
        driverVerificationFields.classList.add('d-none');
    }
}

function resetToPhoneStep() {
    confirmationResult = null;
    verifiedFirebaseUser = null;
    requestedPhoneNumber = null;
    clearResendTimer();
    clearRecaptchaVerifier();
    document.getElementById('otp-code').value = "";
    otpInputContainer.classList.add('d-none');
    registrationContainer.classList.add('d-none');
    phoneInputContainer.classList.remove('d-none');
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = "Send OTP";
    verifyOtpBtn.disabled = false;
    verifyOtpBtn.textContent = "Verify & Login";
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = "Resend OTP";
    setAuthStatus();
    document.getElementById('phone-number').focus();
}

function getFormattedPhoneNumber() {
    const rawPhone = document.getElementById('phone-number').value.trim();

    if (!/^[6-9]\d{9}$/.test(rawPhone)) {
        const message = "Enter a valid 10-digit Indian mobile number.";
        setAuthStatus(message, true);
        alert(message);
        return null;
    }

    return `+91${rawPhone}`;
}

function ensureRecaptchaVerifier() {
    if (recaptchaVerifier) return recaptchaVerifier;

    recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
        callback: () => {
            console.log("reCAPTCHA verification completed.");
        }
    });

    return recaptchaVerifier;
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
    confirmationResult = null;
    clearRecaptchaVerifier();

    try {
        confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, ensureRecaptchaVerifier());
        requestedPhoneNumber = phoneNumber;
        console.log(`Firebase OTP sent to ${phoneNumber}`);
        phoneInputContainer.classList.add('d-none');
        otpInputContainer.classList.remove('d-none');
        document.getElementById('otp-destination').textContent = `We sent a 6-digit OTP to ${maskPhoneNumber(phoneNumber)}.`;
        sendOtpBtn.textContent = "Send OTP";
        setAuthStatus("OTP sent. It may take a few moments to arrive.");
        startResendTimer();
        document.getElementById('otp-code').focus();
    } catch (error) {
        console.error("Firebase phone sign-in failed:", error);
        clearRecaptchaVerifier();
        const message = getAuthErrorMessage(error, "Could not send the OTP. Please try again.");
        setAuthStatus(message, true);
        alert(message);
        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = "Send OTP";
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

async function verifyOTP() {
    if (verifyOtpBtn.disabled) return;

    const code = document.getElementById('otp-code').value.trim();

    if (!/^\d{6}$/.test(code)) {
        alert("Enter the full 6-digit confirmation pin.");
        return;
    }

    if (!confirmationResult) {
        alert("Please request an OTP first.");
        return;
    }

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = "Verifying...";
    setAuthStatus("Verifying your OTP...");

    try {
        const result = await confirmationResult.confirm(code);
        verifiedFirebaseUser = result.user;
        clearResendTimer();
        setAuthStatus("Phone number verified successfully.");

        const userDocSnap = await getDoc(doc(db, "users", verifiedFirebaseUser.uid));
        if (userDocSnap.exists()) {
            routeToHome(userDocSnap.data());
        } else {
            otpInputContainer.classList.add('d-none');
            registrationContainer.classList.remove('d-none');
            document.getElementById('user-name').focus();
        }
    } catch (error) {
        console.error("OTP verification failed:", error);
        const message = getAuthErrorMessage(error, "Could not verify the OTP. Please try again.");
        setAuthStatus(message, true);
        alert(message);
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = "Verify & Login";
    }
}

async function finalizeRegistration() {
    if (registerBtn.disabled) return;

    const name = document.getElementById('user-name').value.trim();
    const email = document.getElementById('user-email').value.trim();
    const role = document.getElementById('user-role').value;
    const currentAuthUser = verifiedFirebaseUser || auth.currentUser;

    if (!currentAuthUser) {
        alert("Your login session is missing. Please verify OTP again.");
        return;
    }

    if (!name) {
        alert("Name field cannot be blank.");
        return;
    }

    if (!email || !email.includes("@")) {
        alert("Please enter a valid email address.");
        return;
    }

    const profileData = {
        uid: currentAuthUser.uid,
        name,
        phone: currentAuthUser.phoneNumber,
        email,
        role,
        profileCompleted: true,
        createdAt: serverTimestamp()
    };

    if (role === "driver") {
        const profilePhotoUrl = document.getElementById('driver-profile-photo').value.trim();
        const vehicleType = document.getElementById('driver-vehicle-type').value;
        const vehicleNumber = document.getElementById('driver-vehicle-number').value.trim().toUpperCase();
        const vehicleModel = document.getElementById('driver-vehicle-model').value.trim();
        const licenseNumber = document.getElementById('driver-license-number').value.trim().toUpperCase();
        const upiId = document.getElementById('driver-upi-id').value.trim();

        if (!profilePhotoUrl || !vehicleType || !vehicleNumber || !vehicleModel || !licenseNumber || !upiId) {
            alert("Drivers must select Bike or Auto and add all required vehicle and payment details.");
            return;
        }

        Object.assign(profileData, {
            profilePhotoUrl,
            vehicleType,
            vehicle_type: vehicleType,
            vehicleNumber,
            vehicle_number: vehicleNumber,
            vehicleModel,
            vehicle_model: vehicleModel,
            drivingLicenseNumber: licenseNumber,
            upiId,
            verificationStatus: "pending_review",
            driverAvailability: "searching",
            lifetime_earnings: 0,
            total_completed_trips: 0
        });
    }

    registerBtn.disabled = true;
    registerBtn.textContent = "Creating account...";
    setAuthStatus("Creating your GoYatra account...");

    try {
        await setDoc(doc(db, "users", currentAuthUser.uid), profileData);
        console.log(`Saved profile to Firestore: ${name} as ${role}`);
        routeToHome(profileData);
    } catch (error) {
        console.error("Firestore Write Exception:", error);
        const message = "Your phone was verified, but the profile could not be saved. Please try again.";
        setAuthStatus(message, true);
        alert(message);
        registerBtn.disabled = false;
        registerBtn.textContent = "Create Account";
    }
}

sendOtpBtn.addEventListener('click', sendOTP);
verifyOtpBtn.addEventListener('click', verifyOTP);
registerBtn.addEventListener('click', finalizeRegistration);
resendOtpBtn.addEventListener('click', resendOTP);
changePhoneBtn.addEventListener('click', resetToPhoneStep);
userRoleSelect.addEventListener('change', updateRegistrationFieldsForRole);
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
updateRegistrationFieldsForRole();

onAuthStateChanged(auth, async (user) => {
    if (!user || loginFlowStarted) return;

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (userDocSnap.exists()) {
            routeToHome(userDocSnap.data());
        } else {
            verifiedFirebaseUser = user;
            phoneInputContainer.classList.add('d-none');
            otpInputContainer.classList.add('d-none');
            registrationContainer.classList.remove('d-none');
        }
    } catch (error) {
        console.warn("Existing auth session lookup failed:", error);
    }
});
