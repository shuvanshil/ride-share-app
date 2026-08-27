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
            const token = await Promise.race([
                window.LiphtUpNative.registerPushNotifications(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("native-timeout")), 5000))
            ]);
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

    try {
        const supported = await Promise.race([
            isSupported().catch(() => false),
            new Promise((resolve) => setTimeout(() => resolve(false), 2000))
        ]);
        if (!supported) return { ok: false, reason: "messaging-unsupported" };

        const permission = Notification.permission === "granted"
            ? "granted"
            : await Promise.race([
                Notification.requestPermission(),
                new Promise((resolve) => setTimeout(() => resolve("denied"), 6000))
            ]);

        if (permission !== "granted") {
            return { ok: false, reason: permission };
        }

        const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => setTimeout(() => reject(new Error("sw-ready-timeout")), 3000))
        ]);

        const messaging = getMessaging(app);
        const token = await Promise.race([
            getToken(messaging, {
                vapidKey: DRIVER_PUSH_VAPID_KEY,
                serviceWorkerRegistration: registration
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("get-token-timeout")), 4000))
        ]);
        return { ok: !!token, token };
    } catch (error) {
        console.warn("[platform/notifications] web push registration warning:", error?.message || error);
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
        
        const isDriver = (window.LIPHTUP_USER_ROLE === "driver") || 
            (window.isCurrentPage && (window.isCurrentPage('driver') || window.isCurrentPage('driver-service')));
        const primaryEndpoint = isDriver ? "/api/rides/driver-push-token" : "/api/rides/passenger-push-token";

        let response = await fetch(primaryEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ token, userAgent: navigator.userAgent, permission: "granted" }),
            signal: AbortSignal.timeout(5000)
        });
        
        // Fallback retry if 403 (e.g. role mismatch)
        if (response.status === 403) {
            const fallbackEndpoint = isDriver ? "/api/rides/passenger-push-token" : "/api/rides/driver-push-token";
            response = await fetch(fallbackEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({ token, userAgent: navigator.userAgent, permission: "granted" }),
                signal: AbortSignal.timeout(5000)
            });
        }

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
