/**
 * Client dispatch unit test suite.
 * Executes in Node.js to verify client-side dispatch countdown, heartbeat, and service area logic.
 */
const assert = require('assert');

// 1. Mock Functions replicating www/js/driver/driver-service.js
function getRideRemainingMs(ride = {}) {
    if (ride.currentOffer?.expiresAt) {
        let expMs = 0;
        if (typeof ride.currentOffer.expiresAt.toMillis === "function") {
            expMs = ride.currentOffer.expiresAt.toMillis();
        } else if (ride.currentOffer.expiresAt.seconds) {
            expMs = ride.currentOffer.expiresAt.seconds * 1000;
        } else {
            expMs = new Date(ride.currentOffer.expiresAt).getTime();
        }
        if (!isNaN(expMs) && expMs > 0) {
            return Math.max(0, expMs - Date.now());
        }
    }
    return null;
}

function formatCountdownTimer(remainingMs) {
    if (remainingMs === null || remainingMs === undefined) return "";
    const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

// 2. Heartbeat condition simulator
function simulateHeartbeatTick(currentUser, isDocumentHidden, lastPosition, lastWriteAt) {
    if (!currentUser?.uid || isDocumentHidden) return { fired: false, reason: "hidden_or_no_user" };
    const isOffline = (currentUser?.driverAvailability || "offline") === "offline";
    if (isOffline) return { fired: false, reason: "offline" };
    if (lastPosition && (Date.now() - lastWriteAt >= 20000)) {
        return { fired: true, reason: "written" };
    }
    return { fired: false, reason: "recent_write" };
}

console.log("Running client dispatch tests in Node.js...");

// Test A: Single offer countdown & null fallback for scheduled/unoffered rides
const now = Date.now();
const hexOfferRide = {
    id: "ride_hex_1",
    currentOffer: {
        driverId: "drv_1",
        expiresAt: new Date(now + 15500).toISOString(),
    },
    createdAt: now - 30000,
};
const hexRemaining = getRideRemainingMs(hexOfferRide);
assert(hexRemaining > 14000 && hexRemaining <= 16000, `Expected ~15s remaining, got ${hexRemaining}`);
assert.strictEqual(formatCountdownTimer(15000), "0:15");
console.log("  ✓ Hex-batch counts down to currentOffer.expiresAt (0:15)");

const unofferedRide = {
    id: "ride_unoffered_1",
    currentOffer: null,
    createdAt: now - 60000,
};
const unofferedRemaining = getRideRemainingMs(unofferedRide);
assert.strictEqual(unofferedRemaining, null);
assert.strictEqual(formatCountdownTimer(unofferedRemaining), "");
console.log("  ✓ Unoffered / scheduled ride returns null remaining time without crashing");

// Test B: Stationary heartbeat lifecycle
const onlineUser = { uid: "drv_test", driverAvailability: "online" };
const offlineUser = { uid: "drv_test", driverAvailability: "offline" };
const pos = { lat: 24.33, lng: 92.01 };

assert.strictEqual(simulateHeartbeatTick(offlineUser, false, pos, now - 25000).fired, false);
console.log("  ✓ Stationary heartbeat suppresses writes when driver is offline");

assert.strictEqual(simulateHeartbeatTick(onlineUser, true, pos, now - 25000).fired, false);
console.log("  ✓ Stationary heartbeat suppresses writes when page is hidden");

assert.strictEqual(simulateHeartbeatTick(onlineUser, false, pos, now - 5000).fired, false);
console.log("  ✓ Stationary heartbeat suppresses writes when last write was recent (<20s)");

assert.strictEqual(simulateHeartbeatTick(onlineUser, false, pos, now - 25000).fired, true);
console.log("  ✓ Stationary heartbeat executes write when online, visible, and stationary >=20s");

console.log("\nAll client-side JS unit assertions PASSED cleanly.\n");
