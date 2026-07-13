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
const RING_INTERVAL_MS = 1400;

let activeRingTimer = null;
let activeAudio = null;

function buildRingAudio() {
    const audio = new Audio("data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YSAAAACAgICA/v7+/4CAgAAAAP7+/v+AgID+/v7/AAAAAICAgA==");
    audio.loop = false;
    audio.volume = 0.85;
    return audio;
}

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

export function startRideRequestRing() {
    if (activeRingTimer) return;

    const ringOnce = () => {
        try {
            activeAudio = buildRingAudio();
            activeAudio.play().catch(() => {});
        } catch {
            // Browser audio policies can block sound until the driver interacts with the page.
        }
    };

    ringOnce();
    if (navigator.vibrate) {
        navigator.vibrate([350, 180, 350, 600]);
    }
    activeRingTimer = window.setInterval(ringOnce, RING_INTERVAL_MS);
}

export function stopRideRequestRing() {
    if (activeRingTimer) {
        window.clearInterval(activeRingTimer);
        activeRingTimer = null;
    }
    if (activeAudio) {
        activeAudio.pause();
        activeAudio.currentTime = 0;
        activeAudio = null;
    }
    if (navigator.vibrate) navigator.vibrate(0);
}
