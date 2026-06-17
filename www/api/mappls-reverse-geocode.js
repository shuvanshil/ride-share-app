const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson,
    extractItems
} = require("./_mappls");

function buildAddress(item = {}) {
    const parts = [
        item.poi,
        item.houseName,
        item.house_number,
        item.street,
        item.road,
        item.locality,
        item.subLocality,
        item.village,
        item.town,
        item.city,
        item.district,
        item.state_district,
        item.state,
        item.formatted_address,
        item.placeAddress
    ].filter(Boolean);

    return [...new Set(parts)].join(", ");
}

function buildReverseUrls(lat, lng, accessToken, restKey) {
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const urls = [
        `https://atlas.mappls.com/api/places/rev_geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&access_token=${encodedToken}`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/rev_geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`
    ];

    if (restKey) {
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/rev_geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
    }

    return urls;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const lat = Number(req.query?.lat);
    const lng = Number(req.query?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return json(res, 400, { error: "Missing lat/lng" });
    }

    try {
        const config = getMapplsConfig();
        const accessToken = await getAccessToken();

        for (const url of buildReverseUrls(lat, lng, accessToken, config.restKey)) {
            try {
                const data = await fetchJson(url);
                const item = extractItems(data)[0] || data;
                const address = buildAddress(item);
                if (address) {
                    return json(res, 200, {
                        result: {
                            lat,
                            lng,
                            fullAddress: address,
                            name: item.poi || item.placeName || address,
                            source: "mappls",
                            provider: "mappls"
                        }
                    });
                }
            } catch (_) {
                // Try next endpoint variant.
            }
        }

        return json(res, 404, { error: "Address not found" });
    } catch (error) {
        return json(res, 500, {
            error: "Mappls reverse geocode failed",
            message: error.message
        });
    }
};
