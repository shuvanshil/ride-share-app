/**
 * Platform adapter for Storage.
 * Wraps localStorage and sessionStorage with error handling.
 */

export const local = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            console.warn(`[storage/local] get failed for ${key}:`, e);
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            console.warn(`[storage/local] set failed for ${key}:`, e);
            return false;
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }
};

export const session = {
    get(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (e) {
            console.warn(`[storage/session] get failed for ${key}:`, e);
            return null;
        }
    },
    set(key, value) {
        try {
            sessionStorage.setItem(key, value);
            return true;
        } catch (e) {
            console.warn(`[storage/session] set failed for ${key}:`, e);
            return false;
        }
    },
    remove(key) {
        try {
            sessionStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }
};
