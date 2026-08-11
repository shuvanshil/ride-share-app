import { app, auth } from './firebase-init.js';
import {
    getMessaging,
    getToken,
    isSupported
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

const DRIVER_PUSH_VAPID_KEY = "BJXKOjn7PQPRpnLMcXW5xe_blAib33GSjpIpTzQtH5Pw7IzxxNaWpwgGox7QxQFaObpvhSrc1vck4uY4bRrCkSl";

/**
 * Checks if the app is running in a native (Capacitor) environment.
 */
function isNative() {
    return !!(window.LIPHTUP_IS_NATIVE && window.LiphtUpNative);
}

/**
 * Registers for push notifications.
 * Returns the token if successful, or an object with error reason.
 */
export async function registerForPush() {
    if (isNative()) {
        console.log("[platform/notifications] registering native push...");
        try {
            const token = await window.LiphtUpNative.registerPushNotifications();
            return { ok: !!token, token };
        } catch (error) {
            console.error("[platform/notifications] native registration failed:", error);
            return { ok: false, reason: error.message === "permission-denied" ? "denied" : "unsupported" };
        }
    }

    // Web Implementation
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        return { ok: false, reason: "unsupported" };
    }

    const supported = await isSupported().catch(() => false);
    if (!supported) return { ok: false, reason: "messaging-unsupported" };

    const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();

    if (permission !== "granted") {
        return { ok: false, reason: permission };
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        const messaging = getMessaging(app);
        const token = await getToken(messaging, {
            vapidKey: DRIVER_PUSH_VAPID_KEY,
            serviceWorkerRegistration: registration
        });
        return { ok: !!token, token };
    } catch (error) {
        console.error("[platform/notifications] web registration failed:", error);
        return { ok: false, reason: "registration-failed" };
    }
}

/**
 * Sends the push token to the backend.
 */
export async function sendTokenToBackend(token) {
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");
        const response = await fetch("/api/rides/driver-push-token", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ token, userAgent: navigator.userAgent, permission: "granted" })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            const backendError = new Error(data.error || "Could not register push token.");
            backendError.backendUnavailable = [404, 405, 502, 503].includes(response.status);
            throw backendError;
        }
        return { ok: true };
    } catch (error) {
        console.warn("[platform/notifications] backend sync failed:", error);
        return { ok: false, reason: "backend-unavailable" };
    }
}
