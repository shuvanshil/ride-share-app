// Fare pricing lives in ONE place: /fare-policy.config.json (single source of
// truth, shared with the server). This file just loads that JSON and exposes
// it as the same convenient JS helpers the rest of the app already imports
// (RIDE_SERVICES, calculateServiceFare, etc.) -- to change pricing, edit
// fare-policy.config.json, not this file or any code in api/routers/rides.py.
//
// Fare formula (kept identical here and in api/core/fare_policy.py):
//   fare = base_fare + (full_distance_to_destination_km * per_km_rate)
//   fare = max(round(fare), min_fare)
//
// The top-level `await` below pauses evaluation of THIS module (and anything
// that imports it) until the config JSON has loaded, which is a standard,
// widely-supported ES module feature -- every function this file exports is
// still called the exact same synchronous way from app.js/map.js/etc., they
// simply aren't reachable until the (near-instant, same-origin) fetch below
// resolves, which always happens well before any user interaction can call
// them.
const CONFIG_URL = new URL("../fare-policy.config.json", import.meta.url);

async function loadFarePolicyConfig() {
    const response = await fetch(CONFIG_URL);
    if (!response.ok) {
        throw new Error(`Could not load fare-policy.config.json (HTTP ${response.status})`);
    }
    return response.json();
}

const fareConfig = await loadFarePolicyConfig();

export const MAX_SERVICEABLE_DISTANCE_KM = Number(fareConfig.maxServiceableDistanceKm);

export const RIDE_SERVICES = Object.freeze(
    Object.fromEntries(
        Object.entries(fareConfig.services).map(([id, service]) => [
            id,
            Object.freeze({
                id,
                name: service.name,
                shortName: service.shortName,
                capacity: service.capacity,
                baseFare: Number(service.baseFare),
                perKmRate: Number(service.perKmRate),
                minFare: Number(service.minFare)
            })
        ])
    )
);

export function getRideService(serviceType) {
    return RIDE_SERVICES[String(serviceType || "").toLowerCase()] || null;
}

/**
 * Returns true when a distance (in km) is a sane, positive, finite number
 * that falls within the area LiphtUp currently serves.
 */
export function isDistanceServiceable(distanceKm) {
    const distance = Number(distanceKm);
    return Number.isFinite(distance) && distance >= 0 && distance <= MAX_SERVICEABLE_DISTANCE_KM;
}

/**
 * Computes the fare for a single service type given a road distance in km.
 * fare = base_fare + (full distance to destination in km * per_km_rate),
 * floored at the service's minFare. Returns null when the service is unknown
 * or the distance is invalid/out of range, so callers can distinguish
 * "can't price this" from a real fare of 0.
 */
export function calculateServiceFare(serviceType, distanceKm) {
    const service = getRideService(serviceType);
    if (!service || !isDistanceServiceable(distanceKm)) return null;

    const distance = Number(distanceKm);
    const fare = service.baseFare + (distance * service.perKmRate);

    return Math.max(Math.round(fare), service.minFare);
}

export function calculateFareOptions(distanceKm) {
    return Object.fromEntries(
        Object.keys(RIDE_SERVICES).map((serviceType) => [
            serviceType,
            calculateServiceFare(serviceType, distanceKm)
        ])
    );
}
