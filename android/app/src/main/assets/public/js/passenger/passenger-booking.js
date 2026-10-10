import { auth, db } from '../platform/firebase-init.js';
import {
    collection,
    deleteField,
    doc,
    getDoc,
    getDocs,
    query,
    setDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showAlert, showConfirm } from '../shared/dialog.js';
import { showSkeleton, setButtonBusy } from '../shared/loading.js';
import { waitForAuth } from '../shared/auth.js';
import { t } from '../shared/i18n.js';

const UNCLEAR_LOCATION_LABELS = new Set(["current location", "current", "my location", "pinned pickup", "pinned destination"]);
const SAVED_PLACE_SLOTS = ["home", "work"];
const TRIPURA_CENTER = { lat: 23.8315, lng: 91.2868 };

const savedPlacesRow = document.getElementById('dashboard-saved-places');
const dashboardSearchForm = document.getElementById('dashboard-search-form');
const dashboardSearchInput = document.getElementById('dashboard-search-input');

// Full Saved Places & Address Editor Modal elements
const savedPlacesModal = document.getElementById('saved-places-modal');
const savedPlacesListContainer = document.getElementById('saved-places-list-container');
const saveAddressEditorModal = document.getElementById('save-address-editor-modal');
const saveAddressTypeInput = document.getElementById('save-address-type-input');
const saveAddressLocationInput = document.getElementById('save-address-location-input');
const saveAddressSuggestions = document.getElementById('save-address-suggestions');
const saveAddressEditorTitle = document.getElementById('save-address-editor-title');
const saveAddressEditorForm = document.getElementById('save-address-editor-form');

let currentUid = null;
let savedPlacesCache = null;
let activeSavedSlot = null;
let pickedPlace = null;
let suggestionAbortController = null;
let roughUserPosition = null;

// Best-effort, non-blocking location bias for saved-place search -- mirrors
// the precision the main booking search gets, without gating the UI on it.
if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            roughUserPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
        },
        () => {},
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 }
    );
}

function cleanText(value) {
    return String(value || "").trim();
}

function isUnclearLocation(value) {
    const label = cleanText(value).toLowerCase();
    return !label || UNCLEAR_LOCATION_LABELS.has(label);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ==========================================
// Greetings & Dynamic Sub-greeting Rotation (IST & 3-hour rotation)
// ==========================================

const GREETINGS_SUB_EN = [
  "Where are you headed?",
  "Where are you off to today?",
  "Got places to go?",
  "Ready when you are.",
  "Let's make the journey easy.",
  "Your ride is just a tap away.",
  "Another day, another journey.",
  "Where will you go today?",
  "Let's get you moving.",
  "Your destination awaits.",
  "The road is yours today.",
  "Wherever today takes you.",
  "Make your next move.",
  "Start your journey here.",
  "Ready when the road is.",
  "Go places. Go LiphtUp."
];

const GREETINGS_SUB_BN = [
  "কোথায় যাচ্ছেন?",
  "আজ কোথায় চলেছেন?",
  "কোথাও যাওয়ার আছে?",
  "আপনি প্রস্তুত তো?",
  "চলুন, যাত্রাটা সহজ করি।",
  "এক ট্যাপেই আপনার রাইড।",
  "আরেকটি দিন, আরেকটি যাত্রা।",
  "আজ কোথায় যাবেন?",
  "চলুন, রওনা হওয়া যাক।",
  "আপনার গন্তব্য অপেক্ষায়।",
  "আজকের পথ আপনার।",
  "আজ যেদিকেই যান।",
  "পরের গন্তব্য ঠিক করুন।",
  "যাত্রা শুরু হোক এখান থেকেই।",
  "রাস্তা প্রস্তুত, আপনিও তো?",
  "ঘুরে আসুন, LiphtUp-এর সাথে।"
];

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
let currentGreetingIndex = -1;
let lastGreetingTimestamp = 0;
let cachedUserName = "User";

function getIndianTime() {
    const now = new Date();
    const utcMillis = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utcMillis + (3600000 * 5.5));
}

function getGreetingKeyAndFallback() {
    const istDate = getIndianTime();
    const hour = istDate.getHours();
    if (hour >= 4 && hour < 12) {
        return { key: "home.greeting_morning", fallback: "Good morning" };
    }
    if (hour >= 12 && hour < 17) {
        return { key: "home.greeting_afternoon", fallback: "Good afternoon" };
    }
    return { key: "home.greeting_evening", fallback: "Good evening" };
}

function updateGreeting(name) {
    if (name) cachedUserName = name;
    const greetingEl = document.getElementById('greeting-text');
    if (!greetingEl) return;

    const { key, fallback } = getGreetingKeyAndFallback();
    const translatedGreeting = t(key, fallback);

    greetingEl.innerHTML = `${translatedGreeting}, <span id="user-display-name">${escapeHtml(cachedUserName)}</span> 👋`;
}

function selectRandomGreetingIndex() {
    const total = GREETINGS_SUB_EN.length;
    let newIndex = Math.floor(Math.random() * total);
    if (currentGreetingIndex >= 0 && total > 1 && newIndex === currentGreetingIndex) {
        newIndex = (newIndex + 1) % total;
    }
    currentGreetingIndex = newIndex;
    lastGreetingTimestamp = Date.now();
    try {
        sessionStorage.setItem('liphtup_subgreeting_idx', String(currentGreetingIndex));
        sessionStorage.setItem('liphtup_subgreeting_time', String(lastGreetingTimestamp));
    } catch (e) {}
    return currentGreetingIndex;
}

function updateDynamicSubGreeting() {
    const subEl = document.getElementById('home-subgreeting-text');
    if (!subEl) return;

    if (currentGreetingIndex < 0) {
        selectRandomGreetingIndex();
    } else {
        const now = Date.now();
        if (now - lastGreetingTimestamp >= THREE_HOURS_MS) {
            selectRandomGreetingIndex();
        }
    }

    const currentLang = (window.LiphtUpI18n && typeof window.LiphtUpI18n.getCurrentLanguage === 'function')
        ? window.LiphtUpI18n.getCurrentLanguage()
        : 'en';
    
    const list = (currentLang === 'bn' || currentLang === 'bengali') ? GREETINGS_SUB_BN : GREETINGS_SUB_EN;
    const greetingText = list[currentGreetingIndex] || list[0];
    subEl.textContent = greetingText;
}

// Periodic check: update every minute if 3 hours elapsed or IST time boundary changed
setInterval(() => {
    const now = Date.now();
    if (now - lastGreetingTimestamp >= THREE_HOURS_MS) {
        selectRandomGreetingIndex();
        updateDynamicSubGreeting();
    }
    updateGreeting();
}, 60000);

function getDefaultAvatarUrl(profile = {}) {
    const gender = String(profile.gender || profile.sex || "").trim().toLowerCase();
    if (gender === 'female' || gender === 'woman' || gender === 'f') {
        return "assets/icons/webicons/avatar-female.png";
    }
    return "assets/icons/webicons/avatar-male.png";
}

function setupSideDrawer(profile) {
    const trigger = document.getElementById('profile-menu-trigger');
    const drawer = document.getElementById('side-drawer');
    const closeBtn = document.getElementById('close-drawer-btn');
    const headerImg = document.getElementById('user-profile-img');
    const drawerImg = document.getElementById('drawer-user-img');
    const drawerName = document.getElementById('drawer-user-name');
    const drawerPhone = document.getElementById('drawer-user-phone');

    const savedPlacesBtn = document.getElementById('drawer-item-saved-places');
    const logoutBtn = document.getElementById('drawer-item-logout');

    if (!trigger || !drawer) return;

    // Update profile images: prioritize custom profilePhotoUrl from Firestore,
    // otherwise fallback to gender-specific avatar placeholder.
    const rawPhotoUrl = profile.profilePhotoUrl || profile.photoURL || profile.avatarUrl || "";
    let validPhotoUrl = "";
    if (typeof rawPhotoUrl === 'string') {
        const clean = rawPhotoUrl.trim();
        if (clean.startsWith('http://') || clean.startsWith('https://')) {
            validPhotoUrl = clean;
        } else if (clean.startsWith('data:image/')) {
            const commaIdx = clean.indexOf(',');
            if (commaIdx > 0 && (clean.length - commaIdx) > 500) {
                validPhotoUrl = clean;
            }
        }
    }

    const fallbackUrl = getDefaultAvatarUrl(profile);
    const finalPhotoUrl = validPhotoUrl || fallbackUrl;

    if (headerImg) {
        headerImg.src = finalPhotoUrl;
        headerImg.style.display = 'block';
        if (headerImg.nextElementSibling) headerImg.nextElementSibling.style.display = 'none';
        headerImg.onerror = () => {
            if (headerImg.src !== fallbackUrl) headerImg.src = fallbackUrl;
        };
    }

    if (drawerImg) {
        drawerImg.src = finalPhotoUrl;
        drawerImg.style.display = 'block';
        if (drawerImg.nextElementSibling) drawerImg.nextElementSibling.style.display = 'none';
        drawerImg.onerror = () => {
            if (drawerImg.src !== fallbackUrl) drawerImg.src = fallbackUrl;
        };
    }

    if (drawerName) drawerName.textContent = profile.name || profile.displayName || "User";
    if (drawerPhone) drawerPhone.textContent = profile.phone || "";

    trigger.addEventListener('click', () => {
        drawer.classList.remove('d-none');
        document.body.style.overflow = 'hidden';
    });

    const closeDrawer = () => {
        drawer.classList.add('d-none');
        document.body.style.overflow = '';
    };

    closeBtn?.addEventListener('click', closeDrawer);
    drawer.addEventListener('click', (e) => {
        if (e.target === drawer) closeDrawer();
    });

    savedPlacesBtn?.addEventListener('click', () => {
        closeDrawer();
        openSavedPlacesModal();
    });

    logoutBtn?.addEventListener('click', async () => {
        closeDrawer();
        const confirmed = await showConfirm(
            t('profile.logout_confirm_msg', "Are you sure you want to log out of LiphtUp?"),
            {
                okText: t('common.logout', "Logout"),
                cancelText: t('common.cancel', "Cancel")
            }
        );
        if (!confirmed) return;

        window.LiphtUpLoading?.showPageLoader?.(t('common.logging_out', "Logging out..."));
        try {
            sessionStorage.clear();
            await signOut(auth);
        } catch (err) {
            console.warn("Logout error:", err);
        } finally {
            window.location.href = '/login.html';
        }
    });
}

// ==========================================
// Our Services Shortcuts & Parcel Modal
// ==========================================

function openParcelModal() {
    const modal = document.getElementById('parcel-service-modal');
    if (modal) modal.classList.remove('d-none');
}

function closeParcelModal() {
    const modal = document.getElementById('parcel-service-modal');
    if (modal) modal.classList.add('d-none');
}

function initOurServices() {
    document.querySelectorAll('[data-service-shortcut]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const serviceType = btn.dataset.serviceShortcut;
            if (serviceType === 'parcel') {
                openParcelModal();
                return;
            }
            if (serviceType === 'auto' || serviceType === 'bike' || serviceType === 'share') {
                try {
                    sessionStorage.setItem('liphtup_temp_selected_service', serviceType);
                } catch (e) {
                    console.warn("Could not save temporary service selection:", e);
                }
                window.location.href = '/services.html';
            }
        });
    });

    document.getElementById('parcel-modal-close-btn')?.addEventListener('click', closeParcelModal);
    document.getElementById('parcel-modal-backdrop')?.addEventListener('click', closeParcelModal);
    document.getElementById('parcel-modal-got-it-btn')?.addEventListener('click', closeParcelModal);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('parcel-service-modal');
            if (modal && !modal.classList.contains('d-none')) {
                closeParcelModal();
            }
        }
    });
}

window.addEventListener('languageChanged', () => {
    updateGreeting();
    updateDynamicSubGreeting();
    renderSavedPlaces();
    renderSavedPlacesModalList();
});

function goToServicesWithDestination(destinationText) {
    const clean = cleanText(destinationText);
    if (!clean || isUnclearLocation(clean)) {
        window.location.href = '/services.html';
        return;
    }
    const url = new URL('/services.html', window.location.href);
    url.searchParams.set('destination', clean);
    window.location.href = url.href;
}

// ==========================================
// Saved places (Home / Work / favourites)
// ==========================================

// ==========================================
// Saved places (Home / Work / custom places)
// ==========================================

let activeEditingSlotOrIndex = null;

async function loadSavedPlaces(uid) {
    try {
        const user = await waitForAuth();
        const activeUid = uid || user?.uid || currentUid;
        if (!activeUid) return {};
        const snap = await getDoc(doc(db, "savedPlaces", activeUid));
        return snap.exists() ? snap.data() : {};
    } catch (error) {
        console.warn("Could not load saved places:", error);
        return {};
    }
}

function savedPlaceChipMarkup(slot, place) {
    const labels = { 
        home: t('home.home_chip', 'Home'), 
        work: t('home.work_chip', 'Work') 
    };
    const tapToAddText = t('home.tap_to_add', 'Tap to add');
    const icon = slot === "home" ? "webicon-favorite" : "webicon-work";
    const set = Boolean(place?.address);
    return `
        <div class="dashboard-saved-chip-wrap">
            <button type="button" class="dashboard-saved-chip${set ? ' is-set' : ''}" data-slot="${slot}">
                <span class="webicon ${icon}" aria-hidden="true"></span>
                <span class="dashboard-saved-chip-text">
                    <strong>${labels[slot]}</strong>
                    <small>${set ? escapeHtml(place.address) : tapToAddText}</small>
                </span>
            </button>
            ${set ? `
                <button type="button" class="dashboard-saved-chip-edit" data-slot="${slot}" aria-label="Edit ${labels[slot]} address">
                    <span class="webicon webicon-edit" aria-hidden="true"></span>
                </button>
            ` : ''}
        </div>
    `;
}

function renderSavedPlaces() {
    if (!savedPlacesRow) return;
    const places = savedPlacesCache || {};
    savedPlacesRow.innerHTML = SAVED_PLACE_SLOTS
        .map((slot) => savedPlaceChipMarkup(slot, places[slot]))
        .join('');

    savedPlacesRow.querySelectorAll('.dashboard-saved-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const slot = chip.dataset.slot;
            const place = savedPlacesCache?.[slot];
            if (place?.address) {
                goToServicesWithDestination(place.address);
            } else {
                openSaveAddressEditor(slot, slot === 'home' ? 'Home' : 'Work');
            }
        });
    });

    savedPlacesRow.querySelectorAll('.dashboard-saved-chip-edit').forEach((editBtn) => {
        editBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const slot = editBtn.dataset.slot;
            const place = savedPlacesCache?.[slot];
            openSaveAddressEditor(slot, slot === 'home' ? 'Home' : 'Work', place?.address || '');
        });
    });
}

async function initSavedPlaces(uid) {
    if (!savedPlacesRow && !savedPlacesModal) return;
    const clearSkeleton = savedPlacesRow ? showSkeleton(savedPlacesRow, { kind: 'line', count: 1 }) : () => {};
    savedPlacesCache = await loadSavedPlaces(uid);
    clearSkeleton();
    renderSavedPlaces();
}

function renderSavedPlacesModalList() {
    if (!savedPlacesListContainer) return;

    const home = savedPlacesCache?.home;
    const work = savedPlacesCache?.work;
    const customPlaces = Array.isArray(savedPlacesCache?.customPlaces) ? savedPlacesCache.customPlaces : [];

    let html = '';

    // 1. Home Item
    html += `
        <div class="saved-place-item-card" data-type="home">
            <div class="saved-place-icon-badge">
                <span class="webicon webicon-home" style="color: #1A7A2E;"></span>
            </div>
            <div class="saved-place-details" ${home?.address ? `onclick="window.selectSavedPlace('home')"` : ''} style="cursor:${home?.address ? 'pointer' : 'default'}">
                <strong>${t('home.home_chip', 'Home')}</strong>
                <small>${home?.address ? escapeHtml(home.address) : t('services.not_saved_yet', 'Not saved yet - tap pencil to add')}</small>
            </div>
            <div class="saved-place-actions">
                <button type="button" class="saved-item-action-btn" title="Edit Home" onclick="window.editSavedPlace('home')">
                    <span class="webicon webicon-edit" style="color: #4B5563;"></span>
                </button>
                ${home?.address ? `
                    <button type="button" class="saved-item-action-btn delete-btn" title="Delete Home" onclick="window.deleteSavedPlace('home', null, this)">
                        <span class="webicon webicon-trash"></span>
                    </button>
                ` : ''}
            </div>
        </div>
    `;

    // 2. Work Item
    html += `
        <div class="saved-place-item-card" data-type="work">
            <div class="saved-place-icon-badge">
                <span class="webicon webicon-work" style="color: #1A7A2E;"></span>
            </div>
            <div class="saved-place-details" ${work?.address ? `onclick="window.selectSavedPlace('work')"` : ''} style="cursor:${work?.address ? 'pointer' : 'default'}">
                <strong>${t('home.work_chip', 'Work')}</strong>
                <small>${work?.address ? escapeHtml(work.address) : t('services.not_saved_yet', 'Not saved yet - tap pencil to add')}</small>
            </div>
            <div class="saved-place-actions">
                <button type="button" class="saved-item-action-btn" title="Edit Work" onclick="window.editSavedPlace('work')">
                    <span class="webicon webicon-edit" style="color: #4B5563;"></span>
                </button>
                ${work?.address ? `
                    <button type="button" class="saved-item-action-btn delete-btn" title="Delete Work" onclick="window.deleteSavedPlace('work', null, this)">
                        <span class="webicon webicon-trash"></span>
                    </button>
                ` : ''}
            </div>
        </div>
    `;

    // 3. Custom Places
    customPlaces.forEach((place, index) => {
        html += `
            <div class="saved-place-item-card" data-index="${index}">
                <div class="saved-place-icon-badge">
                    <span class="webicon webicon-favorite" style="color: #1A7A2E;"></span>
                </div>
                <div class="saved-place-details" onclick="window.selectSavedPlace('custom', ${index})" style="cursor:pointer">
                    <strong>${escapeHtml(place.name || t('profile.saved_place_title', 'Saved Place'))}</strong>
                    <small>${escapeHtml(place.address)}</small>
                </div>
                <div class="saved-place-actions">
                    <button type="button" class="saved-item-action-btn" title="Edit" onclick="window.editSavedPlace('custom', ${index})">
                        <span class="webicon webicon-edit" style="color: #4B5563;"></span>
                    </button>
                    <button type="button" class="saved-item-action-btn delete-btn" title="Delete" onclick="window.deleteSavedPlace('custom', ${index}, this)">
                        <span class="webicon webicon-trash"></span>
                    </button>
                </div>
            </div>
        `;
    });

    savedPlacesListContainer.innerHTML = html;

    const addBtn = document.getElementById('add-new-saved-place-btn');
    if (addBtn) {
        addBtn.classList.toggle('d-none', customPlaces.length >= 3);
    }
}

function openSavedPlacesModal() {
    renderSavedPlacesModalList();
    savedPlacesModal?.classList.remove('d-none');
}

function closeSavedPlacesModal() {
    savedPlacesModal?.classList.add('d-none');
}

function openSaveAddressEditor(targetKey, defaultLabel = "", defaultAddress = "") {
    activeEditingSlotOrIndex = targetKey;
    pickedPlace = null;
    if (!saveAddressEditorModal) return;

    if (targetKey === 'home') {
        if (saveAddressTypeInput) {
            saveAddressTypeInput.value = "Home";
            saveAddressTypeInput.readOnly = true;
        }
        if (saveAddressEditorTitle) saveAddressEditorTitle.textContent = t('services.save_home_address', "Save Home Address");
    } else if (targetKey === 'work') {
        if (saveAddressTypeInput) {
            saveAddressTypeInput.value = "Work";
            saveAddressTypeInput.readOnly = true;
        }
        if (saveAddressEditorTitle) saveAddressEditorTitle.textContent = t('services.save_work_address', "Save Work Address");
    } else {
        if (saveAddressTypeInput) {
            saveAddressTypeInput.value = defaultLabel || "";
            saveAddressTypeInput.readOnly = false;
        }
        if (saveAddressEditorTitle) saveAddressEditorTitle.textContent = t('services.save_new_address', "Save New Address");
    }

    const quickTags = document.getElementById('save-address-quick-tags');
    if (quickTags) quickTags.classList.toggle('d-none', Boolean(saveAddressTypeInput?.readOnly));
    document.querySelectorAll('.save-address-tag-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.label === saveAddressTypeInput?.value);
    });

    if (saveAddressLocationInput) saveAddressLocationInput.value = defaultAddress || "";
    if (saveAddressSuggestions) saveAddressSuggestions.innerHTML = "";
    saveAddressEditorModal.classList.remove('d-none');
    setTimeout(() => (saveAddressTypeInput?.readOnly ? saveAddressLocationInput?.focus() : saveAddressTypeInput?.focus()), 100);
}

function closeSaveAddressEditor() {
    saveAddressEditorModal?.classList.add('d-none');
    activeEditingSlotOrIndex = null;
    pickedPlace = null;
    if (saveAddressSuggestions) saveAddressSuggestions.innerHTML = "";
}

async function persistSavedPlace(targetKey, label, address) {
    if (!currentUid) {
        window.location.href = '/login.html';
        return;
    }

    const submitBtn = document.getElementById('save-address-submit-btn');
    const originalText = submitBtn ? submitBtn.innerHTML : t('services.save_address', 'Save Address');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span class="lu-spinner lu-spinner-sm me-2" style="border-top-color:#fff;"></span>${t('common.saving', 'Saving...')}`;
    }

    const payload = { ...savedPlacesCache, updatedAt: new Date().toISOString() };

    if (targetKey === 'home') {
        payload.home = { address, name: "Home" };
    } else if (targetKey === 'work') {
        payload.work = { address, name: "Work" };
    } else if (typeof targetKey === 'number') {
        payload.customPlaces = payload.customPlaces || [];
        payload.customPlaces[targetKey] = { name: label, address };
    } else {
        payload.customPlaces = payload.customPlaces || [];
        if (payload.customPlaces.length >= 3) {
            showAlert(t('services.max_saved_places_notice', "You can save up to 3 places in addition to Home and Work."));
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
            return;
        }
        payload.customPlaces.push({ name: label, address });
    }

    try {
        await setDoc(doc(db, "savedPlaces", currentUid), payload, { merge: true });
        savedPlacesCache = payload;
        renderSavedPlaces();
        renderSavedPlacesModalList();
        closeSaveAddressEditor();
    } catch (e) {
        console.error("Could not save address:", e);
        showAlert(t('services.save_address_error', "Could not save address. Please try again."));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    }
}

async function deleteSavedPlaceItem(targetKey, customIndex = null, btnElement = null) {
    if (!currentUid) return;

    if (btnElement) {
        btnElement.disabled = true;
        btnElement.innerHTML = '<span class="lu-spinner lu-spinner-sm" style="margin:0; border-top-color:#EF4444;"></span>';
    }

    const payload = { ...savedPlacesCache, updatedAt: new Date().toISOString() };

    if (targetKey === 'home') {
        delete payload.home;
    } else if (targetKey === 'work') {
        delete payload.work;
    } else if (targetKey === 'custom' && Number.isInteger(customIndex)) {
        payload.customPlaces = payload.customPlaces || [];
        payload.customPlaces.splice(customIndex, 1);
    }

    try {
        await setDoc(doc(db, "savedPlaces", currentUid), payload);
        savedPlacesCache = payload;
        renderSavedPlaces();
        renderSavedPlacesModalList();
    } catch (e) {
        console.error("Could not delete saved place:", e);
        showAlert(t('services.delete_place_error', "Could not delete place. Try again."));
        renderSavedPlacesModalList();
    }
}

window.selectSavedPlace = (targetKey, index = null) => {
    let address = "";
    if (targetKey === 'home') address = savedPlacesCache?.home?.address;
    else if (targetKey === 'work') address = savedPlacesCache?.work?.address;
    else if (targetKey === 'custom' && Number.isInteger(index)) address = savedPlacesCache?.customPlaces?.[index]?.address;

    if (address) {
        closeSavedPlacesModal();
        goToServicesWithDestination(address);
    }
};

window.editSavedPlace = (targetKey, index = null) => {
    if (targetKey === 'home') {
        openSaveAddressEditor('home', 'Home', savedPlacesCache?.home?.address || '');
    } else if (targetKey === 'work') {
        openSaveAddressEditor('work', 'Work', savedPlacesCache?.work?.address || '');
    } else if (targetKey === 'custom' && Number.isInteger(index)) {
        const place = savedPlacesCache?.customPlaces?.[index];
        openSaveAddressEditor(index, place?.name || '', place?.address || '');
    }
};

window.deleteSavedPlace = (targetKey, index = null, btnElement = null) => {
    deleteSavedPlaceItem(targetKey, index, btnElement);
};

async function searchAddressSuggestions(text) {
    if (suggestionAbortController) suggestionAbortController.abort();
    const controller = new AbortController();
    suggestionAbortController = controller;
    try {
        const bias = roughUserPosition || TRIPURA_CENTER;
        const params = new URLSearchParams({
            q: text,
            lat: String(bias.lat),
            lng: String(bias.lng)
        });
        const response = await fetch(`/api/google-autocomplete?${params.toString()}`, {
            signal: controller.signal,
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (controller.signal.aborted || !response.ok) return [];
        return Array.isArray(data.results) ? data.results : [];
    } catch (error) {
        if (error.name !== "AbortError") console.warn("Address suggestion search failed:", error);
        return [];
    }
}

async function resolvePlaceCoordinates(place) {
    if (Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))) {
        return {
            address: place.fullAddress || place.name || "",
            lat: Number(place.lat),
            lng: Number(place.lng),
            placeId: place.placeId || ""
        };
    }
    if (!place.placeId) {
        return { address: place.fullAddress || place.name || "", lat: null, lng: null, placeId: "" };
    }
    try {
        const params = new URLSearchParams({ placeId: place.placeId });
        const response = await fetch(`/api/google-place-detail?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.result) throw new Error("no detail");
        return {
            address: data.result.fullAddress || place.fullAddress || place.name || "",
            lat: Number.isFinite(Number(data.result.lat)) ? Number(data.result.lat) : null,
            lng: Number.isFinite(Number(data.result.lng)) ? Number(data.result.lng) : null,
            placeId: data.result.placeId || place.placeId
        };
    } catch (error) {
        console.warn("Could not resolve place coordinates:", error);
        return { address: place.fullAddress || place.name || "", lat: null, lng: null, placeId: place.placeId || "" };
    }
}

let saveAddressDebounceTimer = null;
saveAddressLocationInput?.addEventListener('input', () => {
    const text = saveAddressLocationInput.value.trim();
    if (saveAddressDebounceTimer) window.clearTimeout(saveAddressDebounceTimer);
    if (text.length < 2) {
        if (saveAddressSuggestions) saveAddressSuggestions.innerHTML = "";
        return;
    }
    saveAddressDebounceTimer = window.setTimeout(async () => {
        const results = await searchAddressSuggestions(text);
        if (!saveAddressSuggestions) return;
        if (!results.length) {
            saveAddressSuggestions.innerHTML = "";
            return;
        }
        saveAddressSuggestions.innerHTML = results.slice(0, 5).map((place, index) => `
            <button type="button" class="destination-suggestion-item saved-place-suggestion w-100 text-start" data-index="${index}">
                <strong>${escapeHtml(place.name || place.mainName || "")}</strong>
                <small class="d-block text-muted">${escapeHtml(place.fullAddress || "")}</small>
            </button>
        `).join('');

        saveAddressSuggestions.querySelectorAll('.saved-place-suggestion').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const place = results[Number(btn.dataset.index)];
                if (!place) return;
                saveAddressSuggestions.innerHTML = "";
                saveAddressLocationInput.value = place.fullAddress || place.name || "";
                saveAddressLocationInput.disabled = true;
                pickedPlace = await resolvePlaceCoordinates(place);
                saveAddressLocationInput.disabled = false;
                if (saveAddressLocationInput) saveAddressLocationInput.value = pickedPlace.address;
            });
        });
    }, 250);
});

document.getElementById('saved-places-modal-close')?.addEventListener('click', closeSavedPlacesModal);
document.getElementById('saved-places-modal-backdrop')?.addEventListener('click', closeSavedPlacesModal);
document.getElementById('add-new-saved-place-btn')?.addEventListener('click', () => openSaveAddressEditor('new'));
document.getElementById('save-address-editor-close')?.addEventListener('click', closeSaveAddressEditor);
document.getElementById('save-address-editor-backdrop')?.addEventListener('click', closeSaveAddressEditor);
document.getElementById('save-address-cancel-btn')?.addEventListener('click', closeSaveAddressEditor);

document.querySelectorAll('.save-address-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        if (saveAddressTypeInput && !saveAddressTypeInput.readOnly) {
            saveAddressTypeInput.value = chip.dataset.label || '';
            document.querySelectorAll('.save-address-tag-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            saveAddressLocationInput?.focus();
        }
    });
});

saveAddressEditorForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const label = cleanText(saveAddressTypeInput?.value);
    const address = pickedPlace?.address || cleanText(saveAddressLocationInput?.value);
    if (!label || !address) return;
    persistSavedPlace(activeEditingSlotOrIndex, label, address);
});

// ==========================================
// Prominent search bar
// ==========================================

dashboardSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = cleanText(dashboardSearchInput?.value);
    if (!text) {
        window.location.href = '/services.html';
        return;
    }
    goToServicesWithDestination(text);
});

// ==========================================
// Bootstrap
// ==========================================

// Run initial greeting calculation immediately on script load for instant display
updateGreeting();
updateDynamicSubGreeting();
initOurServices();

window.addEventListener('user-session-ready', (event) => {
    const profile = event.detail || {};
    if (profile.role === "driver" || !profile.uid) return;
    currentUid = profile.uid;
    updateGreeting(profile.name || profile.displayName);
    updateDynamicSubGreeting();
    setupSideDrawer(profile);
    initSavedPlaces(profile.uid);
});
