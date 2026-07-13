import { db } from './firebase-init.js';
import { calculateFareOptions, isNightFareTime } from './fare-policy.js';
import {
    collection,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const DEFAULT_PICKUP = { lat: 24.3124, lng: 92.0135 };
const TRIPURA_CENTER = { lat: 23.8315, lng: 91.9882 };
const PICKUP_CACHE_KEY = "liphtup_last_passenger_pickup";
const DESTINATION_SEARCH_DEBOUNCE_MS = 150;
const MAX_VISIBLE_SUGGESTIONS = 5;
const GOOGLE_MAP_SCRIPT_ID = "google-maps-js-sdk";
const GOOGLE_MAP_SCRIPT_VERSION = "weekly";
const DRIVER_MARKER_ANIMATION_MS = 850;
const DRIVER_HEADING_MIN_DISTANCE_METERS = 5;
const ACTIVE_DRIVER_ROUTE_RECALC_DISTANCE_METERS = 25;
const ACTIVE_DRIVER_ROUTE_RECALC_MIN_INTERVAL_MS = 7000;
const VEHICLE_MARKER_ASSETS = Object.freeze({
    bike: new URL("../assets/vehicle-markers/bike-marker.png", import.meta.url).href,
    auto: new URL("../assets/vehicle-markers/auto-marker.png", import.meta.url).href
});

let userLatitude = DEFAULT_PICKUP.lat;
let userLongitude = DEFAULT_PICKUP.lng;
let mainMapShell = null;
let userMarker = null;
let destinationMarker = null;
let routePolyline = null;
let routeMetricElement = null;
let destinationSearchTimer = null;
let destinationSearchAbortController = null;
let pickupSearchTimer = null;
let pickupSearchAbortController = null;
let destinationMapPickMode = null;
let pickupMapPickMode = null;
let centerMapPickerElement = null;
let fareEngineListenersBound = false;
let pickupSearchListenersBound = false;
let passengerDestinationLocked = false;
let globalDriversUnsubscribe = null;
let vehicleLegendElement = null;
let googleMapsLoadPromise = null;
let activeDriverMarker = null;
let pendingAssignedDriverDetail = null;
let assignedDriverTrackingDriverId = "";
let assignedDriverRoutePolyline = null;
let assignedDriverTrackingElement = null;
let assignedDriverLastDistanceKm = null;
let activeDriverRouteState = {
    driverId: "",
    targetKey: "",
    routePath: [],
    lastRoutePosition: null,
    lastRouteAt: 0,
    routeRequestInFlight: false,
    queuedDetail: null
};
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

function normalizeHeading(value) {
    const heading = Number(value);
    return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
}

function shortestHeadingDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function smoothHeading(previousHeading, nextHeading, strength = 0.35) {
    const previous = normalizeHeading(previousHeading);
    const next = normalizeHeading(nextHeading);
    if (next == null) return previous;
    if (previous == null) return next;
    return normalizeHeading(previous + shortestHeadingDelta(previous, next) * strength);
}

function calculateDistanceMeters(pointA, pointB) {
    if (!pointA || !pointB) return Infinity;

    const earthRadius = 6371000;
    const lat1 = Number(pointA.lat) * Math.PI / 180;
    const lat2 = Number(pointB.lat) * Math.PI / 180;
    const deltaLat = (Number(pointB.lat) - Number(pointA.lat)) * Math.PI / 180;
    const deltaLng = (Number(pointB.lng) - Number(pointA.lng)) * Math.PI / 180;
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function calculateBearing(from, to) {
    if (!from || !to) return null;

    const lat1 = Number(from.lat) * Math.PI / 180;
    const lat2 = Number(to.lat) * Math.PI / 180;
    const deltaLng = (Number(to.lng) - Number(from.lng)) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function getFallbackPickupLocation() {
    return {
        lat: DEFAULT_PICKUP.lat,
        lng: DEFAULT_PICKUP.lng,
        label: "Kailashahar Center"
    };
}

function readCachedPickupLocation() {
    try {
        const cached = JSON.parse(localStorage.getItem(PICKUP_CACHE_KEY) || "null");
        const coords = normalizeCoordinatePair(cached?.lat, cached?.lng);
        if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return null;

        return {
            lat: coords.lat,
            lng: coords.lng,
            label: cached.label || cached.name || "Previous pickup location"
        };
    } catch {
        return null;
    }
}

function rememberPickupLocation(coords, label = "Previous pickup location") {
    const normalized = normalizeCoordinatePair(coords?.lat, coords?.lng);
    if (!Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lng)) return;

    try {
        localStorage.setItem(PICKUP_CACHE_KEY, JSON.stringify({
            lat: normalized.lat,
            lng: normalized.lng,
            label,
            savedAt: Date.now()
        }));
    } catch {
        // Storage may be unavailable in private browsing; map behavior still works.
    }
}

function getInitialPickupLocation() {
    const pickup = readCachedPickupLocation() || getFallbackPickupLocation();
    userLatitude = pickup.lat;
    userLongitude = pickup.lng;

    const pickupInput = document.getElementById("pickup-input");
    if (pickupInput && !pickupInput.value) {
        pickupInput.value = pickup.label;
    }

    return pickup;
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

    if (googleMapsLoadPromise) return googleMapsLoadPromise;

    googleMapsLoadPromise = (async () => {
        const existingScript = document.getElementById(GOOGLE_MAP_SCRIPT_ID);
        if (existingScript) {
            await new Promise((resolve, reject) => {
                if (getGoogleMaps()?.Map) {
                    resolve();
                    return;
                }
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
    })().catch((error) => {
        googleMapsLoadPromise = null;
        throw error;
    });

    return googleMapsLoadPromise;
}

export function warmGoogleMaps() {
    loadGoogleMaps().catch((error) => {
        console.warn("Google Maps warmup failed:", error);
    });
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

        .location-suggestions,
        .destination-suggestions {
            margin-top: 12px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #fff;
            overflow: hidden;
            box-shadow: 0 14px 34px rgba(15, 23, 42, 0.08);
            display: none;
        }

        .location-suggestions.is-visible,
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

        .destination-suggestion-pin .webicon {
            width: 18px;
            height: 18px;
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

        .is-location-pick-mode,
        .is-location-pick-mode * {
            cursor: crosshair !important;
        }

        .map-center-location-picker {
            position: absolute;
            inset: 0;
            z-index: 750;
            pointer-events: none;
        }

        .map-center-pin-wrap {
            --pin-color: #0b5d2a;
            position: absolute;
            top: 50%;
            left: 50%;
            width: 42px;
            height: 58px;
            transform: translate(-50%, -50px);
            transition: transform 160ms ease;
            filter: drop-shadow(0 5px 5px rgba(0, 0, 0, 0.28));
        }

        .map-center-location-picker.is-drop .map-center-pin-wrap {
            --pin-color: #d32f2f;
        }

        .map-center-location-picker.is-moving .map-center-pin-wrap {
            transform: translate(-50%, -58px);
        }

        .map-center-pin-head {
            position: absolute;
            top: 0;
            left: 5px;
            width: 32px;
            height: 32px;
            border: 7px solid var(--pin-color);
            border-radius: 50%;
            background: #fff;
        }

        .map-center-pin-stick {
            position: absolute;
            top: 29px;
            left: 19px;
            width: 4px;
            height: 20px;
            border-radius: 0 0 4px 4px;
            background: var(--pin-color);
        }

        .map-center-pin-shadow {
            position: absolute;
            top: calc(50% + 3px);
            left: 50%;
            width: 22px;
            height: 7px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.2);
            transform: translate(-50%, -50%);
            transition: transform 160ms ease, opacity 160ms ease;
        }

        .map-center-location-picker.is-moving .map-center-pin-shadow {
            opacity: 0.12;
            transform: translate(-50%, -50%) scale(0.7);
        }

        .map-center-picker-actions {
            position: absolute;
            right: 14px;
            bottom: 14px;
            left: 14px;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 10px;
            align-items: center;
            padding: 10px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.96);
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
            pointer-events: auto;
        }

        .map-center-picker-actions span {
            color: #374151;
            font-size: 11px;
            font-weight: 700;
            line-height: 1.3;
        }

        .map-center-picker-confirm {
            min-height: 38px;
            padding: 0 14px;
            border: 0;
            border-radius: 9px;
            color: #fff;
            background: #0b5d2a;
            font-size: 12px;
            font-weight: 800;
            cursor: pointer !important;
        }

        .map-center-location-picker.is-drop .map-center-picker-confirm {
            background: #d32f2f;
        }

        .map-center-picker-confirm:disabled {
            opacity: 0.65;
        }

        .vehicle-marker-legend {
            position: absolute;
            top: 58px;
            left: 12px;
            z-index: 700;
            display: flex;
            gap: 6px;
            padding: 5px 7px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.94);
            box-shadow: 0 5px 14px rgba(0, 0, 0, 0.12);
            pointer-events: none;
        }

        .vehicle-marker-legend span {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            color: #374151;
            font-size: 10px;
            font-weight: 800;
        }

        .vehicle-marker-legend img {
            width: 23px;
            height: 23px;
            object-fit: contain;
        }

        .assigned-driver-tracking {
            position: absolute;
            right: 12px;
            bottom: 12px;
            left: 12px;
            z-index: 710;
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
            padding: 9px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.96);
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
            pointer-events: none;
        }

        .assigned-driver-tracking span {
            display: block;
            color: #6b7280;
            font-size: 10px;
            font-weight: 800;
            line-height: 1.2;
            text-transform: uppercase;
        }

        .assigned-driver-tracking strong {
            display: block;
            margin-top: 2px;
            color: #111827;
            font-size: 13px;
            font-weight: 900;
            line-height: 1.2;
            overflow-wrap: anywhere;
        }

        .rotating-vehicle-marker {
            position: absolute;
            width: 48px;
            height: 48px;
            pointer-events: auto;
            will-change: transform;
        }

        .rotating-vehicle-marker img {
            width: 48px;
            height: 48px;
            object-fit: contain;
            transform-origin: 50% 50%;
            transition: transform 220ms linear;
            user-select: none;
        }
    `;
    document.head.appendChild(style);
}

function googleLatLngLiteral(coords) {
    return { lat: Number(coords.lat), lng: Number(coords.lng) };
}

class RotatingVehicleMarker {
    constructor({ map, position, title = "", vehicleType = "bike", heading = null, zIndex = 500 }) {
        const maps = getGoogleMaps();
        this.position = googleLatLngLiteral(position);
        this.title = title;
        this.vehicleType = vehicleType;
        this.heading = normalizeHeading(heading);
        this.overlay = new maps.OverlayView();
        this.element = document.createElement("div");
        this.element.className = "rotating-vehicle-marker";
        this.element.style.zIndex = String(zIndex);
        this.element.title = title;
        this.image = document.createElement("img");
        this.image.alt = "";
        this.image.draggable = false;
        this.element.appendChild(this.image);
        this.setVehicleType(vehicleType);
        this.setHeading(this.heading);

        this.overlay.onAdd = () => {
            this.overlay.getPanes()?.overlayMouseTarget.appendChild(this.element);
        };
        this.overlay.draw = () => this.draw();
        this.overlay.onRemove = () => {
            this.element.remove();
        };
        this.overlay.setMap(map);
    }

    draw() {
        const projection = this.overlay.getProjection();
        if (!projection || !this.position) return;

        const maps = getGoogleMaps();
        const point = projection.fromLatLngToDivPixel(new maps.LatLng(this.position.lat, this.position.lng));
        if (!point) return;

        this.element.style.transform = `translate(${point.x - 24}px, ${point.y - 24}px)`;
    }

    getPosition() {
        const maps = getGoogleMaps();
        return new maps.LatLng(this.position.lat, this.position.lng);
    }

    setPosition(position) {
        this.position = googleLatLngLiteral(position);
        this.draw();
    }

    setMap(map) {
        this.overlay.setMap(map);
    }

    setTitle(title = "") {
        this.title = title;
        this.element.title = title;
    }

    setIcon(icon) {
        if (icon?.url) this.image.src = icon.url;
    }

    setVehicleType(vehicleType = "bike") {
        this.vehicleType = vehicleType;
        this.image.src = VEHICLE_MARKER_ASSETS[vehicleType] || VEHICLE_MARKER_ASSETS.bike;
    }

    setHeading(heading) {
        const normalized = normalizeHeading(heading);
        if (normalized == null) return;

        this.heading = normalized;
        this.image.style.transform = `rotate(${normalized}deg)`;
    }
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

function getRideDropLocation(detail = {}) {
    const drop = normalizeCoordinatePair(detail.drop_lat, detail.drop_lng);
    if (!Number.isFinite(drop.lat) || !Number.isFinite(drop.lng)) return null;

    return {
        position: drop,
        title: detail.drop_name || detail.drop_full_address || "Destination"
    };
}

function upsertRideDestinationMarker(detail = {}) {
    if (!window.mapInstance) return null;

    const destination = getRideDropLocation(detail);
    if (!destination) return null;

    if (!destinationMarker) {
        destinationMarker = makeMarker({
            map: window.mapInstance,
            position: googleLatLngLiteral(destination.position),
            title: destination.title,
            zIndex: 920
        });
        return destination.position;
    }

    destinationMarker.setMap(window.mapInstance);
    destinationMarker.setPosition(googleLatLngLiteral(destination.position));
    destinationMarker.setTitle(destination.title);
    return destination.position;
}

function renderRouteMetric(distanceKm, durationMinutes) {
    if (!window.mapInstance || !Number.isFinite(distanceKm) || !Number.isFinite(durationMinutes)) return;

    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    if (routeMetricElement) {
        routeMetricElement.remove();
        routeMetricElement = null;
    }

    routeMetricElement = document.createElement("div");
    routeMetricElement.className = "map-metric";
    routeMetricElement.setAttribute("role", "status");
    routeMetricElement.setAttribute("aria-live", "polite");
    routeMetricElement.textContent = `${distanceKm.toFixed(1)} km \u2022 ${Math.round(durationMinutes)} mins`;
    mapContainer.appendChild(routeMetricElement);
}

function formatTrackingDistance(distanceKm) {
    const distance = Number(distanceKm);
    if (!Number.isFinite(distance) || distance < 0) return "--";
    if (distance < 1) return `${Math.round(distance * 1000)} m`;
    return `${distance.toFixed(1)} km`;
}

function formatTrackingDuration(durationMinutes) {
    const duration = Number(durationMinutes);
    if (!Number.isFinite(duration) || duration < 0) return "--";
    return `${Math.max(1, Math.round(duration))} min`;
}

function getAssignedDriverTrend(distanceKm) {
    if (!Number.isFinite(distanceKm)) return "Tracking";
    if (!Number.isFinite(assignedDriverLastDistanceKm)) return "Tracking";

    const deltaKm = assignedDriverLastDistanceKm - distanceKm;
    if (deltaKm > 0.03) return "Getting closer";
    if (deltaKm < -0.03) return "Moving away";
    return "Holding";
}

function renderAssignedDriverTracking(routeDetails, straightLineDistanceKm = null) {
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    const distanceKm = Number.isFinite(Number(routeDetails?.distanceKm))
        ? Number(routeDetails.distanceKm)
        : Number(straightLineDistanceKm);
    const durationMinutes = Number(routeDetails?.durationMinutes);
    const trend = getAssignedDriverTrend(distanceKm);

    if (!assignedDriverTrackingElement) {
        assignedDriverTrackingElement = document.createElement("div");
        assignedDriverTrackingElement.className = "assigned-driver-tracking";
        assignedDriverTrackingElement.setAttribute("role", "status");
        assignedDriverTrackingElement.setAttribute("aria-live", "polite");
        mapContainer.appendChild(assignedDriverTrackingElement);
    }

    assignedDriverTrackingElement.innerHTML = `
        <div><span>Driver</span><strong>${trend}</strong></div>
        <div><span>Distance</span><strong>${formatTrackingDistance(distanceKm)}</strong></div>
        <div><span>ETA</span><strong>${formatTrackingDuration(durationMinutes)}</strong></div>
    `;

    if (Number.isFinite(distanceKm)) {
        assignedDriverLastDistanceKm = distanceKm;
    }
}

function clearAssignedDriverRoute() {
    if (assignedDriverRoutePolyline?.setMap) {
        assignedDriverRoutePolyline.setMap(null);
    }
    assignedDriverRoutePolyline = null;
    if (assignedDriverTrackingElement) {
        assignedDriverTrackingElement.remove();
        assignedDriverTrackingElement = null;
    }
    assignedDriverLastDistanceKm = null;
}

function drawAssignedDriverRoute(path, driverPosition, targetPosition, destinationPosition = null) {
    if (!window.mapInstance || !window.google?.maps) return;

    if (assignedDriverRoutePolyline?.setMap) {
        assignedDriverRoutePolyline.setMap(null);
    }

    const routePath = Array.isArray(path) && path.length >= 2
        ? path
        : [driverPosition, targetPosition].filter(Boolean);
    if (routePath.length < 2) return;

    assignedDriverRoutePolyline = new window.google.maps.Polyline({
        map: window.mapInstance,
        path: routePath,
        strokeColor: "#16723a",
        strokeOpacity: 0.96,
        strokeWeight: 6,
        zIndex: 640
    });

    const bounds = new window.google.maps.LatLngBounds();
    routePath.forEach((point) => bounds.extend(point));
    bounds.extend(driverPosition);
    bounds.extend(targetPosition);
    if (destinationPosition) bounds.extend(destinationPosition);
    window.mapInstance.fitBounds(bounds, { top: 58, right: 42, bottom: 96, left: 42 });
}

function setGlobalDriverMarkerVisibility(driverId, existing) {
    if (!existing?.marker?.setMap) return;

    const shouldShow = !assignedDriverTrackingDriverId || driverId === assignedDriverTrackingDriverId;
    existing.marker.setMap(shouldShow ? window.mapInstance : null);
}

function syncGlobalDriverMarkerVisibility() {
    globalDriverMarkers.forEach((existing, driverId) => {
        setGlobalDriverMarkerVisibility(driverId, existing);
    });

    if (vehicleLegendElement) {
        vehicleLegendElement.classList.toggle("d-none", Boolean(assignedDriverTrackingDriverId));
    }
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
    const fallback = readCachedPickupLocation() || getFallbackPickupLocation();

    if (!navigator.geolocation) {
        userLatitude = fallback.lat;
        userLongitude = fallback.lng;
        if (pickupInput && !pickupInput.value) pickupInput.value = fallback.label;
        return fallback;
    }

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const coords = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    label: "Current location"
                };
                userLatitude = coords.lat;
                userLongitude = coords.lng;

                const placeholderValue = coords.label;
                if (pickupInput) pickupInput.value = placeholderValue;

                const geocoded = await reverseGeocodeLocation(coords.lat, coords.lng);
                const resolvedLabel = geocoded?.name || geocoded?.fullAddress || coords.label;
                coords.label = resolvedLabel;
                coords.fullAddress = geocoded?.fullAddress || "";
                coords.placeId = geocoded?.placeId || "";

                if (pickupInput && pickupInput.value === placeholderValue) {
                    pickupInput.value = resolvedLabel;
                }

                rememberPickupLocation(coords, resolvedLabel);
                resolve(coords);
            },
            () => {
                userLatitude = fallback.lat;
                userLongitude = fallback.lng;
                if (pickupInput && !pickupInput.value) pickupInput.value = fallback.label;
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
    const vehicleType = inferDriverVehicleType(driver);
    return {
        url: VEHICLE_MARKER_ASSETS[vehicleType],
        scaledSize: new maps.Size(48, 48),
        anchor: new maps.Point(24, 24)
    };
}

function getDriverDocumentHeading(driver) {
    return normalizeHeading(
        driver.driverHeading
        ?? driver.heading
        ?? driver.driverLocation?.heading
        ?? driver.driverLocation?.bearing
    );
}

function getRouteHeading(position, routePath = []) {
    if (!position || !Array.isArray(routePath) || routePath.length < 2) return null;

    let bestIndex = -1;
    let bestDistance = Infinity;
    routePath.forEach((point, index) => {
        const distance = calculateDistanceMeters(position, point);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    if (bestIndex < 0) return null;
    const nextPoint = routePath[bestIndex + 1] || routePath[bestIndex];
    const previousPoint = routePath[bestIndex - 1] || routePath[bestIndex];
    return calculateBearing(previousPoint, nextPoint);
}

function resolveDriverHeading(existing, position, driver, routePath = []) {
    const routeHeading = getRouteHeading(position, routePath);
    if (routeHeading != null) {
        return smoothHeading(existing?.heading, routeHeading, 0.45);
    }

    const documentHeading = getDriverDocumentHeading(driver);
    if (documentHeading != null) {
        return smoothHeading(existing?.heading, documentHeading, 0.4);
    }

    const previousPosition = existing?.marker?.getPosition?.();
    if (previousPosition) {
        const previous = { lat: previousPosition.lat(), lng: previousPosition.lng() };
        if (calculateDistanceMeters(previous, position) >= DRIVER_HEADING_MIN_DISTANCE_METERS) {
            return smoothHeading(existing?.heading, calculateBearing(previous, position), 0.35);
        }
    }

    return normalizeHeading(existing?.heading);
}

function updateVehicleMarkerLegend() {
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    const counts = { bike: 0, auto: 0 };
    globalDriverMarkers.forEach(({ vehicleType }) => {
        counts[vehicleType] = (counts[vehicleType] || 0) + 1;
    });

    if (!vehicleLegendElement) {
        vehicleLegendElement = document.createElement("div");
        vehicleLegendElement.className = "vehicle-marker-legend";
        vehicleLegendElement.setAttribute("aria-label", "Nearby vehicle counts");
        mapContainer.appendChild(vehicleLegendElement);
    }

    vehicleLegendElement.innerHTML = `
        <span><img src="${VEHICLE_MARKER_ASSETS.bike}" alt="">Bike ${counts.bike}</span>
        <span><img src="${VEHICLE_MARKER_ASSETS.auto}" alt="">Auto ${counts.auto}</span>
    `;
    vehicleLegendElement.classList.toggle("d-none", Boolean(assignedDriverTrackingDriverId));
}

function animateGlobalDriverMarker(existing, targetPosition, targetHeading = null) {
    if (existing.animationFrame) cancelAnimationFrame(existing.animationFrame);

    const current = existing.marker.getPosition();
    if (!current || typeof requestAnimationFrame !== "function") {
        existing.marker.setPosition(targetPosition);
        existing.marker.setHeading?.(targetHeading);
        return;
    }

    const startPosition = { lat: current.lat(), lng: current.lng() };
    const latitudeDelta = targetPosition.lat - startPosition.lat;
    const longitudeDelta = targetPosition.lng - startPosition.lng;
    if (Math.abs(latitudeDelta) > 0.05 || Math.abs(longitudeDelta) > 0.05) {
        existing.marker.setPosition(targetPosition);
        existing.marker.setHeading?.(targetHeading);
        return;
    }

    const startedAt = performance.now();
    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / DRIVER_MARKER_ANIMATION_MS);
        const eased = progress * progress * (3 - (2 * progress));
        existing.marker.setPosition({
            lat: startPosition.lat + (latitudeDelta * eased),
            lng: startPosition.lng + (longitudeDelta * eased)
        });
        if (targetHeading != null) {
            existing.marker.setHeading(smoothHeading(existing.heading, targetHeading, eased));
        }

        if (progress < 1) {
            existing.animationFrame = requestAnimationFrame(step);
        } else {
            existing.heading = targetHeading ?? existing.heading;
            existing.marker.setHeading?.(existing.heading);
            existing.animationFrame = null;
        }
    };
    existing.animationFrame = requestAnimationFrame(step);
}

const DRIVER_LOCATION_VISIBLE_MS = 15 * 60 * 1000;

function getTimestampMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isLiveDriverVisible(driver) {
    const location = driver.driverLocation || {};
    const lastLocationAt = getTimestampMs(driver.lastLocationAt || driver.lastSeenAt || driver.updatedAt);
    const hasFreshLocation = lastLocationAt
        ? Date.now() - lastLocationAt <= DRIVER_LOCATION_VISIBLE_MS
        : driver.isConnected === true;

    return driver.desiredAvailability !== "offline"
        && driver.driverAvailability !== "offline"
        && hasFreshLocation
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
    const heading = resolveDriverHeading(existing, position, driver, driver.activeRoutePath || []);

    if (!existing) {
        const marker = new RotatingVehicleMarker({
            map: assignedDriverTrackingDriverId && driverId !== assignedDriverTrackingDriverId ? null : window.mapInstance,
            position,
            title: `${driver.name || "Online Driver"} - ${vehicleType}`,
            vehicleType,
            heading,
            zIndex: 500
        });

        globalDriverMarkers.set(driverId, { marker, vehicleType, heading, animationFrame: null });
        setGlobalDriverMarkerVisibility(driverId, globalDriverMarkers.get(driverId));
        updateVehicleMarkerLegend();
        return;
    }

    setGlobalDriverMarkerVisibility(driverId, existing);
    animateGlobalDriverMarker(existing, position, heading);
    existing.marker.setTitle(`${driver.name || "Online Driver"} - ${vehicleType}`);
    if (existing.vehicleType !== vehicleType) {
        existing.marker.setVehicleType?.(vehicleType);
        existing.marker.setIcon?.(createDriverMarkerIcon(driver));
        existing.vehicleType = vehicleType;
        updateVehicleMarkerLegend();
    }
    if (heading != null && !existing.animationFrame) {
        existing.heading = heading;
        existing.marker.setHeading?.(heading);
    }
}

function removeGlobalDriverMarker(driverId) {
    const existing = globalDriverMarkers.get(driverId);
    if (!existing) return;
    if (existing.animationFrame) cancelAnimationFrame(existing.animationFrame);
    removeMarker(existing.marker);
    globalDriverMarkers.delete(driverId);
    updateVehicleMarkerLegend();
}

function clearGlobalDriverMarkers() {
    Array.from(globalDriverMarkers.keys()).forEach(removeGlobalDriverMarker);
}

function resetActiveDriverRouteState() {
    activeDriverRouteState = {
        driverId: "",
        targetKey: "",
        routePath: [],
        lastRoutePosition: null,
        lastRouteAt: 0,
        routeRequestInFlight: false,
        queuedDetail: null
    };
}

function clearActiveDriverMarker() {
    if (activeDriverMarker?.animationFrame) cancelAnimationFrame(activeDriverMarker.animationFrame);
    removeMarker(activeDriverMarker?.marker);
    activeDriverMarker = null;
    assignedDriverTrackingDriverId = "";
    clearAssignedDriverRoute();
    clearRouteAndDestination();
    resetActiveDriverRouteState();
    syncGlobalDriverMarkerVisibility();
}

function getActiveRideTarget(detail = {}) {
    const status = detail.rideStatus || detail.status || "";
    const isDestinationLeg = status === "started" || status === "en_route";
    const target = isDestinationLeg
        ? normalizeCoordinatePair(detail.drop_lat, detail.drop_lng)
        : normalizeCoordinatePair(detail.pickup_lat, detail.pickup_lng);

    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return null;
    return target;
}

async function refreshActiveDriverRoute(detail, position, target) {
    const driverId = detail.driver_id || detail.driverId || "assigned";
    const targetKey = `${driverId}:${target.lat}:${target.lng}`;
    const destinationPosition = upsertRideDestinationMarker(detail);
    const targetChanged = activeDriverRouteState.targetKey !== targetKey;
    const moved = calculateDistanceMeters(activeDriverRouteState.lastRoutePosition, position);
    const elapsed = Date.now() - activeDriverRouteState.lastRouteAt;

    if (targetChanged) {
        activeDriverRouteState.routePath = [];
        activeDriverRouteState.lastRoutePosition = null;
        activeDriverRouteState.lastRouteAt = 0;
    }

    if (!targetChanged
        && activeDriverRouteState.routePath.length
        && moved < ACTIVE_DRIVER_ROUTE_RECALC_DISTANCE_METERS) {
        return;
    }

    if (!targetChanged
        && activeDriverRouteState.routePath.length
        && elapsed < ACTIVE_DRIVER_ROUTE_RECALC_MIN_INTERVAL_MS) {
        return;
    }

    if (activeDriverRouteState.routeRequestInFlight) {
        activeDriverRouteState.queuedDetail = detail;
        return;
    }

    activeDriverRouteState.routeRequestInFlight = true;
    let routeRefreshed = false;
    const hadRoutePath = activeDriverRouteState.routePath.length > 0;
    try {
        const routeDetails = await fetchRoadRouteDetails(position, target);
        if (!routeDetails?.routePath?.length) {
            const straightLineDistanceKm = calculateDistanceMeters(position, target) / 1000;
            drawAssignedDriverRoute([], position, target, destinationPosition);
            renderAssignedDriverTracking(routeDetails, straightLineDistanceKm);
            return;
        }

        activeDriverRouteState.driverId = driverId;
        activeDriverRouteState.targetKey = targetKey;
        activeDriverRouteState.routePath = routeDetails.routePath;
        activeDriverRouteState.lastRoutePosition = position;
        activeDriverRouteState.lastRouteAt = Date.now();
        drawAssignedDriverRoute(routeDetails.routePath, position, target, destinationPosition);
        if (!hadRoutePath) assignedDriverLastDistanceKm = null;
        renderAssignedDriverTracking(routeDetails);
        routeRefreshed = true;
    } catch (error) {
        console.warn("Assigned driver route heading lookup failed:", error);
        const straightLineDistanceKm = calculateDistanceMeters(position, target) / 1000;
        drawAssignedDriverRoute([], position, target, destinationPosition);
        renderAssignedDriverTracking(null, straightLineDistanceKm);
    } finally {
        activeDriverRouteState.routeRequestInFlight = false;
        const queuedDetail = activeDriverRouteState.queuedDetail;
        activeDriverRouteState.queuedDetail = null;
        if (queuedDetail || routeRefreshed) {
            handleAssignedDriverLocation({ detail: queuedDetail || detail });
        }
    }
}

async function handleAssignedDriverLocation(event) {
    const detail = event.detail || {};
    if (!window.mapInstance) {
        pendingAssignedDriverDetail = detail;
        return;
    }

    const location = detail.driverLocation || detail;
    const position = {
        lat: Number(location.lat),
        lng: Number(location.lng)
    };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;

    const vehicleType = inferDriverVehicleType(detail);
    const target = getActiveRideTarget(detail);
    const driverId = detail.driver_id || detail.driverId || "assigned";
    assignedDriverTrackingDriverId = driverId;
    syncGlobalDriverMarkerVisibility();
    clearRouteAndDestination();
    upsertRideDestinationMarker(detail);

    if (target) {
        const targetKey = `${driverId}:${target.lat}:${target.lng}`;
        if (activeDriverRouteState.targetKey !== targetKey || !activeDriverRouteState.routePath.length) {
            renderAssignedDriverTracking(null, calculateDistanceMeters(position, target) / 1000);
        }
        refreshActiveDriverRoute(detail, position, target).catch((error) => {
            console.warn("Assigned driver route heading refresh failed:", error);
        });
    }

    const existingGlobal = driverId ? globalDriverMarkers.get(driverId) : null;
    const existing = existingGlobal || activeDriverMarker;
    const routePath = target ? activeDriverRouteState.routePath : [];
    const heading = resolveDriverHeading(existing, position, detail, routePath);

    if (existingGlobal) {
        if (activeDriverMarker) {
            if (activeDriverMarker.animationFrame) cancelAnimationFrame(activeDriverMarker.animationFrame);
            removeMarker(activeDriverMarker.marker);
            activeDriverMarker = null;
        }
        animateGlobalDriverMarker(existingGlobal, position, heading);
        if (heading != null && !existingGlobal.animationFrame) {
            existingGlobal.heading = heading;
            existingGlobal.marker.setHeading?.(heading);
        }
        existingGlobal.marker.setTitle(detail.driver_name || "Assigned Driver");
        return;
    }

    if (!activeDriverMarker) {
        activeDriverMarker = {
            marker: new RotatingVehicleMarker({
                map: window.mapInstance,
                position,
                title: detail.driver_name || "Assigned Driver",
                vehicleType,
                heading,
                zIndex: 950
            }),
            vehicleType,
            heading,
            animationFrame: null
        };
        return;
    }

    animateGlobalDriverMarker(activeDriverMarker, position, heading);
    activeDriverMarker.marker.setTitle(detail.driver_name || "Assigned Driver");
    if (activeDriverMarker.vehicleType !== vehicleType) {
        activeDriverMarker.marker.setVehicleType(vehicleType);
        activeDriverMarker.vehicleType = vehicleType;
    }
}

function startGlobalDriverPresenceListener() {
    if (!window.mapInstance) return;

    if (globalDriversUnsubscribe) {
        globalDriversUnsubscribe();
        globalDriversUnsubscribe = null;
    }

    clearGlobalDriverMarkers();
    updateVehicleMarkerLegend();
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

async function refreshLivePickupAfterMapReady(initialCoords) {
    const coords = await getUserLocation();
    const pickupInput = document.getElementById("pickup-input");
    const label = coords.label || pickupInput?.value || "Current location";

    rememberPickupLocation(coords, label);
    addPickupMarker(coords);

    const movedFromInitial = Math.abs(coords.lat - initialCoords.lat) > 0.00001
        || Math.abs(coords.lng - initialCoords.lng) > 0.00001;
    if (movedFromInitial) {
        window.mapInstance?.panTo(googleLatLngLiteral(coords));
    }

    window.dispatchEvent(new CustomEvent("pickup-location-updated", {
        detail: { name: label, lat: coords.lat, lng: coords.lng }
    }));

    if (!window.selectedDestination) return;

    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!fareQuoteBox || !fareAmountSpan) return;

    fareAmountSpan.innerText = "Calculating...";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");
    await renderDestinationFare(window.selectedDestination, fareQuoteBox, fareAmountSpan);
}

export async function initializeMapEngine() {
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;
    const coords = getInitialPickupLocation();

    hidePickupSuggestions();
    hideDestinationSuggestions();
    pickupMapPickMode = null;
    destinationMapPickMode = null;
    hideCenterMapPicker();
    window.latestFareQuote = null;
    window.selectedDestination = null;
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));

    await loadGoogleMaps();
    addGoogleMapStyles();

    if (globalDriversUnsubscribe) {
        globalDriversUnsubscribe();
        globalDriversUnsubscribe = null;
    }
    clearGlobalDriverMarkers();
    clearActiveDriverMarker();
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
    if (pendingAssignedDriverDetail) {
        const detail = pendingAssignedDriverDetail;
        pendingAssignedDriverDetail = null;
        handleAssignedDriverLocation({ detail });
    }

    window.mapInstance.addListener("dragstart", () => {
        centerMapPickerElement?.classList.add("is-moving");
    });
    window.mapInstance.addListener("dragend", () => {
        centerMapPickerElement?.classList.remove("is-moving");
    });

    setupFareEngineListeners();
    setupPickupSearchListeners();
    startGlobalDriverPresenceListener();
    window.dispatchEvent(new CustomEvent("map-engine-ready", {
        detail: { pickup: { lat: coords.lat, lng: coords.lng } }
    }));

    refreshLivePickupAfterMapReady(coords).catch((error) => {
        console.warn("Current pickup location refresh failed:", error);
    });
}

function setupPickupSearchListeners() {
    if (pickupSearchListenersBound) return;

    const pickupInput = document.getElementById("pickup-input");
    if (!pickupInput) return;
    pickupSearchListenersBound = true;

    pickupInput.addEventListener("focus", () => {
        hideDestinationSuggestions();
        if (!pickupInput.readOnly) {
            showPickupSuggestions(pickupInput, [], false);
        }
    });

    pickupInput.addEventListener("input", () => {
        if (pickupInput.readOnly) return;
        cancelCenterMapPick();
        const query = pickupInput.value.trim();

        if (pickupSearchTimer) clearTimeout(pickupSearchTimer);
        if (pickupSearchAbortController) {
            pickupSearchAbortController.abort();
            pickupSearchAbortController = null;
        }
        hideDestinationSuggestions();

        window.latestFareQuote = null;
        window.dispatchEvent(new CustomEvent("fare-quote-reset"));
        clearRouteAndDestination();

        if (query.length < 2) {
            hidePickupSuggestions();
            return;
        }

        pickupSearchTimer = setTimeout(async () => {
            const pickups = await searchGooglePickups(query);
            if (pickupInput.readOnly || pickupInput.value.trim() !== query) return;
            showPickupSuggestions(pickupInput, pickups.slice(0, MAX_VISIBLE_SUGGESTIONS));
        }, DESTINATION_SEARCH_DEBOUNCE_MS);
    });
}

function ensurePickupSuggestions(pickupInput) {
    let suggestions = document.getElementById("pickup-suggestions");
    if (suggestions) return suggestions;

    suggestions = document.createElement("div");
    suggestions.id = "pickup-suggestions";
    suggestions.className = "location-suggestions destination-suggestions";
    suggestions.setAttribute("role", "listbox");
    pickupInput.closest(".services-location-card")?.after(suggestions);
    return suggestions;
}

function hidePickupSuggestions() {
    document.getElementById("pickup-suggestions")?.classList.remove("is-visible");
}

async function searchGooglePickups(query) {
    pickupSearchAbortController = new AbortController();
    const signal = pickupSearchAbortController.signal;

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
        if (signal.aborted || !response.ok) return [];

        return (Array.isArray(data.results) ? data.results : []).map((place) => ({
            ...place,
            ...normalizeCoordinatePair(place.lat, place.lng),
            typeHint: place.typeHint || getPlaceTypeHint(place),
            source: "google",
            provider: "google"
        }));
    } catch (error) {
        if (error.name !== "AbortError") console.warn("Google pickup search failed:", error);
        return [];
    }
}

function showPickupSuggestions(pickupInput, pickups, showEmptyMessage = true) {
    const suggestions = ensurePickupSuggestions(pickupInput);
    if (!pickups.length) {
        suggestions.innerHTML = `
            <button class="destination-suggestion-item use-current-pickup-item" type="button">
                <span class="destination-suggestion-pin"><span class="webicon webicon-use-current-location" aria-hidden="true"></span></span>
                <span><strong class="destination-suggestion-main">Use current location</strong><small class="destination-suggestion-sub">Detect this device's GPS location</small></span>
            </button>
            <button class="destination-map-pick-btn choose-pickup-on-map-btn" type="button">Select pickup on map</button>
            ${showEmptyMessage ? '<div class="destination-suggestion-empty">No Google result found for this pickup name.</div>' : ''}
        `;
        suggestions.querySelector(".use-current-pickup-item")?.addEventListener("click", useCurrentPickupLocation);
        suggestions.querySelector(".choose-pickup-on-map-btn")?.addEventListener("click", () => startPickupMapPick(pickupInput));
        suggestions.classList.add("is-visible");
        return;
    }

    suggestions.innerHTML = `
        <div class="destination-suggestions-title">Pickup search results</div>
        <button class="destination-suggestion-item use-current-pickup-item" type="button">
            <span class="destination-suggestion-pin"><span class="webicon webicon-use-current-location" aria-hidden="true"></span></span>
            <span><strong class="destination-suggestion-main">Use current location</strong><small class="destination-suggestion-sub">Detect this device's GPS location</small></span>
        </button>
        <button class="destination-map-pick-btn choose-pickup-on-map-btn" type="button">Select pickup on map</button>
        ${pickups.map((pickup, index) => `
            <button class="destination-suggestion-item" type="button" role="option" data-index="${index}">
                <span class="destination-suggestion-pin"><span class="webicon webicon-current-location" aria-hidden="true"></span></span>
                <span>
                    <strong class="destination-suggestion-main">${escapeHtml(pickup.mainName || pickup.name)}</strong>
                    <small class="destination-suggestion-sub">${escapeHtml(pickup.fullAddress || "Tripura, India")}</small>
                    <span class="destination-suggestion-meta"><span>${escapeHtml(pickup.typeHint)}</span></span>
                </span>
            </button>
        `).join("")}
    `;

    suggestions.querySelector(".use-current-pickup-item")?.addEventListener("click", useCurrentPickupLocation);
    suggestions.querySelector(".choose-pickup-on-map-btn")?.addEventListener("click", () => startPickupMapPick(pickupInput));

    suggestions.querySelectorAll(".destination-suggestion-item[data-index]").forEach((item) => {
        item.addEventListener("click", async () => {
            const selected = pickups[Number(item.dataset.index)];
            if (!selected) return;

            const resolved = await resolveGooglePlace(selected);
            if (!resolved) return;

            cancelCenterMapPick();
            const existingDestination = window.selectedDestination;
            userLatitude = resolved.lat;
            userLongitude = resolved.lng;
            pickupInput.value = resolved.mainName || resolved.name;
            rememberPickupLocation(resolved, pickupInput.value);
            hidePickupSuggestions();
            addPickupMarker(resolved);
            window.mapInstance?.panTo(googleLatLngLiteral(resolved));
            window.mapInstance?.setZoom(15);
            window.dispatchEvent(new CustomEvent("pickup-location-updated", {
                detail: { name: pickupInput.value, lat: resolved.lat, lng: resolved.lng }
            }));

            window.latestFareQuote = null;
            window.dispatchEvent(new CustomEvent("fare-quote-reset"));
            clearRouteAndDestination();

            if (existingDestination) {
                window.selectedDestination = existingDestination;
                const fareQuoteBox = document.getElementById("fare-quote-box");
                const fareAmountSpan = document.getElementById("fare-amount");
                if (fareQuoteBox && fareAmountSpan) {
                    fareAmountSpan.innerText = "Calculating...";
                    fareQuoteBox.classList.remove("d-none");
                    fareQuoteBox.classList.add("d-flex");
                    await renderDestinationFare(existingDestination, fareQuoteBox, fareAmountSpan);
                }
            }
        });
    });
    suggestions.classList.add("is-visible");
}

function hideCenterMapPicker() {
    centerMapPickerElement?.remove();
    centerMapPickerElement = null;
    document.getElementById("map-container")?.classList.remove("is-location-pick-mode");
}

function cancelCenterMapPick() {
    pickupMapPickMode = null;
    destinationMapPickMode = null;
    hideCenterMapPicker();
}

function showCenterMapPicker(kind) {
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    hideCenterMapPicker();
    centerMapPickerElement = document.createElement("div");
    centerMapPickerElement.className = `map-center-location-picker is-${kind}`;
    centerMapPickerElement.innerHTML = `
        <span class="map-center-pin-shadow" aria-hidden="true"></span>
        <span class="map-center-pin-wrap" aria-hidden="true">
            <span class="map-center-pin-head"></span>
            <span class="map-center-pin-stick"></span>
        </span>
        <div class="map-center-picker-actions">
            <span>Move the map to place the ${kind} pin exactly</span>
            <button class="map-center-picker-confirm" type="button">Select ${kind}</button>
        </div>
    `;

    centerMapPickerElement.querySelector(".map-center-picker-confirm")?.addEventListener("click", async (event) => {
        const center = window.mapInstance?.getCenter?.();
        if (!center) return;

        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Selecting...";
        const lat = center.lat();
        const lng = center.lng();
        if (kind === "pickup") {
            await completePickupMapPick(lat, lng);
        } else {
            await completeDestinationMapPick(lat, lng);
        }
    });

    mapContainer.classList.add("is-location-pick-mode");
    mapContainer.appendChild(centerMapPickerElement);
}

function startPickupMapPick(pickupInput) {
    if (!window.mapInstance) {
        alert("Map is not ready yet. Please wait a moment and try again.");
        return;
    }

    cancelCenterMapPick();
    pickupMapPickMode = {
        pickupInput,
        existingDestination: window.selectedDestination
    };
    hidePickupSuggestions();
    hideDestinationSuggestions();
    window.latestFareQuote = null;
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));
    clearRouteAndDestination();
    window.mapInstance.panTo({ lat: userLatitude, lng: userLongitude });
    window.mapInstance.setZoom(16);
    showCenterMapPicker("pickup");
    window.dispatchEvent(new CustomEvent("pickup-location-updated", {
        detail: { name: "Move the map and confirm the pickup pin" }
    }));
}

async function completePickupMapPick(lat, lng) {
    if (!pickupMapPickMode) return;

    const pickMode = pickupMapPickMode;
    pickupMapPickMode = null;

    const result = await reverseGeocodeLocation(lat, lng);
    const pickup = {
        lat,
        lng,
        name: result?.name || result?.fullAddress || "Pinned pickup",
        fullAddress: result?.fullAddress || ""
    };

    userLatitude = lat;
    userLongitude = lng;
    pickMode.pickupInput.value = pickup.name;
    rememberPickupLocation(pickup, pickup.name);
    hideCenterMapPicker();
    addPickupMarker(pickup);
    window.mapInstance?.panTo({ lat, lng });
    window.mapInstance?.setZoom(15);
    window.dispatchEvent(new CustomEvent("pickup-location-updated", {
        detail: { name: pickup.name, lat, lng }
    }));

    if (!pickMode.existingDestination) return;
    window.selectedDestination = pickMode.existingDestination;
    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!fareQuoteBox || !fareAmountSpan) return;

    fareAmountSpan.innerText = "Calculating...";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");
    await renderDestinationFare(pickMode.existingDestination, fareQuoteBox, fareAmountSpan);
}

export async function useCurrentPickupLocation() {
    const pickupInput = document.getElementById("pickup-input");
    if (!pickupInput || pickupInput.readOnly) return;
    cancelCenterMapPick();

    if (pickupSearchTimer) clearTimeout(pickupSearchTimer);
    if (pickupSearchAbortController) {
        pickupSearchAbortController.abort();
        pickupSearchAbortController = null;
    }

    const existingDestination = window.selectedDestination;
    hidePickupSuggestions();
    const coords = await getUserLocation();
    addPickupMarker(coords);
    window.mapInstance?.panTo(googleLatLngLiteral(coords));
    window.mapInstance?.setZoom(15);
    window.dispatchEvent(new CustomEvent("pickup-location-updated", {
        detail: { name: coords.label, lat: coords.lat, lng: coords.lng }
    }));

    window.latestFareQuote = null;
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));
    clearRouteAndDestination();

    if (!existingDestination) return;
    window.selectedDestination = existingDestination;
    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!fareQuoteBox || !fareAmountSpan) return;

    fareAmountSpan.innerText = "Calculating...";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");
    await renderDestinationFare(existingDestination, fareQuoteBox, fareAmountSpan);
}

function setupFareEngineListeners() {
    if (fareEngineListenersBound) return;

    const dropInput = document.getElementById("drop-input");
    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!dropInput || !fareQuoteBox || !fareAmountSpan) return;

    fareEngineListenersBound = true;
    dropInput.addEventListener("focus", () => {
        hidePickupSuggestions();
        if (!passengerDestinationLocked && !dropInput.readOnly) {
            showDestinationSuggestions(dropInput, [], fareQuoteBox, fareAmountSpan, false);
        }
    });

    dropInput.addEventListener("input", (event) => {
        if (passengerDestinationLocked || dropInput.readOnly) return;
        cancelCenterMapPick();
        hidePickupSuggestions();

        const query = event.target.value.trim();

        if (destinationSearchTimer) {
            clearTimeout(destinationSearchTimer);
        }

        if (destinationSearchAbortController) {
            destinationSearchAbortController.abort();
            destinationSearchAbortController = null;
        }

        if (query.length < 2) {
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
                showDestinationSuggestions(dropInput, destinations.slice(0, MAX_VISIBLE_SUGGESTIONS), fareQuoteBox, fareAmountSpan);
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
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));
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

function showDestinationSuggestions(dropInput, destinations, fareQuoteBox, fareAmountSpan, showEmptyMessage = true) {
    const suggestions = ensureDestinationSuggestions(dropInput);

    if (!destinations.length) {
        suggestions.innerHTML = `
            <div class="destination-suggestion-empty">
                ${showEmptyMessage ? '<div>No Google result found for this name.</div>' : ''}
                <button id="choose-destination-on-map-btn" class="destination-map-pick-btn" type="button">Select drop on map</button>
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
                <span class="destination-suggestion-pin"><span class="webicon webicon-destination" aria-hidden="true"></span></span>
                <span>
                    <strong class="destination-suggestion-main">${escapeHtml(destination.mainName || destination.name)}</strong>
                    <small class="destination-suggestion-sub">${escapeHtml(destination.fullAddress || "Tripura, India")}</small>
                    <span class="destination-suggestion-meta">
                        <span>${escapeHtml(destination.typeHint || getPlaceTypeHint(destination))}</span>
                    </span>
                </span>
            </button>
        `).join("")}
        <button id="choose-destination-on-map-btn" class="destination-map-pick-btn" type="button">Select drop on map</button>
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

    suggestions.querySelectorAll(".destination-suggestion-item").forEach((item) => {
        item.addEventListener("click", async () => {
            const selected = destinations[Number(item.dataset.index)];
            if (!selected) return;
            await chooseDestination(selected, dropInput, fareQuoteBox, fareAmountSpan);
        });
    });

    suggestions.classList.add("is-visible");
}

async function chooseDestination(destination, dropInput, fareQuoteBox, fareAmountSpan) {
    cancelCenterMapPick();
    dropInput.value = destination.mainName || destination.name;
    hideDestinationSuggestions();
    window.latestFareQuote = null;
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));
    fareAmountSpan.innerText = "Calculating...";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

    const resolved = await resolveGooglePlace(destination);
    if (!resolved) {
        startDestinationMapPick(destination, dropInput, fareQuoteBox, fareAmountSpan);
        return;
    }

    window.selectedDestination = buildSelectedDestination(resolved);
    const fareRendered = await renderDestinationFare(resolved, fareQuoteBox, fareAmountSpan);
    if (!fareRendered) {
        startDestinationMapPick(destination, dropInput, fareQuoteBox, fareAmountSpan);
    }
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

    cancelCenterMapPick();
    hidePickupSuggestions();
    hideDestinationSuggestions();
    window.latestFareQuote = null;
    window.dispatchEvent(new CustomEvent("fare-quote-reset"));
    clearRouteAndDestination();
    fareAmountSpan.innerText = "Move map and confirm drop";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

    destinationMapPickMode = {
        destination,
        dropInput,
        fareQuoteBox,
        fareAmountSpan
    };

    window.mapInstance.panTo({ lat: userLatitude, lng: userLongitude });
    window.mapInstance.setZoom(16);
    showCenterMapPicker("drop");

    dropInput.value = destination.mainName || destination.name || dropInput.value;
}

async function reverseGeocodeLocation(lat, lng) {
    try {
        const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
        const response = await fetch(`/api/google-reverse-geocode?${params.toString()}`, {
            headers: { Accept: "application/json" }
        });
        const data = await response.json().catch(() => ({}));
        return response.ok ? data.result || null : null;
    } catch (error) {
        console.warn("Google reverse geocode for map selection failed:", error);
        return null;
    }
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

    const result = await reverseGeocodeLocation(lat, lng);
    if (result) {
        destination.name = result.name || destination.name;
        destination.mainName = result.name || destination.mainName;
        destination.fullAddress = result.fullAddress || destination.fullAddress;
        destination.placeId = result.placeId || destination.placeId || "";
    }

    hideCenterMapPicker();
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
    const distance = Number(routeDetails?.distanceKm);
    if (!Number.isFinite(distance) || distance < 0) {
        window.latestFareQuote = null;
        window.dispatchEvent(new CustomEvent("fare-quote-reset"));
        fareAmountSpan.innerText = "Road route unavailable";
        fareQuoteBox.classList.remove("d-none");
        fareQuoteBox.classList.add("d-flex");
        return true;
    }

    const billedDistanceKm = Number(distance.toFixed(2));
    const estimatedDurationMinutes = routeDetails?.durationMinutes || Math.max(5, Math.round((distance / 25) * 60));
    const fareQuotedAt = new Date();
    const isNightFare = isNightFareTime(fareQuotedAt);
    const fareOptions = calculateFareOptions(billedDistanceKm, fareQuotedAt);

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
        distance_km: billedDistanceKm,
        duration_minutes: estimatedDurationMinutes,
        fare_quoted_at: fareQuotedAt.toISOString(),
        is_night_fare: isNightFare,
        fare_options: fareOptions
    };

    fareAmountSpan.innerText = "Choose a ride";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

    drawDestinationAndRoute(destination, routeDetails?.routePath || [], {
        distanceKm: routeDetails?.distanceKm,
        durationMinutes: routeDetails?.durationMinutes
    });
    window.dispatchEvent(new CustomEvent("fare-quote-updated", {
        detail: window.latestFareQuote
    }));
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

window.addEventListener("prefill-destination-request", async (event) => {
    const query = event.detail?.query?.trim();
    if (!query || passengerDestinationLocked) return;

    const dropInput = document.getElementById("drop-input");
    const fareQuoteBox = document.getElementById("fare-quote-box");
    const fareAmountSpan = document.getElementById("fare-amount");
    if (!dropInput || !fareQuoteBox || !fareAmountSpan) return;

    dropInput.value = query;
    fareAmountSpan.innerText = "Searching...";
    fareQuoteBox.classList.remove("d-none");
    fareQuoteBox.classList.add("d-flex");

    const destinations = await searchGoogleDestinations(query);
    if (passengerDestinationLocked || dropInput.value.trim() !== query) return;

    if (destinations.length) {
        await chooseDestination(destinations[0], dropInput, fareQuoteBox, fareAmountSpan);
        return;
    }

    resetDestinationFareState(fareQuoteBox);
    showDestinationSuggestions(dropInput, [], fareQuoteBox, fareAmountSpan);
});

window.addEventListener("passenger-destination-lock-changed", (event) => {
    passengerDestinationLocked = Boolean(event.detail?.locked);
    if (!passengerDestinationLocked) return;

    destinationMapPickMode = null;
    pickupMapPickMode = null;
    hideCenterMapPicker();
    if (destinationSearchTimer) {
        clearTimeout(destinationSearchTimer);
        destinationSearchTimer = null;
    }
    if (destinationSearchAbortController) {
        destinationSearchAbortController.abort();
        destinationSearchAbortController = null;
    }
    if (pickupSearchTimer) {
        clearTimeout(pickupSearchTimer);
        pickupSearchTimer = null;
    }
    if (pickupSearchAbortController) {
        pickupSearchAbortController.abort();
        pickupSearchAbortController = null;
    }
    hidePickupSuggestions();
    hideDestinationSuggestions();
});

window.addEventListener("driver-location-updated", handleAssignedDriverLocation);
window.addEventListener("ride-completed-clear-map", clearActiveDriverMarker);
