const { getAdmin } = require("./_firebase-admin");
const {
    json,
    methodNotAllowed,
    readJsonBody,
    verifyToken
} = require("./_otp");

async function loadPhoneLoginIndex(admin, phone) {
    const snap = await admin.firestore().collection("phoneLoginIndex").doc(phone).get();
    if (!snap.exists) return null;
    return snap.data();
}

async function loadUserProfileByPhone(admin, phone) {
    const snap = await admin.firestore()
        .collection("users")
        .where("phone", "==", phone)
        .limit(1)
        .get();

    if (snap.empty) return null;

    const doc = snap.docs[0];
    const profile = doc.data();
    return {
        uid: profile.uid || doc.id,
        email: profile.email || "",
        role: profile.role || "passenger",
        phone
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    try {
        const body = await readJsonBody(req);
        const tokenPayload = verifyToken(body.verificationToken, "reset");
        const password = String(body.password || "");

        if (password.length < 6) {
            return json(res, 400, { error: "Password must be at least 6 characters." });
        }

        const admin = getAdmin();
        const loginIndex = await loadPhoneLoginIndex(admin, tokenPayload.phone)
            || await loadUserProfileByPhone(admin, tokenPayload.phone);

        if (!loginIndex?.uid) {
            return json(res, 404, { error: "No LiphtUp account was found for this phone number." });
        }

        await admin.auth().updateUser(loginIndex.uid, { password });

        if (loginIndex.email) {
            await admin.firestore().collection("phoneLoginIndex").doc(tokenPayload.phone).set({
                uid: loginIndex.uid,
                email: loginIndex.email,
                role: loginIndex.role || "passenger",
                phone: tokenPayload.phone,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        return json(res, 200, {
            ok: true,
            email: loginIndex.email || "",
            phone: tokenPayload.phone
        });
    } catch (error) {
        console.error("Password reset failed:", error);
        return json(res, error.status || 500, {
            error: error.message || "Could not update password. Please try again."
        });
    }
};
