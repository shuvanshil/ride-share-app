import { db } from './firebase-init.js';
import { 
    collection, 
    addDoc, 
    doc, 
    updateDoc, 
    getDoc,
    query, 
    where, 
    onSnapshot, 
    serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Global variables
let activeDriverLocationWatchId = null;
let currentUser = null;
let activeRideListener = null;
let activeDriverJobsListener = null;

// ==========================================
// 1. ROLE-BASED APPLICATION ROUTER
// ==========================================
window.addEventListener('user-session-ready', (e) => {
    currentUser = e.detail;
    console.log(`Session validated. Routing profile role: ${currentUser.role}`);

    if (currentUser.role === "driver") {
        // Route directly to Driver Console Dashboard
        document.getElementById('auth-view').classList.add('d-none');
        document.getElementById('driver-view').classList.remove('d-none');
        document.getElementById('driver-view').classList.add('d-flex');
        document.getElementById('driver-welcome-name').innerText = `Welcome, ${currentUser.name}`;
        
        // Start live monitoring for passenger broadcasts
        initDriverJobsStream();
    } else {
        // User is a passenger; map initializations happen through map.js automatically
        console.log("Passenger architecture mapped via map.js pipeline context.");
    }
});

// ==========================================
// 2. PASSENGER ENGINE: SUBMIT REQUESTS
// ==========================================
document.getElementById('request-ride-btn').addEventListener('click', async () => {
    if (!currentUser) return;

    const pickupText = document.getElementById('pickup-input').value;
    const dropText = document.getElementById('drop-input').value;
    const fareText = document.getElementById('fare-amount').innerText;

    if (!dropText || fareText === "₹0.00") {
        alert("Please enter a valid destination to get a fare quote first.");
        return;
    }

    const fareAmount = parseFloat(fareText.replace('₹', ''));
    const requestBtn = document.getElementById('request-ride-btn');
    
    requestBtn.innerHTML = '⏳ Waiting for a driver to accept...';
    requestBtn.className = "btn btn-warning w-100 fw-bold py-2 text-dark";
    requestBtn.disabled = true;

    try {
        const rideData = {
            passenger_id: currentUser.uid,
            passenger_name: currentUser.name,
            passenger_phone: currentUser.phone,
            pickup_name: pickupText,
            drop_name: dropText,
            fare: fareAmount,
            status: "pending",
            driver_id: null,
            createdAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(db, "rides"), rideData);
        listenToRideStatusUpdates(docRef.id);

    } catch (error) {
        console.error("Database Write Failure:", error);
        requestBtn.innerHTML = 'Confirm Request';
        requestBtn.className = "btn btn-primary w-100 fw-bold py-2";
        requestBtn.disabled = false;
    }
});

function listenToRideStatusUpdates(rideId) {
    const requestBtn = document.getElementById('request-ride-btn');

    activeRideListener = onSnapshot(doc(db, "rides", rideId), (docSnap) => {
        if (!docSnap.exists()) return;
        const ride = docSnap.data();

        if (ride.status === "accepted") {
            requestBtn.innerHTML = `✅ Driver En Route!`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            // NEW: If the driver has broadcasted a location, trigger the map update
            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', { 
                    detail: ride.driverLocation 
                }));
            }
        } else if (ride.status === "completed") {
            requestBtn.innerHTML = '🎉 Trip Completed! Safe travels.';
            requestBtn.className = "btn btn-dark w-100 fw-bold py-2";
            
            // Tell the map engine to strip the tracking taxi layer
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            
            // NEW: Show Passenger Billing Review Screen
            const finalFare = ride.fare || "0.00";
            document.getElementById('passenger-final-fare').innerText = `₹${finalFare}`;
            document.getElementById('passenger-payment-view').classList.remove('d-none');
            
            if (activeRideListener) activeRideListener();
        }
    });
}

// ==========================================
// 3. DRIVER ENGINE: LIVE MARKETPLACE LOOP
// ==========================================
function initDriverJobsStream() {
    const ridesContainer = document.getElementById('available-rides-list');
    const noRidesMsg = document.getElementById('no-rides-msg');

    const q = query(collection(db, "rides"), where("status", "==", "pending"));

    activeDriverJobsListener = onSnapshot(q, (querySnapshot) => {
        // Clear old items out of view, preserving placeholder message references
        ridesContainer.innerHTML = "";
        ridesContainer.appendChild(noRidesMsg);

        if (querySnapshot.empty) {
            noRidesMsg.classList.remove('d-none');
            return;
        }

        noRidesMsg.classList.add('d-none');

        querySnapshot.forEach((docSnapshot) => {
            const rideId = docSnapshot.id;
            const ride = docSnapshot.data();

            // Render a clean bootstrap card item for every active ride matching the query
            const card = document.createElement('div');
            card.className = "card p-3 mb-3 border-start border-primary border-4 shadow-sm";
            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div>
                        <h6 class="fw-bold mb-1 text-dark">${ride.passenger_name}</h6>
                        <p class="mb-1 text-muted small"><strong>From:</strong> ${ride.pickup_name}</p>
                        <p class="mb-2 text-muted small"><strong>To:</strong> ${ride.drop_name}</p>
                    </div>
                    <span class="badge bg-primary fs-6">₹${ride.fare_amount}</span>
                </div>
                <button class="btn btn-sm btn-success w-100 fw-bold mt-2 accept-job-btn" data-id="${rideId}">
                    Accept Ride Request
                </button>
            `;

            ridesContainer.appendChild(card);
        });

        // Add execution clicks to all active generation buttons
        document.querySelectorAll('.accept-job-btn').forEach(btn => {
            btn.addEventListener('click', (e) => acceptRideJob(e.target.getAttribute('data-id')));
        });
    });
}



// Global variable to keep track of the ride currently being driven
let currentlyAssignedRideId = null;

// Execute state mutation to accept standard rides
async function acceptRideJob(rideId) {
    try {
        const rideRef = doc(db, "rides", rideId);
        await updateDoc(rideRef, {
            status: "accepted",
            driver_id: currentUser.uid
        });

        currentlyAssignedRideId = rideId;
        
        // UI Transition: Show active trip control panel
        document.getElementById('active-trip-container').classList.remove('d-none');
        document.getElementById('active-trip-details').innerHTML = `
            <p class="mb-1"><strong>Status:</strong> En route to destination</p>
            <p class="mb-0 text-secondary" id="gps-status">📍 Locking GPS signal...</p>
        `;

        // NEW: Start Live GPS Tracking
        if (navigator.geolocation) {
            activeDriverLocationWatchId = navigator.geolocation.watchPosition(
                async (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    
                    // Push live coordinates to Firestore
                    await updateDoc(rideRef, {
                        driverLocation: { lat: lat, lng: lng }
                    });
                    
                    document.getElementById('gps-status').innerText = "🟢 GPS Active & Broadcasting";
                },
                (error) => {
                    console.error("GPS Tracking Error:", error);
                    document.getElementById('gps-status').innerText = "🔴 GPS Signal Lost. Please enable location.";
                },
                { enableHighAccuracy: true, maximumAge: 0 } // Forces the device to use real GPS, not just cell towers
            );
        }

    } catch (error) {
        console.error("Failed to commit transactional state adjustment:", error);
    }
}


// Execute final state mutation to complete the ride
async function completeRideJob() {
    console.log("▶️ Drop-off button clicked! Current Assigned Ride ID:", currentlyAssignedRideId);

    if (!currentlyAssignedRideId) {
        console.error("❌ Cannot complete trip: currentlyAssignedRideId is null or undefined.");
        alert("System Error: Active ride tracker lost. Check database session.");
        return;
    }

    try {
        const rideRef = doc(db, "rides", currentlyAssignedRideId);
        
        console.log("🛰️ Fetching final transaction fare data from Firestore...");
        const rideSnap = await getDoc(rideRef);
        
        if (!rideSnap.exists()) {
            console.error("❌ Ride document does not exist in Firestore!");
            return;
        }

        const rideData = rideSnap.data();
        const finalFare = rideData.fare || "0.00";
        console.log(`💰 Fare locked at: ₹${finalFare}. Updating status to 'completed'...`);

        await updateDoc(rideRef, {
            status: "completed"
        });

        // Kill the GPS Tracker
        if (activeDriverLocationWatchId !== null) {
            console.log("🛑 Killing active GPS hardware stream...");
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        // Hide old transit layout panels
        document.getElementById('active-trip-container').classList.add('d-none');
        
        // Populate and display the Driver Collect-Fare Panel
        document.getElementById('driver-final-fare').innerText = `₹${finalFare}`;
        
        // Construct standard string protocol for Indian Banking UPI apps
        const driverUPI = "yourname@okaxis"; 
        const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
        
        // Connect to a free global secure QR image compilation API
        document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
        
        console.log("🏁 UI Transitioning to Receipt Modal View.");
        document.getElementById('driver-payment-view').classList.remove('d-none');
        
        // Reset state tracker variable last
        currentlyAssignedRideId = null;

    } catch (error) {
        console.error("❌ Error finalizing ride transaction:", error);
        alert("Database connection dropped during checkout.");
    }
}

// Attach the click listener for the complete button
document.getElementById('complete-trip-btn').addEventListener('click', completeRideJob);

// Close Passenger Receipt & Reload Engine State
document.getElementById('close-passenger-payment-btn').addEventListener('click', () => {
    document.getElementById('passenger-payment-view').classList.add('d-none');
    window.location.reload(); // Quick refresh to clear map markers and reset fields smoothly
});

// Close Driver Dashboard & Reset
document.getElementById('close-driver-payment-btn').addEventListener('click', () => {
    document.getElementById('driver-payment-view').classList.add('d-none');
    window.location.reload();
});

