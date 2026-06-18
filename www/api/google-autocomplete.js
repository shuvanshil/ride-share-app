const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

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
        const autocomplete = await fetchAutocomplete(query, key, lat, lng).catch(() => []);
        const textSearch = autocomplete.length
            ? []
            : await fetchTextSearch(query, key, lat, lng).catch(() => []);

        return json(res, 200, {
            results: dedupe([...autocomplete, ...textSearch]).slice(0, 8)
        });
    } catch (error) {
        return json(res, 500, {
            error: "Google autocomplete failed",
            message: error.message,
            status: error.status || 0
        });
    }
};
