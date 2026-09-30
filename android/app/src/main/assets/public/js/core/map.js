/**
 * Map Engine Core Facade Re-exporter
 * Provides backward compatibility for legacy imports pointing to js/core/map.js
 */
export {
    warmGoogleMaps,
    createRideMapSurface,
    initializeMapEngine,
    useCurrentPickupLocation,
    fetchRoadRouteDetails
} from '../map/map-core.js';
