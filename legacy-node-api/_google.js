function getEnv(name) {
    return process.env[name] || "";
}

function json(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function getGoogleConfig() {
    return {
        browserKey: getEnv("GOOGLE_MAPS_BROWSER_KEY"),
        serverKey: getEnv("GOOGLE_MAPS_SERVER_KEY")
    };
}

function requireServerKey() {
    const { serverKey } = getGoogleConfig();
    if (!serverKey) {
        throw new Error("Missing GOOGLE_MAPS_SERVER_KEY.");
    }
    return serverKey;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
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

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

module.exports = {
    json,
    getGoogleConfig,
    requireServerKey,
    fetchJson,
    numberOrNull
};
