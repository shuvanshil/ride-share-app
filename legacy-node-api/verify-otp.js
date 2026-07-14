const {
    TWOFACTOR_BASE_URL,
    buildVerificationToken,
    fetchTwoFactorJson,
    json,
    methodNotAllowed,
    normalizePhone,
    normalizePurpose,
    readJsonBody,
    requireEnv
} = require("./_otp");

function isOtpMatched(data) {
    const status = String(data.Status || "").toLowerCase();
    const details = String(data.Details || "").toLowerCase();
    return details === "otp matched" || (status === "success" && details.includes("matched"));
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    try {
        const body = await readJsonBody(req);
        const phone = normalizePhone(body.phone);
        const purpose = normalizePurpose(body.purpose);
        const otp = String(body.otp || "").trim();
        const otpSessionId = String(body.otpSessionId || "").trim();

        if (!phone) {
            return json(res, 400, { error: "Enter a valid 10-digit Indian mobile number." });
        }
        if (!/^\d{4,8}$/.test(otp)) {
            return json(res, 400, { error: "Enter the OTP sent to your phone." });
        }
        if (!otpSessionId) {
            return json(res, 400, { error: "OTP session is missing. Request a new OTP." });
        }

        const apiKey = requireEnv("TWOFACTOR_API_KEY");
        const verifyUrl = [
            TWOFACTOR_BASE_URL,
            encodeURIComponent(apiKey),
            "SMS",
            "VERIFY",
            encodeURIComponent(otpSessionId),
            encodeURIComponent(otp)
        ].join("/");

        const data = await fetchTwoFactorJson(verifyUrl);

        if (!isOtpMatched(data)) {
            return json(res, 400, {
                error: "That OTP is incorrect or expired.",
                providerStatus: data.Status || "",
                providerDetails: data.Details || ""
            });
        }

        return json(res, 200, {
            ok: true,
            phone,
            purpose,
            verificationToken: buildVerificationToken(phone, purpose)
        });
    } catch (error) {
        console.error("2Factor verify OTP failed:", error);
        return json(res, error.status || 500, {
            error: "Could not verify OTP. Please try again.",
            message: error.message
        });
    }
};
