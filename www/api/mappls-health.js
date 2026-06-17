const { json, getMapplsConfig, getAccessToken } = require("./_mappls");

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const config = getMapplsConfig();
    try {
        await getAccessToken();
        return json(res, 200, {
            ok: true,
            hasClientId: Boolean(config.clientId),
            hasClientSecret: Boolean(config.clientSecret),
            hasRestKey: Boolean(config.restKey),
            hasAccessToken: Boolean(config.accessToken)
        });
    } catch (error) {
        return json(res, 500, {
            ok: false,
            hasClientId: Boolean(config.clientId),
            hasClientSecret: Boolean(config.clientSecret),
            hasRestKey: Boolean(config.restKey),
            hasAccessToken: Boolean(config.accessToken),
            message: error.message
        });
    }
};
