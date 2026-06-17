const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson,
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

function buildSearchUrls(query, accessToken, restKey) {
    const encodedQuery = encodeURIComponent(query);
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const bias = encodeURIComponent("91.9882,23.8315");
    const urls = [
        `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&location=${bias}&access_token=${encodedToken}`,
        `https://atlas.mappls.com/api/places/search/json?query=${encodedQuery}&region=IND&access_token=${encodedToken}`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/autosuggest?query=${encodedQuery}&region=IND&location=${bias}`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/geo_code?addr=${encodedQuery}&region=IND`
    ];

    if (restKey) {
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/autosuggest?query=${encodedQuery}&region=IND&location=${bias}`);
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/geo_code?addr=${encodedQuery}&region=IND`);
    }

    return urls;
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

async function searchMappls(query) {
    const config = getMapplsConfig();
    const accessToken = await getAccessToken();
    const rawResults = [];

    for (const queryVariant of buildQueryVariants(query)) {
        for (const url of buildSearchUrls(queryVariant, accessToken, config.restKey)) {
            try {
                const data = await fetchJson(url);
                rawResults.push(...extractItems(data).map((item) => normalizeSuggestion(item, queryVariant)));
            } catch (_) {
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

    return dedupe(enriched)
        .filter((item) => item.lat != null && item.lng != null)
        .slice(0, 8);
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
        const results = await searchMappls(query);
        return json(res, 200, { results });
    } catch (error) {
        return json(res, 500, {
            error: "Mappls search failed",
            message: error.message
        });
    }
};
