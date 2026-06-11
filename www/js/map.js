// Local state variables for tracking user position
let userLatitude = 24.3124; // Default center fallback (Kailashahar center)
let userLongitude = 92.0135;
let mapInstance = null;
let userMarker = null;
let routePolyline = null;
let destinationMarker = null;

// Mock local landmarks database for North Tripura to compute distances/fares without an expensive Google API key
const localLandmarks = {
    "kumarghat station": { lat: 24.2415, lng: 92.0312, name: "Kumarghat Railway Station" },
    "rgm hospital": { lat: 24.3210, lng: 92.0110, name: "Kailashahar RGM Hospital" },
    "dharmanagar": { lat: 24.3667, lng: 92.1667, name: "Dharmanagar Town Center" },
    "unakoti": { lat: 24.3236, lng: 92.0272, name: "Unakoti Heritage Site" }
};

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

        pickupField.value = readableParts.length
            ? readableParts.join(", ")
            : `My Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    } catch (error) {
        console.warn("Reverse geocoding failed:", error);
        pickupField.value = `My Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
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

// 2. Initialize Visual Map Window
export async function initializeMapEngine() {
    const coords = await getUserLocation();
    const mapContainer = document.getElementById('map-container');
    mapContainer.innerHTML = "";

    console.log("Loading standalone open-source mapping engine layer...");

    await loadLeaflet();
    injectMapStyles();

    if (window.mapInstance) {
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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(window.mapInstance); // Change to window.mapInstance

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
}

// 3. Dynamic Fare Calculation Engine (Straight-Line Haversine Approximation)
function setupFareEngineListeners() {
    const dropInput = document.getElementById('drop-input');
    const fareQuoteBox = document.getElementById('fare-quote-box');
    const fareAmountSpan = document.getElementById('fare-amount');

    dropInput.addEventListener('input', async (e) => {
        const query = e.target.value.toLowerCase().trim();

        // Check if user is typing one of our known local destinations
        let destination = null;
        for (const key in localLandmarks) {
            if (query.includes(key) || key.includes(query) && query.length > 3) {
                destination = localLandmarks[key];
                break;
            }
        }

        if (destination) {
            // Calculate rough distance in kilometers
            const distance = calculateDistance(userLatitude, userLongitude, destination.lat, destination.lng);
            const estimatedDurationMinutes = Math.max(5, Math.round((distance / 25) * 60));

            // Dynamic Pricing Rule: Rs 30 Base Fare + Rs 12 per kilometer
            const baseFare = 30;
            const perKmRate = 12;
            const finalFare = Math.round(baseFare + (distance * perKmRate));
            window.latestFareQuote = {
                pickup_lat: userLatitude,
                pickup_lng: userLongitude,
                drop_lat: destination.lat,
                drop_lng: destination.lng,
                distance_km: Number(distance.toFixed(2)),
                duration_minutes: estimatedDurationMinutes
            };

            // Unveil the price ticket smoothly in the UI
            fareAmountSpan.innerText = `₹${finalFare}.00`;
            fareQuoteBox.classList.remove('d-none');
            fareQuoteBox.classList.add('d-flex');

            if (window.mapInstance) {
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
        } else {
            fareQuoteBox.classList.add('d-none');
            fareQuoteBox.classList.remove('d-flex');
            window.latestFareQuote = null;
            clearDestinationRoute();
        }
    });
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
