import { auth, db } from '../platform/firebase-init.js';
import { serverTimestamp, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert, showConfirm } from './dialog.js';
import { hideInitialLoader } from './loading.js';
import { t } from './i18n.js';

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
function getDefaultAvatarUrl(genderValue) {
    const gender = String(genderValue || "").trim().toLowerCase();
    if (gender === 'female' || gender === 'woman' || gender === 'f') {
        return "assets/icons/webicons/avatar-female.png";
    }
    return "assets/icons/webicons/avatar-male.png";
}

function renderAvatar(container, name, photoUrl, genderValue = "") {
    if (!container) return;
    container.replaceChildren();

    let validUrl = "";
    if (typeof photoUrl === 'string') {
        const clean = photoUrl.trim();
        if (clean.startsWith('http://') || clean.startsWith('https://')) {
            validUrl = clean;
        } else if (clean.startsWith('data:image/')) {
            const commaIdx = clean.indexOf(',');
            if (commaIdx > 0 && (clean.length - commaIdx) > 500) {
                validUrl = clean;
            }
        }
    }

    const fallbackUrl = getDefaultAvatarUrl(genderValue);
    const targetUrl = validUrl || fallbackUrl;

    const photo = document.createElement('img');
    photo.src = targetUrl;
    photo.alt = `${name || "LiphtUp user"} profile photo`;
    photo.addEventListener('error', () => {
        if (photo.src !== fallbackUrl) {
            photo.src = fallbackUrl;
        }
    }, { once: true });
    container.appendChild(photo);
}

function renderProfileSummary(profile = {}) {
    const displayName = profile.name || currentAuthUser?.displayName || "LiphtUp User";
    const phone = profile.phone || currentAuthUser?.phoneNumber || "Phone number unavailable";

    nameEl.innerText = displayName;
    phoneEl.innerText = phone;
    emailEl.innerText = profile.email || "";
    renderAvatar(avatarEl, displayName, profile.profilePhotoUrl || "", profile.gender || profile.sex || "");

    const isDriver = profile.role === "driver";
    const paymentsRow = document.getElementById('profile-menu-payments-row');
    if (paymentsRow) {
        paymentsRow.classList.toggle('d-none', !isDriver);
    }
    const walletRow = document.getElementById('profile-menu-wallet-row');
    if (walletRow) {
        walletRow.classList.toggle('d-none', isDriver);
    }
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
    if (typeof message === 'object' && message !== null) {
        message = message.message || message.error || JSON.stringify(message);
    }
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
    if (typeof message === 'object' && message !== null) {
        message = message.message || message.error || JSON.stringify(message);
    }
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
    loadEmergencyContacts();
}

function closeSafetySheet() {
    safetyLayer.classList.add('d-none');
    unlockBodyIfNoSheetOpen();
}

// ==========================================
// FEATURE 3: EMERGENCY CONTACT MANAGEMENT
// ==========================================
let emergencyContactsCache = [];

function renderEmergencyContacts() {
    const list = document.getElementById('emergency-contacts-list');
    const addBtn = document.getElementById('emergency-contact-add-btn');
    const limitNotice = document.getElementById('emergency-contact-limit-notice');
    if (!list) return;

    const t = (key, fallback) => (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t(key) : fallback;
    const tRemove = t('common.remove', 'Remove');
    const tEmpty = t('profile.no_emergency_contacts', 'No emergency contacts saved yet.');

    if (!emergencyContactsCache.length) {
        list.innerHTML = `<p class="profile-safety-tools-hint mb-0 text-muted" style="font-size:12.5px;">${tEmpty}</p>`;
    } else {
        list.innerHTML = emergencyContactsCache.map((contact, index) => `
            <div class="emergency-contact-item">
                <div class="emergency-contact-info">
                    <div class="contact-avatar-circle">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <circle cx="12" cy="7" r="4" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>
                    <div>
                        <strong>${escapeHtmlText(contact.name)}</strong>
                        <span>${escapeHtmlText(contact.phone)}</span>
                    </div>
                </div>
                <button type="button" class="emergency-contact-remove-btn" data-index="${index}">${tRemove}</button>
            </div>
        `).join("");
        list.querySelectorAll('.emergency-contact-remove-btn').forEach((btn) => {
            btn.addEventListener('click', () => removeEmergencyContact(Number(btn.dataset.index)));
        });
    }

    const isMax = emergencyContactsCache.length >= 3;
    if (addBtn) addBtn.classList.toggle('d-none', isMax);
    if (limitNotice) limitNotice.classList.toggle('d-none', !isMax);
}

window.addEventListener('languageChanged', () => {
    renderEmergencyContacts();
});

function escapeHtmlText(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

async function loadEmergencyContacts() {
    if (!currentAuthUser?.uid) return;
    try {
        const snap = await getDoc(doc(db, "emergencyContacts", currentAuthUser.uid));
        emergencyContactsCache = snap.exists() ? (snap.data().contacts || []) : [];
    } catch (error) {
        console.warn("Could not load emergency contacts:", error);
        emergencyContactsCache = [];
    }
    renderEmergencyContacts();
}

async function saveEmergencyContacts() {
    if (!currentAuthUser?.uid) return;
    await setDoc(doc(db, "emergencyContacts", currentAuthUser.uid), {
        contacts: emergencyContactsCache,
        updatedAt: serverTimestamp()
    }, { merge: true });
}

async function removeEmergencyContact(index) {
    if (!(await showConfirm(t('profile.remove_contact_confirm', "Remove this emergency contact?")))) return;
    emergencyContactsCache = emergencyContactsCache.filter((_, i) => i !== index);
    renderEmergencyContacts();
    try {
        await saveEmergencyContacts();
    } catch (error) {
        console.error("Could not remove emergency contact:", error);
        await showAlert(t('profile.remove_contact_failed', "Could not remove this contact. Please try again."));
        loadEmergencyContacts();
    }
}

document.getElementById('emergency-contact-add-btn')?.addEventListener('click', () => {
    document.getElementById('emergency-contact-form')?.classList.remove('d-none');
    document.getElementById('emergency-contact-add-btn')?.classList.add('d-none');
});

document.getElementById('emergency-contact-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('emergency-contact-form')?.classList.add('d-none');
    document.getElementById('emergency-contact-form')?.reset();
    renderEmergencyContacts();
});

document.getElementById('emergency-contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.getElementById('emergency-contact-name')?.value.trim();
    const phone = document.getElementById('emergency-contact-phone')?.value.trim();
    if (!name || !phone) return;
    if (emergencyContactsCache.length >= 3) {
        await showAlert(t('profile.contact_limit_alert', "You can save up to 3 emergency contacts."));
        return;
    }

    emergencyContactsCache = [...emergencyContactsCache, { name, phone }];
    try {
        await saveEmergencyContacts();
        document.getElementById('emergency-contact-form')?.classList.add('d-none');
        document.getElementById('emergency-contact-form')?.reset();
        renderEmergencyContacts();
    } catch (error) {
        console.error("Could not save emergency contact:", error);
        await showAlert(t('profile.save_contact_failed', "Could not save this contact. Please try again."));
    }
});

// ==========================================
// FEATURE 3: REPORT A SAFETY CONCERN & ACTIONS
// ==========================================
document.getElementById('safety-center-share-btn')?.addEventListener('click', () => {
    if (typeof window.LiphtUpShareInvite === 'function') {
        window.LiphtUpShareInvite();
    } else {
        shareLiphtUp();
    }
});

document.getElementById('safety-get-help-btn')?.addEventListener('click', () => {
    window.location.href = 'tel:112';
});

document.getElementById('safety-report-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('safety-report-form')?.reset();
});

document.getElementById('safety-report-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const category = document.getElementById('safety-report-category')?.value;
    const description = document.getElementById('safety-report-description')?.value.trim();
    const submitBtn = event.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error(t('history.login_to_report', "Please log in to submit a report."));
        const response = await fetch("/api/rides/safety-report", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ category, description })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || t('history.report_failed', "Could not submit this report."));

        document.getElementById('safety-report-form')?.reset();
        await showAlert(t('history.report_submitted', "Thank you. Your report has been submitted to LiphtUp's safety team."));
    } catch (error) {
        console.error("Safety report submit failed:", error);
        await showAlert(error.message || t('history.report_failed_retry', "Could not submit this report. Please try again."));
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});

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
        window.location.href = '/login.html';
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
    saveNotice.innerText = t('profile.link_copied', "LiphtUp link copied");
    showSaveNotice();
    window.setTimeout(() => {
        saveNotice.innerText = t('profile.profile_updated', "Profile updated successfully");
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
    saveButton.innerText = isSaving ? t('common.saving', "Saving...") : t('profile.save_changes', "Save Changes");
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

    roleBadge.innerText = isDriver ? t('profile.driver_account', "Driver account") : t('profile.passenger_account', "Passenger account");
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
    deleteSubmitButton.innerText = isDeleting ? t('common.deleting', "Deleting...") : t('profile.delete_my_account', "Delete my account");
    deleteForm.querySelectorAll('input, button').forEach((control) => {
        if (control !== deleteSubmitButton) control.disabled = isDeleting;
    });
}

async function logoutCurrentUser() {
    window.LiphtUpLoading?.showPageLoader?.(t('common.logging_out', "Logging out..."));
    try {
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
        await signOut(auth);
    } catch (err) {
        console.warn("Logout error:", err);
    } finally {
        window.location.href = '/login.html';
    }
}

async function deleteAccount(event) {
    event.preventDefault();
    if (!currentAuthUser || deleteInProgress) return;

    const confirmation = deleteConfirmationInput.value.trim();
    const password = deletePasswordInput.value;

    if (confirmation !== "DELETE") {
        showDeleteError(t('profile.type_delete_error', "Type DELETE exactly to confirm permanent deletion."));
        return;
    }
    if (password.length < 6) {
        showDeleteError(t('profile.enter_password_error', "Enter your account password to delete this account."));
        return;
    }

    window.LiphtUpLoading?.showPageLoader?.(t('profile.deleting_account', "Deleting account..."));

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
            throw new Error(data.error || t('profile.delete_failed', "Could not delete your account. Please try again."));
        }

        sessionStorage.removeItem(PROFILE_CACHE_KEY);
        saveNotice.innerText = t('profile.account_deleted', "Account deleted");
        showSaveNotice();
        try {
            await signOut(auth);
        } catch (signOutError) {
            console.warn("Local sign out after account deletion failed:", signOutError);
        }
        window.location.replace('/login.html');
    } catch (error) {
        console.error("Account deletion failed:", error);
        setDeleteState(false);
        showDeleteError(error.message || t('profile.delete_failed', "Could not delete your account. Please try again."));
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

    if (name.length < 2) return t('profile.enter_full_name', "Enter your full name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return t('profile.enter_valid_email', "Enter a valid email address.");
    if (photoUrl && !/^https?:\/\/[^\s]+$/i.test(photoUrl)) return t('profile.enter_valid_photo_url', "Enter a valid profile photo URL.");

    if (isDriver) {
        const vehicleType = inputs.vehicleType.value;
        const vehicleModel = inputs.vehicleModel.value.trim();
        const vehicleNumber = inputs.vehicleNumber.value.trim();
        const license = inputs.license.value.trim();
        const upi = inputs.upi.value.trim();

        if (!pendingPhotoValue) return t('profile.photo_required_driver', "A profile photo is required for driver accounts.");
        if (!vehicleType) return t('profile.select_vehicle_service', "Select Bike / Scooty or Auto as your ride service.");
        if (vehicleModel.length < 2) return t('profile.enter_vehicle_model', "Enter the registered vehicle model.");
        if (!/^[A-Z0-9 -]{4,20}$/i.test(vehicleNumber)) return t('profile.enter_vehicle_number', "Enter a valid vehicle number.");
        if (!/^[A-Z0-9 -]{5,30}$/i.test(license)) return t('profile.enter_license_number', "Enter a valid driving licence number.");
        if (!/^[a-z0-9._-]{2,}@[a-z0-9.-]{2,}$/i.test(upi)) return t('profile.enter_upi_id', "Enter a valid UPI ID.");
    }

    return "";
}

async function saveProfileThroughBackend(user, updates) {
    const idToken = await user.getIdToken();
    const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify(updates)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.profile) {
        throw new Error(data.error || 'Profile update failed.');
    }
    return data.profile;
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
        profilePhotoUrl: pendingPhotoValue
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

    window.LiphtUpLoading?.showPageLoader?.(t('profile.saving_changes', "Saving profile changes..."));
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
        showError(t('profile.save_failed', "Could not save your profile. Check your connection and try again."));
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

function bindProfileActions() {
    document.querySelector('[data-action="rides"]')?.addEventListener('click', () => {
        window.navigateToPage('history.html');
    });
    document.querySelector('[data-action="wallet"]')?.addEventListener('click', openWalletSheet);
    document.querySelector('[data-action="payments"]')?.addEventListener('click', () => {
        window.navigateToPage('driver-payments.html');
    });
    document.querySelector('[data-action="contact"]')?.addEventListener('click', () => {
        window.navigateToPage('contact.html');
    });
    document.querySelector('[data-action="help"]')?.addEventListener('click', () => {
        window.navigateToPage('help.html');
    });
    document.querySelector('[data-action="safety"]')?.addEventListener('click', openSafetySheet);
    document.querySelector('[data-action="refer"]')?.addEventListener('click', shareLiphtUp);
    document.querySelector('[data-action="about"]')?.addEventListener('click', () => {
        window.navigateToPage('about.html');
    });
    document.querySelector('[data-action="terms"]')?.addEventListener('click', () => {
        window.navigateToPage('terms.html');
    });
    document.querySelector('[data-action="privacy"]')?.addEventListener('click', () => {
        window.navigateToPage('privacy.html');
    });

    editButton?.addEventListener('click', openEditor);
    document.getElementById('profile-edit-close-btn')?.addEventListener('click', closeEditor);
    document.getElementById('profile-edit-cancel-btn')?.addEventListener('click', closeEditor);
    document.getElementById('profile-edit-backdrop')?.addEventListener('click', closeEditor);
    document.getElementById('profile-share-close-btn')?.addEventListener('click', closeFallbackShareSheet);
    document.getElementById('profile-share-backdrop')?.addEventListener('click', closeFallbackShareSheet);
    document.getElementById('profile-about-close-btn')?.addEventListener('click', closeAboutSheet);
    document.getElementById('profile-about-backdrop')?.addEventListener('click', closeAboutSheet);
    document.getElementById('profile-contact-close-btn')?.addEventListener('click', closeContactSheet);
    document.getElementById('profile-contact-backdrop')?.addEventListener('click', closeContactSheet);
    document.getElementById('profile-help-close-btn')?.addEventListener('click', closeHelpSheet);
    document.getElementById('profile-help-backdrop')?.addEventListener('click', closeHelpSheet);
    document.getElementById('profile-privacy-close-btn')?.addEventListener('click', closePrivacySheet);
    document.getElementById('profile-privacy-backdrop')?.addEventListener('click', closePrivacySheet);
    document.getElementById('profile-safety-close-btn')?.addEventListener('click', closeSafetySheet);
    document.getElementById('profile-wallet-close-btn')?.addEventListener('click', closeWalletSheet);
    document.getElementById('profile-wallet-backdrop')?.addEventListener('click', closeWalletSheet);
    document.getElementById('profile-wallet-pay-ride-btn')?.addEventListener('click', payRideFromWalletShortcut);
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
        if (event.key === 'Escape' && !document.getElementById('profile-wallet-modal')?.classList.contains('d-none')) {
            closeWalletSheet();
        } else if (event.key === 'Escape' && !aboutLayer.classList.contains('d-none')) {
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

    profileSessionButton.addEventListener('click', () => {
        if (!currentAuthUser) {
            window.location.href = '/login.html';
            return;
        }
        openAccountSheet();
    });
}

let currentActiveRidePayable = null;

async function openWalletSheet() {
    if (!currentAuthUser) {
        window.location.href = '/login.html';
        return;
    }
    const walletModal = document.getElementById('profile-wallet-modal');
    if (!walletModal) return;
    walletModal.classList.remove('d-none');
    document.body.classList.add('profile-wallet-open');
    await loadWalletData();
    checkAndShowCelebration();
}

function closeWalletSheet() {
    const walletModal = document.getElementById('profile-wallet-modal');
    if (walletModal) walletModal.classList.add('d-none');
    document.body.classList.remove('profile-wallet-open');
}

async function loadWalletData() {
    if (!currentAuthUser) return;
    const balanceEl = document.getElementById('profile-wallet-balance-val');
    const listEl = document.getElementById('profile-wallet-tx-list');
    const rideCard = document.getElementById('profile-wallet-active-ride-card');
    const rideDesc = document.getElementById('profile-wallet-active-ride-desc');

    try {
        const idToken = await currentAuthUser.getIdToken();
        const res = await fetch('/api/wallet', {
            headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load wallet');

        const wallet = data.wallet || {};
        if (balanceEl) {
            balanceEl.innerText = `₹${(wallet.balance ?? 0).toLocaleString('en-IN')}`;
        }

        // Active ride payable banner
        if (wallet.activeRidePayable && wallet.activeRidePayable.remainingFare > 0 && wallet.balance > 0) {
            currentActiveRidePayable = { ...wallet.activeRidePayable, walletBalance: wallet.balance };
            const spendAmt = Math.min(wallet.activeRidePayable.remainingFare, wallet.balance);
            if (rideDesc) {
                rideDesc.innerText = `${t('wallet.remaining_ride_fare', { amount: wallet.activeRidePayable.remainingFare })} (₹${spendAmt} wallet available)`;
            }
            const payRideBtn = document.getElementById('profile-wallet-pay-ride-btn');
            if (payRideBtn) {
                payRideBtn.innerText = `Use ₹${spendAmt} Wallet Credits`;
            }
            if (rideCard) rideCard.classList.remove('d-none');
        } else {
            currentActiveRidePayable = null;
            if (rideCard) rideCard.classList.add('d-none');
        }

        // Load transaction history
        await loadWalletTransactions();
    } catch (error) {
        console.error('Wallet load error:', error);
        if (listEl) {
            listEl.innerHTML = `<div class="wallet-empty-state"><p class="text-danger small">${error.message || t('common.error_occurred')}</p></div>`;
        }
    }
}

async function loadWalletTransactions() {
    if (!currentAuthUser) return;
    const listEl = document.getElementById('profile-wallet-tx-list');
    if (!listEl) return;

    try {
        const idToken = await currentAuthUser.getIdToken();
        const res = await fetch('/api/wallet/transactions?limit=30', {
            headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load transactions');

        const txs = data.transactions || [];
        if (!txs.length) {
            listEl.innerHTML = `
                <div class="wallet-empty-state">
                    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#9CA3AF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="mb-2">
                        <rect x="2" y="5" width="20" height="14" rx="2"></rect>
                        <line x1="2" y1="10" x2="22" y2="10"></line>
                    </svg>
                    <strong class="d-block text-dark small">${t('wallet.no_transactions')}</strong>
                    <p class="text-muted small mb-0">${t('wallet.no_transactions_desc')}</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = txs.map(tx => {
            const isCredit = tx.direction === 'credit';
            const sign = isCredit ? '+' : '-';
            const amtClass = isCredit ? 'text-success' : 'text-dark';
            const statusLabel = tx.isReversed ? t('wallet.reversed') : (tx.status === 'completed' ? t('wallet.completed') : tx.status);
            const statusBadgeClass = tx.isReversed ? 'bg-danger-subtle text-danger' : (isCredit ? 'bg-success-subtle text-success' : 'bg-light text-secondary');
            const dateStr = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            
            return `
                <div class="wallet-tx-card">
                    <div class="wallet-tx-icon ${isCredit ? 'credit' : 'debit'}">
                        ${isCredit ? `
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#16A34A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="19" x2="12" y2="5"></line>
                                <polyline points="5 12 12 5 19 12"></polyline>
                            </svg>
                        ` : `
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#DC2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <polyline points="19 12 12 19 5 12"></polyline>
                            </svg>
                        `}
                    </div>
                    <div class="wallet-tx-details">
                        <div class="d-flex justify-content-between align-items-center mb-1">
                            <strong class="wallet-tx-desc">${tx.description || t('wallet.title')}</strong>
                            <strong class="wallet-tx-amt ${amtClass}">${sign}₹${(tx.amount ?? 0).toLocaleString('en-IN')}</strong>
                        </div>
                        <div class="d-flex justify-content-between align-items-center">
                            <span class="wallet-tx-date">${dateStr}</span>
                            <span class="badge ${statusBadgeClass} rounded-pill px-2 py-1 small" style="font-size:10px;">${statusLabel}</span>
                        </div>
                        ${tx.tags && tx.tags.length ? `
                            <div class="wallet-tx-tags mt-1">
                                ${tx.tags.map(tag => `<span class="badge bg-success-subtle text-success me-1" style="font-size:9px;">${tag}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Error rendering transactions:', err);
    }
}

async function payRideFromWalletShortcut() {
    if (!currentActiveRidePayable || !currentAuthUser) return;
    const ride = currentActiveRidePayable;
    const walletBalance = Number(ride.walletBalance || 0);
    const spendAmt = Math.min(ride.remainingFare, walletBalance);
    const remAfter = Math.max(0, ride.remainingFare - spendAmt);

    const confirmed = await showConfirm(
        `${t('wallet.pay_from_wallet_confirm', { amount: spendAmt })}\n\n` +
        `${t('wallet.deduct_confirm_desc', { amount: spendAmt })}\n` +
        `${t('wallet.remaining_fare_after_pay', { amount: remAfter })}`,
        { okText: t('common.confirm'), cancelText: t('common.cancel') }
    );
    if (!confirmed) return;

    window.LiphtUpLoading?.showPageLoader?.(t('wallet.processing_payment'));
    try {
        const idToken = await currentAuthUser.getIdToken();
        const idempotencyKey = `rwp_${ride.rideId}_shortcut_${Date.now()}`;
        const res = await fetch('/api/wallet/pay-current-ride', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ rideId: ride.rideId, idempotencyKey })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Payment failed.');

        const result = data.result || {};
        await showAlert(t('wallet.payment_success_desc', {
            amount: result.transferAmount,
            remaining: result.remainingFare
        }));
        await loadWalletData();
    } catch (error) {
        console.error('Shortcut payment failed:', error);
        await showAlert(error.message || t('common.error_occurred'));
    } finally {
        window.LiphtUpLoading?.hidePageLoader?.({ force: true });
    }
}

async function checkAndShowCelebration() {
    if (!currentAuthUser) return;
    try {
        const idToken = await currentAuthUser.getIdToken();
        const res = await fetch('/api/wallet/unacknowledged-credits', {
            headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) return;

        const credits = data.unacknowledgedCredits || [];
        if (!credits.length) return;

        const firstCredit = credits[0];
        const modal = document.getElementById('profile-wallet-celebration-modal');
        const amtVal = document.getElementById('wallet-celebration-amount-val');
        const tagsContainer = document.getElementById('wallet-celebration-tags');
        const dismissBtn = document.getElementById('wallet-celebration-dismiss-btn');

        if (!modal) return;

        if (amtVal) amtVal.innerText = `+₹${(firstCredit.amount ?? 0).toLocaleString('en-IN')}`;
        if (tagsContainer) {
            tagsContainer.innerHTML = (firstCredit.tags || ['Bonus']).map(tg => `<span class="badge bg-success-subtle text-success me-1 px-2 py-1">${tg}</span>`).join('');
        }

        modal.classList.remove('d-none');

        const handleDismiss = async () => {
            modal.classList.add('d-none');
            dismissBtn?.removeEventListener('click', handleDismiss);
            try {
                await fetch('/api/wallet/acknowledge-credit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({ transactionId: firstCredit.transactionId })
                });
            } catch (e) {
                console.warn('Acknowledge failed:', e);
            }
        };
        dismissBtn?.addEventListener('click', handleDismiss, { once: true });
    } catch (e) {
        console.warn('Celebration check error:', e);
    }
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

onAuthStateChanged(auth, async (user) => {
    const profileLangSwitcher = document.getElementById('profile-lang-switcher');
    if (!user) {
        currentAuthUser = null;
        currentProfile = null;
        if (profileLangSwitcher) profileLangSwitcher.classList.add('d-none');
        nameEl.innerText = t('profile.guest_user', "Guest User");
        phoneEl.innerText = t('profile.login_to_view', "Login to view your profile");
        emailEl.innerText = "";
        avatarEl.innerText = "G";
        editButton.disabled = true;
        profileSessionButton.innerText = t('auth.tab_login', "Login / Register");
        profileSessionButton.classList.add('is-login');
        profileSessionButton.classList.remove('d-none');
        document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.remove('d-none'));
        hideInitialLoader();
        return;
    }

    currentAuthUser = user;
    if (profileLangSwitcher) profileLangSwitcher.classList.remove('d-none');
    editButton.disabled = false;
    profileSessionButton.innerText = t('profile.account_settings', "Account");
    profileSessionButton.classList.remove('is-login');
    profileSessionButton.classList.remove('d-none');
    document.querySelectorAll('.guest-login-btn').forEach((button) => button.classList.add('d-none'));

    const cachedProfile = getCachedProfile();
    if (cachedProfile?.uid === user.uid) {
        currentProfile = cachedProfile;
        renderProfileSummary(currentProfile);
        hideInitialLoader();
    }

    try {
        currentProfile = await loadProfileThroughBackend(user);
        renderProfileSummary(currentProfile);
        cacheProfile(currentProfile);
        hideInitialLoader();
    } catch (error) {
        console.error("Profile backend load failed:", error);
        currentProfile = {
            uid: user.uid,
            name: user.displayName || t('history.default_user', "LiphtUp User"),
            phone: user.phoneNumber || "",
            role: "passenger"
        };
        renderProfileSummary(currentProfile);
        hideInitialLoader();
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('open') === 'wallet' || urlParams.get('tab') === 'wallet') {
        if (currentProfile?.role === 'driver') {
            window.location.replace('/driver-payments.html?tab=wallet');
        } else {
            openWalletSheet();
        }
    }
});

window.addEventListener('languageChanged', () => {
    if (currentProfile) {
        renderProfileSummary(currentProfile);
    }
});
