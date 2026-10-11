import { app, auth } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getMessaging,
    getToken,
    onMessage,
    isSupported
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

const DRIVER_PUSH_VAPID_KEY = "BJXKOjn7PQPRpnLMcXW5xe_blAib33GSjpIpTzQtH5Pw7IzxxNaWpwgGox7QxQFaObpvhSrc1vck4uY4bRrCkSl";
const DELIVERED_STORAGE_KEY = "liphtup_delivered_notifs_v1";
const PENDING_POLL_INTERVAL_MS = 12000;

let foregroundListenerAttached = false;
let inboxInitialized = false;
let pollTimerId = null;
let checkInFlight = false;
let gestureListenerAttached = false;
const inMemoryShownIds = new Set();

/**
 * Checks if the app is running in a native (Capacitor) environment.
 */
function isNative() {
    return !!(window.LIPHTUP_IS_NATIVE && window.LiphtUpNative);
}

function isAdminRoute() {
    try {
        return window.location.pathname.startsWith("/admin");
    } catch {
        return false;
    }
}

function getDeliveredMap() {
    try {
        const raw = localStorage.getItem(DELIVERED_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function hasBeenShown(key) {
    if (!key) return false;
    if (inMemoryShownIds.has(key)) return true;
    const map = getDeliveredMap();
    return Boolean(map[key]);
}

function markAsShown(keys = []) {
    const validKeys = keys.filter(Boolean).map((k) => String(k).trim());
    if (!validKeys.length) return;
    validKeys.forEach((k) => inMemoryShownIds.add(k));
    try {
        const map = getDeliveredMap();
        const now = Date.now();
        validKeys.forEach((k) => {
            map[k] = now;
        });
        // Prune entries older than 7 days or cap at 150 entries
        const entries = Object.entries(map)
            .filter(([, ts]) => now - Number(ts || 0) < 7 * 24 * 60 * 60 * 1000)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, 150);
        localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        // Ignore storage quota errors
    }
}

function playNotificationAlertSound() {
    if (navigator.vibrate) {
        try {
            navigator.vibrate([300, 140, 300]);
        } catch {
            // Ignore browser gesture restrictions
        }
    }
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        const notes = [587.33, 880]; // D5 -> A5 chime
        notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, now + idx * 0.14);
            gain.gain.setValueAtTime(0.0001, now + idx * 0.14);
            gain.gain.exponentialRampToValueAtTime(0.18, now + idx * 0.14 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.28);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + idx * 0.14);
            osc.stop(now + idx * 0.14 + 0.3);
        });
        setTimeout(() => {
            ctx.close().catch(() => {});
        }, 800);
    } catch {
        // Ignore audio context restrictions
    }
}

function ensureInAppBannerContainer() {
    let container = document.getElementById("liphtup-live-notif-container");
    if (container) return container;

    if (!document.getElementById("liphtup-live-notif-styles")) {
        const style = document.createElement("style");
        style.id = "liphtup-live-notif-styles";
        style.textContent = `
            #liphtup-live-notif-container {
                position: fixed;
                top: 14px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                width: min(94vw, 420px);
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
            }
            .liphtup-live-notif-card {
                pointer-events: auto;
                background: #ffffff;
                color: #0f172a;
                border-radius: 16px;
                padding: 14px 16px;
                box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22), 0 2px 8px rgba(15, 23, 42, 0.08);
                border: 1px solid rgba(32, 107, 196, 0.18);
                border-left: 5px solid #206bc4;
                display: flex;
                align-items: flex-start;
                gap: 12px;
                animation: liphtupNotifSlideIn 0.28s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Inter', system-ui, -apple-system, sans-serif;
            }
            @keyframes liphtupNotifSlideIn {
                from { opacity: 0; transform: translateY(-16px) scale(0.97); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .liphtup-live-notif-icon {
                width: 40px;
                height: 40px;
                border-radius: 10px;
                object-fit: contain;
                flex-shrink: 0;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                padding: 3px;
            }
            .liphtup-live-notif-body-wrap {
                flex: 1;
                min-width: 0;
            }
            .liphtup-live-notif-title {
                font-size: 0.95rem;
                font-weight: 700;
                color: #0f172a;
                margin: 0 0 3px 0;
                line-height: 1.3;
            }
            .liphtup-live-notif-text {
                font-size: 0.85rem;
                color: #475569;
                margin: 0;
                line-height: 1.42;
                word-break: break-word;
            }
            .liphtup-live-notif-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 8px;
            }
            .liphtup-live-notif-btn {
                border: none;
                background: #206bc4;
                color: #ffffff;
                font-size: 0.76rem;
                font-weight: 600;
                padding: 5px 12px;
                border-radius: 999px;
                cursor: pointer;
            }
            .liphtup-live-notif-close {
                border: none;
                background: transparent;
                color: #94a3b8;
                font-size: 1.2rem;
                line-height: 1;
                padding: 2px 4px;
                cursor: pointer;
                flex-shrink: 0;
            }
            .liphtup-live-notif-close:hover {
                color: #334155;
            }
        `;
        document.head.appendChild(style);
    }

    container = document.createElement("div");
    container.id = "liphtup-live-notif-container";
    document.body.appendChild(container);
    return container;
}

function showInAppNotificationBanner({ title, body, deepLink }) {
    if (!document.body) return;
    const container = ensureInAppBannerContainer();
    const card = document.createElement("div");
    card.className = "liphtup-live-notif-card";

    const iconUrl = new URL("/assets/icons/liphtup-icon-192.png", window.location.origin).href;
    const img = document.createElement("img");
    img.className = "liphtup-live-notif-icon";
    img.src = iconUrl;
    img.alt = "LiphtUp";

    const content = document.createElement("div");
    content.className = "liphtup-live-notif-body-wrap";

    const titleEl = document.createElement("div");
    titleEl.className = "liphtup-live-notif-title";
    titleEl.textContent = title || "LiphtUp Notification";

    const textEl = document.createElement("p");
    textEl.className = "liphtup-live-notif-text";
    textEl.textContent = body || "";

    content.appendChild(titleEl);
    content.appendChild(textEl);

    if (deepLink && deepLink !== "/" && deepLink !== window.location.href && deepLink !== window.location.pathname) {
        const actions = document.createElement("div");
        actions.className = "liphtup-live-notif-actions";
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "liphtup-live-notif-btn";
        openBtn.textContent = "Open";
        openBtn.addEventListener("click", () => {
            card.remove();
            try {
                const parsed = new URL(deepLink, window.location.origin);
                const targetPath = parsed.pathname + parsed.search;
                if (window.navigateToPage) {
                    window.navigateToPage(targetPath);
                } else {
                    window.location.href = window.getPlatformUrl ? window.getPlatformUrl(targetPath) : targetPath;
                }
            } catch {
                window.location.href = deepLink;
            }
        });
        actions.appendChild(openBtn);
        content.appendChild(actions);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "liphtup-live-notif-close";
    closeBtn.setAttribute("aria-label", "Dismiss notification");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => card.remove());

    card.appendChild(img);
    card.appendChild(content);
    card.appendChild(closeBtn);
    container.appendChild(card);

    setTimeout(() => {
        if (card.parentNode) {
            card.style.transition = "opacity 0.25s ease, transform 0.25s ease";
            card.style.opacity = "0";
            card.style.transform = "translateY(-10px)";
            setTimeout(() => card.remove(), 260);
        }
    }, 10000);
}

async function showBrowserSystemNotification({ title, body, deepLink, tag, id, broadcastId }) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
        return;
    }
    const targetUrl = (() => {
        try {
            return new URL(deepLink || "/", window.location.origin).href;
        } catch {
            return window.location.origin;
        }
    })();
    const iconUrl = new URL("/assets/icons/liphtup-icon-192.png", window.location.origin).href;
    const notifTag = tag || (broadcastId ? `admin_broadcast_${broadcastId}` : (id ? `liphtup_notif_${id}` : "liphtup_alert"));

    try {
        if ("serviceWorker" in navigator) {
            const registration = await ensureServiceWorkerRegistration();
            if (registration && typeof registration.showNotification === "function") {
                await registration.showNotification(title || "LiphtUp Alert", {
                    body: body || "",
                    icon: iconUrl,
                    badge: iconUrl,
                    tag: notifTag,
                    renotify: true,
                    requireInteraction: true,
                    vibrate: [350, 180, 350, 180, 700],
                    data: {
                        url: targetUrl,
                        broadcastId: broadcastId || "",
                        notificationId: id || "",
                    },
                });
                return;
            }
        }
    } catch {
        // Fallback to standard Notification API below
    }

    try {
        const n = new Notification(title || "LiphtUp Alert", {
            body: body || "",
            icon: iconUrl,
            tag: notifTag,
        });
        n.onclick = () => {
            window.focus();
            n.close();
        };
    } catch {
        // Ignore if browser disallows direct Notification constructor
    }
}

async function ensureServiceWorkerRegistration() {
    if (!("serviceWorker" in navigator)) return null;
    try {
        let reg = await navigator.serviceWorker.getRegistration("/");
        if (!reg) {
            reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        }
        const readyReg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((resolve) => setTimeout(() => resolve(reg), 8000)),
        ]);
        return readyReg || reg;
    } catch (err) {
        console.warn("[platform/notifications] SW registration lookup warning:", err?.message || err);
        return null;
    }
}

async function acknowledgeNotificationsOnBackend(notificationIds = [], broadcastIds = []) {
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;
        await fetch("/api/rides/notifications/ack", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                notificationIds,
                broadcastIds,
                markRead: true,
            }),
            signal: AbortSignal.timeout(6000),
        });
    } catch {
        // Non-fatal; will retry on next poll if still undelivered
    }
}

async function presentAndAckNotification(item, { skipSystemNotification = false } = {}) {
    const id = item.id || "";
    const broadcastId = item.broadcastId || "";
    const eventId = item.eventId || "";
    const dedupKeys = [
        id ? `id:${id}` : "",
        broadcastId ? `bcast:${broadcastId}` : "",
        eventId ? `evt:${eventId}` : "",
    ].filter(Boolean);

    if (dedupKeys.some((k) => hasBeenShown(k))) {
        if (id || broadcastId) {
            acknowledgeNotificationsOnBackend(id ? [id] : [], broadcastId ? [broadcastId] : []);
        }
        return;
    }

    markAsShown(dedupKeys);
    playNotificationAlertSound();
    showInAppNotificationBanner({
        title: item.title,
        body: item.body,
        deepLink: item.deepLink || item.url || "/",
    });

    if (!skipSystemNotification) {
        await showBrowserSystemNotification({
            title: item.title,
            body: item.body,
            deepLink: item.deepLink || item.url || "/",
            tag: item.tag,
            id,
            broadcastId,
        });
    }

    if (id || broadcastId) {
        await acknowledgeNotificationsOnBackend(id ? [id] : [], broadcastId ? [broadcastId] : []);
    }
}

/**
 * Checks for any pending or scheduled notifications queued while the user was offline or without push.
 */
export async function checkPendingNotifications() {
    if (isAdminRoute() || checkInFlight) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    checkInFlight = true;
    try {
        const idToken = await currentUser.getIdToken();
        if (!idToken) return;

        const response = await fetch("/api/rides/notifications/pending", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${idToken}`,
            },
            signal: AbortSignal.timeout(7000),
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const list = Array.isArray(data.notifications) ? data.notifications : [];
        for (const notif of list) {
            await presentAndAckNotification(notif);
        }
    } catch {
        // Ignore transient offline or network errors; will retry when online
    } finally {
        checkInFlight = false;
    }
}

async function attachForegroundMessagingListener() {
    if (foregroundListenerAttached || isNative() || isAdminRoute()) return;
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    try {
        const supported = await Promise.race([
            isSupported().catch(() => false),
            new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        if (!supported) return;
        const messaging = getMessaging(app);
        foregroundListenerAttached = true;
        onMessage(messaging, (payload) => {
            const data = payload?.data || {};
            const notif = payload?.notification || {};
            const title = notif.title || data.title || "LiphtUp Alert";
            const body = notif.body || data.body || "";
            const url = data.url || "/";
            const broadcastId = data.broadcastId || "";
            const eventId = data.eventId || payload?.messageId || "";
            const tag = data.tag || "";

            // Ride cancellation is handled by active ride listeners
            if (data.type === "RIDE_CANCELLED" || data.type === "ride_cancelled") {
                return;
            }

            presentAndAckNotification({
                id: data.notificationId || "",
                broadcastId,
                eventId,
                title,
                body,
                deepLink: url,
                tag,
            });
        });
    } catch {
        foregroundListenerAttached = false;
    }
}

/**
 * Registers for push notifications.
 * Returns the token if successful, or an object with error reason.
 */
export async function registerForPush({ allowPrompt = true } = {}) {
    if (isNative()) {
        console.log("[platform/notifications] registering native push...");
        try {
            const token = await Promise.race([
                window.LiphtUpNative.registerPushNotifications(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("native-timeout")), 10000))
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
            new Promise((resolve) => setTimeout(() => resolve(false), 3000))
        ]);
        if (!supported) return { ok: false, reason: "messaging-unsupported" };

        let permission = Notification.permission;
        if (permission !== "granted" && allowPrompt) {
            permission = await Promise.race([
                Notification.requestPermission().catch(() => Notification.permission),
                new Promise((resolve) => setTimeout(() => resolve(Notification.permission), 6000))
            ]);
        }

        if (permission !== "granted") {
            return { ok: false, reason: permission };
        }

        const registration = await ensureServiceWorkerRegistration();
        if (!registration) {
            return { ok: false, reason: "sw-unavailable" };
        }

        const messaging = getMessaging(app);
        attachForegroundMessagingListener();

        let token = null;
        try {
            token = await Promise.race([
                getToken(messaging, {
                    vapidKey: DRIVER_PUSH_VAPID_KEY,
                    serviceWorkerRegistration: registration
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("get-token-timeout")), 10000))
            ]);
        } catch (vapidErr) {
            // Fallback to project default webpush certificate if custom vapidKey fails
            token = await Promise.race([
                getToken(messaging, {
                    serviceWorkerRegistration: registration
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("get-token-timeout")), 10000))
            ]);
        }
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
    if (!token) return { ok: false, reason: "missing-token" };
    try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Authentication is required.");

        const payload = JSON.stringify({
            token,
            userAgent: navigator.userAgent,
            permission: "granted"
        });

        let response = await fetch("/api/rides/push-token", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: payload,
            signal: AbortSignal.timeout(7000)
        });

        if (response.status === 404 || response.status === 405) {
            response = await fetch("/api/rides/passenger-push-token", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                body: payload,
                signal: AbortSignal.timeout(7000)
            });
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            const backendError = new Error(data.error || "Could not register push token.");
            backendError.backendUnavailable = [404, 405, 502, 503].includes(response.status);
            throw backendError;
        }
        try {
            localStorage.setItem("liphtup_current_push_token", token);
        } catch {}
        return { ok: true };
    } catch (error) {
        console.warn("[platform/notifications] backend sync failed:", error);
        return { ok: false, reason: "backend-unavailable" };
    }
}

/**
 * Unlinks the current device push token on logout without affecting other devices.
 */
export async function unregisterDevicePushToken() {
    try {
        const token = localStorage.getItem("liphtup_current_push_token");
        if (!token) return { ok: true };

        const idToken = await auth.currentUser?.getIdToken();
        if (idToken) {
            await fetch("/api/rides/device/unregister", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({ token }),
                signal: AbortSignal.timeout(4000)
            }).catch(() => {});
        }
        localStorage.removeItem("liphtup_current_push_token");
        return { ok: true };
    } catch (error) {
        console.warn("[platform/notifications] unregister push token error:", error);
        return { ok: false };
    }
}

/**
 * Initializes real-time foreground push + scheduled online delivery inbox for all passenger and driver pages.
 */
export function initUserNotificationInbox() {
    if (inboxInitialized || isAdminRoute()) return;
    inboxInitialized = true;

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (event) => {
            if (event.data?.type === "BROADCAST_NOTIFICATION" && event.data.payload) {
                presentAndAckNotification(event.data.payload, { skipSystemNotification: true });
            }
        });
    }

    window.addEventListener("online", () => {
        checkPendingNotifications();
        if (auth.currentUser) {
            registerForPush({ allowPrompt: false }).then((res) => {
                if (res?.ok && res.token) sendTokenToBackend(res.token).catch(() => {});
            }).catch(() => {});
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            checkPendingNotifications();
        }
    });

    window.addEventListener("focus", () => {
        checkPendingNotifications();
    });

    onAuthStateChanged(auth, (user) => {
        if (pollTimerId) {
            clearInterval(pollTimerId);
            pollTimerId = null;
        }
        if (!user) return;

        attachForegroundMessagingListener();
        checkPendingNotifications();

        // Register push token immediately if permission is already granted or native
        registerForPush({ allowPrompt: true }).then((res) => {
            if (res?.ok && res.token) {
                sendTokenToBackend(res.token).catch(() => {});
            } else if (!isNative() && "Notification" in window && Notification.permission === "default" && !gestureListenerAttached) {
                gestureListenerAttached = true;
                const onFirstGesture = () => {
                    document.removeEventListener("click", onFirstGesture);
                    document.removeEventListener("touchstart", onFirstGesture);
                    registerForPush({ allowPrompt: true }).then((r) => {
                        if (r?.ok && r.token) {
                            sendTokenToBackend(r.token).catch(() => {});
                        }
                    }).catch(() => {});
                };
                document.addEventListener("click", onFirstGesture, { once: true, passive: true });
                document.addEventListener("touchstart", onFirstGesture, { once: true, passive: true });
            }
        }).catch(() => {});

        pollTimerId = setInterval(() => {
            if (document.visibilityState === "visible") {
                checkPendingNotifications();
            }
        }, PENDING_POLL_INTERVAL_MS);
    });
}

if (typeof window !== "undefined" && !isAdminRoute()) {
    initUserNotificationInbox();
}
