const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson,
    fetchJsonWithMeta,
    extractItems,
    normalizeSuggestion,
    dedupe
} = require("./_mappls");

function buildQueryVariants(query) {
    const cleanQuery = String(query || "").trim().replace(/\s+/g, " ");
    const lower = cleanQuery.toLowerCase();
    const variants = [
        cleanQuery,
        `${cleanQuery} Tripura`
    ];

    if (!/(agartala|kailashahar|kumarghat|dharmanagar|ambassa|udaipur|belonia|khowai|teliamura|sonamura|bishalgarh|kamalpur|santirbazar|panisagar)/.test(lower)) {
        variants.push(`${cleanQuery} Agartala`);
        variants.push(`${cleanQuery} Kailashahar`);
    }

    if (lower.includes("mandir")) {
        variants.push(cleanQuery.replace(/\bmandir\b/gi, "temple"));
    }

    if (lower.includes("temple")) {
        variants.push(cleanQuery.replace(/\btemple\b/gi, "mandir"));
    }

    if (lower.includes("sbi")) {
        variants.push(cleanQuery.replace(/\bsbi\b/gi, "State Bank of India"));
    }

    if (lower.includes("police") && !lower.includes("station")) {
        variants.push(`${cleanQuery} police station`);
    }

    return [...new Set(variants)].filter(Boolean).slice(0, 5);
}

function buildSearchRequests(query, accessToken, restKey) {
    const encodedQuery = encodeURIComponent(query);
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const bias = encodeURIComponent("91.9882,23.8315");
    const requests = [
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&location=${bias}&access_token=${encodedToken}` },
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&access_token=${encodedToken}` },
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&location=${bias}`, headers: { Authorization: `Bearer ${accessToken}` } },
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND`, headers: { Authorization: `Bearer ${accessToken}` } },
        { url: `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&location=${bias}`, headers: { Authorization: accessToken } },
        { url: `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/autosuggest?query=${encodedQuery}&region=IND&location=${bias}` },
        { url: `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/geo_code?addr=${encodedQuery}&region=IND` }
    ];

    if (restKey) {
        requests.push({ url: `https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/autosuggest?query=${encodedQuery}&region=IND&location=${bias}` });
        requests.push({ url: `https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/geo_code?addr=${encodedQuery}&region=IND` });
    }

    return requests;
}

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

async function fetchPlaceDetail(eLoc, accessToken, restKey, fallbackQuery) {
    if (!eLoc) return null;

    for (const url of buildDetailUrls(eLoc, accessToken, restKey)) {
        try {
            const data = await fetchJson(url);
            const item = extractItems(data)[0] || data;
            const normalized = normalizeSuggestion({ ...item, eLoc }, fallbackQuery);
            if (normalized.lat != null && normalized.lng != null) {
                return normalized;
            }
        } catch (_) {
            // Try the next Mappls URL variant.
        }
    }

    return null;
}

function summarizeData(data) {
    if (!data || typeof data !== "object") return "";
    return data.error || data.message || data.responseMessage || data.status || "";
}

function getBucketCounts(data) {
    const buckets = {
        suggestedLocations: data?.suggestedLocations,
        results: data?.results,
        items: data?.items,
        places: data?.places,
        rowLocations: data?.rowLocations,
        responseSuggestedLocations: data?.response?.suggestedLocations,
        responseResults: data?.response?.results,
        responseRowLocations: data?.response?.rowLocations,
        dataSuggestedLocations: data?.data?.suggestedLocations,
        dataResults: data?.data?.results,
        dataRowLocations: data?.data?.rowLocations
    };

    return Object.fromEntries(
        Object.entries(buckets)
            .filter(([, value]) => Array.isArray(value))
            .map(([key, value]) => [key, value.length])
    );
}

function getSearchItems(data) {
    const suggested = Array.isArray(data?.suggestedLocations)
        ? data.suggestedLocations
        : Array.isArray(data?.response?.suggestedLocations)
            ? data.response.suggestedLocations
            : Array.isArray(data?.data?.suggestedLocations)
                ? data.data.suggestedLocations
                : [];
    const rows = Array.isArray(data?.rowLocations)
        ? data.rowLocations
        : Array.isArray(data?.response?.rowLocations)
            ? data.response.rowLocations
            : Array.isArray(data?.data?.rowLocations)
                ? data.data.rowLocations
                : [];

    if (suggested.length && rows.length) {
        return suggested.map((item, index) => {
            const eLoc = item.eLoc || item.eloc || item.placeId || item.place_id || item.mapplsPin || "";
            const matchingRow = rows.find((row) => {
                const rowELoc = row.eLoc || row.eloc || row.placeId || row.place_id || row.mapplsPin || "";
                return eLoc && rowELoc && String(eLoc).toLowerCase() === String(rowELoc).toLowerCase();
            }) || rows[index] || {};

            return { ...matchingRow, ...item };
        });
    }

    return extractItems(data);
}

function getFirstItem(data) {
    return getSearchItems(data)[0] || null;
}

function safeSample(item) {
    if (!item || typeof item !== "object") return null;

    return {
        keys: Object.keys(item).slice(0, 20),
        placeName: item.placeName || item.place_name || item.name || item.poi || "",
        placeAddress: item.placeAddress || item.formatted_address || item.address || "",
        eLoc: item.eLoc || item.eloc || item.placeId || item.place_id || item.mapplsPin || "",
        latitude: item.latitude ?? item.lat ?? item.y ?? item.entryLatitude ?? null,
        longitude: item.longitude ?? item.lng ?? item.lon ?? item.x ?? item.entryLongitude ?? null
    };
}

async function searchMappls(query) {
    const config = getMapplsConfig();
    const accessToken = await getAccessToken();
    const rawResults = [];
    const debug = [];

    for (const queryVariant of buildQueryVariants(query)) {
        for (const request of buildSearchRequests(queryVariant, accessToken, config.restKey)) {
            try {
                const meta = await fetchJsonWithMeta(request.url, { headers: request.headers || {} });
                debug.push({
                    status: meta.status,
                    ok: meta.ok,
                    host: new URL(request.url).host,
                    path: new URL(request.url).pathname,
                    message: summarizeData(meta.data),
                    topLevelKeys: meta.data && typeof meta.data === "object" ? Object.keys(meta.data).slice(0, 20) : [],
                    bucketCounts: getBucketCounts(meta.data),
                    sample: safeSample(getFirstItem(meta.data))
                });

                if (meta.ok) {
                    rawResults.push(...getSearchItems(meta.data).map((item) => normalizeSuggestion(item, queryVariant)));
                }
            } catch (error) {
                debug.push({
                    status: 0,
                    ok: false,
                    message: error.message
                });
                // Mappls accounts differ by endpoint/version; keep trying variants.
            }

            if (rawResults.length >= 12) break;
        }

        if (rawResults.length >= 12) break;
    }

    const enriched = [];
    for (const result of dedupe(rawResults)) {
        if (result.lat != null && result.lng != null) {
            enriched.push(result);
            continue;
        }

        const detailed = await fetchPlaceDetail(result.eLoc, accessToken, config.restKey, query);
        if (detailed) {
            enriched.push(detailed);
        }
    }

    return {
        results: dedupe([...enriched, ...rawResults])
            .slice(0, 8),
        debug
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const query = String(req.query?.q || "").trim();
    if (query.length < 2) {
        return json(res, 200, { results: [] });
    }

    try {
        const output = await searchMappls(query);
        const payload = { results: output.results };
        if (req.query?.debug === "1") {
            payload.debug = output.debug.slice(0, 30);
        }
        return json(res, 200, payload);
    } catch (error) {
        return json(res, 500, {
            error: "Mappls search failed",
            message: error.message
        });
    }
};
