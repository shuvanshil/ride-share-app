const { getAdmin } = require("./_firebase-admin");
const {
    json,
    methodNotAllowed,
    readJsonBody
} = require("./_otp");

const DRIVER_NOTIFICATION_ELIGIBLE_MS = 30 * 60 * 1000;
const APP_BASE_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "https://liphtup.in").replace(/\/+$/, "");

function cleanId(value) {
    return String(value || "").trim().slice(0, 160);
}

function timestampMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isNotificationEligible(driver = {}) {
    if (driver.desiredAvailability === "offline" || driver.driverAvailability === "offline") return false;
    const eligibleUntil = timestampMs(driver.notificationEligibleUntil);
    if (eligibleUntil) return eligibleUntil >= Date.now();

    const lastSeenAt = timestampMs(driver.lastAppSeenAt || driver.lastSeenAt || driver.updatedAt);
    return Boolean(lastSeenAt) && Date.now() - lastSeenAt <= DRIVER_NOTIFICATION_ELIGIBLE_MS;
}

function collectTokens(driver = {}) {
    const tokens = new Set();
    if (Array.isArray(driver.pushTokens)) {
        driver.pushTokens.forEach((token) => {
            if (typeof token === "string" && token.trim()) tokens.add(token.trim());
        });
    }
    if (Array.isArray(driver.pushTokenDetails)) {
        driver.pushTokenDetails.forEach((detail) => {
            if (typeof detail?.token === "string" && detail.token.trim()) tokens.add(detail.token.trim());
        });
    }
    return [...tokens];
}

async function verifyPassenger(req, admin) {
    const authorization = String(req.headers.authorization || "");
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        const error = new Error("Missing passenger authorization.");
        error.status = 401;
        throw error;
    }
    return admin.auth().verifyIdToken(match[1]);
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    try {
        const admin = getAdmin();
        const decoded = await verifyPassenger(req, admin);
        const body = await readJsonBody(req);
        const rideId = cleanId(body.rideId);
        const driverIds = Array.isArray(body.driverIds)
            ? [...new Set(body.driverIds.map(cleanId).filter(Boolean))].slice(0, 20)
            : [];

        if (!rideId || !driverIds.length) {
            return json(res, 400, { error: "Ride ID and driver IDs are required." });
        }

        const db = admin.firestore();
        const rideSnap = await db.collection("rides").doc(rideId).get();
        if (!rideSnap.exists) {
            return json(res, 404, { error: "Ride request not found." });
        }

        const ride = rideSnap.data() || {};
        if (ride.passenger_id !== decoded.uid) {
            return json(res, 403, { error: "Only the passenger can notify drivers for this ride." });
        }
        if (ride.status !== "pending" || ride.driver_id) {
            return json(res, 409, { error: "Ride is no longer pending." });
        }

        const eligibleSet = new Set(Array.isArray(ride.eligible_driver_ids) ? ride.eligible_driver_ids : []);
        const allowedDriverIds = driverIds.filter((driverId) => eligibleSet.has(driverId));
        if (!allowedDriverIds.length) {
            return json(res, 200, { ok: true, sent: 0, skipped: "no-eligible-drivers" });
        }

        const driverDocs = await Promise.all(
            allowedDriverIds.map((driverId) => db.collection("driverPresence").doc(driverId).get())
        );
        const tokens = [];
        driverDocs.forEach((driverDoc) => {
            if (!driverDoc.exists) return;
            const driver = driverDoc.data() || {};
            if (!isNotificationEligible(driver)) return;
            collectTokens(driver).forEach((token) => tokens.push(token));
        });

        const uniqueTokens = [...new Set(tokens)].slice(0, 500);
        if (!uniqueTokens.length) {
            return json(res, 200, { ok: true, sent: 0, skipped: "no-driver-tokens" });
        }

        const pickup = ride.pickup_display_address || ride.pickup_name || "Pickup location";
        const drop = ride.drop_display_address || ride.drop_name || ride.drop_full_address || "Destination";
        const fare = Number(ride.fare || 0);
        const bodyText = `${pickup} to ${drop}${fare > 0 ? ` - Rs ${fare}` : ""}`;

        const notificationUrl = `${APP_BASE_URL}/driver.html?rideId=${encodeURIComponent(rideId)}&from=push`;

        const response = await admin.messaging().sendEachForMulticast({
            tokens: uniqueTokens,
            data: {
                type: "ride_request",
                rideId,
                title: "New LiphtUp ride request",
                body: bodyText,
                url: notificationUrl
            },
            webpush: {
                headers: {
                    Urgency: "high",
                    TTL: "90"
                },
                fcmOptions: {
                    link: notificationUrl
                }
            }
        });

        return json(res, 200, {
            ok: true,
            sent: response.successCount,
            failed: response.failureCount
        });
    } catch (error) {
        console.error("Ride request notification failed:", error);
        return json(res, error.status || 500, {
            error: error.message || "Could not send ride notifications."
        });
    }
};
