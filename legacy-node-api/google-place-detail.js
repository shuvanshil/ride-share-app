const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

function normalizePlace(place = {}) {
    const location = place.location || {};
    const lat = numberOrNull(location.latitude ?? location.lat);
    const lng = numberOrNull(location.longitude ?? location.lng);
    const displayName = place.displayName?.text || place.name || "";

    return {
        placeId: String(place.id || "").trim(),
        name: displayName,
        mainName: displayName,
        fullAddress: place.formattedAddress || "",
        lat,
        lng,
        types: Array.isArray(place.types) ? place.types : [],
        typeHint: "",
        source: "google",
        provider: "google"
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const placeId = String(req.query?.placeId || "").trim();
    if (!placeId) {
        return json(res, 400, { error: "Missing placeId" });
    }

    try {
        const key = requireServerKey();
        const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
        const data = await fetchJson(url, {
            headers: {
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "id,displayName,formattedAddress,location,types"
            }
        });
        const result = normalizePlace(data);

        if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
            return json(res, 404, { error: "Place location not found" });
        }

        return json(res, 200, { result });
    } catch (error) {
        return json(res, 500, {
            error: "Google place detail failed",
            message: error.message,
            status: error.status || 0
        });
    }
};
