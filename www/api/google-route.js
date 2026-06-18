const { json, requireServerKey, fetchJson, numberOrNull } = require("./_google");

function parseDurationSeconds(value) {
    if (typeof value === "number") return value;
    const match = String(value || "").match(/^(\d+(?:\.\d+)?)s$/);
    return match ? Number(match[1]) : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed" });
    }

    const origin = {
        lat: numberOrNull(req.query?.originLat),
        lng: numberOrNull(req.query?.originLng)
    };
    const destination = {
        lat: numberOrNull(req.query?.destinationLat),
        lng: numberOrNull(req.query?.destinationLng)
    };

    if (
        !Number.isFinite(origin.lat) ||
        !Number.isFinite(origin.lng) ||
        !Number.isFinite(destination.lat) ||
        !Number.isFinite(destination.lng)
    ) {
        return json(res, 400, { error: "Missing route coordinates" });
    }

    try {
        const key = requireServerKey();
        const data = await fetchJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline"
            },
            body: JSON.stringify({
                origin: {
                    location: {
                        latLng: {
                            latitude: origin.lat,
                            longitude: origin.lng
                        }
                    }
                },
                destination: {
                    location: {
                        latLng: {
                            latitude: destination.lat,
                            longitude: destination.lng
                        }
                    }
                },
                travelMode: "DRIVE",
                routingPreference: "TRAFFIC_UNAWARE",
                computeAlternativeRoutes: false,
                units: "METRIC"
            })
        });

        const route = Array.isArray(data.routes) ? data.routes[0] : null;
        if (!route) {
            return json(res, 404, { error: "Google route not found" });
        }

        const distanceMeters = Number(route.distanceMeters);
        const durationSeconds = parseDurationSeconds(route.duration);

        return json(res, 200, {
            distanceKm: Number.isFinite(distanceMeters) ? distanceMeters / 1000 : null,
            durationMinutes: Number.isFinite(durationSeconds) ? Math.max(1, Math.round(durationSeconds / 60)) : null,
            encodedPolyline: route.polyline?.encodedPolyline || ""
        });
    } catch (error) {
        return json(res, 500, {
            error: "Google route failed",
            message: error.message,
            status: error.status || 0
        });
    }
};
