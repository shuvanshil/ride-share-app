import { registerForPush, sendTokenToBackend } from '../platform/notifications.js';

let lastOpenNotificationAt = 0;

export async function registerDriverPushToken(_db, uid) {
    if (!uid) return { ok: false, reason: "unsupported" };

    const result = await registerForPush();
    if (!result.ok) return result;

    const syncResult = await sendTokenToBackend(result.token);
    if (!syncResult.ok) return syncResult;

    return { ok: true, token: result.token };
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
    const url = new URL("/driver.html", window.location.href);
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
