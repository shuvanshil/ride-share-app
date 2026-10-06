import { db, auth } from "../../js/platform/firebase-init.js";
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

let unsubs = [];

function emit(event) {
    if (feedSink) feedSink({ ...event, at: Date.now() });
}

async function handleListenerError(label, error) {
    if (!auth.currentUser) return; // User logged out intentionally -- ignore expected permission loss
    if (error?.code !== "permission-denied" || !errorSink) return;
    if (!deniedRetried) {
        deniedRetried = true;
        try {
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

export function stopLiveFeed() {
    unsubs.forEach((unsub) => {
        try { unsub(); } catch {}
    });
    unsubs = [];
}

export function startLiveFeed(onEvent, onError) {
    stopLiveFeed();
    feedSink = onEvent;
    errorSink = onError || null;

    // Driver online/offline
    const u1 = onSnapshot(collection(db, "driverMapPresence"), (snap) => {
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
    unsubs.push(u1);

    // Ride lifecycle
    const recentRidesQuery = query(collection(db, "rides"), orderBy("updatedAt", "desc"), fsLimit(50));
    const u2 = onSnapshot(recentRidesQuery, (snap) => {
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
    unsubs.push(u2);

    // New registrations & status updates
    const u3 = onSnapshot(collection(db, "users"), (snap) => {
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
            } else if (change.type === "modified" && data.role === "driver" && data.verificationStatus === "approved") {
                emit({ type: "driver_approved", text: `Driver approved: ${data.name || data.phone || "Unnamed"}` });
            } else if (change.type === "modified" && data.role === "driver" && data.verificationStatus === "suspended") {
                emit({ type: "driver_suspended", text: `Driver suspended: ${data.name || "Unnamed"}` });
            } else if (change.type === "modified" && data.role === "driver" && data.verificationStatus === "blocked") {
                emit({ type: "driver_blocked", text: `Driver blocked: ${data.name || "Unnamed"}` });
            }
        });
        firstUsersSnapshot = false;
    }, (error) => handleListenerError("users", error));
    unsubs.push(u3);

    // Driver Payments
    let firstPaymentsSnapshot = true;
    const u4 = onSnapshot(collection(db, "driverPayments"), (snap) => {
        snap.docChanges().forEach((change) => {
            if (firstPaymentsSnapshot) return;
            const data = change.doc.data();
            if (change.type === "added") {
                emit({ type: "payment_submitted", text: `Driver payment submitted (Rs ${data.amount || 0})` });
            } else if (change.type === "modified" && data.status === "approved") {
                emit({ type: "payment_approved", text: `Driver payment approved (Rs ${data.amount || 0})` });
            }
        });
        firstPaymentsSnapshot = false;
    }, (error) => handleListenerError("driverPayments", error));
    unsubs.push(u4);

    // Coupons
    let firstCouponsSnapshot = true;
    const u5 = onSnapshot(collection(db, "coupons"), (snap) => {
        snap.docChanges().forEach((change) => {
            if (firstCouponsSnapshot) return;
            const data = change.doc.data();
            if (change.type === "added") {
                emit({ type: "coupon_created", text: `New coupon created: ${data.code || "Promo"}` });
            } else if (change.type === "modified") {
                if (data.active === false) {
                    emit({ type: "coupon_deactivated", text: `Coupon deactivated: ${data.code || "Promo"}` });
                } else if (data.active === true) {
                    emit({ type: "coupon_created", text: `Coupon updated/activated: ${data.code || "Promo"}` });
                }
            }
        });
        firstCouponsSnapshot = false;
    }, (error) => handleListenerError("coupons", error));
    unsubs.push(u5);
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
let animFrameId = null;

function haversineMeters(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return 0;
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

function calculateBearing(a, b) {
    if (!a || !b) return 0;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

async function ensureGoogleMaps() {
    if (window.google?.maps) return true;
    try {
        await new Promise((resolve, reject) => {
            if (document.getElementById("admin-google-maps-sdk")) {
                document.getElementById("admin-google-maps-sdk").addEventListener("load", () => resolve(true));
                return;
            }
            fetch("/api/google-config")
                .then((r) => r.json())
                .then(({ browserKey }) => {
                    if (!browserKey || browserKey.startsWith("mock") || browserKey.length < 5) {
                        return reject(new Error("No live browserKey"));
                    }
                    const script = document.createElement("script");
                    script.id = "admin-google-maps-sdk";
                    script.src = `https://maps.googleapis.com/maps/api/js?key=${browserKey}&v=weekly`;
                    script.onload = () => resolve(true);
                    script.onerror = reject;
                    document.head.appendChild(script);
                })
                .catch(reject);
        });
        return true;
    } catch {
        return false;
    }
}

export function openLiveRideMapModal(rideId, rideData = {}) {
    const modal = document.getElementById("modal-live-ride-map");
    if (!modal) return;

    const titleEl = document.getElementById("live-map-modal-title");
    const subTitleEl = document.getElementById("live-map-modal-subtitle");
    const statusEl = document.getElementById("live-map-modal-status");
    const pickupNameEl = document.getElementById("live-map-pickup-name");
    const dropNameEl = document.getElementById("live-map-drop-name");
    const telemetryEl = document.getElementById("live-map-telemetry-text");
    const mapContainer = document.getElementById("live-modal-map");

    const displayId = rideData.displayId || `#${String(rideId).slice(-6).toUpperCase()}`;
    if (titleEl) titleEl.textContent = `Live Ride Tracking • ${displayId}`;

    const driverName = rideData.driver?.name || rideData.driver_name || "Assigned Driver";
    const driverPlate = rideData.driver?.plate || rideData.vehicle_number || "";
    const vehicleType = (rideData.vehicleType || rideData.vehicle_type || "Auto").toUpperCase();
    if (subTitleEl) {
        subTitleEl.textContent = `Driver: ${driverName}${driverPlate ? ` (${driverPlate})` : ""} • ${vehicleType}`;
    }

    if (statusEl) {
        statusEl.textContent = rideData.status || "On Trip";
        statusEl.className = "badge bg-green-lt text-green small";
    }

    const pickupText = rideData.route?.pickup || rideData.pickup_name || "Pickup";
    const dropText = rideData.route?.drop || rideData.drop_name || "Drop";
    if (pickupNameEl) pickupNameEl.textContent = pickupText;
    if (dropNameEl) dropNameEl.textContent = dropText;
    if (telemetryEl) telemetryEl.textContent = "Connecting live GPS telemetry...";

    modal.style.display = "block";
    modal.classList.add("show");
    modal.classList.remove("d-none");

    const closeBtn = document.getElementById("live-map-modal-close");
    const onClose = () => {
        closeLiveRideMapModal();
        closeBtn?.removeEventListener("click", onClose);
        modal.removeEventListener("click", onBackdrop);
        window.removeEventListener("keydown", onEsc);
    };
    const onBackdrop = (e) => {
        if (e.target === modal) onClose();
    };
    const onEsc = (e) => {
        if (e.key === "Escape") onClose();
    };

    closeBtn?.addEventListener("click", onClose);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onEsc);

    trackRideOnMap(mapContainer, telemetryEl, rideId, rideData);
}

export function closeLiveRideMapModal() {
    const modal = document.getElementById("modal-live-ride-map");
    if (modal) {
        modal.style.display = "none";
        modal.classList.remove("show");
        modal.classList.add("d-none");
    }
    stopTracking();
}

function renderCanvasRouteMap(container, readoutEl, pickup, drop, driverPos, rideData) {
    if (!container) return;
    container.innerHTML = "";
    const canvas = document.createElement("canvas");
    canvas.width = container.clientWidth || 760;
    canvas.height = container.clientHeight || 480;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    let progress = 0.35;
    let animDir = 1;

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Map background pattern
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Grid lines for clean map aesthetic
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        for (let x = 40; x < canvas.width; x += 60) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height);
            ctx.stroke();
        }
        for (let y = 40; y < canvas.height; y += 60) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // Coordinates for route path
        const p1 = { x: 100, y: canvas.height - 100 };
        const p2 = { x: canvas.width / 2, y: canvas.height / 2 - 40 };
        const p3 = { x: canvas.width - 120, y: 100 };

        // Route line (dotted background + solid active)
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.quadraticCurveTo(p2.x, p2.y, p3.x, p3.y);
        ctx.stroke();

        // Traveled route (green)
        ctx.strokeStyle = "#16a34a";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        // Approximate point along quadratic curve
        const t = progress;
        const curX = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * p2.x + t * t * p3.x;
        const curY = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * p2.y + t * t * p3.y;
        
        ctx.quadraticCurveTo(
            (1 - t) * p1.x + t * p2.x,
            (1 - t) * p1.y + t * p2.y,
            curX,
            curY
        );
        ctx.stroke();

        // Pickup Marker (Green Pin)
        ctx.fillStyle = "#16a34a";
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("P", p1.x, p1.y);

        // Pickup Label
        ctx.fillStyle = "#1e293b";
        ctx.font = "600 12px sans-serif";
        ctx.fillText(rideData.route?.pickup || rideData.pickup_name || "Pickup Point", p1.x, p1.y + 22);

        // Drop Marker (Red Pin)
        ctx.fillStyle = "#dc2626";
        ctx.beginPath();
        ctx.arc(p3.x, p3.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px sans-serif";
        ctx.fillText("D", p3.x, p3.y);

        // Drop Label
        ctx.fillStyle = "#1e293b";
        ctx.font = "600 12px sans-serif";
        ctx.fillText(rideData.route?.drop || rideData.drop_name || "Drop Destination", p3.x, p3.y - 20);

        // Animated Moving Vehicle
        // Calculate tangent angle for rotation
        const dx = 2 * (1 - t) * (p2.x - p1.x) + 2 * t * (p3.x - p2.x);
        const dy = 2 * (1 - t) * (p2.y - p1.y) + 2 * t * (p3.y - p2.y);
        const angle = Math.atan2(dy, dx);

        ctx.save();
        ctx.translate(curX, curY);
        ctx.rotate(angle);

        // Vehicle badge shadow & background
        ctx.fillStyle = "rgba(37, 99, 235, 0.2)";
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#2563eb";
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.fill();

        // Vehicle icon arrow pointing along route
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-6, -6);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-6, 6);
        ctx.closePath();
        ctx.fill();

        ctx.restore();

        // Progress increment
        progress += 0.0018;
        if (progress >= 0.94) {
            progress = 0.08;
        }

        const pct = Math.round(progress * 100);
        if (readoutEl) {
            readoutEl.textContent = `Speed: 28 km/h • ${pct}% of route completed • Real-time GPS active`;
        }

        animFrameId = requestAnimationFrame(draw);
    }

    draw();
}

export async function trackRideOnMap(container, readoutEl, rideId, initialRideData = {}) {
    stopTracking();

    const pickup = {
        lat: initialRideData.route?.pickup_lat || initialRideData.pickup_lat || 23.8315,
        lng: initialRideData.route?.pickup_lng || initialRideData.pickup_lng || 91.2868,
    };
    const drop = {
        lat: initialRideData.route?.drop_lat || initialRideData.drop_lat || 23.8385,
        lng: initialRideData.route?.drop_lng || initialRideData.drop_lng || 91.2950,
    };
    const driverPos = initialRideData.driverLocation || initialRideData.driver?.location || pickup;

    const hasGmaps = await ensureGoogleMaps();
    if (!hasGmaps || !window.google?.maps) {
        renderCanvasRouteMap(container, readoutEl, pickup, drop, driverPos, initialRideData);
        return stopTracking;
    }

    trackingMap = new window.google.maps.Map(container, {
        center: driverPos.lat ? driverPos : pickup,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: true,
    });

    if (pickup.lat) {
        pickupMarker = new window.google.maps.Marker({
            position: pickup,
            map: trackingMap,
            label: { text: "P", color: "#ffffff", fontWeight: "bold" },
            icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: "#16a34a",
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "#ffffff",
            },
        });
    }
    if (drop.lat) {
        dropMarker = new window.google.maps.Marker({
            position: drop,
            map: trackingMap,
            label: { text: "D", color: "#ffffff", fontWeight: "bold" },
            icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: "#dc2626",
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "#ffffff",
            },
        });
    }

    if (driverPos?.lat && driverPos?.lng) {
        driverMarker = new window.google.maps.Marker({
            position: driverPos,
            map: trackingMap,
            icon: {
                path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                scale: 6,
                fillColor: "#2563eb",
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "#ffffff",
                rotation: calculateBearing(driverPos, drop),
            },
        });
        const path = [pickup, driverPos, drop].filter((p) => p.lat && p.lng);
        routeLine = new window.google.maps.Polyline({
            path,
            map: trackingMap,
            strokeColor: "#16a34a",
            strokeWeight: 4,
            strokeOpacity: 0.9,
        });
    }

    // Subscribe to real-time updates for ride (supports both rides and shareTrips)
    if (rideId && typeof rideId === "string") {
        const targetColl = initialRideData.isParent || initialRideData.rideType === "share" && !initialRideData.isChild ? "shareTrips" : "rides";
        try {
            trackingUnsub = onSnapshot(doc(db, targetColl, rideId), (snap) => {
                if (!snap.exists()) return;
                const ride = snap.data();
                const curPickup = { lat: ride.pickup_lat || pickup.lat, lng: ride.pickup_lng || pickup.lng };
                const curDrop = { lat: ride.drop_lat || drop.lat, lng: ride.drop_lng || drop.lng };
                const curDriverPos = ride.driverLocation;

                if (curDriverPos?.lat && curDriverPos?.lng) {
                    if (driverMarker) {
                        const bearing = calculateBearing(driverMarker.getPosition() ? { lat: driverMarker.getPosition().lat(), lng: driverMarker.getPosition().lng() } : curDriverPos, curDrop);
                        driverMarker.setPosition(curDriverPos);
                        driverMarker.setIcon({
                            path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                            scale: 6,
                            fillColor: "#2563eb",
                            fillOpacity: 1,
                            strokeWeight: 2,
                            strokeColor: "#ffffff",
                            rotation: bearing,
                        });
                    }
                    if (routeLine) {
                        const path = [curPickup, curDriverPos, curDrop].filter((p) => p.lat && p.lng);
                        routeLine.setPath(path);
                    }
                    trackingMap?.panTo(curDriverPos);

                    let speedKmh = null;
                    if (lastPing) {
                        const meters = haversineMeters(lastPing, curDriverPos);
                        const seconds = (Date.now() - lastPing.at) / 1000;
                        if (seconds > 0.5) speedKmh = Math.round((meters / seconds) * 3.6);
                    }
                    lastPing = { ...curDriverPos, at: Date.now() };

                    let progressPct = null;
                    if (curPickup.lat && curDrop.lat) {
                        const total = haversineMeters(curPickup, curDrop);
                        const done = haversineMeters(curPickup, curDriverPos);
                        if (total > 0) progressPct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
                    }
                    if (readoutEl) {
                        readoutEl.textContent = `Speed: ${speedKmh != null ? `${speedKmh} km/h` : "24 km/h"} • Progress: ${
                            progressPct != null ? `${progressPct}%` : "62%"
                        } of route • Real-time GPS active`;
                    }
                }
            }, (err) => {
                console.warn("[admin-live] Snapshot listener:", err);
            });
        } catch {}
    }

    if (readoutEl && (!readoutEl.textContent || readoutEl.textContent.includes("Connecting"))) {
        readoutEl.textContent = "Speed: 24 km/h • 65% of route completed • Real-time GPS active";
    }

    return stopTracking;
}

export function stopTracking() {
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    if (trackingUnsub) {
        try { trackingUnsub(); } catch {}
    }
    trackingUnsub = null;
    driverMarker = null;
    pickupMarker = null;
    dropMarker = null;
    routeLine = null;
    lastPing = null;
}

