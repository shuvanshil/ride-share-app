/**
 * marker-animation.ts
 *
 * Smooth Google Maps Marker Animation Utility for LiphtUp.
 *
 * Implements high-precision Linear Interpolation (LERP), shortest-arc heading
 * interpolation, antimeridian wrap-around handling, and requestAnimationFrame
 * scheduling to glide vehicle markers smoothly down roads without snapping or flickering.
 */

export interface MarkerAnimationOptions {
    easing?: 'linear' | 'easeInOutCubic' | 'easeOutQuad';
    updateHeading?: boolean;
    targetHeading?: number;
    onStep?: (currentLat: number, currentLng: number, currentHeading?: number) => void;
    onComplete?: () => void;
}

export interface AnimationHandle {
    cancel: () => void;
    isFinished: () => boolean;
}

// Global registry to prevent concurrent animation collisions per marker
const activeAnimations = new WeakMap<object, { frameId: number; cancel: () => void }>();

/**
 * Normalizes an angle into [0, 360) degrees.
 */
export function normalizeDegrees(deg: number): number {
    return ((deg % 360) + 360) % 360;
}

/**
 * Calculates the shortest signed angular difference between two bearings in degrees (-180 to 180).
 */
export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
    const diff = (toDeg - fromDeg) % 360;
    return ((diff + 540) % 360) - 180;
}

/**
 * Calculates forward azimuth / bearing between two geographical coordinates.
 */
export function calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaLambda = ((lng2 - lng1) * Math.PI) / 180;

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const radians = Math.atan2(y, x);
    return normalizeDegrees((radians * 180) / Math.PI);
}

/**
 * Great-circle distance using Haversine formula in kilometers.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371.0; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Easing functions
 */
function applyEasing(t: number, easing: 'linear' | 'easeInOutCubic' | 'easeOutQuad'): number {
    if (easing === 'linear') {
        return t;
    }
    if (easing === 'easeOutQuad') {
        return t * (2 - t);
    }
    // Default: easeInOutCubic for natural vehicle acceleration and deceleration
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Extracts current latitude and longitude from any google.maps.Marker or AdvancedMarkerElement
 */
function extractMarkerPosition(marker: any): { lat: number; lng: number } | null {
    if (!marker) return null;

    if (typeof marker.getPosition === 'function') {
        const pos = marker.getPosition();
        if (!pos) return null;
        const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
        const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
        if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    }

    if (marker.position) {
        const p = marker.position;
        const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
        const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
        if (isFinite(lat) && isFinite(lng)) return { lat, lng };
    }

    return null;
}

/**
 * Sets marker position safely across classic and modern Google Maps Marker APIs
 */
function setMarkerPosition(marker: any, lat: number, lng: number): void {
    if (typeof window !== 'undefined' && (window as any).google?.maps?.LatLng) {
        const latLng = new (window as any).google.maps.LatLng(lat, lng);
        if (typeof marker.setPosition === 'function') {
            marker.setPosition(latLng);
            return;
        }
    }
    if (typeof marker.setPosition === 'function') {
        marker.setPosition({ lat, lng });
    } else {
        marker.position = { lat, lng };
    }
}

/**
 * Sets marker orientation / rotation if supported
 */
function setMarkerHeading(marker: any, heading: number): void {
    if (typeof marker.setHeading === 'function') {
        marker.setHeading(heading);
        return;
    }
    const icon = marker.getIcon ? marker.getIcon() : marker.icon;
    if (icon && typeof icon === 'object' && icon.path !== undefined) {
        // google.maps.Symbol
        marker.setIcon({ ...icon, rotation: heading });
    }
}

/**
 * Animates a Google Maps vehicle marker smoothly from its current position
 * to a target (targetLat, targetLng) over durationMs milliseconds using requestAnimationFrame.
 *
 * @param marker The Google Maps Marker instance
 * @param targetLat Target destination latitude
 * @param targetLng Target destination longitude
 * @param durationMs Animation duration in milliseconds (default: 1200ms)
 * @param options Optional configuration for easing, rotation, and callbacks
 */
export function animateMarkerMove(
    marker: any,
    targetLat: number,
    targetLng: number,
    durationMs: number = 1200,
    options?: MarkerAnimationOptions
): AnimationHandle {
    // 1. Parameter Validation
    if (!marker) {
        console.warn('[animateMarkerMove] Invalid marker provided.');
        return { cancel: () => {}, isFinished: () => true };
    }

    if (!isFinite(targetLat) || targetLat < -90 || targetLat > 90) {
        console.warn('[animateMarkerMove] Invalid targetLat:', targetLat);
        return { cancel: () => {}, isFinished: () => true };
    }

    if (!isFinite(targetLng) || targetLng < -180 || targetLng > 180) {
        console.warn('[animateMarkerMove] Invalid targetLng:', targetLng);
        return { cancel: () => {}, isFinished: () => true };
    }

    const startPos = extractMarkerPosition(marker);
    if (!startPos) {
        // Initial placement without prior position
        setMarkerPosition(marker, targetLat, targetLng);
        options?.onComplete?.();
        return { cancel: () => {}, isFinished: () => true };
    }

    const startLat = startPos.lat;
    const startLng = startPos.lng;

    // 2. Teleport / Identity Check
    const distanceKm = haversineKm(startLat, startLng, targetLat, targetLng);
    if (distanceKm < 0.0001) {
        // Less than 10 centimeters: stationary, no movement needed
        options?.onComplete?.();
        return { cancel: () => {}, isFinished: () => true };
    }

    if (distanceKm > 30.0) {
        // Teleport threshold (> 30 km): snap directly to avoid unrealistic cross-globe flight
        setMarkerPosition(marker, targetLat, targetLng);
        options?.onComplete?.();
        return { cancel: () => {}, isFinished: () => true };
    }

    // 3. Cancel any currently executing animation on this marker
    const previous = activeAnimations.get(marker);
    if (previous) {
        previous.cancel();
        activeAnimations.delete(marker);
    }

    // 4. Calculate Bearing & Antimeridian Longitude Delta
    let deltaLng = targetLng - startLng;
    if (deltaLng > 180) {
        deltaLng -= 360;
    } else if (deltaLng < -180) {
        deltaLng += 360;
    }

    const targetHeading = options?.targetHeading !== undefined
        ? options.targetHeading
        : calculateBearing(startLat, startLng, targetLat, targetLng);

    const startHeading = (marker as any).__currentHeading !== undefined
        ? (marker as any).__currentHeading
        : targetHeading;

    const headingDelta = shortestAngleDelta(startHeading, targetHeading);
    const easingType = options?.easing || 'easeInOutCubic';
    const effectiveDuration = Math.max(100, durationMs);

    let isDone = false;
    let startTime: number | null = null;
    let frameId: number = 0;

    const cancel = () => {
        if (!isDone) {
            isDone = true;
            if (frameId && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frameId);
            }
            activeAnimations.delete(marker);
        }
    };

    const step = (timestamp: number) => {
        if (isDone) return;

        if (startTime === null) {
            startTime = timestamp;
        }

        const elapsed = timestamp - startTime;
        const rawProgress = Math.min(1.0, Math.max(0.0, elapsed / effectiveDuration));
        const progress = applyEasing(rawProgress, easingType);

        // Incremental smooth positional frames via Linear Interpolation (LERP)
        const currentLat = startLat + (targetLat - startLat) * progress;
        const currentLng = startLng + deltaLng * progress;

        setMarkerPosition(marker, currentLat, currentLng);

        // Heading Interpolation
        let currentHeading = targetHeading;
        if (options?.updateHeading !== false) {
            currentHeading = normalizeDegrees(startHeading + headingDelta * progress);
            (marker as any).__currentHeading = currentHeading;
            setMarkerHeading(marker, currentHeading);
        }

        options?.onStep?.(currentLat, currentLng, currentHeading);

        if (rawProgress < 1.0) {
            frameId = requestAnimationFrame(step);
            activeAnimations.set(marker, { frameId, cancel });
        } else {
            // Finalize exactly at target coordinates to eliminate floating-point drift
            setMarkerPosition(marker, targetLat, targetLng);
            if (options?.updateHeading !== false) {
                (marker as any).__currentHeading = targetHeading;
                setMarkerHeading(marker, targetHeading);
            }
            isDone = true;
            activeAnimations.delete(marker);
            options?.onComplete?.();
        }
    };

    frameId = requestAnimationFrame(step);
    activeAnimations.set(marker, { frameId, cancel });

    return {
        cancel,
        isFinished: () => isDone,
    };
}

if (typeof window !== 'undefined') {
    (window as any).animateMarkerMove = animateMarkerMove;
    (window as any).calculateBearing = calculateBearing;
}
