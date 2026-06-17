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

function buildCoordinateLookupRequests(query, accessToken, restKey, pickupLat, pickupLng) {
    const cleanQuery = String(query || "").trim().replace(/\s+/g, " ");
    if (!cleanQuery) return [];

    const encodedQuery = encodeURIComponent(cleanQuery);
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const hasPickup = Number.isFinite(pickupLat) && Number.isFinite(pickupLng);
    const searchLocation = hasPickup
        ? `${pickupLng},${pickupLat}`
        : "91.9882,23.8315";
    const nearbyLocation = hasPickup
        ? `${pickupLat},${pickupLng}`
        : "23.8315,91.9882";
    const encodedSearchLocation = encodeURIComponent(searchLocation);
    const encodedNearbyLocation = encodeURIComponent(nearbyLocation);
    const requests = [
        { url: `https://atlas.mappls.com/api/places/textsearch/json?query=${encodedQuery}&region=IND&location=${encodedSearchLocation}&access_token=${encodedToken}` },
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&location=${encodedSearchLocation}&access_token=${encodedToken}` },
        { url: `https://atlas.mappls.com/api/places/geocode?address=${encodedQuery}&region=IND&access_token=${encodedToken}` },
        { url: `https://atlas.mappls.com/api/places/geocode/json?address=${encodedQuery}&region=IND&access_token=${encodedToken}` },
        { url: `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/geo_code?addr=${encodedQuery}&region=IND` },
        { url: `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/nearby_search?keywords=${encodedQuery}&refLocation=${encodedNearbyLocation}&radius=50000` }
    ];

    if (restKey) {
        requests.push({ url: `https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/geo_code?addr=${encodedQuery}&region=IND` });
        requests.push({ url: `https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/nearby_search?keywords=${encodedQuery}&refLocation=${encodedNearbyLocation}&radius=50000` });
    }

    return requests;
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

async function resolveByQuery(query, accessToken, restKey, pickupLat, pickupLng, debug) {
    for (const request of buildCoordinateLookupRequests(query, accessToken, restKey, pickupLat, pickupLng)) {
        try {
            const meta = await fetchJsonWithMeta(request.url, { headers: request.headers || {} });
            debug.push({
                status: meta.status,
                ok: meta.ok,
                host: new URL(request.url).host,
                path: new URL(request.url).pathname,
                sample: safeSample(meta.data)
            });

            if (!meta.ok) continue;

            const items = extractItems(meta.data);
            for (const item of items) {
                const result = normalizeSuggestion(item, query);
                if (result.lat != null && result.lng != null) {
                    return result;
                }
            }
        } catch (error) {
            debug.push({
                status: 0,
                ok: false,
                message: error.message
            });
        }
    }

    return null;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const eLoc = String(req.query?.eloc || req.query?.place_id || "").trim();
    const query = String(req.query?.q || "").trim();
    const pickupLat = Number(req.query?.pickupLat);
    const pickupLng = Number(req.query?.pickupLng);
    if (!eLoc && !query) {
        return json(res, 400, { error: "Missing eloc or query" });
    }

    try {
        const config = getMapplsConfig();
        const accessToken = await getAccessToken();
        const debug = [];

        if (eLoc) {
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
        }

        const queryResolved = await resolveByQuery(query || eLoc, accessToken, config.restKey, pickupLat, pickupLng, debug);
        if (queryResolved) {
            const payload = { result: { ...queryResolved, eLoc: queryResolved.eLoc || eLoc } };
            if (req.query?.debug === "1") payload.debug = debug;
            return json(res, 200, payload);
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
