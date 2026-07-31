import { auth } from './firebase-init.js';
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { markCurrentDriverOffline } from './driver-availability.js';

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
const accountLayer = document.getElementById('profile-account-layer');
const deleteLayer = document.getElementById('profile-delete-layer');
const deleteForm = document.getElementById('profile-delete-form');
const deleteConfirmationInput = document.getElementById('profile-delete-confirmation');
const deletePasswordInput = document.getElementById('profile-delete-password');
const deleteErrorBox = document.getElementById('profile-delete-error');
const deleteSubmitButton = document.getElementById('profile-delete-submit-btn');

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
let deleteInProgress = false;
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

function getCachedProfile() {
    try {
        const cached = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null");
        if (cached?.uid && Date.now() - Number(cached.cachedAt || 0) <= 6 * 60 * 60 * 1000) {
            return cached;
        }
    } catch {
        // Continue with the authoritative backend profile.
    }
    return null;
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

function showDeleteError(message) {
    deleteErrorBox.innerText = message;
    deleteErrorBox.classList.remove('d-none');
}

function clearDeleteError() {
    deleteErrorBox.innerText = "";
    deleteErrorBox.classList.add('d-none');
}

function isSupportLayerOpen() {
    return [
        editLayer,
        shareLayer,
        aboutLayer,
        contactLayer,
        helpLayer,
        privacyLayer,
        safetyLayer,
        termsLayer,
        accountLayer,
        deleteLayer
    ].some((layer) => layer && !layer.classList.contains('d-none'));
}

function unlockBodyIfNoSheetOpen() {
    if (!isSupportLayerOpen()) {
        document.body.classList.remove('profile-editor-open');
    }
}

function openFallbackShareSheet() {
    shareLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
}

function closeFallbackShareSheet() {
    shareLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openAboutSheet() {
    aboutLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-about-close-btn').focus(), 80);
}

function closeAboutSheet() {
    aboutLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openContactSheet() {
    contactLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-contact-close-btn').focus(), 80);
}

function closeContactSheet() {
    contactLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openHelpSheet() {
    helpLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-help-close-btn').focus(), 80);
}

function closeHelpSheet() {
    helpLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openPrivacySheet() {
    privacyLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-privacy-close-btn').focus(), 80);
}

function closePrivacySheet() {
    privacyLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openSafetySheet() {
    safetyLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-safety-close-btn').focus(), 80);
}

function closeSafetySheet() {
    safetyLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openTermsSheet() {
    termsLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-terms-close-btn').focus(), 80);
}

function closeTermsSheet() {
    termsLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openAccountSheet() {
    if (!currentAuthUser) {
        window.location.href = '/login';
        return;
    }

    accountLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => document.getElementById('profile-account-logout-btn').focus(), 80);
}

function closeAccountSheet() {
    if (deleteInProgress) return;
    accountLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

function openDeleteSheet() {
    if (!currentAuthUser) return;
    closeAccountSheet();
    clearDeleteError();
    deleteForm.reset();
    deleteLayer.classList.remove('d-none');
    document.body.classList.add('profile-editor-open');
    window.setTimeout(() => deleteConfirmationInput.focus(), 80);
}

function closeDeleteSheet() {
    if (deleteInProgress) return;
    deleteLayer.classList.add('d-none');
    clearDeleteError();
    deleteForm.reset();
    unlockBodyIfNoSheetOpen();
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
    unlockBodyIfNoSheetOpen();
    clearError();
}

function setDeleteState(isDeleting) {
    deleteInProgress = isDeleting;
    deleteSubmitButton.disabled = isDeleting;
    deleteSubmitButton.innerText = isDeleting ? "Deleting..." : "Delete my account";
    deleteForm.querySelectorAll('input, button').forEach((control) => {
        if (control !== deleteSubmitButton) control.disabled = isDeleting;
    });
}

async function logoutCurrentUser() {
    sessionStorage.removeItem(PROFILE_CACHE_KEY);
    await markCurrentDriverOffline();
    await signOut(auth);
    window.location.href = '/login';
}

async function deleteAccount(event) {
    event.preventDefault();
    if (!currentAuthUser || deleteInProgress) return;

    const confirmation = deleteConfirmationInput.value.trim();
    const password = deletePasswordInput.value;

    if (confirmation !== "DELETE") {
        showDeleteError("Type DELETE exactly to confirm permanent deletion.");
        return;
    }
    if (password.length < 6) {
        showDeleteError("Enter your account password to delete this account.");
        return;
    }

    clearDeleteError();
    setDeleteState(true);

    try {
        const idToken = await currentAuthUser.getIdToken(true);
        const response = await fetch('/api/delete-account', {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${idToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ confirmation, password })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Could not delete your account. Please try again.");
        }

        sessionStorage.removeItem(PROFILE_CACHE_KEY);
        saveNotice.innerText = "Account deleted";
        showSaveNotice();
        try {
            await signOut(auth);
        } catch (signOutError) {
            console.warn("Local sign out after account deletion failed:", signOutError);
        }
        window.location.replace('/login');
    } catch (error) {
        console.error("Account deletion failed:", error);
        setDeleteState(false);
        showDeleteError(error.message || "Could not delete your account. Please try again.");
    }
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
            vehicleModel,
            vehicleNumber,
            drivingLicenseNumber: inputs.license.value.trim().toUpperCase(),
            upiId: inputs.upi.value.trim().toLowerCase()
        });
    }

    try {
        currentProfile = await saveProfileThroughBackend(currentAuthUser, updates);

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
        window.location.href = '/history';
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
    document.getElementById('profile-account-close-btn').addEventListener('click', closeAccountSheet);
    document.getElementById('profile-account-backdrop').addEventListener('click', closeAccountSheet);
    document.getElementById('profile-account-logout-btn').addEventListener('click', logoutCurrentUser);
    document.getElementById('profile-account-delete-open-btn').addEventListener('click', openDeleteSheet);
    document.getElementById('profile-delete-close-btn').addEventListener('click', closeDeleteSheet);
    document.getElementById('profile-delete-backdrop').addEventListener('click', closeDeleteSheet);
    document.getElementById('profile-delete-cancel-btn').addEventListener('click', closeDeleteSheet);
    deleteForm.addEventListener('submit', deleteAccount);
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
        } else if (event.key === 'Escape' && !deleteLayer.classList.contains('d-none')) {
            closeDeleteSheet();
        } else if (event.key === 'Escape' && !accountLayer.classList.contains('d-none')) {
            closeAccountSheet();
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
        } else if (!deleteLayer.classList.contains('d-none')) {
            closeDeleteSheet();
        } else if (!accountLayer.classList.contains('d-none')) {
            closeAccountSheet();
        }
    });

    profileSessionButton.addEventListener('click', () => {
        if (!currentAuthUser) {
            window.location.href = '/login';
            return;
        }
        openAccountSheet();
    });
}

bindProfileActions();

async function loadProfileThroughBackend(user) {
    const idToken = await user.getIdToken();
    const response = await fetch('/api/profile', {
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${idToken}`
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.profile) {
        throw new Error(data.error || 'Profile backend request failed.');
    }
    return data.profile;
}

async function saveProfileThroughBackend(user, updates) {
    const { updatedAt, ...requestUpdates } = updates;
    try {
        const idToken = await user.getIdToken();
        const response = await fetch('/api/profile', {
            method: 'PATCH',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify(requestUpdates)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok || !data.profile) {
            const error = new Error(data.error || 'Profile backend request failed.');
            error.backendUnavailable = [404, 405, 502, 503].includes(response.status);
            throw error;
        }
        return data.profile;
    } catch (error) {
        if (error?.backendUnavailable === undefined) error.backendUnavailable = true;
        throw error;
    }
}

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
    profileSessionButton.innerText = "Account";
    profileSessionButton.classList.remove('is-login');
    profileSessionButton.classList.remove('d-none');
    document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.add('d-none'));

    const cachedProfile = getCachedProfile();
    if (cachedProfile?.uid === user.uid) {
        currentProfile = cachedProfile;
        renderProfileSummary(currentProfile);
    }

    try {
        currentProfile = await loadProfileThroughBackend(user);
        renderProfileSummary(currentProfile);
        cacheProfile(currentProfile);
    } catch (error) {
        console.error("Profile backend load failed:", error);
        currentProfile = {
            uid: user.uid,
            name: user.displayName || "LiphtUp User",
            phone: user.phoneNumber || "",
            role: "passenger"
        };
        renderProfileSummary(currentProfile);
    }
});
