const {
    json,
    getMapplsConfig,
    getAccessToken,
    fetchJson
} = require("./_mappls");

function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== "string") return [];

    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates = [];

    while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte = null;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        result = 0;
        shift = 0;

        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        coordinates.push([lat / 1e5, lng / 1e5]);
    }

    return coordinates;
}

function extractRouteCoordinates(data) {
    const route = data?.routes?.[0] || data?.route?.[0] || data?.results?.[0] || data;
    const geometry = route?.geometry || route?.shape || route?.polyline;

    if (Array.isArray(geometry?.coordinates)) {
        return geometry.coordinates.map(([lng, lat]) => [Number(lat), Number(lng)])
            .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    }

    if (Array.isArray(route?.coordinates)) {
        return route.coordinates.map((point) => {
            if (Array.isArray(point)) return [Number(point[1]), Number(point[0])];
            return [Number(point.lat), Number(point.lng ?? point.lon)];
        }).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    }

    if (typeof geometry === "string") {
        return decodePolyline(geometry);
    }

    return [];
}

function buildRouteUrls(origin, destination, accessToken, restKey) {
    const originPair = `${origin.lng},${origin.lat}`;
    const destinationPair = `${destination.lng},${destination.lat}`;
    const encodedToken = encodeURIComponent(accessToken);
    const encodedRestKey = encodeURIComponent(restKey || "");
    const urls = [
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/route_adv/driving/${originPair};${destinationPair}?geometries=geojson&overview=full`,
        `https://apis.mappls.com/advancedmaps/v1/${encodedToken}/route_adv/driving/${originPair};${destinationPair}?overview=full`
    ];

    if (restKey) {
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/route_adv/driving/${originPair};${destinationPair}?geometries=geojson&overview=full`);
        urls.push(`https://apis.mappls.com/advancedmaps/v1/${encodedRestKey}/route_adv/driving/${originPair};${destinationPair}?overview=full`);
    }

    return urls;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const origin = {
        lat: Number(req.query?.originLat),
        lng: Number(req.query?.originLng)
    };
    const destination = {
        lat: Number(req.query?.destinationLat),
        lng: Number(req.query?.destinationLng)
    };

    if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) {
        return json(res, 400, { error: "Missing route coordinates" });
    }

    try {
        const config = getMapplsConfig();
        const accessToken = await getAccessToken();

        for (const url of buildRouteUrls(origin, destination, accessToken, config.restKey)) {
            try {
                const data = await fetchJson(url);
                const coordinates = extractRouteCoordinates(data);
                if (coordinates.length >= 2) {
                    return json(res, 200, { coordinates });
                }
            } catch (_) {
                // Try next Mappls route endpoint variant.
            }
        }

        return json(res, 404, { error: "Mappls route not found" });
    } catch (error) {
        return json(res, 500, {
            error: "Mappls route failed",
            message: error.message
        });
    }
};
