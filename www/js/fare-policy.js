export const RIDE_SERVICES = Object.freeze({
    bike: Object.freeze({
        id: "bike",
        name: "Bike / Scooty",
        shortName: "Bike",
        capacity: 1,
        baseFare: 15,
        perKmRate: 7,
        nightPerKmRate: 13
    }),
    auto: Object.freeze({
        id: "auto",
        name: "Auto",
        shortName: "Auto",
        capacity: 3,
        baseFare: 25,
        perKmRate: 12.5,
        nightPerKmRate: 20
    })
});

const NIGHT_FARE_START_MINUTES = 22 * 60;
const NIGHT_FARE_END_MINUTES = (4 * 60) + 30;

export function getRideService(serviceType) {
    return RIDE_SERVICES[String(serviceType || "").toLowerCase()] || null;
}

export function isNightFareTime(requestedAt = new Date()) {
    const requestTime = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
    if (Number.isNaN(requestTime.getTime())) return false;

    const requestMinutes = (requestTime.getHours() * 60) + requestTime.getMinutes();
    return requestMinutes >= NIGHT_FARE_START_MINUTES || requestMinutes < NIGHT_FARE_END_MINUTES;
}

export function getServiceFarePolicy(serviceType, requestedAt = new Date()) {
    const service = getRideService(serviceType);
    if (!service) return null;

    const nightFare = isNightFareTime(requestedAt);
    return Object.freeze({
        ...service,
        isNightFare: nightFare,
        perKmRate: nightFare ? service.nightPerKmRate : service.perKmRate,
        normalPerKmRate: service.perKmRate,
        nightPerKmRate: service.nightPerKmRate
    });
}

export function calculateServiceFare(serviceType, distanceKm, requestedAt = new Date()) {
    const service = getServiceFarePolicy(serviceType, requestedAt);
    const distance = Number(distanceKm);
    if (!service || !Number.isFinite(distance) || distance < 0) return null;
    return Math.round(service.baseFare + (distance * service.perKmRate));
}

export function calculateFareOptions(distanceKm, requestedAt = new Date()) {
    return Object.fromEntries(
        Object.keys(RIDE_SERVICES).map((serviceType) => [
            serviceType,
            calculateServiceFare(serviceType, distanceKm, requestedAt)
        ])
    );
}
