import { auth, db } from './firebase-init.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "goyatra_user_profile";

let confirmationResult = null;
let verifiedFirebaseUser = null;
let recaptchaVerifier = null;
let loginFlowStarted = false;

const phoneInputContainer = document.getElementById('phone-input-container');
const otpInputContainer = document.getElementById('otp-input-container');
const registrationContainer = document.getElementById('registration-container');
const userRoleSelect = document.getElementById('user-role');
const driverVerificationFields = document.getElementById('driver-verification-fields');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const registerBtn = document.getElementById('register-btn');
const changePhoneBtn = document.getElementById('change-phone-btn');

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
    window.location.replace("index.html");
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
    otpInputContainer.classList.add('d-none');
    registrationContainer.classList.add('d-none');
    phoneInputContainer.classList.remove('d-none');
    sendOtpBtn.disabled = false;
    sendOtpBtn.innerText = "Send OTP";
    verifyOtpBtn.disabled = false;
    verifyOtpBtn.innerText = "Verify & Login";
}

function getFormattedPhoneNumber() {
    const rawPhone = document.getElementById('phone-number').value.trim();

    if (!/^\d{10}$/.test(rawPhone)) {
        alert("Please enter a valid 10-digit mobile number.");
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
    const phoneNumber = getFormattedPhoneNumber();
    if (!phoneNumber) return;

    loginFlowStarted = true;
    sendOtpBtn.disabled = true;
    sendOtpBtn.innerText = "Sending OTP...";

    try {
        confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, ensureRecaptchaVerifier());
        console.log(`Firebase OTP sent to ${phoneNumber}`);
        phoneInputContainer.classList.add('d-none');
        otpInputContainer.classList.remove('d-none');
        document.getElementById('otp-code').focus();
    } catch (error) {
        console.error("Firebase phone sign-in failed:", error);
        alert(error.message || "Failed to send OTP. Check Firebase Phone Auth setup.");
        sendOtpBtn.disabled = false;
        sendOtpBtn.innerText = "Send OTP";
    }
}

async function verifyOTP() {
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
    verifyOtpBtn.innerText = "Verifying...";

    try {
        const result = await confirmationResult.confirm(code);
        verifiedFirebaseUser = result.user;

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
        alert("Incorrect OTP or expired verification. Please try again.");
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.innerText = "Verify & Login";
    }
}

async function finalizeRegistration() {
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
        const vehicleNumber = document.getElementById('driver-vehicle-number').value.trim().toUpperCase();
        const vehicleModel = document.getElementById('driver-vehicle-model').value.trim();
        const licenseNumber = document.getElementById('driver-license-number').value.trim().toUpperCase();
        const upiId = document.getElementById('driver-upi-id').value.trim();

        if (!profilePhotoUrl || !vehicleNumber || !vehicleModel || !licenseNumber || !upiId) {
            alert("Drivers must add profile photo, vehicle number, vehicle model, driving licence number, and UPI ID.");
            return;
        }

        Object.assign(profileData, {
            profilePhotoUrl,
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
    registerBtn.innerText = "Creating account...";

    try {
        await setDoc(doc(db, "users", currentAuthUser.uid), profileData);
        console.log(`Saved profile to Firestore: ${name} as ${role}`);
        routeToHome(profileData);
    } catch (error) {
        console.error("Firestore Write Exception:", error);
        alert("Failed to save profile registration.");
        registerBtn.disabled = false;
        registerBtn.innerText = "Create Account";
    }
}

sendOtpBtn.addEventListener('click', sendOTP);
verifyOtpBtn.addEventListener('click', verifyOTP);
registerBtn.addEventListener('click', finalizeRegistration);
changePhoneBtn.addEventListener('click', resetToPhoneStep);
userRoleSelect.addEventListener('change', updateRegistrationFieldsForRole);
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
