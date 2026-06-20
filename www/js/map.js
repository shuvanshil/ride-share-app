import { db } from './firebase-init.js';
import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const DEFAULT_PICKUP = { lat: 24.3124, lng: 92.0135 };
const TRIPURA_CENTER = { lat: 23.8315, lng: 91.9882 };
const DESTINATION_SEARCH_DEBOUNCE_MS = 420;
const GOOGLE_MAP_SCRIPT_ID = "google-maps-js-sdk";
const GOOGLE_MAP_SCRIPT_VERSION = "weekly";

let userLatitude = DEFAULT_PICKUP.lat;
let userLongitude = DEFAULT_PICKUP.lng;
let mainMapShell = null;
let userMarker = null;
let destinationMarker = null;
let routePolyline = null;
let routeMetricElement = null;
let destinationSearchTimer = null;
let destinationSearchAbortController = null;
let destinationMapPickMode = null;
let fareEngineListenersBound = false;
let passengerDestinationLocked = false;
let globalDriversUnsubscribe = null;
const globalDriverMarkers = new Map();

function normalizeCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isLikelyTripuraCoordinate(lat, lng) {
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && lat >= 22
        && lat <= 25.5
        && lng >= 90.5
        && lng <= 93.5;
}

function normalizeCoordinatePair(latValue, lngValue) {
    const lat = normalizeCoordinate(latValue);
    const lng = normalizeCoordinate(lngValue);

    if (lat == null || lng == null) {
        return { lat: null, lng: null };
    }

    if (isLikelyTripuraCoordinate(lat, lng)) {
        return { lat, lng };
    }

    if (isLikelyTripuraCoordinate(lng, lat)) {
        return { lat: lng, lng: lat };
    }

    return { lat: null, lng: null };
}

function getGoogleMaps() {
    return window.google?.maps || null;
}

async function getGoogleBrowserKey() {
    const response = await fetch("/api/google-config", {
        headers: { Accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.browserKey) {
        throw new Error(data.error || "Google Maps browser key is not configured.");
    }

    return data.browserKey;
}

async function loadGoogleMaps() {
    if (getGoogleMaps()?.Map && getGoogleMaps()?.places) {
        return getGoogleMaps();
    }

    const existingScript = document.getElementById(GOOGLE_MAP_SCRIPT_ID);
    if (existingScript) {
        await new Promise((resolve, reject) => {
            existingScript.addEventListener("load", resolve, { once: true });
            existingScript.addEventListener("error", reject, { once: true });
        });
        return getGoogleMaps();
    }

    const browserKey = await getGoogleBrowserKey();
    await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.id = GOOGLE_MAP_SCRIPT_ID;
        script.async = true;
        script.defer = true;
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserKey)}&libraries=places&v=${GOOGLE_MAP_SCRIPT_VERSION}`;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });

    if (!getGoogleMaps()?.Map) {
        throw new Error("Google Maps SDK did not load.");
    }

    return getGoogleMaps();
}

function addGoogleMapStyles() {
    if (document.getElementById("google-map-engine-styles")) return;

    const style = document.createElement("style");
    style.id = "google-map-engine-styles";
    style.textContent = `
        .google-map-host {
            width: 100%;
            height: 100%;
            min-height: 180px;
        }

        .destination-suggestions {
            margin-top: 12px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #fff;
            overflow: hidden;
            box-shadow: 0 14px 34px rgba(15, 23, 42, 0.08);
            display: none;
        }

        .destination-suggestions.is-visible {
            display: block;
        }

        .destination-suggestions-title {
            padding: 14px 14px 8px;
            font-weight: 800;
            font-size: 0.9rem;
            color: #111827;
        }

        .destination-suggestion-item {
            width: 100%;
            display: grid;
            grid-template-columns: 40px 1fr;
            gap: 12px;
            align-items: center;
            padding: 14px;
            border: 0;
            border-top: 1px solid #eef2f1;
            background: #fff;
            text-align: left;
        }

        .destination-suggestion-item:hover,
        .destination-suggestion-item:active {
            background: #f3faf4;
        }

        .destination-suggestion-pin {
            width: 38px;
            height: 38px;
            border-radius: 8px;
            display: grid;
            place-items: center;
            background: #f3f4f6;
            color: #14532d;
            font-weight: 800;
        }

        .destination-suggestion-main {
            display: block;
            font-size: 0.94rem;
            color: #111827;
            line-height: 1.25;
        }

        .destination-suggestion-sub {
            display: block;
            margin-top: 3px;
            color: #6b7280;
            font-size: 0.8rem;
            line-height: 1.3;
        }

        .destination-suggestion-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
        }

        .destination-suggestion-meta span {
            display: inline-flex;
            align-items: center;
            min-height: 22px;
            padding: 3px 8px;
            border-radius: 999px;
            background: #dcfce7;
            color: #14532d;
            font-size: 0.74rem;
            font-weight: 800;
        }

        .destination-suggestion-empty {
            padding: 16px 14px;
            color: #6b7280;
            font-size: 0.86rem;
            font-weight: 700;
            line-height: 1.45;
        }

        .destination-map-pick-btn {
            margin-top: 12px;
            border: 0;
            border-radius: 8px;
            background: #15803d;
            color: #fff;
            font-weight: 800;
            padding: 10px 12px;
            width: 100%;
        }
    `;
    document.head.appendChild(style);
}

function googleLatLngLiteral(coords) {
    return { lat: Number(coords.lat), lng: Number(coords.lng) };
}

function makeMarker(options) {
    const maps = getGoogleMaps();
    return new maps.Marker(options);
}

function removeMarker(marker) {
    if (marker?.setMap) {
        marker.setMap(null);
    }
}

function clearRouteAndDestination() {
    removeMarker(destinationMarker);
    destinationMarker = null;

    if (routePolyline?.setMap) {
        routePolyline.setMap(null);
    }
    routePolyline = null;

    if (routeMetricElement) {
        routeMetricElement.remove();
        routeMetricElement = null;
    }
}

function renderRouteMetric(distanceKm, durationMinutes) {
    if (!window.mapInstance || !Number.isFinite(distanceKm) || !Number.isFinite(durationMinutes)) return;

    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    routeMetricElement = document.createElement("div");
    routeMetricElement.className = "map-metric";
    routeMetricElement.setAttribute("role", "status");
    routeMetricElement.setAttribute("aria-live", "polite");
    routeMetricElement.textContent = `${distanceKm.toFixed(1)} km \u2022 ${Math.round(durationMinutes)} mins`;
    mapContainer.appendChild(routeMetricElement);
}

function clearPickupMarker() {
    removeMarker(userMarker);
    userMarker = null;
}

export async function createRideMapSurface(hostElementOrId, options = {}) {
    const maps = await loadGoogleMaps();
    addGoogleMapStyles();

    const hostElement = typeof hostElementOrId === "string"
        ? document.getElementById(hostElementOrId)
        : hostElementOrId;

    if (!hostElement) {
        throw new Error("Map host element not found.");
    }

    const center = options.center || { lat: userLatitude, lng: userLongitude };
    hostElement.innerHTML = "";
    hostElement.classList.add("google-map-host");

    const map = new maps.Map(hostElement, {
        center: googleLatLngLiteral(center),
        zoom: options.zoom ?? 15,
        minZoom: options.minZoom ?? 8,
        maxZoom: options.maxZoom ?? 20,
        disableDefaultUI: options.disableDefaultUI ?? false,
        zoomControl: options.zoomControl ?? true,
        fullscreenControl: options.fullscreenControl ?? true,
        streetViewControl: false,
        mapTypeControl: false,
        gestureHandling: options.gestureHandling || "greedy",
        clickableIcons: true
    });

    return {
        map,
        destroy() {
            maps.event.clearInstanceListeners(map);
            hostElement.innerHTML = "";
            hostElement.classList.remove("google-map-host");
        }
    };
}

function decodePolyline(encoded = "") {
    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates = [];

    while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte = null;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        result = 0;
        shift = 0;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }

    return coordinates;
}

async function getUserLocation() {
    const pickupInput = document.getElementById("pickup-input");

    const fallback = {
        lat: DEFAULT_PICKUP.lat,
        lng: DEFAULT_PICKUP.lng,
        label: "Kailashahar Center (Simulation)"
    };

    if (!navigator.geolocation) {
        userLatitude = fallback.lat;
        userLongitude = fallback.lng;
        if (pickupInput) pickupInput.value = fallback.label;
        return fallback;
    }

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const coords = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    label: "Current location"
                };
                userLatitude = coords.lat;
                userLongitude = coords.lng;
                if (pickupInput) pickupInput.value = coords.label;
                resolve(coords);
            },
            () => {
                userLatitude = fallback.lat;
                userLongitude = fallback.lng;
                if (pickupInput) pickupInput.value = fallback.label;
                resolve(fallback);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
    });
}

function addPickupMarker(coords) {
    const maps = getGoogleMaps();
    clearPickupMarker();

    userMarker = makeMarker({
        map: window.mapInstance,
        position: googleLatLngLiteral(coords),
        title: "Your pickup location",
        icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 9,
            fillColor: "#22c55e",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 3
        },
        zIndex: 1000
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

function createDriverMarkerIcon(driver) {
    const maps = getGoogleMaps();
    const isAuto = inferDriverVehicleType(driver) === "auto";
    return {
        path: "M12 2C7.03 2 3 6.03 3 11c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z",
        fillColor: isAuto ? "#f59e0b" : "#15803d",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
        scale: 1.35,
        labelOrigin: new maps.Point(12, 11)
    };
}

function isLiveDriverVisible(driver) {
    const location = driver.driverLocation || {};
    return driver.isConnected === true
        && driver.driverAvailability !== "offline"
        && Number.isFinite(Number(location.lat))
        && Number.isFinite(Number(location.lng));
}

function upsertGlobalDriverMarker(driverId, driver) {
    if (!window.mapInstance) return;

    const location = driver.driverLocation || {};
    const position = {
        lat: Number(location.lat),
        lng: Number(location.lng)
    };
    const vehicleType = inferDriverVehicleType(driver);
    const existing = globalDriverMarkers.get(driverId);

    if (!existing) {
        const marker = makeMarker({
            map: window.mapInstance,
            position,
            title: `${driver.name || "Online Driver"} - ${vehicleType}`,
            icon: createDriverMarkerIcon(driver),
            label: {
                text: vehicleType === "auto" ? "A" : "B",
                color: "#ffffff",
                fontSize: "11px",
                fontWeight: "800"
            },
            zIndex: 500
        });

        globalDriverMarkers.set(driverId, { marker, vehicleType });
        return;
    }

    existing.marker.setPosition(position);
    if (existing.vehicleType !== vehicleType) {
        existing.marker.setIcon(createDriverMarkerIcon(driver));
        existing.marker.setLabel({
            text: vehicleType === "auto" ? "A" : "B",
            color: "#ffffff",
            fontSize: "11px",
            fontWeight: "800"
        });
        existing.vehicleType = vehicleType;
    }
}

function removeGlobalDriverMarker(driverId) {
    const existing = globalDriverMarkers.get(driverId);
    if (!existing) return;
    removeMarker(existing.marker);
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

export async function initializeMapEngine() {
    const coords = await getUserLocation();
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    await loadGoogleMaps();
    addGoogleMapStyles();

    if (globalDriversUnsubscribe) {
        globalDriversUnsubscribe();
        globalDriversUnsubscribe = null;
    }
    clearGlobalDriverMarkers();
    clearRouteAndDestination();
    clearPickupMarker();

    if (mainMapShell) {
        mainMapShell.destroy();
        mainMapShell = null;
    }

    mainMapShell = await createRideMapSurface(mapContainer, {
        center: coords,
        zoom: 15,
        zoomControl: true,
        fullscreenControl: true
    });

    window.mapInstance = mainMapShell.map;
    addPickupMarker(coords);

    window.mapInstance.addListener("click", (event) => {
        if (!destinationMapPickMode || !event.latLng) return;
        completeDestinationMapPick(event.latLng.lat(), event.latLng.lng());
    });

    setupFareEngineListeners();
    startGlobalDriverPresenceListener();
    window.dispatchEvent(new CustomEvent("map-engine-ready", {
        detail: { pickup: { lat: coords.lat, lng: coords.lng } }
    }));
}

function setupFareEngineListeners() {
    if (fareEngineListenersBound) return;

    const dropInput = document.getElementById("drop-input");
    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!dropInput || !fareQuoteBox || !fareAmountSpan) return;

    fareEngineListenersBound = true;
    dropInput.addEventListener("input", (event) => {
        if (passengerDestinationLocked || dropInput.readOnly) return;

        const query = event.target.value.trim();

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
        fareQuoteBox.classList.remove("d-none");
        fareQuoteBox.classList.add("d-flex");
        window.latestFareQuote = null;

        destinationSearchTimer = setTimeout(async () => {
            const destinations = await searchGoogleDestinations(query);

            if (passengerDestinationLocked || dropInput.readOnly || dropInput.value.trim() !== query) {
                return;
            }

            if (destinations.length) {
                showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan);
                fareQuoteBox.classList.add("d-none");
                fareQuoteBox.classList.remove("d-flex");
            } else {
                resetDestinationFareState(fareQuoteBox);
                showDestinationSuggestions(dropInput, [], fareQuoteBox, fareAmountSpan);
            }
        }, DESTINATION_SEARCH_DEBOUNCE_MS);
    });
}

function resetDestinationFareState(fareQuoteBox) {
    if (fareQuoteBox) {
        fareQuoteBox.classList.add("d-none");
        fareQuoteBox.classList.remove("d-flex");
    }
    window.latestFareQuote = null;
    window.selectedDestination = null;
    clearRouteAndDestination();
}

function getPlaceTypeHint(place = {}) {
    const text = [
        place.typeHint,
        ...(place.types || []),
        place.name,
        place.mainName,
        place.fullAddress
    ].filter(Boolean).join(" ").toLowerCase();

    if (/(hospital|clinic|medical|health)/.test(text)) return "Hospital";
    if (/(school|college|academy|vidyalaya|university)/.test(text)) return "School";
    if (/(market|bazar|bazaar|chowmuhani|shop|store|mall)/.test(text)) return "Market";
    if (/(police|thana)/.test(text)) return "Police";
    if (/(hindu_temple|mandir|temple|place_of_worship)/.test(text)) return "Temple";
    if (/(station|stand|bus|railway|transit_station)/.test(text)) return "Station";
    if (/(bank|atm|sbi|state bank)/.test(text)) return "Bank";
    if (/(office|court|local_government_office)/.test(text)) return "Office";
    if (/(village|locality|sublocality|neighborhood)/.test(text)) return "Locality";
    if (/(route|road|street)/.test(text)) return "Road";
    return "Place";
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function ensureDestinationSuggestions(dropInput) {
    let suggestions = document.getElementById("destination-suggestions");
    if (suggestions) return suggestions;

    suggestions = document.createElement("div");
    suggestions.id = "destination-suggestions";
    suggestions.className = "destination-suggestions";
    suggestions.setAttribute("role", "listbox");
    dropInput.closest(".services-location-card")?.after(suggestions);
    return suggestions;
}

function hideDestinationSuggestions() {
    const suggestions = document.getElementById("destination-suggestions");
    if (!suggestions) return;
    suggestions.classList.remove("is-visible");
}

async function searchGoogleDestinations(query) {
    destinationSearchAbortController = new AbortController();
    const signal = destinationSearchAbortController.signal;

    try {
        const params = new URLSearchParams({
            q: query,
            lat: String(userLatitude || TRIPURA_CENTER.lat),
            lng: String(userLongitude || TRIPURA_CENTER.lng)
        });
        const response = await fetch(`/api/google-autocomplete?${params.toString()}`, {
            signal,
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (signal.aborted) return [];
        if (!response.ok) {
            console.warn("Google destination search failed:", data.error || response.statusText);
            return [];
        }

        return (Array.isArray(data.results) ? data.results : [])
            .map((destination) => ({
                ...destination,
                ...normalizeCoordinatePair(destination.lat, destination.lng),
                typeHint: destination.typeHint || getPlaceTypeHint(destination),
                source: "google",
                provider: "google"
            }));
    } catch (error) {
        if (error.name !== "AbortError") {
            console.warn("Google destination search failed:", error);
        }
        return [];
    }
}

async function resolveGooglePlace(destination) {
    const existingCoords = normalizeCoordinatePair(destination.lat, destination.lng);
    if (Number.isFinite(existingCoords.lat) && Number.isFinite(existingCoords.lng)) {
        return {
            ...destination,
            lat: existingCoords.lat,
            lng: existingCoords.lng,
            source: "google",
            provider: "google"
        };
    }

    if (!destination.placeId) return null;

    try {
        const params = new URLSearchParams({ placeId: destination.placeId });
        const response = await fetch(`/api/google-place-detail?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.result) return null;

        const coords = normalizeCoordinatePair(data.result.lat, data.result.lng);
        if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
            return null;
        }

        return {
            ...destination,
            ...data.result,
            lat: coords.lat,
            lng: coords.lng,
            placeId: data.result.placeId || destination.placeId,
            source: "google",
            provider: "google"
        };
    } catch (error) {
        console.warn("Google place detail lookup failed:", error);
        return null;
    }
}

function showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan) {
    const suggestions = ensureDestinationSuggestions(dropInput);

    if (!destinations.length) {
        suggestions.innerHTML = `
            <div class="destination-suggestion-empty">
                <div>No Google result found for this name.</div>
                <button id="choose-destination-on-map-btn" class="destination-map-pick-btn" type="button">Choose destination on map</button>
            </div>
        `;
        suggestions.querySelector("#choose-destination-on-map-btn")?.addEventListener("click", () => {
            startDestinationMapPick({
                name: dropInput.value.trim() || "Pinned destination",
                mainName: dropInput.value.trim() || "Pinned destination",
                source: "google-map-pick",
                provider: "google",
                typeHint: "Pinned location"
            }, dropInput, fareQuoteBox, fareAmountSpan);
        });
        suggestions.classList.add("is-visible");
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
                        <span>${escapeHtml(destination.typeHint || getPlaceTypeHint(destination))}</span>
                    </span>
                </span>
            </button>
        `).join("")}
    `;

    suggestions.querySelectorAll(".destination-suggestion-item").forEach((item) => {
        item.addEventListener("click", async () => {
            const selected = destinations[Number(item.dataset.index)];
            if (!selected) return;

            dropInput.value = selected.mainName || selected.name;
            hideDestinationSuggestions();
            fareAmountSpan.innerText = "Calculating...";
            fareQuoteBox.classList.remove("d-none");
            fareQuoteBox.classList.add("d-flex");

            const resolved = await resolveGooglePlace(selected);
            if (!resolved) {
                startDestinationMapPick(selected, dropInput, fareQuoteBox, fareAmountSpan);
                return;
            }

            window.selectedDestination = buildSelectedDestination(resolved);
            const fareRendered = await renderDestinationFare(resolved, fareQuoteBox, fareAmountSpan);
            if (!fareRendered) {
                startDestinationMapPick(selected, dropInput, fareQuoteBox, fareAmountSpan);
            }
        });
    });

    suggestions.classList.add("is-visible");
}

function buildSelectedDestination(destination) {
    return {
        name: destination.mainName || destination.name,
        fullAddress: destination.fullAddress || "",
        lat: destination.lat,
        lng: destination.lng,
        source: "google",
        provider: "google",
        placeId: destination.placeId || "",
        eLoc: "",
        typeHint: destination.typeHint || getPlaceTypeHint(destination)
    };
}

function startDestinationMapPick(destination, dropInput, fareQuoteBox, fareAmountSpan) {
    if (!window.mapInstance) {
        alert("Map is not ready yet. Please wait a moment and try again.");
        return;
    }

    hideDestinationSuggestions();
    fareAmountSpan.innerText = "Tap destination on map";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

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
        source: "google-map-pick",
        provider: "google",
        typeHint: pickMode.destination.typeHint || "Pinned location"
    };

    try {
        const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
        const response = await fetch(`/api/google-reverse-geocode?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.result) {
            destination.name = data.result.name || destination.name;
            destination.mainName = data.result.name || destination.mainName;
            destination.fullAddress = data.result.fullAddress || destination.fullAddress;
            destination.placeId = data.result.placeId || destination.placeId || "";
        }
    } catch (error) {
        console.warn("Google reverse geocode for selected destination failed:", error);
    }

    pickMode.dropInput.value = destination.mainName || destination.name || destination.fullAddress || "Pinned destination";
    window.selectedDestination = buildSelectedDestination(destination);
    renderDestinationFare(destination, pickMode.fareQuoteBox, pickMode.fareAmountSpan);
}

export async function fetchRoadRouteDetails(origin, destination) {
    const originCoords = normalizeCoordinatePair(origin.lat, origin.lng);
    const destinationCoords = normalizeCoordinatePair(destination.lat, destination.lng);

    if (
        !Number.isFinite(originCoords.lat) ||
        !Number.isFinite(originCoords.lng) ||
        !Number.isFinite(destinationCoords.lat) ||
        !Number.isFinite(destinationCoords.lng)
    ) {
        return null;
    }

    try {
        const params = new URLSearchParams({
            originLat: String(originCoords.lat),
            originLng: String(originCoords.lng),
            destinationLat: String(destinationCoords.lat),
            destinationLng: String(destinationCoords.lng)
        });
        const response = await fetch(`/api/google-route?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return null;

        return {
            distanceKm: Number.isFinite(Number(data.distanceKm)) ? Number(data.distanceKm) : null,
            durationMinutes: Number.isFinite(Number(data.durationMinutes)) ? Number(data.durationMinutes) : null,
            routePath: data.encodedPolyline ? decodePolyline(data.encodedPolyline) : []
        };
    } catch (error) {
        console.warn("Google route fetch failed:", error);
        return null;
    }
}

async function renderDestinationFare(destination, fareQuoteBox, fareAmountSpan) {
    const destinationCoords = normalizeCoordinatePair(destination.lat, destination.lng);
    if (!Number.isFinite(destinationCoords.lat) || !Number.isFinite(destinationCoords.lng)) {
        return false;
    }

    const routeDetails = await fetchRoadRouteDetails(
        { lat: userLatitude, lng: userLongitude },
        destinationCoords
    );
    const straightLineDistance = calculateDistance(userLatitude, userLongitude, destinationCoords.lat, destinationCoords.lng);
    const distance = Number.isFinite(routeDetails?.distanceKm) ? routeDetails.distanceKm : straightLineDistance;
    const estimatedDurationMinutes = routeDetails?.durationMinutes || Math.max(5, Math.round((distance / 25) * 60));
    const baseFare = 30;
    const perKmRate = 12;
    const finalFare = Math.round(baseFare + (distance * perKmRate));

    window.latestFareQuote = {
        pickup_lat: userLatitude,
        pickup_lng: userLongitude,
        drop_lat: destinationCoords.lat,
        drop_lng: destinationCoords.lng,
        drop_name: destination.mainName || destination.name,
        drop_full_address: destination.fullAddress || "",
        drop_source: "google",
        drop_provider: "google",
        drop_place_id: destination.placeId || "",
        drop_eloc: "",
        drop_type_hint: destination.typeHint || getPlaceTypeHint(destination),
        distance_km: Number(distance.toFixed(2)),
        duration_minutes: estimatedDurationMinutes
    };

    fareAmountSpan.innerText = `\u20B9${finalFare}.00`;
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

    drawDestinationAndRoute(destination, routeDetails?.routePath || [], {
        distanceKm: routeDetails?.distanceKm,
        durationMinutes: routeDetails?.durationMinutes
    });
    return true;
}

function drawDestinationAndRoute(destination, routePath = [], routeMetrics = {}) {
    if (!window.mapInstance) return;

    const maps = getGoogleMaps();
    const destinationCoords = normalizeCoordinatePair(destination.lat, destination.lng);
    if (!Number.isFinite(destinationCoords.lat) || !Number.isFinite(destinationCoords.lng)) return;

    clearRouteAndDestination();

    destinationMarker = makeMarker({
        map: window.mapInstance,
        position: googleLatLngLiteral(destinationCoords),
        title: destination.mainName || destination.name || "Drop location",
        zIndex: 900
    });

    const path = Array.isArray(routePath) && routePath.length >= 2
        ? routePath
        : [
            { lat: userLatitude, lng: userLongitude },
            { lat: destinationCoords.lat, lng: destinationCoords.lng }
        ];

    routePolyline = new maps.Polyline({
        map: window.mapInstance,
        path,
        strokeColor: "#1a73e8",
        strokeOpacity: 0.92,
        strokeWeight: 5
    });

    const bounds = new maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    bounds.extend({ lat: userLatitude, lng: userLongitude });
    bounds.extend(destinationCoords);
    window.mapInstance.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
    renderRouteMetric(routeMetrics.distanceKm, routeMetrics.durationMinutes);
}

export async function renderGoogleRoutePreview(hostElementOrId, fareQuote = {}) {
    const origin = normalizeCoordinatePair(fareQuote.pickup_lat, fareQuote.pickup_lng);
    const destination = normalizeCoordinatePair(fareQuote.drop_lat, fareQuote.drop_lng);
    if (
        !Number.isFinite(origin.lat) ||
        !Number.isFinite(origin.lng) ||
        !Number.isFinite(destination.lat) ||
        !Number.isFinite(destination.lng)
    ) {
        return null;
    }

    const shell = await createRideMapSurface(hostElementOrId, {
        center: origin,
        zoom: 15,
        zoomControl: false,
        fullscreenControl: false,
        gestureHandling: "cooperative",
        disableDefaultUI: true
    });

    const maps = getGoogleMaps();
    const routeDetails = await fetchRoadRouteDetails(origin, destination);
    const path = routeDetails?.routePath?.length >= 2
        ? routeDetails.routePath
        : [origin, destination];

    new maps.Marker({
        map: shell.map,
        position: origin,
        title: "Pickup"
    });
    new maps.Marker({
        map: shell.map,
        position: destination,
        title: "Drop"
    });

    new maps.Polyline({
        map: shell.map,
        path,
        strokeColor: "#1A7A2E",
        strokeOpacity: 0.95,
        strokeWeight: 5
    });

    const bounds = new maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    shell.map.fitBounds(bounds, { top: 42, right: 42, bottom: 42, left: 42 });
    return shell;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(lat1 * Math.PI / 180)
        * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLon / 2)
        * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

window.addEventListener("user-session-ready", () => {
    if (!document.getElementById("map-container")) return;
    initializeMapEngine().catch((error) => {
        console.error("Google map engine initialization failed:", error);
    });
});

window.addEventListener("passenger-destination-lock-changed", (event) => {
    passengerDestinationLocked = Boolean(event.detail?.locked);
    if (!passengerDestinationLocked) return;

    destinationMapPickMode = null;
    if (destinationSearchTimer) {
        clearTimeout(destinationSearchTimer);
        destinationSearchTimer = null;
    }
    if (destinationSearchAbortController) {
        destinationSearchAbortController.abort();
        destinationSearchAbortController = null;
    }
    hideDestinationSuggestions();
});
