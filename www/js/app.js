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

const ACTIVE_RIDE_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"];
const DRIVER_ACTIVE_STATUSES = ["accepted", "arrived", "started", "en_route"];

// Global variables
let activeDriverLocationWatchId = null;
let currentUser = null;
let activeRideListener = null;          // For Passenger monitoring
let activeDriverTripListener = null;      // NEW: For Driver active trip monitoring
let activeDriverJobsListener = null;     // For Driver marketplace stream

// Global variable to keep track of the ride currently being driven
let currentlyAssignedRideId = null;
let pendingDriverPaymentRideId = null;
let activeDriverRenderedStatus = null;

function generateVerificationPin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function renderPassengerVerificationPin(pin) {
    if (!pin) return;

    const bottomSheetContainer = document.querySelector('#bottom-sheet .container');
    if (!bottomSheetContainer) return;

    let pinBox = document.getElementById('passenger-verification-pin-box');
    if (!pinBox) {
        pinBox = document.createElement('div');
        pinBox.id = 'passenger-verification-pin-box';
        pinBox.className = 'bg-warning-subtle border border-warning rounded p-2 mb-3 text-center';
        bottomSheetContainer.insertBefore(pinBox, document.getElementById('request-ride-btn'));
    }

    pinBox.innerHTML = `
        <div class="small text-secondary fw-semibold">Passenger Verification PIN</div>
        <div class="fs-3 fw-bold text-dark letter-spacing-2">${pin}</div>
        <div class="small text-muted">Share this PIN only with your assigned driver.</div>
    `;
    pinBox.classList.remove('d-none');
}

function hidePassengerVerificationPin() {
    const pinBox = document.getElementById('passenger-verification-pin-box');
    if (pinBox) pinBox.classList.add('d-none');
}

function renderPassengerDriverCard(ride) {
    if (!ride.driver_name && !ride.driver_phone && !ride.vehicle_model && !ride.vehicle_number) return;

    const bottomSheetContainer = document.querySelector('#bottom-sheet .container');
    if (!bottomSheetContainer) return;

    let driverCard = document.getElementById('passenger-driver-card');
    if (!driverCard) {
        driverCard = document.createElement('div');
        driverCard.id = 'passenger-driver-card';
        driverCard.className = 'bg-white border rounded p-3 mb-3 shadow-sm';
        bottomSheetContainer.insertBefore(driverCard, document.getElementById('passenger-verification-pin-box') || document.getElementById('request-ride-btn'));
    }

    const driverName = ride.driver_name || "Assigned Driver";
    const vehicleModel = ride.vehicle_model || "Vehicle";
    const vehicleNumber = ride.vehicle_number || "Number pending";
    const driverPhone = ride.driver_phone || "";

    driverCard.innerHTML = `
        <div class="d-flex justify-content-between align-items-start gap-3">
            <div>
                <div class="fw-bold text-dark">${driverName}</div>
                <div class="small text-muted">🚗 ${vehicleModel} • ${vehicleNumber}</div>
            </div>
            ${driverPhone ? `
                <a href="tel:${driverPhone}" class="btn btn-outline-primary btn-sm fw-semibold">
                    Call Driver
                </a>
            ` : ""}
        </div>
    `;
    driverCard.classList.remove('d-none');
}

function hidePassengerDriverCard() {
    const driverCard = document.getElementById('passenger-driver-card');
    if (driverCard) driverCard.classList.add('d-none');
}

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

    arrivedBtn.classList.add('d-none');
    startBtn.classList.add('d-none');
    completeBtn.classList.toggle('d-none', status !== "en_route");
    completeBtn.disabled = status !== "en_route";
}

function renderActiveTripStatus(status) {
    activeDriverRenderedStatus = status;

    const labels = {
        accepted: "PIN verification required",
        arrived: "Arrived at pickup - ready to start",
        started: "Trip started - drive to destination",
        en_route: "Trip in Progress"
    };

    const activeTripDetails = document.getElementById('active-trip-details');
    const gpsStatusText = document.getElementById('gps-status')?.innerText || "GPS locking...";
    const pinVerificationHtml = status === "accepted" ? `
        <div id="verification-pin-panel" class="mt-3">
            <label for="verification-pin-input" class="form-label fw-semibold mb-1">Passenger PIN</label>
            <input id="verification-pin-input" type="tel" maxlength="4" inputmode="numeric" class="form-control text-center fw-bold mb-2" placeholder="Enter 4-digit PIN">
            <button id="verify-pin-btn" class="btn btn-success w-100 fw-bold">
                Verify & Start Trip
            </button>
        </div>
    ` : "";

    activeTripDetails.innerHTML = `
        <p class="mb-1"><strong>Status:</strong> ${labels[status] || status}</p>
        <p class="mb-0 text-secondary" id="gps-status">${gpsStatusText}</p>
        ${pinVerificationHtml}
    `;

    resetActiveTripButtons(status);

    const verifyPinBtn = document.getElementById('verify-pin-btn');
    if (verifyPinBtn) {
        verifyPinBtn.addEventListener('click', () => verifyAndStartTrip(currentlyAssignedRideId));
    }
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
        },
        en_route: {
            text: "🚗 Trip in Progress! Enjoy your ride.",
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

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatHistoryDate(timestamp) {
    if (!timestamp?.toDate) return "Date not recorded";
    return timestamp.toDate().toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function formatDistance(distanceKm) {
    return Number.isFinite(Number(distanceKm)) ? `${Number(distanceKm).toFixed(2)} km` : "Not recorded";
}

function formatDuration(durationMinutes) {
    return Number.isFinite(Number(durationMinutes)) ? `${Math.round(Number(durationMinutes))} min` : "Not recorded";
}

function buildTripHistoryRecord(rideId, rideData) {
    return {
        ride_id: rideId,
        passenger_id: rideData.passenger_id || null,
        driver_id: rideData.driver_id || null,
        pickup_location: rideData.pickup_name || "Pickup not recorded",
        drop_location: rideData.drop_name || "Drop not recorded",
        completedAt: rideData.completedAt || serverTimestamp(),
        paidAt: serverTimestamp(),
        distance_km: Number(rideData.distance_km || 0),
        duration_minutes: Number(rideData.duration_minutes || 0),
        fare_amount: Number(rideData.fare || 0),
        trip_status: rideData.status || "completed",
        payment_status: "paid",
        driver_name: rideData.driver_name || "Driver",
        passenger_name: rideData.passenger_name || "Passenger",
        vehicle_model: rideData.vehicle_model || "Vehicle",
        vehicle_number: rideData.vehicle_number || "Number not recorded",
        vehicle_details: `${rideData.vehicle_model || "Vehicle"} • ${rideData.vehicle_number || "Number not recorded"}`,
        source: "client_payment_confirmation",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
}

async function markRidePaidAndCreateHistory(rideId) {
    if (!rideId) {
        alert("No completed ride found for payment confirmation.");
        return false;
    }

    try {
        const rideRef = doc(db, "rides", rideId);
        const historyRef = doc(db, "tripHistory", rideId);

        await runTransaction(db, async (transaction) => {
            const rideSnap = await transaction.get(rideRef);
            if (!rideSnap.exists()) {
                throw new Error("Ride document no longer exists.");
            }

            const rideData = rideSnap.data();
            if (rideData.status !== "completed") {
                throw new Error("Only completed rides can be moved into trip history.");
            }

            if (rideData.driver_id !== currentUser.uid) {
                throw new Error("Only the assigned driver can confirm this payment.");
            }

            transaction.update(rideRef, {
                payment_status: "paid",
                payment_confirmed_by: currentUser.uid,
                paymentConfirmedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            transaction.set(historyRef, buildTripHistoryRecord(rideId, {
                ...rideData,
                payment_status: "paid"
            }));
        });

        return true;
    } catch (error) {
        console.error("Trip history creation failed:", error);
        alert(error.message || "Could not confirm payment and save trip history.");
        return false;
    }
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
        renderPassengerDriverCard(activeRide);
        renderPassengerVerificationPin(activeRide.verification_pin);
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
        const verificationPin = generateVerificationPin();
        const fareQuote = window.latestFareQuote || {};
        const rideData = {
            passenger_id: currentUser.uid,
            passenger_name: currentUser.name,
            passenger_phone: currentUser.phone,
            pickup_name: pickupText,
            drop_name: dropText,
            pickup_lat: fareQuote.pickup_lat || null,
            pickup_lng: fareQuote.pickup_lng || null,
            drop_lat: fareQuote.drop_lat || null,
            drop_lng: fareQuote.drop_lng || null,
            distance_km: fareQuote.distance_km || null,
            duration_minutes: fareQuote.duration_minutes || null,
            fare: fareAmount, 
            status: "pending",
            driver_id: null,
            driver_name: null,
            driver_phone: null,
            vehicle_model: null,
            vehicle_number: null,
            driverAvailabilitySnapshot: null,
            payment_methods: ["cash", "upi"],
            payment_status: "pending",
            verification_pin: verificationPin,
            createdAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(db, "rides"), rideData);
        renderPassengerVerificationPin(verificationPin);
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
            hidePassengerVerificationPin();
            hidePassengerDriverCard();
            
            requestBtn.innerHTML = 'Confirm Request';
            document.getElementById('request-ride-btn').disabled = false;
            document.getElementById('request-ride-btn').className = "btn btn-primary w-100 fw-bold py-2";
            
            window.dispatchEvent(new CustomEvent('ride-completed-clear-map'));
            if (activeRideListener) activeRideListener(); // Unsubscribe stream
            return;
        }

        if (ride.status === "accepted") {
            renderPassengerDriverCard(ride);
            renderPassengerVerificationPin(ride.verification_pin);
            requestBtn.innerHTML = `Driver accepted. On the way to pickup.`;
            requestBtn.className = "btn btn-success w-100 fw-bold py-2";
            
            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', { 
                    detail: ride.driverLocation 
                }));
            }
        } else if (ride.status === "arrived") {
            renderPassengerDriverCard(ride);
            requestBtn.innerHTML = 'Driver arrived at pickup.';
            requestBtn.className = "btn btn-info w-100 fw-bold py-2 text-dark";

            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', {
                    detail: ride.driverLocation
                }));
            }
        } else if (ride.status === "started") {
            renderPassengerDriverCard(ride);
            requestBtn.innerHTML = 'Trip started. Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', {
                    detail: ride.driverLocation
                }));
            }
        } else if (ride.status === "en_route") {
            renderPassengerDriverCard(ride);
            requestBtn.innerHTML = '🚗 Trip in Progress! Enjoy your ride.';
            requestBtn.className = "btn btn-primary w-100 fw-bold py-2";

            if (ride.driverLocation) {
                window.dispatchEvent(new CustomEvent('driver-location-updated', {
                    detail: ride.driverLocation
                }));
            }
        } else if (ride.status === "completed") {
            requestBtn.innerHTML = '🎉 Trip Completed! Safe travels.';
            requestBtn.className = "btn btn-dark w-100 fw-bold py-2";
            hidePassengerVerificationPin();
            hidePassengerDriverCard();
            
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
            if (currentRideData.status !== activeDriverRenderedStatus) {
                renderActiveTripStatus(currentRideData.status);
            }
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
                vehicle_model: currentUser.vehicle_model || currentUser.vehicleModel || currentUser.vehicleName || "Registered Vehicle",
                vehicle_number: currentUser.vehicle_number || currentUser.vehicleNumber || currentUser.vehicleNo || "Vehicle number pending",
                acceptedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        await setDriverAvailability("busy");

        currentlyAssignedRideId = rideId;
        
        // UI Transition: Show active trip control panel
        document.getElementById('active-trip-container').classList.remove('d-none');
        renderActiveTripStatus("accepted");

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

async function verifyAndStartTrip(rideId) {
    if (!rideId) {
        alert("No active ride found for PIN verification.");
        return;
    }

    const pinInput = document.getElementById('verification-pin-input');
    const typedPin = pinInput ? pinInput.value.trim() : "";

    if (!/^\d{4}$/.test(typedPin)) {
        alert("Please enter the 4-digit passenger PIN.");
        return;
    }

    try {
        const rideRef = doc(db, "rides", rideId);
        const rideSnap = await getDoc(rideRef);

        if (!rideSnap.exists()) {
            alert("This ride no longer exists.");
            return;
        }

        const rideData = rideSnap.data();

        if (rideData.driver_id !== currentUser.uid) {
            alert("Only the assigned driver can verify this ride.");
            return;
        }

        if (String(rideData.verification_pin || "") !== typedPin) {
            alert("Incorrect verification PIN. Please verify with the passenger.");
            return;
        }

        await updateDoc(rideRef, {
            status: "en_route",
            pinVerifiedAt: serverTimestamp(),
            startedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        const verificationPanel = document.getElementById('verification-pin-panel');
        if (verificationPanel) verificationPanel.classList.add('d-none');

        renderActiveTripStatus("en_route");
    } catch (error) {
        console.error("PIN verification failed:", error);
        alert("Could not verify PIN. Please try again.");
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

        const rideSnap = await getDoc(rideRef);
        if (!rideSnap.exists()) return;

        const rideData = rideSnap.data();
        if (rideData.status !== "en_route") {
            alert("Verify the passenger PIN before completing this trip.");
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
        pendingDriverPaymentRideId = currentlyAssignedRideId;
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
        hidePassengerVerificationPin();
        hidePassengerDriverCard();
        
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

document.getElementById('close-driver-payment-btn').addEventListener('click', async () => {
    const closeBtn = document.getElementById('close-driver-payment-btn');
    closeBtn.disabled = true;
    closeBtn.innerText = "Saving trip history...";

    const saved = await markRidePaidAndCreateHistory(pendingDriverPaymentRideId);
    if (!saved) {
        closeBtn.disabled = false;
        closeBtn.innerText = "Fare Received & Clear";
        return;
    }

    document.getElementById('driver-payment-view').classList.add('d-none');
    window.location.reload();
});



// ==========================================
// 5. MODULE E: HISTORICAL TRIP LEDGER ENGINE
// ==========================================

async function fetchUserTripHistory() {
    if (!currentUser) return [];

    try {
        const roleField = currentUser.role === "driver" ? "driver_id" : "passenger_id";
        const historyQuery = query(
            collection(db, "tripHistory"),
            where(roleField, "==", currentUser.uid)
        );

        const snapshot = await getDocs(historyQuery);
        return snapshot.docs
            .map((docSnap) => ({
                id: docSnap.id,
                ...docSnap.data()
            }))
            .sort((a, b) => {
                const aTime = a.completedAt?.toMillis ? a.completedAt.toMillis() : 0;
                const bTime = b.completedAt?.toMillis ? b.completedAt.toMillis() : 0;
                return bTime - aTime;
            });
    } catch (error) {
        console.error("Failed to fetch trip history:", error);
        alert("Could not load trip history. If Firebase asks for an index, create it from the console error link.");
        return [];
    }
}

function renderTripHistoryList(trips) {
    const list = document.getElementById('trip-history-list');
    const subtitle = document.getElementById('trip-history-subtitle');
    if (!list || !subtitle) return;

    subtitle.innerText = currentUser.role === "driver" ? "Completed rides and earnings" : "Completed passenger trips";

    if (!trips.length) {
        list.innerHTML = `
            <div class="bg-white border rounded p-4 text-center text-muted">
                No completed paid trips found yet.
            </div>
        `;
        return;
    }

    list.innerHTML = trips.map((trip) => {
        const isDriver = currentUser.role === "driver";
        const title = isDriver ? trip.passenger_name : trip.driver_name;
        const moneyLabel = isDriver ? "Earnings" : "Fare";
        const vehicleLine = !isDriver ? `
            <div class="small text-muted">${escapeHtml(trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || ""}`)}</div>
        ` : "";

        return `
            <div class="bg-white border rounded p-3 mb-3 shadow-sm">
                <div class="d-flex justify-content-between gap-3">
                    <div>
                        <div class="fw-bold text-dark">${escapeHtml(title || "Trip participant")}</div>
                        <div class="small text-muted">${formatHistoryDate(trip.completedAt)}</div>
                        ${vehicleLine}
                    </div>
                    <div class="text-end">
                        <div class="fw-bold text-success">₹${escapeHtml(trip.fare_amount || 0)}</div>
                        <div class="small text-muted">${moneyLabel}</div>
                    </div>
                </div>
                <hr class="my-2">
                <div class="small"><strong>From:</strong> ${escapeHtml(trip.pickup_location)}</div>
                <div class="small"><strong>To:</strong> ${escapeHtml(trip.drop_location)}</div>
                <div class="d-flex justify-content-between small text-muted mt-2">
                    <span>${formatDistance(trip.distance_km)}</span>
                    <span>${formatDuration(trip.duration_minutes)}</span>
                    <span class="text-capitalize">${escapeHtml(trip.payment_status || trip.trip_status || "completed")}</span>
                </div>
                <button class="btn btn-sm btn-outline-primary w-100 mt-3 trip-detail-btn" data-trip-id="${escapeHtml(trip.id)}">
                    View Details
                </button>
            </div>
        `;
    }).join("");

    document.querySelectorAll('.trip-detail-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const trip = trips.find((item) => item.id === btn.getAttribute('data-trip-id'));
            if (trip) renderTripDetail(trip);
        });
    });
}

function renderTripDetail(trip) {
    const detailContent = document.getElementById('trip-detail-content');
    if (!detailContent) return;

    detailContent.innerHTML = `
        <div class="mb-2"><strong>Ride ID:</strong> ${escapeHtml(trip.ride_id || trip.id)}</div>
        <div class="mb-2"><strong>Date & Time:</strong> ${formatHistoryDate(trip.completedAt)}</div>
        <div class="mb-2"><strong>Passenger:</strong> ${escapeHtml(trip.passenger_name || "Passenger")}</div>
        <div class="mb-2"><strong>Driver:</strong> ${escapeHtml(trip.driver_name || "Driver")}</div>
        <div class="mb-2"><strong>Vehicle:</strong> ${escapeHtml(trip.vehicle_details || `${trip.vehicle_model || "Vehicle"} • ${trip.vehicle_number || "Number not recorded"}`)}</div>
        <div class="mb-2"><strong>Pickup:</strong> ${escapeHtml(trip.pickup_location)}</div>
        <div class="mb-2"><strong>Drop:</strong> ${escapeHtml(trip.drop_location)}</div>
        <div class="mb-2"><strong>Distance:</strong> ${formatDistance(trip.distance_km)}</div>
        <div class="mb-2"><strong>Duration:</strong> ${formatDuration(trip.duration_minutes)}</div>
        <div class="mb-2"><strong>Fare:</strong> ₹${escapeHtml(trip.fare_amount || 0)}</div>
        <div class="mb-0"><strong>Status:</strong> ${escapeHtml(trip.trip_status || "completed")} / ${escapeHtml(trip.payment_status || "paid")}</div>
    `;

    document.getElementById('trip-detail-view').classList.remove('d-none');
}

async function openTripHistory() {
    if (!currentUser) {
        alert("Please login first.");
        return;
    }

    const historyView = document.getElementById('trip-history-view');
    const list = document.getElementById('trip-history-list');
    historyView.classList.remove('d-none');
    list.innerHTML = `<div class="text-center text-muted py-5">Loading trip history...</div>`;

    const trips = await fetchUserTripHistory();
    renderTripHistoryList(trips);
}

document.getElementById('passenger-history-btn').addEventListener('click', openTripHistory);
document.getElementById('driver-history-btn').addEventListener('click', openTripHistory);
document.getElementById('close-trip-history-btn').addEventListener('click', () => {
    document.getElementById('trip-history-view').classList.add('d-none');
});
document.getElementById('close-trip-detail-btn').addEventListener('click', () => {
    document.getElementById('trip-detail-view').classList.add('d-none');
});

window.fetchUserTripHistory = fetchUserTripHistory;
