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
import { showAlert, showConfirm } from '../shared/dialog.js';
import { showSkeleton, setButtonBusy } from '../shared/loading.js';
import { waitForAuth } from '../shared/auth.js';
import { t } from '../shared/i18n.js';

const UNCLEAR_LOCATION_LABELS = new Set(["current location", "current", "my location", "pinned pickup", "pinned destination"]);
const RECENT_RIDES_LIMIT = 3;
const SAVED_PLACE_SLOTS = ["home", "work"];
const TRIPURA_CENTER = { lat: 23.8315, lng: 91.2868 };

const recentRidesList = document.getElementById('dashboard-recent-rides');
const recentRidesSection = document.getElementById('dashboard-recent-section');
const savedPlacesRow = document.getElementById('dashboard-saved-places');
const dashboardSearchForm = document.getElementById('dashboard-search-form');
const dashboardSearchInput = document.getElementById('dashboard-search-input');
const savedPlaceModal = document.getElementById('saved-place-modal');
const savedPlaceForm = document.getElementById('saved-place-form');
const savedPlaceTitle = document.getElementById('saved-place-modal-title');
const savedPlaceAddressInput = document.getElementById('saved-place-address-input');
const savedPlaceSuggestions = document.getElementById('saved-place-suggestions');
const savedPlaceUseGpsBtn = document.getElementById('saved-place-use-gps-btn');
const savedPlaceCancelBtn = document.getElementById('saved-place-cancel-btn');
const savedPlaceRemoveBtn = document.getElementById('saved-place-remove-btn');

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

function formatMoney(value) {
    const amount = Number(value || 0);
    return `₹${Math.round(amount)}`;
}

function getTripTime(trip) {
    const timestamp = trip.finalStatusAt || trip.completedAt || trip.cancelledAt || trip.verifiedAt;
    return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function getTripDestination(trip) {
    if (!isUnclearLocation(trip.drop_display_address)) return trip.drop_display_address;
    if (!isUnclearLocation(trip.drop_location)) return trip.drop_location;
    return t('history.drop_not_recorded', "Destination not recorded");
}

function formatRelativeDay(millis) {
    if (!millis) return "";
    const diffDays = Math.floor((Date.now() - millis) / (24 * 60 * 60 * 1000));
    if (diffDays <= 0) return t('history.today', "Today");
    if (diffDays === 1) return t('history.yesterday', "Yesterday");
    if (diffDays < 7) {
        const lang = (window.LiphtUpI18n && window.LiphtUpI18n.getCurrentLang) ? window.LiphtUpI18n.getCurrentLang() : 'en';
        return lang === 'bn' ? `${diffDays} দিন আগে` : `${diffDays} days ago`;
    }
    return new Date(millis).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function updateGreeting(name) {
    const greetingEl = document.getElementById('greeting-text');
    if (!greetingEl) return;

    const hour = new Date().getHours();
    let key = "home.greeting_morning";
    let fallback = "Good morning";
    if (hour >= 12 && hour < 17) {
        key = "home.greeting_afternoon";
        fallback = "Good afternoon";
    } else if (hour >= 17 || hour < 4) {
        key = "home.greeting_evening";
        fallback = "Good evening";
    }

    const translatedGreeting = t(key, fallback);

    greetingEl.innerHTML = `${translatedGreeting}, <span id="user-display-name">${escapeHtml(name || 'User')}</span> 👋`;
}

window.addEventListener('languageChanged', () => {
    const nameEl = document.getElementById('user-display-name');
    if (nameEl) {
        updateGreeting(nameEl.innerText);
    }
    renderSavedPlaces();
    renderRecentRides();
});

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
}

// ==========================================
// Recent rides
// ==========================================

async function loadRecentRides(uid) {
    const q = query(collection(db, "tripHistory"), where("passenger_id", "==", uid));
    const snap = await getDocs(q);
    return snap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => getTripTime(b) - getTripTime(a))
        .slice(0, RECENT_RIDES_LIMIT);
}

function renderRecentRides(trips) {
    if (!recentRidesList) return;

    if (!trips.length) {
        recentRidesSection?.classList.add('d-none');
        return;
    }

    recentRidesSection?.classList.remove('d-none');
    const tCancelled = (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t('history.status_cancelled') : "Cancelled";
    recentRidesList.innerHTML = trips.map((trip) => {
        const destination = getTripDestination(trip);
        const when = formatRelativeDay(getTripTime(trip)) || "Recently";
        const cancelled = trip.final_status === "cancelled" || trip.status === "cancelled";
        const fareFormatted = formatMoney(trip.fare_amount || trip.price || 0);

        return `
            <button type="button" class="dashboard-recent-item${cancelled ? ' is-cancelled' : ''}" data-destination="${escapeHtml(destination)}">
                <div class="recent-item-icon-badge">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1A7A2E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                        <path d="M12 7v5l4 2"/>
                    </svg>
                </div>
                <div class="dashboard-recent-item-text">
                    <strong>${escapeHtml(destination)}</strong>
                    <small>
                        <span>${escapeHtml(when)}</span>
                        ${cancelled ? `<span class="dot-separator">•</span><span class="status-cancelled">${tCancelled}</span>` : ''}
                    </small>
                </div>
                <div class="dashboard-recent-item-right">
                    <strong class="recent-fare-amount${cancelled ? ' is-cancelled' : ''}">${escapeHtml(cancelled ? '₹0' : fareFormatted)}</strong>
                    <span class="chevron-right-arrow">&rsaquo;</span>
                </div>
            </button>
        `;
    }).join('');

    recentRidesList.querySelectorAll('.dashboard-recent-item').forEach((btn) => {
        btn.addEventListener('click', () => goToServicesWithDestination(btn.dataset.destination));
    });
}

let cachedTripsForLanguageSwitch = [];

window.addEventListener('languageChanged', () => {
    renderSavedPlaces();
    if (cachedTripsForLanguageSwitch.length) {
        renderRecentRides(cachedTripsForLanguageSwitch);
    }
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

async function initRecentRides(uid) {
    if (!recentRidesList) return;
    const clearSkeleton = showSkeleton(recentRidesList, { kind: 'avatar-row', count: 2 });
    try {
        const user = await waitForAuth();
        const activeUid = uid || user?.uid;
        if (!activeUid) {
            clearSkeleton();
            recentRidesSection?.classList.add('d-none');
            return;
        }
        const trips = await loadRecentRides(activeUid);
        clearSkeleton();
        renderRecentRides(trips);
    } catch (error) {
        console.warn("Could not load recent rides:", error);
        clearSkeleton();
        recentRidesSection?.classList.add('d-none');
    }
}

// ==========================================
// Saved places (Home / Work / favourites)
// ==========================================

async function loadSavedPlaces(uid) {
    try {
        const user = await waitForAuth();
        const activeUid = uid || user?.uid;
        if (!activeUid) return {};
        const snap = await getDoc(doc(db, "savedPlaces", activeUid));
        return snap.exists() ? snap.data() : {};
    } catch (error) {
        console.warn("Could not load saved places:", error);
        return {};
    }
}

function savedPlaceChipMarkup(slot, place) {
    const t = (key, fallback) => (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t(key) : fallback;
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
                openSavedPlaceModal(slot);
            }
        });
    });

    savedPlacesRow.querySelectorAll('.dashboard-saved-chip-edit').forEach((editBtn) => {
        editBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            openSavedPlaceModal(editBtn.dataset.slot);
        });
    });
}

async function initSavedPlaces(uid) {
    if (!savedPlacesRow) return;
    const clearSkeleton = showSkeleton(savedPlacesRow, { kind: 'line', count: 1 });
    savedPlacesCache = await loadSavedPlaces(uid);
    clearSkeleton();
    renderSavedPlaces();
}

function openSavedPlaceModal(slot) {
    if (!savedPlaceModal) return;
    activeSavedSlot = slot;
    const existing = savedPlacesCache?.[slot];
    pickedPlace = existing?.address ? { ...existing } : null;
    if (savedPlaceTitle) savedPlaceTitle.textContent = slot === "home" ? t('profile.save_home_title', "Save your Home address") : t('profile.save_work_title', "Save your Work address");
    if (savedPlaceAddressInput) savedPlaceAddressInput.value = existing?.address || "";
    if (savedPlaceSuggestions) savedPlaceSuggestions.innerHTML = "";
    savedPlaceRemoveBtn?.classList.toggle('d-none', !existing?.address);
    savedPlaceModal.classList.remove('d-none');
    window.requestAnimationFrame(() => savedPlaceAddressInput?.focus());
}

function closeSavedPlaceModal() {
    savedPlaceModal?.classList.add('d-none');
    activeSavedSlot = null;
    pickedPlace = null;
}

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

// Plain autocomplete predictions don't carry coordinates -- resolve them via
// Place Details (same call the main booking search makes) so a saved Home/Work
// address is always backed by real map coordinates, not just a text label.
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

function renderSuggestions(results) {
    if (!savedPlaceSuggestions) return;
    if (!results.length) {
        savedPlaceSuggestions.innerHTML = "";
        return;
    }
    savedPlaceSuggestions.innerHTML = results.slice(0, 5).map((place, index) => `
        <button type="button" class="saved-place-suggestion" data-index="${index}">
            <strong>${escapeHtml(place.name || place.mainName || "")}</strong>
            <small>${escapeHtml(place.fullAddress || "")}</small>
        </button>
    `).join('');

    savedPlaceSuggestions.querySelectorAll('.saved-place-suggestion').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const place = results[Number(btn.dataset.index)];
            if (!place) return;
            savedPlaceSuggestions.innerHTML = "";
            savedPlaceAddressInput.value = place.fullAddress || place.name || "";
            savedPlaceAddressInput.disabled = true;
            pickedPlace = await resolvePlaceCoordinates(place);
            savedPlaceAddressInput.disabled = false;
            if (savedPlaceAddressInput) savedPlaceAddressInput.value = pickedPlace.address;
        });
    });
}

let suggestionDebounceTimer = null;
savedPlaceAddressInput?.addEventListener('input', () => {
    pickedPlace = null;
    const text = savedPlaceAddressInput.value.trim();
    if (suggestionDebounceTimer) window.clearTimeout(suggestionDebounceTimer);
    if (text.length < 2) {
        if (savedPlaceSuggestions) savedPlaceSuggestions.innerHTML = "";
        return;
    }
    suggestionDebounceTimer = window.setTimeout(async () => {
        const results = await searchAddressSuggestions(text);
        renderSuggestions(results);
    }, 250);
});

savedPlaceUseGpsBtn?.addEventListener('click', async () => {
    if (!navigator.geolocation) {
        await showAlert(t('profile.location_not_supported', "Your browser does not support location detection."));
        return;
    }
    const restore = setButtonBusy(savedPlaceUseGpsBtn, t('common.locating', "Locating…"));
    navigator.geolocation.getCurrentPosition(async (position) => {
        try {
            const { latitude, longitude } = position.coords;
            const params = new URLSearchParams({ lat: String(latitude), lng: String(longitude) });
            const response = await fetch(`/api/google-reverse-geocode?${params.toString()}`, {
                headers: { Accept: "application/json" }
            });
            const data = await response.json().catch(() => ({}));
            const result = response.ok ? data.result : null;
            const address = result?.displayAddress || result?.fullAddress || "";
            if (!address) throw new Error(t('profile.location_resolve_failed', "Could not resolve your current address."));

            pickedPlace = { address, lat: latitude, lng: longitude, placeId: "" };
            if (savedPlaceAddressInput) savedPlaceAddressInput.value = address;
            if (savedPlaceSuggestions) savedPlaceSuggestions.innerHTML = "";
        } catch (error) {
            await showAlert(error.message || t('profile.location_detect_failed', "Could not detect your current location."));
        } finally {
            restore();
        }
    }, async () => {
        restore();
        await showAlert(t('profile.location_permission_denied', "Could not access your location. Please allow location access and try again."));
    }, { enableHighAccuracy: true, timeout: 10000 });
});

savedPlaceCancelBtn?.addEventListener('click', closeSavedPlaceModal);
savedPlaceModal?.addEventListener('mousedown', (event) => {
    if (event.target === savedPlaceModal) closeSavedPlaceModal();
});

savedPlaceRemoveBtn?.addEventListener('click', async () => {
    if (!currentUid || !activeSavedSlot) return;
    const label = activeSavedSlot === "home" ? t('profile.home', "Home") : t('profile.work', "Work");
    const confirmed = await showConfirm(`${t('profile.remove_saved_prefix', "Remove your saved")} ${label} ${t('profile.remove_saved_suffix', "address?")}`, {
        okText: t('common.remove', "Remove"),
        cancelText: t('profile.keep_it', "Keep it")
    });
    if (!confirmed) return;

    const restore = setButtonBusy(savedPlaceRemoveBtn, t('common.removing', "Removing…"));
    try {
        await setDoc(doc(db, "savedPlaces", currentUid), {
            [activeSavedSlot]: deleteField(),
            updatedAt: new Date().toISOString()
        }, { merge: true });

        savedPlacesCache = { ...(savedPlacesCache || {}) };
        delete savedPlacesCache[activeSavedSlot];
        renderSavedPlaces();
        closeSavedPlaceModal();
    } catch (error) {
        console.error("Could not remove saved place:", error);
        await showAlert(t('profile.remove_address_failed', "Could not remove this address. Please try again."));
    } finally {
        restore();
    }
});

savedPlaceForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentUid || !activeSavedSlot) return;

    const address = pickedPlace?.address || cleanText(savedPlaceAddressInput?.value);
    if (!address) {
        await showAlert(t('profile.enter_or_pick_address', "Please enter or pick an address first."));
        return;
    }

    const submitBtn = savedPlaceForm.querySelector('button[type="submit"]');
    const restore = setButtonBusy(submitBtn, t('common.saving', "Saving…"));
    try {
        const place = pickedPlace?.address === address
            ? pickedPlace
            : { address, lat: null, lng: null, placeId: "" };

        await setDoc(doc(db, "savedPlaces", currentUid), {
            [activeSavedSlot]: place,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        savedPlacesCache = { ...(savedPlacesCache || {}), [activeSavedSlot]: place };
        renderSavedPlaces();
        closeSavedPlaceModal();
    } catch (error) {
        console.error("Could not save place:", error);
        await showAlert(t('profile.save_address_failed', "Could not save this location. Please try again."));
    } finally {
        restore();
    }
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

window.addEventListener('user-session-ready', (event) => {
    const profile = event.detail || {};
    if (profile.role === "driver" || !profile.uid) return;
    currentUid = profile.uid;
    updateGreeting(profile.name || profile.displayName);
    setupSideDrawer(profile);
    initRecentRides(profile.uid);
    initSavedPlaces(profile.uid);
});
