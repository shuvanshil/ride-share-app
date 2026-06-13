import { initializeMapEngine } from './map.js';

const pickupInput = document.getElementById('pickup-input');
const dropInput = document.getElementById('drop-input');
const findRideBtn = document.getElementById('request-ride-btn');
const refreshLocationBtn = document.getElementById('refresh-location-btn');
const clearDropBtn = document.getElementById('clear-drop-btn');
const locationStatus = document.getElementById('services-location-status');
const gpsPill = document.getElementById('services-gps-pill');

function setStatus(message, state = "loading") {
    locationStatus.innerText = message;
    gpsPill.dataset.state = state;
    gpsPill.innerText = state === "ready" ? "Live" : state === "error" ? "Check" : "GPS";
}

async function bootServicesMap() {
    try {
        setStatus("Locking your exact location...", "loading");
        await initializeMapEngine();
        setStatus(pickupInput.value || "Pickup location detected.", "ready");
    } catch (error) {
        console.error("Services map failed to initialize:", error);
        setStatus("Could not load map. Check location permission and internet.", "error");
    }
}

function saveBookingDraftAndContinue() {
    const pickup = pickupInput.value.trim();
    const drop = dropInput.value.trim();
    const fare = document.getElementById('fare-amount')?.innerText || "₹0.00";

    if (!pickup) {
        alert("Please allow location access or wait for pickup detection.");
        return;
    }

    if (!drop) {
        alert("Please enter your drop location.");
        dropInput.focus();
        return;
    }

    if (fare === "₹0.00" && !window.latestFareQuote) {
        alert("Please choose a known destination like Unakoti, Kumarghat Station, RGM Hospital, or Dharmanagar to calculate fare.");
        dropInput.focus();
        return;
    }

    sessionStorage.setItem("goyatra_service_booking_draft", JSON.stringify({
        pickup,
        drop,
        createdAt: Date.now()
    }));

    window.location.href = "index.html";
}

findRideBtn.addEventListener('click', saveBookingDraftAndContinue);

refreshLocationBtn.addEventListener('click', () => {
    bootServicesMap();
});

clearDropBtn.addEventListener('click', () => {
    dropInput.value = "";
    dropInput.dispatchEvent(new Event('input', { bubbles: true }));
    dropInput.focus();
});

dropInput.addEventListener('input', () => {
    findRideBtn.disabled = !dropInput.value.trim();
});

findRideBtn.disabled = true;
bootServicesMap();
