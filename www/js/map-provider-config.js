// Keep the Mappls key in one place so search/reverse geocoding/map tiles can
// all switch providers without touching the ride lifecycle code.
export const MAPPLS_STATIC_KEY = "zgvqxvnirufqyzfwamehbhugdyggterdygll";

export const MAPPLS_ENABLED = MAPPLS_STATIC_KEY.trim().length > 0;
export const MAPPLS_TILES_ENABLED = true;
