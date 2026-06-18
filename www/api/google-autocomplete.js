const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

function buildQueryVariants(query) {
    const clean = String(query || "").trim().replace(/\s+/g, " ");
    const lower = clean.toLowerCase();
    const variants = [
        clean,
        `${clean} Tripura`,
        `${clean} India`
    ];

    if (!/(agartala|kailashahar|kumarghat|dharmanagar|ambassa|udaipur|belonia|khowai|teliamura|unakoti|tripura)/.test(lower)) {
        variants.push(`${clean} Kailashahar Tripura`);
        variants.push(`${clean} Unakoti Tripura`);
        variants.push(`${clean} Agartala Tripura`);
    }

    return [...new Set(variants)].filter(Boolean).slice(0, 6);
}

function normalizePrediction(prediction = {}) {
    const structured = prediction.structuredFormat || {};
    const mainName = structured.mainText?.text || prediction.text?.text || "";
    const fullAddress = structured.secondaryText?.text || prediction.text?.text || "";

    return {
        placeId: prediction.placeId || "",
        name: mainName || fullAddress,
        mainName: mainName || fullAddress,
        fullAddress: fullAddress || mainName,
        types: Array.isArray(prediction.types) ? prediction.types : [],
        lat: null,
        lng: null,
        source: "google",
        provider: "google"
    };
}

function normalizeTextSearchPlace(place = {}) {
    const lat = numberOrNull(place.location?.latitude);
    const lng = numberOrNull(place.location?.longitude);
    const mainName = place.displayName?.text || place.formattedAddress || "";

    return {
        placeId: place.id || "",
        name: mainName,
        mainName,
        fullAddress: place.formattedAddress || "",
        types: Array.isArray(place.types) ? place.types : [],
        lat,
        lng,
        source: "google",
        provider: "google"
    };
}

async function fetchAutocomplete(input, key, lat, lng) {
    const body = {
        input,
        includedRegionCodes: ["in"],
        includeQueryPredictions: false,
        locationBias: {
            circle: {
                center: {
                    latitude: Number.isFinite(lat) ? lat : 23.8315,
                    longitude: Number.isFinite(lng) ? lng : 91.9882
                },
                radius: 100000
            }
        }
    };

    const data = await fetchJson("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types"
        },
        body: JSON.stringify(body)
    });

    return (Array.isArray(data.suggestions) ? data.suggestions : [])
        .map((suggestion) => suggestion.placePrediction)
        .filter(Boolean)
        .map(normalizePrediction);
}

async function fetchTextSearch(input, key, lat, lng) {
    const body = {
        textQuery: input,
        regionCode: "IN",
        locationBias: {
            circle: {
                center: {
                    latitude: Number.isFinite(lat) ? lat : 23.8315,
                    longitude: Number.isFinite(lng) ? lng : 91.9882
                },
                radius: 100000
            }
        }
    };

    const data = await fetchJson("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types"
        },
        body: JSON.stringify(body)
    });

    return (Array.isArray(data.places) ? data.places : [])
        .map(normalizeTextSearchPlace);
}

async function fetchGeocode(input, key) {
    const params = new URLSearchParams({
        address: input,
        region: "in",
        key
    });
    const data = await fetchJson(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
    const results = Array.isArray(data.results) ? data.results : [];

    return results.map((item) => {
        const location = item.geometry?.location || {};
        const fullAddress = item.formatted_address || "";
        const mainName = item.address_components?.[0]?.long_name || fullAddress;

        return {
            placeId: item.place_id || "",
            name: mainName,
            mainName,
            fullAddress,
            types: Array.isArray(item.types) ? item.types : [],
            lat: numberOrNull(location.lat),
            lng: numberOrNull(location.lng),
            source: "google",
            provider: "google"
        };
    });
}

async function collectSafe(label, debug, task) {
    try {
        const results = await task();
        debug.push({ label, ok: true, count: results.length });
        return results;
    } catch (error) {
        debug.push({
            label,
            ok: false,
            status: error.status || 0,
            message: error.data?.error?.message || error.data?.error_message || error.message
        });
        return [];
    }
}

function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => {
        const key = [
            String(item.placeId || "").toLowerCase(),
            String(item.mainName || item.name || "").toLowerCase(),
            String(item.fullAddress || "").toLowerCase()
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const query = String(req.query?.q || "").trim();
    if (query.length < 2) {
        return json(res, 200, { results: [] });
    }

    const lat = numberOrNull(req.query?.lat);
    const lng = numberOrNull(req.query?.lng);

    try {
        const key = requireServerKey();
        const debug = [];
        const results = [];

        for (const variant of buildQueryVariants(query)) {
            results.push(...await collectSafe(`autocomplete:${variant}`, debug, () => fetchAutocomplete(variant, key, lat, lng)));
            if (results.length >= 8) break;

            results.push(...await collectSafe(`text:${variant}`, debug, () => fetchTextSearch(variant, key, lat, lng)));
            if (results.length >= 8) break;

            results.push(...await collectSafe(`geocode:${variant}`, debug, () => fetchGeocode(variant, key)));
            if (results.length >= 8) break;
        }

        const payload = {
            results: dedupe(results).slice(0, 8)
        };
        if (req.query?.debug === "1") {
            payload.debug = debug;
        }

        return json(res, 200, payload);
    } catch (error) {
        return json(res, 500, {
            error: "Google autocomplete failed",
            message: error.message,
            status: error.status || 0
        });
    }
};
