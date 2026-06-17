const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson,
    extractItems,
    normalizeSuggestion
} = require("./_mappls");

function buildDetailUrls(eLoc, accessToken, restKey) {
    const encodedELoc = encodeURIComponent(eLoc);
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const urls = [
        `https://atlas.mappls.com/api/places/details/json?eloc=${encodedELoc}&access_token=${encodedToken}`,
        `https://atlas.mappls.com/api/places/details/json?place_id=${encodedELoc}&access_token=${encodedToken}`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/place_detail?eloc=${encodedELoc}`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/place_detail?place_id=${encodedELoc}`
    ];

    if (restKey) {
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/place_detail?eloc=${encodedELoc}`);
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/place_detail?place_id=${encodedELoc}`);
    }

    return urls;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const eLoc = String(req.query?.eloc || req.query?.place_id || "").trim();
    if (!eLoc) {
        return json(res, 400, { error: "Missing eloc" });
    }

    try {
        const config = getMapplsConfig();
        const accessToken = await getAccessToken();

        for (const url of buildDetailUrls(eLoc, accessToken, config.restKey)) {
            try {
                const data = await fetchJson(url);
                const item = extractItems(data)[0] || data;
                const result = normalizeSuggestion({ ...item, eLoc }, eLoc);
                if (result.lat != null && result.lng != null) {
                    return json(res, 200, { result });
                }
            } catch (_) {
                // Try next endpoint variant.
            }
        }

        return json(res, 404, { error: "Place detail not found" });
    } catch (error) {
        return json(res, 500, {
            error: "Mappls place detail failed",
            message: error.message
        });
    }
};
