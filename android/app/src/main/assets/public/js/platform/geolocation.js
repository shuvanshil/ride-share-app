/**
 * Platform adapter for Geolocation with multi-tier accuracy fallback.
 */

export async function getCurrentPosition(options = { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }) {
    // 1. Try Native Capacitor Geolocation if available
    const nativeGeo = window.Capacitor?.Plugins?.Geolocation;
    if (nativeGeo && typeof nativeGeo.getCurrentPosition === 'function') {
        try {
            const nativePos = await Promise.race([
                nativeGeo.getCurrentPosition({
                    enableHighAccuracy: options.enableHighAccuracy ?? true,
                    timeout: options.timeout ?? 8000,
                    maximumAge: options.maximumAge ?? 30000
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("native-geo-timeout")), options.timeout ?? 8000))
            ]);
            if (nativePos?.coords) {
                return {
                    coords: {
                        latitude: nativePos.coords.latitude,
                        longitude: nativePos.coords.longitude,
                        accuracy: nativePos.coords.accuracy || 10,
                        altitude: nativePos.coords.altitude,
                        altitudeAccuracy: nativePos.coords.altitudeAccuracy,
                        heading: nativePos.coords.heading,
                        speed: nativePos.coords.speed
                    },
                    timestamp: nativePos.timestamp || Date.now()
                };
            }
        } catch (nativeErr) {
            console.warn("[geolocation] Native geolocation fallback to browser navigator:", nativeErr);
        }
    }

    if (!navigator.geolocation) {
        throw new Error("Geolocation not supported");
    }

    // 2. Primary High-Accuracy attempt with fast fallback to low-accuracy network fix
    const primaryPromise = new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: options.enableHighAccuracy ?? true,
            timeout: options.timeout ?? 6000,
            maximumAge: options.maximumAge ?? 30000
        });
    });

    try {
        return await primaryPromise;
    } catch (primaryErr) {
        // If high accuracy failed (e.g. timeout or indoors), attempt fast low accuracy network fix
        if (options.enableHighAccuracy) {
            try {
                return await new Promise((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        enableHighAccuracy: false,
                        timeout: 4000,
                        maximumAge: 300000
                    });
                });
            } catch (fallbackErr) {
                throw primaryErr;
            }
        }
        throw primaryErr;
    }
}

export function watchPosition(success, error, options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }) {
    if (!navigator.geolocation) {
        if (typeof error === 'function') error(new Error("Geolocation not supported"));
        return null;
    }
    return navigator.geolocation.watchPosition(success, error, options);
}

export function clearWatch(watchId) {
    if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
    }
}
