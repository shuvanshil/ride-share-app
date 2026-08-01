// Reuses the app's existing Firebase project/config -- admins sign in with
// the same Firebase Authentication used everywhere else in LiphtUp. What
// makes a signed-in user an *admin* is the `admin` custom claim on their
// Firebase ID token (see scripts/set_admin_claim.py and
// www/api/core/admin.py), not anything checked in this file.
import { auth } from "../../js/firebase-init.js";
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

async function authHeader() {
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
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
    const data = await handleResponse(response);
    if (cacheable) cache.set(url, { data, at: Date.now() });
    return data;
}

export function clearAdminCache() {
    cache.clear();
}

export async function adminPatch(path, body) {
    const response = await fetch(`/api/admin${path}`, {
        method: "PATCH",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await handleResponse(response);
    clearAdminCache(); // any write can affect dashboard/list caches
    return data;
}
