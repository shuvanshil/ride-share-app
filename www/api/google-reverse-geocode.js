const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const lat = numberOrNull(req.query?.lat);
    const lng = numberOrNull(req.query?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return json(res, 400, { error: "Missing lat/lng" });
    }

    try {
        const key = requireServerKey();
        const params = new URLSearchParams({
            latlng: `${lat},${lng}`,
            key
        });
        const data = await fetchJson(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
        const item = Array.isArray(data.results) ? data.results[0] : null;

        if (!item) {
            return json(res, 404, { error: "Address not found" });
        }

        return json(res, 200, {
            result: {
                name: item.address_components?.[0]?.long_name || item.formatted_address || "Pinned destination",
                fullAddress: item.formatted_address || "",
                placeId: item.place_id || "",
                lat,
                lng,
                source: "google",
                provider: "google"
            }
        });
    } catch (error) {
        return json(res, 500, {
            error: "Google reverse geocode failed",
            message: error.message,
            status: error.status || 0
        });
    }
};
