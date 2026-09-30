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
const CONFIG_URL = new URL("../../fare-policy.config.json", import.meta.url);

async function loadFarePolicyConfig() {
    const response = await fetch(CONFIG_URL);
    if (!response.ok) {
        throw new Error(`Could not load fare-policy.config.json (HTTP ${response.status})`);
    }
    return response.json();
}

const fareConfig = await loadFarePolicyConfig();
const nightFareConfig = fareConfig.nightFare || {};

export const MAX_SERVICEABLE_DISTANCE_KM = Number(fareConfig.maxServiceableDistanceKm);
export const NIGHT_FARE_TIMEZONE = String(nightFareConfig.timezone || "Asia/Kolkata");

function parseClockMinutes(value, fallback) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return fallback;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return fallback;
    }

    return (hours * 60) + minutes;
}

const NIGHT_FARE_START_MINUTES = parseClockMinutes(nightFareConfig.start, 22 * 60);
const NIGHT_FARE_END_MINUTES = parseClockMinutes(nightFareConfig.end, (4 * 60) + 30);

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
                nightPerKmRate: Number.isFinite(Number(service.nightPerKmRate))
                    ? Number(service.nightPerKmRate)
                    : Number(service.perKmRate),
                minFare: Number(service.minFare)
            })
        ])
    )
);

export function getRideService(serviceType) {
    return RIDE_SERVICES[String(serviceType || "").toLowerCase()] || null;
}

function getTimePartsInFareTimezone(requestedAt) {
    const requestTime = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
    if (Number.isNaN(requestTime.getTime())) return null;

    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: NIGHT_FARE_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).formatToParts(requestTime);

    const rawHour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(rawHour) || !Number.isInteger(minute)) return null;

    const hour = rawHour === 24 ? 0 : rawHour;
    return { hour, minute };
}

export function isNightFareTime(requestedAt = new Date()) {
    const timeParts = getTimePartsInFareTimezone(requestedAt);
    if (!timeParts) return false;

    const requestMinutes = (timeParts.hour * 60) + timeParts.minute;
    if (NIGHT_FARE_START_MINUTES <= NIGHT_FARE_END_MINUTES) {
        return requestMinutes >= NIGHT_FARE_START_MINUTES && requestMinutes < NIGHT_FARE_END_MINUTES;
    }

    return requestMinutes >= NIGHT_FARE_START_MINUTES || requestMinutes < NIGHT_FARE_END_MINUTES;
}

export function getServiceFarePolicy(serviceType, requestedAt = new Date()) {
    const service = getRideService(serviceType);
    if (!service) return null;

    const isNightFare = isNightFareTime(requestedAt);
    return Object.freeze({
        ...service,
        perKmRate: isNightFare ? service.nightPerKmRate : service.perKmRate,
        normalPerKmRate: service.perKmRate,
        isNightFare
    });
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
export function calculateServiceFare(serviceType, distanceKm, requestedAt = new Date()) {
    const service = getServiceFarePolicy(serviceType, requestedAt);
    if (!service || !isDistanceServiceable(distanceKm)) return null;

    const distance = Number(distanceKm);
    const fare = service.baseFare + (distance * service.perKmRate);

    return Math.max(Math.round(fare), service.minFare);
}

export function calculateFareOptions(distanceKm, requestedAt = new Date()) {
    return Object.fromEntries(
        Object.keys(RIDE_SERVICES).map((serviceType) => [
            serviceType,
            calculateServiceFare(serviceType, distanceKm, requestedAt)
        ])
    );
}
