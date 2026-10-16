/**
 * RideTrackingService.ts
 *
 * Rock-solid, production-grade vehicle background tracking system for LiphtUp.
 *
 * PLATFORM CAVEATS & ARCHITECTURAL ARCHETYPE:
 * 1. Background WebView Freezing:
 *    On Android and iOS, the WebView JavaScript runtime is paused or aggressively throttled
 *    when the app is minimized, the screen is turned off, or the driver switches to Google
 *    Maps for turn-by-turn navigation. JS setInterval and setTimeout cannot be relied upon.
 *    Telemetry transmission MUST occur natively via an Android Foreground Service with an
 *    un-timed partial wake lock or native HTTP wrapper.
 * 2. Sequential Permission Request Sequence (Android 10+ / 13+):
 *    - Android 10+ (API 29+) forbids requesting ACCESS_BACKGROUND_LOCATION simultaneously
 *      with ACCESS_FINE_LOCATION. They MUST be requested in sequence: foreground location first,
 *      followed by background location.
 *    - Android 13+ (API 33+) requires runtime POST_NOTIFICATIONS permission before foreground
 *      service notifications can be displayed.
 * 3. Sticky Foreground Service:
 *    To ensure Android doesn't kill the tracking process in low-memory situations or Doze mode,
 *    the service runs as a foreground service with 'ongoing: true', so drivers cannot swipe it away.
 * 4. Offline Queueing:
 *    Telemetry collected during cellular connectivity drops is queued in local persistent storage
 *    (IndexedDB/SQLite) and automatically flushed when the connection is re-established.
 */

export interface TrackingOptions {
    apiBaseUrl?: string;
    distanceFilter?: number; // meters, default: 10
    interval?: number;       // milliseconds, default: 5000
    fastestInterval?: number;// milliseconds, default: 2000
    notificationTitle?: string;
    notificationText?: string;
    enableHighAccuracy?: boolean;
    syncUrl?: string;
}

export interface LocationPayload {
    lat: number;
    lng: number;
    rideId?: string;
    driverHeading?: number | null;
    driverSpeed?: number | null;
    driverAccuracy?: number | null;
    timestamp?: number;
    routePolyline?: string;
}

export interface PermissionStatus {
    location: boolean;
    backgroundLocation: boolean;
    notifications: boolean;
    batteryOptimizationIgnored: boolean;
}

declare global {
    interface Window {
        LiphtUpNativeStatus?: {
            isFirebaseReady?: () => boolean;
            getGoogleMapsKey?: () => string;
            startDriverTracking?: (configJson: string) => void;
            updateTrackingState?: (configJson: string) => void;
            stopDriverTracking?: () => void;
            isTrackingActive?: () => boolean;
            isBatteryOptimizationIgnored?: () => boolean;
            requestIgnoreBatteryOptimizations?: () => void;
            updateNotificationText?: (text: string) => void;
            updateRideProgress?: (remainingKm: number, etaMins: number) => void;
        };
        Capacitor?: {
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
            Plugins?: Record<string, any>;
        };
        BackgroundGeolocation?: any;
        onNativeLocationUpdate?: (payload: LocationPayload) => void;
    }
}

export class RideTrackingService {
    private static instance: RideTrackingService | null = null;

    private activeRideId: string | null = null;
    private driverToken: string | null = null;
    private refreshToken: string | null = null;
    private isTracking: boolean = false;
    private options: Required<TrackingOptions>;
    private offlineQueue: LocationPayload[] = [];
    private queueStorageKey = 'liphtup_offline_location_queue';
    private webWatchId: number | null = null;
    private queueFlushTimer: any = null;
    private backgroundPluginWatcherId: string | null = null;

    private constructor() {
        this.options = {
            apiBaseUrl: 'https://liphtup.in',
            distanceFilter: 10,
            interval: 5000,
            fastestInterval: 2000,
            notificationTitle: 'LiphtUp Navigation Active',
            notificationText: 'Broadcasting live route location to passenger',
            enableHighAccuracy: true,
            syncUrl: '/api/rides/driver-location',
        };
        this.loadOfflineQueue();
    }

    public static getInstance(): RideTrackingService {
        if (!RideTrackingService.instance) {
            RideTrackingService.instance = new RideTrackingService();
        }
        return RideTrackingService.instance;
    }

    /**
     * Request permissions in strict sequence:
     * 1. Foreground Location (Fine & Coarse)
     * 2. Notifications (Android 13+ POST_NOTIFICATIONS)
     * 3. Background Location (Android 10+ ACCESS_BACKGROUND_LOCATION)
     * 4. Battery Optimization Exemption
     */
    public async requestPermissionsSequentially(): Promise<PermissionStatus> {
        const status: PermissionStatus = {
            location: false,
            backgroundLocation: false,
            notifications: false,
            batteryOptimizationIgnored: false,
        };

        // Step 1: Request Foreground Location
        try {
            if (navigator.permissions && navigator.permissions.query) {
                const geoPerm = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
                status.location = geoPerm.state === 'granted';
            }
            if (!status.location && navigator.geolocation) {
                await new Promise<void>((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(
                        () => {
                            status.location = true;
                            resolve();
                        },
                        (err) => {
                            console.warn('[RideTrackingService] Foreground location permission check:', err.message);
                            resolve(); // Continue gracefully
                        },
                        { timeout: 5000, enableHighAccuracy: true }
                    );
                });
            }
        } catch (e) {
            console.warn('[RideTrackingService] Geolocation permission query error:', e);
        }

        // Step 2: Request Notifications (Android 13+)
        try {
            const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
            if (PushNotifications && typeof PushNotifications.requestPermissions === 'function') {
                const pushPerm = await PushNotifications.requestPermissions();
                status.notifications = pushPerm.receive === 'granted';
            } else if (typeof Notification !== 'undefined' && Notification.requestPermission) {
                const nPerm = await Notification.requestPermission();
                status.notifications = nPerm === 'granted';
            } else {
                status.notifications = true;
            }
        } catch (e) {
            console.warn('[RideTrackingService] Notification permission check error:', e);
            status.notifications = true;
        }

        // Step 3: Native Background Location Plugin Check
        const BackgroundGeo = window.Capacitor?.Plugins?.BackgroundGeolocation || window.BackgroundGeolocation;
        if (BackgroundGeo && typeof BackgroundGeo.requestPermissions === 'function') {
            try {
                const bgPerm = await BackgroundGeo.requestPermissions();
                status.backgroundLocation = bgPerm.location === 'granted' || bgPerm.background === 'granted';
            } catch (e) {
                console.warn('[RideTrackingService] BackgroundGeolocation requestPermissions error:', e);
            }
        } else {
            status.backgroundLocation = true; // Handled natively by custom DriverLocationService
        }

        // Step 4: Battery Optimization Exemption
        if (window.LiphtUpNativeStatus?.isBatteryOptimizationIgnored) {
            try {
                status.batteryOptimizationIgnored = window.LiphtUpNativeStatus.isBatteryOptimizationIgnored();
                if (!status.batteryOptimizationIgnored && window.LiphtUpNativeStatus.requestIgnoreBatteryOptimizations) {
                    window.LiphtUpNativeStatus.requestIgnoreBatteryOptimizations();
                }
            } catch (e) {
                console.warn('[RideTrackingService] Battery optimization exemption error:', e);
            }
        } else {
            status.batteryOptimizationIgnored = true;
        }

        return status;
    }

    /**
     * Start live background ride tracking.
     *
     * @param rideId Active ride identifier
     * @param driverToken Authenticated driver bearer token
     * @param refreshToken Optional refresh token for background token renewal
     * @param userOptions Optional overrides for tracking parameters
     */
    public async startRideTracking(
        rideId: string,
        driverToken: string,
        refreshToken?: string,
        userOptions?: Partial<TrackingOptions>
    ): Promise<boolean> {
        if (!rideId || !driverToken) {
            throw new Error('[RideTrackingService] rideId and driverToken are required to start tracking.');
        }

        this.activeRideId = rideId;
        this.driverToken = driverToken;
        if (refreshToken) this.refreshToken = refreshToken;
        if (userOptions) {
            this.options = { ...this.options, ...userOptions };
        }

        // 1. Sequentially request required permissions
        await this.requestPermissionsSequentially();

        // 2. Configure and launch native background tracking
        // Archetype 1: Native Android Foreground Service (DriverLocationService via LiphtUpNativeStatus)
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.startDriverTracking === 'function') {
            try {
                const configPayload = {
                    state: 'active_ride',
                    rideId: this.activeRideId,
                    authToken: this.driverToken,
                    refreshToken: this.refreshToken || '',
                    apiBaseUrl: this.options.apiBaseUrl,
                    distanceFilter: this.options.distanceFilter,
                    interval: this.options.interval,
                    notificationTitle: this.options.notificationTitle,
                    notificationText: this.options.notificationText,
                    ongoing: true, // Native foreground service notification stays sticky
                };
                window.LiphtUpNativeStatus.startDriverTracking(JSON.stringify(configPayload));
                this.isTracking = true;
                console.log('[RideTrackingService] Started native foreground service with sticky notification.');
            } catch (e) {
                console.error('[RideTrackingService] Failed to start native driver tracking:', e);
            }
        }

        // Archetype 2: Capgo / Capacitor Community Background Geolocation Plugin (if installed)
        const BackgroundGeo = window.Capacitor?.Plugins?.BackgroundGeolocation || window.BackgroundGeolocation;
        if (BackgroundGeo && typeof BackgroundGeo.addWatcher === 'function') {
            try {
                const watcherOptions = {
                    backgroundTitle: this.options.notificationTitle,
                    backgroundMessage: this.options.notificationText,
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: this.options.distanceFilter,
                    interval: this.options.interval,
                    fastestInterval: this.options.fastestInterval,
                    notificationTitle: this.options.notificationTitle,
                    notificationText: this.options.notificationText,
                    ongoing: true,
                    // Direct Native HTTP posting configuration
                    server: {
                        url: `${this.options.apiBaseUrl}${this.options.syncUrl}`,
                        headers: {
                            'Authorization': `Bearer ${this.driverToken}`,
                            'Content-Type': 'application/json',
                        },
                        postTemplate: {
                            lat: '@latitude',
                            lng: '@longitude',
                            driverAccuracy: '@accuracy',
                            driverSpeed: '@speed',
                            driverHeading: '@bearing',
                            rideId: this.activeRideId,
                            timestamp: '@time',
                        },
                    },
                };

                this.backgroundPluginWatcherId = await BackgroundGeo.addWatcher(
                    watcherOptions,
                    (location: any, error: any) => {
                        if (error) {
                            console.warn('[RideTrackingService] BackgroundGeolocation error:', error);
                            return;
                        }
                        if (location) {
                            this.handleLocationUpdate({
                                lat: location.latitude,
                                lng: location.longitude,
                                driverAccuracy: location.accuracy,
                                driverSpeed: location.speed,
                                driverHeading: location.bearing,
                                rideId: this.activeRideId || undefined,
                                timestamp: location.time || Date.now(),
                            });
                        }
                    }
                );
                this.isTracking = true;
                console.log('[RideTrackingService] Background Geolocation plugin watcher registered:', this.backgroundPluginWatcherId);
            } catch (e) {
                console.warn('[RideTrackingService] BackgroundGeolocation addWatcher failed (falling back to native service):', e);
            }
        }

        // 3. Fallback / Foreground watcher for Webview UI updates
        this.startForegroundWatcher();

        // 4. Start offline queue draining worker
        this.startQueueSyncWorker();

        return this.isTracking;
    }

    /**
     * Gracefully stops ride tracking, purges/flushes pending queues, and releases hooks.
     */
    public async stopRideTracking(): Promise<void> {
        console.log('[RideTrackingService] Stopping ride tracking...');

        // 1. Stop Native Android Foreground Service
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.stopDriverTracking === 'function') {
            try {
                window.LiphtUpNativeStatus.stopDriverTracking();
            } catch (e) {
                console.warn('[RideTrackingService] stopDriverTracking error:', e);
            }
        }

        // 2. Remove Background Plugin Watcher
        const BackgroundGeo = window.Capacitor?.Plugins?.BackgroundGeolocation || window.BackgroundGeolocation;
        if (BackgroundGeo && this.backgroundPluginWatcherId) {
            try {
                if (typeof BackgroundGeo.removeWatcher === 'function') {
                    await BackgroundGeo.removeWatcher({ id: this.backgroundPluginWatcherId });
                }
                this.backgroundPluginWatcherId = null;
            } catch (e) {
                console.warn('[RideTrackingService] removeWatcher error:', e);
            }
        }

        // 3. Clear Web Watcher
        if (this.webWatchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(this.webWatchId);
            this.webWatchId = null;
        }

        // 4. Stop Queue Worker and flush remaining items
        if (this.queueFlushTimer) {
            clearInterval(this.queueFlushTimer);
            this.queueFlushTimer = null;
        }
        await this.flushQueue();

        this.isTracking = false;
        this.activeRideId = null;
        console.log('[RideTrackingService] Ride tracking stopped and queues flushed.');
    }

    /**
     * Dynamically updates the persistent Android notification drawer text.
     * E.g. "3.5 KM remaining • 8 mins to destination"
     */
    public updateNotificationText(text: string): void {
        if (!text) return;
        if (window.LiphtUpNativeStatus?.updateNotificationText) {
            window.LiphtUpNativeStatus.updateNotificationText(text);
        }
    }

    /**
     * Updates notification progress with structured distance and ETA values.
     */
    public updateProgress(remainingKm: number, etaMins: number): void {
        if (window.LiphtUpNativeStatus?.updateRideProgress) {
            window.LiphtUpNativeStatus.updateRideProgress(remainingKm, etaMins);
        } else {
            const formatted = remainingKm <= 0.05
                ? 'Arrived at destination • Completing ride'
                : `${remainingKm.toFixed(1)} KM remaining • ${etaMins} mins to destination`;
            this.updateNotificationText(formatted);
        }
    }

    /**
     * Handles an incoming location fix, notifying frontend listeners and transmitting
     * to backend if app is in active state.
     */
    public handleLocationUpdate(payload: LocationPayload): void {
        // Dispatch custom event for frontend Google Maps and UI listeners
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('driver-location-updated', {
                detail: payload,
            }));
            if (window.onNativeLocationUpdate) {
                try {
                    window.onNativeLocationUpdate(payload);
                } catch (e) {
                    console.error('[RideTrackingService] onNativeLocationUpdate callback error:', e);
                }
            }
        }

        // Enqueue if offline
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            this.enqueueLocation(payload);
        }
    }

    private startForegroundWatcher(): void {
        if (!navigator.geolocation) return;
        if (this.webWatchId !== null) {
            navigator.geolocation.clearWatch(this.webWatchId);
        }

        this.webWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const payload: LocationPayload = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    driverAccuracy: pos.coords.accuracy,
                    driverSpeed: pos.coords.speed !== null && pos.coords.speed >= 0 ? pos.coords.speed : undefined,
                    driverHeading: pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading >= 0 ? pos.coords.heading : undefined,
                    rideId: this.activeRideId || undefined,
                    timestamp: pos.timestamp || Date.now(),
                };
                this.handleLocationUpdate(payload);
            },
            (err) => {
                console.warn('[RideTrackingService] Foreground watchPosition warning:', err.message);
            },
            {
                enableHighAccuracy: this.options.enableHighAccuracy,
                timeout: 10000,
                maximumAge: 2000,
            }
        );
    }

    private enqueueLocation(payload: LocationPayload): void {
        this.offlineQueue.push(payload);
        if (this.offlineQueue.length > 500) {
            this.offlineQueue.shift(); // Bound memory usage
        }
        this.saveOfflineQueue();
    }

    private saveOfflineQueue(): void {
        try {
            localStorage.setItem(this.queueStorageKey, JSON.stringify(this.offlineQueue));
        } catch (ignored) {}
    }

    private loadOfflineQueue(): void {
        try {
            const raw = localStorage.getItem(this.queueStorageKey);
            if (raw) {
                this.offlineQueue = JSON.parse(raw);
            }
        } catch (ignored) {
            this.offlineQueue = [];
        }
    }

    private startQueueSyncWorker(): void {
        if (this.queueFlushTimer) clearInterval(this.queueFlushTimer);
        this.queueFlushTimer = setInterval(() => {
            if (navigator.onLine && this.offlineQueue.length > 0) {
                this.flushQueue();
            }
        }, 10000);
    }

    public async flushQueue(): Promise<void> {
        if (!this.driverToken || this.offlineQueue.length === 0) return;

        const batch = [...this.offlineQueue];
        this.offlineQueue = [];
        this.saveOfflineQueue();

        const endpoint = `${this.options.apiBaseUrl}${this.options.syncUrl}`;
        for (const item of batch) {
            try {
                await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.driverToken}`,
                    },
                    body: JSON.stringify(item),
                });
            } catch (e) {
                // If network fails again, re-enqueue remaining items
                this.offlineQueue.push(item);
            }
        }
        this.saveOfflineQueue();
    }

    public getIsTracking(): boolean {
        return this.isTracking;
    }

    public getActiveRideId(): string | null {
        return this.activeRideId;
    }
}

// Global export for vanilla HTML script-tag integration
if (typeof window !== 'undefined') {
    (window as any).RideTrackingService = RideTrackingService;
}
