import { db } from "../../js/firebase-init.js";
import {
    collection,
    doc,
    onSnapshot,
    query,
    where,
    orderBy,
    limit as fsLimit,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const knownDriverAvailability = new Map(); // uid -> last driverAvailability seen
const knownRideStatus = new Map(); // rideId -> last status seen
const knownUserIds = new Set(); // uids already seen at least once (skip synthetic "new" events on first snapshot)
let feedSink = null;
let errorSink = null;
let firstUsersSnapshot = true;
let firstDriverSnapshot = true;
let firstRidesSnapshot = true;
let deniedRetried = false;

function emit(event) {
    if (feedSink) feedSink({ ...event, at: Date.now() });
}

/**
 * A `permission-denied` here almost always means one of two things: the
 * signed-in admin's ID token was cached before the `admin` custom claim was
 * granted (fixed by a forced token refresh -- retried once, automatically),
 * or the firestore.rules containing the `isAdmin()` read grant were edited
 * locally but never deployed to the live Firebase project (that one needs a
 * human to run `firebase deploy --only firestore:rules`). Surface it once
 * instead of letting three near-identical console errors speak for us.
 */
async function handleListenerError(label, error) {
    console.error(`[admin-live] ${label} listener error:`, error);
    if (error?.code !== "permission-denied" || !errorSink) return;
    if (!deniedRetried) {
        deniedRetried = true;
        try {
            const { auth } = await import("../../js/firebase-init.js");
            if (auth.currentUser) await auth.currentUser.getIdToken(true);
        } catch {
            /* fall through to the user-facing message below */
        }
    }
    errorSink(
        "Live updates lost permission to read from Firestore. If this admin " +
            "account was just granted access, sign out and back in. If it keeps " +
            "happening, firestore.rules may not be deployed to the live project."
    );
}

/**
 * Starts all realtime listeners once. Safe to call exactly once per page
 * load. `onError(message)` is optional and is called (at most once per
 * kind of failure) with a human-readable string suitable for a toast.
 */
export function startLiveFeed(onEvent, onError) {
    feedSink = onEvent;
    errorSink = onError || null;

    // Driver online/offline, straight from the public driverMapPresence
    // collection -- no rules change was needed for this one.
    onSnapshot(collection(db, "driverMapPresence"), (snap) => {
        snap.docChanges().forEach((change) => {
            const data = change.doc.data();
            const uid = change.doc.id;
            const prev = knownDriverAvailability.get(uid);
            knownDriverAvailability.set(uid, data.driverAvailability);
            if (firstDriverSnapshot || prev === data.driverAvailability) return;
            const name = data.name || "A driver";
            if (data.driverAvailability === "offline" && prev !== "offline") {
                emit({ type: "driver_offline", text: `${name} went offline` });
            } else if ((data.driverAvailability === "online" || data.driverAvailability === "searching") && prev === "offline") {
                emit({ type: "driver_online", text: `${name} went online` });
            }
        });
        firstDriverSnapshot = false;
    }, (error) => handleListenerError("driverMapPresence", error));

    // Ride lifecycle: accepted / cancelled / completed / payment, from the
    // admin-only read grant added to firestore.rules.
    const recentRidesQuery = query(collection(db, "rides"), orderBy("updatedAt", "desc"), fsLimit(50));
    onSnapshot(recentRidesQuery, (snap) => {
        snap.docChanges().forEach((change) => {
            const data = change.doc.data();
            const rideId = change.doc.id;
            const prevStatus = knownRideStatus.get(rideId);
            knownRideStatus.set(rideId, data.status);
            if (firstRidesSnapshot || prevStatus === data.status) return;
            const label = {
                accepted: "Ride accepted",
                cancelled_by_passenger: "Ride cancelled by passenger",
                cancelled_by_driver: "Ride cancelled by driver",
                completed: "Ride completed",
                started: "Ride started",
            }[data.status];
            if (label) {
                emit({ type: `ride_${data.status}`, text: `${label} \u00b7 ${data.pickupName || "ride"} \u2192 ${data.dropName || ""}` });
            }
            if (data.payment_status === "paid" && prevStatus !== undefined) {
                emit({ type: "payment_completed", text: `Payment completed for a ride (Rs ${data.fare || 0})` });
            }
        });
        firstRidesSnapshot = false;
    }, (error) => handleListenerError("rides", error));

    // New passenger registrations + driver status changes (approved/
    // suspended/blocked), from the admin-only read grant on `users`.
    onSnapshot(collection(db, "users"), (snap) => {
        snap.docChanges().forEach((change) => {
            const data = change.doc.data();
            const uid = change.doc.id;
            if (change.type === "added") {
                if (!firstUsersSnapshot && !knownUserIds.has(uid)) {
                    if (data.role === "passenger") {
                        emit({ type: "new_passenger", text: `New passenger registered: ${data.name || data.phone || "Unnamed"}` });
                    } else if (data.role === "driver") {
                        emit({ type: "new_driver", text: `New driver registered: ${data.name || data.phone || "Unnamed"}` });
                    }
                }
                knownUserIds.add(uid);
            } else if (change.type === "modified" && data.role === "driver" && data.verificationStatus === "suspended") {
                emit({ type: "driver_suspended", text: `Driver suspended: ${data.name || "Unnamed"}` });
            } else if (change.type === "modified" && data.role === "driver" && data.verificationStatus === "blocked") {
                emit({ type: "driver_blocked", text: `Driver blocked: ${data.name || "Unnamed"}` });
            }
        });
        firstUsersSnapshot = false;
    }, (error) => handleListenerError("users", error));
}

// ---------------------------------------------------------------------
// Live ride tracking (single ride, opened from the Live Rides list)
// ---------------------------------------------------------------------

let trackingUnsub = null;
let trackingMap = null;
let driverMarker = null;
let pickupMarker = null;
let dropMarker = null;
let routeLine = null;
let lastPing = null; // {lat,lng,at}

function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

async function ensureGoogleMaps() {
    if (window.google?.maps) return;
    await new Promise((resolve, reject) => {
        if (document.getElementById("admin-google-maps-sdk")) {
            document.getElementById("admin-google-maps-sdk").addEventListener("load", resolve);
            return;
        }
        fetch("/api/google-config")
            .then((r) => r.json())
            .then(({ browserKey }) => {
                const script = document.createElement("script");
                script.id = "admin-google-maps-sdk";
                script.src = `https://maps.googleapis.com/maps/api/js?key=${browserKey}&v=weekly`;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            })
            .catch(reject);
    });
}

/**
 * Renders a live, auto-updating map for one active ride into `container`,
 * plus a text readout element updated with speed/progress.
 * Returns a stop() function -- call it when the panel closes.
 */
export async function trackRideOnMap(container, readoutEl, rideId) {
    stopTracking();
    await ensureGoogleMaps();

    trackingMap = new window.google.maps.Map(container, {
        center: { lat: 23.8315, lng: 91.9882 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
    });

    trackingUnsub = onSnapshot(doc(db, "rides", rideId), (snap) => {
        if (!snap.exists()) return;
        const ride = snap.data();
        const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
        const drop = { lat: ride.drop_lat, lng: ride.drop_lng };
        const driverPos = ride.driverLocation;

        if (pickup.lat && !pickupMarker) {
            pickupMarker = new window.google.maps.Marker({ position: pickup, map: trackingMap, label: "P" });
        }
        if (drop.lat && !dropMarker) {
            dropMarker = new window.google.maps.Marker({ position: drop, map: trackingMap, label: "D" });
        }

        if (driverPos?.lat && driverPos?.lng) {
            if (!driverMarker) {
                driverMarker = new window.google.maps.Marker({
                    position: driverPos,
                    map: trackingMap,
                    icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5, fillColor: "#1A7A2E", fillOpacity: 1, strokeWeight: 1 },
                });
            } else {
                driverMarker.setPosition(driverPos);
            }
            trackingMap.panTo(driverPos);

            if (routeLine) routeLine.setMap(null);
            const path = [pickup, driverPos, drop].filter((p) => p.lat && p.lng);
            routeLine = new window.google.maps.Polyline({ path, map: trackingMap, strokeColor: "#1A7A2E", strokeWeight: 3 });

            let speedKmh = null;
            if (lastPing) {
                const meters = haversineMeters(lastPing, driverPos);
                const seconds = (Date.now() - lastPing.at) / 1000;
                if (seconds > 0.5) speedKmh = Math.round((meters / seconds) * 3.6);
            }
            lastPing = { ...driverPos, at: Date.now() };

            let progressPct = null;
            if (pickup.lat && drop.lat) {
                const total = haversineMeters(pickup, drop);
                const done = haversineMeters(pickup, driverPos);
                if (total > 0) progressPct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
            }
            if (readoutEl) {
                readoutEl.textContent = `${speedKmh != null ? `${speedKmh} km/h` : "Speed: --"} \u00b7 ${
                    progressPct != null ? `${progressPct}% of route` : "Progress: --"
                }`;
            }
        }
    });

    return stopTracking;
}

export function stopTracking() {
    if (trackingUnsub) trackingUnsub();
    trackingUnsub = null;
    driverMarker = null;
    pickupMarker = null;
    dropMarker = null;
    routeLine = null;
    lastPing = null;
}
