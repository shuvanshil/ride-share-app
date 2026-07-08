import { auth, db } from './firebase-init.js';
import {
    doc,
    getDoc,
    serverTimestamp,
    setDoc,
    updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const APP_SHARE_URL = "https://liphtup.in/";
const APP_SHARE_TITLE = "LiphtUp";
const APP_SHARE_TEXT = "Book reliable local rides with LiphtUp. Join me and travel easily across Tripura.";
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SAVED_IMAGE_LENGTH = 650000;

const nameEl = document.getElementById('profile-user-name');
const phoneEl = document.getElementById('profile-user-phone');
const emailEl = document.getElementById('profile-user-email');
const avatarEl = document.getElementById('profile-avatar');
const editButton = document.getElementById('profile-edit-btn');
const editLayer = document.getElementById('profile-edit-layer');
const editForm = document.getElementById('profile-edit-form');
const editAvatar = document.getElementById('profile-edit-avatar');
const roleBadge = document.getElementById('profile-edit-role');
const driverFields = document.getElementById('profile-driver-fields');
const photoFileInput = document.getElementById('profile-photo-file');
const photoUrlInput = document.getElementById('profile-photo-url');
const removePhotoButton = document.getElementById('profile-photo-remove-btn');
const saveButton = document.getElementById('profile-save-btn');
const errorBox = document.getElementById('profile-edit-error');
const saveNotice = document.getElementById('profile-save-notice');
const shareLayer = document.getElementById('profile-share-layer');
const aboutLayer = document.getElementById('profile-about-layer');
const contactLayer = document.getElementById('profile-contact-layer');
const helpLayer = document.getElementById('profile-help-layer');
const privacyLayer = document.getElementById('profile-privacy-layer');
const safetyLayer = document.getElementById('profile-safety-layer');
const termsLayer = document.getElementById('profile-terms-layer');
const profileSessionButton = document.getElementById('profile-logout-btn');

const inputs = {
    name: document.getElementById('profile-edit-name'),
    email: document.getElementById('profile-edit-email'),
    phone: document.getElementById('profile-edit-phone'),
    vehicleType: document.getElementById('profile-edit-vehicle-type'),
    vehicleModel: document.getElementById('profile-edit-vehicle-model'),
    vehicleNumber: document.getElementById('profile-edit-vehicle-number'),
    license: document.getElementById('profile-edit-license'),
    upi: document.getElementById('profile-edit-upi')
};

let currentAuthUser = null;
let currentProfile = null;
let pendingPhotoValue = "";
let saveInProgress = false;
let noticeTimer = null;

function getInitials(name) {
    return String(name || "G")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("") || "G";
}

function renderAvatar(container, name, photoUrl) {
    container.replaceChildren();

    if (!photoUrl) {
        container.innerText = getInitials(name);
        return;
    }

    const photo = document.createElement('img');
    photo.src = photoUrl;
    photo.alt = `${name || "LiphtUp user"} profile photo`;
    photo.addEventListener('error', () => {
        container.replaceChildren();
        container.innerText = getInitials(name);
    }, { once: true });
    container.appendChild(photo);
}

function renderProfileSummary(profile = {}) {
    const displayName = profile.name || currentAuthUser?.displayName || "LiphtUp User";
    const phone = profile.phone || currentAuthUser?.phoneNumber || "Phone number unavailable";

    nameEl.innerText = displayName;
    phoneEl.innerText = phone;
    emailEl.innerText = profile.email || "";
    renderAvatar(avatarEl, displayName, profile.profilePhotoUrl || "");
}

function cacheProfile(profile) {
    const { createdAt, updatedAt, cachedAt, ...cacheableProfile } = profile;
    try {
        sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        }));
    } catch (error) {
        console.warn("Could not cache updated profile:", error);
    }
}

function showError(message) {
    errorBox.innerText = message;
    errorBox.classList.remove('d-none');
}

function clearError() {
    errorBox.innerText = "";
    errorBox.classList.add('d-none');
}

function showSaveNotice() {
    if (noticeTimer) window.clearTimeout(noticeTimer);
    saveNotice.classList.remove('d-none');
    noticeTimer = window.setTimeout(() => saveNotice.classList.add('d-none'), 2600);
}

function openFallbackShareSheet() {
    shareLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
}

function closeFallbackShareSheet() {
    shareLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openAboutSheet() {
    aboutLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-about-close-btn').focus(), 80);
}

function closeAboutSheet() {
    aboutLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openContactSheet() {
    contactLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-contact-close-btn').focus(), 80);
}

function closeContactSheet() {
    contactLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openHelpSheet() {
    helpLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-help-close-btn').focus(), 80);
}

function closeHelpSheet() {
    helpLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openPrivacySheet() {
    privacyLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-privacy-close-btn').focus(), 80);
}

function closePrivacySheet() {
    privacyLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openSafetySheet() {
    safetyLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-safety-close-btn').focus(), 80);
}

function closeSafetySheet() {
    safetyLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none') && termsLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openTermsSheet() {
    termsLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-terms-close-btn').focus(), 80);
}

function closeTermsSheet() {
    termsLayer.classList.add('d-none');
    if (editLayer.classList.contains('d-none') && aboutLayer.classList.contains('d-none') && contactLayer.classList.contains('d-none') && helpLayer.classList.contains('d-none') && privacyLayer.classList.contains('d-none') && safetyLayer.classList.contains('d-none') && shareLayer.classList.contains('d-none')) {
        document.body.classList.remove('profile-editor-open');
    }
}

async function copyShareLink() {
    try {
        await navigator.clipboard.writeText(APP_SHARE_URL);
    } catch {
        const temporaryInput = document.createElement('textarea');
        temporaryInput.value = APP_SHARE_URL;
        temporaryInput.setAttribute('readonly', '');
        temporaryInput.style.position = 'fixed';
        temporaryInput.style.opacity = '0';
        document.body.appendChild(temporaryInput);
        temporaryInput.select();
        document.execCommand('copy');
        temporaryInput.remove();
    }

    closeFallbackShareSheet();
    saveNotice.innerText = "LiphtUp link copied";
    showSaveNotice();
    window.setTimeout(() => {
        saveNotice.innerText = "Profile updated successfully";
    }, 2700);
}

function openShareChannel(channel) {
    const message = `${APP_SHARE_TEXT} ${APP_SHARE_URL}`;
    const urls = {
        whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(APP_SHARE_URL)}`,
        email: `mailto:?subject=${encodeURIComponent(APP_SHARE_TITLE)}&body=${encodeURIComponent(message)}`
    };

    if (channel === 'copy') {
        copyShareLink();
        return;
    }

    const target = urls[channel];
    if (target) {
        window.open(target, '_blank', 'noopener,noreferrer');
        closeFallbackShareSheet();
    }
}

async function shareLiphtUp() {
    const shareData = {
        title: APP_SHARE_TITLE,
        text: APP_SHARE_TEXT,
        url: APP_SHARE_URL
    };

    if (typeof navigator.share === 'function') {
        try {
            await navigator.share(shareData);
            return;
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.warn("Native app sharing failed; showing fallback options:", error);
        }
    }

    openFallbackShareSheet();
}

function setSavingState(isSaving) {
    saveInProgress = isSaving;
    saveButton.disabled = isSaving;
    saveButton.innerText = isSaving ? "Saving..." : "Save Changes";
    editForm.querySelectorAll('input, button').forEach((control) => {
        if (control !== saveButton) control.disabled = isSaving;
    });
}

function populateEditForm() {
    if (!currentProfile || !currentAuthUser) return;

    const isDriver = currentProfile.role === "driver";
    const photoUrl = currentProfile.profilePhotoUrl || "";

    inputs.name.value = currentProfile.name || currentAuthUser.displayName || "";
    inputs.email.value = currentProfile.email || "";
    inputs.phone.value = currentProfile.phone || currentAuthUser.phoneNumber || "";
    const vehicleText = `${currentProfile.vehicleModel || currentProfile.vehicle_model || ""}`.toLowerCase();
    inputs.vehicleType.value = currentProfile.vehicleType || currentProfile.vehicle_type
        || (/auto|rickshaw|tuk/.test(vehicleText) ? "auto" : /bike|scooter|activa|motorcycle/.test(vehicleText) ? "bike" : "");
    inputs.vehicleModel.value = currentProfile.vehicleModel || currentProfile.vehicle_model || "";
    inputs.vehicleNumber.value = currentProfile.vehicleNumber || currentProfile.vehicle_number || "";
    inputs.license.value = currentProfile.drivingLicenseNumber || "";
    inputs.upi.value = currentProfile.upiId || "";
    photoUrlInput.value = /^https?:\/\//i.test(photoUrl) ? photoUrl : "";
    photoFileInput.value = "";
    pendingPhotoValue = photoUrl;

    roleBadge.innerText = isDriver ? "Driver account" : "Passenger account";
    driverFields.classList.toggle('d-none', !isDriver);
    removePhotoButton.classList.toggle('d-none', !photoUrl);
    renderAvatar(editAvatar, inputs.name.value, photoUrl);
    clearError();
}

function openEditor() {
    if (!currentProfile || !currentAuthUser) return;
    populateEditForm();
    editLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => inputs.name.focus(), 80);
}

function closeEditor() {
    if (saveInProgress) return;
    editLayer.classList.add('d-none');
    document.body.classList.remove('profile-editor-open');
    clearError();
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("The selected image could not be read."));
        };
        image.src = objectUrl;
    });
}

async function compressProfilePhoto(file) {
    if (!file.type.startsWith('image/')) {
        throw new Error("Choose a JPG, PNG, or WebP image.");
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
        throw new Error("Choose an image smaller than 10 MB.");
    }

    const image = await loadImage(file);
    const maxDimension = 480;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    let quality = 0.8;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > MAX_SAVED_IMAGE_LENGTH && quality > 0.45) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    if (dataUrl.length > MAX_SAVED_IMAGE_LENGTH) {
        throw new Error("This image is still too large after resizing. Choose a smaller photo.");
    }

    return dataUrl;
}

function validateProfileForm() {
    const name = inputs.name.value.trim();
    const email = inputs.email.value.trim();
    const photoUrl = photoUrlInput.value.trim();
    const isDriver = currentProfile?.role === "driver";

    if (name.length < 2) return "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
    if (photoUrl && !/^https?:\/\/[^\s]+$/i.test(photoUrl)) return "Enter a valid profile photo URL.";

    if (isDriver) {
        const vehicleType = inputs.vehicleType.value;
        const vehicleModel = inputs.vehicleModel.value.trim();
        const vehicleNumber = inputs.vehicleNumber.value.trim();
        const license = inputs.license.value.trim();
        const upi = inputs.upi.value.trim();

        if (!pendingPhotoValue) return "A profile photo is required for driver accounts.";
        if (!vehicleType) return "Select Bike / Scooty or Auto as your ride service.";
        if (vehicleModel.length < 2) return "Enter the registered vehicle model.";
        if (!/^[A-Z0-9 -]{4,20}$/i.test(vehicleNumber)) return "Enter a valid vehicle number.";
        if (!/^[A-Z0-9 -]{5,30}$/i.test(license)) return "Enter a valid driving licence number.";
        if (!/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/i.test(upi)) return "Enter a valid UPI ID.";
    }

    return "";
}

async function saveProfile(event) {
    event.preventDefault();
    if (!currentAuthUser || !currentProfile || saveInProgress) return;

    if (photoUrlInput.value.trim()) {
        pendingPhotoValue = photoUrlInput.value.trim();
    }

    const validationError = validateProfileForm();
    if (validationError) {
        showError(validationError);
        return;
    }

    clearError();
    setSavingState(true);

    const name = inputs.name.value.trim();
    const email = inputs.email.value.trim().toLowerCase();
    const updates = {
        name,
        email,
        profilePhotoUrl: pendingPhotoValue,
        updatedAt: serverTimestamp()
    };

    if (currentProfile.role === "driver") {
        const vehicleType = inputs.vehicleType.value;
        const vehicleModel = inputs.vehicleModel.value.trim();
        const vehicleNumber = inputs.vehicleNumber.value.trim().toUpperCase();
        Object.assign(updates, {
            vehicleType,
            vehicle_type: vehicleType,
            vehicleModel,
            vehicle_model: vehicleModel,
            vehicleNumber,
            vehicle_number: vehicleNumber,
            drivingLicenseNumber: inputs.license.value.trim().toUpperCase(),
            upiId: inputs.upi.value.trim().toLowerCase()
        });
    }

    try {
        await updateDoc(doc(db, "users", currentAuthUser.uid), updates);

        if (currentProfile.role === "driver") {
            try {
                await setDoc(doc(db, "driverPresence", currentAuthUser.uid), {
                    name: updates.name,
                    phone: currentProfile.phone || currentAuthUser.phoneNumber || "",
                    profilePhotoUrl: updates.profilePhotoUrl,
                    vehicle_type: updates.vehicle_type,
                    vehicle_model: updates.vehicle_model,
                    vehicle_number: updates.vehicle_number,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            } catch (presenceError) {
                console.warn("Driver presence profile sync will retry from the driver console:", presenceError);
            }
        }

        currentProfile = { ...currentProfile, ...updates };
        cacheProfile(currentProfile);
        renderProfileSummary(currentProfile);
        setSavingState(false);
        closeEditor();
        showSaveNotice();
    } catch (error) {
        console.error("Profile update failed:", error);
        setSavingState(false);
        showError("Could not save your profile. Check your connection and try again.");
    }
}

function bindProfileActions() {
    document.querySelector('[data-action="rides"]').addEventListener('click', () => {
        window.location.href = 'history.html';
    });
    document.querySelector('[data-action="contact"]').addEventListener('click', openContactSheet);
    document.querySelector('[data-action="help"]').addEventListener('click', openHelpSheet);
    document.querySelector('[data-action="safety"]').addEventListener('click', openSafetySheet);
    document.querySelector('[data-action="refer"]').addEventListener('click', shareLiphtUp);
    document.querySelector('[data-action="about"]').addEventListener('click', openAboutSheet);
    document.querySelector('[data-action="terms"]').addEventListener('click', openTermsSheet);
    document.querySelector('[data-action="privacy"]').addEventListener('click', openPrivacySheet);

    editButton.addEventListener('click', openEditor);
    document.getElementById('profile-edit-close-btn').addEventListener('click', closeEditor);
    document.getElementById('profile-edit-cancel-btn').addEventListener('click', closeEditor);
    document.getElementById('profile-edit-backdrop').addEventListener('click', closeEditor);
    document.getElementById('profile-share-close-btn').addEventListener('click', closeFallbackShareSheet);
    document.getElementById('profile-share-backdrop').addEventListener('click', closeFallbackShareSheet);
    document.getElementById('profile-about-close-btn').addEventListener('click', closeAboutSheet);
    document.getElementById('profile-about-backdrop').addEventListener('click', closeAboutSheet);
    document.getElementById('profile-contact-close-btn').addEventListener('click', closeContactSheet);
    document.getElementById('profile-contact-backdrop').addEventListener('click', closeContactSheet);
    document.getElementById('profile-help-close-btn').addEventListener('click', closeHelpSheet);
    document.getElementById('profile-help-backdrop').addEventListener('click', closeHelpSheet);
    document.getElementById('profile-privacy-close-btn').addEventListener('click', closePrivacySheet);
    document.getElementById('profile-privacy-backdrop').addEventListener('click', closePrivacySheet);
    document.getElementById('profile-safety-close-btn').addEventListener('click', closeSafetySheet);
    document.getElementById('profile-safety-backdrop').addEventListener('click', closeSafetySheet);
    document.getElementById('profile-terms-close-btn').addEventListener('click', closeTermsSheet);
    document.getElementById('profile-terms-backdrop').addEventListener('click', closeTermsSheet);
    document.querySelectorAll('[data-share-channel]').forEach((button) => {
        button.addEventListener('click', () => openShareChannel(button.dataset.shareChannel));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !aboutLayer.classList.contains('d-none')) {
            closeAboutSheet();
        } else if (event.key === 'Escape' && !contactLayer.classList.contains('d-none')) {
            closeContactSheet();
        } else if (event.key === 'Escape' && !helpLayer.classList.contains('d-none')) {
            closeHelpSheet();
        } else if (event.key === 'Escape' && !privacyLayer.classList.contains('d-none')) {
            closePrivacySheet();
        } else if (event.key === 'Escape' && !safetyLayer.classList.contains('d-none')) {
            closeSafetySheet();
        } else if (event.key === 'Escape' && !termsLayer.classList.contains('d-none')) {
            closeTermsSheet();
        }
    });
    editForm.addEventListener('submit', saveProfile);

    inputs.name.addEventListener('input', () => {
        renderAvatar(editAvatar, inputs.name.value, pendingPhotoValue);
    });

    photoUrlInput.addEventListener('change', () => {
        const value = photoUrlInput.value.trim();
        if (!value) return;
        pendingPhotoValue = value;
        photoFileInput.value = "";
        removePhotoButton.classList.remove('d-none');
        renderAvatar(editAvatar, inputs.name.value, value);
    });

    photoFileInput.addEventListener('change', async () => {
        const file = photoFileInput.files?.[0];
        if (!file) return;

        clearError();
        try {
            pendingPhotoValue = await compressProfilePhoto(file);
            photoUrlInput.value = "";
            removePhotoButton.classList.remove('d-none');
            renderAvatar(editAvatar, inputs.name.value, pendingPhotoValue);
        } catch (error) {
            photoFileInput.value = "";
            showError(error.message || "Could not prepare this photo.");
        }
    });

    removePhotoButton.addEventListener('click', () => {
        pendingPhotoValue = "";
        photoUrlInput.value = "";
        photoFileInput.value = "";
        removePhotoButton.classList.add('d-none');
        renderAvatar(editAvatar, inputs.name.value, "");
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!shareLayer.classList.contains('d-none')) {
            closeFallbackShareSheet();
        } else if (!editLayer.classList.contains('d-none')) {
            closeEditor();
        }
    });

    profileSessionButton.addEventListener('click', async () => {
        if (!currentAuthUser) {
            window.location.href = 'login.html';
            return;
        }
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
        await signOut(auth);
        window.location.href = 'login.html';
    });
}

bindProfileActions();

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        currentAuthUser = null;
        currentProfile = null;
        nameEl.innerText = "Guest User";
        phoneEl.innerText = "Login to view your profile";
        emailEl.innerText = "";
        avatarEl.innerText = "G";
        editButton.disabled = true;
        profileSessionButton.innerText = "Login / Register";
        profileSessionButton.classList.add('is-login');
        profileSessionButton.classList.remove('d-none');
        document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.remove('d-none'));
        return;
    }

    currentAuthUser = user;
    editButton.disabled = false;
    profileSessionButton.innerText = "Log out";
    profileSessionButton.classList.remove('is-login');
    profileSessionButton.classList.remove('d-none');
    document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.add('d-none'));

    try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        currentProfile = userSnap.exists() ? userSnap.data() : {
            uid: user.uid,
            name: user.displayName || "LiphtUp User",
            phone: user.phoneNumber || "",
            role: "passenger"
        };
        renderProfileSummary(currentProfile);
        cacheProfile(currentProfile);
    } catch (error) {
        console.error("Profile load failed:", error);
        currentProfile = {
            uid: user.uid,
            name: user.displayName || "LiphtUp User",
            phone: user.phoneNumber || "",
            role: "passenger"
        };
        renderProfileSummary(currentProfile);
    }
});
