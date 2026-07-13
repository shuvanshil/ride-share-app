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

// Reverse geocoding in less-mapped areas (rural roads, unnamed lanes, small
// plots) often resolves the most specific component to a bare plot/ward
// number instead of a real name, e.g. "122" or "221". Those are useless as a
// pickup label, so we filter them out here rather than showing raw digits.
function isMeaningfulLabel(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return false;
    // Reject pure numbers and short number+letter codes (plot/house/ward numbers).
    if (/^\d+[a-zA-Z]?$/.test(trimmed)) return false;
    return true;
}

// Google plus codes (e.g. "8XCC+2Q") sometimes lead the formatted address in
// areas without a precise street address. Strip that prefix so it never ends
// up as the visible pickup text.
function stripPlusCode(value) {
    return String(value || "")
        .replace(/^[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,3}\s*,?\s*/i, "")
        .trim();
}

function buildDetailedAddress(item = {}) {
    const components = Array.isArray(item.address_components) ? item.address_components : [];

    const premiseRaw = getComponent(components, "premise")
        || getComponent(components, "point_of_interest")
        || getComponent(components, "establishment")
        || getComponent(components, "sublocality_level_3");
    const roadRaw = getComponent(components, "route");
    const localityRaw = getComponent(components, "sublocality_level_2")
        || getComponent(components, "sublocality_level_1")
        || getComponent(components, "neighborhood");
    const cityRaw = getComponent(components, "locality")
        || getComponent(components, "postal_town")
        || getComponent(components, "administrative_area_level_3");
    const district = getComponent(components, "administrative_area_level_2");
    const state = getComponent(components, "administrative_area_level_1");
    const pinCode = getComponent(components, "postal_code");
    const formatted = stripPlusCode(item.formatted_address || "");

    const premise = isMeaningfulLabel(premiseRaw) ? premiseRaw : "";
    const road = isMeaningfulLabel(roadRaw) ? roadRaw : "";
    const locality = isMeaningfulLabel(localityRaw) ? localityRaw : "";
    const city = isMeaningfulLabel(cityRaw) ? cityRaw : "";

    // Prefer a friendly "Area, City" style label (e.g. "City Center, Agartala")
    // built from real place names; only fall back to the raw formatted address
    // (with any plus code stripped) when nothing meaningful was returned.
    const area = premise || road || locality;
    let name;
    if (area && city && area.toLowerCase() !== city.toLowerCase()) {
        name = `${area}, ${city}`;
    } else {
        name = city || area || formatted || "Pinned location";
    }

    return {
        name,
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

// Reverse geocode responses list results from most-specific to least-specific,
// and the most-specific one is frequently a plus code or bare plot/ward number
// in areas without detailed street data. Score a handful of the top results
// and pick whichever produces the most meaningful (non-numeric) label instead
// of always trusting results[0].
function pickBestResult(results = []) {
    const candidates = results.slice(0, 5).map((item) => ({ item, details: buildDetailedAddress(item) }));
    const meaningful = candidates.find(({ details }) => isMeaningfulLabel(details.name));
    return meaningful || candidates[0] || null;
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
        const best = pickBestResult(Array.isArray(data.results) ? data.results : []);

        if (!best) {
            return json(res, 404, { error: "Address not found" });
        }

        const { item, details } = best;

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
