const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

function getComponent(components = [], type) {
    return components.find((component) => Array.isArray(component.types) && component.types.includes(type))?.long_name || "";
}

function compactParts(parts) {
    const seen = new Set();
    return parts
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .filter((part) => {
            const key = part.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function buildDetailedAddress(item = {}) {
    const components = Array.isArray(item.address_components) ? item.address_components : [];
    const premise = getComponent(components, "premise")
        || getComponent(components, "point_of_interest")
        || getComponent(components, "establishment")
        || getComponent(components, "sublocality_level_3");
    const road = getComponent(components, "route");
    const locality = getComponent(components, "sublocality_level_2")
        || getComponent(components, "sublocality_level_1")
        || getComponent(components, "locality")
        || getComponent(components, "postal_town");
    const city = getComponent(components, "locality")
        || getComponent(components, "postal_town")
        || getComponent(components, "administrative_area_level_3");
    const district = getComponent(components, "administrative_area_level_2");
    const state = getComponent(components, "administrative_area_level_1");
    const pinCode = getComponent(components, "postal_code");
    const formatted = String(item.formatted_address || "").trim();

    return {
        name: premise || road || locality || city || formatted || "Pinned location",
        displayAddress: compactParts([premise, road, locality, city, district, state, pinCode]).join(", ") || formatted,
        landmark: premise,
        road,
        locality,
        city,
        district,
        state,
        pinCode
    };
}

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

        const details = buildDetailedAddress(item);

        return json(res, 200, {
            result: {
                name: details.name,
                fullAddress: item.formatted_address || "",
                displayAddress: details.displayAddress,
                landmark: details.landmark,
                road: details.road,
                locality: details.locality,
                city: details.city,
                district: details.district,
                state: details.state,
                pinCode: details.pinCode,
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
