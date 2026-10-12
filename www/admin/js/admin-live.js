/**
 * Real-time Firestore listeners & Centralized Map and Ride-Location System
 * for the LiphtUp Admin Console.
 *
 * Provides:
 *  - Real-time activity feed listeners (`startLiveFeed`, `stopLiveFeed`)
 *  - Centralized map & ride-location service (`renderRideMap`, `renderLiveModalMap`,
 *    `stopLiveModalTracking`, `normalizeRideLocationData`, `fetchRoadRouteGeometry`)
 *    used across Live Ride "View on Map", Ride Details, SOS Incident Details,
 *    and Safety Report Details.
 */

import { db } from "../../js/platform/firebase-init.js";
import {
    collection,
    doc,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const ACTIVE_STATUSES = [
    "pending",
    "searching",
    "requested",
    "accepted",
    "arrived",
    "started",
    "in_progress",
    "en_route",
    "to_pickup",
];

const POST_PICKUP_STATUSES = new Set([
    "started",
    "in_progress",
    "en_route",
    "completed",
]);

const PRE_PICKUP_STATUSES = new Set([
    "pending",
    "searching",
    "requested",
    "accepted",
    "arrived",
    "to_pickup",
    "finding riders",
    "finding_riders",
]);

let unsubscribers = [];
let googleMapsPromise = null;
const roadRouteCache = new Map();

// ---------------------------------------------------------------------------
// Coordinate & Pickup State Validation Helpers
// ---------------------------------------------------------------------------

export function isValidCoord(lat, lng) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
    if (la === 0 && ln === 0) return false;
    return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

export function isPassengerPickedUp(rideOrSnapshot = {}) {
    if (!rideOrSnapshot || typeof rideOrSnapshot !== "object") return false;
    if (
        rideOrSnapshot.pin_verified === true ||
        rideOrSnapshot.pinVerified === true ||
        Boolean(rideOrSnapshot.pinVerifiedAt)
    ) {
        return true;
    }
    const rawStatus = String(
        rideOrSnapshot.ride_status ||
            rideOrSnapshot.rawStatus ||
            rideOrSnapshot.status ||
            ""
    )
        .trim()
        .toLowerCase();
    if (POST_PICKUP_STATUSES.has(rawStatus)) return true;
    if (PRE_PICKUP_STATUSES.has(rawStatus)) return false;

    const startedVal = rideOrSnapshot.startedAt;
    if (startedVal && typeof startedVal !== "boolean") {
        const sStr = String(startedVal).trim();
        // Ignore formatted UI clock labels like "10:15 AM" or "--" from hierarchy rows
        if (sStr && sStr !== "--" && !/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(sStr)) {
            return true;
        }
    }
    return false;
}

/**
 * Normalizes coordinates from a ride, hierarchy item, SOS alert, or safety report
 * without ever substituting pickup or driver coordinates for the destination.
 */
export function normalizeRideLocationData(source = {}, options = {}) {
    const snap = source.location_snapshot || source.locationSnapshot || {};
    const route = source.route || {};
    const drvLoc = source.driverLocation || (source.ride && source.ride.driverLocation) || {};
    const paxLoc = source.passengerLocation || (source.ride && source.ride.passengerLocation) || {};
    const incidentLoc = source.location || {};

    const pickLat =
        snap.pickup_lat ??
        source.pickup_lat ??
        route.pickup_lat ??
        (source.ride && source.ride.pickup_lat) ??
        null;
    const pickLng =
        snap.pickup_lng ??
        source.pickup_lng ??
        route.pickup_lng ??
        (source.ride && source.ride.pickup_lng) ??
        null;

    // Destination MUST come strictly from drop/destination fields — never fallback to pickup or driver
    const dropLat =
        snap.drop_lat ??
        source.drop_lat ??
        route.drop_lat ??
        source.destination_lat ??
        (source.ride && source.ride.drop_lat) ??
        null;
    const dropLng =
        snap.drop_lng ??
        source.drop_lng ??
        route.drop_lng ??
        source.destination_lng ??
        (source.ride && source.ride.drop_lng) ??
        null;

    const drvLat =
        options.driverLat ??
        snap.driver_lat ??
        drvLoc.lat ??
        source.driver_lat ??
        (String(source.reporter_role || "").toLowerCase() === "driver" ? incidentLoc.lat : null) ??
        null;
    const drvLng =
        options.driverLng ??
        snap.driver_lng ??
        drvLoc.lng ??
        source.driver_lng ??
        (String(source.reporter_role || "").toLowerCase() === "driver" ? incidentLoc.lng : null) ??
        null;

    const paxLat =
        options.passengerLat ??
        snap.passenger_lat ??
        paxLoc.lat ??
        source.passenger_lat ??
        (String(source.reporter_role || "").toLowerCase() === "passenger" ? incidentLoc.lat : null) ??
        pickLat;
    const paxLng =
        options.passengerLng ??
        snap.passenger_lng ??
        paxLoc.lng ??
        source.passenger_lng ??
        (String(source.reporter_role || "").toLowerCase() === "passenger" ? incidentLoc.lng : null) ??
        pickLng;

    const incLat = incidentLoc.lat ?? snap.incident_lat ?? source.lat ?? null;
    const incLng = incidentLoc.lng ?? snap.incident_lng ?? source.lng ?? null;

    const vehicleType = String(
        source.vehicle_type ||
            source.vehicleType ||
            snap.vehicle_type ||
            (source.ride && (source.ride.vehicle_type || source.ride.vehicleType)) ||
            "auto"
    )
        .trim()
        .toLowerCase();

    const pickedUp = isPassengerPickedUp(
        Object.keys(snap).length ? { ...source, ...snap } : source
    );

    const pickup = isValidCoord(pickLat, pickLng)
        ? { lat: Number(pickLat), lng: Number(pickLng), name: source.pickup_name || route.pickup || "Pickup" }
        : null;
    const destination = isValidCoord(dropLat, dropLng)
        ? { lat: Number(dropLat), lng: Number(dropLng), name: source.drop_name || route.drop || "Destination" }
        : null;
    const driver = isValidCoord(drvLat, drvLng)
        ? { lat: Number(drvLat), lng: Number(drvLng) }
        : null;
    const passenger = isValidCoord(paxLat, paxLng)
        ? { lat: Number(paxLat), lng: Number(paxLng) }
        : pickup
        ? { lat: pickup.lat, lng: pickup.lng }
        : null;
    const incident = isValidCoord(incLat, incLng)
        ? { lat: Number(incLat), lng: Number(incLng) }
        : null;

    return {
        pickup,
        destination,
        driver,
        passenger,
        incident,
        vehicleType,
        pickedUp,
        status: String(
            snap.ride_status ||
                source.ride_status ||
                source.rawStatus ||
                source.status ||
                "active"
        ),
        pickupName: source.pickup_name || route.pickup || (source.ride && source.ride.pickup_name) || "Pickup",
        dropName: source.drop_name || route.drop || (source.ride && source.ride.drop_name) || "Destination",
    };
}

// ---------------------------------------------------------------------------
// Marker SVG Icons (Driver Circular Vehicle Icon, Passenger Pin, Destination Flag)
// ---------------------------------------------------------------------------

export function getVehicleInnerSvg(vehicleType = "auto", color = "#ffffff") {
    const vt = String(vehicleType || "auto").toLowerCase();
    if (vt.includes("bike") || vt.includes("scooty") || vt.includes("two") || vt.includes("moto")) {
        // Two-wheeler motorbike/scooty icon
        return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6.5" cy="16.5" r="3"/>
            <circle cx="17.5" cy="16.5" r="3"/>
            <path d="M10 16.5h3.5l2-5.5h-4.5l-2 2.5"/>
            <path d="M13.5 8h2.5l1.5 3"/>
            <path d="M6.5 16.5l2.5-5.5h3"/>
        </g>`;
    }
    if (vt.includes("car") || vt.includes("cab") || vt.includes("sedan") || vt.includes("suv")) {
        // Four-wheeler car icon
        return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16"/>
            <rect x="3.5" y="13" width="17" height="4.5" rx="1.5"/>
            <circle cx="7" cy="17.5" r="1.5" fill="${color}"/>
            <circle cx="17" cy="17.5" r="1.5" fill="${color}"/>
        </g>`;
    }
    // Auto-rickshaw (3-wheeler canopy silhouette)
    return `<g fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 15V9.5A2.5 2.5 0 0 1 7.5 7h7l3.5 4.5V15H5z"/>
        <path d="M11.5 7v8"/>
        <circle cx="7.5" cy="16.5" r="2" fill="${color}"/>
        <circle cx="16.5" cy="16.5" r="2" fill="${color}"/>
        <path d="M4 12h2"/>
    </g>`;
}

export function buildDriverMarkerDataUrl(vehicleType = "auto", unifiedWithPassenger = false) {
    const badgeRing = unifiedWithPassenger
        ? `<circle cx="33" cy="9" r="6" fill="#16a34a" stroke="#ffffff" stroke-width="1.8"/>
           <circle cx="33" cy="9" r="2.2" fill="#ffffff"/>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="18" fill="#2563eb" fill-opacity="0.18"/>
        <circle cx="21" cy="21" r="14.5" fill="#2563eb" stroke="#ffffff" stroke-width="2.5"/>
        <g transform="translate(9, 8.5)">
            ${getVehicleInnerSvg(vehicleType, "#ffffff")}
        </g>
        ${badgeRing}
    </svg>`;
    return `data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`;
}

export function buildPassengerPinDataUrl() {
    // Distinct pin-shaped marker (emerald/teal pin with white passenger silhouette)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="46" viewBox="0 0 38 46">
        <path d="M19 2C10.7 2 4 8.7 4 17c0 10.6 15 26 15 26s15-15.4 15-26c0-8.3-6.7-15-15-15z" fill="#0d9488" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="19" cy="14" r="3.6" fill="#ffffff"/>
        <path d="M12.5 23c0-3.2 2.9-5.2 6.5-5.2s6.5 2 6.5 5.2" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round"/>
    </svg>`;
    return `data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`;
}

export function buildDestinationPinDataUrl() {
    // Distinct crimson pin with checkered/flag icon inside
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="46" viewBox="0 0 38 46">
        <path d="M19 2C10.7 2 4 8.7 4 17c0 10.6 15 26 15 26s15-15.4 15-26c0-8.3-6.7-15-15-15z" fill="#dc2626" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M14 10v13M14 10h9l-2 4 2 4h-9" fill="#ffffff" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return `data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------------------
// Road-Following Route Geometry (Google Directions / Backend / OSRM)
// ---------------------------------------------------------------------------

export function decodeGooglePolyline(encoded) {
    if (!encoded || typeof encoded !== "string") return [];
    const points = [];
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;

    while (index < len) {
        let b;
        let shift = 0;
        let result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20 && index <= len);
        const dlat = result & 1 ? ~(result >> 1) : result >> 1;
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20 && index <= len);
        const dlng = result & 1 ? ~(result >> 1) : result >> 1;
        lng += dlng;

        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
}

export async function fetchRoadRouteGeometry(origin, destination) {
    if (!origin || !destination || !isValidCoord(origin.lat, origin.lng) || !isValidCoord(destination.lat, destination.lng)) {
        return null;
    }
    const cacheKey = `${Number(origin.lat).toFixed(4)},${Number(origin.lng).toFixed(4)}->${Number(destination.lat).toFixed(4)},${Number(destination.lng).toFixed(4)}`;
    if (roadRouteCache.has(cacheKey)) {
        return roadRouteCache.get(cacheKey);
    }

    // 1. Try Google Maps DirectionsService if available in browser
    if (window.google?.maps?.DirectionsService) {
        try {
            const svc = new window.google.maps.DirectionsService();
            const dirResult = await new Promise((resolve, reject) => {
                svc.route(
                    {
                        origin: { lat: Number(origin.lat), lng: Number(origin.lng) },
                        destination: { lat: Number(destination.lat), lng: Number(destination.lng) },
                        travelMode: window.google.maps.TravelMode.DRIVING,
                    },
                    (res, status) => {
                        if (status === "OK" && res?.routes?.[0]) resolve(res);
                        else reject(new Error(status || "Directions failed"));
                    }
                );
            });
            const route = dirResult.routes[0];
            const leg = route.legs?.[0];
            const path = (route.overview_path || []).map((p) => ({
                lat: typeof p.lat === "function" ? p.lat() : p.lat,
                lng: typeof p.lng === "function" ? p.lng() : p.lng,
            }));
            if (path.length >= 2) {
                const distanceKm = leg?.distance?.value ? Number((leg.distance.value / 1000).toFixed(2)) : null;
                const durationMinutes = leg?.duration?.value ? Math.max(1, Math.round(leg.duration.value / 60)) : null;
                const out = {
                    path,
                    distanceKm,
                    durationMinutes,
                    distanceText: leg?.distance?.text || (distanceKm != null ? `${distanceKm} km` : null),
                    durationText: leg?.duration?.text || (durationMinutes != null ? `~${durationMinutes} min` : null),
                    directionsResult: dirResult,
                    provider: "google_js",
                };
                roadRouteCache.set(cacheKey, out);
                return out;
            }
        } catch (_err) {
            // Fall through to backend /api/google-route or OSRM
        }
    }

    // 2. Try backend /api/google-route
    try {
        const params = new URLSearchParams({
            originLat: String(origin.lat),
            originLng: String(origin.lng),
            destinationLat: String(destination.lat),
            destinationLng: String(destination.lng),
        });
        const resp = await fetch(`/api/google-route?${params.toString()}`);
        if (resp.ok) {
            const data = await resp.json();
            const decoded = decodeGooglePolyline(data.encodedPolyline);
            if (decoded.length >= 2) {
                const distanceKm = data.distanceKm ?? null;
                const durationMinutes = data.durationMinutes ?? null;
                const out = {
                    path: decoded,
                    distanceKm,
                    durationMinutes,
                    distanceText: data.distanceText || (distanceKm != null ? `${distanceKm} km` : null),
                    durationText: data.durationText || (durationMinutes != null ? `~${durationMinutes} min` : null),
                    provider: "google_backend",
                };
                roadRouteCache.set(cacheKey, out);
                return out;
            }
        }
    } catch (_err) {
        // Fall through to OSRM road router
    }

    // 3. Try OSRM road routing service for road-aligned geometry
    try {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${Number(origin.lng)},${Number(origin.lat)};${Number(destination.lng)},${Number(destination.lat)}?overview=full&geometries=geojson`;
        const resp = await fetch(osrmUrl);
        if (resp.ok) {
            const data = await resp.json();
            const coords = data?.routes?.[0]?.geometry?.coordinates;
            if (Array.isArray(coords) && coords.length >= 2) {
                const path = coords.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
                const distM = data.routes[0].distance;
                const durS = data.routes[0].duration;
                const distanceKm = Number.isFinite(distM) ? Number((distM / 1000).toFixed(2)) : null;
                const durationMinutes = Number.isFinite(durS) ? Math.max(1, Math.round(durS / 60)) : null;
                const out = {
                    path,
                    distanceKm,
                    durationMinutes,
                    distanceText: distanceKm != null ? `${distanceKm} km` : null,
                    durationText: durationMinutes != null ? `~${durationMinutes} min` : null,
                    provider: "osrm",
                };
                roadRouteCache.set(cacheKey, out);
                return out;
            }
        }
    } catch (_err) {
        // Ignore network errors
    }

    return null;
}

// ---------------------------------------------------------------------------
// Real-time Activity Feed Listeners
// ---------------------------------------------------------------------------

export function startLiveFeed(onEvent, onError) {
    stopLiveFeed();
    let initialRidesLoaded = false;
    let initialSosLoaded = false;
    let initialDriversLoaded = false;

    try {
        const ridesQ = query(
            collection(db, "rides"),
            where("status", "in", ACTIVE_STATUSES),
            limit(50)
        );
        unsubscribers.push(
            onSnapshot(
                ridesQ,
                (snap) => {
                    if (!initialRidesLoaded) {
                        initialRidesLoaded = true;
                        return;
                    }
                    snap.docChanges().forEach((change) => {
                        const data = change.doc.data() || {};
                        const shortId = `#LP${String(change.doc.id).slice(-5).toUpperCase()}`;
                        const pax = data.passenger_name || "Passenger";
                        const drv = data.driver_name || "driver";
                        let text = `Ride ${shortId} (${change.type}): ${data.status || ""}`;
                        let type = "ride";
                        let color = "primary";
                        let icon = "ti-car";
                        if (change.type === "added") {
                            text = `New ride request ${shortId} by ${pax}`;
                            type = "ride_requested";
                            color = "primary";
                            icon = "ti-map-pin";
                        } else if (data.status === "accepted" || data.status === "started" || data.status === "en_route") {
                            text = `Ride ${shortId} ${data.status === "accepted" ? `assigned to ${drv}` : "in progress"}`;
                            type = "ride_assigned";
                            color = "info";
                            icon = "ti-car";
                        }
                        onEvent({
                            id: `live_ride_${change.doc.id}_${change.type}_${data.status}`,
                            type,
                            category: "ride",
                            color,
                            icon,
                            text,
                            at: Date.now(),
                            timestampMs: Date.now(),
                            targetType: "ride",
                            targetId: change.doc.id,
                            section: "live-rides",
                        });
                    });
                },
                (err) => onError && onError(`Live rides listener error: ${err.message}`)
            )
        );
    } catch (err) {
        if (onError) onError(`Could not subscribe to rides: ${err.message}`);
    }

    try {
        const sosQ = query(
            collection(db, "sosAlerts"),
            where("status", "==", "open"),
            orderBy("createdAt", "desc"),
            limit(20)
        );
        unsubscribers.push(
            onSnapshot(
                sosQ,
                (snap) => {
                    if (!initialSosLoaded) {
                        initialSosLoaded = true;
                        return;
                    }
                    snap.docChanges().forEach((change) => {
                        if (change.type === "added") {
                            const data = change.doc.data() || {};
                            onEvent({
                                id: `live_sos_${change.doc.id}`,
                                type: "sos_alert",
                                category: "safety",
                                color: "danger",
                                icon: "ti-alert-triangle",
                                text: `SOS alert raised by ${data.reporter_name || data.passenger_name || data.reporter_role || "rider"}`,
                                at: Date.now(),
                                timestampMs: Date.now(),
                                targetType: "sos",
                                targetId: change.doc.id,
                                section: "safety",
                            });
                        }
                    });
                },
                (err) => onError && onError(`SOS listener error: ${err.message}`)
            )
        );
    } catch (err) {
        if (onError) onError(`Could not subscribe to SOS alerts: ${err.message}`);
    }

    try {
        const driversQ = query(
            collection(db, "users"),
            where("role", "==", "driver"),
            where("verificationStatus", "==", "pending_review"),
            limit(25)
        );
        unsubscribers.push(
            onSnapshot(
                driversQ,
                (snap) => {
                    if (!initialDriversLoaded) {
                        initialDriversLoaded = true;
                        return;
                    }
                    snap.docChanges().forEach((change) => {
                        if (change.type === "added") {
                            const data = change.doc.data() || {};
                            onEvent({
                                id: `live_drv_reg_${change.doc.id}`,
                                type: "driver_registered",
                                category: "driver",
                                color: "primary",
                                icon: "ti-steering-wheel",
                                text: `New driver registration: ${data.name || data.phone || change.doc.id}`,
                                at: Date.now(),
                                timestampMs: Date.now(),
                                targetType: "driver",
                                targetId: change.doc.id,
                                section: "drivers",
                            });
                        }
                    });
                },
                (err) => onError && onError(`Drivers listener error: ${err.message}`)
            )
        );
    } catch (err) {
        if (onError) onError(`Could not subscribe to drivers: ${err.message}`);
    }
}

export function stopLiveFeed() {
    unsubscribers.forEach((fn) => {
        try {
            fn();
        } catch (_e) {
            // ignore
        }
    });
    unsubscribers = [];
}

// ---------------------------------------------------------------------------
// Google Maps loader + Centralized Ride Map Rendering
// ---------------------------------------------------------------------------

export function loadGoogleMapsOnce() {
    if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
    if (googleMapsPromise) return googleMapsPromise;

    googleMapsPromise = (async () => {
        const res = await fetch("/api/google-config");
        if (!res.ok) throw new Error("Could not load Google Maps config.");
        const { browserKey } = await res.json();
        if (!browserKey) throw new Error("Missing Google Maps browser key.");
        await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserKey)}`;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error("Failed to load Google Maps script."));
            document.head.appendChild(script);
        });
        return window.google.maps;
    })().catch((err) => {
        googleMapsPromise = null;
        throw err;
    });

    return googleMapsPromise;
}

/**
 * Renders an interactive SVG/Coordinate map with road-aligned route geometry,
 * circular blue driver vehicle marker, pin-shaped passenger marker (when pre-pickup),
 * and crimson destination flag marker when Google Maps JS API is unavailable.
 */
function renderInteractiveFallbackMap(container, locState, roadGeometry, options = {}) {
    if (!container) return;

    const points = [];
    if (locState.pickup) points.push({ ...locState.pickup, role: "pickup" });
    if (locState.destination) points.push({ ...locState.destination, role: "destination" });
    if (locState.driver) points.push({ ...locState.driver, role: "driver" });
    if (!locState.pickedUp && locState.passenger) points.push({ ...locState.passenger, role: "passenger" });
    if (options.isSnapshot && locState.incident) points.push({ ...locState.incident, role: "incident" });
    const routePath = roadGeometry?.path || [];
    routePath.forEach((p) => {
        if (isValidCoord(p.lat, p.lng)) points.push({ lat: p.lat, lng: p.lng, role: "path" });
    });

    if (points.length === 0) {
        container.innerHTML = `<div class="d-flex flex-column align-items-center justify-content-center h-100 p-4 text-secondary small bg-light rounded">
            <i class="ti ti-map-off fs-1 mb-2 text-muted"></i>
            <div>Location coordinates were not recorded for this record.</div>
        </div>`;
        return;
    }

    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latSpan = Math.max(0.004, (maxLat - minLat) * 1.35);
    const lngSpan = Math.max(0.004, (maxLng - minLng) * 1.35);
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;

    const width = 640;
    const height = 300;
    const project = (pt) => {
        const x = ((pt.lng - (centerLng - lngSpan / 2)) / lngSpan) * (width - 96) + 48;
        const y = ((centerLat + latSpan / 2 - pt.lat) / latSpan) * (height - 76) + 38;
        return {
            x: Math.max(32, Math.min(width - 32, Number(x.toFixed(1)))),
            y: Math.max(28, Math.min(height - 28, Number(y.toFixed(1)))),
        };
    };

    let roadPathSvg = "";
    const activeOrigin = locState.pickedUp
        ? locState.driver || locState.pickup
        : locState.pickup || locState.passenger || locState.driver;
    const activeDest = locState.destination;

    const polyPoints =
        routePath.length >= 2
            ? routePath.map(project)
            : activeOrigin && activeDest
            ? [project(activeOrigin), project(activeDest)]
            : [];

    if (polyPoints.length >= 2) {
        const dStr = polyPoints
            .map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x},${pt.y}`)
            .join(" ");
        roadPathSvg = `
            <path d="${dStr}" fill="none" stroke="#1e40af" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>
            <path d="${dStr}" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        `;
    }

    // Pre-pickup driver-to-passenger approach line if both exist and not picked up
    let approachSvg = "";
    if (!locState.pickedUp && locState.driver && locState.passenger) {
        const dp = project(locState.driver);
        const pp = project(locState.passenger);
        approachSvg = `<line x1="${dp.x}" y1="${dp.y}" x2="${pp.x}" y2="${pp.y}" stroke="#0d9488" stroke-width="2.5" stroke-dasharray="5,5" opacity="0.85"/>`;
    }

    // Destination flag marker
    let destMarkerSvg = "";
    if (locState.destination) {
        const dp = project(locState.destination);
        destMarkerSvg = `
            <g transform="translate(${dp.x}, ${dp.y})">
                <title>Destination: ${locState.dropName} (${locState.destination.lat.toFixed(4)}, ${locState.destination.lng.toFixed(4)})</title>
                <path d="M0 -28 C-7.5 -28 -13.5 -22 -13.5 -14.5 C-13.5 -5 0 4 0 4 C0 4 13.5 -5 13.5 -14.5 C13.5 -22 7.5 -28 0 -28 Z" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
                <path d="M-4 -20 V-10 M-4 -20 H4 L2.2 -17 L4 -14 H-4" fill="#ffffff" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <text x="0" y="16" text-anchor="middle" fill="#991b1b" font-size="10" font-weight="700">Destination</text>
            </g>
        `;
    }

    // Passenger pin marker (ONLY shown before passenger pickup & PIN verification)
    let paxMarkerSvg = "";
    if (!locState.pickedUp && locState.passenger) {
        const pp = project(locState.passenger);
        paxMarkerSvg = `
            <g transform="translate(${pp.x}, ${pp.y})">
                <title>Passenger Pin (${locState.passenger.lat.toFixed(4)}, ${locState.passenger.lng.toFixed(4)})</title>
                <path d="M0 -28 C-7.5 -28 -13.5 -22 -13.5 -14.5 C-13.5 -5 0 4 0 4 C0 4 13.5 -5 13.5 -14.5 C13.5 -22 7.5 -28 0 -28 Z" fill="#0d9488" stroke="#ffffff" stroke-width="2"/>
                <circle cx="0" cy="-16.5" r="3" fill="#ffffff"/>
                <path d="M-5 -9.5 C-5 -12.2 -2.5 -13.8 0 -13.8 C2.5 -13.8 5 -12.2 5 -9.5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/>
                <text x="0" y="16" text-anchor="middle" fill="#0f766e" font-size="10" font-weight="700">Passenger</text>
            </g>
        `;
    }

    // Driver circular blue vehicle marker (unified after pickup)
    let drvMarkerSvg = "";
    const drvCoord = locState.driver || (locState.pickedUp ? locState.pickup : null);
    if (drvCoord) {
        const vp = project(drvCoord);
        const label = locState.pickedUp ? "Driver + Passenger (On Trip)" : "Driver";
        drvMarkerSvg = `
            <g transform="translate(${vp.x}, ${vp.y})">
                <title>${label} (${drvCoord.lat.toFixed(4)}, ${drvCoord.lng.toFixed(4)})</title>
                <circle cx="0" cy="0" r="19" fill="#2563eb" fill-opacity="0.18"/>
                <circle cx="0" cy="0" r="14.5" fill="#2563eb" stroke="#ffffff" stroke-width="2.5"/>
                <g transform="translate(-12, -12)">
                    ${getVehicleInnerSvg(locState.vehicleType, "#ffffff")}
                </g>
                ${
                    locState.pickedUp
                        ? `<circle cx="11" cy="-11" r="5.5" fill="#16a34a" stroke="#ffffff" stroke-width="1.5"/>`
                        : ""
                }
                <text x="0" y="26" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="700">${locState.pickedUp ? "On Trip (PIN Verified)" : "Driver"}</text>
            </g>
        `;
    }

    const modeBadge = options.isSnapshot
        ? `<span class="badge bg-amber-lt text-amber fw-semibold"><i class="ti ti-camera me-1"></i>Incident Time Snapshot</span>`
        : `<span class="badge bg-blue-lt text-blue fw-semibold"><i class="ti ti-route me-1"></i>Road Route View</span>`;

    const distBadge =
        roadGeometry?.distanceKm != null
            ? `<span class="badge bg-secondary-lt text-dark">${roadGeometry.distanceKm} km${roadGeometry.durationMinutes ? ` • ~${roadGeometry.durationMinutes} min` : ""}</span>`
            : "";

    container.innerHTML = `
        <div class="position-relative w-100 h-100 d-flex flex-column justify-content-between" style="min-height: 240px; background: linear-gradient(180deg, #f8fafc 0%, #eff6ff 100%); border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
            <div class="d-flex align-items-center justify-content-between px-3 py-2 bg-white border-bottom flex-wrap gap-1" style="z-index: 2;">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                    ${modeBadge}
                    ${distBadge}
                </div>
                <div class="d-flex align-items-center gap-3 small text-secondary" style="font-size: 0.72rem;">
                    <span class="d-inline-flex align-items-center gap-1"><span style="width:10px;height:10px;border-radius:50%;background:#2563eb;display:inline-block;"></span>Driver (${locState.vehicleType.toUpperCase()})</span>
                    ${
                        !locState.pickedUp
                            ? `<span class="d-inline-flex align-items-center gap-1"><span style="width:10px;height:10px;border-radius:2px;background:#0d9488;display:inline-block;"></span>Passenger Pin</span>`
                            : `<span class="d-inline-flex align-items-center gap-1 text-success fw-semibold"><i class="ti ti-shield-check"></i>Picked Up (Unified)</span>`
                    }
                    <span class="d-inline-flex align-items-center gap-1"><span style="width:10px;height:10px;border-radius:2px;background:#dc2626;display:inline-block;"></span>Destination</span>
                </div>
            </div>
            <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 220px; display: block;">
                <defs>
                    <pattern id="map-road-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                        <path d="M 36 0 L 0 0 0 36" fill="none" stroke="#cbd5e1" stroke-width="0.6" stroke-dasharray="2,2"/>
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#map-road-grid)" />
                ${roadPathSvg}
                ${approachSvg}
                ${destMarkerSvg}
                ${paxMarkerSvg}
                ${drvMarkerSvg}
            </svg>
        </div>
    `;
}

/**
 * Centralized map renderer for Ride History Details, SOS Details, and Safety Report Details.
 * @param {HTMLElement} container
 * @param {object} rideOrIncident
 * @param {object} options - { isSnapshot?: boolean }
 */
export async function renderRideMap(container, rideOrIncident, options = {}) {
    if (!container) return;
    const locState = normalizeRideLocationData(rideOrIncident, options);
    const readoutEl = options.readoutEl || null;

    if (!locState.pickup && !locState.destination && !locState.driver && !locState.passenger && !locState.incident) {
        container.innerHTML = `<div class="d-flex flex-column align-items-center justify-content-center h-100 p-3 text-secondary small bg-light rounded border">
            <i class="ti ti-map-pin-off fs-2 mb-1 text-muted"></i>
            <span>Location coordinates not recorded for this trip.</span>
        </div>`;
        if (readoutEl) {
            readoutEl.textContent = options.isSnapshot
                ? "No incident location coordinates recorded."
                : "Location coordinates not recorded for this trip.";
        }
        return;
    }

    const routeOrigin = locState.pickedUp
        ? locState.driver || locState.pickup
        : locState.pickup || locState.passenger || locState.driver;
    const routeDestination = locState.destination;

    let roadGeometry = null;
    if (routeOrigin && routeDestination) {
        roadGeometry = await fetchRoadRouteGeometry(routeOrigin, routeDestination).catch(() => null);
    }

    if (readoutEl) {
        const parts = [];
        if (options.isSnapshot) {
            parts.push("Static Incident Snapshot");
        }
        parts.push(
            locState.pickedUp
                ? `Passenger Onboard (${(locState.vehicleType || "auto").toUpperCase()} • PIN Verified)`
                : "Pre-pickup (Driver & Passenger Separate)"
        );
        const distLabel =
            roadGeometry?.distanceText ||
            (roadGeometry?.distanceKm != null ? `${roadGeometry.distanceKm} km` : null);
        const durLabel =
            roadGeometry?.durationText ||
            (roadGeometry?.durationMinutes != null ? `~${roadGeometry.durationMinutes} min` : null);
        if (distLabel || durLabel) {
            parts.push([distLabel, durLabel].filter(Boolean).join(" • "));
        } else if (locState.destination) {
            parts.push(`${locState.pickupName} → ${locState.dropName}`);
        } else {
            parts.push("Destination coordinates not recorded");
        }
        readoutEl.textContent = parts.join(" · ");
    }

    try {
        const maps = await loadGoogleMapsOnce();
        container.innerHTML = "";
        const centerPt =
            locState.driver ||
            locState.incident ||
            locState.pickup ||
            locState.destination ||
            locState.passenger;

        const map = new maps.Map(container, {
            center: { lat: centerPt.lat, lng: centerPt.lng },
            zoom: 14,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
        });
        const bounds = new maps.LatLngBounds();

        // 1. Render Road Route
        if (roadGeometry?.directionsResult) {
            const renderer = new maps.DirectionsRenderer({
                map,
                directions: roadGeometry.directionsResult,
                suppressMarkers: true,
                preserveViewport: true,
                polylineOptions: {
                    strokeColor: "#2563eb",
                    strokeOpacity: 0.9,
                    strokeWeight: 5,
                },
            });
            void renderer;
            roadGeometry.path.forEach((p) => bounds.extend(p));
        } else if (roadGeometry?.path?.length >= 2) {
            new maps.Polyline({
                path: roadGeometry.path,
                geodesic: true,
                strokeColor: "#2563eb",
                strokeOpacity: 0.9,
                strokeWeight: 5,
                map,
            });
            roadGeometry.path.forEach((p) => bounds.extend(p));
        } else if (routeOrigin && routeDestination) {
            // Try DirectionsService directly now that Google Maps SDK is loaded
            const freshRoad = await fetchRoadRouteGeometry(routeOrigin, routeDestination).catch(() => null);
            if (freshRoad?.path?.length >= 2) {
                new maps.Polyline({
                    path: freshRoad.path,
                    geodesic: true,
                    strokeColor: "#2563eb",
                    strokeOpacity: 0.9,
                    strokeWeight: 5,
                    map,
                });
                freshRoad.path.forEach((p) => bounds.extend(p));
            }
        }

        // 2. Destination Marker (Strictly at actual destination coordinates)
        if (locState.destination) {
            new maps.Marker({
                position: { lat: locState.destination.lat, lng: locState.destination.lng },
                map,
                title: `Destination: ${locState.dropName}`,
                icon: {
                    url: buildDestinationPinDataUrl(),
                    scaledSize: new maps.Size(34, 42),
                    anchor: new maps.Point(17, 40),
                },
            });
            bounds.extend({ lat: locState.destination.lat, lng: locState.destination.lng });
        }

        // 3. Passenger Marker (Pin-shaped, shown ONLY before passenger pickup & PIN verification)
        if (!locState.pickedUp && locState.passenger) {
            new maps.Marker({
                position: { lat: locState.passenger.lat, lng: locState.passenger.lng },
                map,
                title: `Passenger (${locState.pickupName})`,
                icon: {
                    url: buildPassengerPinDataUrl(),
                    scaledSize: new maps.Size(34, 42),
                    anchor: new maps.Point(17, 40),
                },
            });
            bounds.extend({ lat: locState.passenger.lat, lng: locState.passenger.lng });
        }

        // 4. Driver Circular Blue Vehicle Marker (unified after passenger pickup)
        const drvPoint = locState.driver || (locState.pickedUp ? locState.pickup : null);
        if (drvPoint) {
            new maps.Marker({
                position: { lat: drvPoint.lat, lng: drvPoint.lng },
                map,
                title: locState.pickedUp
                    ? `Driver + Passenger (${locState.vehicleType.toUpperCase()} • PIN Verified)`
                    : `Driver (${locState.vehicleType.toUpperCase()})`,
                icon: {
                    url: buildDriverMarkerDataUrl(locState.vehicleType, locState.pickedUp),
                    scaledSize: new maps.Size(40, 40),
                    anchor: new maps.Point(20, 20),
                },
            });
            bounds.extend({ lat: drvPoint.lat, lng: drvPoint.lng });
        }

        if (!bounds.isEmpty()) {
            map.fitBounds(bounds, 44);
        }
    } catch (_err) {
        renderInteractiveFallbackMap(container, locState, roadGeometry, options);
    }
}

// ---------------------------------------------------------------------------
// Live Ride Modal Tracking ("View on Map" button in Live Rides)
// ---------------------------------------------------------------------------

let liveModalRideUnsub = null;
let liveModalDriverUnsub = null;
let liveModalMapInstance = null;
let liveModalDriverMarker = null;
let liveModalPassengerMarker = null;
let liveModalDestMarker = null;
let liveModalRoutePolyline = null;

export function stopLiveModalTracking() {
    if (liveModalRideUnsub) {
        try {
            liveModalRideUnsub();
        } catch (_e) {}
        liveModalRideUnsub = null;
    }
    if (liveModalDriverUnsub) {
        try {
            liveModalDriverUnsub();
        } catch (_e) {}
        liveModalDriverUnsub = null;
    }
    liveModalMapInstance = null;
    liveModalDriverMarker = null;
    liveModalPassengerMarker = null;
    liveModalDestMarker = null;
    liveModalRoutePolyline = null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function renderLiveModalMap(container, rideItem, onTelemetryUpdate) {
    stopLiveModalTracking();
    if (!container || !rideItem) return;

    const rideId = String(rideItem.id || "").trim();
    const driverId = String(rideItem.driver?.id || rideItem.driver_id || "").trim();
    const isParentShare = Boolean(
        rideItem.isShareTripDoc ||
            (rideItem.isParent &&
                rideItem.rideType === "share" &&
                rideItem.childRides?.length &&
                rideItem.childRides[0]?.id !== rideId)
    );

    let latestSource = { ...rideItem };
    let latestDrvLat = null;
    let latestDrvLng = null;
    let latestSpeedKmh = null;

    const updateTelemetryAndMarkers = async () => {
        const locState = normalizeRideLocationData(latestSource, {
            driverLat: latestDrvLat,
            driverLng: latestDrvLng,
        });

        // Calculate telemetry
        let progressText = locState.pickedUp ? "Passenger On Board (PIN Verified)" : "Approaching Pickup";
        if (locState.pickup && locState.destination && locState.driver) {
            const totalKm = Math.max(
                0.2,
                haversineKm(locState.pickup.lat, locState.pickup.lng, locState.destination.lat, locState.destination.lng)
            );
            const remKm = haversineKm(
                locState.driver.lat,
                locState.driver.lng,
                locState.destination.lat,
                locState.destination.lng
            );
            const pct = Math.max(5, Math.min(99, Math.round(((totalKm - remKm) / totalKm) * 100)));
            progressText = `${pct}% (${remKm.toFixed(1)} km to destination)`;
        }
        const speedText =
            latestSpeedKmh !== null && Number.isFinite(latestSpeedKmh) && latestSpeedKmh > 0
                ? `${Math.round(latestSpeedKmh)} km/h`
                : locState.driver
                ? "Live GPS Active"
                : "Awaiting GPS";

        if (typeof onTelemetryUpdate === "function") {
            onTelemetryUpdate(`Status: ${speedText} • Route Progress: ${progressText}`);
        }

        const routeOrigin = locState.pickedUp
            ? locState.driver || locState.pickup
            : locState.pickup || locState.passenger || locState.driver;
        const routeDestination = locState.destination;
        const roadGeometry =
            routeOrigin && routeDestination
                ? await fetchRoadRouteGeometry(routeOrigin, routeDestination).catch(() => null)
                : null;

        if (liveModalMapInstance && window.google?.maps) {
            const maps = window.google.maps;
            const drvPt = locState.driver || (locState.pickedUp ? locState.pickup : null);

            if (drvPt) {
                if (!liveModalDriverMarker) {
                    liveModalDriverMarker = new maps.Marker({
                        position: drvPt,
                        map: liveModalMapInstance,
                        title: locState.pickedUp ? "Driver + Passenger (On Trip)" : "Driver",
                    });
                } else {
                    liveModalDriverMarker.setPosition(drvPt);
                }
                liveModalDriverMarker.setIcon({
                    url: buildDriverMarkerDataUrl(locState.vehicleType, locState.pickedUp),
                    scaledSize: new maps.Size(40, 40),
                    anchor: new maps.Point(20, 20),
                });
            }

            // Hide separate passenger pin once passenger is picked up & PIN verified
            if (locState.pickedUp) {
                if (liveModalPassengerMarker) {
                    liveModalPassengerMarker.setMap(null);
                    liveModalPassengerMarker = null;
                }
            } else if (locState.passenger) {
                if (!liveModalPassengerMarker) {
                    liveModalPassengerMarker = new maps.Marker({
                        position: { lat: locState.passenger.lat, lng: locState.passenger.lng },
                        map: liveModalMapInstance,
                        title: `Passenger (${locState.pickupName})`,
                        icon: {
                            url: buildPassengerPinDataUrl(),
                            scaledSize: new maps.Size(34, 42),
                            anchor: new maps.Point(17, 40),
                        },
                    });
                } else {
                    liveModalPassengerMarker.setPosition({
                        lat: locState.passenger.lat,
                        lng: locState.passenger.lng,
                    });
                }
            }

            if (locState.destination) {
                if (!liveModalDestMarker) {
                    liveModalDestMarker = new maps.Marker({
                        position: { lat: locState.destination.lat, lng: locState.destination.lng },
                        map: liveModalMapInstance,
                        title: `Destination: ${locState.dropName}`,
                        icon: {
                            url: buildDestinationPinDataUrl(),
                            scaledSize: new maps.Size(34, 42),
                            anchor: new maps.Point(17, 40),
                        },
                    });
                } else {
                    liveModalDestMarker.setPosition({
                        lat: locState.destination.lat,
                        lng: locState.destination.lng,
                    });
                }
            }

            if (roadGeometry?.path?.length >= 2) {
                if (!liveModalRoutePolyline) {
                    liveModalRoutePolyline = new maps.Polyline({
                        path: roadGeometry.path,
                        geodesic: true,
                        strokeColor: "#2563eb",
                        strokeOpacity: 0.9,
                        strokeWeight: 5,
                        map: liveModalMapInstance,
                    });
                } else {
                    liveModalRoutePolyline.setPath(roadGeometry.path);
                }
            }
        } else {
            renderInteractiveFallbackMap(container, locState, roadGeometry, { isSnapshot: false });
        }
    };

    try {
        const maps = await loadGoogleMapsOnce();
        container.innerHTML = "";
        const initialLoc = normalizeRideLocationData(latestSource);
        const centerPt =
            initialLoc.driver ||
            initialLoc.pickup ||
            initialLoc.destination ||
            initialLoc.passenger || { lat: 23.8315, lng: 91.2868 };

        liveModalMapInstance = new maps.Map(container, {
            center: { lat: centerPt.lat, lng: centerPt.lng },
            zoom: 14,
            mapTypeControl: false,
            streetViewControl: false,
        });

        await updateTelemetryAndMarkers();

        const bounds = new maps.LatLngBounds();
        [initialLoc.pickup, initialLoc.destination, initialLoc.driver, initialLoc.passenger]
            .filter(Boolean)
            .forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
        if (!bounds.isEmpty()) {
            liveModalMapInstance.fitBounds(bounds, 52);
        }
    } catch (_err) {
        liveModalMapInstance = null;
        await updateTelemetryAndMarkers();
    }

    // Subscribe to real-time Firestore updates for active ride and driver presence
    if (rideId) {
        try {
            const collName = isParentShare ? "shareTrips" : "rides";
            liveModalRideUnsub = onSnapshot(doc(db, collName, rideId), (snap) => {
                if (!snap.exists()) return;
                const d = snap.data() || {};
                latestSource = { ...latestSource, ...d };
                const dl = d.driverLocation || {};
                if (isValidCoord(dl.lat, dl.lng)) {
                    latestDrvLat = Number(dl.lat);
                    latestDrvLng = Number(dl.lng);
                }
                if (typeof dl.speedKmh === "number") latestSpeedKmh = dl.speedKmh;
                updateTelemetryAndMarkers();
            });
        } catch (_e) {}
    }

    if (driverId) {
        try {
            liveModalDriverUnsub = onSnapshot(doc(db, "driverPresence", driverId), (snap) => {
                if (!snap.exists()) return;
                const d = snap.data() || {};
                const loc = d.currentLocation || d.location || {};
                const lat = loc.lat ?? d.lat;
                const lng = loc.lng ?? d.lng;
                if (isValidCoord(lat, lng)) {
                    latestDrvLat = Number(lat);
                    latestDrvLng = Number(lng);
                    if (typeof d.speedKmh === "number") latestSpeedKmh = d.speedKmh;
                    else if (typeof loc.speed === "number") latestSpeedKmh = loc.speed * 3.6;
                    updateTelemetryAndMarkers();
                }
            });
        } catch (_e) {}
    }
}

export function stopTracking() {
    stopLiveModalTracking();
}

export async function trackRideOnMap(container, rideOrId, readoutElOrOpts = null, maybeRide = null) {
    if (!container) return;
    const rideObj =
        maybeRide && typeof maybeRide === "object"
            ? maybeRide
            : rideOrId && typeof rideOrId === "object"
            ? rideOrId
            : { id: String(rideOrId || "") };
    const opts =
        readoutElOrOpts && typeof readoutElOrOpts === "object" && !(readoutElOrOpts instanceof Element)
            ? readoutElOrOpts
            : { isSnapshot: false, readoutEl: readoutElOrOpts };
    return renderRideMap(container, rideObj, opts);
}

let liveRideModalBound = false;

export function closeLiveRideMapModal() {
    stopLiveModalTracking();
    const modalEl = document.getElementById("modal-live-ride-map");
    if (modalEl) {
        modalEl.classList.remove("show");
        modalEl.style.display = "none";
        modalEl.setAttribute("aria-hidden", "true");
    }
}

export async function openLiveRideMapModal(rideId, rideData = {}) {
    const modalEl = document.getElementById("modal-live-ride-map");
    const mapContainer = document.getElementById("live-modal-map");
    const titleEl = document.getElementById("live-map-modal-title");
    const statusEl = document.getElementById("live-map-modal-status");
    const subtitleEl = document.getElementById("live-map-modal-subtitle");
    const pickupEl = document.getElementById("live-map-pickup-name");
    const dropEl = document.getElementById("live-map-drop-name");
    const telemetryEl = document.getElementById("live-map-telemetry-text");
    const closeBtn = document.getElementById("live-map-modal-close");

    if (!liveRideModalBound && modalEl) {
        liveRideModalBound = true;
        closeBtn?.addEventListener("click", () => closeLiveRideMapModal());
        modalEl.addEventListener("click", (e) => {
            if (e.target === modalEl) closeLiveRideMapModal();
        });
    }

    const rideItem = {
        ...(rideData && typeof rideData === "object" ? rideData : {}),
        id: String(rideId || rideData?.id || "").trim(),
    };

    const displayId = rideItem.displayId || (rideItem.id ? `#${rideItem.id.slice(0, 8)}` : "Live Ride");
    if (titleEl) titleEl.textContent = `Live Ride Tracking • ${displayId}`;
    if (statusEl) statusEl.textContent = rideItem.status || "On Trip";

    const drvId = String(rideItem.driver?.id || rideItem.driver_id || rideItem.driverId || "").trim();
    const rawDrvName = String(rideItem.driver?.name || rideItem.driver_name || rideItem.driverName || "").trim();
    const drvName =
        rawDrvName && rawDrvName !== drvId
            ? rawDrvName
            : drvId
            ? "Driver details unavailable"
            : "Unassigned";
    const drvPlate = rideItem.driver?.plate || rideItem.vehicle_number || rideItem.vehicleNumber || "";
    if (subtitleEl) {
        subtitleEl.textContent = drvPlate ? `Driver: ${drvName} (${drvPlate})` : `Driver: ${drvName}`;
    }

    const locState = normalizeRideLocationData(rideItem);
    if (pickupEl) pickupEl.textContent = locState.pickupName || "Pickup";
    if (dropEl) dropEl.textContent = locState.dropName || "Destination";
    if (telemetryEl) telemetryEl.textContent = "Loading live telemetry...";

    if (modalEl) {
        modalEl.classList.remove("d-none");
        modalEl.style.display = "block";
        modalEl.classList.add("show");
        modalEl.setAttribute("aria-hidden", "false");
    }

    if (mapContainer) {
        await renderLiveModalMap(mapContainer, rideItem, (telemetryText) => {
            if (telemetryEl) telemetryEl.textContent = telemetryText;
        });
    }
}

