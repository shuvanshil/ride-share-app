const { json, getGoogleConfig } = require("./_google");

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const { browserKey } = getGoogleConfig();
    if (!browserKey) {
        return json(res, 500, { error: "Missing GOOGLE_MAPS_BROWSER_KEY." });
    }

    return json(res, 200, { browserKey });
};
