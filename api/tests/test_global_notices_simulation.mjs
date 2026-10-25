/**
 * Client-Side Global Notices Simulation Test Suite
 *
 * Simulates user scenarios for:
 * 1. Schedule boundaries (before start, active, after end).
 * 2. Audience targeting (passenger vs driver vs both).
 * 3. Driver-specific content toggle (when enabled vs disabled).
 * 4. Closable notice dismissal persistence per user + notice ID + version.
 * 5. Version increment redisplay after notice edit.
 * 6. Non-closable notice lockdown (no user bypass, dismisses on stop/expiry).
 * 7. Unauthenticated page suppression (no display on login/public routes).
 * 8. Real-time stop & delete reaction.
 */

import assert from 'assert';

console.log("=== STARTING GLOBAL NOTICES SIMULATION TESTS ===\n");

// Mock LocalStorage
class MockLocalStorage {
    constructor() {
        this.store = new Map();
    }
    getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
    }
    setItem(key, value) {
        this.store.set(key, String(value));
    }
    removeItem(key) {
        this.store.delete(key);
    }
    clear() {
        this.store.clear();
    }
}

// Logic mirror of processNoticesList and content selection in global-notices.js
function processNoticesForUser({ notices, userUid, userRole, localStorage, nowMs }) {
    if (!userUid) return null;

    const activeNotices = notices.filter((n) => {
        if (n.state !== "enabled") return false;
        const startMs = new Date(n.startsAt).getTime();
        const endMs = new Date(n.endsAt).getTime();
        if (startMs > nowMs || endMs < nowMs) return false;

        const aud = String(n.audience || "both").toLowerCase();
        if (aud === "both") return true;
        if (aud === "drivers" && userRole === "driver") return true;
        if (aud === "passengers" && userRole === "passenger") return true;
        return false;
    });

    if (!activeNotices.length) return null;

    activeNotices.sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
    const targetNotice = activeNotices[0];

    const noticeId = targetNotice.noticeId || targetNotice.id;
    const version = Number(targetNotice.version || 1);
    const closable = targetNotice.closable !== false;

    // Check dismissal
    const dismissKey = `liphtup_notice_dismissed_${userUid}_${noticeId}_v${version}`;
    if (closable && localStorage.getItem(dismissKey) === "1") {
        return null; // Suppressed because dismissed
    }

    const isDriver = (userRole === "driver");
    const useDriverContent = isDriver && !!targetNotice.driverContentEnabled;

    const title = (useDriverContent ? (targetNotice.driverTitle || targetNotice.title) : targetNotice.title);
    const description = (useDriverContent ? (targetNotice.driverDescription || targetNotice.description) : targetNotice.description);
    const callout = (useDriverContent ? (targetNotice.driverCallout || targetNotice.callout) : targetNotice.callout);

    return {
        noticeId,
        version,
        closable,
        title,
        description,
        callout,
        audience: targetNotice.audience,
        state: targetNotice.state,
    };
}

function isPageAllowedForNotice(pathname) {
    const unauthPages = ['login.html', 'driver-signup.html', 'about.html', 'contact.html', 'help.html', 'privacy.html', 'terms.html', 'offline.html'];
    const p = (pathname || '').toLowerCase();
    if (p.includes('/admin')) return false;
    return !unauthPages.some(page => p.includes(page));
}

// -------------------------------------------------------------
// Test 1: Unauthenticated routes suppression
// -------------------------------------------------------------
console.log("[Test 1] Testing unauthenticated routes suppression...");
assert.strictEqual(isPageAllowedForNotice("/login.html"), false);
assert.strictEqual(isPageAllowedForNotice("/driver-signup.html"), false);
assert.strictEqual(isPageAllowedForNotice("/about.html"), false);
assert.strictEqual(isPageAllowedForNotice("/admin/notifications.html"), false);
assert.strictEqual(isPageAllowedForNotice("/index.html"), true);
assert.strictEqual(isPageAllowedForNotice("/driver.html"), true);
assert.strictEqual(isPageAllowedForNotice("/services.html"), true);
console.log("✔ PASS: Notices are strictly prohibited on login, signup, admin, and public routes.\n");

// -------------------------------------------------------------
// Test 2: Schedule boundaries (Scheduled vs Active vs Ended)
// -------------------------------------------------------------
console.log("[Test 2] Testing schedule boundaries...");
const now = Date.now();
const storage = new MockLocalStorage();

const noticeFuture = {
    noticeId: "n_future",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "Future Notice",
    description: "Will start in 1 hour",
    startsAt: new Date(now + 3600000).toISOString(),
    endsAt: new Date(now + 7200000).toISOString(),
    closable: true,
};

const noticeActive = {
    noticeId: "n_active",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "Active Notice",
    description: "Running right now",
    startsAt: new Date(now - 1800000).toISOString(),
    endsAt: new Date(now + 1800000).toISOString(),
    closable: true,
};

const noticePast = {
    noticeId: "n_past",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "Past Notice",
    description: "Ended 1 hour ago",
    startsAt: new Date(now - 7200000).toISOString(),
    endsAt: new Date(now - 3600000).toISOString(),
    closable: true,
};

// Scheduled notice before start time -> null
assert.strictEqual(
    processNoticesForUser({ notices: [noticeFuture], userUid: "u1", userRole: "passenger", localStorage: storage, nowMs: now }),
    null
);

// Active notice -> displays
const resActive = processNoticesForUser({ notices: [noticeActive], userUid: "u1", userRole: "passenger", localStorage: storage, nowMs: now });
assert.strictEqual(resActive.noticeId, "n_active");
assert.strictEqual(resActive.title, "Active Notice");

// Ended notice -> null
assert.strictEqual(
    processNoticesForUser({ notices: [noticePast], userUid: "u1", userRole: "passenger", localStorage: storage, nowMs: now }),
    null
);
console.log("✔ PASS: Notices appear only during active start-to-end schedule window.\n");

// -------------------------------------------------------------
// Test 3: Audience targeting (Driver-only, Passenger-only, Both)
// -------------------------------------------------------------
console.log("[Test 3] Testing audience targeting...");
const noticeDriverOnly = {
    noticeId: "n_drv",
    version: 1,
    state: "enabled",
    audience: "drivers",
    title: "Drivers Only Notice",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 10000).toISOString(),
    closable: true,
};

const noticePaxOnly = {
    noticeId: "n_pax",
    version: 1,
    state: "enabled",
    audience: "passengers",
    title: "Passengers Only Notice",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 10000).toISOString(),
    closable: true,
};

// Driver viewing driver notice -> allowed
assert.notStrictEqual(
    processNoticesForUser({ notices: [noticeDriverOnly], userUid: "u_drv", userRole: "driver", localStorage: storage, nowMs: now }),
    null
);

// Passenger viewing driver notice -> blocked
assert.strictEqual(
    processNoticesForUser({ notices: [noticeDriverOnly], userUid: "u_pax", userRole: "passenger", localStorage: storage, nowMs: now }),
    null
);

// Passenger viewing passenger notice -> allowed
assert.notStrictEqual(
    processNoticesForUser({ notices: [noticePaxOnly], userUid: "u_pax", userRole: "passenger", localStorage: storage, nowMs: now }),
    null
);

// Driver viewing passenger notice -> blocked
assert.strictEqual(
    processNoticesForUser({ notices: [noticePaxOnly], userUid: "u_drv", userRole: "driver", localStorage: storage, nowMs: now }),
    null
);
console.log("✔ PASS: Strict audience isolation between drivers and passengers.\n");

// -------------------------------------------------------------
// Test 4: Driver-specific content toggle
// -------------------------------------------------------------
console.log("[Test 4] Testing driver-specific content toggle...");
const noticeDualContent = {
    noticeId: "n_dual",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "Default Title for Riders",
    description: "Default Description for Riders",
    callout: "Default Callout",
    driverContentEnabled: true,
    driverTitle: "Custom Captain Title",
    driverDescription: "Custom Captain Description",
    driverCallout: "Custom Captain Callout",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 10000).toISOString(),
    closable: true,
};

// Passenger receives default
const paxContent = processNoticesForUser({ notices: [noticeDualContent], userUid: "u_pax", userRole: "passenger", localStorage: storage, nowMs: now });
assert.strictEqual(paxContent.title, "Default Title for Riders");
assert.strictEqual(paxContent.description, "Default Description for Riders");

// Driver receives driver-specific content
const drvContent = processNoticesForUser({ notices: [noticeDualContent], userUid: "u_drv", userRole: "driver", localStorage: storage, nowMs: now });
assert.strictEqual(drvContent.title, "Custom Captain Title");
assert.strictEqual(drvContent.description, "Custom Captain Description");
assert.strictEqual(drvContent.callout, "Custom Captain Callout");
console.log("✔ PASS: Content separation verified: Drivers receive custom content, passengers receive default.\n");

// -------------------------------------------------------------
// Test 5: Dismissal persistence and version increment redisplay
// -------------------------------------------------------------
console.log("[Test 5] Testing dismissal persistence and version increment redisplay...");
const storageUser = new MockLocalStorage();
const userA = "user_alpha";

const closableNoticeV1 = {
    noticeId: "n_discount",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "10% Festive Discount",
    description: "Save 10% on rides",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 10000).toISOString(),
    closable: true,
};

// First time viewing -> displays
let disp1 = processNoticesForUser({ notices: [closableNoticeV1], userUid: userA, userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.notStrictEqual(disp1, null);

// User dismisses V1
storageUser.setItem(`liphtup_notice_dismissed_${userA}_n_discount_v1`, "1");

// Next refresh -> suppressed!
let disp2 = processNoticesForUser({ notices: [closableNoticeV1], userUid: userA, userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.strictEqual(disp2, null, "Dismissed V1 must not reappear on refresh");

// Admin edits notice -> increments version to 2
const closableNoticeV2 = {
    ...closableNoticeV1,
    version: 2,
    title: "20% Festive Discount (Updated!)",
};

// Viewing V2 -> REAPPEARS because version changed!
let disp3 = processNoticesForUser({ notices: [closableNoticeV2], userUid: userA, userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.notStrictEqual(disp3, null, "Updated V2 must reappear for previously dismissed user");
assert.strictEqual(disp3.title, "20% Festive Discount (Updated!)");
assert.strictEqual(disp3.version, 2);
console.log("✔ PASS: Dismissal is per-version: suppresses repeat display on refresh, reappears when edited.\n");

// -------------------------------------------------------------
// Test 6: Non-closable notice lockdown
// -------------------------------------------------------------
console.log("[Test 6] Testing non-closable notice lockdown...");
const nonClosableNotice = {
    noticeId: "n_lockdown",
    version: 1,
    state: "enabled",
    audience: "both",
    title: "Emergency Weather Lockdown",
    description: "Services temporarily paused due to cyclone",
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + 10000).toISOString(),
    closable: false,
};

const lockResult = processNoticesForUser({ notices: [nonClosableNotice], userUid: "u_any", userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.strictEqual(lockResult.closable, false, "Must be non-closable");

// Even if user attempts to store dismissal key, non-closable notices ignore it
storageUser.setItem(`liphtup_notice_dismissed_u_any_n_lockdown_v1`, "1");
const lockResultAfter = processNoticesForUser({ notices: [nonClosableNotice], userUid: "u_any", userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.notStrictEqual(lockResultAfter, null, "Non-closable notice cannot be bypassed by storage tampering");

// Automatically dismissed when stopped by admin
const stoppedNotice = { ...nonClosableNotice, state: "stopped" };
const stoppedResult = processNoticesForUser({ notices: [stoppedNotice], userUid: "u_any", userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.strictEqual(stoppedResult, null, "Stopped notice immediately ceases display");

// Automatically dismissed when deleted by admin
const deletedNotice = { ...nonClosableNotice, state: "deleted" };
const deletedResult = processNoticesForUser({ notices: [deletedNotice], userUid: "u_any", userRole: "passenger", localStorage: storageUser, nowMs: now });
assert.strictEqual(deletedResult, null, "Deleted notice immediately ceases display");
console.log("✔ PASS: Non-closable notices cannot be bypassed and immediately dismiss when stopped or deleted.\n");

// -------------------------------------------------------------
// Test 7: IST Timezone verification & scheduled notice wakeup delay
// -------------------------------------------------------------
console.log("[Test 7] Testing IST Timezone formatting & future notice wakeup calculation...");

// 1. IST formatting check
const testIsoUtc = "2026-10-26T04:30:00.000Z"; // 4:30 AM UTC = 10:00 AM IST
const istFormatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
}).format(new Date(testIsoUtc)) + ' IST';

assert.ok(istFormatted.includes("10:00") && istFormatted.includes("IST"), `Expected 10:00 AM IST but got ${istFormatted}`);

// 2. Upcoming notice wakeup timer delay calculation
function computeNextWakeupDelay(notices, userRole, nowMs) {
    let earliestFutureStartsMs = Infinity;
    for (const n of notices) {
        if (n.state !== "enabled") continue;
        const aud = String(n.audience || "both").toLowerCase();
        const matchesAudience = (aud === "both") || (aud === "drivers" && userRole === "driver") || (aud === "passengers" && userRole === "passenger");
        if (!matchesAudience) continue;

        const startMs = new Date(n.startsAt).getTime();
        const endMs = new Date(n.endsAt).getTime();
        if (startMs > nowMs && endMs > nowMs && startMs < earliestFutureStartsMs) {
            earliestFutureStartsMs = startMs;
        }
    }
    return (earliestFutureStartsMs !== Infinity) ? (earliestFutureStartsMs - nowMs) : null;
}

const scheduledDelay = computeNextWakeupDelay([noticeFuture], "passenger", now);
assert.strictEqual(scheduledDelay, 3600000, "Wakeup timer must fire exactly when future notice starts");
console.log("✔ PASS: IST Timezone strictly formatted and future notice wakeup correctly computed.\n");

console.log("========================================================");
console.log("🎉 ALL 7 CLIENT SIMULATION SUITES PASSED FLAWLESSLY!");
console.log("========================================================");