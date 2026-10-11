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

    // Driver online/offline (bounded to 100 active presence docs)
    const driverPresenceQuery = query(collection(db, "driverMapPresence"), fsLimit(100));
    const u1 = onSnapshot(driverPresenceQuery, (snap) => {
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

    // Ride lifecycle (bounded to 50 most recently updated rides)
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
                emit({ type: `ride_${data.status}`, text: `${label} \u00b7 ${data.pickupName || data.pickup_name || "ride"} \u2192 ${data.dropName || data.drop_name || ""}` });
            }
            if (data.payment_status === "paid" && prevStatus !== undefined) {
                emit({ type: "payment_completed", text: `Payment completed for a ride (Rs ${data.fare || 0})` });
            }
        });
        firstRidesSnapshot = false;
    }, (error) => handleListenerError("rides", error));
    unsubs.push(u2);

    // New registrations & status updates (bounded to 50 newest users)
    const recentUsersQuery = query(collection(db, "users"), orderBy("createdAt", "desc"), fsLimit(50));
    const u3 = onSnapshot(recentUsersQuery, (snap) => {
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

    // Driver Payments (bounded to 50 most recent submissions)
    let firstPaymentsSnapshot = true;
    const recentPaymentsQuery = query(collection(db, "driverPayments"), orderBy("submittedAt", "desc"), fsLimit(50));
    const u4 = onSnapshot(recentPaymentsQuery, (snap) => {
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

    // Coupons (bounded to 50 docs)
    let firstCouponsSnapshot = true;
    const recentCouponsQuery = query(collection(db, "coupons"), fsLimit(50));
    const u5 = onSnapshot(recentCouponsQuery, (snap) => {
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

export async function ensureGoogleMaps() {
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
    if (telemetryEl) telemetryEl.textContent = "Checking live GPS telemetry...";

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
    const hasRealDriverGps = Boolean(
        driverPos &&
        typeof driverPos.lat === "number" &&
        typeof driverPos.lng === "number" &&
        (driverPos.lat !== pickup.lat || driverPos.lng !== pickup.lng)
    );

    let progress = null;
    if (hasRealDriverGps && pickup?.lat && drop?.lat) {
        const totalDist = haversineMeters(pickup, drop);
        const coveredDist = haversineMeters(pickup, driverPos);
        if (totalDist > 0) {
            progress = Math.max(0.05, Math.min(0.95, coveredDist / totalDist));
        }
    }

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

    // Coordinates for static route path
    const p1 = { x: 110, y: canvas.height - 110 };
    const p2 = { x: canvas.width / 2, y: canvas.height / 2 - 35 };
    const p3 = { x: canvas.width - 130, y: 110 };

    // Route line
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 5;
    ctx.setLineDash([8, 6]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // If real driver GPS progress is known, highlight traveled segment
    if (progress !== null) {
        const t = progress;
        const curX = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * p2.x + t * t * p3.x;
        const curY = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * p2.y + t * t * p3.y;

        ctx.strokeStyle = "#16a34a";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.quadraticCurveTo((1 - t) * p1.x + t * p2.x, (1 - t) * p1.y + t * p2.y, curX, curY);
        ctx.stroke();

        // Static Driver Position Marker
        ctx.fillStyle = "rgba(37, 99, 235, 0.2)";
        ctx.beginPath();
        ctx.arc(curX, curY, 18, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#2563eb";
        ctx.beginPath();
        ctx.arc(curX, curY, 12, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("DRV", curX, curY);

        ctx.fillStyle = "#1e40af";
        ctx.font = "600 11px sans-serif";
        ctx.fillText(
            `Driver (${Number(driverPos.lat).toFixed(4)}, ${Number(driverPos.lng).toFixed(4)})`,
            curX,
            curY - 22
        );
    }

    // Pickup Marker (Green Pin)
    ctx.fillStyle = "#16a34a";
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("P", p1.x, p1.y);

    // Pickup Label & Coords
    ctx.fillStyle = "#1e293b";
    ctx.font = "600 12px sans-serif";
    ctx.fillText(rideData.route?.pickup || rideData.pickup_name || "Pickup Point", p1.x, p1.y + 22);
    if (pickup?.lat && pickup?.lng) {
        ctx.fillStyle = "#64748b";
        ctx.font = "11px sans-serif";
        ctx.fillText(`(${Number(pickup.lat).toFixed(4)}, ${Number(pickup.lng).toFixed(4)})`, p1.x, p1.y + 38);
    }

    // Drop Marker (Red Pin)
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(p3.x, p3.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("D", p3.x, p3.y);

    // Drop Label & Coords
    ctx.fillStyle = "#1e293b";
    ctx.font = "600 12px sans-serif";
    ctx.fillText(rideData.route?.drop || rideData.drop_name || "Drop Destination", p3.x, p3.y - 24);
    if (drop?.lat && drop?.lng) {
        ctx.fillStyle = "#64748b";
        ctx.font = "11px sans-serif";
        ctx.fillText(`(${Number(drop.lat).toFixed(4)}, ${Number(drop.lng).toFixed(4)})`, p3.x, p3.y - 10);
    }

    // Direct distance badge in center
    if (pickup?.lat && drop?.lat) {
        const directKm = (haversineMeters(pickup, drop) / 1000).toFixed(2);
        ctx.fillStyle = "#334155";
        ctx.font = "600 12px sans-serif";
        ctx.fillText(`Direct route distance: ${directKm} km (Static Map View)`, canvas.width / 2, 24);
    }

    if (readoutEl) {
        if (hasRealDriverGps) {
            const pct = progress !== null ? `${Math.round(progress * 100)}% of direct distance` : "Coordinates reported";
            readoutEl.textContent = `Last reported driver GPS: (${Number(driverPos.lat).toFixed(4)}, ${Number(driverPos.lng).toFixed(4)}) • ${pct} • Static route view`;
        } else {
            readoutEl.textContent = "Live GPS telemetry unavailable for this ride • Showing static pickup & drop route";
        }
    }
}

export async function trackRideOnMap(container, readoutEl, rideId, initialRideData = {}) {
    stopTracking();

    const pickup = {
        lat: Number(initialRideData.route?.pickup_lat ?? initialRideData.pickup_lat) || 23.8315,
        lng: Number(initialRideData.route?.pickup_lng ?? initialRideData.pickup_lng) || 91.2868,
    };
    const drop = {
        lat: Number(initialRideData.route?.drop_lat ?? initialRideData.drop_lat) || 23.8385,
        lng: Number(initialRideData.route?.drop_lng ?? initialRideData.drop_lng) || 91.2950,
    };
    const rawDriverLoc = initialRideData.driverLocation || initialRideData.driver?.location || null;
    const driverPos =
        rawDriverLoc && rawDriverLoc.lat != null && rawDriverLoc.lng != null
            ? { lat: Number(rawDriverLoc.lat), lng: Number(rawDriverLoc.lng) }
            : null;

    const hasGmaps = await ensureGoogleMaps();
    if (!hasGmaps || !window.google?.maps) {
        renderCanvasRouteMap(container, readoutEl, pickup, drop, driverPos, initialRideData);
        return stopTracking;
    }

    trackingMap = new window.google.maps.Map(container, {
        center: driverPos || pickup,
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
    }

    const initialPath = [pickup, ...(driverPos ? [driverPos] : []), drop].filter((p) => p && p.lat && p.lng);
    routeLine = new window.google.maps.Polyline({
        path: initialPath,
        map: trackingMap,
        strokeColor: "#16a34a",
        strokeWeight: 4,
        strokeOpacity: 0.9,
    });

    if (readoutEl) {
        if (driverPos) {
            readoutEl.textContent = `Last reported driver GPS: (${driverPos.lat.toFixed(4)}, ${driverPos.lng.toFixed(4)}) • Listening for live telemetry...`;
        } else {
            readoutEl.textContent = "No live driver GPS coordinates reported yet • Listening for telemetry updates...";
        }
    }

    // Subscribe to real-time updates for ride (supports both rides and shareTrips)
    if (rideId && typeof rideId === "string") {
        const targetColl =
            initialRideData.isParent || (initialRideData.rideType === "share" && !initialRideData.isChild)
                ? "shareTrips"
                : "rides";
        try {
            trackingUnsub = onSnapshot(doc(db, targetColl, rideId), (snap) => {
                if (!snap.exists()) return;
                const ride = snap.data();
                const curPickup = { lat: Number(ride.pickup_lat) || pickup.lat, lng: Number(ride.pickup_lng) || pickup.lng };
                const curDrop = { lat: Number(ride.drop_lat) || drop.lat, lng: Number(ride.drop_lng) || drop.lng };
                const curDriverPos =
                    ride.driverLocation && ride.driverLocation.lat != null && ride.driverLocation.lng != null
                        ? { lat: Number(ride.driverLocation.lat), lng: Number(ride.driverLocation.lng) }
                        : null;

                if (curDriverPos) {
                    if (driverMarker) {
                        const prevPos = driverMarker.getPosition()
                            ? { lat: driverMarker.getPosition().lat(), lng: driverMarker.getPosition().lng() }
                            : curDriverPos;
                        const bearing = calculateBearing(prevPos, curDrop);
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
                    } else if (trackingMap) {
                        driverMarker = new window.google.maps.Marker({
                            position: curDriverPos,
                            map: trackingMap,
                            icon: {
                                path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                                scale: 6,
                                fillColor: "#2563eb",
                                fillOpacity: 1,
                                strokeWeight: 2,
                                strokeColor: "#ffffff",
                                rotation: calculateBearing(curDriverPos, curDrop),
                            },
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
                        const speedText = speedKmh != null ? `Speed: ${speedKmh} km/h` : `GPS: (${curDriverPos.lat.toFixed(4)}, ${curDriverPos.lng.toFixed(4)})`;
                        const progText = progressPct != null ? `${progressPct}% of direct route` : "Route active";
                        readoutEl.textContent = `${speedText} • ${progText} • Live GPS telemetry active`;
                    }
                }
            }, (err) => {
                console.warn("[admin-live] Snapshot listener:", err);
            });
        } catch {}
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

// ---------------------------------------------------------------------
// Priority 1: Unified "God View" Live Fleet & Demand Map
// ---------------------------------------------------------------------

export async function renderGodViewMap(container, mapData = {}, filters = {}, callbacks = {}) {
    if (!container) return;
    const showOnline = filters.showOnlineDrivers !== false;
    const showBusy = filters.showBusyDrivers !== false;
    const showWaiting = filters.showWaitingPassengers !== false;
    const showRides = filters.showActiveRides !== false;
    const vehicleFilter = (filters.vehicleType || "all").toLowerCase();

    const drivers = (mapData.drivers || []).filter((d) => {
        if (d.status === "online" && !showOnline) return false;
        if (d.status === "busy" && !showBusy) return false;
        if (vehicleFilter !== "all" && String(d.vehicleType || "").toLowerCase() !== vehicleFilter) return false;
        return true;
    });
    const waitingPassengers = showWaiting
        ? (mapData.waitingPassengers || []).filter((p) => {
              if (vehicleFilter === "all") return true;
              return String(p.vehicleType || p.type || "").toLowerCase() === vehicleFilter;
          })
        : [];
    const activeRides = showRides
        ? (mapData.activeRides || []).filter((r) => {
              if (vehicleFilter === "all") return true;
              return String(r.vehicleType || "").toLowerCase() === vehicleFilter;
          })
        : [];

    const modeLabelEl = document.getElementById("god-map-mode-label");
    const hasGmaps = await ensureGoogleMaps();
    if (hasGmaps && window.google?.maps) {
        if (modeLabelEl) modeLabelEl.textContent = "Google Maps Live View";
        container.innerHTML = "";
        const map = new window.google.maps.Map(container, {
            center: { lat: 23.8315, lng: 91.2868 },
            zoom: 13,
            disableDefaultUI: false,
            mapTypeControl: false,
            streetViewControl: false,
        });
        const infoWin = new window.google.maps.InfoWindow();
        const bounds = new window.google.maps.LatLngBounds();
        let hasPoints = false;

        drivers.forEach((d) => {
            const lat = Number(d.lat);
            const lng = Number(d.lng);
            if (!lat || !lng) return;
            hasPoints = true;
            bounds.extend({ lat, lng });
            const isBusy = d.status === "busy";
            const marker = new window.google.maps.Marker({
                position: { lat, lng },
                map,
                title: `${d.name} (${d.status})`,
                label: { text: isBusy ? "B" : "D", color: "#ffffff", fontWeight: "bold", fontSize: "11px" },
                icon: {
                    path: window.google.maps.SymbolPath.CIRCLE,
                    scale: 11,
                    fillColor: isBusy ? "#2563eb" : "#16a34a",
                    fillOpacity: 1,
                    strokeWeight: 2,
                    strokeColor: "#ffffff",
                },
            });
            marker.addListener("click", () => {
                const div = document.createElement("div");
                div.style.cssText = "min-width:190px;padding:4px;";
                div.innerHTML = `
                    <div style="font-weight:700;color:#0f172a;">${d.name || "Driver"}</div>
                    <div style="font-size:12px;color:#64748b;">${d.plate || "No Plate"} • ${(d.vehicleType || "auto").toUpperCase()}</div>
                    <div style="font-size:12px;margin-top:4px;">Status: <strong>${isBusy ? "On Trip" : "Online / Idle"}</strong></div>
                    ${d.idleTimeText ? `<div style="font-size:11px;color:#475569;">Idle: ${d.idleTimeText}</div>` : ""}
                    <button type="button" class="btn btn-sm btn-outline-primary w-100 mt-2 gm-driver-btn">Driver Profile</button>
                `;
                div.querySelector(".gm-driver-btn")?.addEventListener("click", () => {
                    infoWin.close();
                    if (callbacks.onSelectDriver) callbacks.onSelectDriver(d);
                });
                infoWin.setContent(div);
                infoWin.open(map, marker);
            });
        });

        waitingPassengers.forEach((p) => {
            const lat = Number(p.pickup_lat);
            const lng = Number(p.pickup_lng);
            if (!lat || !lng) return;
            hasPoints = true;
            bounds.extend({ lat, lng });
            const isUrgent = Number(p.waitTimeMinutes || 0) >= 15;
            const marker = new window.google.maps.Marker({
                position: { lat, lng },
                map,
                title: `Waiting: ${p.name}`,
                label: { text: "W", color: "#ffffff", fontWeight: "bold", fontSize: "11px" },
                icon: {
                    path: window.google.maps.SymbolPath.CIRCLE,
                    scale: 12,
                    fillColor: isUrgent ? "#dc2626" : "#d97706",
                    fillOpacity: 1,
                    strokeWeight: 2,
                    strokeColor: "#ffffff",
                },
            });
            marker.addListener("click", () => {
                const div = document.createElement("div");
                div.style.cssText = "min-width:210px;padding:4px;";
                div.innerHTML = `
                    <div style="font-weight:700;color:#0f172a;">${p.name || "Waiting Passenger"}</div>
                    <div style="font-size:12px;color:#64748b;">${p.pickupLocation || "Pickup"}</div>
                    <div style="font-size:12px;margin-top:4px;color:#b45309;font-weight:600;">Waiting: ${p.waitTimeText || "1 min"} (${p.type || "Auto"})</div>
                    <button type="button" class="btn btn-sm btn-primary w-100 mt-2 gm-assign-btn">Assign Driver</button>
                `;
                div.querySelector(".gm-assign-btn")?.addEventListener("click", () => {
                    infoWin.close();
                    if (callbacks.onAssignPassenger) callbacks.onAssignPassenger(p);
                });
                infoWin.setContent(div);
                infoWin.open(map, marker);
            });
        });

        activeRides.forEach((r) => {
            const pLat = Number(r.route?.pickup_lat);
            const pLng = Number(r.route?.pickup_lng);
            const dLat = Number(r.route?.drop_lat);
            const dLng = Number(r.route?.drop_lng);
            if (pLat && pLng && dLat && dLng) {
                hasPoints = true;
                bounds.extend({ lat: pLat, lng: pLng });
                bounds.extend({ lat: dLat, lng: dLng });
                const poly = new window.google.maps.Polyline({
                    path: [
                        { lat: pLat, lng: pLng },
                        { lat: dLat, lng: dLng },
                    ],
                    map,
                    strokeColor: r.rideType === "share" ? "#7c3aed" : "#2563eb",
                    strokeOpacity: 0.75,
                    strokeWeight: 3,
                });
                poly.addListener("click", () => {
                    if (callbacks.onSelectRide) callbacks.onSelectRide(r);
                });
            }
        });

        if (hasPoints) {
            map.fitBounds(bounds);
        }
        return;
    }

    if (modeLabelEl) modeLabelEl.textContent = "Coordinate Map Active";

    // Fallback: Interactive Coordinate Canvas & Live Fleet Overlay when Google Maps API key is not configured
    container.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "position-relative w-100 h-100 d-flex flex-column";
    wrapper.style.minHeight = "440px";
    wrapper.style.background = "#f8fafc";

    const canvas = document.createElement("canvas");
    canvas.width = container.clientWidth || 880;
    canvas.height = 440;
    canvas.style.width = "100%";
    canvas.style.height = "440px";
    canvas.style.display = "block";
    canvas.style.cursor = "pointer";
    wrapper.appendChild(canvas);

    const tooltip = document.createElement("div");
    tooltip.className = "card shadow-sm border p-2 position-absolute d-none";
    tooltip.style.cssText = "z-index:20; min-width:220px; max-width:280px; pointer-events:auto;";
    wrapper.appendChild(tooltip);
    container.appendChild(wrapper);

    const ctx = canvas.getContext("2d");

    // Collect all valid coordinates to compute bounding box around Agartala (23.8315, 91.2868)
    const allCoords = [];
    drivers.forEach((d) => {
        if (d.lat && d.lng) allCoords.push({ lat: Number(d.lat), lng: Number(d.lng) });
    });
    waitingPassengers.forEach((p) => {
        if (p.pickup_lat && p.pickup_lng) allCoords.push({ lat: Number(p.pickup_lat), lng: Number(p.pickup_lng) });
    });
    activeRides.forEach((r) => {
        if (r.route?.pickup_lat && r.route?.pickup_lng) {
            allCoords.push({ lat: Number(r.route.pickup_lat), lng: Number(r.route.pickup_lng) });
        }
        if (r.route?.drop_lat && r.route?.drop_lng) {
            allCoords.push({ lat: Number(r.route.drop_lat), lng: Number(r.route.drop_lng) });
        }
    });

    if (allCoords.length === 0) {
        allCoords.push({ lat: 23.8200, lng: 91.2700 }, { lat: 23.8450, lng: 91.3050 });
    }

    let minLat = Math.min(...allCoords.map((c) => c.lat));
    let maxLat = Math.max(...allCoords.map((c) => c.lat));
    let minLng = Math.min(...allCoords.map((c) => c.lng));
    let maxLng = Math.max(...allCoords.map((c) => c.lng));

    if (Math.abs(maxLat - minLat) < 0.01) {
        minLat -= 0.008;
        maxLat += 0.008;
    }
    if (Math.abs(maxLng - minLng) < 0.01) {
        minLng -= 0.008;
        maxLng += 0.008;
    }

    const pad = 55;
    const project = (lat, lng, idx = 0) => {
        if (!lat || !lng) {
            // Deterministic spread if exact GPS is missing on a doc
            const col = idx % 5;
            const row = Math.floor(idx / 5);
            return {
                x: pad + 60 + col * ((canvas.width - pad * 2 - 100) / 4),
                y: pad + 50 + row * 70,
            };
        }
        const xRatio = (Number(lng) - minLng) / (maxLng - minLng);
        const yRatio = 1 - (Number(lat) - minLat) / (maxLat - minLat);
        return {
            x: Math.round(pad + xRatio * (canvas.width - pad * 2)),
            y: Math.round(pad + yRatio * (canvas.height - pad * 2)),
        };
    };

    // Draw background grid
    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

    // Draw active ride route lines
    activeRides.forEach((r, idx) => {
        const p1 = project(r.route?.pickup_lat, r.route?.pickup_lng, idx);
        const p2 = project(r.route?.drop_lat, r.route?.drop_lng, idx + 3);
        ctx.strokeStyle = r.rideType === "share" ? "#7c3aed" : "#3b82f6";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    const hitTargets = [];

    // Draw drivers
    drivers.forEach((d, idx) => {
        const pt = project(d.lat, d.lng, idx);
        const isBusy = d.status === "busy";
        ctx.fillStyle = isBusy ? "rgba(37, 99, 235, 0.18)" : "rgba(22, 163, 74, 0.18)";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 17, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = isBusy ? "#2563eb" : "#16a34a";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(isBusy ? "B" : "D", pt.x, pt.y);

        ctx.fillStyle = "#1e293b";
        ctx.font = "600 11px sans-serif";
        ctx.fillText(d.name || "Driver", pt.x, pt.y + 20);

        hitTargets.push({ x: pt.x, y: pt.y, r: 16, kind: "driver", item: d });
    });

    // Draw waiting passengers
    waitingPassengers.forEach((p, idx) => {
        const pt = project(p.pickup_lat, p.pickup_lng, idx + drivers.length + 2);
        const isUrgent = Number(p.waitTimeMinutes || 0) >= 15;
        ctx.fillStyle = isUrgent ? "rgba(220, 38, 38, 0.2)" : "rgba(217, 119, 6, 0.2)";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 18, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = isUrgent ? "#dc2626" : "#d97706";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("W", pt.x, pt.y);

        ctx.fillStyle = "#7c2d12";
        ctx.font = "600 11px sans-serif";
        ctx.fillText(`${p.name || "Passenger"} (${p.waitTimeText || "1m"})`, pt.x, pt.y - 18);

        hitTargets.push({ x: pt.x, y: pt.y, r: 16, kind: "passenger", item: p });
    });

    if (drivers.length === 0 && waitingPassengers.length === 0 && activeRides.length === 0) {
        ctx.fillStyle = "#64748b";
        ctx.font = "600 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No active drivers, waiting passengers, or live rides match current filters.", canvas.width / 2, canvas.height / 2);
    }

    canvas.addEventListener("click", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (ev.clientX - rect.left) * scaleX;
        const my = (ev.clientY - rect.top) * scaleY;

        const hit = hitTargets.find((t) => Math.hypot(t.x - mx, t.y - my) <= t.r + 4);
        if (!hit) {
            tooltip.classList.add("d-none");
            return;
        }

        tooltip.style.left = `${Math.min(rect.width - 250, Math.max(12, ev.clientX - rect.left + 10))}px`;
        tooltip.style.top = `${Math.min(rect.height - 140, Math.max(12, ev.clientY - rect.top + 10))}px`;
        tooltip.classList.remove("d-none");

        if (hit.kind === "driver") {
            const d = hit.item;
            tooltip.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div class="fw-bold text-dark">${d.name || "Driver"}</div>
                    <span class="badge ${d.status === "busy" ? "bg-blue-lt text-blue" : "bg-green-lt text-green"}">${d.status === "busy" ? "On Trip" : "Online"}</span>
                </div>
                <div class="text-secondary small mt-1">${d.plate || "No Plate"} • ${(d.vehicleType || "auto").toUpperCase()}</div>
                <div class="text-secondary small">${d.currentLocation || ""}</div>
                ${d.idleTimeText ? `<div class="text-muted small mt-1">Idle: ${d.idleTimeText}</div>` : ""}
                <button type="button" class="btn btn-sm btn-outline-primary w-100 mt-2 canvas-driver-btn">
                    <i class="ti ti-id me-1"></i>Driver Profile
                </button>
            `;
            tooltip.querySelector(".canvas-driver-btn")?.addEventListener("click", () => {
                tooltip.classList.add("d-none");
                if (callbacks.onSelectDriver) callbacks.onSelectDriver(d);
            });
        } else if (hit.kind === "passenger") {
            const p = hit.item;
            tooltip.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div class="fw-bold text-dark">${p.name || "Waiting Passenger"}</div>
                    <span class="badge bg-amber-lt text-amber">${p.waitTimeText || "Waiting"}</span>
                </div>
                <div class="text-secondary small mt-1">Pickup: ${p.pickupLocation || "Pickup"}</div>
                <div class="text-secondary small">Type: ${p.type || "Auto"}</div>
                <button type="button" class="btn btn-sm btn-primary w-100 mt-2 canvas-assign-btn">
                    <i class="ti ti-steering-wheel me-1"></i>Assign Driver
                </button>
            `;
            tooltip.querySelector(".canvas-assign-btn")?.addEventListener("click", () => {
                tooltip.classList.add("d-none");
                if (callbacks.onAssignPassenger) callbacks.onAssignPassenger(p);
            });
        }
    });
}


