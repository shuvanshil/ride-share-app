const TOKEN_URL = "https://outpost.mappls.com/api/security/oauth/token";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function getEnv(name) {
    return process.env[name] || "";
}

function json(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function getMapplsConfig() {
    return {
        clientId: getEnv("MAPPLS_CLIENT_ID"),
        clientSecret: getEnv("MAPPLS_CLIENT_SECRET"),
        restKey: getEnv("MAPPLS_REST_KEY"),
        accessToken: getEnv("MAPPLS_ACCESS_TOKEN")
    };
}

async function getAccessToken() {
    const config = getMapplsConfig();

    if (config.accessToken) {
        return config.accessToken;
    }

    if (!config.clientId || !config.clientSecret) {
        throw new Error("Missing MAPPLS_CLIENT_ID or MAPPLS_CLIENT_SECRET.");
    }

    const now = Date.now();
    if (cachedToken && cachedTokenExpiresAt > now + 30000) {
        return cachedToken;
    }

    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret
    });

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
        },
        body
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Mappls token request failed: HTTP ${response.status}`);
    }

    const token = data.access_token || data.accessToken || data.token;
    if (!token) {
        throw new Error("Mappls token response did not include an access token.");
    }

    const expiresInSeconds = Number(data.expires_in || data.expiresIn || 3600);
    cachedToken = token;
    cachedTokenExpiresAt = now + (Math.max(60, expiresInSeconds - 60) * 1000);
    return cachedToken;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            "Accept-Language": "en",
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

async function fetchJsonWithMeta(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            "Accept-Language": "en",
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));
    return {
        ok: response.ok,
        status: response.status,
        data
    };
}

function extractItems(data) {
    const buckets = [
        data?.suggestedLocations,
        data?.results,
        data?.items,
        data?.places,
        data?.response?.suggestedLocations,
        data?.response?.results,
        data?.data?.suggestedLocations,
        data?.data?.results
    ];

    const items = [];
    buckets.forEach((bucket) => {
        if (Array.isArray(bucket)) items.push(...bucket);
    });

    if (!items.length && data && typeof data === "object" && !Array.isArray(data)) {
        items.push(data);
    }

    return items;
}

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function buildAddress(item = {}) {
    const address = item.address || item;
    const parts = [
        item.placeAddress,
        item.formatted_address,
        address.houseName,
        address.house_number,
        address.street,
        address.road,
        address.locality,
        address.subLocality,
        address.village,
        address.town,
        address.city,
        address.district,
        address.state_district,
        address.state
    ].filter(Boolean);

    return [...new Set(parts)].join(", ");
}

function inferTypeHint(item = {}) {
    const text = [
        item.type,
        item.placeType,
        item.poiType,
        item.category,
        item.placeName,
        item.name,
        item.keyword,
        item.placeAddress,
        item.formatted_address
    ].filter(Boolean).join(" ").toLowerCase();

    if (/(hospital|clinic|medical|health)/.test(text)) return "Hospital";
    if (/(school|college|academy|vidyalaya|university)/.test(text)) return "School";
    if (/(market|bazar|bazaar|chowmuhani|shop)/.test(text)) return "Market";
    if (/(police|thana)/.test(text)) return "Police";
    if (/(mandir|temple|place_of_worship)/.test(text)) return "Temple";
    if (/(station|stand|bus|railway)/.test(text)) return "Station";
    if (/(bank|atm|sbi|state bank)/.test(text)) return "Bank";
    if (/(office|court)/.test(text)) return "Office";
    if (/(village|para|gaon)/.test(text)) return "Village";
    if (/(road|lane)/.test(text)) return "Road";
    return "Place";
}

function normalizeSuggestion(item = {}, fallbackQuery = "") {
    const lat = numberOrNull(item.latitude ?? item.lat ?? item.y ?? item.entryLatitude);
    const lng = numberOrNull(item.longitude ?? item.lng ?? item.lon ?? item.x ?? item.entryLongitude);
    const mainName = item.placeName || item.place_name || item.name || item.poi || item.keyword || item.formatted_address || fallbackQuery;
    const fullAddress = buildAddress(item) || "Tripura, India";
    const eLoc = item.eLoc || item.eloc || item.placeId || item.place_id || item.mapplsPin || "";

    return {
        lat,
        lng,
        name: mainName || fullAddress,
        mainName: mainName || fullAddress,
        fullAddress,
        typeHint: inferTypeHint(item),
        source: "mappls",
        provider: "mappls",
        eLoc,
        rawType: item.type || item.placeType || item.poiType || item.category || ""
    };
}

function dedupe(items) {
    const seen = new Set();
    return items.filter((item) => {
        if (!item) return false;
        const key = [
            String(item.eLoc || "").toLowerCase(),
            String(item.mainName || item.name || "").toLowerCase(),
            item.lat == null ? "" : Number(item.lat).toFixed(5),
            item.lng == null ? "" : Number(item.lng).toFixed(5)
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

module.exports = {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson,
    fetchJsonWithMeta,
    extractItems,
    normalizeSuggestion,
    dedupe
};
