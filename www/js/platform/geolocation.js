/**
 * Platform adapter for Geolocation with multi-tier accuracy fallback
 * and Native Android Background Location Service integration.
 */

let activeNativeTrackingListener = null;
let fallbackWatchId = null;

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

/**
 * Starts production driver background location tracking.
 * On native Android, starts the foreground service with persistent notification.
 * On Web/Desktop, establishes watchPosition and locks screen wake lock.
 */
export function startDriverTracking({ state = "on_duty", rideId = "", authToken = "", apiBaseUrl = "", onLocation, onError }) {
    const isNativeAndroid = Boolean(window.LiphtUpNativeStatus?.startDriverTracking);

    if (isNativeAndroid) {
        try {
            window.onNativeLocationUpdate = (payload) => {
                if (!payload || !Number.isFinite(Number(payload.lat)) || !Number.isFinite(Number(payload.lng))) return;
                const rawHeading = (payload.heading != null && payload.heading !== "null") ? Number(payload.heading) : null;
                const heading = (Number.isFinite(rawHeading) && rawHeading >= 0 && rawHeading <= 360) ? rawHeading : null;
                const position = {
                    coords: {
                        latitude: Number(payload.lat),
                        longitude: Number(payload.lng),
                        accuracy: Number(payload.accuracy) || 10,
                        speed: Number(payload.speed) || 0,
                        heading
                    },
                    timestamp: Number(payload.timestamp) || Date.now(),
                    isNativeBackground: true,
                    state: payload.state,
                    rideId: payload.rideId
                };
                if (typeof onLocation === "function") {
                    onLocation(position);
                }
            };

            const config = {
                state: state || "on_duty",
                rideId: rideId || "",
                authToken: authToken || "",
                apiBaseUrl: apiBaseUrl || window.location.origin
            };
            window.LiphtUpNativeStatus.startDriverTracking(JSON.stringify(config));
            console.log("[geolocation] Started native Android driver foreground tracking:", config.state);
        } catch (nativeError) {
            console.error("[geolocation] Failed to start native tracking:", nativeError);
            if (typeof onError === "function") onError(nativeError);
        }
    }

    // Always keep or initiate browser watchPosition as active in-app provider / web fallback
    if (fallbackWatchId !== null) {
        clearWatch(fallbackWatchId);
    }

    fallbackWatchId = watchPosition(
        (pos) => {
            if (typeof onLocation === "function") onLocation(pos);
        },
        (err) => {
            console.warn("[geolocation] Web watchPosition error:", err);
            // If native tracking is running, don't kill the tracking session on browser error
            if (!isNativeAndroid && typeof onError === "function") {
                onError(err);
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 12000
        }
    );

    return fallbackWatchId;
}

/**
 * Updates active driver tracking state (e.g. transitioning from on_duty to active_ride).
 */
export function updateDriverTrackingState({ state = "on_duty", rideId = "", authToken = "", apiBaseUrl = "" }) {
    if (window.LiphtUpNativeStatus?.updateTrackingState) {
        try {
            const config = {
                state: state || "on_duty",
                rideId: rideId || "",
                authToken: authToken || "",
                apiBaseUrl: apiBaseUrl || window.location.origin
            };
            window.LiphtUpNativeStatus.updateTrackingState(JSON.stringify(config));
            console.log("[geolocation] Updated native tracking state:", config);
        } catch (err) {
            console.warn("[geolocation] Failed to update native tracking state:", err);
        }
    }
}

/**
 * Stops driver tracking completely (stops Android foreground service and clears watches).
 */
export function stopDriverTracking() {
    if (window.LiphtUpNativeStatus?.stopDriverTracking) {
        try {
            window.LiphtUpNativeStatus.stopDriverTracking();
            console.log("[geolocation] Stopped native Android driver tracking service.");
        } catch (err) {
            console.warn("[geolocation] Error stopping native tracking:", err);
        }
    }

    if (window.onNativeLocationUpdate) {
        window.onNativeLocationUpdate = null;
    }

    if (fallbackWatchId !== null) {
        clearWatch(fallbackWatchId);
        fallbackWatchId = null;
    }
}

/**
 * Checks if native tracking service is currently running.
 */
export function isDriverTrackingActive() {
    if (window.LiphtUpNativeStatus?.isTrackingActive) {
        return window.LiphtUpNativeStatus.isTrackingActive();
    }
    return fallbackWatchId !== null;
}

/**
 * Opens Google Maps Navigation (Turn-by-Turn mode) for the driver.
 * On Android, triggers native Google Maps navigation intent.
 * On Web, opens Google Maps driving directions in a new tab.
 */
export function openGoogleMapsNavigation(lat, lng, label = "") {
    const targetLat = Number(lat);
    const targetLng = Number(lng);
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
        console.error("Invalid coordinates for Google Maps navigation:", lat, lng);
        return false;
    }

    if (window.LiphtUpNativeStatus?.openGoogleMapsNavigation) {
        try {
            window.LiphtUpNativeStatus.openGoogleMapsNavigation(targetLat, targetLng, label || "");
            return true;
        } catch (err) {
            console.warn("Native navigation intent failed, falling back to web URL:", err);
        }
    }

    const webNavUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${targetLat},${targetLng}`)}&travelmode=driving`;
    window.open(webNavUrl, "_blank", "noopener,noreferrer");
    return true;
}

/**
 * Checks if battery optimization is ignored for the app on Android.
 */
export function isBatteryOptimizationIgnored() {
    if (window.LiphtUpNativeStatus?.isBatteryOptimizationIgnored) {
        try {
            return Boolean(window.LiphtUpNativeStatus.isBatteryOptimizationIgnored());
        } catch (e) {
            console.warn("[geolocation] Error checking battery optimization status:", e);
        }
    }
    return true;
}

/**
 * Prompts the driver to exempt LiphtUp from battery optimization.
 */
export function requestIgnoreBatteryOptimizations() {
    if (window.LiphtUpNativeStatus?.requestIgnoreBatteryOptimizations) {
        try {
            window.LiphtUpNativeStatus.requestIgnoreBatteryOptimizations();
            return true;
        } catch (e) {
            console.warn("[geolocation] Error requesting battery optimization exemption:", e);
        }
    }
    return false;
}

