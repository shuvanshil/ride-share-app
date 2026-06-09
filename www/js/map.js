// Local state variables for tracking user position
let userLatitude = 24.3124; // Default center fallback (Kailashahar center)
let userLongitude = 92.0135;
let mapInstance = null;
let userMarker = null;

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

function updatePickupInputField(lat, lng, isFallback) {
    const pickupField = document.getElementById('pickup-input');
    if (pickupField) {
        pickupField.value = isFallback 
            ? `📍 Kailashahar Center (Simulation)` 
            : `📍 My Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    }
}

// 2. Initialize Visual Map Window
export async function initializeMapEngine() {
    const coords = await getUserLocation();
    const mapContainer = document.getElementById('map-container');
    mapContainer.innerHTML = "";
    
    console.log("Loading standalone open-source mapping engine layer...");
    
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    document.body.appendChild(script);

    script.onload = () => {
        // Just add 'window.' in front of mapInstance to expose it globally!
        window.mapInstance = L.map('map-container').setView([coords.lat, coords.lng], 14);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(window.mapInstance); // Change to window.mapInstance

        userMarker = L.marker([coords.lat, coords.lng]).addTo(window.mapInstance) // Change to window.mapInstance
            .bindPopup('<b>Your Pickup Location</b>')
            .openPopup();
            
        setupFareEngineListeners();
    };
}

// 3. Dynamic Fare Calculation Engine (Straight-Line Haversine Approximation)
function setupFareEngineListeners() {
    const dropInput = document.getElementById('drop-input');
    const fareQuoteBox = document.getElementById('fare-quote-box');
    const fareAmountSpan = document.getElementById('fare-amount');

    dropInput.addEventListener('input', (e) => {
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
            
            // Dynamic Pricing Rule: ₹30 Base Fare + ₹12 per kilometer
            const baseFare = 30;
            const perKmRate = 12;
            const finalFare = Math.round(baseFare + (distance * perKmRate));

            // Unveil the price ticket smoothly in the UI
            fareAmountSpan.innerText = `₹${finalFare}.00`;
            fareQuoteBox.classList.remove('d-none');
            fareQuoteBox.classList.add('d-flex');
        } else {
            fareQuoteBox.classList.add('d-none');
            fareQuoteBox.classList.remove('d-flex');
        }
    });
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

    console.log("🚕 Passenger map received driver location:", coords);

    if (!driverMarker) {
        // Create the driver marker 
        driverMarker = L.marker([coords.lat, coords.lng], {
            icon: L.divIcon({
                className: 'taxi-floating-icon',
                html: "<div style='font-size: 28px; transform: scaleX(-1); text-shadow: 2px 2px 4px rgba(0,0,0,0.3);'>🚖</div>",
                iconSize: [40, 40],
                iconAnchor: [20, 20]
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