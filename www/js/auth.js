import { auth, db } from './firebase-init.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let confirmationResult = null;
let verifiedFirebaseUser = null;
let recaptchaVerifier = null;

// DOM Selectors
const phoneInputContainer = document.getElementById('phone-input-container');
const otpInputContainer = document.getElementById('otp-input-container');
const registrationContainer = document.getElementById('registration-container');
const userRoleSelect = document.getElementById('user-role');
const driverVerificationFields = document.getElementById('driver-verification-fields');

function updateRegistrationFieldsForRole() {
    if (!userRoleSelect || !driverVerificationFields) return;

    if (userRoleSelect.value === "driver") {
        driverVerificationFields.classList.remove('d-none');
    } else {
        driverVerificationFields.classList.add('d-none');
    }
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

// 1. Trigger Verification Code SMS
async function sendOTP() {
    const phoneNumber = getFormattedPhoneNumber();
    if (!phoneNumber) return;

    const sendBtn = document.getElementById('send-otp-btn');
    sendBtn.disabled = true;
    sendBtn.innerText = "Sending OTP...";

    try {
        confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, ensureRecaptchaVerifier());
        console.log(`Firebase OTP sent to ${phoneNumber}`);
        phoneInputContainer.classList.add('d-none');
        otpInputContainer.classList.remove('d-none');
    } catch (error) {
        console.error("Firebase phone sign-in failed:", error);
        alert(error.message || "Failed to send OTP. Check Firebase Phone Auth setup.");
        sendBtn.disabled = false;
        sendBtn.innerText = "Send OTP";
    }
}

// 2. Validate Code Token and Route User
async function verifyOTP() {
    const code = document.getElementById('otp-code').value.trim();

    if (code.length !== 6) {
        alert("Enter the full 6-digit confirmation pin.");
        return;
    }

    if (!confirmationResult) {
        alert("Please request an OTP first.");
        return;
    }

    const verifyBtn = document.getElementById('verify-otp-btn');
    verifyBtn.disabled = true;
    verifyBtn.innerText = "Verifying...";

    try {
        const result = await confirmationResult.confirm(code);
        verifiedFirebaseUser = result.user;

        const userDocRef = doc(db, "users", verifiedFirebaseUser.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
            handleUserRouting(userDocSnap.data());
        } else {
            otpInputContainer.classList.add('d-none');
            registrationContainer.classList.remove('d-none');
        }
    } catch (error) {
        console.error("OTP verification failed:", error);
        alert("Incorrect OTP or expired verification. Please try again.");
        verifyBtn.disabled = false;
        verifyBtn.innerText = "Verify & Login";
    }
}

// 3. Complete Registration Profile Documents
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
        name: name,
        phone: currentAuthUser.phoneNumber,
        email: email,
        role: role,
        profileCompleted: true,
        createdAt: serverTimestamp()
    };

    if (role === "driver") {
        const profilePhotoUrl = document.getElementById('driver-profile-photo').value.trim();
        const vehicleNumber = document.getElementById('driver-vehicle-number').value.trim().toUpperCase();
        const licenseNumber = document.getElementById('driver-license-number').value.trim().toUpperCase();
        const upiId = document.getElementById('driver-upi-id').value.trim();

        if (!profilePhotoUrl || !vehicleNumber || !licenseNumber || !upiId) {
            alert("Drivers must add profile photo, vehicle number, driving licence number, and UPI ID.");
            return;
        }

        Object.assign(profileData, {
            profilePhotoUrl: profilePhotoUrl,
            vehicleNumber: vehicleNumber,
            drivingLicenseNumber: licenseNumber,
            upiId: upiId,
            verificationStatus: "pending_review",
            driverAvailability: "searching",
            lifetime_earnings: 0,
            total_completed_trips: 0
        });
    }

    try {
        await setDoc(doc(db, "users", currentAuthUser.uid), profileData);
        console.log(`Saved profile to Firestore: ${name} as ${role}`);
        handleUserRouting(profileData);
    } catch (error) {
        console.error("Firestore Write Exception:", error);
        alert("Failed to save profile registration.");
    }
}

function handleUserRouting(userData) {
    document.getElementById('auth-view').classList.add('d-none');
    
    // Check role to unveil correct visual layout framework
    if (userData.role === "driver") {
        document.getElementById('driver-view').classList.remove('d-none');
        document.getElementById('driver-view').classList.add('d-flex');
    } else {
        document.getElementById('dashboard-view').classList.remove('d-none');
        document.getElementById('dashboard-view').classList.add('d-flex');
    }

    window.dispatchEvent(new CustomEvent('user-session-ready', { detail: userData }));
}

// Attach Event Handlers
document.getElementById('send-otp-btn').addEventListener('click', sendOTP);
document.getElementById('verify-otp-btn').addEventListener('click', verifyOTP);
document.getElementById('register-btn').addEventListener('click', finalizeRegistration);
userRoleSelect.addEventListener('change', updateRegistrationFieldsForRole);
updateRegistrationFieldsForRole();

onAuthStateChanged(auth, async (user) => {
    if (!user || currentUserHasSession()) return;

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (userDocSnap.exists()) {
            verifiedFirebaseUser = user;
            handleUserRouting(userDocSnap.data());
        }
    } catch (error) {
        console.warn("Existing auth session lookup failed:", error);
    }
});

function currentUserHasSession() {
    return document.getElementById('auth-view').classList.contains('d-none');
}
