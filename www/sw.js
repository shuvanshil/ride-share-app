const CACHE_VERSION = "liphtup-shell-v21-driver-heading";
const BASE_URL = new URL("./", self.location.href);
const OFFLINE_URL = new URL("offline.html", BASE_URL).href;
const APP_SHELL = [
    "offline.html",
    "index.html",
    "driver.html",
    "driver-service.html",
    "services.html",
    "profile.html",
    "history.html",
    "login.html",
    "manifest.webmanifest",
    "css/style.css",
    "css/driver-service.css",
    "js/firebase-init.js",
    "js/auth.js",
    "js/app.js",
    "js/driver.js",
    "js/driver-service.js",
    "js/services.js",
    "js/profile.js",
    "js/history.js",
    "js/login.js",
    "js/map.js",
    "js/fare-policy.js",
    "js/navigation.js",
    "js/pwa.js",
    "assets/icons/liphtup-icon-180.png",
    "assets/icons/liphtup-icon-192.png",
    "assets/icons/liphtup-icon-512.png",
    "assets/icons/liphtup-icon-1024.png",
    "assets/icons/liphtup-icon-maskable-512.png",
    "assets/liphtup-logo.jpeg",
    "assets/vehicle-markers/bike-marker.png",
    "assets/vehicle-markers/auto-marker.png",
    "assets/hero banner.png",
    "assets/unakoti background image.jpg",
    "assets/railway background.jpeg"
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(APP_SHELL))
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
