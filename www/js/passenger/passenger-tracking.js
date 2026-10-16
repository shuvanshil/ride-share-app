import { db } from '../platform/firebase-init.js';
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { hideInitialLoader } from '../shared/loading.js';

const GOOGLE_MAP_SCRIPT_ID = "lu-track-google-maps";
let googleBrowserKey = null;
let map = null;
let driverMarker = null;
let pickupMarker = null;
let dropMarker = null;
let unsubscribe = null;

const STATUS_COPY = {
    accepted: "Driver is on the way to pickup.",
    arrived: "Driver has arrived at pickup.",
    started: "Trip is in progress.",
    en_route: "Trip is in progress.",
    completed: "This trip has ended.",
    cancelled_by_driver: "This trip was cancelled.",
    cancelled_by_passenger: "This trip was cancelled."
};

const ENDED_STATUSES = new Set(["completed", "cancelled_by_driver", "cancelled_by_passenger"]);

function setStatusCardState(state) {
    const statusCard = document.getElementById('track-status-card');
    if (!statusCard) return;
    statusCard.classList.remove('is-live', 'is-ended', 'is-cancelled');
    statusCard.classList.add(state);
}

function getRideIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return (params.get('ride') || '').trim();
}

async function getGoogleBrowserKey() {
    if (googleBrowserKey) return googleBrowserKey;
    const response = await fetch("/api/google-config", { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.browserKey) throw new Error(data.error || "Maps is not configured.");
    googleBrowserKey = data.browserKey;
    return googleBrowserKey;
}

function loadGoogleMaps() {
    return new Promise((resolve, reject) => {
        if (window.google?.maps?.Map) {
            resolve(window.google.maps);
            return;
        }
        getGoogleBrowserKey().then((key) => {
            const script = document.createElement("script");
            script.id = GOOGLE_MAP_SCRIPT_ID;
            script.async = true;
            script.defer = true;
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry`;
            script.onload = () => resolve(window.google.maps);
            script.onerror = reject;
            document.head.appendChild(script);
        }).catch(reject);
    });
}

let passengerUserInteracted = false;

function ensureMap(center) {
    const mapsApi = window.google.maps;
    if (!map) {
        map = new mapsApi.Map(document.getElementById('track-map'), {
            center,
            zoom: 15,
            disableDefaultUI: true,
            zoomControl: true,
        });
        map.addListener('dragstart', () => { passengerUserInteracted = true; });
        map.addListener('zoom_changed', () => { passengerUserInteracted = true; });
    }
    return map;
}

const VEHICLE_MARKER_ASSETS = Object.freeze({
    bike: "/assets/vehicle-markers/bike-marker.png",
    auto: "/assets/vehicle-markers/auto-marker.png",
    cab: "/assets/icons/webicons/driver-car-marker.png"
});

function ensureVehicleMarkerStyles() {
    if (document.getElementById("lu-vehicle-marker-style")) return;
    const style = document.createElement("style");
    style.id = "lu-vehicle-marker-style";
    style.textContent = `
        .rotating-vehicle-marker {
            position: absolute;
            width: 48px;
            height: 48px;
            pointer-events: auto;
            will-change: transform;
        }
        .rotating-vehicle-marker::before {
            content: "";
            position: absolute;
            inset: -8px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(26, 115, 232, 0.32) 0%, rgba(26, 115, 232, 0) 72%);
            opacity: 1;
            animation: vehicle-marker-pulse 1.8s ease-out infinite;
            pointer-events: none;
        }
        .rotating-vehicle-marker img {
            width: 48px;
            height: 48px;
            object-fit: contain;
            transform-origin: 50% 50%;
            filter: drop-shadow(0 3px 6px rgba(15, 23, 42, 0.35));
            user-select: none;
        }
        @keyframes vehicle-marker-pulse {
            0% { transform: scale(0.6); opacity: 0.55; }
            70% { transform: scale(1.6); opacity: 0; }
            100% { transform: scale(1.6); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
}

function normalizeHeading(value) {
    const heading = Number(value);
    return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
}

function shortestHeadingDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function calculateDistanceMeters(pointA, pointB) {
    if (!pointA || !pointB) return Infinity;
    if (window.google?.maps?.geometry?.spherical?.computeDistanceBetween) {
        try {
            const p1 = new window.google.maps.LatLng(Number(pointA.lat), Number(pointA.lng));
            const p2 = new window.google.maps.LatLng(Number(pointB.lat), Number(pointB.lng));
            return window.google.maps.geometry.spherical.computeDistanceBetween(p1, p2);
        } catch (_) {}
    }
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
    const lat1 = Number(from.lat);
    const lng1 = Number(from.lng);
    const lat2 = Number(to.lat);
    const lng2 = Number(to.lng);
    if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
        return null;
    }
    // Reject degenerate zero-distance bearings which falsely yield 0° (Due North)
    if (Math.abs(lat1 - lat2) < 1e-7 && Math.abs(lng1 - lng2) < 1e-7) {
        return null;
    }

    if (window.google?.maps?.geometry?.spherical?.computeHeading) {
        try {
            const p1 = new window.google.maps.LatLng(lat1, lng1);
            const p2 = new window.google.maps.LatLng(lat2, lng2);
            return normalizeHeading(window.google.maps.geometry.spherical.computeHeading(p1, p2));
        } catch (_) {}
    }
    const radLat1 = lat1 * Math.PI / 180;
    const radLat2 = lat2 * Math.PI / 180;
    const deltaLng = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(radLat2);
    const x = Math.cos(radLat1) * Math.sin(radLat2)
        - Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(deltaLng);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

function sphericalInterpolate(from, to, fraction) {
    if (!from || !to) return to || from;
    const t = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (t <= 0) return { lat: from.lat, lng: from.lng };
    if (t >= 1) return { lat: to.lat, lng: to.lng };

    if (window.google?.maps?.geometry?.spherical?.interpolate) {
        try {
            const p1 = new window.google.maps.LatLng(Number(from.lat), Number(from.lng));
            const p2 = new window.google.maps.LatLng(Number(to.lat), Number(to.lng));
            const res = window.google.maps.geometry.spherical.interpolate(p1, p2, t);
            if (res) return { lat: res.lat(), lng: res.lng() };
        } catch (_) {}
    }

    const fromLat = from.lat * Math.PI / 180;
    const fromLng = from.lng * Math.PI / 180;
    const toLat = to.lat * Math.PI / 180;
    const toLng = to.lng * Math.PI / 180;
    const cosFromLat = Math.cos(fromLat);
    const cosToLat = Math.cos(toLat);

    const cosDistance = Math.sin(fromLat) * Math.sin(toLat) +
        cosFromLat * cosToLat * Math.cos(fromLng - toLng);

    const d = Math.acos(Math.max(-1, Math.min(1, cosDistance)));
    if (d < 1e-6) {
        return {
            lat: from.lat + (to.lat - from.lat) * t,
            lng: from.lng + (to.lng - from.lng) * t
        };
    }
    const sinD = Math.sin(d);
    const a = Math.sin((1 - t) * d) / sinD;
    const b = Math.sin(t * d) / sinD;

    const x = a * cosFromLat * Math.cos(fromLng) + b * cosToLat * Math.cos(toLng);
    const y = a * cosFromLat * Math.sin(fromLng) + b * cosToLat * Math.sin(toLng);
    const z = a * Math.sin(fromLat) + b * Math.sin(toLat);

    return {
        lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI,
        lng: Math.atan2(y, x) * 180 / Math.PI
    };
}

function buildRouteAnimationWaypoints(startPosition, targetPosition, routePath, startIndex = -1, targetIndex = -1) {
    if (!Array.isArray(routePath) || routePath.length < 2 || startIndex < 0 || targetIndex < 0) return null;
    if (targetIndex < startIndex || (targetIndex - startIndex) > 80) return null;

    const waypoints = [startPosition];
    for (let i = startIndex + 1; i <= targetIndex; i += 1) {
        const pt = routePath[i];
        if (pt) {
            const prev = waypoints[waypoints.length - 1];
            if (calculateDistanceMeters(prev, pt) >= 1.0) {
                waypoints.push(pt);
            }
        }
    }
    const prev = waypoints[waypoints.length - 1];
    if (calculateDistanceMeters(prev, targetPosition) >= 0.5) {
        waypoints.push(targetPosition);
    }

    const cumulative = [0];
    let totalDistance = 0;
    for (let i = 0; i < waypoints.length - 1; i += 1) {
        const segDist = calculateDistanceMeters(waypoints[i], waypoints[i + 1]);
        totalDistance += segDist;
        cumulative.push(totalDistance);
    }
    if (totalDistance < 0.5) return null;
    return { waypoints, cumulative, totalDistance };
}

function sampleRouteAnimation(routeAnimData, progress) {
    const { waypoints, cumulative, totalDistance } = routeAnimData;
    const targetDist = Math.max(0, Math.min(1, progress)) * totalDistance;

    for (let i = 0; i < cumulative.length - 1; i += 1) {
        const d0 = cumulative[i];
        const d1 = cumulative[i + 1];
        if (targetDist <= d1 || i === cumulative.length - 2) {
            const segDist = d1 - d0;
            const fraction = segDist > 1e-6 ? (targetDist - d0) / segDist : 0;
            const p0 = waypoints[i];
            const p1 = waypoints[i + 1];
            const point = sphericalInterpolate(p0, p1, fraction);
            let heading = calculateBearing(p0, p1);
            if (heading == null && i + 2 < waypoints.length) {
                heading = calculateBearing(p0, waypoints[i + 2]);
            }
            return { point, heading };
        }
    }
    const last = waypoints[waypoints.length - 1];
    return { point: last, heading: null };
}

class RotatingVehicleMarker {
    constructor({ map: markerMap, position, title = "", vehicleType = "auto", heading = null, zIndex = 1000 }) {
        ensureVehicleMarkerStyles();
        this.position = position;
        this.heading = normalizeHeading(heading);
        this.vehicleType = vehicleType;
        this.overlay = new window.google.maps.OverlayView();
        this.element = document.createElement("div");
        this.element.className = "rotating-vehicle-marker";
        this.element.style.zIndex = String(zIndex);
        this.element.title = title;
        this.image = document.createElement("img");
        this.image.alt = title;
        this.image.draggable = false;
        this.element.appendChild(this.image);
        this.setVehicleType(vehicleType);
        this.setHeading(this.heading);

        this.overlay.onAdd = () => this.overlay.getPanes()?.overlayMouseTarget.appendChild(this.element);
        this.overlay.draw = () => this.draw();
        this.overlay.onRemove = () => this.element.remove();
        this.overlay.setMap(markerMap);
    }

    draw() {
        const projection = this.overlay.getProjection();
        if (!projection || !this.position) return;
        const point = projection.fromLatLngToDivPixel(new window.google.maps.LatLng(this.position.lat, this.position.lng));
        if (!point) return;
        this.element.style.transform = `translate(${point.x - 24}px, ${point.y - 24}px)`;
    }

    getPosition() {
        return new window.google.maps.LatLng(this.position.lat, this.position.lng);
    }

    setPosition(position) {
        this.position = position;
        this.draw();
    }

    setHeading(heading) {
        const normalized = normalizeHeading(heading);
        if (normalized == null) return;
        this.heading = normalized;
        this.image.style.transform = `rotate(${normalized}deg)`;
    }

    setVehicleType(vehicleType = "auto") {
        this.vehicleType = vehicleType;
        this.image.src = VEHICLE_MARKER_ASSETS[vehicleType] || VEHICLE_MARKER_ASSETS.auto;
    }

    setMap(markerMap) {
        this.overlay.setMap(markerMap);
    }
}

let trackRoutePolyline = null;
let trackRoutePath = [];
let trackLastPolyline = null;
let driverMarkerAnimation = null;
let lastRenderedDriverLoc = null;
let lastDriverHeading = 0;
let lastRouteMatchIndex = -1;
let trackLastFixAt = 0;
let trackIntervalEma = null;

let trackLastAcceptedEpochMs = 0;
let trackPendingOutlier = null;
let trackLastAcceptedFixAt = null;
const TRACK_MAX_PLAUSIBLE_SPEED_MPS = 45;
const TRACK_OUTLIER_CONFIRM_RADIUS_METERS = 60;

function stopLiveTracking() {
    if (driverMarkerAnimation) {
        cancelAnimationFrame(driverMarkerAnimation);
        driverMarkerAnimation = null;
    }
    if (markers.driver?.setMap) {
        markers.driver.setMap(null);
        delete markers.driver;
    }
    if (trackRoutePolyline?.setMap) {
        trackRoutePolyline.setMap(null);
        trackRoutePolyline = null;
    }
    lastRenderedDriverLoc = null;
    lastDriverHeading = 0;
    lastRouteMatchIndex = -1;
    trackLastPolyline = null;
    trackRoutePath = [];
    trackLastFixAt = 0;
    trackIntervalEma = null;
    trackLastAcceptedEpochMs = 0;
    trackPendingOutlier = null;
    trackLastAcceptedFixAt = null;
}

function getTimestampMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
    if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value > 1e11 ? value : value * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function filterTrackPositionOutlier(rawPosition, nowMs, sourceTimestampEpochMs = 0) {
    if (sourceTimestampEpochMs > 0) {
        if (sourceTimestampEpochMs < trackLastAcceptedEpochMs) {
            return null; // Reject stale out-of-order packet
        }
    }

    if (!lastRenderedDriverLoc) {
        if (sourceTimestampEpochMs > 0) trackLastAcceptedEpochMs = sourceTimestampEpochMs;
        trackLastAcceptedFixAt = nowMs;
        return rawPosition;
    }

    let elapsedSeconds;
    if (sourceTimestampEpochMs > 0 && trackLastAcceptedEpochMs > 0) {
        const deltaSource = (sourceTimestampEpochMs - trackLastAcceptedEpochMs) / 1000;
        elapsedSeconds = deltaSource >= 0.2 ? deltaSource : Math.max(0.5, (nowMs - (trackLastAcceptedFixAt || nowMs)) / 1000);
    } else {
        elapsedSeconds = trackLastAcceptedFixAt
            ? Math.max(0.5, (nowMs - trackLastAcceptedFixAt) / 1000)
            : 3;
    }

    const jumpDistanceMeters = calculateDistanceMeters(lastRenderedDriverLoc, rawPosition);
    const impliedSpeedMps = jumpDistanceMeters / elapsedSeconds;

    if (impliedSpeedMps <= TRACK_MAX_PLAUSIBLE_SPEED_MPS) {
        trackPendingOutlier = null;
        if (sourceTimestampEpochMs > 0) trackLastAcceptedEpochMs = sourceTimestampEpochMs;
        trackLastAcceptedFixAt = nowMs;
        return rawPosition;
    }

    if (trackPendingOutlier
        && calculateDistanceMeters(trackPendingOutlier, rawPosition) <= TRACK_OUTLIER_CONFIRM_RADIUS_METERS) {
        trackPendingOutlier = null;
        if (sourceTimestampEpochMs > 0) trackLastAcceptedEpochMs = sourceTimestampEpochMs;
        trackLastAcceptedFixAt = nowMs;
        return rawPosition;
    }

    trackPendingOutlier = rawPosition;
    return lastRenderedDriverLoc;
}

function snapToTrackRoute(point, path, lastIdx = -1, vehicleHeading = null) {
    if (!point || !Array.isArray(path) || path.length < 2) return { point, heading: null, index: -1 };
    let searchFullRange = lastIdx < 0 || lastIdx >= path.length - 1;
    let windowStart = searchFullRange ? 0 : Math.max(0, lastIdx - 2);
    let windowEnd = searchFullRange ? path.length - 2 : Math.min(path.length - 2, lastIdx + 60);

    if (windowStart > windowEnd) {
        searchFullRange = true;
        windowStart = 0;
        windowEnd = path.length - 2;
    }

    const evaluateCandidate = (currentBest, segIndex, p1, p2) => {
        const segLat = p2.lat - p1.lat;
        const segLng = (p2.lng - p1.lng) * (Math.cos((p1.lat * Math.PI) / 180) || 1);
        const ptLat = point.lat - p1.lat;
        const ptLng = (point.lng - p1.lng) * (Math.cos((p1.lat * Math.PI) / 180) || 1);
        const segLenSq = (segLat * segLat) + (segLng * segLng);
        const frac = segLenSq > 1e-18 ? Math.max(0, Math.min(1, ((ptLat * segLat) + (ptLng * segLng)) / segLenSq)) : 0;
        const proj = { lat: p1.lat + (p2.lat - p1.lat) * frac, lng: p1.lng + (p2.lng - p1.lng) * frac };
        const dist = calculateDistanceMeters(point, proj);
        if (dist > 30) return currentBest;

        const segHeading = calculateBearing(p1, p2);
        const isHeadingAligned = (vehicleHeading != null && segHeading != null)
            ? Math.abs(shortestHeadingDelta(vehicleHeading, segHeading)) <= 90
            : true;

        if (!currentBest) {
            return { index: segIndex, point: proj, dist, heading: segHeading, aligned: isHeadingAligned };
        }
        if (isHeadingAligned && !currentBest.aligned) {
            return { index: segIndex, point: proj, dist, heading: segHeading, aligned: isHeadingAligned };
        }
        if (!isHeadingAligned && currentBest.aligned) {
            return currentBest;
        }
        if (dist < currentBest.dist) {
            return { index: segIndex, point: proj, dist, heading: segHeading, aligned: isHeadingAligned };
        }
        return currentBest;
    };

    let best = null;
    for (let i = windowStart; i <= windowEnd; i++) {
        best = evaluateCandidate(best, i, path[i], path[i + 1]);
    }

    // If windowed search did not find a match within tolerance (e.g. detour or rejoin far ahead), search the entire route
    if (!best && !searchFullRange) {
        for (let i = 0; i <= path.length - 2; i++) {
            best = evaluateCandidate(best, i, path[i], path[i + 1]);
        }
    }

    if (best && best.dist <= 30) {
        lastRouteMatchIndex = best.index;
        return { point: best.point, heading: best.heading, index: best.index };
    }
    return { point, heading: null, index: -1 };
}

function animateDriverMarker(rawTarget, heading = null, vehicleType = "auto", speed = null) {
    if (!map || !rawTarget || !window.google?.maps) return;
    const now0 = performance.now();
    const prevMatchIndex = lastRouteMatchIndex;
    const isMoving = speed != null ? speed >= 0.8 : true;
    const candidateHeading = isMoving ? (normalizeHeading(heading) ?? lastDriverHeading) : null;
    const snapResult = snapToTrackRoute(rawTarget, trackRoutePath, lastRouteMatchIndex, candidateHeading);
    const targetPosition = snapResult.point;
    const effectiveHeading = snapResult.heading ?? candidateHeading ?? lastDriverHeading;

    if (driverMarkerAnimation) {
        cancelAnimationFrame(driverMarkerAnimation);
        driverMarkerAnimation = null;
    }

    if (!markers.driver) {
        markers.driver = new RotatingVehicleMarker({
            map,
            position: targetPosition,
            title: "Driver",
            vehicleType,
            heading: effectiveHeading,
            zIndex: 1000
        });
        lastRenderedDriverLoc = targetPosition;
        lastDriverHeading = effectiveHeading;
        trackLastFixAt = now0;
        if (!passengerUserInteracted) map.panTo(targetPosition);
        return;
    }

    markers.driver.setVehicleType(vehicleType);

    const start = lastRenderedDriverLoc || (markers.driver.getPosition() ? {
        lat: markers.driver.getPosition().lat(),
        lng: markers.driver.getPosition().lng()
    } : targetPosition);

    const distance = calculateDistanceMeters(start, targetPosition);
    if (distance < 1.0) {
        markers.driver.setPosition(targetPosition);
        if (effectiveHeading != null) {
            markers.driver.setHeading(effectiveHeading);
            lastDriverHeading = effectiveHeading;
        }
        trackLastFixAt = now0;
        return;
    }

    // Adaptive duration via EMA
    const sinceLastFix = trackLastFixAt ? Math.max(150, now0 - trackLastFixAt) : 3000;
    trackIntervalEma = trackIntervalEma ? (trackIntervalEma * 0.65 + sinceLastFix * 0.35) : sinceLastFix;
    const duration = Math.min(5000, Math.max(350, trackIntervalEma));
    trackLastFixAt = now0;

    const initialHeading = normalizeHeading(lastDriverHeading ?? effectiveHeading);
    const routeAnimData = (Array.isArray(trackRoutePath) && trackRoutePath.length >= 2 && prevMatchIndex >= 0 && snapResult.index >= prevMatchIndex)
        ? buildRouteAnimationWaypoints(start, targetPosition, trackRoutePath, prevMatchIndex, snapResult.index)
        : null;

    const startedAt = now0;
    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        let framePosition;
        let segHeading = null;
        if (routeAnimData) {
            const sampled = sampleRouteAnimation(routeAnimData, eased);
            framePosition = sampled.point;
            segHeading = sampled.heading;
        } else {
            framePosition = sphericalInterpolate(start, targetPosition, eased);
        }
        markers.driver.setPosition(framePosition);
        lastRenderedDriverLoc = framePosition;

        let frameHeading = initialHeading;
        const targetH = (segHeading != null) ? segHeading : effectiveHeading;
        if (targetH != null && initialHeading != null) {
            const curDelta = shortestHeadingDelta(initialHeading, targetH);
            frameHeading = normalizeHeading(initialHeading + (curDelta * eased));
            markers.driver.setHeading(frameHeading);
        } else if (targetH != null) {
            frameHeading = targetH;
            markers.driver.setHeading(frameHeading);
        }
        lastDriverHeading = frameHeading;

        if (!passengerUserInteracted && map?.panTo) {
            map.panTo(framePosition);
        }

        if (progress < 1) {
            driverMarkerAnimation = requestAnimationFrame(step);
        } else {
            driverMarkerAnimation = null;
            markers.driver.setPosition(targetPosition);
            lastRenderedDriverLoc = targetPosition;
            lastDriverHeading = targetH ?? frameHeading ?? effectiveHeading ?? lastDriverHeading;
            if (lastDriverHeading != null) {
                markers.driver.setHeading(lastDriverHeading);
            }
        }
    };
    driverMarkerAnimation = requestAnimationFrame(step);
}

function decodeTrackPolyline(encoded = "") {
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

function updateMarker(refHolder, key, position, options) {
    if (!position) {
        if (refHolder[key]?.setMap) {
            refHolder[key].setMap(null);
            delete refHolder[key];
        }
        return;
    }
    const mapsApi = window.google.maps;
    if (!refHolder[key]) {
        refHolder[key] = new mapsApi.Marker({ map, position, ...options });
    } else {
        refHolder[key].setPosition(position);
    }
}

const markers = {};

function renderSnapshot(data) {
    const statusTitle = document.getElementById('track-status-title');
    const statusCopy = document.getElementById('track-status-copy');
    const detailsCard = document.getElementById('track-details-card');

    const status = data.status || "";
    statusTitle.innerText = STATUS_COPY[status] ? "Trip in progress" : "Trip status";
    statusCopy.innerText = STATUS_COPY[status] || "Waiting for the latest trip update...";

    if (status === "cancelled_by_driver" || status === "cancelled_by_passenger") {
        setStatusCardState('is-cancelled');
    } else if (ENDED_STATUSES.has(status)) {
        setStatusCardState('is-ended');
    } else {
        setStatusCardState('is-live');
    }

    if (ENDED_STATUSES.has(status)) {
        stopLiveTracking();
    }

    document.getElementById('track-driver-name').innerText = data.driver_name || "Assigned driver";
    document.getElementById('track-vehicle').innerText = [data.vehicle_model, data.vehicle_number].filter(Boolean).join(" · ") || "—";
    document.getElementById('track-pickup').innerText = data.pickup_name || "—";
    document.getElementById('track-drop').innerText = data.drop_name || "—";
    detailsCard.classList.remove('d-none');

    const driverLoc = data.driverLocation;
    const isPickedUp = ["started", "en_route", "completed"].includes(status);
    const pickup = (!isPickedUp && data.pickup_lat && data.pickup_lng) ? { lat: data.pickup_lat, lng: data.pickup_lng } : null;
    const drop = (data.drop_lat && data.drop_lng) ? { lat: data.drop_lat, lng: data.drop_lng } : null;
    const center = driverLoc || pickup || drop;
    ensureMap(center);
    updateMarker(markers, 'pickup', pickup, { title: "Pickup", label: "P" });
    if (drop) updateMarker(markers, 'drop', drop, { title: "Destination", label: "X" });

    const isShareRide = data.rideType === "share" && Boolean(data.parentTripId || data.sharedInfo?.parentTripId);
    const shared = isShareRide ? data.sharedInfo : null;
    if (shared?.nextPickup && Number.isFinite(Number(shared.nextPickup.lat)) && Number.isFinite(Number(shared.nextPickup.lng))) {
        updateMarker(markers, 'nextPickup', { lat: Number(shared.nextPickup.lat), lng: Number(shared.nextPickup.lng) }, { title: "Next pickup", label: "N" });
    } else {
        updateMarker(markers, 'nextPickup', null);
    }

    const polylineString = data.routePolyline || data.route_polyline || shared?.routePolyline;
    if (polylineString && (!trackRoutePolyline || trackLastPolyline !== polylineString)) {
        trackLastPolyline = polylineString;
        lastRouteMatchIndex = -1;
        const path = decodeTrackPolyline(polylineString);
        if (path.length >= 2) {
            trackRoutePath = path;
            const oldPolyline = trackRoutePolyline;
            trackRoutePolyline = new window.google.maps.Polyline({
                map,
                path,
                strokeColor: "#16723a",
                strokeOpacity: 0.95,
                strokeWeight: 5,
                zIndex: 500
            });
            if (oldPolyline?.setMap) {
                oldPolyline.setMap(null);
            }
        }
    }

    function inferVehicleType(d) {
        const text = [d.vehicle_type, d.vehicleType, d.vehicle_model, d.vehicleModel].filter(Boolean).join(" ").toLowerCase();
        if (text.includes("bike") || text.includes("motorcycle") || text.includes("scooter")) return "bike";
        if (text.includes("auto") || text.includes("rickshaw") || text.includes("tuk")) return "auto";
        return "cab";
    }

    if (driverLoc && !ENDED_STATUSES.has(status)) {
        const sourceTimestamp = getTimestampMs(
            data.driverLocationUpdatedAt
            || data.lastLocationAt
            || data.updatedAt
            || driverLoc.updatedAt
            || driverLoc.timestamp
        );
        const nowMs = performance.now();
        const filteredLoc = filterTrackPositionOutlier(driverLoc, nowMs, sourceTimestamp);
        if (filteredLoc) {
            const vehicleType = inferVehicleType(data);
            const rawSpeed = data.driverSpeed ?? driverLoc.driverSpeed;
            const speed = (rawSpeed != null && rawSpeed !== "" && !isNaN(Number(rawSpeed))) ? Number(rawSpeed) : null;
            animateDriverMarker(filteredLoc, data.driverHeading || driverLoc.driverHeading || null, vehicleType, speed);
        }
    }
}


function showNotFound() {
    setStatusCardState('is-ended');
    document.getElementById('track-status-title').innerText = "Trip not found";
    document.getElementById('track-status-copy').innerText = "This trip has ended, or the passenger has turned off live sharing.";
    document.getElementById('track-map').classList.add('d-none');
}

async function start() {
    const rideId = getRideIdFromUrl();
    if (!rideId) {
        showNotFound();
        hideInitialLoader();
        return;
    }

    try {
        await loadGoogleMaps();
    } catch (error) {
        console.warn("Could not load Google Maps:", error);
    }

    unsubscribe = onSnapshot(
        doc(db, "tripShareView", rideId),
        (snap) => {
            if (!snap.exists()) {
                showNotFound();
                hideInitialLoader();
                return;
            }
            renderSnapshot(snap.data());
            hideInitialLoader();
        },
        (error) => {
            console.error("Trip share listener error:", error);
            showNotFound();
            hideInitialLoader();
        }
    );
}

window.addEventListener('beforeunload', () => {
    if (unsubscribe) unsubscribe();
});

start();
