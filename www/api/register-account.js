const { getAdmin } = require("./_firebase-admin");
const {
    json,
    methodNotAllowed,
    readJsonBody,
    verifyToken
} = require("./_otp");

function cleanString(value, maxLength = 200) {
    return String(value || "").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
    return cleanString(value, 320).toLowerCase();
}

function validateBaseProfile(profile = {}) {
    const name = cleanString(profile.name, 80);
    const email = normalizeEmail(profile.email);
    const role = profile.role === "driver" ? "driver" : "passenger";

    if (name.length < 2) {
        throw new Error("Enter your full name.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Enter a valid email address.");
    }

    return { name, email, role };
}

function buildProfile(uid, phone, profile) {
    const base = validateBaseProfile(profile);
    const profileData = {
        uid,
        name: base.name,
        phone,
        email: base.email,
        role: base.role,
        phoneVerified: true,
        authProvider: "password",
        otpProvider: "2factor",
        profileCompleted: true,
        createdAt: new Date()
    };

    if (base.role === "driver") {
        const profilePhotoUrl = cleanString(profile.profilePhotoUrl, 1500);
        const vehicleType = profile.vehicleType === "auto" ? "auto" : profile.vehicleType === "bike" ? "bike" : "";
        const vehicleNumber = cleanString(profile.vehicleNumber, 20).toUpperCase();
        const vehicleModel = cleanString(profile.vehicleModel, 80);
        const licenseNumber = cleanString(profile.drivingLicenseNumber, 30).toUpperCase();
        const upiId = cleanString(profile.upiId, 100).toLowerCase();

        if (!profilePhotoUrl || !vehicleType || !vehicleNumber || !vehicleModel || !licenseNumber || !upiId) {
            throw new Error("Drivers must add all required vehicle and payment details.");
        }

        Object.assign(profileData, {
            profilePhotoUrl,
            vehicleType,
            vehicle_type: vehicleType,
            vehicleNumber,
            vehicle_number: vehicleNumber,
            vehicleModel,
            vehicle_model: vehicleModel,
            drivingLicenseNumber: licenseNumber,
            upiId,
            verificationStatus: "pending_review",
            driverAvailability: "searching",
            lifetime_earnings: 0,
            total_completed_trips: 0
        });
    }

    return profileData;
}

async function phoneAlreadyExists(admin, phone) {
    try {
        await admin.auth().getUserByPhoneNumber(phone);
        return true;
    } catch (error) {
        if (error.code !== "auth/user-not-found") {
            throw error;
        }
    }

    const indexSnap = await admin.firestore().collection("phoneLoginIndex").doc(phone).get();
    if (indexSnap.exists) return true;

    const userSnap = await admin.firestore().collection("users").where("phone", "==", phone).limit(1).get();
    return !userSnap.empty;
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    let createdUid = "";

    try {
        const body = await readJsonBody(req);
        const tokenPayload = verifyToken(body.verificationToken, "register");
        const password = String(body.password || "");

        if (password.length < 6) {
            return json(res, 400, { error: "Password must be at least 6 characters." });
        }

        const admin = getAdmin();
        if (await phoneAlreadyExists(admin, tokenPayload.phone)) {
            return json(res, 409, { error: "An account already exists for this mobile number. Please login instead." });
        }

        const base = validateBaseProfile(body.profile || {});
        const userRecord = await admin.auth().createUser({
            email: base.email,
            password,
            displayName: base.name,
            phoneNumber: tokenPayload.phone
        });
        createdUid = userRecord.uid;

        const profileData = buildProfile(createdUid, tokenPayload.phone, {
            ...(body.profile || {}),
            ...base
        });

        await admin.firestore().collection("users").doc(createdUid).set(profileData);
        await admin.firestore().collection("phoneLoginIndex").doc(tokenPayload.phone).set({
            uid: createdUid,
            email: profileData.email,
            role: profileData.role,
            phone: tokenPayload.phone,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const customToken = await admin.auth().createCustomToken(createdUid);

        return json(res, 200, {
            ok: true,
            customToken,
            profile: {
                ...profileData,
                createdAt: Date.now()
            }
        });
    } catch (error) {
        console.error("Registration failed:", error);
        if (createdUid) {
            try {
                await getAdmin().auth().deleteUser(createdUid);
            } catch (cleanupError) {
                console.error("Registration cleanup failed:", cleanupError);
            }
        }
        return json(res, error.status || 500, {
            error: error.message || "Could not create account. Please try again."
        });
    }
};
