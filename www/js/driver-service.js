import { auth, db } from './firebase-init.js';
import { createRideMapSurface, fetchRoadRouteDetails } from './map.js';
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const PROFILE_CACHE_KEY = "liphtup_user_profile";
const ACTIVE_RIDE_STATUSES = ["accepted", "arrived", "started", "en_route"];
const ROUTE_RECALC_DISTANCE_METERS = 25;
const ROUTE_RECALC_MIN_INTERVAL_MS = 7000;
const LOCATION_WRITE_DISTANCE_METERS = 10;
const LOCATION_WRITE_MIN_INTERVAL_MS = 5000;

const mapHost = document.getElementById('driver-service-map');
const statusText = document.getElementById('driver-service-status');
const livePill = document.getElementById('driver-service-live-pill');
const routePanel = document.getElementById('driver-route-panel');
const routeLabel = document.getElementById('driver-route-label');
const routePlace = document.getElementById('driver-route-place');
const routeDistance = document.getElementById('driver-route-distance');
const routeDuration = document.getElementById('driver-route-duration');
const routeWarning = document.getElementById('driver-route-warning');
const messagePanel = document.getElementById('driver-map-message');
const messageTitle = document.getElementById('driver-map-message-title');
const messageCopy = document.getElementById('driver-map-message-copy');
const retryButton = document.getElementById('driver-location-retry-btn');
const openConsoleButton = document.getElementById('driver-open-console-btn');

let currentUser = null;
let currentRide = null;
let currentRideId = null;
let currentTarget = null;
let currentTargetKey = "";
let driverMarkerAnimationFrame = null;

const VEHICLE_MARKER_ASSETS = Object.freeze({
    bike: new URL("../assets/vehicle-markers/bike-marker.png", import.meta.url).href,
    auto: new URL("../assets/vehicle-markers/auto-marker.png", import.meta.url).href
});

function inferVehicleType(driver = {}) {
    const text = [
        driver.vehicle_type,
        driver.vehicleType,
        driver.vehicle_model,
        driver.vehicleModel,
        driver.vehicleName
    ].filter(Boolean).join(" ").toLowerCase();
    return /auto|rickshaw|tuk/.test(text) ? "auto" : "bike";
}

function getLiveVehicleMarkerIcon() {
    const maps = window.google.maps;
    return {
        url: VEHICLE_MARKER_ASSETS[inferVehicleType(currentUser)],
        scaledSize: new maps.Size(48, 48),
        anchor: new maps.Point(24, 24)
    };
}

function animateDriverMarkerTo(position) {
    if (driverMarkerAnimationFrame) cancelAnimationFrame(driverMarkerAnimationFrame);
    const current = driverMarker?.getPosition();
    if (!current || typeof requestAnimationFrame !== "function") {
        driverMarker?.setPosition(position);
        return;
    }

    const start = { lat: current.lat(), lng: current.lng() };
    const latDelta = position.lat - start.lat;
    const lngDelta = position.lng - start.lng;
    if (Math.abs(latDelta) > 0.05 || Math.abs(lngDelta) > 0.05) {
        driverMarker.setPosition(position);
        driverMarkerAnimationFrame = null;
        return;
    }

    const startedAt = performance.now();
    const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / 700);
        const eased = progress * progress * (3 - (2 * progress));
        driverMarker.setPosition({
            lat: start.lat + (latDelta * eased),
            lng: start.lng + (lngDelta * eased)
        });
        driverMarkerAnimationFrame = progress < 1 ? requestAnimationFrame(step) : null;
    };
    driverMarkerAnimationFrame = requestAnimationFrame(step);
}
let mapShell = null;
let map = null;
let driverMarker = null;
let targetMarker = null;
let routePolyline = null;
let locationWatchId = null;
let activeRideUnsubscribe = null;
let lastPosition = null;
let lastRoutePosition = null;
let lastRouteAt = 0;
let lastWritePosition = null;
let lastWriteAt = 0;
let routeRequestInFlight = false;
let routeRefreshQueued = false;
let firstRouteFitComplete = false;
let routeRetryTimer = null;

function cacheProfile(profile) {
    const { createdAt, cachedAt, ...cacheableProfile } = profile;
    try {
        sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
            ...cacheableProfile,
            cachedAt: Date.now()
        }));
    } catch (error) {
        console.warn("Could not cache driver profile:", error);
    }
}

function setGpsState(state, label) {
    livePill.dataset.state = state;
    livePill.innerText = label;
}

function showMessage(title, copy, action = "location") {
    messageTitle.innerText = title;
    messageCopy.innerText = copy;
    retryButton.dataset.action = action;
    retryButton.innerText = action === "map" ? "Retry Map" : "Retry Location";
    messagePanel.classList.remove('d-none');
}

function hideMessage() {
    messagePanel.classList.add('d-none');
}

function showRouteWarning(message) {
    routeWarning.innerText = message;
    routeWarning.classList.remove('d-none');
}

function hideRouteWarning() {
    routeWarning.classList.add('d-none');
}

function normalizeCoordinates(latValue, lngValue) {
    const lat = Number(latValue);
    const lng = Number(lngValue);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceMeters(pointA, pointB) {
    if (!pointA || !pointB) return Infinity;

    const earthRadius = 6371000;
    const lat1 = pointA.lat * Math.PI / 180;
    const lat2 = pointB.lat * Math.PI / 180;
    const deltaLat = (pointB.lat - pointA.lat) * Math.PI / 180;
    const deltaLng = (pointB.lng - pointA.lng) * Math.PI / 180;
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function clearRoute() {
    if (routePolyline?.setMap) routePolyline.setMap(null);
    routePolyline = null;
}

function clearTarget() {
    if (targetMarker?.setMap) targetMarker.setMap(null);
    targetMarker = null;
    clearRoute();
    currentTarget = null;
    currentTargetKey = "";
    firstRouteFitComplete = false;
    if (routeRetryTimer) {
        window.clearTimeout(routeRetryTimer);
        routeRetryTimer = null;
    }
}

function scheduleRouteRetry() {
    if (routeRetryTimer) window.clearTimeout(routeRetryTimer);
    routeRetryTimer = window.setTimeout(() => {
        routeRetryTimer = null;
        if (lastPosition && currentTarget) refreshRoute(lastPosition, true);
    }, 20000);
}

async function ensureMap(position) {
    if (map) return map;

    try {
        mapShell = await createRideMapSurface(mapHost, {
            center: position,
            zoom: 17,
            minZoom: 9,
            maxZoom: 21,
            zoomControl: true,
            fullscreenControl: true,
            gestureHandling: "greedy"
        });
        map = mapShell.map;
        hideMessage();
        return map;
    } catch (error) {
        console.error("Driver Google Map failed to load:", error);
        setGpsState("error", "MAP");
        showMessage(
            "Map could not load",
            "Check the Google Maps browser key and your network connection, then retry.",
            "map"
        );
        throw error;
    }
}

function upsertDriverMarker(position) {
    if (!map || !window.google?.maps) return;

    if (!driverMarker) {
        driverMarker = new window.google.maps.Marker({
            map,
            position,
            title: "Your live location",
            zIndex: 1000,
            icon: getLiveVehicleMarkerIcon()
        });
        return;
    }

    animateDriverMarkerTo(position);
}

function upsertTargetMarker() {
    if (!map || !currentTarget || !window.google?.maps) return;

    if (!targetMarker) {
        targetMarker = new window.google.maps.Marker({
            map,
            position: currentTarget.position,
            title: currentTarget.place,
            label: {
                text: currentTarget.kind === "pickup" ? "P" : "D",
                color: "#ffffff",
                fontWeight: "800"
            },
            zIndex: 900
        });
        return;
    }

    targetMarker.setPosition(currentTarget.position);
    targetMarker.setTitle(currentTarget.place);
    targetMarker.setLabel({
        text: currentTarget.kind === "pickup" ? "P" : "D",
        color: "#ffffff",
        fontWeight: "800"
    });
}

function fitActiveRoute(path) {
    if (!map || !currentTarget || firstRouteFitComplete || !window.google?.maps) return;

    const bounds = new window.google.maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    bounds.extend(currentTarget.position);
    if (lastPosition) bounds.extend(lastPosition);
    map.fitBounds(bounds, { top: 110, right: 42, bottom: 70, left: 42 });
    firstRouteFitComplete = true;
}

function drawRoute(path) {
    if (!map || !Array.isArray(path) || path.length < 2 || !window.google?.maps) return;

    clearRoute();
    routePolyline = new window.google.maps.Polyline({
        map,
        path,
        strokeColor: "#16723a",
        strokeOpacity: 0.96,
        strokeWeight: 6,
        zIndex: 500
    });
    fitActiveRoute(path);
}

function updateRouteMetrics(routeDetails) {
    routeDistance.innerText = Number.isFinite(routeDetails?.distanceKm)
        ? `${routeDetails.distanceKm.toFixed(1)} km`
        : "-- km";
    routeDuration.innerText = Number.isFinite(routeDetails?.durationMinutes)
        ? `${Math.round(routeDetails.durationMinutes)} min`
        : "-- min";
}

async function refreshRoute(position, force = false) {
    if (!map || !currentTarget || !position) return;

    const moved = distanceMeters(lastRoutePosition, position);
    const elapsed = Date.now() - lastRouteAt;
    if (!force && moved < ROUTE_RECALC_DISTANCE_METERS) return;
    if (!force && elapsed < ROUTE_RECALC_MIN_INTERVAL_MS) {
        routeRefreshQueued = true;
        return;
    }

    if (routeRequestInFlight) {
        routeRefreshQueued = true;
        return;
    }

    routeRequestInFlight = true;
    routeRefreshQueued = false;
    const requestTargetKey = currentTargetKey;

    try {
        const routeDetails = await fetchRoadRouteDetails(position, currentTarget.position);
        if (requestTargetKey !== currentTargetKey) return;
        if (!routeDetails?.routePath?.length) {
            showRouteWarning("Google could not find a driving route. Live driver and stop markers remain visible.");
            lastRoutePosition = position;
            lastRouteAt = Date.now();
            scheduleRouteRetry();
            return;
        }

        if (routeRetryTimer) {
            window.clearTimeout(routeRetryTimer);
            routeRetryTimer = null;
        }
        lastRoutePosition = position;
        lastRouteAt = Date.now();
        hideRouteWarning();
        updateRouteMetrics(routeDetails);
        drawRoute(routeDetails.routePath);
    } catch (error) {
        if (requestTargetKey !== currentTargetKey) return;
        console.warn("Driver route refresh failed:", error);
        showRouteWarning("Route refresh failed. Keeping the last route and live markers while we retry.");
        lastRoutePosition = position;
        lastRouteAt = Date.now();
        scheduleRouteRetry();
    } finally {
        routeRequestInFlight = false;
        if (routeRefreshQueued && lastPosition && currentTarget) {
            window.setTimeout(() => refreshRoute(lastPosition), ROUTE_RECALC_MIN_INTERVAL_MS);
        }
    }
}

async function writeDriverLocation(position) {
    if (!currentUser?.uid) return;

    const elapsed = Date.now() - lastWriteAt;
    const moved = distanceMeters(lastWritePosition, position);
    if (elapsed < LOCATION_WRITE_MIN_INTERVAL_MS && moved < LOCATION_WRITE_DISTANCE_METERS) return;

    lastWriteAt = Date.now();
    lastWritePosition = position;
    const locationData = { lat: position.lat, lng: position.lng };
    const availability = currentRide ? "busy" : "searching";
    currentUser.driverAvailability = availability;

    const writes = [
        updateDoc(doc(db, "users", currentUser.uid), {
            driverLocation: locationData,
            driverAvailability: availability,
            isConnected: true,
            lastSeenAt: serverTimestamp(),
            driverAvailabilityUpdatedAt: serverTimestamp()
        }),
        setDoc(doc(db, "driverPresence", currentUser.uid), {
            uid: currentUser.uid,
            name: currentUser.name || "Driver",
            phone: currentUser.phone || "",
            driverLocation: locationData,
            driverAvailability: availability,
            verificationStatus: currentUser.verificationStatus || "pending_review",
            vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || "",
            vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || "",
            vehicle_type: inferVehicleType(currentUser),
            isConnected: true,
            lastSeenAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }, { merge: true })
    ];

    if (currentRideId) {
        writes.push(updateDoc(doc(db, "rides", currentRideId), {
            driverLocation: locationData,
            driverLocationUpdatedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }));
    }

    const results = await Promise.allSettled(writes);
    results.forEach((result) => {
        if (result.status === "rejected") {
            console.warn("A driver location write failed:", result.reason);
        }
    });
}

async function handleLocation(position) {
    const coords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
    };

    lastPosition = coords;
    setGpsState("live", "LIVE");
    hideMessage();
    statusText.innerText = currentTarget
        ? currentTarget.kind === "pickup"
            ? "Live route to passenger pickup"
            : "Passenger verified - navigating to destination"
        : "Online and ready for ride requests";

    writeDriverLocation(coords).catch((error) => {
        console.warn("Driver location sync failed:", error);
    });

    try {
        await ensureMap(coords);
    } catch {
        return;
    }

    upsertDriverMarker(coords);

    if (currentTarget) {
        upsertTargetMarker();
        refreshRoute(coords);
    } else {
        map.panTo(coords);
        hideRouteWarning();
    }
}

function handleLocationError(error) {
    console.warn("Driver GPS update failed:", error);
    setGpsState("error", "GPS");

    if (lastPosition) {
        statusText.innerText = "GPS signal lost. Showing your last known position.";
        showRouteWarning("GPS signal interrupted. Navigation will resume automatically when location returns.");
        return;
    }

    const denied = error?.code === error?.PERMISSION_DENIED || error?.code === 1;
    showMessage(
        denied ? "Location permission required" : "Current location unavailable",
        denied
            ? "Allow precise location access in your browser settings, then retry."
            : "Move to an open area, check GPS, and retry live location.",
        "location"
    );
}

function startLocationTracking() {
    if (!navigator.geolocation) {
        setGpsState("error", "GPS");
        showMessage("Location is not supported", "This browser cannot provide live GPS navigation.", "location");
        return;
    }

    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
    }

    setGpsState("loading", "GPS");
    statusText.innerText = "Finding your live position...";
    locationWatchId = navigator.geolocation.watchPosition(
        handleLocation,
        handleLocationError,
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 12000
        }
    );
}

function getRideTarget(ride) {
    const isDestinationLeg = ride.status === "en_route";
    const position = isDestinationLeg
        ? normalizeCoordinates(ride.drop_lat, ride.drop_lng)
        : normalizeCoordinates(ride.pickup_lat, ride.pickup_lng);

    if (!position) return null;

    return {
        kind: isDestinationLeg ? "destination" : "pickup",
        position,
        place: isDestinationLeg
            ? ride.drop_name || ride.drop_full_address || "Passenger destination"
            : ride.pickup_name || "Passenger pickup"
    };
}

function renderIdleState() {
    clearTarget();
    currentRide = null;
    currentRideId = null;
    routePanel.classList.add('d-none');
    openConsoleButton.classList.add('d-none');
    hideRouteWarning();
    statusText.innerText = "Online and ready for ride requests";
    if (lastPosition && map) map.panTo(lastPosition);
}

function renderActiveRideState(rideId, ride) {
    currentRideId = rideId;
    currentRide = ride;
    openConsoleButton.classList.remove('d-none');

    const target = getRideTarget(ride);
    if (!target) {
        clearTarget();
        routePanel.classList.add('d-none');
        statusText.innerText = "Active ride coordinates are unavailable";
        showRouteWarning("This ride is missing map coordinates. Open the Duty Console for ride details.");
        return;
    }

    const nextTargetKey = `${target.kind}:${target.position.lat}:${target.position.lng}`;
    const targetChanged = nextTargetKey !== currentTargetKey;
    if (targetChanged) {
        if (targetMarker?.setMap) targetMarker.setMap(null);
        targetMarker = null;
        clearRoute();
        currentTargetKey = nextTargetKey;
        firstRouteFitComplete = false;
        lastRoutePosition = null;
        lastRouteAt = 0;
        routeRefreshQueued = false;
        if (routeRetryTimer) {
            window.clearTimeout(routeRetryTimer);
            routeRetryTimer = null;
        }
    }

    currentTarget = target;
    routeLabel.innerText = target.kind === "pickup" ? "Navigate to pickup" : "Navigate to destination";
    routePlace.innerText = target.place;
    routePanel.classList.remove('d-none');
    statusText.innerText = target.kind === "pickup"
        ? "Live route to passenger pickup"
        : "Passenger verified - navigating to destination";

    if (map) upsertTargetMarker();
    if (lastPosition) refreshRoute(lastPosition, targetChanged);
}

function startActiveRideListener() {
    if (!currentUser?.uid) return;
    if (activeRideUnsubscribe) activeRideUnsubscribe();

    const activeRideQuery = query(
        collection(db, "rides"),
        where("driver_id", "==", currentUser.uid),
        where("status", "in", ACTIVE_RIDE_STATUSES)
    );

    activeRideUnsubscribe = onSnapshot(activeRideQuery, (snapshot) => {
        if (snapshot.empty) {
            renderIdleState();
            return;
        }

        const existingRide = currentRideId
            ? snapshot.docs.find((rideDoc) => rideDoc.id === currentRideId)
            : null;
        const activeRideDoc = existingRide || snapshot.docs[0];
        renderActiveRideState(activeRideDoc.id, activeRideDoc.data());
    }, (error) => {
        console.error("Driver active ride listener failed:", error);
        showRouteWarning("Could not sync the active ride. Check your connection; live GPS remains active.");
    });
}

retryButton.addEventListener('click', () => {
    hideMessage();
    if (retryButton.dataset.action === "map" && !lastPosition) {
        window.location.reload();
        return;
    }

    if (retryButton.dataset.action === "map" && lastPosition) {
        if (driverMarkerAnimationFrame) {
            cancelAnimationFrame(driverMarkerAnimationFrame);
            driverMarkerAnimationFrame = null;
        }
        mapShell?.destroy();
        mapShell = null;
        map = null;
        driverMarker = null;
        targetMarker = null;
        routePolyline = null;
        ensureMap(lastPosition).then(() => {
            upsertDriverMarker(lastPosition);
            if (currentTarget) {
                upsertTargetMarker();
                refreshRoute(lastPosition, true);
            }
        }).catch(() => {});
        return;
    }

    startLocationTracking();
});

openConsoleButton.addEventListener('click', () => {
    window.location.href = 'driver.html';
});

onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
        window.location.replace('login.html');
        return;
    }

    try {
        const profileSnap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!profileSnap.exists()) {
            window.location.replace('login.html');
            return;
        }

        const profile = profileSnap.data();
        if (profile.role !== "driver") {
            window.location.replace('index.html');
            return;
        }

        if (profile.verificationStatus !== "approved") {
            window.location.replace('driver.html');
            return;
        }

        currentUser = profile;
        cacheProfile(profile);
        startActiveRideListener();
        startLocationTracking();
    } catch (error) {
        console.error("Driver service authentication failed:", error);
        showMessage("Could not load driver account", "Check your connection and retry the page.", "map");
    }
});

window.addEventListener('beforeunload', () => {
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
    if (activeRideUnsubscribe) activeRideUnsubscribe();
    if (driverMarkerAnimationFrame) cancelAnimationFrame(driverMarkerAnimationFrame);
    mapShell?.destroy();
});
