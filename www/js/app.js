import { db } from './firebase-init.js';
import { 
    collection, 
    addDoc, 
    doc, 
    updateDoc, 
    getDoc,
    getDocs,
    query, 
    where,
    orderBy, 
    onSnapshot, 
    serverTimestamp,
    increment
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Global variables
let activeDriverLocationWatchId = null;
let currentUser = null;
let activeRideListener = null;          // For Passenger monitoring
let activeDriverTripListener = null;      // NEW: For Driver active trip monitoring
let activeDriverJobsListener = null;     // For Driver marketplace stream

// Global variable to keep track of the ride currently being driven
let currentlyAssignedRideId = null;

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

    // Double-Booking Protection Check
    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("passenger_id", "==", currentUser.uid),
            where("status", "in", ["pending", "accepted", "en_route"])
        );

        const activeRideSnap = await getDocs(activeRideQuery); 
        if (!activeRideSnap.empty) {
            alert("You already have an active ride request or an ongoing trip!");
            return; 
        }
    } catch (queryError) {
        console.error("Active ride validation failed:", queryError);
        alert("Network synchronization error. Please try again.");
        return;
    }

    // UI updates only happen if the user has no active bookings
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

        // FIXED: Added handling for when a driver cancels mid-trip
        if (ride.status === "cancelled_by_driver") {
            alert("Your driver had to cancel the trip due to an unexpected issue. Please request a new ride.");
            
            requestBtn.innerHTML = 'Confirm Request';
            document.getElementById('request-ride-btn').disabled = false;
            document.getElementById('request-ride-btn').className = "btn btn-primary w-100 fw-bold py-2";
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
            return;
        }

        if (ride.status === "accepted") {
            requestBtn.innerHTML = `✅ Driver En Route!`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', { 
                    detail: ride.driverLocation 
                }));
            }
        } else if (ride.status === "completed") {
            requestBtn.innerHTML = '🎉 Trip Completed! Safe travels.';
            requestBtn.className = "btn btn-dark w-100 fw-bold py-2";
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            
            const finalFare = ride.fare || "0.00";
            document.getElementById('passenger-final-fare').innerText = `₹${finalFare}`;
            document.getElementById('passenger-payment-view').classList.remove('d-none');
            
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
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

            // FIXED: Changed ride.fare_amount to ride.fare to clear the undefined bug
            const card = document.createElement('div');
            card.className = "card p-3 mb-3 border-start border-primary border-4 shadow-sm";
            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div>
                        <h6 class="fw-bold mb-1 text-dark">${ride.passenger_name}</h6>
                        <p class="mb-1 text-muted small"><strong>From:</strong> ${ride.pickup_name}</p>
                        <p class="mb-2 text-muted small"><strong>To:</strong> ${ride.drop_name}</p>
                    </div>
                    <span class="badge bg-primary fs-6">₹${ride.fare}</span>
                </div>
                <button class="btn btn-sm btn-success w-100 fw-bold mt-2 accept-job-btn" data-id="${rideId}">
                    Accept Ride Request
                </button>
            `;

            ridesContainer.appendChild(card);
        });

        document.querySelectorAll('.accept-job-btn').forEach(btn => {
            btn.addEventListener('click', (e) => acceptRideJob(e.target.getAttribute('data-id')));
        });
    });
}

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

        // FIXED/ADDED: Driver monitors if Passenger cancels mid-route
        activeDriverTripListener = onSnapshot(rideRef, (docSnap) => {
            if (!docSnap.exists()) return;
            const currentRideData = docSnap.data();

            if (currentRideData.status === "cancelled_by_passenger") {
                alert("The passenger has cancelled this ride request.");
                
                // Kill GPS safely
                if (activeDriverLocationWatchId !== null) {
                    navigator.geolocation.clearWatch(activeDriverLocationWatchId);
                    activeDriverLocationWatchId = null;
                }
                
                document.getElementById('active-trip-container').classList.add('d-none');
                currentlyAssignedRideId = null;
                
                if (activeDriverTripListener) activeDriverTripListener(); // Kill listener
            }
        });

        // Start Live GPS Tracking
        if (navigator.geolocation) {
            activeDriverLocationWatchId = navigator.geolocation.watchPosition(
                async (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    
                    if (currentlyAssignedRideId) { // Safeguard mapping updates
                        await updateDoc(rideRef, {
                            driverLocation: { lat: lat, lng: lng }
                        });
                        document.getElementById('gps-status').innerText = "🟢 GPS Active & Broadcasting";
                    }
                },
                (error) => {
                    console.error("GPS Tracking Error:", error);
                    document.getElementById('gps-status').innerText = "🔴 GPS Signal Lost. Please enable location.";
                },
                { enableHighAccuracy: true, maximumAge: 0 }
            );
        }

    } catch (error) {
        console.error("Failed to commit transactional state adjustment:", error);
    }
}


// Execute final state mutation to complete the ride & update ledgers
async function completeRideJob() {
    console.log("▶️ Drop-off button clicked! Current Assigned Ride ID:", currentlyAssignedRideId);

    if (!currentlyAssignedRideId) {
        console.error("❌ Cannot complete trip: active tracker lost.");
        return;
    }

    try {
        const rideRef = doc(db, "rides", currentlyAssignedRideId);
        if (activeDriverTripListener) activeDriverTripListener();

        const rideSnap = await getDoc(rideRef);
        if (!rideSnap.exists()) return;

        const rideData = rideSnap.data();
        const finalFare = parseFloat(rideData.fare || 0); // Ensure it's a clean number

        // 1. Mark the ride as complete
        await updateDoc(rideRef, {
            status: "completed",
            completedAt: serverTimestamp() // Time-stamp it for the history logs
        });

        // 2. 💰 MODULE E: UPDATE DRIVER LIFETIME EARNINGS LEDGER
        const driverProfileRef = doc(db, "users", currentUser.uid);
        await updateDoc(driverProfileRef, {
            lifetime_earnings: increment(finalFare),
            total_completed_trips: increment(1)
        });
        console.log(`✅ Ledger Updated: Added ₹${finalFare} to driver's lifetime earnings.`);

        // 3. Kill the GPS Tracker
        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        // 4. UI Transitions
        document.getElementById('active-trip-container').classList.add('d-none');
        document.getElementById('driver-final-fare').innerText = `₹${finalFare}`;
        
        const driverUPI = "yourname@okaxis"; 
        const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
        document.getElementById('upi-qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
        
        document.getElementById('driver-payment-view').classList.remove('d-none');
        currentlyAssignedRideId = null;

    } catch (error) {
        console.error("❌ Error finalizing ride transaction:", error);
        alert("Database connection dropped during checkout.");
    }
}


// Triggered when passenger clicks a "Cancel Ride" button
async function cancelRideByPassenger(rideId) {
    if (!confirm("Are you sure you want to cancel your ride request?")) return;

    try {
        const rideRef = doc(db, "rides", rideId);
        
        await updateDoc(rideRef, {
            status: "cancelled_by_passenger",
            cancelledAt: serverTimestamp()
        });

        alert("Your ride request has been cancelled.");
        
        document.getElementById('request-ride-btn').innerHTML = 'Confirm Request';
        document.getElementById('request-ride-btn').disabled = false;
        document.getElementById('request-ride-btn').className = "btn btn-primary w-100 fw-bold py-2";

    } catch (error) {
        console.error("Failed to cancel ride:", error);
    }
}

// Triggered when driver clicks a "Cancel Active Trip" button
async function cancelRideByDriver(rideId) {
    if (!confirm("Warning: Cancelling active trips impacts your driver rating. Proceed?")) return;

    try {
        const rideRef = doc(db, "rides", rideId);

        if (activeDriverTripListener) activeDriverTripListener();

        if (activeDriverLocationWatchId !== null) {
            navigator.geolocation.clearWatch(activeDriverLocationWatchId);
            activeDriverLocationWatchId = null;
        }

        await updateDoc(rideRef, {
            status: "cancelled_by_driver",
            cancelledAt: serverTimestamp()
        });

        document.getElementById('active-trip-container').classList.add('d-none');
        alert("Trip aborted successfully. Status set to offline.");
        
        currentlyAssignedRideId = null;

    } catch (error) {
        console.error("Driver cancel execution failure:", error);
    }
}

// ==========================================
// 4. GLOBAL UI EVENT LISTENERS
// ==========================================
document.getElementById('complete-trip-btn').addEventListener('click', completeRideJob);

document.getElementById('close-passenger-payment-btn').addEventListener('click', () => {
    document.getElementById('passenger-payment-view').classList.add('d-none');
    window.location.reload(); 
});

document.getElementById('close-driver-payment-btn').addEventListener('click', () => {
    document.getElementById('driver-payment-view').classList.add('d-none');
    window.location.reload();
});



// ==========================================
// 5. MODULE E: HISTORICAL TRIP LEDGER ENGINE
// ==========================================

// Call this function when the user opens their "History" or "Earnings" tab
async function fetchUserTripHistory() {
    if (!currentUser) return [];

    console.log(`Fetching history for ${currentUser.role}: ${currentUser.uid}...`);
    
    try {
        // Determine which column to check based on their role
        const roleField = currentUser.role === "driver" ? "driver_id" : "passenger_id";

        // Query: Get completed rides for this specific user, newest first
        const historyQuery = query(
            collection(db, "rides"),
            where(roleField, "==", currentUser.uid),
            where("status", "==", "completed"),
            orderBy("completedAt", "desc") // Sort newest to oldest
        );

        const snapshot = await getDocs(historyQuery);
        const tripHistory = [];

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            tripHistory.push({
                id: docSnap.id,
                date: data.completedAt ? data.completedAt.toDate().toLocaleDateString() : "Unknown Date",
                pickup: data.pickup_name,
                drop: data.drop_name,
                fare: data.fare
            });
        });

        console.log(`✅ Found ${tripHistory.length} past trips in the ledger.`);
        return tripHistory; // Returns an array of clean data objects ready for the UI team's layout!

    } catch (error) {
        console.error("Failed to fetch historical ledger:", error);
        
        // Note: If Firebase throws a 'Missing Index' error link in the console here, 
        // click the link it provides to automatically build the composite index for sorting.
        return [];
    }
}

// Expose it globally so your HTML buttons can trigger it later
window.fetchUserTripHistory = fetchUserTripHistory;