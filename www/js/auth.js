import { auth, db } from './firebase-init.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const isDevelopmentMode = true; 

// DOM Selectors
const phoneInputContainer = document.getElementById('phone-input-container');
const otpInputContainer = document.getElementById('otp-input-container');
const registrationContainer = document.getElementById('registration-container');

// 1. Trigger Verification Code SMS
async function sendOTP() {
    const rawPhone = document.getElementById('phone-number').value.trim();
    if (rawPhone.length !== 10) {
        alert("Please enter a valid 10-digit mobile number.");
        return;
    }

    if (isDevelopmentMode && (rawPhone === "9999999999" || rawPhone === "8888888888")) {
        console.log(`[SANDBOX] Bypassing SMS for phone: ${rawPhone}`);
        phoneInputContainer.classList.add('d-none');
        otpInputContainer.classList.remove('d-none');
        return;
    }

    alert("Please use sandbox numbers 9999999999 or 8888888888 for free local testing.");
}

// 2. Validate Code Token and Route User
async function verifyOTP() {
    const code = document.getElementById('otp-code').value.trim();
    const rawPhone = document.getElementById('phone-number').value.trim();

    if (code.length !== 6) {
        alert("Enter the full 6-digit confirmation pin.");
        return;
    }

    if (isDevelopmentMode && (rawPhone === "9999999999" || rawPhone === "8888888888") && code === "123456") {
        // Generate entirely different IDs so they don't overwrite each other!
        const sandboxUid = `sandbox_uid_${rawPhone}`;
        const userDocRef = doc(db, "users", sandboxUid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
            handleUserRouting(userDocSnap.data());
        } else {
            otpInputContainer.classList.add('d-none');
            registrationContainer.classList.remove('d-none');
        }
        return;
    }

    alert("Incorrect code! Use the test code: 123456");
}

// 3. Complete Registration Profile Documents
async function finalizeRegistration() {
    const name = document.getElementById('user-name').value.trim();
    const role = document.getElementById('user-role').value;
    const rawPhone = document.getElementById('phone-number').value.trim();
    const sandboxUid = `sandbox_uid_${rawPhone}`;

    if (!name) {
        alert("Name field cannot be blank.");
        return;
    }

    const profileData = {
        uid: sandboxUid,
        name: name,
        phone: `+91${rawPhone}`,
        role: role,
        createdAt: serverTimestamp()
    };

    try {
        await setDoc(doc(db, "users", sandboxUid), profileData);
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