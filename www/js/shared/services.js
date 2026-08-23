import { auth, db } from '../platform/firebase-init.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeMapEngine, useCurrentPickupLocation, warmGoogleMaps } from '../map/map-core.js';
import { getRideService } from './fare-policy.js';
import { acquireWakeLock, releaseWakeLock } from '../platform/wake-lock.js';
import { setInlineLoading, hideInitialLoader } from './loading.js';
import { waitForAuth } from './auth.js';
import { showAlert } from './dialog.js';

const dashboardView = document.getElementById('dashboard-view');
const pickupInput = document.getElementById('pickup-input');
const dropInput = document.getElementById('drop-input');
const findRideBtn = document.getElementById('request-ride-btn');
const refreshLocationBtn = document.getElementById('refresh-location-btn');
const clearDropBtn = document.getElementById('clear-drop-btn');
const locationStatus = document.getElementById('services-location-status');
const gpsPill = document.getElementById('services-gps-pill');
const serviceOptions = document.getElementById('ride-service-options');
const distanceLabel = document.getElementById('ride-distance-label');
const bookingLoginGate = document.getElementById('booking-login-gate');
const swapLocationsBtn = document.getElementById('swap-locations-btn');
const selectOnMapBtn = document.getElementById('select-on-map-btn');

let servicesSessionStarted = false;
let selectedServiceType = "auto";
let serviceSelectionLocked = false;
let isAuthenticatedPassenger = false;
let currentPickup = null;
let savedPlacesCache = {};
let currentPassengerUid = null;
let activeEditingSlotOrIndex = null;
const requestedDestination = new URLSearchParams(window.location.search).get("destination")?.trim() || "";

warmGoogleMaps();

function selectRideService(serviceType) {
    if (serviceSelectionLocked) return;
    const service = getRideService(serviceType);
    const fare = window.latestFareQuote?.fare_options?.[serviceType];
    if (!service || !Number.isFinite(fare)) return;

    selectedServiceType = serviceType;
    window.selectedRideService = { ...service, fare };
    document.querySelectorAll('[data-service-type]').forEach((card) => {
        const selected = card.dataset.serviceType === serviceType;
        card.classList.toggle('is-selected', selected);
        card.setAttribute('aria-pressed', String(selected));
    });
    const fareAmountEl = document.getElementById('fare-amount');
    if (fareAmountEl) fareAmountEl.innerText = `₹${fare}`;
    const availPriceEl = document.getElementById('availability-price-amount');
    if (availPriceEl) availPriceEl.innerText = `₹${fare}`;
    const availWrapper = document.getElementById('availability-card-wrapper');
    if (availWrapper) availWrapper.classList.remove('d-none');
    findRideBtn.innerText = `Confirm ${service.shortName} · ₹${fare}`;
    findRideBtn.disabled = false;
}

function renderFareOptions(quote) {
    if (!quote?.fare_options) return;
    document.getElementById('bike-fare').innerText = `₹${quote.fare_options.bike}`;
    document.getElementById('auto-fare').innerText = `₹${quote.fare_options.auto}`;
    distanceLabel.innerText = `${Number(quote.distance_km).toFixed(1)} km`;
    const headingCopy = serviceOptions.querySelector('.ride-service-heading p');
    if (headingCopy) {
        headingCopy.innerText = quote.is_night_fare
            ? "Night fare applies from 10:00 PM to 4:30 AM."
            : "Vehicle locked for your active ride.";
    }
    const availWrapper = document.getElementById('availability-card-wrapper');
    if (availWrapper) availWrapper.classList.remove('d-none');
    serviceOptions.classList.remove('d-none');
    selectRideService(selectedServiceType);
}

function resetFareOptions() {
    if (serviceSelectionLocked) return;
    window.selectedRideService = null;
    serviceOptions.classList.add('d-none');
    const fareQuoteBox = document.getElementById('fare-quote-box');
    if (fareQuoteBox) {
        fareQuoteBox.classList.add('d-none');
        fareQuoteBox.classList.remove('d-flex');
    }
    const availWrapper = document.getElementById('availability-card-wrapper');
    if (availWrapper) availWrapper.classList.add('d-none');
    findRideBtn.innerHTML = dropInput.value.trim()
        ? '<span class="lu-spinner lu-spinner-sm" aria-hidden="true"></span><span>Just a sec...</span>'
        : "Please enter destination";
    findRideBtn.disabled = true;
}

function setServiceSelectionLocked(detail = {}) {
    serviceSelectionLocked = Boolean(detail.locked);
    serviceOptions.classList.toggle('is-locked', serviceSelectionLocked);
    if (serviceSelectionLocked) acquireWakeLock(); else releaseWakeLock();

    const headingCopy = serviceOptions.querySelector('.ride-service-heading p');
    if (headingCopy) {
        headingCopy.innerText = serviceSelectionLocked
            ? "Vehicle locked for your active ride."
            : "Fares use the calculated road distance.";
    }

    document.querySelectorAll('[data-service-type]').forEach((card) => {
        const selected = serviceSelectionLocked && card.dataset.serviceType === detail.vehicleType;
        card.disabled = serviceSelectionLocked;
        if (serviceSelectionLocked) {
            card.classList.toggle('is-selected', selected);
            card.setAttribute('aria-pressed', String(selected));
        }
    });

    if (!serviceSelectionLocked) return;

    selectedServiceType = detail.vehicleType;
    const service = getRideService(selectedServiceType);
    if (!service) return;

    serviceOptions.classList.remove('d-none');
    window.selectedRideService = { ...service, fare: detail.fare };
    if (Number.isFinite(detail.fare)) {
        document.getElementById(`${selectedServiceType}-fare`).innerText = `₹${detail.fare}`;
        const fareAmountEl = document.getElementById('fare-amount');
        if (fareAmountEl) fareAmountEl.innerText = `₹${detail.fare}`;
        const availPriceEl = document.getElementById('availability-price-amount');
        if (availPriceEl) availPriceEl.innerText = `₹${detail.fare}`;
    }
    if (Number.isFinite(detail.distanceKm)) {
        distanceLabel.innerText = `${detail.distanceKm.toFixed(1)} km`;
    }
}

function setStatus(message, state = "loading") {
    if (locationStatus) locationStatus.innerText = message;
    if (!gpsPill) return;

    gpsPill.dataset.state = state;
    gpsPill.innerText = state === "ready" ? "Live" : state === "error" ? "Check" : "GPS";
    setInlineLoading(gpsPill, state === "loading");
}

function showPassengerServices() {
    dashboardView.classList.remove('d-none');
}

function setGuestLoginVisibility(visible) {
    document.querySelectorAll('.guest-login-btn').forEach((button) => {
        button.classList.toggle('d-none', !visible);
    });
    const safeBadge = document.getElementById('services-safe-badge');
    if (safeBadge) {
        safeBadge.classList.toggle('d-none', visible);
    }
    const profileTrigger = document.getElementById('profile-menu-trigger');
    if (profileTrigger) {
        profileTrigger.classList.toggle('d-none', visible);
    }
}

function openBookingLoginGate() {
    bookingLoginGate.classList.remove('d-none');
}

function closeBookingLoginGate() {
    bookingLoginGate.classList.add('d-none');
}

function requestPrefilledDestination() {
    if (!requestedDestination || window.selectedDestination) return;
    dropInput.value = requestedDestination;
    window.dispatchEvent(new CustomEvent('prefill-destination-request', {
        detail: { query: requestedDestination }
    }));
}

function startGuestServices() {
    isAuthenticatedPassenger = false;
    setGuestLoginVisibility(true);
    showPassengerServices();
    if (!servicesSessionStarted) {
        servicesSessionStarted = true;
        initializeMapEngine().catch((error) => {
            console.error("Guest map initialization failed:", error);
            setStatus("Could not load the map. Check location permission.", "error");
        });
    }
}

async function refreshServicesMap() {
    try {
        setStatus("Detecting your current pickup location...", "loading");
        await useCurrentPickupLocation();
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    } catch (error) {
        console.error("Services location refresh failed:", error);
        setStatus("Could not refresh location. Check GPS permission.", "error");
    }
}

function swapLocations() {
    if (serviceSelectionLocked) return;
    const pLoc = currentPickup;
    const dLoc = window.selectedDestination;

    if (!pLoc || !dLoc) return;

    // Local swap of values for immediate feedback
    pickupInput.value = dLoc.name || dLoc.mainName;
    dropInput.value = pLoc.name || pLoc.mainName;

    window.dispatchEvent(new CustomEvent('locations-swapped', {
        detail: { pickup: dLoc, destination: pLoc }
    }));
}

function bindServicesControls() {
    if (refreshLocationBtn) refreshLocationBtn.addEventListener('click', refreshServicesMap);
    if (swapLocationsBtn) swapLocationsBtn.addEventListener('click', swapLocations);
    if (selectOnMapBtn) {
        selectOnMapBtn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('request-destination-pick-on-map'));
        });
    }

    if (clearDropBtn) {
        clearDropBtn.addEventListener('click', () => {
            if (dropInput && dropInput.readOnly) return;
            if (dropInput) {
                dropInput.value = "";
                dropInput.dispatchEvent(new Event('input', { bubbles: true }));
                dropInput.focus();
            }
        });
    }

    if (dropInput) {
        dropInput.addEventListener('input', () => {
            resetFareOptions();
        });
    }

    document.querySelectorAll('[data-service-type]').forEach((card) => {
        card.addEventListener('click', () => selectRideService(card.dataset.serviceType));
    });

    window.addEventListener('fare-quote-updated', (event) => renderFareOptions(event.detail));
    window.addEventListener('fare-quote-reset', resetFareOptions);
    window.addEventListener('passenger-service-lock-changed', (event) => setServiceSelectionLocked(event.detail));
    window.addEventListener('ride-completed-clear-map', () => releaseWakeLock());

    window.addEventListener('map-engine-ready', () => {
        if (pickupInput) setStatus(pickupInput.value || "Pickup location detected.", "ready");
        requestPrefilledDestination();
    });

    window.addEventListener('pickup-location-updated', (event) => {
        currentPickup = event.detail;
        setStatus(event.detail?.name || "Pickup location detected.", "ready");
    });

    if (findRideBtn) {
        findRideBtn.addEventListener('click', () => {
            if (!isAuthenticatedPassenger && window.selectedRideService) {
                openBookingLoginGate();
            }
        });
    }

    const loginBtn = document.getElementById('booking-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            window.location.href = '/login.html';
        });
    }

    const loginCloseBtn = document.getElementById('booking-login-close-btn');
    if (loginCloseBtn) loginCloseBtn.addEventListener('click', closeBookingLoginGate);

    if (bookingLoginGate) {
        bookingLoginGate.addEventListener('click', (event) => {
            if (event.target === bookingLoginGate) closeBookingLoginGate();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && bookingLoginGate && !bookingLoginGate.classList.contains('d-none')) {
            closeBookingLoginGate();
        }
    });
}


bindServicesControls();
findRideBtn.disabled = true;

function initEstimatedPriceInfoPopover() {
    const infoBtn = document.getElementById('estimated-price-info-btn');
    const popover = document.getElementById('estimated-price-popover');
    const closeBtn = document.getElementById('estimated-price-popover-close');
    const backdrop = document.getElementById('estimated-price-popover-backdrop');

    if (!infoBtn || !popover) return;

    const openPopover = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        popover.classList.remove('d-none');
        document.body.classList.add('popover-open');
    };

    const closePopover = () => {
        popover.classList.add('d-none');
        document.body.classList.remove('popover-open');
    };

    infoBtn.addEventListener('click', openPopover);
    closeBtn?.addEventListener('click', closePopover);
    backdrop?.addEventListener('click', closePopover);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !popover.classList.contains('d-none')) {
            closePopover();
        }
    });
}

async function bootstrapServices() {
    initEstimatedPriceInfoPopover();
    // Start guest services immediately if auth takes too long,
    // ensuring the map loads for everyone.
    const mapTimeout = setTimeout(() => {
        if (!servicesSessionStarted) startGuestServices();
    }, 2500);

    const user = await waitForAuth();
    clearTimeout(mapTimeout);

    if (!user) {
        startGuestServices();
        hideInitialLoader();
        return;
    }

    try {
        const userDocSnap = await getDoc(doc(db, "users", user.uid));
        if (!userDocSnap.exists()) {
            startGuestServices();
            hideInitialLoader();
            return;
        }

        const profile = userDocSnap.data();
        if (profile.role === "driver") {
            window.location.replace('/driver.html');
            return;
        }

        isAuthenticatedPassenger = true;
        setGuestLoginVisibility(false);
        showPassengerServices();
        loadSavedPlacesForUser(user.uid);

        if (!servicesSessionStarted) {
            servicesSessionStarted = true;
            initializeMapEngine().catch((error) => {
                console.error("Passenger map initialization failed:", error);
                setStatus("Could not load the map. Check location permission.", "error");
            });
            window.dispatchEvent(new CustomEvent('user-session-ready', { detail: profile }));
        }
        hideInitialLoader();
    } catch (error) {
        console.error("Services bootstrap failed:", error);
        startGuestServices();
        hideInitialLoader();
    }
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
// Saved Places & Quick Chips Controller
// ==========================================

function updateQuickChipsUI() {
    // Quick chips updated for Saved Places modal
}

function selectDestinationAddress(addressText) {
    if (!addressText || !dropInput) return;
    dropInput.value = addressText;
    dropInput.dispatchEvent(new Event('input', { bubbles: true }));
    dropInput.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector(".user-location-bubble-card")?.classList?.remove("user-location-wobble");
}

async function loadSavedPlacesForUser(uid) {
    currentPassengerUid = uid;
    try {
        const snap = await getDoc(doc(db, "savedPlaces", uid));
        savedPlacesCache = snap.exists() ? snap.data() : {};
    } catch (e) {
        console.warn("Could not load saved places:", e);
        savedPlacesCache = {};
    }
    updateQuickChipsUI();
}

function renderSavedPlacesModalList() {
    const container = document.getElementById('saved-places-list-container');
    if (!container) return;

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
                <strong>Home</strong>
                <small>${home?.address ? escapeHtml(home.address) : 'Not saved yet - tap pencil to add'}</small>
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
                <strong>Work</strong>
                <small>${work?.address ? escapeHtml(work.address) : 'Not saved yet - tap pencil to add'}</small>
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
                    <strong>${escapeHtml(place.name || 'Saved Place')}</strong>
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

    container.innerHTML = html;

    // Manage Add Address Button state (max 3 custom places)
    const addBtn = document.getElementById('add-new-saved-place-btn');
    if (addBtn) {
        addBtn.classList.toggle('d-none', customPlaces.length >= 3);
    }
}

function openSavedPlacesModal() {
    renderSavedPlacesModalList();
    document.getElementById('saved-places-modal')?.classList.remove('d-none');
}

function closeSavedPlacesModal() {
    document.getElementById('saved-places-modal')?.classList.add('d-none');
}

function openSaveAddressEditor(targetKey, defaultLabel = "", defaultAddress = "") {
    activeEditingSlotOrIndex = targetKey;
    const modal = document.getElementById('save-address-editor-modal');
    const labelInput = document.getElementById('save-address-type-input');
    const locationInput = document.getElementById('save-address-location-input');
    const titleEl = document.getElementById('save-address-editor-title');

    if (!modal) return;

    if (targetKey === 'home') {
        labelInput.value = "Home";
        labelInput.readOnly = true;
        titleEl.textContent = "Save Home Address";
    } else if (targetKey === 'work') {
        labelInput.value = "Work";
        labelInput.readOnly = true;
        titleEl.textContent = "Save Work Address";
    } else {
        labelInput.value = defaultLabel || "";
        labelInput.readOnly = false;
        titleEl.textContent = "Save New Address";
    }

    locationInput.value = defaultAddress || "";
    modal.classList.remove('d-none');
    setTimeout(() => (labelInput.readOnly ? locationInput.focus() : labelInput.focus()), 100);
}

function closeSaveAddressEditor() {
    document.getElementById('save-address-editor-modal')?.classList.add('d-none');
    activeEditingSlotOrIndex = null;
}

async function persistSavedPlace(targetKey, label, address) {
    if (!currentPassengerUid) {
        openBookingLoginGate();
        return;
    }

    const submitBtn = document.getElementById('save-address-submit-btn');
    const originalText = submitBtn ? submitBtn.innerHTML : 'Save Address';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="lu-spinner lu-spinner-sm me-2" style="border-top-color:#fff;"></span>Saving...';
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
            showAlert("You can save up to 3 places in addition to Home and Work.");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
            return;
        }
        payload.customPlaces.push({ name: label, address });
    }

    try {
        await setDoc(doc(db, "savedPlaces", currentPassengerUid), payload, { merge: true });
        savedPlacesCache = payload;
        renderSavedPlacesModalList();
        closeSaveAddressEditor();
    } catch (e) {
        console.error("Could not save address:", e);
        showAlert("Could not save address. Please try again.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    }
}

async function deleteSavedPlaceItem(targetKey, customIndex = null, btnElement = null) {
    if (!currentPassengerUid) return;

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
        await setDoc(doc(db, "savedPlaces", currentPassengerUid), payload);
        savedPlacesCache = payload;
        renderSavedPlacesModalList();
    } catch (e) {
        console.error("Could not delete saved place:", e);
        showAlert("Could not delete place. Try again.");
        renderSavedPlacesModalList();
    }
}

window.selectSavedPlace = (targetKey, index = null) => {
    let address = "";
    if (targetKey === 'home') address = savedPlacesCache?.home?.address;
    else if (targetKey === 'work') address = savedPlacesCache?.work?.address;
    else if (targetKey === 'custom' && Number.isInteger(index)) address = savedPlacesCache?.customPlaces?.[index]?.address;

    if (address) {
        selectDestinationAddress(address);
        closeSavedPlacesModal();
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

document.getElementById('chip-saved-places-btn')?.addEventListener('click', () => {
    if (!isAuthenticatedPassenger) {
        openBookingLoginGate();
        return;
    }
    openSavedPlacesModal();
});

document.getElementById('saved-places-modal-close')?.addEventListener('click', closeSavedPlacesModal);
document.getElementById('saved-places-modal-backdrop')?.addEventListener('click', closeSavedPlacesModal);

document.getElementById('add-new-saved-place-btn')?.addEventListener('click', () => {
    openSaveAddressEditor('new');
});

document.getElementById('save-address-editor-close')?.addEventListener('click', closeSaveAddressEditor);
document.getElementById('save-address-editor-backdrop')?.addEventListener('click', closeSaveAddressEditor);
document.getElementById('save-address-cancel-btn')?.addEventListener('click', closeSaveAddressEditor);

document.getElementById('save-address-editor-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const label = document.getElementById('save-address-type-input').value.trim();
    const address = document.getElementById('save-address-location-input').value.trim();
    if (!label || !address) return;
    persistSavedPlace(activeEditingSlotOrIndex, label, address);
});

window.addEventListener("ride-status-updated", (e) => {
    const status = e.detail?.status || e.detail?.ride?.status;
    const isLiveAssigned = ["accepted", "arrived", "started", "en_route"].includes(status);
    document.getElementById("services-map-card")?.classList.toggle("is-expanded", isLiveAssigned);
});
window.addEventListener("driver-assigned", () => {
    document.getElementById("services-map-card")?.classList.add("is-expanded");
});
window.addEventListener("fare-quote-updated", () => {
    // Automatically expand map height when destination is calculated and route is presented
    document.getElementById("services-map-card")?.classList.add("is-expanded");
});
window.addEventListener("destination-selected", () => {
    document.getElementById("services-map-card")?.classList.add("is-expanded");
});
window.addEventListener("fare-quote-reset", () => {
    document.getElementById("services-map-card")?.classList.remove("is-expanded");
});
window.addEventListener("ride-completed-clear-map", () => {
    document.getElementById("services-map-card")?.classList.remove("is-expanded");
});

bootstrapServices();
