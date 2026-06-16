import { db } from './firebase-init.js';
import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { MAPPLS_ENABLED, MAPPLS_STATIC_KEY, MAPPLS_TILES_ENABLED } from './map-provider-config.js';

// Local state variables for tracking user position
let userLatitude = 24.3124; // Default center fallback (Kailashahar center)
let userLongitude = 92.0135;
let mapInstance = null;
let userMarker = null;
let routePolyline = null;
let destinationMarker = null;
let globalDriversUnsubscribe = null;
let destinationSearchTimer = null;
let destinationSearchAbortController = null;
const globalDriverMarkers = new Map();

// Fast shortcuts only. Unknown Tripura villages/streets are resolved through Nominatim geocoding below.
const localLandmarks = {
    "kumarghat station": { lat: 24.2415, lng: 92.0312, name: "Kumarghat Railway Station" },
    "rgm hospital": { lat: 24.3210, lng: 92.0110, name: "Kailashahar RGM Hospital" },
    "dharmanagar": { lat: 24.3667, lng: 92.1667, name: "Dharmanagar Town Center" },
    "unakoti": { lat: 24.3236, lng: 92.0272, name: "Unakoti Heritage Site" }
};

const TRIPURA_VIEWBOX = "91.0,24.7,92.6,22.8";
const TRIPURA_BIAS_POINT = "91.9882,23.8315";
const RURAL_PRIORITY_TYPES = new Set([
    "village",
    "hamlet",
    "locality",
    "suburb",
    "neighbourhood",
    "residential",
    "town",
    "city"
]);

const CARTO_TILE_CONFIG = {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
        subdomains: 'abcd',
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
};

function hasMapplsKey() {
    return MAPPLS_ENABLED && MAPPLS_STATIC_KEY.trim().length > 0;
}

function getMapplsTileConfig() {
    if (!hasMapplsKey() || !MAPPLS_TILES_ENABLED) return null;

    return {
        url: `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/tiles/{z}/{x}/{y}.png`,
        options: {
            maxZoom: 19,
            attribution: '&copy; Mappls'
        }
    };
}

export function createBaseTileLayer(leafletInstance = window.L) {
    const provider = getMapplsTileConfig() || CARTO_TILE_CONFIG;
    return leafletInstance.tileLayer(provider.url, provider.options);
}

function buildReadableAddressFromObject(address = {}) {
    const parts = [
        address.poi || address.houseName || address.house_number,
        address.road || address.street || address.locality || address.subLocality || address.subLocalityName,
        address.suburb || address.neighbourhood || address.village || address.hamlet || address.district || address.subDistrict,
        address.city || address.town || address.state_district || address.state
    ].filter(Boolean);

    return [...new Set(parts)].join(", ");
}

function normalizeMapplsSuggestion(item) {
    const latitude = Number(item?.latitude ?? item?.lat);
    const longitude = Number(item?.longitude ?? item?.lng ?? item?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }

    const mainName = item.placeName || item.place_name || item.placeAddress || item.name || item.keyword;
    const fullAddress = item.placeAddress || item.address || buildReadableAddressFromObject(item) || "Tripura, India";
    if (!mainName && !fullAddress) {
        return null;
    }

    return {
        lat: latitude,
        lng: longitude,
        name: mainName || fullAddress,
        mainName: mainName || fullAddress,
        fullAddress
    };
}

async function fetchJsonWithGracefulFailure(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

// 1. Fetch live hardware GPS coordinates from the device
export function getUserLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            updatePickupInputField(userLatitude, userLongitude, true);
            resolve({ lat: userLatitude, lng: userLongitude });
            return;
        }

        const geoOptions = {
            enableHighAccuracy: true,
            timeout: 5000, // 5 seconds timeout before fallback
            maximumAge: 0
        };

        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLatitude = position.coords.latitude;
                userLongitude = position.coords.longitude;
                console.log(`GPS Lock Acquired: Lat ${userLatitude}, Lng ${userLongitude}`);
                updatePickupInputField(userLatitude, userLongitude, false);
                resolve({ lat: userLatitude, lng: userLongitude });
            },
            (error) => {
                console.warn(`GPS Fallback Active (${error.message}). Using regional defaults.`);
                updatePickupInputField(userLatitude, userLongitude, true);
                resolve({ lat: userLatitude, lng: userLongitude });
            },
            geoOptions
        );
    });
}

async function updatePickupInputField(lat, lng, isFallback) {
    const pickupField = document.getElementById('pickup-input');
    if (!pickupField) return;

    if (isFallback) {
        pickupField.value = "Kailashahar Center (Simulation)";
        return;
    }

    pickupField.value = "Fetching your location...";

    try {
        const readableAddress = await reverseGeocodePickup(lat, lng);
        pickupField.value = readableAddress || `My Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    } catch (error) {
        console.warn("Reverse geocoding failed:", error);
        pickupField.value = `My Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    }
}

async function reverseGeocodePickup(lat, lng) {
    const mapplsAddress = await reverseGeocodeWithMappls(lat, lng);
    if (mapplsAddress) {
        return mapplsAddress;
    }

    const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
        { headers: { "Accept-Language": "en" } }
    );
    const data = await response.json();
    const addr = data.address || {};
    const readableParts = [
        addr.road,
        addr.suburb,
        addr.city || addr.town || addr.village
    ].filter(Boolean);

    return readableParts.length
        ? readableParts.join(", ")
        : null;
}

async function reverseGeocodeWithMappls(lat, lng) {
    if (!hasMapplsKey()) return null;

    const reverseUrlCandidates = [
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/rev_geocode?lat=${lat}&lng=${lng}`,
        `https://atlas.mappls.com/api/places/rev_geocode?lat=${lat}&lng=${lng}&access_token=${encodeURIComponent(MAPPLS_STATIC_KEY)}`
    ];

    for (const url of reverseUrlCandidates) {
        try {
            const data = await fetchJsonWithGracefulFailure(url, {
                headers: { "Accept-Language": "en" }
            });
            const address = Array.isArray(data?.results)
                ? data.results[0]
                : Array.isArray(data?.items)
                    ? data.items[0]
                    : data;
            const readableAddress = buildReadableAddressFromObject(address);

            if (readableAddress) {
                return readableAddress;
            }

            if (address?.formatted_address || address?.placeAddress) {
                return address.formatted_address || address.placeAddress;
            }
        } catch (error) {
            console.warn("Mappls reverse geocode attempt failed:", error);
        }
    }

    return null;
}

function injectMapStyles() {
    if (document.getElementById('rideshare-map-styles')) return;

    const mapStyle = document.createElement('style');
    mapStyle.id = 'rideshare-map-styles';
    mapStyle.textContent = `
        .pickup-pulse-dot {
            width: 16px;
            height: 16px;
            background: #22c55e;
            border: 3px solid #fff;
            border-radius: 50%;
            box-shadow: 0 0 0 rgba(34, 197, 94, 0.45);
            animation: pickupPulse 1.6s infinite;
        }

        @keyframes pickupPulse {
            0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
            70% { box-shadow: 0 0 0 18px rgba(34, 197, 94, 0); }
            100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }

        .leaflet-popup-content-wrapper {
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        }

        .leaflet-popup-tip {
            display: none;
        }

        .map-popup-title {
            font-weight: 600;
            font-size: 14px;
            color: #111;
        }

        .map-popup-sub {
            font-size: 12px;
            color: #666;
        }

        .global-driver-marker {
            background: transparent;
            border: 0;
        }

        .global-driver-shell {
            width: 38px;
            height: 38px;
            display: grid;
            place-items: center;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 8px 18px rgba(17, 24, 39, 0.25);
            transform: translateZ(0);
        }

        .global-driver-marker.bike .global-driver-shell {
            border: 2px solid #1A7A2E;
        }

        .global-driver-marker.auto .global-driver-shell {
            border: 2px solid #facc15;
        }

        .destination-suggestions {
            display: none;
            width: 100%;
            margin-top: 10px;
            border: 1px solid #e7e7e7;
            border-radius: 12px;
            background: #fff;
            box-shadow: 0 14px 34px rgba(17, 24, 39, 0.12);
            overflow: hidden;
            z-index: 1200;
        }

        .destination-suggestions.is-visible {
            display: block;
        }

        .destination-suggestions-title {
            padding: 12px 14px 4px;
            color: #111;
            font-size: 14px;
            font-weight: 800;
        }

        .destination-suggestion-item {
            width: 100%;
            display: grid;
            grid-template-columns: 42px 1fr;
            gap: 12px;
            align-items: center;
            padding: 13px 14px;
            border: 0;
            border-top: 1px solid #f0f0f0;
            background: #fff;
            text-align: left;
        }

        .destination-suggestion-item:active,
        .destination-suggestion-item:hover {
            background: #f7fbf8;
        }

        .destination-suggestion-pin {
            width: 38px;
            height: 38px;
            display: grid;
            place-items: center;
            border-radius: 10px;
            color: #111;
            background: #f5f5f5;
            font-size: 18px;
        }

        .destination-suggestion-main {
            display: block;
            color: #111;
            font-size: 14px;
            font-weight: 800;
            line-height: 1.25;
        }

        .destination-suggestion-sub {
            display: block;
            margin-top: 4px;
            color: #777;
            font-size: 12px;
            line-height: 1.3;
        }

        .destination-suggestion-empty {
            padding: 14px;
            color: #777;
            font-size: 13px;
            font-weight: 700;
        }
    `;
    document.head.appendChild(mapStyle);
}

function loadLeaflet() {
    return new Promise((resolve, reject) => {
        if (window.L) {
            resolve();
            return;
        }

        if (!document.querySelector('link[href*="leaflet.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);
        }

        const existingScript = document.querySelector('script[src*="leaflet.js"]');
        if (existingScript) {
            existingScript.addEventListener('load', resolve, { once: true });
            existingScript.addEventListener('error', reject, { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
    });
}

function inferDriverVehicleType(driver) {
    const text = [
        driver.vehicle_type,
        driver.vehicleType,
        driver.vehicle_model,
        driver.vehicleModel,
        driver.vehicleName
    ].filter(Boolean).join(" ").toLowerCase();

    if (text.includes("auto") || text.includes("rickshaw") || text.includes("tuk")) return "auto";
    return "bike";
}

function createLiveDriverIcon(driver) {
    const vehicleType = inferDriverVehicleType(driver);
    const isAuto = vehicleType === "auto";

    return L.divIcon({
        className: `global-driver-marker ${vehicleType}`,
        html: `
            <div class="global-driver-shell" title="${isAuto ? "Online auto driver" : "Online bike driver"}">
                ${isAuto ? `
                    <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
                        <rect x="7" y="12" width="24" height="15" rx="5" fill="#15803d"/>
                        <rect x="11" y="8" width="15" height="10" rx="4" fill="#facc15"/>
                        <rect x="13" y="10" width="9" height="6" rx="2" fill="#e0f2fe"/>
                        <circle cx="12" cy="28" r="4" fill="#111827"/>
                        <circle cx="27" cy="28" r="4" fill="#111827"/>
                        <circle cx="12" cy="28" r="1.7" fill="#fff"/>
                        <circle cx="27" cy="28" r="1.7" fill="#fff"/>
                    </svg>
                ` : `
                    <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
                        <circle cx="12" cy="27" r="5" fill="#111827"/>
                        <circle cx="28" cy="27" r="5" fill="#111827"/>
                        <path d="M12 27L18 18H24L28 27" stroke="#15803d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M17 18L14 14H20L23 18" stroke="#111827" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M22 15H29" stroke="#15803d" stroke-width="3" stroke-linecap="round"/>
                        <circle cx="19" cy="11" r="3" fill="#facc15"/>
                    </svg>
                `}
            </div>
        `,
        iconSize: [38, 38],
        iconAnchor: [19, 19]
    });
}

function isLiveDriverVisible(driver) {
    const location = driver.driverLocation || {};
    return driver.isConnected === true
        && driver.driverAvailability !== "offline"
        && Number.isFinite(Number(location.lat))
        && Number.isFinite(Number(location.lng));
}

function animateDriverMarker(markerState, nextLatLng) {
    const marker = markerState.marker;
    const start = marker.getLatLng();
    const end = L.latLng(nextLatLng);
    const duration = 900;
    const startedAt = performance.now();

    if (markerState.animationFrame) {
        cancelAnimationFrame(markerState.animationFrame);
    }

    function step(now) {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        marker.setLatLng([
            start.lat + (end.lat - start.lat) * eased,
            start.lng + (end.lng - start.lng) * eased
        ]);

        if (progress < 1) {
            markerState.animationFrame = requestAnimationFrame(step);
        } else {
            markerState.animationFrame = null;
        }
    }

    markerState.animationFrame = requestAnimationFrame(step);
}

function upsertGlobalDriverMarker(driverId, driver) {
    if (!window.mapInstance) return;

    const location = driver.driverLocation || {};
    const nextLatLng = [Number(location.lat), Number(location.lng)];
    const existing = globalDriverMarkers.get(driverId);

    if (!existing) {
        const marker = L.marker(nextLatLng, {
            icon: createLiveDriverIcon(driver),
            zIndexOffset: 500
        }).addTo(window.mapInstance);

        marker.bindPopup(`
            <div class="map-popup-title">${driver.name || "Online Driver"}</div>
            <div class="map-popup-sub">${inferDriverVehicleType(driver) === "auto" ? "Auto" : "Bike"} available nearby</div>
        `);

        globalDriverMarkers.set(driverId, {
            marker,
            vehicleType: inferDriverVehicleType(driver),
            animationFrame: null
        });
        return;
    }

    const nextVehicleType = inferDriverVehicleType(driver);
    if (existing.vehicleType !== nextVehicleType) {
        existing.marker.setIcon(createLiveDriverIcon(driver));
        existing.vehicleType = nextVehicleType;
    }

    animateDriverMarker(existing, nextLatLng);
}

function removeGlobalDriverMarker(driverId) {
    const existing = globalDriverMarkers.get(driverId);
    if (!existing) return;

    if (existing.animationFrame) {
        cancelAnimationFrame(existing.animationFrame);
    }

    if (window.mapInstance) {
        window.mapInstance.removeLayer(existing.marker);
    }

    globalDriverMarkers.delete(driverId);
}

function clearGlobalDriverMarkers() {
    Array.from(globalDriverMarkers.keys()).forEach(removeGlobalDriverMarker);
}

function startGlobalDriverPresenceListener() {
    if (!window.mapInstance) return;

    if (globalDriversUnsubscribe) {
        globalDriversUnsubscribe();
        globalDriversUnsubscribe = null;
    }
    clearGlobalDriverMarkers();

    globalDriversUnsubscribe = onSnapshot(collection(db, "driverPresence"), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const driverId = change.doc.id;
            const driver = { id: driverId, ...change.doc.data() };

            if (change.type === "removed" || !isLiveDriverVisible(driver)) {
                removeGlobalDriverMarker(driverId);
                return;
            }

            upsertGlobalDriverMarker(driverId, driver);
        });
    }, (error) => {
        console.warn("Global live driver listener failed:", error);
    });
}

// 2. Initialize Visual Map Window
export async function initializeMapEngine() {
    const coords = await getUserLocation();
    const mapContainer = document.getElementById('map-container');
    mapContainer.innerHTML = "";

    console.log("Loading standalone open-source mapping engine layer...");

    await loadLeaflet();
    injectMapStyles();

    if (window.mapInstance) {
        if (globalDriversUnsubscribe) {
            globalDriversUnsubscribe();
            globalDriversUnsubscribe = null;
        }
        clearGlobalDriverMarkers();
        window.mapInstance.remove();
        window.mapInstance = null;
    }

    // Just add 'window.' in front of mapInstance to expose it globally!
    window.mapInstance = L.map('map-container', {
        zoomControl: false,
        zoomAnimation: true,
        minZoom: 10,
        maxZoom: 19
    }).setView([coords.lat, coords.lng], 15);

    mapInstance = window.mapInstance;

    L.control.zoom({ position: 'bottomright' }).addTo(window.mapInstance);

    createBaseTileLayer().addTo(window.mapInstance);

    userMarker = L.marker([coords.lat, coords.lng], {
        icon: L.divIcon({
            className: 'pickup-marker-icon',
            html: '<div class="pickup-pulse-dot"></div>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            popupAnchor: [0, -14]
        })
    }).addTo(window.mapInstance) // Change to window.mapInstance
        .bindPopup(`
            <div class="map-popup-title">Your Pickup Location</div>
            <div class="map-popup-sub">Live GPS pickup point</div>
        `)
        .openPopup();

    setTimeout(() => window.mapInstance.invalidateSize(), 100);
    setupFareEngineListeners();
    startGlobalDriverPresenceListener();
    window.dispatchEvent(new CustomEvent('map-engine-ready', {
        detail: {
            pickup: { lat: coords.lat, lng: coords.lng }
        }
    }));
}

// 3. Dynamic Fare Calculation Engine (Straight-Line Haversine Approximation)
function setupFareEngineListeners() {
    const dropInput = document.getElementById('drop-input');
    const fareQuoteBox = document.getElementById('fare-quote-box');
    const fareAmountSpan = document.getElementById('fare-amount');

    dropInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (destinationSearchTimer) {
            clearTimeout(destinationSearchTimer);
        }

        if (destinationSearchAbortController) {
            destinationSearchAbortController.abort();
            destinationSearchAbortController = null;
        }

        if (query.length < 3) {
            resetDestinationFareState(fareQuoteBox);
            hideDestinationSuggestions();
            return;
        }

        fareAmountSpan.innerText = "Searching...";
        fareQuoteBox.classList.remove('d-none');
        fareQuoteBox.classList.add('d-flex');
        window.latestFareQuote = null;

        destinationSearchTimer = setTimeout(async () => {
            const destinations = [
                ...findLocalDestinations(query),
                ...(await searchTripuraDestinations(query))
            ].slice(0, 7);

            if (destinations.length) {
                showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan);
                fareQuoteBox.classList.add('d-none');
                fareQuoteBox.classList.remove('d-flex');
            } else {
                resetDestinationFareState(fareQuoteBox);
                showDestinationSuggestions(dropInput, [], fareQuoteBox, fareAmountSpan);
            }
        }, 650);
    });
}

function findLocalDestination(query) {
    return findLocalDestinations(query)[0] || null;
}

function findLocalDestinations(query) {
    return Object.entries(localLandmarks)
        .filter(([key]) => query.includes(key) || (key.includes(query) && query.length > 3))
        .map(([, destination]) => ({
            ...destination,
            mainName: destination.name,
            fullAddress: `${destination.name}, Tripura, India`,
            source: "local"
        }));
}

function resetDestinationFareState(fareQuoteBox) {
    fareQuoteBox.classList.add('d-none');
    fareQuoteBox.classList.remove('d-flex');
    window.latestFareQuote = null;
    window.selectedDestination = null;
    clearDestinationRoute();

    if (destinationSearchAbortController) {
        destinationSearchAbortController.abort();
        destinationSearchAbortController = null;
    }
}

function rankTripuraResult(result) {
    const address = result.address || {};
    const type = result.type || "";
    const displayName = (result.display_name || "").toLowerCase();
    let score = 0;

    if (displayName.includes("tripura")) score += 100;
    if (RURAL_PRIORITY_TYPES.has(type)) score += 35;
    if (address.village || address.hamlet || address.locality) score += 30;
    if (address.suburb || address.neighbourhood) score += 20;
    if (address.town || address.city) score += 12;

    return score;
}

function buildDestinationName(result, fallbackQuery) {
    const address = result.address || {};
    const parts = [
        address.road,
        address.village || address.hamlet || address.locality || address.suburb || address.neighbourhood,
        address.town || address.city || address.county || address.state_district
    ].filter(Boolean);

    return parts.length ? [...new Set(parts)].join(", ") : result.name || fallbackQuery;
}

function splitDestinationDisplay(result, fallbackQuery) {
    const displayParts = String(result.display_name || "").split(",").map((part) => part.trim()).filter(Boolean);
    const mainName = result.name || displayParts[0] || fallbackQuery;
    const subAddress = displayParts.filter((part) => part.toLowerCase() !== String(mainName).toLowerCase()).join(", ");

    return {
        mainName,
        fullAddress: subAddress || result.display_name || buildDestinationName(result, fallbackQuery)
    };
}

async function searchTripuraDestinations(query) {
    if (destinationSearchAbortController) {
        destinationSearchAbortController.abort();
    }

    destinationSearchAbortController = new AbortController();

    const mapplsResults = await searchTripuraDestinationsWithMappls(query, destinationSearchAbortController.signal);
    if (mapplsResults.length) {
        return mapplsResults;
    }

    return searchTripuraDestinationsWithNominatim(query, destinationSearchAbortController.signal);
}

async function searchTripuraDestinationsWithMappls(query, signal) {
    if (!hasMapplsKey()) return [];

    const urlCandidates = [
        `https://atlas.mappls.com/api/places/search/json?query=${encodeURIComponent(`${query} Tripura`)}&region=IND&access_token=${encodeURIComponent(MAPPLS_STATIC_KEY)}`,
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/autosuggest?query=${encodeURIComponent(query)}&region=IND&pod=city&location=${encodeURIComponent(TRIPURA_BIAS_POINT)}`
    ];

    for (const url of urlCandidates) {
        try {
            const data = await fetchJsonWithGracefulFailure(url, {
                headers: { "Accept-Language": "en" },
                signal
            });
            const rawItems = Array.isArray(data?.suggestedLocations)
                ? data.suggestedLocations
                : Array.isArray(data?.items)
                    ? data.items
                    : Array.isArray(data?.results)
                        ? data.results
                        : [];
            const normalized = rawItems
                .map(normalizeMapplsSuggestion)
                .filter(Boolean)
                .filter((item) => `${item.mainName} ${item.fullAddress}`.toLowerCase().includes("tripura"))
                .slice(0, 6);

            if (normalized.length) {
                return normalized;
            }
        } catch (error) {
            if (error.name !== "AbortError") {
                console.warn("Mappls destination search attempt failed:", error);
            }
        }
    }

    return [];
}

async function searchTripuraDestinationsWithNominatim(query, signal) {
    try {
        const params = new URLSearchParams({
            format: "jsonv2",
            q: `${query}, Tripura, India`,
            addressdetails: "1",
            limit: "8",
            countrycodes: "in",
            viewbox: TRIPURA_VIEWBOX,
            bounded: "1"
        });
        const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
            headers: { "Accept-Language": "en" },
            signal
        });
        const results = await response.json();

        return (Array.isArray(results) ? results : [])
            .filter((result) => Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon)))
            .sort((a, b) => rankTripuraResult(b) - rankTripuraResult(a))
            .slice(0, 6)
            .map((result) => {
                const display = splitDestinationDisplay(result, query);
                return {
                    lat: Number(result.lat),
                    lng: Number(result.lon),
                    name: display.mainName,
                    mainName: display.mainName,
                    fullAddress: display.fullAddress
                };
            });
    } catch (error) {
        if (error.name !== "AbortError") {
            console.warn("Tripura destination geocoding failed:", error);
        }
        return [];
    }
}

function ensureDestinationSuggestions(dropInput) {
    let suggestions = document.getElementById('destination-suggestions');
    if (suggestions) return suggestions;

    suggestions = document.createElement('div');
    suggestions.id = 'destination-suggestions';
    suggestions.className = 'destination-suggestions';
    suggestions.setAttribute('role', 'listbox');

    const field = dropInput.closest('.location-field');
    if (field) {
        field.insertAdjacentElement('afterend', suggestions);
    } else {
        dropInput.insertAdjacentElement('afterend', suggestions);
    }

    document.addEventListener('click', (event) => {
        if (!suggestions.contains(event.target) && event.target !== dropInput) {
            hideDestinationSuggestions();
        }
    });

    return suggestions;
}

function hideDestinationSuggestions() {
    const suggestions = document.getElementById('destination-suggestions');
    if (!suggestions) return;
    suggestions.classList.remove('is-visible');
}

function showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan) {
    const suggestions = ensureDestinationSuggestions(dropInput);

    if (!destinations.length) {
        suggestions.innerHTML = `<div class="destination-suggestion-empty">No exact Tripura location found. Try village, market, road, or subdivision name.</div>`;
        suggestions.classList.add('is-visible');
        return;
    }

    suggestions.innerHTML = `
        <div class="destination-suggestions-title">Search results</div>
        ${destinations.map((destination, index) => `
            <button class="destination-suggestion-item" type="button" role="option" data-index="${index}">
                <span class="destination-suggestion-pin">⌖</span>
                <span>
                    <strong class="destination-suggestion-main">${escapeHtml(destination.mainName || destination.name)}</strong>
                    <small class="destination-suggestion-sub">${escapeHtml(destination.fullAddress || "Tripura, India")}</small>
                </span>
            </button>
        `).join("")}
    `;

    suggestions.querySelectorAll('.destination-suggestion-item').forEach((item) => {
        item.addEventListener('click', () => {
            const selected = destinations[Number(item.dataset.index)];
            if (!selected) return;

            dropInput.value = selected.mainName || selected.name;
            window.selectedDestination = {
                name: selected.mainName || selected.name,
                fullAddress: selected.fullAddress || "",
                lat: selected.lat,
                lng: selected.lng
            };
            hideDestinationSuggestions();
            renderDestinationFare(selected, fareQuoteBox, fareAmountSpan);
        });
    });

    suggestions.classList.add('is-visible');
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function geocodeTripuraDestination(query) {
    return (await searchTripuraDestinations(query))[0] || null;
}

async function renderDestinationFare(destination, fareQuoteBox, fareAmountSpan) {
    const distance = calculateDistance(userLatitude, userLongitude, destination.lat, destination.lng);
    const estimatedDurationMinutes = Math.max(5, Math.round((distance / 25) * 60));
    const baseFare = 30;
    const perKmRate = 12;
    const finalFare = Math.round(baseFare + (distance * perKmRate));

    window.latestFareQuote = {
        pickup_lat: userLatitude,
        pickup_lng: userLongitude,
        drop_lat: destination.lat,
        drop_lng: destination.lng,
        drop_name: destination.mainName || destination.name,
        drop_full_address: destination.fullAddress || "",
        distance_km: Number(distance.toFixed(2)),
        duration_minutes: estimatedDurationMinutes
    };

    fareAmountSpan.innerText = `\u20B9${finalFare}.00`;
    fareQuoteBox.classList.remove('d-none');
    fareQuoteBox.classList.add('d-flex');

    if (!window.mapInstance) return;

    clearDestinationRoute();

    const destinationIcon = L.divIcon({
        className: 'destination-marker-icon',
        html: `
            <svg width="24" height="36" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 35C12 35 23 22.2 23 12.5C23 6.14873 18.0751 1 12 1C5.92487 1 1 6.14873 1 12.5C1 22.2 12 35 12 35Z" fill="#ef4444" stroke="white" stroke-width="2"/>
                <circle cx="12" cy="12.5" r="4.5" fill="white"/>
            </svg>
        `,
        iconSize: [24, 36],
        iconAnchor: [12, 36],
        popupAnchor: [0, -32]
    });

    destinationMarker = L.marker([destination.lat, destination.lng], {
        icon: destinationIcon
    }).addTo(window.mapInstance)
        .bindPopup(`
            <div class="map-popup-title">${destination.name}</div>
            <div class="map-popup-sub">Drop location</div>
        `);

    const routeCoords = await fetchRoadRouteCoords(
        { lat: userLatitude, lng: userLongitude },
        { lat: destination.lat, lng: destination.lng }
    );

    drawRoutePolyline(routeCoords);
}

function clearDestinationRoute() {
    if (!window.mapInstance) return;

    if (destinationMarker) {
        window.mapInstance.removeLayer(destinationMarker);
        destinationMarker = null;
    }

    if (routePolyline) {
        window.mapInstance.removeLayer(routePolyline);
        routePolyline = null;
    }
}

async function fetchRoadRouteCoords(origin, destination) {
    const fallbackCoords = [
        [origin.lat, origin.lng],
        [destination.lat, destination.lng]
    ];

    try {
        const routeUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
        const response = await fetch(routeUrl);
        const data = await response.json();
        const coordinates = data.routes?.[0]?.geometry?.coordinates;

        if (!Array.isArray(coordinates) || coordinates.length === 0) {
            return fallbackCoords;
        }

        return coordinates.map(([lng, lat]) => [lat, lng]);
    } catch (error) {
        console.warn("OSRM route fetch failed. Falling back to straight route line:", error);
        return fallbackCoords;
    }
}

function drawRoutePolyline(routeCoords) {
    const routeUnderline = L.polyline(routeCoords, {
        color: '#fff',
        weight: 10,
        opacity: 0.35,
        lineCap: 'round',
        lineJoin: 'round'
    });

    const routeLine = L.polyline(routeCoords, {
        color: '#1a73e8',
        weight: 5,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
    });

    routePolyline = L.layerGroup([routeUnderline, routeLine]).addTo(window.mapInstance);
    window.mapInstance.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
}

// Helper mathematical function to compute distance between two map coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Listen for custom login trigger
window.addEventListener('user-session-ready', (e) => {
    initializeMapEngine();
});




// Variable to hold the driver's map marker
let driverMarker = null;

// Listen for live GPS pings from the app.js Firestore snapshot
window.addEventListener('driver-location-updated', (e) => {
    const coords = e.detail; // Contains { lat, lng }

    // Check if your window-scoped map instance is ready
    if (!window.mapInstance) {
        console.error("Map instance not found on window scope.");
        return;
    }

    console.log("Passenger map received driver location:", coords);

    if (!driverMarker) {
        // Create the driver marker
        driverMarker = L.marker([coords.lat, coords.lng], {
            icon: L.divIcon({
                className: 'taxi-floating-icon',
                html: `
                    <div style="width:36px;height:36px;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.35));">
                        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="10" y="6" width="16" height="24" rx="5" fill="#111827"/>
                            <rect x="13" y="9" width="10" height="6" rx="1.5" fill="#60a5fa"/>
                            <rect x="13" y="20" width="10" height="5" rx="1.5" fill="#2563eb"/>
                            <circle cx="9" cy="12" r="2" fill="#6b7280"/>
                            <circle cx="27" cy="12" r="2" fill="#6b7280"/>
                            <circle cx="9" cy="24" r="2" fill="#6b7280"/>
                            <circle cx="27" cy="24" r="2" fill="#6b7280"/>
                            <rect x="12" y="4" width="4" height="2" rx="1" fill="#facc15"/>
                            <rect x="20" y="4" width="4" height="2" rx="1" fill="#facc15"/>
                            <rect x="12" y="30" width="4" height="2" rx="1" fill="#ef4444"/>
                            <rect x="20" y="30" width="4" height="2" rx="1" fill="#ef4444"/>
                            <path d="M12 17H24" stroke="#374151" stroke-width="1"/>
                        </svg>
                    </div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            })
        }).addTo(window.mapInstance); // Changed to window.mapInstance

        // Pan the map smoothly to center on the approaching driver
        window.mapInstance.setView([coords.lat, coords.lng], 15); // Changed to window.mapInstance
    } else {
        // Smoothly update the coordinates of the existing marker
        driverMarker.setLatLng([coords.lat, coords.lng]);
    }
});

// Clean up the map marker when the trip ends
window.addEventListener('ride-completed-clear-map', () => {
    if (driverMarker && window.mapInstance) {
        window.mapInstance.removeLayer(driverMarker); // Changed to window.mapInstance
        driverMarker = null;
    }
});
