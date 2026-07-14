const admin = require("firebase-admin");

function getEnv(name) {
    return process.env[name] || "";
}

function getPrivateKey() {
    const key = getEnv("FIREBASE_PRIVATE_KEY");
    return key ? key.replace(/\\n/g, "\n") : "";
}

function getAdminApp() {
    if (admin.apps.length) {
        return admin.apps[0];
    }

    const projectId = getEnv("FIREBASE_PROJECT_ID");
    const clientEmail = getEnv("FIREBASE_CLIENT_EMAIL");
    const privateKey = getPrivateKey();

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error("Missing Firebase Admin environment variables.");
    }

    return admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey
        })
    });
}

function getAdmin() {
    getAdminApp();
    return admin;
}

module.exports = {
    getAdmin
};
