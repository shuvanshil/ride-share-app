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
let mapplsUserMarker = null;
let routePolyline = null;
let destinationMarker = null;
let mapplsDestinationMarker = null;
let mapplsRouteLayers = [];
let globalDriversUnsubscribe = null;
let destinationSearchTimer = null;
let destinationSearchAbortController = null;
let fareEngineListenersBound = false;
let destinationMapPickMode = null;
let mainMapShell = null;
const globalDriverMarkers = new Map();

// Fast local safety net for Tripura places that large providers often miss or
// return too broadly. Provider results still rank first when they are strong.
const localLandmarks = {
    "kumarghat station": {
        lat: 24.2415,
        lng: 92.0312,
        name: "Kumarghat Railway Station",
        fullAddress: "Kumarghat, Unakoti, Tripura",
        typeHint: "Station",
        aliases: ["kumarghat railway", "kumarghat rail station", "kugt station"]
    },
    "rgm hospital": {
        lat: 24.3210,
        lng: 92.0110,
        name: "RGM Hospital Kailashahar",
        fullAddress: "Kailashahar, Unakoti, Tripura",
        typeHint: "Hospital",
        aliases: ["rajib gandhi memorial hospital", "kailashahar hospital", "hospital kailashahar"]
    },
    "dharmanagar police station": {
        lat: 24.3786,
        lng: 92.1783,
        name: "Dharmanagar Police Station",
        fullAddress: "Dharmanagar, North Tripura, Tripura",
        typeHint: "Police",
        aliases: ["dharmanagar thana", "police station dharmanagar", "police dharmanagar"]
    },
    "dharmanagar": {
        lat: 24.3785,
        lng: 92.1783,
        name: "Dharmanagar Town Center",
        fullAddress: "Dharmanagar, North Tripura, Tripura",
        typeHint: "Town",
        aliases: ["dharma nagar", "dharmanagar town"]
    },
    "sbi kailashahar": {
        lat: 24.3240,
        lng: 92.0126,
        name: "State Bank of India Kailashahar",
        fullAddress: "Kailashahar, Unakoti, Tripura",
        typeHint: "Bank",
        aliases: ["state bank kailashahar", "state bank of india kailashahar", "sbi bank kailashahar", "kailashahar sbi"]
    },
    "kailashahar motor stand": {
        lat: 24.3232,
        lng: 92.0124,
        name: "Kailashahar Motor Stand",
        fullAddress: "Kailashahar, Unakoti, Tripura",
        typeHint: "Station",
        aliases: ["motor stand kailashahar", "kailashahar bus stand", "bus stand kailashahar", "kailashahar stand"]
    },
    "chandipur kailashahar": {
        lat: 24.3066,
        lng: 92.0018,
        name: "Chandipur",
        fullAddress: "Chandipur, Kailashahar, Unakoti, Tripura",
        typeHint: "Village",
        aliases: ["kailashahar chandipur", "chandipur unakoti", "chandipur tripura"]
    },
    "lake chowmuhani": {
        lat: 23.8321,
        lng: 91.2788,
        name: "Lake Chowmuhani",
        fullAddress: "Krishna Nagar, Agartala, West Tripura",
        typeHint: "Market",
        aliases: ["lake chowmuhani market", "lake chowmuhani agartala"]
    },
    "kumarghat school": {
        lat: 24.2397,
        lng: 92.0306,
        name: "Kumarghat School",
        fullAddress: "Kumarghat, Unakoti, Tripura",
        typeHint: "School",
        aliases: ["school kumarghat", "kumarghat h s school", "kumarghat high school"]
    },
    "unakoti district court": {
        lat: 24.3229,
        lng: 92.0122,
        name: "District Court Unakoti",
        fullAddress: "Kailashahar, Unakoti, Tripura",
        typeHint: "Office",
        aliases: ["unakoti court", "district court kailashahar", "kailashahar court"]
    },
    "tripura gramin bank kailashahar": {
        lat: 24.3237,
        lng: 92.0123,
        name: "Tripura Gramin Bank Kailashahar",
        fullAddress: "Kailashahar, Unakoti, Tripura",
        typeHint: "Bank",
        aliases: ["tgb kailashahar", "gramin bank kailashahar"]
    },
    "unakoti": {
        lat: 24.3236,
        lng: 92.0272,
        name: "Unakoti Heritage Site",
        fullAddress: "Unakoti, Tripura",
        typeHint: "Temple",
        aliases: ["unakoti hills", "unakoti heritage"]
    }
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
const DESTINATION_SEARCH_DEBOUNCE_MS = 420;
const TRIPURA_DISTRICT_TERMS = [
    "west tripura",
    "sepahijala",
    "khowai",
    "gomati",
    "south tripura",
    "dhalai",
    "unakoti",
    "north tripura"
];
const TRIPURA_TOWN_TERMS = [
    "agartala",
    "kailashahar",
    "kumarghat",
    "dharmanagar",
    "ambassa",
    "udaipur",
    "belonia",
    "khowai",
    "teliamura",
    "sonamura",
    "bishalgarh",
    "kamalpur",
    "santirbazar",
    "panisagar",
    "jampui"
];
const TRIPURA_TOWN_CENTERS = {
    agartala: { lat: 23.8315, lng: 91.2868, radius: 12000 },
    kailashahar: { lat: 24.3232, lng: 92.0124, radius: 8000 },
    kumarghat: { lat: 24.2415, lng: 92.0312, radius: 8000 },
    dharmanagar: { lat: 24.3785, lng: 92.1783, radius: 9000 },
    ambassa: { lat: 23.9368, lng: 91.8542, radius: 9000 },
    udaipur: { lat: 23.5332, lng: 91.4917, radius: 9000 },
    belonia: { lat: 23.2510, lng: 91.4541, radius: 9000 },
    khowai: { lat: 24.0619, lng: 91.6057, radius: 9000 },
    teliamura: { lat: 23.8362, lng: 91.6186, radius: 9000 },
    sonamura: { lat: 23.4751, lng: 91.2657, radius: 9000 },
    bishalgarh: { lat: 23.6628, lng: 91.2756, radius: 9000 },
    kamalpur: { lat: 24.1957, lng: 91.8336, radius: 9000 },
    santirbazar: { lat: 23.3065, lng: 91.6440, radius: 9000 },
    panisagar: { lat: 24.2522, lng: 92.1598, radius: 9000 }
};
const USEFUL_PLACE_TYPE_TERMS = [
    "school",
    "college",
    "hospital",
    "clinic",
    "market",
    "bazar",
    "bazaar",
    "police",
    "mandir",
    "temple",
    "mosque",
    "church",
    "stand",
    "station",
    "office",
    "bank",
    "sbi",
    "state bank",
    "atm",
    "shop",
    "restaurant",
    "hotel",
    "court",
    "road",
    "village"
];
const PLACE_TYPE_HINTS = [
    { label: "Hospital", terms: ["hospital", "clinic", "medical", "health"] },
    { label: "School", terms: ["school", "college", "academy", "vidyalaya", "university"] },
    { label: "Market", terms: ["market", "bazar", "bazaar", "chowmuhani", "shop"] },
    { label: "Police", terms: ["police", "thana"] },
    { label: "Temple", terms: ["mandir", "temple"] },
    { label: "Station", terms: ["station", "stand", "bus", "railway"] },
    { label: "Bank", terms: ["bank", "atm", "sbi", "state bank"] },
    { label: "Office", terms: ["office", "court"] },
    { label: "Village", terms: ["village", "para", "gaon"] },
    { label: "Road", terms: ["road", "rd", "lane"] }
];

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

function canUseMapplsBasemap() {
    return hasMapplsKey() && MAPPLS_TILES_ENABLED;
}

export function createBaseTileLayer(leafletInstance = window.L) {
    return leafletInstance.tileLayer(CARTO_TILE_CONFIG.url, CARTO_TILE_CONFIG.options);
}

function buildReadableAddressFromObject(address = {}) {
    const parts = [
        address.poi || address.houseName || address.house_number,
        address.road || address.street || address.locality || address.subLocality || address.subLocalityName,
        address.suburb || address.neighbourhood || address.village || address.hamlet || address.district || address.subDistrict || address.districtName,
        address.city || address.town || address.state_district || address.state || address.stateName
    ].filter(Boolean);

    return [...new Set(parts)].join(", ");
}

function getResultText(result) {
    return [
        result?.name,
        result?.mainName,
        result?.placeName,
        result?.place_name,
        result?.keyword,
        result?.fullAddress,
        result?.placeAddress,
        result?.address,
        result?.display_name,
        result?.addressText,
        result?.type,
        result?.placeType,
        result?.rawType
    ].filter(Boolean).join(" ").toLowerCase();
}

function normalizeCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function inferPlaceTypeHint(destination = {}) {
    const text = getResultText(destination);
    const explicitType = destination.type || destination.placeType || destination.poiType || destination.category;

    for (const hint of PLACE_TYPE_HINTS) {
        if (hint.terms.some((term) => text.includes(term))) {
            return hint.label;
        }
    }

    if (explicitType) {
        return String(explicitType)
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    return "Place";
}

function getPickupDistanceLabel(destination = {}) {
    if (
        !Number.isFinite(Number(destination.lat)) ||
        !Number.isFinite(Number(destination.lng)) ||
        !Number.isFinite(Number(userLatitude)) ||
        !Number.isFinite(Number(userLongitude))
    ) {
        return "";
    }

    const distance = calculateDistance(userLatitude, userLongitude, Number(destination.lat), Number(destination.lng));
    return distance < 1
        ? `${Math.max(50, Math.round(distance * 1000 / 50) * 50)} m away`
        : `${distance.toFixed(1)} km away`;
}

function normalizeMapplsSuggestion(item, fallbackQuery = "") {
    const latitude = normalizeCoordinate(item?.latitude ?? item?.lat ?? item?.y ?? item?.entryLatitude);
    const longitude = normalizeCoordinate(item?.longitude ?? item?.lng ?? item?.lon ?? item?.x ?? item?.entryLongitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }

    const mainName = item.placeName || item.place_name || item.poi || item.name || item.keyword || item.formatted_address || fallbackQuery;
    const fullAddress = item.placeAddress || item.address || item.formatted_address || item.display_name || buildReadableAddressFromObject(item) || "Tripura, India";
    if (!mainName && !fullAddress) {
        return null;
    }

    return {
        lat: latitude,
        lng: longitude,
        name: mainName || fullAddress,
        mainName: mainName || fullAddress,
        fullAddress,
        typeHint: inferPlaceTypeHint(item),
        source: "mappls",
        provider: "mappls",
        eLoc: item.eLoc || item.eloc || item.placeId || item.place_id || "",
        rawType: item.type || item.placeType || item.poiType || item.category || ""
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
    return reverseGeocodeWithMappls(lat, lng);
}

async function reverseGeocodeWithMappls(lat, lng) {
    try {
        const response = await fetch(`/api/mappls-reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json();
        if (!response.ok) return null;
        return data?.result?.fullAddress || data?.result?.name || null;
    } catch (error) {
        console.warn("Mappls reverse geocode attempt failed:", error);
        return null;
    }
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

        .destination-suggestion-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 7px;
        }

        .destination-suggestion-meta span {
            min-height: 22px;
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 0 8px;
            color: #22572F;
            background: #EAF8ED;
            font-size: 11px;
            font-weight: 800;
        }

        .destination-suggestion-empty {
            padding: 14px;
            color: #777;
            font-size: 13px;
            font-weight: 700;
        }

        .destination-map-pick-btn {
            min-height: 38px;
            margin-top: 10px;
            border: 0;
            border-radius: 8px;
            padding: 0 12px;
            color: #fff;
            background: #1A7A2E;
            font-size: 12px;
            font-weight: 800;
        }

        .map-hybrid-host {
            position: relative;
            overflow: hidden;
        }

        .mappls-base-surface,
        .leaflet-overlay-surface {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
        }

        .mappls-base-surface {
            z-index: 1;
            pointer-events: none;
        }

        .mappls-base-surface > div,
        .mappls-base-surface canvas {
            width: 100% !important;
            height: 100% !important;
        }

        .mappls-base-surface .mappls-ctrl-top-left,
        .mappls-base-surface .mappls-ctrl-top-right,
        .mappls-base-surface .mappls-ctrl-bottom-left {
            display: none !important;
        }

        .leaflet-overlay-surface {
            z-index: 2;
        }

        .leaflet-overlay-surface,
        .leaflet-overlay-surface .leaflet-container {
            background: transparent !important;
        }

        .leaflet-overlay-surface .leaflet-control-attribution {
            display: none;
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

function loadMapplsSdk() {
    return new Promise((resolve, reject) => {
        if (!canUseMapplsBasemap()) {
            resolve(null);
            return;
        }

        if (window.mappls?.Map) {
            resolve(window.mappls);
            return;
        }

        const existingScript = document.querySelector('script[data-mappls-sdk="true"]');
        if (existingScript) {
            existingScript.addEventListener('load', () => resolve(window.mappls || null), { once: true });
            existingScript.addEventListener('error', reject, { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = `https://sdk.mappls.com/map/sdk/web?v=3.0&access_token=${encodeURIComponent(MAPPLS_STATIC_KEY)}`;
        script.async = true;
        script.dataset.mapplsSdk = 'true';
        script.onload = () => resolve(window.mappls || null);
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function syncBaseMapView(baseMap, leafletMap) {
    if (!baseMap || !leafletMap) return;

    const center = leafletMap.getCenter();
    const zoom = leafletMap.getZoom();

    try {
        if (typeof baseMap.setCenter === 'function') {
            baseMap.setCenter([center.lng, center.lat]);
        } else if (typeof baseMap.panTo === 'function') {
            baseMap.panTo({ lat: center.lat, lng: center.lng });
        }

        if (typeof baseMap.setZoom === 'function') {
            baseMap.setZoom(zoom);
        }
    } catch (error) {
        console.warn('Mappls base map sync failed:', error);
    }
}

function normalizeBaseMapDom(hostElement, baseElement) {
    if (!hostElement || !baseElement) return;

    const hostHeight = hostElement.clientHeight;
    const explicitHeight = hostHeight > 0 ? `${hostHeight}px` : '100%';

    baseElement.style.width = '100%';
    baseElement.style.height = explicitHeight;

    baseElement.querySelectorAll('div, canvas').forEach((node) => {
        node.style.maxWidth = '100%';
    });

    const directChild = baseElement.firstElementChild;
    if (directChild) {
        directChild.style.width = '100%';
        directChild.style.height = explicitHeight;
    }

    const canvas = baseElement.querySelector('canvas');
    if (canvas) {
        canvas.style.width = '100%';
        canvas.style.height = explicitHeight;
    }
}

function refreshBaseMapLayout(hostElement, baseMap, baseElement, overlayMap) {
    const run = () => {
        normalizeBaseMapDom(hostElement, baseElement);
        syncBaseMapView(baseMap, overlayMap);

        try {
            if (typeof baseMap?.resize === 'function') {
                baseMap.resize();
            } else if (typeof baseMap?._onResize === 'function') {
                baseMap._onResize();
            }
        } catch (error) {
            console.warn('Mappls resize call failed:', error);
        }
    };

    run();
    requestAnimationFrame(run);
    setTimeout(run, 120);
    setTimeout(run, 320);
    setTimeout(run, 700);
}

function createMapShellMarkup(hostElement, shellId) {
    hostElement.innerHTML = `
        <div id="${shellId}-base" class="mappls-base-surface"></div>
        <div id="${shellId}-overlay" class="leaflet-overlay-surface"></div>
    `;

    return {
        baseId: `${shellId}-base`,
        overlayId: `${shellId}-overlay`
    };
}

export async function createRideMapSurface(hostElementOrId, options = {}) {
    const hostElement = typeof hostElementOrId === 'string'
        ? document.getElementById(hostElementOrId)
        : hostElementOrId;

    if (!hostElement) {
        throw new Error('Map host element not found.');
    }

    const center = options.center || { lat: userLatitude, lng: userLongitude };
    const zoom = options.zoom ?? 15;
    const useMapplsBasemap = canUseMapplsBasemap();
    const shellId = options.shellId || `ride-map-${Date.now()}`;

    if (!window.L) {
        await loadLeaflet();
    }

    hostElement.classList.add('map-hybrid-host');

    if (useMapplsBasemap) {
        try {
            await loadMapplsSdk();
        } catch (error) {
            console.warn('Mappls SDK failed to load, using Carto fallback:', error);
            hostElement.innerHTML = '';
            const fallbackMap = L.map(hostElement, {
                zoomControl: options.zoomControl ?? false,
                zoomAnimation: true,
                minZoom: options.minZoom ?? 10,
                maxZoom: options.maxZoom ?? 19,
                attributionControl: options.attributionControl ?? true,
                dragging: options.dragging ?? true,
                scrollWheelZoom: options.scrollWheelZoom ?? true,
                doubleClickZoom: options.doubleClickZoom ?? true,
                touchZoom: options.touchZoom ?? true
            }).setView([center.lat, center.lng], zoom);
            createBaseTileLayer().addTo(fallbackMap);

            return {
                map: fallbackMap,
                baseMap: null,
                destroy() {
                    fallbackMap.remove();
                    hostElement.innerHTML = '';
                }
            };
        }

        const shell = createMapShellMarkup(hostElement, shellId);
        const overlayMap = L.map(shell.overlayId, {
            zoomControl: options.zoomControl ?? false,
            zoomAnimation: true,
            minZoom: options.minZoom ?? 10,
            maxZoom: options.maxZoom ?? 19,
            attributionControl: options.attributionControl ?? false,
            dragging: options.dragging ?? true,
            scrollWheelZoom: options.scrollWheelZoom ?? true,
            doubleClickZoom: options.doubleClickZoom ?? true,
            touchZoom: options.touchZoom ?? true
        }).setView([center.lat, center.lng], zoom);

        let baseMap = null;
        try {
            baseMap = new window.mappls.Map(shell.baseId, {
                center: { lat: center.lat, lng: center.lng },
                zoom,
                zoomControl: false,
                fullscreen_control: false,
                geolocation: false
            });
        } catch (error) {
            console.warn('Mappls base map creation failed, reverting to Carto base layer:', error);
            hostElement.innerHTML = '';
            const fallbackMap = L.map(hostElement, {
                zoomControl: options.zoomControl ?? false,
                zoomAnimation: true,
                minZoom: options.minZoom ?? 10,
                maxZoom: options.maxZoom ?? 19,
                attributionControl: options.attributionControl ?? true,
                dragging: options.dragging ?? true,
                scrollWheelZoom: options.scrollWheelZoom ?? true,
                doubleClickZoom: options.doubleClickZoom ?? true,
                touchZoom: options.touchZoom ?? true
            }).setView([center.lat, center.lng], zoom);
            createBaseTileLayer().addTo(fallbackMap);

            return {
                map: fallbackMap,
                baseMap: null,
                destroy() {
                    fallbackMap.remove();
                    hostElement.innerHTML = '';
                }
            };
        }

        const baseElement = document.getElementById(shell.baseId);
        const syncHandler = () => syncBaseMapView(baseMap, overlayMap);
        overlayMap.on('move zoom zoomend moveend resize', syncHandler);
        refreshBaseMapLayout(hostElement, baseMap, baseElement, overlayMap);

        return {
            map: overlayMap,
            baseMap,
            destroy() {
                overlayMap.off('move zoom zoomend moveend resize', syncHandler);
                overlayMap.remove();
                try {
                    if (typeof baseMap?.remove === 'function') {
                        baseMap.remove();
                    }
                } catch (error) {
                    console.warn('Mappls base map cleanup failed:', error);
                }
                hostElement.innerHTML = '';
            }
        };
    }

    hostElement.innerHTML = '';
    const map = L.map(hostElement, {
        zoomControl: options.zoomControl ?? false,
        zoomAnimation: true,
        minZoom: options.minZoom ?? 10,
        maxZoom: options.maxZoom ?? 19,
        attributionControl: options.attributionControl ?? true,
        dragging: options.dragging ?? true,
        scrollWheelZoom: options.scrollWheelZoom ?? true,
        doubleClickZoom: options.doubleClickZoom ?? true,
        touchZoom: options.touchZoom ?? true
    }).setView([center.lat, center.lng], zoom);

    createBaseTileLayer().addTo(map);

    return {
        map,
        baseMap: null,
        destroy() {
            map.remove();
            hostElement.innerHTML = '';
        }
    };
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

function removeMapplsUserMarker(baseMap) {
    if (!mapplsUserMarker || !window.mappls?.remove || !baseMap) {
        mapplsUserMarker = null;
        return;
    }

    try {
        window.mappls.remove({ map: baseMap, layer: mapplsUserMarker });
    } catch (error) {
        console.warn("Mappls pickup marker cleanup failed:", error);
    }

    mapplsUserMarker = null;
}

function removeMapplsLayer(baseMap, layer) {
    if (!layer || !baseMap || !window.mappls?.remove) return;

    try {
        window.mappls.remove({ map: baseMap, layer });
    } catch (error) {
        console.warn("Mappls layer cleanup failed:", error);
    }
}

function createPickupMarkerHtml() {
    return `
        <div class="pickup-marker-icon">
            <div class="pickup-pulse-dot"></div>
        </div>
    `;
}

function addPickupMarker(coords, mapShell) {
    if (mapShell?.baseMap && window.mappls?.Marker) {
        mapplsUserMarker = new window.mappls.Marker({
            map: mapShell.baseMap,
            position: { lat: coords.lat, lng: coords.lng },
            html: createPickupMarkerHtml(),
            popupOptions: true,
            popupHtml: `
                <div class="map-popup-title">Your Pickup Location</div>
                <div class="map-popup-sub">Live GPS pickup point</div>
            `,
            width: 22,
            height: 22,
            offset: [0, 0]
        });
        userMarker = null;
        return;
    }

    userMarker = L.marker([coords.lat, coords.lng], {
        icon: L.divIcon({
            className: 'pickup-marker-icon',
            html: '<div class="pickup-pulse-dot"></div>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            popupAnchor: [0, -14]
        })
    }).addTo(window.mapInstance)
        .bindPopup(`
            <div class="map-popup-title">Your Pickup Location</div>
            <div class="map-popup-sub">Live GPS pickup point</div>
        `)
        .openPopup();
}

function createDestinationMarkerHtml() {
    return `
        <div class="destination-marker-icon">
            <svg width="24" height="36" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 35C12 35 23 22.2 23 12.5C23 6.14873 18.0751 1 12 1C5.92487 1 1 6.14873 1 12.5C1 22.2 12 35 12 35Z" fill="#ef4444" stroke="white" stroke-width="2"/>
                <circle cx="12" cy="12.5" r="4.5" fill="white"/>
            </svg>
        </div>
    `;
}

function getActiveMapplsBaseMap() {
    return mainMapShell?.baseMap || null;
}

// 2. Initialize Visual Map Window
export async function initializeMapEngine() {
    const coords = await getUserLocation();
    const mapContainer = document.getElementById('map-container');

    console.log("Loading ride map surface...");

    await loadLeaflet();
    injectMapStyles();

    if (mainMapShell) {
        if (globalDriversUnsubscribe) {
            globalDriversUnsubscribe();
            globalDriversUnsubscribe = null;
        }
        clearGlobalDriverMarkers();
        removeMapplsUserMarker(mainMapShell.baseMap);
        mainMapShell.destroy();
        mainMapShell = null;
        window.mapInstance = null;
    } else if (window.mapInstance) {
        if (globalDriversUnsubscribe) {
            globalDriversUnsubscribe();
            globalDriversUnsubscribe = null;
        }
        clearGlobalDriverMarkers();
        window.mapInstance.remove();
        window.mapInstance = null;
    }
    userMarker = null;

    mapContainer.innerHTML = "";

    mainMapShell = await createRideMapSurface(mapContainer, {
        shellId: 'main-ride-map',
        center: { lat: coords.lat, lng: coords.lng },
        zoom: 15,
        zoomControl: false,
        minZoom: 10,
        maxZoom: 19,
        attributionControl: !canUseMapplsBasemap()
    });
    window.mapInstance = mainMapShell.map;
    mapInstance = window.mapInstance;

    L.control.zoom({ position: 'bottomright' }).addTo(window.mapInstance);
    addPickupMarker(coords, mainMapShell);
    window.mapInstance.on('click', (event) => {
        if (!destinationMapPickMode) return;
        completeDestinationMapPick(event.latlng.lat, event.latlng.lng);
    });

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
    if (fareEngineListenersBound) return;

    const dropInput = document.getElementById('drop-input');
    const fareQuoteBox = document.getElementById('fare-quote-box');
    const fareAmountSpan = document.getElementById('fare-amount');
    if (!dropInput || !fareQuoteBox || !fareAmountSpan) return;

    fareEngineListenersBound = true;

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
            const destinations = await searchTripuraDestinations(query);

            if (dropInput.value.toLowerCase().trim() !== query) {
                return;
            }

            if (destinations.length) {
                showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan);
                fareQuoteBox.classList.add('d-none');
                fareQuoteBox.classList.remove('d-flex');
            } else {
                resetDestinationFareState(fareQuoteBox);
                showDestinationSuggestions(dropInput, [], fareQuoteBox, fareAmountSpan);
            }
        }, DESTINATION_SEARCH_DEBOUNCE_MS);
    });
}

function findLocalDestination(query) {
    return findLocalDestinations(query)[0] || null;
}

function findLocalDestinations(query) {
    return [];
}

function normalizeSearchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getSearchTokens(value) {
    return normalizeSearchText(value)
        .split(" ")
        .filter((token) => token.length > 1);
}

function getSpecificSearchTokens(value) {
    const genericTokens = new Set([
        "tripura",
        "india",
        "near",
        "road",
        "rd",
        "main",
        "center",
        "centre",
        ...TRIPURA_TOWN_TERMS,
        ...TRIPURA_DISTRICT_TERMS.flatMap((term) => term.split(" "))
    ]);

    return getSearchTokens(value)
        .filter((token) => token.length > 2 && !genericTokens.has(token));
}

function scoreLocalLandmark(normalizedQuery, queryTokens, key, destination) {
    const normalizedKey = normalizeSearchText(key);
    const aliasTexts = (destination.aliases || []).map(normalizeSearchText);
    const searchableText = normalizeSearchText([
        key,
        destination.name,
        destination.fullAddress,
        destination.typeHint,
        ...(destination.aliases || [])
    ].filter(Boolean).join(" "));

    if (!normalizedQuery || !searchableText) return 0;
    if (normalizedQuery === normalizedKey || aliasTexts.includes(normalizedQuery)) return 280;
    if (normalizedQuery.includes(normalizedKey) || aliasTexts.some((alias) => normalizedQuery.includes(alias))) return 250;

    const specificQueryTokens = getSpecificSearchTokens(normalizedQuery);
    const specificMatches = specificQueryTokens.filter((token) => searchableText.includes(token));
    const importantMatches = USEFUL_PLACE_TYPE_TERMS.filter((term) => normalizedQuery.includes(term) && searchableText.includes(term));
    const townMatches = TRIPURA_TOWN_TERMS.filter((town) => normalizedQuery.includes(town) && searchableText.includes(town));

    if (!specificMatches.length && !importantMatches.length) {
        return 0;
    }

    if (specificMatches.length < 2 && !importantMatches.length) {
        return 0;
    }

    let score = 0;
    specificMatches.forEach((token) => {
        if (searchableText.includes(token)) {
            score += token.length > 3 ? 34 : 18;
        }
    });

    score += importantMatches.length * 38;
    score += townMatches.length * 12;

    return score >= 64 ? score : 0;
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

function scoreTripuraDestination(destination, query = "") {
    const text = getResultText(destination);
    const normalizedQuery = normalizeSearchText(query);
    const specificQueryTokens = getSpecificSearchTokens(normalizedQuery);
    const matchedSpecificTokens = specificQueryTokens.filter((part) => text.includes(part));
    let score = 0;

    if (text.includes("tripura")) score += 120;
    TRIPURA_DISTRICT_TERMS.forEach((term) => {
        if (text.includes(term)) score += 70;
    });
    TRIPURA_TOWN_TERMS.forEach((term) => {
        if (text.includes(term)) score += 48;
    });
    USEFUL_PLACE_TYPE_TERMS.forEach((term) => {
        if (normalizedQuery.includes(term) && text.includes(term)) score += 28;
    });

    matchedSpecificTokens.forEach((part) => {
        score += part.length > 3 ? 18 : 9;
    });

    if (specificQueryTokens.length >= 2 && !matchedSpecificTokens.length) score -= 140;
    if (specificQueryTokens.length >= 3 && matchedSpecificTokens.length < 2) score -= 80;

    if (destination.source === "mappls") score += 45;
    if (destination.source === "overpass") score += 45;
    if (destination.source === "nominatim") score += 24;
    if (destination.source === "local") score += 4;
    if (destination.eLoc) score += 8;
    if (Number.isFinite(Number(destination.lat)) && Number.isFinite(Number(destination.lng))) score += 12;

    return score;
}

function rankTripuraResult(result) {
    const address = result.address || {};
    const type = result.type || "";
    const displayName = (result.display_name || "").toLowerCase();
    return scoreTripuraDestination({
        ...result,
        fullAddress: result.display_name,
        rawType: type,
        addressText: buildReadableAddressFromObject(address)
    });
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
    const signal = destinationSearchAbortController.signal;

    try {
        const response = await fetch(`/api/mappls-search?q=${encodeURIComponent(query)}`, {
            headers: { Accept: "application/json" },
            signal
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
        }

        return (Array.isArray(data?.results) ? data.results : [])
            .map((destination) => ({
                ...destination,
                lat: Number.isFinite(Number(destination.lat)) ? Number(destination.lat) : null,
                lng: Number.isFinite(Number(destination.lng)) ? Number(destination.lng) : null,
                source: "mappls",
                provider: "mappls"
            }));
    } catch (error) {
        if (error.name !== "AbortError") {
            console.warn("Mappls destination search failed:", error);
        }
        return [];
    }
}

async function searchTripuraDestinationsWithMappls(query, signal) {
    if (!hasMapplsKey()) return [];

    const results = [];
    const queryVariants = buildMapplsQueryVariants(query);

    for (const queryVariant of queryVariants) {
        if (signal.aborted) return [];

        const urlCandidates = buildMapplsSearchUrls(queryVariant);
        for (const url of urlCandidates) {
            if (signal.aborted) return [];

            try {
                const data = await fetchJsonWithGracefulFailure(url, {
                    headers: { "Accept-Language": "en" },
                    signal
                });
                const normalized = await normalizeMapplsResponseItems(data, queryVariant, signal);
                results.push(...normalized);
            } catch (error) {
                if (error.name !== "AbortError") {
                    console.warn("Mappls destination search attempt failed:", error);
                }
            }

            const strongResults = dedupeDestinationResults(results)
                .filter((item) => scoreTripuraDestination(item, query) >= 45)
                .sort((a, b) => scoreTripuraDestination(b, query) - scoreTripuraDestination(a, query));
            if (strongResults.length >= 8) {
                return strongResults.slice(0, 8);
            }
        }
    }

    return dedupeDestinationResults(results)
        .sort((a, b) => scoreTripuraDestination(b, query) - scoreTripuraDestination(a, query))
        .slice(0, 8);
}

function buildMapplsQueryVariants(query) {
    const cleanQuery = query.trim().replace(/\s+/g, " ");
    const lowerQuery = cleanQuery.toLowerCase();
    const variants = buildSearchQueryVariants(cleanQuery);

    return [...new Set(variants)].slice(0, 8);
}

function buildSearchQueryVariants(query) {
    const cleanQuery = query.trim().replace(/\s+/g, " ");
    const lowerQuery = cleanQuery.toLowerCase();
    const variants = [
        cleanQuery,
        `${cleanQuery} Tripura`
    ];

    if (!TRIPURA_TOWN_TERMS.some((town) => lowerQuery.includes(town))) {
        variants.push(`${cleanQuery} Agartala`);
        variants.push(`${cleanQuery} Kailashahar`);
        variants.push(`${cleanQuery} Kumarghat`);
    }

    if (!USEFUL_PLACE_TYPE_TERMS.some((term) => lowerQuery.includes(term))) {
        variants.push(`${cleanQuery} market Tripura`);
        variants.push(`${cleanQuery} road Tripura`);
    }

    if (lowerQuery.includes("mandir")) {
        variants.push(cleanQuery.replace(/\bmandir\b/gi, "temple"));
        variants.push(`${cleanQuery.replace(/\bmandir\b/gi, "temple")} Tripura`);
    }

    if (lowerQuery.includes("temple")) {
        variants.push(cleanQuery.replace(/\btemple\b/gi, "mandir"));
        variants.push(`${cleanQuery.replace(/\btemple\b/gi, "mandir")} Tripura`);
    }

    if (lowerQuery.includes("sbi")) {
        variants.push(cleanQuery.replace(/\bsbi\b/gi, "State Bank of India"));
        variants.push(`${cleanQuery.replace(/\bsbi\b/gi, "State Bank of India")} Tripura`);
    }

    if (lowerQuery.includes("police") && !lowerQuery.includes("station")) {
        variants.push(`${cleanQuery} police station`);
    }

    return [...new Set(variants)];
}

function buildMapplsSearchUrls(queryVariant) {
    const encodedQuery = encodeURIComponent(queryVariant);
    const encodedKey = encodeURIComponent(MAPPLS_STATIC_KEY);
    const encodedBias = encodeURIComponent(TRIPURA_BIAS_POINT);

    return [
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/autosuggest?query=${encodedQuery}&region=IND&location=${encodedBias}`,
        `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&access_token=${encodedKey}`,
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/geo_code?addr=${encodedQuery}&region=IND`
    ];
}

function extractMapplsItems(data) {
    const buckets = [
        data?.suggestedLocations,
        data?.results,
        data?.items,
        data?.places,
        data?.copResults,
        data?.response?.results,
        data?.response?.suggestedLocations,
        data?.data?.results,
        data?.data?.suggestedLocations
    ];

    const items = [];
    buckets.forEach((bucket) => {
        if (Array.isArray(bucket)) {
            items.push(...bucket);
        }
    });

    if (!items.length && data && typeof data === "object" && !Array.isArray(data)) {
        items.push(data);
    }

    return items;
}

async function normalizeMapplsResponseItems(data, queryVariant, signal) {
    const rawItems = extractMapplsItems(data);
    const normalized = [];

    for (const item of rawItems) {
        if (signal.aborted) return [];

        let destination = normalizeMapplsSuggestion(item, queryVariant);
        if (!destination && (item?.eLoc || item?.eloc || item?.placeId || item?.place_id)) {
            destination = await fetchMapplsPlaceDetail(item.eLoc || item.eloc || item.placeId || item.place_id, signal, queryVariant);
        }

        if (destination) {
            normalized.push(destination);
        }
    }

    return normalized;
}

async function fetchMapplsPlaceDetail(placeId, signal, fallbackQuery = "") {
    if (!placeId || !hasMapplsKey()) return null;

    const encodedPlaceId = encodeURIComponent(placeId);
    const encodedKey = encodeURIComponent(MAPPLS_STATIC_KEY);
    const urlCandidates = [
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/place_detail?place_id=${encodedPlaceId}`,
        `https://apis.mappls.com/advancedmaps/v1/${MAPPLS_STATIC_KEY}/place_detail?eloc=${encodedPlaceId}`,
        `https://atlas.mappls.com/api/places/details/json?eloc=${encodedPlaceId}&access_token=${encodedKey}`,
        `https://atlas.mappls.com/api/places/details/json?place_id=${encodedPlaceId}&access_token=${encodedKey}`
    ];

    for (const url of urlCandidates) {
        try {
            const data = await fetchJsonWithGracefulFailure(url, {
                headers: { "Accept-Language": "en" },
                signal
            });
            const detail = extractMapplsItems(data)[0] || data;
            const normalized = normalizeMapplsSuggestion({ ...detail, eLoc: placeId }, fallbackQuery);
            if (normalized) return normalized;
        } catch (error) {
            if (error.name !== "AbortError") {
                console.warn("Mappls place detail lookup failed:", error);
            }
        }
    }

    return null;
}

function dedupeDestinationResults(destinations) {
    const seen = new Set();

    return destinations.filter((destination) => {
        if (!destination) return false;
        const lat = Number(destination.lat).toFixed(5);
        const lng = Number(destination.lng).toFixed(5);
        const name = String(destination.mainName || destination.name || "").toLowerCase().trim();
        const key = `${name}|${lat}|${lng}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function mergeDestinationResults(providerDestinations, localDestinations, query) {
    const strongProviderResults = dedupeDestinationResults(providerDestinations)
        .filter((destination) => scoreTripuraDestination(destination, query) >= 40)
        .sort((a, b) => scoreTripuraDestination(b, query) - scoreTripuraDestination(a, query));

    const strongLocalResults = dedupeDestinationResults(localDestinations)
        .filter((destination) => Number(destination._score || 0) >= 90)
        .sort((a, b) => Number(b._score || 0) - Number(a._score || 0));

    if (strongProviderResults.length >= 5) {
        return strongProviderResults.slice(0, 8);
    }

    return dedupeDestinationResults([
        ...strongProviderResults,
        ...strongLocalResults
    ])
        .sort((a, b) => {
            const providerBoostA = a.source === "local" ? 0 : 35;
            const providerBoostB = b.source === "local" ? 0 : 35;
            return (scoreTripuraDestination(b, query) + providerBoostB) - (scoreTripuraDestination(a, query) + providerBoostA);
        })
        .slice(0, 8);
}

async function searchTripuraDestinationsWithOverpass(query, signal) {
    const center = inferTripuraSearchCenter(query);
    const filters = inferOverpassFilters(query);
    const namePattern = buildOverpassNamePattern(query);

    if (!center || (!filters.length && !namePattern)) {
        return [];
    }

    const clauses = [];
    const radius = Math.min(center.radius || 8000, 12000);

    filters.forEach((filter) => {
        clauses.push(`node(around:${radius},${center.lat},${center.lng})${filter};`);
        clauses.push(`way(around:${radius},${center.lat},${center.lng})${filter};`);
    });

    if (namePattern) {
        clauses.push(`node(around:${radius},${center.lat},${center.lng})[name~"${namePattern}",i];`);
        clauses.push(`way(around:${radius},${center.lat},${center.lng})[name~"${namePattern}",i];`);
    }

    const overpassQuery = `[out:json][timeout:10];(${clauses.join("")});out center tags 12;`;
    const endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    ];

    for (const endpoint of endpoints) {
        if (signal.aborted) return [];

        try {
            const response = await fetch(`${endpoint}?data=${encodeURIComponent(overpassQuery)}`, {
                headers: { "Accept-Language": "en" },
                signal
            });
            if (!response.ok) continue;

            const data = await response.json();
            const elements = Array.isArray(data?.elements) ? data.elements : [];
            const results = elements
                .map((item) => normalizeOverpassElement(item, query))
                .filter(Boolean)
                .sort((a, b) => scoreTripuraDestination(b, query) - scoreTripuraDestination(a, query));

            if (results.length) {
                return dedupeDestinationResults(results).slice(0, 8);
            }
        } catch (error) {
            if (error.name !== "AbortError") {
                console.warn("Overpass POI search failed:", error);
            }
        }
    }

    return [];
}

function inferTripuraSearchCenter(query) {
    const normalizedQuery = normalizeSearchText(query);
    const matchedTown = Object.keys(TRIPURA_TOWN_CENTERS).find((town) => normalizedQuery.includes(town));
    if (matchedTown) return TRIPURA_TOWN_CENTERS[matchedTown];

    if (Number.isFinite(Number(userLatitude)) && Number.isFinite(Number(userLongitude))) {
        return { lat: userLatitude, lng: userLongitude, radius: 9000 };
    }

    return TRIPURA_TOWN_CENTERS.kailashahar;
}

function inferOverpassFilters(query) {
    const normalizedQuery = normalizeSearchText(query);
    const filters = [];

    if (/\b(mandir|temple|kali|shiva|durga)\b/.test(normalizedQuery)) filters.push("[amenity=place_of_worship]");
    if (/\b(sbi|bank|atm|state bank)\b/.test(normalizedQuery)) filters.push("[amenity~\"bank|atm\"]");
    if (/\b(police|thana)\b/.test(normalizedQuery)) filters.push("[amenity=police]");
    if (/\b(school|college|academy|vidyalaya)\b/.test(normalizedQuery)) filters.push("[amenity~\"school|college|university\"]");
    if (/\b(hospital|clinic|medical)\b/.test(normalizedQuery)) filters.push("[amenity~\"hospital|clinic|doctors\"]");
    if (/\b(market|bazar|bazaar|shop)\b/.test(normalizedQuery)) filters.push("[shop]");
    if (/\b(stand|station|bus|railway)\b/.test(normalizedQuery)) filters.push("[amenity~\"bus_station|taxi\"]");

    return [...new Set(filters)];
}

function buildOverpassNamePattern(query) {
    const tokens = getSpecificSearchTokens(query)
        .filter((token) => !USEFUL_PLACE_TYPE_TERMS.includes(token))
        .slice(0, 4);

    if (!tokens.length) return "";
    return tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function normalizeOverpassElement(item, query) {
    const lat = Number(item.lat ?? item.center?.lat);
    const lng = Number(item.lon ?? item.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const tags = item.tags || {};
    const name = tags.name || tags["name:en"] || query;
    const town = tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || "";
    const addressParts = [
        tags["addr:housename"],
        tags["addr:street"],
        town,
        tags["addr:district"],
        "Tripura"
    ].filter(Boolean);

    return {
        lat,
        lng,
        name,
        mainName: name,
        fullAddress: [...new Set(addressParts)].join(", ") || "Tripura, India",
        typeHint: inferPlaceTypeHint({
            name,
            type: tags.amenity || tags.shop || tags.tourism || tags.office || ""
        }),
        source: "overpass",
        provider: "openstreetmap",
        osmId: item.id || ""
    };
}

async function searchTripuraDestinationsWithNominatim(query, signal) {
    const results = [];
    const queryVariants = buildSearchQueryVariants(query).slice(0, 6);

    for (const queryVariant of queryVariants) {
        if (signal.aborted) return [];

        try {
            const params = new URLSearchParams({
                format: "jsonv2",
                q: `${queryVariant}, Tripura, India`,
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
            const data = await response.json();

            results.push(...(Array.isArray(data) ? data : []));
        } catch (error) {
            if (error.name !== "AbortError") {
                console.warn("Tripura destination geocoding failed:", error);
            }
        }
    }

    return dedupeDestinationResults(
        results
            .filter((result) => Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon)))
            .sort((a, b) => rankTripuraResult(b) - rankTripuraResult(a))
            .map((result) => {
                const display = splitDestinationDisplay(result, query);
                return {
                    lat: Number(result.lat),
                    lng: Number(result.lon),
                    name: display.mainName,
                    mainName: display.mainName,
                    fullAddress: display.fullAddress,
                    typeHint: inferPlaceTypeHint(result),
                    source: "nominatim",
                    provider: "nominatim"
                };
            })
    ).slice(0, 8);
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

async function resolveDestinationCoordinates(destination) {
    if (Number.isFinite(Number(destination.lat)) && Number.isFinite(Number(destination.lng))) {
        return {
            ...destination,
            lat: Number(destination.lat),
            lng: Number(destination.lng)
        };
    }

    if (!destination.eLoc) return null;

    try {
        const response = await fetch(`/api/mappls-place-detail?eloc=${encodeURIComponent(destination.eLoc)}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json();
        const resolved = data?.result;
        if (response.ok && Number.isFinite(Number(resolved?.lat)) && Number.isFinite(Number(resolved?.lng))) {
            return {
                ...destination,
                ...resolved,
                lat: Number(resolved.lat),
                lng: Number(resolved.lng)
            };
        }
    } catch (error) {
        console.warn("Mappls place detail coordinate lookup failed:", error);
    }

    return null;
}

function startDestinationMapPick(destination, dropInput, fareQuoteBox, fareAmountSpan) {
    if (!window.mapInstance) {
        alert("Map is not ready yet. Please wait a moment and try again.");
        return;
    }

    hideDestinationSuggestions();
    fareAmountSpan.innerText = "Tap destination on map";
    fareQuoteBox.classList.remove('d-none');
    fareQuoteBox.classList.add('d-flex');

    destinationMapPickMode = {
        destination,
        dropInput,
        fareQuoteBox,
        fareAmountSpan
    };

    dropInput.value = destination.mainName || destination.name || dropInput.value;
}

async function completeDestinationMapPick(lat, lng) {
    if (!destinationMapPickMode) return;

    const pickMode = destinationMapPickMode;
    destinationMapPickMode = null;

    const destination = {
        ...pickMode.destination,
        lat,
        lng,
        source: "mappls-map-pick",
        provider: "mappls",
        typeHint: pickMode.destination.typeHint || "Pinned location"
    };

    try {
        const response = await fetch(`/api/mappls-reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json();
        if (response.ok && data?.result?.fullAddress) {
            destination.fullAddress = data.result.fullAddress;
        }
    } catch (error) {
        console.warn("Mappls reverse geocode for selected destination failed:", error);
    }

    pickMode.dropInput.value = destination.mainName || destination.name || destination.fullAddress || "Pinned destination";
    window.selectedDestination = {
        name: destination.mainName || destination.name || "Pinned destination",
        fullAddress: destination.fullAddress || "",
        lat: destination.lat,
        lng: destination.lng,
        source: destination.source,
        provider: destination.provider,
        eLoc: destination.eLoc || "",
        typeHint: destination.typeHint
    };

    renderDestinationFare(destination, pickMode.fareQuoteBox, pickMode.fareAmountSpan);
}

function showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan) {
    const suggestions = ensureDestinationSuggestions(dropInput);

    if (!destinations.length) {
        suggestions.innerHTML = `
            <div class="destination-suggestion-empty">
                <div>No Mappls text result found for this name.</div>
                <button id="choose-destination-on-map-btn" class="destination-map-pick-btn" type="button">Choose destination on map</button>
            </div>
        `;
        suggestions.querySelector('#choose-destination-on-map-btn')?.addEventListener('click', () => {
            startDestinationMapPick({
                name: dropInput.value.trim() || "Pinned destination",
                mainName: dropInput.value.trim() || "Pinned destination",
                fullAddress: "Selected on map",
                typeHint: "Pinned location"
            }, dropInput, fareQuoteBox, fareAmountSpan);
        });
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
                    <span class="destination-suggestion-meta">
                        <span>${escapeHtml(destination.typeHint || inferPlaceTypeHint(destination))}</span>
                        ${getPickupDistanceLabel(destination) ? `<span>${escapeHtml(getPickupDistanceLabel(destination))}</span>` : ""}
                    </span>
                </span>
            </button>
        `).join("")}
    `;

    suggestions.querySelectorAll('.destination-suggestion-item').forEach((item) => {
        item.addEventListener('click', async () => {
            const selected = destinations[Number(item.dataset.index)];
            if (!selected) return;

            dropInput.value = selected.mainName || selected.name;
            hideDestinationSuggestions();

            const resolved = await resolveDestinationCoordinates(selected);
            if (!resolved) {
                startDestinationMapPick(selected, dropInput, fareQuoteBox, fareAmountSpan);
                return;
            }

            window.selectedDestination = {
                name: resolved.mainName || resolved.name,
                fullAddress: resolved.fullAddress || "",
                lat: resolved.lat,
                lng: resolved.lng,
                source: resolved.source || resolved.provider || "mappls",
                provider: resolved.provider || resolved.source || "mappls",
                eLoc: resolved.eLoc || "",
                typeHint: resolved.typeHint || inferPlaceTypeHint(resolved)
            };
            renderDestinationFare(resolved, fareQuoteBox, fareAmountSpan);
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
        drop_source: destination.source || destination.provider || "unknown",
        drop_eloc: destination.eLoc || "",
        drop_type_hint: destination.typeHint || inferPlaceTypeHint(destination),
        distance_km: Number(distance.toFixed(2)),
        duration_minutes: estimatedDurationMinutes
    };

    fareAmountSpan.innerText = `\u20B9${finalFare}.00`;
    fareQuoteBox.classList.remove('d-none');
    fareQuoteBox.classList.add('d-flex');

    if (!window.mapInstance) return;

    clearDestinationRoute();

    const routeCoords = await fetchRoadRouteCoords(
        { lat: userLatitude, lng: userLongitude },
        { lat: destination.lat, lng: destination.lng }
    );

    if (drawMapplsDestinationAndRoute(destination, routeCoords)) {
        return;
    }

    drawLeafletDestinationAndRoute(destination, routeCoords);
}

function clearDestinationRoute() {
    const baseMap = getActiveMapplsBaseMap();

    if (baseMap) {
        removeMapplsLayer(baseMap, mapplsDestinationMarker);
        mapplsDestinationMarker = null;
        mapplsRouteLayers.forEach((layer) => removeMapplsLayer(baseMap, layer));
        mapplsRouteLayers = [];
    }

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

function drawMapplsDestinationAndRoute(destination, routeCoords) {
    const baseMap = getActiveMapplsBaseMap();
    if (!baseMap || !window.mappls?.Marker || !window.mappls?.Polyline) {
        return false;
    }

    try {
        const destinationName = destination.mainName || destination.name || "Drop location";
        mapplsDestinationMarker = new window.mappls.Marker({
            map: baseMap,
            position: { lat: destination.lat, lng: destination.lng },
            html: createDestinationMarkerHtml(),
            popupOptions: true,
            popupHtml: `
                <div class="map-popup-title">${destinationName}</div>
                <div class="map-popup-sub">Drop location</div>
            `,
            width: 24,
            height: 36,
            offset: [0, -18]
        });

        const path = routeCoords.map(([lat, lng]) => ({ lat, lng }));
        const routeGlow = new window.mappls.Polyline({
            map: baseMap,
            path,
            paths: path,
            strokeColor: '#ffffff',
            strokeOpacity: 0.55,
            strokeWeight: 10,
            fitbounds: false
        });
        const routeLine = new window.mappls.Polyline({
            map: baseMap,
            path,
            paths: path,
            strokeColor: '#1a73e8',
            strokeOpacity: 0.95,
            strokeWeight: 5,
            fitbounds: false
        });

        mapplsRouteLayers = [routeGlow, routeLine];
        fitActiveMapToRoute(routeCoords);
        return true;
    } catch (error) {
        console.warn("Mappls destination/route render failed, using Leaflet fallback:", error);
        clearDestinationRoute();
        return false;
    }
}

function drawLeafletDestinationAndRoute(destination, routeCoords) {
    const destinationName = destination.mainName || destination.name || "Drop location";
    const destinationIcon = L.divIcon({
        className: 'destination-marker-icon',
        html: createDestinationMarkerHtml(),
        iconSize: [24, 36],
        iconAnchor: [12, 36],
        popupAnchor: [0, -32]
    });

    destinationMarker = L.marker([destination.lat, destination.lng], {
        icon: destinationIcon
    }).addTo(window.mapInstance)
        .bindPopup(`
            <div class="map-popup-title">${destinationName}</div>
            <div class="map-popup-sub">Drop location</div>
        `);

    drawRoutePolyline(routeCoords);
}

async function fetchRoadRouteCoords(origin, destination) {
    const fallbackCoords = [
        [origin.lat, origin.lng],
        [destination.lat, destination.lng]
    ];

    try {
        const params = new URLSearchParams({
            originLat: origin.lat,
            originLng: origin.lng,
            destinationLat: destination.lat,
            destinationLng: destination.lng
        });
        const routeUrl = `/api/mappls-route?${params.toString()}`;
        const response = await fetch(routeUrl);
        const data = await response.json();
        const coordinates = data.coordinates;

        if (!Array.isArray(coordinates) || coordinates.length === 0) {
            return fallbackCoords;
        }

        return coordinates;
    } catch (error) {
        console.warn("Mappls route fetch failed. Falling back to straight route line:", error);
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

function fitActiveMapToRoute(routeCoords) {
    if (!window.mapInstance || !Array.isArray(routeCoords) || routeCoords.length < 2) {
        return;
    }

    const bounds = L.latLngBounds(routeCoords.map(([lat, lng]) => [lat, lng]));
    window.mapInstance.fitBounds(bounds, { padding: [60, 60] });
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
