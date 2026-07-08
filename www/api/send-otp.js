const {
    OTP_TEMPLATE_NAME,
    TWOFACTOR_BASE_URL,
    fetchTwoFactorJson,
    json,
    methodNotAllowed,
    normalizePhone,
    normalizePurpose,
    readJsonBody,
    requireEnv,
    twoFactorPhone
} = require("./_otp");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return methodNotAllowed(res);
    }

    try {
        const body = await readJsonBody(req);
        const phone = normalizePhone(body.phone);
        const purpose = normalizePurpose(body.purpose);

        if (!phone) {
            return json(res, 400, { error: "Enter a valid 10-digit Indian mobile number." });
        }

        const apiKey = requireEnv("TWOFACTOR_API_KEY");
        const templateName = String(process.env.TWOFACTOR_OTP_TEMPLATE || OTP_TEMPLATE_NAME || "").trim();
        const parts = [
            TWOFACTOR_BASE_URL,
            encodeURIComponent(apiKey),
            "SMS",
            encodeURIComponent(twoFactorPhone(phone)),
            "AUTOGEN"
        ];
        if (templateName) {
            parts.push(encodeURIComponent(templateName));
        }

        const data = await fetchTwoFactorJson(parts.join("/"));

        if (data.Status !== "Success" || !data.Details) {
            return json(res, 502, {
                error: "Could not send OTP.",
                providerStatus: data.Status || "",
                providerDetails: data.Details || ""
            });
        }

        return json(res, 200, {
            ok: true,
            phone,
            purpose,
            otpSessionId: data.Details,
            provider: "2factor"
        });
    } catch (error) {
        console.error("2Factor send OTP failed:", error);
        return json(res, error.status || 500, {
            error: "Could not send OTP. Please try again.",
            message: error.message
        });
    }
};
