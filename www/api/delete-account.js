const { getAdmin } = require("./_firebase-admin");
const {
    json,
    methodNotAllowed,
    readJsonBody
} = require("./_otp");

const ACTIVE_PASSENGER_STATUSES = ["pending", "accepted", "arrived", "started", "en_route"];
const ACTIVE_DRIVER_STATUSES = ["accepted", "arrived", "started", "en_route"];
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyD_mNOtbXCYucI--drFUMtp40MIIADSDfU";

function getBearerToken(req) {
    const header = req.headers.authorization || req.headers.Authorization || "";
    const match = String(header).match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : "";
}

async function verifyPassword(email, password) {
    if (!email || !password || !FIREBASE_WEB_API_KEY) return false;

    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify({
            email,
            password,
            returnSecureToken: true
        })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) return false;
    return data;
}

async function hasActiveRide(db, fieldName, uid, statuses) {
    const snap = await db.collection("rides")
        .where(fieldName, "==", uid)
        .where("status", "in", statuses)
        .limit(1)
        .get();

    return !snap.empty;
}

function anonymizeRideData(role, admin) {
    const deletedAt = admin.firestore.FieldValue.serverTimestamp();
    if (role === "driver") {
        return {
            driver_name: "Deleted driver",
            driver_phone: "",
            driver_profile_photo: "",
            driver_deleted: true,
            driver_deleted_at: deletedAt
        };
    }

    return {
        passenger_name: "Deleted passenger",
        passenger_phone: "",
        passenger_profile_photo: "",
        passenger_deleted: true,
        passenger_deleted_at: deletedAt
    };
}

async function anonymizeCollectionByParticipant(db, admin, collectionName, fieldName, uid, role) {
    const snap = await db.collection(collectionName).where(fieldName, "==", uid).get();
    if (snap.empty) return 0;

    let batch = db.batch();
    let count = 0;
    let pendingWrites = 0;
    const updates = anonymizeRideData(role, admin);

    for (const docSnap of snap.docs) {
        batch.set(docSnap.ref, updates, { merge: true });
        count += 1;
        pendingWrites += 1;

        if (pendingWrites === 450) {
            await batch.commit();
            batch = db.batch();
            pendingWrites = 0;
        }
    }

    if (pendingWrites) {
        await batch.commit();
    }

    return count;
}

async function removeDriverFromPendingDispatches(db, admin, uid) {
    const snap = await db.collection("rides")
        .where("eligible_driver_ids", "array-contains", uid)
        .get();

    if (snap.empty) return 0;

    const removeUid = admin.firestore.FieldValue.arrayRemove(uid);
    let batch = db.batch();
    let count = 0;
    let pendingWrites = 0;

    for (const docSnap of snap.docs) {
        if (docSnap.data().status !== "pending") continue;

        batch.update(docSnap.ref, {
            eligible_driver_ids: removeUid,
            notified_driver_ids: removeUid,
            rejected_driver_ids: removeUid
        });
        count += 1;
        pendingWrites += 1;

        if (pendingWrites === 450) {
            await batch.commit();
            batch = db.batch();
            pendingWrites = 0;
        }
    }

    if (pendingWrites) {
        await batch.commit();
    }

    return count;
}

async function deleteAccountData(admin, uid, profile) {
    const db = admin.firestore();
    const role = profile.role === "driver" ? "driver" : "passenger";
    const phone = profile.phone || "";

    if (await hasActiveRide(db, "passenger_id", uid, ACTIVE_PASSENGER_STATUSES)) {
        const error = new Error("Please complete or cancel your active passenger ride before deleting your account.");
        error.status = 409;
        throw error;
    }

    if (await hasActiveRide(db, "driver_id", uid, ACTIVE_DRIVER_STATUSES)) {
        const error = new Error("Please complete or cancel your active driver trip before deleting your account.");
        error.status = 409;
        throw error;
    }

    const deletedAt = admin.firestore.FieldValue.serverTimestamp();
    await Promise.all([
        role === "driver" ? db.collection("driverPresence").doc(uid).delete().catch(() => null) : Promise.resolve(),
        removeDriverFromPendingDispatches(db, admin, uid),
        anonymizeCollectionByParticipant(db, admin, "rides", "passenger_id", uid, "passenger"),
        anonymizeCollectionByParticipant(db, admin, "rides", "driver_id", uid, "driver"),
        anonymizeCollectionByParticipant(db, admin, "tripHistory", "passenger_id", uid, "passenger"),
        anonymizeCollectionByParticipant(db, admin, "tripHistory", "driver_id", uid, "driver")
    ]);

    await db.collection("deletedAccounts").doc(uid).set({
        uid,
        role,
        deletedAt,
        phoneReleased: Boolean(phone),
        emailReleased: Boolean(profile.email)
    }, { merge: true }).catch(() => null);

    const cleanupBatch = db.batch();
    cleanupBatch.delete(db.collection("users").doc(uid));
    if (phone) {
        cleanupBatch.delete(db.collection("phoneLoginIndex").doc(phone));
    }
    await cleanupBatch.commit();

    await admin.auth().deleteUser(uid);
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    try {
        const body = await readJsonBody(req);
        const confirmation = String(body.confirmation || "").trim();
        const password = String(body.password || "");

        if (confirmation !== "DELETE") {
            return json(res, 400, { error: "Type DELETE to confirm permanent account deletion." });
        }
        if (password.length < 6) {
            return json(res, 400, { error: "Enter your account password to delete this account." });
        }

        const idToken = getBearerToken(req);
        if (!idToken) {
            return json(res, 401, { error: "Please login again before deleting your account." });
        }

        const admin = getAdmin();
        const decodedToken = await admin.auth().verifyIdToken(idToken, true);
        const uid = decodedToken.uid;
        const [authUser, userSnap] = await Promise.all([
            admin.auth().getUser(uid),
            admin.firestore().collection("users").doc(uid).get()
        ]);

        const profile = userSnap.exists ? userSnap.data() : {};
        const email = authUser.email || profile.email || "";
        const passwordCheck = await verifyPassword(email, password);

        if (!passwordCheck || passwordCheck.localId !== uid) {
            return json(res, 401, { error: "The password you entered is incorrect." });
        }

        await deleteAccountData(admin, uid, {
            ...profile,
            email,
            phone: profile.phone || authUser.phoneNumber || ""
        });

        return json(res, 200, { ok: true });
    } catch (error) {
        console.error("Account deletion failed:", error);
        return json(res, error.status || 500, {
            error: error.message || "Could not delete your account. Please try again."
        });
    }
};
