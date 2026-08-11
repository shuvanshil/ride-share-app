/**
 * Platform adapter for Geolocation.
 */
export async function getCurrentPosition(options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation not supported"));
            return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
}

export function watchPosition(success, error, options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }) {
    if (!navigator.geolocation) {
        error(new Error("Geolocation not supported"));
        return null;
    }
    return navigator.geolocation.watchPosition(success, error, options);
}

export function clearWatch(watchId) {
    if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
    }
}
