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
    increment,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started"];
const DRIVER_ACTIVE_STATUSES = ["accepted", "arrived", "started"];

// Global variables
let activeDriverLocationWatchId = null;
let currentUser = null;
let activeRideListener = null;          // For Passenger monitoring
let activeDriverTripListener = null;      // NEW: For Driver active trip monitoring
let activeDriverJobsListener = null;     // For Driver marketplace stream

// Global variable to keep track of the ride currently being driven
let currentlyAssignedRideId = null;

async function setDriverAvailability(status) {
    if (!currentUser || currentUser.role !== "driver") return;

    try {
        await updateDoc(doc(db, "users", currentUser.uid), {
            driverAvailability: status,
            driverAvailabilityUpdatedAt: serverTimestamp()
        });
    } catch (error) {
        console.warn("Driver availability update failed:", error);
    }
}

function resetActiveTripButtons(status = "accepted") {
    const arrivedBtn = document.getElementById('arrived-trip-btn');
    const startBtn = document.getElementById('start-trip-btn');
    const completeBtn = document.getElementById('complete-trip-btn');

    arrivedBtn.disabled = status !== "accepted";
    startBtn.disabled = status !== "arrived";
    completeBtn.disabled = status !== "started";
}

function renderActiveTripStatus(status) {
    const labels = {
        accepted: "Accepted - drive to pickup",
        arrived: "Arrived at pickup - ready to start",
        started: "Trip started - drive to destination"
    };

    const activeTripDetails = document.getElementById('active-trip-details');
    const gpsStatusText = document.getElementById('gps-status')?.innerText || "GPS locking...";

    activeTripDetails.innerHTML = `
        <p class="mb-1"><strong>Status:</strong> ${labels[status] || status}</p>
        <p class="mb-0 text-secondary" id="gps-status">${gpsStatusText}</p>
    `;

    resetActiveTripButtons(status);
}

function resetPassengerRequestButtonForActiveRide(status) {
    const requestBtn = document.getElementById('request-ride-btn');

    const buttonState = {
        pending: {
            text: "Waiting for a driver to accept...",
            className: "btn btn-warning w-100 fw-bold py-2 text-dark"
        },
        accepted: {
            text: "Driver accepted. On the way to pickup.",
            className: "btn btn-success w-100 fw-bold py-2"
        },
        arrived: {
            text: "Driver arrived at pickup.",
            className: "btn btn-info w-100 fw-bold py-2 text-dark"
        },
        started: {
            text: "Trip started. Enjoy your ride.",
            className: "btn btn-primary w-100 fw-bold py-2"
        }
    }[status] || {
        text: "Ride in progress...",
        className: "btn btn-secondary w-100 fw-bold py-2"
    };

    requestBtn.innerHTML = buttonState.text;
    requestBtn.className = buttonState.className;
    requestBtn.disabled = true;
}

function showDriverActiveTripPanel(status) {
    document.getElementById('active-trip-container').classList.remove('d-none');
    document.getElementById('active-trip-details').innerHTML = `
        <p class="mb-1"><strong>Status:</strong> Restoring active trip...</p>
        <p class="mb-0 text-secondary" id="gps-status">GPS locking...</p>
    `;
    renderActiveTripStatus(status);
}

// ==========================================
// 1. ROLE-BASED APPLICATION ROUTER
// ==========================================
window.addEventListener('user-session-ready', (e) => {
    currentUser = e.detail;
    console.log(`Session validated. Routing profile role: ${currentUser.role}`);

    if (currentUser.role === "driver") {
        if (currentUser.verificationStatus !== "approved") {
            console.log(`Driver access paused. Verification status: ${currentUser.verificationStatus || "pending_review"}`);
            if (activeDriverJobsListener) {
                activeDriverJobsListener();
                activeDriverJobsListener = null;
            }
            return;
        }

        // Route directly to Driver Console Dashboard
        document.getElementById('auth-view').classList.add('d-none');
        document.getElementById('driver-review-view').classList.add('d-none');
        document.getElementById('driver-review-view').classList.remove('d-flex');
        document.getElementById('driver-view').classList.remove('d-none');
        document.getElementById('driver-view').classList.add('d-flex');
        document.getElementById('driver-welcome-name').innerText = `Welcome, ${currentUser.name}`;
        
        setDriverAvailability("searching");

        // Start live monitoring for passenger broadcasts
        initDriverJobsStream();
        restoreDriverActiveRide();
    } else {
        // User is a passenger; map initializations happen through map.js automatically
        console.log("Passenger architecture mapped via map.js pipeline context.");
        restorePassengerActiveRide();
    }
});

async function restorePassengerActiveRide() {
    if (!currentUser || currentUser.role !== "passenger") return;

    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("passenger_id", "==", currentUser.uid),
            where("status", "in", ACTIVE_RIDE_STATUSES)
        );

        const activeRideSnap = await getDocs(activeRideQuery);
        if (activeRideSnap.empty) return;

        const activeRideDoc = activeRideSnap.docs[0];
        const activeRide = activeRideDoc.data();

        console.log(`Restoring passenger active ride: ${activeRideDoc.id}`);
        document.getElementById('drop-input').value = activeRide.drop_name || "";
        if (activeRide.fare) {
            document.getElementById('fare-amount').innerText = `₹${activeRide.fare}`;
            document.getElementById('fare-quote-box').classList.remove('d-none');
            document.getElementById('fare-quote-box').classList.add('d-flex');
        }

        resetPassengerRequestButtonForActiveRide(activeRide.status);
        listenToRideStatusUpdates(activeRideDoc.id);

        if (activeRide.driverLocation) {
            window.dispatchEvent(new CustomEvent('driver-location-updated', {
                detail: activeRide.driverLocation
            }));
        }
    } catch (error) {
        console.error("Passenger active ride restore failed:", error);
    }
}

async function restoreDriverActiveRide() {
    if (!currentUser || currentUser.role !== "driver" || currentUser.verificationStatus !== "approved") return;

    try {
        const activeRideQuery = query(
            collection(db, "rides"),
            where("driver_id", "==", currentUser.uid),
            where("status", "in", DRIVER_ACTIVE_STATUSES)
        );

        const activeRideSnap = await getDocs(activeRideQuery);
        if (activeRideSnap.empty) return;

        const activeRideDoc = activeRideSnap.docs[0];
        console.log(`Restoring driver active ride: ${activeRideDoc.id}`);

        currentlyAssignedRideId = activeRideDoc.id;
        await setDriverAvailability("busy");
        showDriverActiveTripPanel(activeRideDoc.data().status);
        attachDriverTripListener(doc(db, "rides", activeRideDoc.id));
        startDriverGpsBroadcast(doc(db, "rides", activeRideDoc.id));
    } catch (error) {
        console.error("Driver active ride restore failed:", error);
    }
}

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
            where("status", "in", ACTIVE_RIDE_STATUSES)
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
            driver_name: null,
            driver_phone: null,
            driverAvailabilitySnapshot: null,
            payment_methods: ["cash", "upi"],
            payment_status: "pending",
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
            requestBtn.innerHTML = `Driver accepted. On the way to pickup.`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', { 
                    detail: ride.driverLocation 
                }));
            }
        } else if (ride.status === "arrived") {
            requestBtn.innerHTML = 'Driver arrived at pickup.';
            requestBtn.className = "btn btn-info w-100 fw-bold py-2 text-dark";

            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', {
                    detail: ride.driverLocation
                }));
            }
        } else if (ride.status === "started") {
            requestBtn.innerHTML = 'Trip started. Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

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

function attachDriverTripListener(rideRef) {
    if (activeDriverTripListener) activeDriverTripListener();

    activeDriverTripListener = onSnapshot(rideRef, (docSnap) => {
        if (!docSnap.exists()) return;
        const currentRideData = docSnap.data();

        if (currentRideData.status === "cancelled_by_passenger") {
            alert("The passenger has cancelled this ride request.");

            if (activeDriverLocationWatchId !== null) {
                navigator.geolocation.clearWatch(activeDriverLocationWatchId);
                activeDriverLocationWatchId = null;
            }

            document.getElementById('active-trip-container').classList.add('d-none');
            currentlyAssignedRideId = null;
            setDriverAvailability("searching");

            if (activeDriverTripListener) activeDriverTripListener();
            return;
        }

        if (DRIVER_ACTIVE_STATUSES.includes(currentRideData.status)) {
            renderActiveTripStatus(currentRideData.status);
        }
    });
}

function startDriverGpsBroadcast(rideRef) {
    if (!navigator.geolocation) return;

    if (activeDriverLocationWatchId !== null) {
        navigator.geolocation.clearWatch(activeDriverLocationWatchId);
        activeDriverLocationWatchId = null;
    }

    activeDriverLocationWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            if (currentlyAssignedRideId) {
                await updateDoc(rideRef, {
                    driverLocation: { lat: lat, lng: lng }
                });
                document.getElementById('gps-status').innerText = "GPS Active & Broadcasting";
            }
        },
        (error) => {
            console.error("GPS Tracking Error:", error);
            document.getElementById('gps-status').innerText = "GPS Signal Lost. Please enable location.";
        },
        { enableHighAccuracy: true, maximumAge: 0 }
    );
}

// Execute state mutation to accept standard rides
async function acceptRideJob(rideId) {
    try {
        const rideRef = doc(db, "rides", rideId);
        const driverActiveRideQuery = query(
            collection(db, "rides"),
            where("driver_id", "==", currentUser.uid),
            where("status", "in", DRIVER_ACTIVE_STATUSES)
        );
        const activeRideSnap = await getDocs(driverActiveRideQuery);

        if (!activeRideSnap.empty) {
            throw new Error("You already have an active ride.");
        }

        await runTransaction(db, async (transaction) => {
            const rideSnap = await transaction.get(rideRef);

            if (!rideSnap.exists()) {
                throw new Error("Ride request no longer exists.");
            }

            const rideData = rideSnap.data();

            if (rideData.status !== "pending" || rideData.driver_id) {
                throw new Error("This ride was already accepted by another driver.");
            }

            transaction.update(rideRef, {
                status: "accepted",
                driver_id: currentUser.uid,
                driver_name: currentUser.name,
                driver_phone: currentUser.phone,
                acceptedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        await setDriverAvailability("busy");

        currentlyAssignedRideId = rideId;
        
        // UI Transition: Show active trip control panel
        document.getElementById('active-trip-container').classList.remove('d-none');
        document.getElementById('active-trip-details').innerHTML = `
            <p class="mb-1"><strong>Status:</strong> Accepted - drive to pickup</p>
            <p class="mb-0 text-secondary" id="gps-status">📍 Locking GPS signal...</p>
        `;
        resetActiveTripButtons("accepted");

        attachDriverTripListener(rideRef);

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
        alert(error.message || "Could not accept this ride.");
    }
}


async function updateActiveRideStatus(nextStatus) {
    if (!currentlyAssignedRideId) {
        console.error("Cannot update trip status: active ride tracker lost.");
        return;
    }

    try {
        const rideRef = doc(db, "rides", currentlyAssignedRideId);
        const rideSnap = await getDoc(rideRef);

        if (!rideSnap.exists()) {
            alert("This ride no longer exists.");
            return;
        }

        const rideData = rideSnap.data();
        const allowedTransitions = {
            accepted: ["arrived"],
            arrived: ["started"],
            started: ["completed"]
        };

        if (rideData.driver_id !== currentUser.uid) {
            alert("Only the assigned driver can update this trip.");
            return;
        }

        if (!allowedTransitions[rideData.status]?.includes(nextStatus)) {
            alert(`Cannot move ride from ${rideData.status} to ${nextStatus}.`);
            return;
        }

        const timestampField = {
            arrived: "arrivedAt",
            started: "startedAt"
        }[nextStatus];

        await updateDoc(rideRef, {
            status: nextStatus,
            [timestampField]: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        renderActiveTripStatus(nextStatus);
    } catch (error) {
        console.error("Trip status update failed:", error);
        alert("Could not update trip status. Please try again.");
    }
}

async function markDriverArrived() {
    await updateActiveRideStatus("arrived");
}

async function startRideJob() {
    await updateActiveRideStatus("started");
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

        const rideSnap = await getDoc(rideRef);
        if (!rideSnap.exists()) return;

        const rideData = rideSnap.data();
        if (rideData.status !== "started") {
            alert("Start the trip before completing it.");
            return;
        }

        const finalFare = parseFloat(rideData.fare || 0); // Ensure it's a clean number

        // 1. Mark the ride as complete
        await updateDoc(rideRef, {
            status: "completed",
            completedAt: serverTimestamp(), // Time-stamp it for the history logs
            updatedAt: serverTimestamp()
        });

        if (activeDriverTripListener) activeDriverTripListener();

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

        await setDriverAvailability("searching");

        // 4. UI Transitions
        document.getElementById('active-trip-container').classList.add('d-none');
        document.getElementById('driver-final-fare').innerText = `₹${finalFare}`;
        
        const driverUPI = currentUser.upiId;
        const upiQrImage = document.getElementById('upi-qr-image');

        if (driverUPI) {
            const upiString = encodeURIComponent(`upi://pay?pa=${driverUPI}&pn=TripuraDriver&am=${finalFare}&cu=INR`);
            upiQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${upiString}`;
            upiQrImage.classList.remove('d-none');
        } else {
            upiQrImage.src = "";
            upiQrImage.classList.add('d-none');
            alert("Your driver UPI ID is missing from your profile. Please collect cash for this ride.");
        }
        
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
    rideId = rideId || currentlyAssignedRideId;
    if (!rideId) {
        alert("No active trip found to cancel.");
        return;
    }

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
        await setDriverAvailability("searching");

    } catch (error) {
        console.error("Driver cancel execution failure:", error);
    }
}

// ==========================================
// 4. GLOBAL UI EVENT LISTENERS
// ==========================================
document.getElementById('arrived-trip-btn').addEventListener('click', markDriverArrived);
document.getElementById('start-trip-btn').addEventListener('click', startRideJob);
document.getElementById('complete-trip-btn').addEventListener('click', completeRideJob);
document.getElementById('cancel-driver-trip-btn').addEventListener('click', () => cancelRideByDriver());

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
