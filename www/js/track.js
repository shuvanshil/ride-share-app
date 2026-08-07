import { db } from './firebase-init.js';
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async`;
            script.onload = () => resolve(window.google.maps);
            script.onerror = reject;
            document.head.appendChild(script);
        }).catch(reject);
    });
}

function ensureMap(center) {
    const mapsApi = window.google.maps;
    if (!map) {
        map = new mapsApi.Map(document.getElementById('track-map'), {
            center,
            zoom: 14,
            disableDefaultUI: true,
            zoomControl: true,
        });
    }
    return map;
}

function updateMarker(refHolder, key, position, options) {
    if (!position) return;
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

    document.getElementById('track-driver-name').innerText = data.driver_name || "Assigned driver";
    document.getElementById('track-vehicle').innerText = [data.vehicle_model, data.vehicle_number].filter(Boolean).join(" · ") || "—";
    document.getElementById('track-pickup').innerText = data.pickup_name || "—";
    document.getElementById('track-drop').innerText = data.drop_name || "—";
    detailsCard.classList.remove('d-none');

    const driverLoc = data.driverLocation;
    const pickup = (data.pickup_lat && data.pickup_lng) ? { lat: data.pickup_lat, lng: data.pickup_lng } : null;
    const drop = (data.drop_lat && data.drop_lng) ? { lat: data.drop_lat, lng: data.drop_lng } : null;
    const center = driverLoc || pickup || drop;
    if (!center || !window.google?.maps) return;

    ensureMap(center);
    if (driverLoc) {
        updateMarker(markers, 'driver', driverLoc, { title: "Driver", label: "D" });
        map.panTo(driverLoc);
    }
    if (pickup) updateMarker(markers, 'pickup', pickup, { title: "Pickup", label: "P" });
    if (drop) updateMarker(markers, 'drop', drop, { title: "Destination", label: "X" });
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
                return;
            }
            renderSnapshot(snap.data());
        },
        (error) => {
            console.error("Trip share listener error:", error);
            showNotFound();
        }
    );
}

window.addEventListener('beforeunload', () => {
    if (unsubscribe) unsubscribe();
});

start();
