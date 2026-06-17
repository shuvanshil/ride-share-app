const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJsonWithMeta,
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

function safeSample(data) {
    const item = extractItems(data)[0] || data;
    if (!item || typeof item !== "object") return null;

    return {
        topLevelKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
        itemKeys: Object.keys(item).slice(0, 30),
        placeName: item.placeName || item.place_name || item.name || item.poi || "",
        placeAddress: item.placeAddress || item.formatted_address || item.address || "",
        eLoc: item.eLoc || item.eloc || item.placeId || item.place_id || item.mapplsPin || "",
        latitude: item.latitude ?? item.lat ?? item.y ?? item.entryLatitude ?? null,
        longitude: item.longitude ?? item.lng ?? item.lon ?? item.x ?? item.entryLongitude ?? null,
        message: data?.message || data?.error || data?.responseMessage || data?.status || ""
    };
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
        const debug = [];

        for (const url of buildDetailUrls(eLoc, accessToken, config.restKey)) {
            try {
                const meta = await fetchJsonWithMeta(url);
                debug.push({
                    status: meta.status,
                    ok: meta.ok,
                    host: new URL(url).host,
                    path: new URL(url).pathname,
                    sample: safeSample(meta.data)
                });

                if (!meta.ok) continue;

                const item = extractItems(meta.data)[0] || meta.data;
                const result = normalizeSuggestion({ ...item, eLoc }, eLoc);
                if (result.lat != null && result.lng != null) {
                    const payload = { result };
                    if (req.query?.debug === "1") payload.debug = debug;
                    return json(res, 200, payload);
                }
            } catch (error) {
                debug.push({
                    status: 0,
                    ok: false,
                    message: error.message
                });
                // Try next endpoint variant.
            }
        }

        const payload = { error: "Place detail not found" };
        if (req.query?.debug === "1") payload.debug = debug;
        return json(res, 404, payload);
    } catch (error) {
        return json(res, 500, {
            error: "Mappls place detail failed",
            message: error.message
        });
    }
};
