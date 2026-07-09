export const RIDE_SERVICES = Object.freeze({
    bike: Object.freeze({
        id: "bike",
        name: "Bike / Scooty",
        shortName: "Bike",
        capacity: 1,
        baseFare: 15,
        perKmRate: 7
    }),
    auto: Object.freeze({
        id: "auto",
        name: "Auto",
        shortName: "Auto",
        capacity: 3,
        baseFare: 25,
        perKmRate: 12.5
    })
});

export function getRideService(serviceType) {
    return RIDE_SERVICES[String(serviceType || "").toLowerCase()] || null;
}

export function calculateServiceFare(serviceType, distanceKm) {
    const service = getRideService(serviceType);
    const distance = Number(distanceKm);
    if (!service || !Number.isFinite(distance) || distance < 0) return null;
    return Math.round(service.baseFare + (distance * service.perKmRate));
}

export function calculateFareOptions(distanceKm) {
    return Object.fromEntries(
        Object.keys(RIDE_SERVICES).map((serviceType) => [
            serviceType,
            calculateServiceFare(serviceType, distanceKm)
        ])
    );
}
