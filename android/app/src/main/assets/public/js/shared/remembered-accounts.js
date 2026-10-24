/**
 * remembered-accounts.js
 *
 * Manages role-specific remembered accounts, secure non-sensitive metadata storage,
 * and strict 7-day inactivity expiration for LiphtUp.
 *
 * Follows OWASP and Android security guidelines:
 * - Stores ONLY non-sensitive identity metadata (display name, phone, role, timestamps).
 * - Never stores passwords, tokens, or OTPs.
 * - Enforces independent 7-day inactivity lifecycle for Passenger and Driver accounts.
 */

export const REMEMBERED_ACCOUNTS_STORAGE_KEY = "liphtup_remembered_accounts";
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000 ms

/**
 * Safely parse raw remembered accounts store.
 * @returns {{ passenger: object|null, driver: object|null }}
 */
export function getRememberedAccountsRaw() {
    try {
        const raw = localStorage.getItem(REMEMBERED_ACCOUNTS_STORAGE_KEY);
        if (!raw) return { passenger: null, driver: null };
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
            return { passenger: null, driver: null };
        }
        return {
            passenger: parsed.passenger && typeof parsed.passenger === "object" ? parsed.passenger : null,
            driver: parsed.driver && typeof parsed.driver === "object" ? parsed.driver : null,
        };
    } catch (e) {
        console.warn("[remembered-accounts] Failed to read store:", e);
        return { passenger: null, driver: null };
    }
}

/**
 * Write raw remembered accounts store safely.
 */
function saveRememberedAccountsRaw(data) {
    try {
        const payload = JSON.stringify(data);
        localStorage.setItem(REMEMBERED_ACCOUNTS_STORAGE_KEY, payload);
        // Sync to Capacitor native bridge if supported
        if (typeof window !== "undefined" && window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.setRememberedAccounts === "function") {
            window.LiphtUpNativeStatus.setRememberedAccounts(payload);
        }
    } catch (e) {
        console.warn("[remembered-accounts] Failed to write store:", e);
    }
}

/**
 * Clean up expired accounts older than 7 inactive days.
 * Returns valid active accounts.
 */
export function cleanupExpiredRememberedAccounts(nowMs = Date.now()) {
    const store = getRememberedAccountsRaw();
    let modified = false;

    for (const role of ["passenger", "driver"]) {
        const entry = store[role];
        if (entry) {
            const expiresAt = Number(entry.expiresAt || 0);
            const lastActivity = Number(entry.lastMeaningfulActivityAt || 0);
            const isExpired = nowMs > expiresAt || (nowMs - lastActivity) > SEVEN_DAYS_MS;
            if (isExpired) {
                console.log(`[remembered-accounts] ${role} account (${entry.name}) expired after 7 days of inactivity. Removing.`);
                store[role] = null;
                modified = true;
            }
        }
    }

    if (modified) {
        saveRememberedAccountsRaw(store);
    }
    return store;
}

/**
 * Retrieve remembered account for a role, ensuring 7-day validity.
 * @param {"passenger" | "driver"} role
 * @param {number} [nowMs]
 * @returns {object|null}
 */
export function getRememberedAccount(role, nowMs = Date.now()) {
    const normalizedRole = String(role || "").toLowerCase() === "driver" ? "driver" : "passenger";
    const store = cleanupExpiredRememberedAccounts(nowMs);
    const entry = store[normalizedRole];
    if (!entry) return null;

    // Strict validation of minimum non-sensitive schema
    if (!entry.name || !entry.role || entry.role !== normalizedRole) {
        forgetRememberedAccount(normalizedRole);
        return null;
    }
    return entry;
}

/**
 * Save or update non-sensitive remembered account metadata upon successful login or registration.
 * Explicitly preserves the other role's entry.
 * @param {object} profile
 * @param {number} [nowMs]
 */
export function saveRememberedAccount(profile, nowMs = Date.now()) {
    if (!profile || typeof profile !== "object") return;
    const normalizedRole = String(profile.role || "").toLowerCase() === "driver" ? "driver" : "passenger";
    const displayName = String(profile.name || profile.displayName || "").trim() || (normalizedRole === "driver" ? "Captain" : "Passenger");
    const rawPhone = String(profile.phone || profile.phoneNumber || "").trim();
    const uid = String(profile.uid || "").trim();

    const lastMeaningfulActivityAt = nowMs;
    const expiresAt = nowMs + SEVEN_DAYS_MS;

    const store = getRememberedAccountsRaw();
    store[normalizedRole] = {
        uid,
        name: displayName,
        phone: rawPhone,
        role: normalizedRole,
        lastMeaningfulActivityAt,
        expiresAt,
    };

    saveRememberedAccountsRaw(store);
    console.log(`[remembered-accounts] Saved remembered ${normalizedRole} account: ${displayName} (valid until ${new Date(expiresAt).toISOString()})`);
}

/**
 * Renew the 7-day inactivity deadline on meaningful activity.
 * @param {"passenger" | "driver"} role
 * @param {number} [nowMs]
 */
export function renewRememberedAccountActivity(role, nowMs = Date.now()) {
    const normalizedRole = String(role || "").toLowerCase() === "driver" ? "driver" : "passenger";
    const store = getRememberedAccountsRaw();
    const entry = store[normalizedRole];
    if (entry) {
        entry.lastMeaningfulActivityAt = nowMs;
        entry.expiresAt = nowMs + SEVEN_DAYS_MS;
        saveRememberedAccountsRaw(store);
    }
}

/**
 * Explicitly remove a remembered account for a role (e.g. user taps "Switch account").
 * @param {"passenger" | "driver"} role
 */
export function forgetRememberedAccount(role) {
    const normalizedRole = String(role || "").toLowerCase() === "driver" ? "driver" : "passenger";
    const store = getRememberedAccountsRaw();
    if (store[normalizedRole]) {
        store[normalizedRole] = null;
        saveRememberedAccountsRaw(store);
        console.log(`[remembered-accounts] Forgot remembered ${normalizedRole} account.`);
    }
}
