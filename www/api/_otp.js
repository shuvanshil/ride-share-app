const crypto = require("crypto");
const { json } = require("./_google");

const OTP_TEMPLATE_NAME = process.env.TWOFACTOR_OTP_TEMPLATE || "OTP1";
const TWOFACTOR_BASE_URL = "https://2factor.in/API/V1";
const TOKEN_TTL_MS = 10 * 60 * 1000;

function getEnv(name) {
    return process.env[name] || "";
}

function requireEnv(name) {
    const value = getEnv(name);
    if (!value) {
        throw new Error(`Missing ${name}.`);
    }
    return value;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16 * 1024) {
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

function normalizePhone(value) {
    const rawPhone = String(value || "").trim().replace(/\D/g, "");
    const nationalPhone = rawPhone.startsWith("91") && rawPhone.length === 12
        ? rawPhone.slice(2)
        : rawPhone;

    if (!/^[6-9]\d{9}$/.test(nationalPhone)) {
        return "";
    }

    return `+91${nationalPhone}`;
}

function normalizePurpose(value) {
    return value === "reset" ? "reset" : "register";
}

function signToken(payload) {
    const secret = requireEnv("OTP_SESSION_SECRET");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("base64url");

    return `${body}.${signature}`;
}

function verifyToken(token, expectedPurpose = "") {
    const secret = requireEnv("OTP_SESSION_SECRET");
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature) {
        throw new Error("Invalid verification token.");
    }

    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("base64url");

    const signatureBuffer = Buffer.from(signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    const isValidSignature = signatureBuffer.length === expectedSignatureBuffer.length
        && crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer);

    if (!isValidSignature) {
        throw new Error("Invalid verification token.");
    }

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.phone || !payload.purpose || !payload.expiresAt) {
        throw new Error("Invalid verification token.");
    }

    if (expectedPurpose && payload.purpose !== expectedPurpose) {
        throw new Error("This verification token cannot be used here.");
    }

    if (Date.now() > Number(payload.expiresAt)) {
        throw new Error("This verification has expired. Please request a new OTP.");
    }

    return payload;
}

async function fetchTwoFactorJson(url) {
    const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const error = new Error(data.Details || data.Status || `2Factor HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

function twoFactorPhone(phoneNumber) {
    return phoneNumber.replace(/^\+/, "");
}

function buildVerificationToken(phone, purpose) {
    return signToken({
        phone,
        purpose,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + TOKEN_TTL_MS
    });
}

function methodNotAllowed(res) {
    return json(res, 405, { error: "Method not allowed" });
}

module.exports = {
    TWOFACTOR_BASE_URL,
    OTP_TEMPLATE_NAME,
    buildVerificationToken,
    fetchTwoFactorJson,
    json,
    methodNotAllowed,
    normalizePhone,
    normalizePurpose,
    readJsonBody,
    requireEnv,
    twoFactorPhone,
    verifyToken
};
