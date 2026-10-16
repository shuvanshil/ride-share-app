/**
 * notification-manager.ts
 *
 * Persistent Notification Text Manager for LiphtUp on Android.
 * Dynamically hooks into real-time Socket.io payloads, Firestore updates, and backend responses
 * to continuously update the foreground notification text in the Android notification drawer.
 */

export interface RideProgressPayload {
    remaining_km?: number | null;
    remainingKm?: number | null;
    eta_mins?: number | null;
    etaMins?: number | null;
    status?: string | null;
    rideId?: string | null;
}

export class PersistentNotificationManager {
    private static instance: PersistentNotificationManager | null = null;
    private attachedSockets: Set<any> = new Set();
    private eventListeners: Array<{ target: EventTarget; type: string; handler: EventListenerOrEventListenerObject }> = [];
    private lastUpdateTime: number = 0;
    private minUpdateIntervalMs: number = 1500; // Debounce notification drawer updates
    private lastFormattedText: string = '';

    private constructor() {
        this.bindGlobalEvents();
    }

    public static getInstance(): PersistentNotificationManager {
        if (!PersistentNotificationManager.instance) {
            PersistentNotificationManager.instance = new PersistentNotificationManager();
        }
        return PersistentNotificationManager.instance;
    }

    /**
     * Bind incoming CustomEvents dispatched across the frontend
     */
    private bindGlobalEvents(): void {
        if (typeof window === 'undefined') return;

        const onProgressEvent = (evt: Event) => {
            const customEvt = evt as CustomEvent<RideProgressPayload>;
            if (customEvt.detail) {
                this.handlePayload(customEvt.detail);
            }
        };

        window.addEventListener('ride-progress-updated', onProgressEvent);
        this.eventListeners.push({ target: window, type: 'ride-progress-updated', handler: onProgressEvent });

        const onLocationEvent = (evt: Event) => {
            const customEvt = evt as CustomEvent<any>;
            if (customEvt.detail) {
                const det = customEvt.detail;
                if (det.remaining_km !== undefined || det.remainingKm !== undefined) {
                    this.handlePayload(det);
                }
            }
        };

        window.addEventListener('driver-location-updated', onLocationEvent);
        this.eventListeners.push({ target: window, type: 'driver-location-updated', handler: onLocationEvent });
    }

    /**
     * Hooks into a Socket.io-client instance.
     */
    public attachSocket(socket: any): void {
        if (!socket || typeof socket.on !== 'function') return;
        if (this.attachedSockets.has(socket)) return;

        this.attachedSockets.add(socket);

        const onProgress = (data: RideProgressPayload) => {
            if (data) {
                this.handlePayload(data);
            }
        };

        socket.on('ride-progress', onProgress);
        socket.on('ride_progress', onProgress);
        socket.on('location-update', onProgress);
        socket.on('driver-location', onProgress);

        console.log('[PersistentNotificationManager] Attached to Socket.io instance.');
    }

    /**
     * Ingests a progress payload from socket, API response, or Firestore.
     */
    public handlePayload(payload: RideProgressPayload): void {
        const remainingKm = payload.remaining_km ?? payload.remainingKm;
        const etaMins = payload.eta_mins ?? payload.etaMins;
        const status = payload.status || '';

        if (remainingKm === undefined || remainingKm === null) {
            return;
        }

        const remKmVal = typeof remainingKm === 'number' ? remainingKm : parseFloat(String(remainingKm));
        const etaVal = typeof etaMins === 'number' ? etaMins : (etaMins ? parseInt(String(etaMins), 10) : 0);

        if (isNaN(remKmVal)) return;

        this.updateDrawer(remKmVal, isNaN(etaVal) ? 0 : etaVal, status);
    }

    /**
     * Formats notification string and delivers it to the Android foreground service.
     */
    public updateDrawer(remainingKm: number, etaMins: number, status: string = ''): void {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.minUpdateIntervalMs) {
            return; // Debounce rapid spam
        }

        let formatted: string;
        if (remainingKm <= 0.05) {
            formatted = 'Arrived at destination • Completing ride';
        } else if (status === 'accepted' || status === 'arrived') {
            formatted = `Approaching pickup • ${remainingKm.toFixed(1)} KM • ${etaMins} mins`;
        } else {
            formatted = `${remainingKm.toFixed(1)} KM remaining • ${etaMins} mins to destination`;
        }

        if (formatted === this.lastFormattedText) {
            return;
        }

        this.lastUpdateTime = now;
        this.lastFormattedText = formatted;

        // Deliver to native Android Foreground Service
        if (typeof window !== 'undefined' && window.LiphtUpNativeStatus) {
            if (typeof window.LiphtUpNativeStatus.updateRideProgress === 'function') {
                window.LiphtUpNativeStatus.updateRideProgress(remainingKm, etaMins);
            } else if (typeof window.LiphtUpNativeStatus.updateNotificationText === 'function') {
                window.LiphtUpNativeStatus.updateNotificationText(formatted);
            }
        }
    }

    /**
     * Clean up listeners.
     */
    public detach(): void {
        for (const item of this.eventListeners) {
            item.target.removeEventListener(item.type, item.handler);
        }
        this.eventListeners = [];
        this.attachedSockets.clear();
        console.log('[PersistentNotificationManager] Detached listeners.');
    }
}

if (typeof window !== 'undefined') {
    (window as any).PersistentNotificationManager = PersistentNotificationManager;
}
