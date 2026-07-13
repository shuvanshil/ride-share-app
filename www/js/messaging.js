import { app } from './firebase-init.js';
import {
    doc,
    setDoc,
    serverTimestamp,
    arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    getMessaging,
    getToken,
    isSupported
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

const DRIVER_PUSH_VAPID_KEY = "BJXKOjn7PQPRpnLMcXW5xe_blAib33GSjpIpTzQtH5Pw7IzxxNaWpwgGox7QxQFaObpvhSrc1vck4uY4bRrCkSl";
let lastOpenNotificationAt = 0;

export async function registerDriverPushToken(db, uid) {
    if (!uid || !("Notification" in window) || !("serviceWorker" in navigator)) {
        return { ok: false, reason: "unsupported" };
    }

    const supported = await isSupported().catch(() => false);
    if (!supported) return { ok: false, reason: "messaging-unsupported" };

    const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();

    if (permission !== "granted") {
        await setDoc(doc(db, "driverPresence", uid), {
            notificationPermission: permission,
            pushUpdatedAt: serverTimestamp()
        }, { merge: true });
        return { ok: false, reason: permission };
    }

    const registration = await navigator.serviceWorker.ready;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
        vapidKey: DRIVER_PUSH_VAPID_KEY,
        serviceWorkerRegistration: registration
    });

    if (!token) return { ok: false, reason: "empty-token" };

    const tokenData = {
        token,
        userAgent: navigator.userAgent,
        updatedAt: new Date().toISOString()
    };

    await Promise.allSettled([
        setDoc(doc(db, "users", uid), {
            pushTokens: arrayUnion(token),
            pushTokenDetails: arrayUnion(tokenData),
            notificationPermission: "granted",
            pushUpdatedAt: serverTimestamp()
        }, { merge: true }),
        setDoc(doc(db, "driverPresence", uid), {
            pushTokens: arrayUnion(token),
            pushTokenDetails: arrayUnion(tokenData),
            notificationPermission: "granted",
            pushUpdatedAt: serverTimestamp()
        }, { merge: true })
    ]);

    return { ok: true, token };
}

export function startRideRequestRing(ride = {}) {
    const now = Date.now();
    if (now - lastOpenNotificationAt < 5000) return;
    lastOpenNotificationAt = now;

    if (navigator.vibrate) {
        navigator.vibrate([350, 180, 350, 180, 700]);
    }

    showRideRequestNotification(ride).catch((error) => {
        console.warn("Open ride notification failed:", error);
    });
}

export async function showRideRequestNotification(ride = {}) {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    if (Notification.permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    const rideId = ride.rideId || ride.id || "";
    const url = new URL("driver.html", window.location.href);
    if (rideId) url.searchParams.set("rideId", rideId);
    url.searchParams.set("from", "open-alert");

    await registration.showNotification("New LiphtUp ride request", {
        body: ride.body || "Open LiphtUp to view and accept this ride.",
        icon: new URL("assets/icons/liphtup-icon-192.png", window.location.href).href,
        badge: new URL("assets/icons/liphtup-icon-192.png", window.location.href).href,
        tag: rideId ? `liphtup-ride-${rideId}` : "liphtup-ride-request-open",
        renotify: true,
        requireInteraction: true,
        vibrate: [350, 180, 350, 180, 700],
        data: {
            rideId,
            url: url.href
        },
        actions: [
            { action: "open", title: "Open ride" }
        ]
    });
}

export function stopRideRequestRing() {
    if (navigator.vibrate) {
        navigator.vibrate(0);
    }
}
