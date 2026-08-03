importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyD_mNOtbXCYucI--drFUMtp40MIIADSDfU",
    authDomain: "tripura-rideshare.firebaseapp.com",
    projectId: "tripura-rideshare",
    storageBucket: "tripura-rideshare.firebasestorage.app",
    messagingSenderId: "678756320479",
    appId: "1:678756320479:web:3861739b218640bb3fd56a"
});

const messaging = firebase.messaging();
const CACHE_VERSION = "liphtup-shell-v31-driver-dashboard-safety";
const BASE_URL = new URL("./", self.location.href);
const OFFLINE_URL = new URL("/offline", BASE_URL).href;
const APP_SHELL = [
    "/offline",
    "/index",
    "/driver",
    "/driver-service",
    "/driver-dashboard",
    "/services",
    "/profile",
    "/history",
    "/login",
    "manifest.webmanifest",
    "fare-policy.config.json",
    "favicon.ico",
    "css/style.css",
    "css/driver-service.css",
    "css/driver-dashboard.css",
    "js/firebase-init.js",
    "js/auth.js",
    "js/app.js",
    "js/driver.js",
    "js/driver-service.js",
    "js/driver-dashboard.js",
    "js/services.js",
    "js/profile.js",
    "js/history.js",
    "js/login.js",
    "js/map.js",
    "js/fare-policy.js",
    "js/dialog.js",
    "js/navigation.js",
    "js/pwa.js",
    "js/messaging.js",
    "assets/icons/liphtup-icon-180.png",
    "assets/icons/liphtup-icon-192.png",
    "assets/icons/liphtup-icon-512.png",
    "assets/icons/liphtup-icon-1024.png",
    "assets/icons/liphtup-icon-maskable-512.png",
    "assets/icons/favicon-32.png",
    "assets/icons/favicon-16.png",
    "assets/liphtup-logo.jpeg",
    "assets/vehicle-markers/bike-marker.png",
    "assets/vehicle-markers/auto-marker.png",
    "assets/hero banner.png",
    "assets/unakoti background image.jpg",
    "assets/railway background.jpeg"
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener("install", (event) => {
    // Pre-cache each app-shell file independently. cache.addAll() is atomic and
    // would abort the ENTIRE install (leaving the old service worker/cache in
    // control indefinitely) if even a single URL failed to fetch. Caching each
    // file on its own means one missing/renamed asset can't silently block the
    // whole app from ever updating.
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => Promise.all(
                APP_SHELL.map((url) => cache.add(url).catch((error) => {
                    console.warn("Service worker: could not pre-cache", url, error);
                }))
            ))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch {
        return await cache.match(request) || await cache.match(OFFLINE_URL);
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    }).catch(() => null);
    return cached || await network || Response.error();
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.includes("/api/")) return;

    if (request.mode === "navigate") {
        event.respondWith(networkFirst(request));
        return;
    }

    if (["style", "script", "image", "font"].includes(request.destination)
        || url.pathname.endsWith(".webmanifest")) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function getRideNotificationUrl(data = {}) {
    const rideId = data.rideId || data.ride_id || "";
    const url = new URL("/driver", BASE_URL);
    if (rideId) url.searchParams.set("rideId", rideId);
    url.searchParams.set("from", "push");
    return url.href;
}

function showRideNotification(payload = {}) {
    const data = payload.data || {};
    const notification = payload.notification || {};
    const title = notification.title || data.title || "New LiphtUp ride request";
    const body = notification.body || data.body || "Open LiphtUp to view and accept this ride.";

    return self.registration.showNotification(title, {
        body,
        icon: new URL("assets/icons/liphtup-icon-192.png", BASE_URL).href,
        badge: new URL("assets/icons/liphtup-icon-192.png", BASE_URL).href,
        tag: data.rideId ? `liphtup-ride-${data.rideId}` : "liphtup-ride-request",
        renotify: true,
        requireInteraction: true,
        vibrate: [350, 180, 350, 180, 700],
        data: {
            ...data,
            url: getRideNotificationUrl(data)
        },
        actions: [
            { action: "open", title: "Open ride" }
        ]
    });
}

messaging.onBackgroundMessage((payload) => {
    showRideNotification(payload);
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || new URL("/driver?from=push", BASE_URL).href;

    event.waitUntil((async () => {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const sameOriginClient = clientList.find((client) => new URL(client.url).origin === self.location.origin);
        if (sameOriginClient) {
            await sameOriginClient.focus();
            sameOriginClient.postMessage({
                type: "OPEN_DRIVER_RIDE",
                rideId: event.notification.data?.rideId || ""
            });
            return;
        }
        await self.clients.openWindow(targetUrl);
    })());
});
