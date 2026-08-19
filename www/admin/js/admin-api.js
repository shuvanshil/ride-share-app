// Reuses the app's existing Firebase project/config -- admins sign in with
// the same Firebase Authentication used everywhere else in LiphtUp. What
// makes a signed-in user an *admin* is the `admin` custom claim on their
// Firebase ID token (see scripts/set_admin_claim.py and
// api/core/admin.py), not anything checked in this file.
import { auth } from "../../js/platform/firebase-init.js";
import {
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

export function watchAdminAuth(callback) {
    return onAuthStateChanged(auth, callback);
}

export async function loginAdmin(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
}

export async function logoutAdmin() {
    return signOut(auth);
}

async function authHeader(forceRefresh = false) {
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");
    const token = await user.getIdToken(forceRefresh);
    return { Authorization: `Bearer ${token}` };
}

// Firebase caches the ID token for up to an hour. If the `admin` custom
// claim was granted after this browser session started (e.g. via
// /api/admin/bootstrap right before signing in), the cached token -- and
// therefore every Firestore realtime listener using the same session --
// can still be missing the claim until it's force-refreshed. Call this once
// right after a successful /verify so the realtime listeners in
// admin-live.js open with a token that actually has the claim.
export async function refreshAdminToken() {
    const user = auth.currentUser;
    if (!user) return;
    await user.getIdToken(true);
}

async function handleResponse(response) {
    let data;
    try {
        data = await response.json();
    } catch {
        data = {};
    }
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
}

const cache = new Map(); // url -> {data, at}
const CACHE_TTL_MS = 15000;

export async function adminGet(path, params = {}, { cacheable = false } = {}) {
    const query = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    const url = `/api/admin${path}${query ? `?${query}` : ""}`;

    if (cacheable) {
        const hit = cache.get(url);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    }

    let response;
    try {
        response = await fetch(url, { headers: await authHeader() });
    } catch (networkError) {
        // One retry on a transient network hiccup before surfacing the error.
        response = await fetch(url, { headers: await authHeader() });
    }
    if (response.status === 401 || response.status === 403) {
        // Could be a stale cached token missing a just-granted admin claim --
        // force a refresh and try exactly once more before giving up.
        response = await fetch(url, { headers: await authHeader(true) });
    }
    const data = await handleResponse(response);
    if (cacheable) cache.set(url, { data, at: Date.now() });
    return data;
}

export function clearAdminCache() {
    cache.clear();
}

export async function adminPatch(path, body) {
    let response = await fetch(`/api/admin${path}`, {
        method: "PATCH",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
        response = await fetch(`/api/admin${path}`, {
            method: "PATCH",
            headers: { ...(await authHeader(true)), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    const data = await handleResponse(response);
    clearAdminCache(); // any write can affect dashboard/list caches
    return data;
}

export async function adminPost(path, body = {}) {
    let response = await fetch(`/api/admin${path}`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
        response = await fetch(`/api/admin${path}`, {
            method: "POST",
            headers: { ...(await authHeader(true)), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    const data = await handleResponse(response);
    clearAdminCache();
    return data;
}

export async function adminDelete(path) {
    let response = await fetch(`/api/admin${path}`, {
        method: "DELETE",
        headers: await authHeader(),
    });
    if (response.status === 401 || response.status === 403) {
        response = await fetch(`/api/admin${path}`, {
            method: "DELETE",
            headers: await authHeader(true),
        });
    }
    const data = await handleResponse(response);
    clearAdminCache();
    return data;
}
