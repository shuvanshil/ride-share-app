// Distance is billed in kilometers. Each service has a base fare (covers the
// first stretch of the trip) plus a per-km rate. Beyond LONG_TRIP_THRESHOLD_KM,
// the per-km rate steps down (LONG_TRIP_RATE_MULTIPLIER) to keep longer rides
// proportionate instead of scaling linearly forever, and any distance beyond
// MAX_SERVICEABLE_DISTANCE_KM is treated as outside the current service area.

export const MAX_SERVICEABLE_DISTANCE_KM = 120;
const LONG_TRIP_THRESHOLD_KM = 20;
const LONG_TRIP_RATE_MULTIPLIER = 0.85;

export const RIDE_SERVICES = Object.freeze({
    bike: Object.freeze({
        id: "bike",
        name: "Bike / Scooty",
        shortName: "Bike",
        capacity: 1,
        baseFare: 15,
        perKmRate: 7,
        minFare: 15
    }),
    auto: Object.freeze({
        id: "auto",
        name: "Auto",
        shortName: "Auto",
        capacity: 3,
        baseFare: 25,
        perKmRate: 12.5,
        minFare: 25
    })
});

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
 * Returns null when the service is unknown or the distance is invalid/out of range,
 * so callers can distinguish "can't price this" from a real fare of 0.
 */
export function calculateServiceFare(serviceType, distanceKm) {
    const service = getRideService(serviceType);
    if (!service || !isDistanceServiceable(distanceKm)) return null;

    const distance = Number(distanceKm);
    const billableKm = Math.min(distance, LONG_TRIP_THRESHOLD_KM);
    const longTripKm = Math.max(0, distance - LONG_TRIP_THRESHOLD_KM);

    const fare = service.baseFare
        + (billableKm * service.perKmRate)
        + (longTripKm * service.perKmRate * LONG_TRIP_RATE_MULTIPLIER);

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
