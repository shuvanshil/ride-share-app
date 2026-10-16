/**
 * ride-tracking-service.js
 *
 * Production-ready vehicle background tracking service for LiphtUp.
 *
 * PLATFORM CAVEATS:
 * 1. Background WebView Freezing:
 *    On mobile platforms, the browser engine pauses execution loops (setInterval / setTimeout)
 *    when the app is minimized or the driver switches to turn-by-turn navigation apps.
 *    Tracking relies on the native Android Foreground Service with continuous wake lock
 *    and direct HTTPS posting to /api/rides/driver-location.
 * 2. Sequential Permission Requests:
 *    Android requires requesting foreground location (Fine/Coarse) before background location.
 *    Android 13+ requires POST_NOTIFICATIONS runtime permission.
 * 3. Sticky Foreground Service:
 *    Android Foreground Service uses 'ongoing: true' so users cannot swipe it away while
 *    a ride is active.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.RideTrackingService = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var instance = null;

    function RideTrackingService() {
        this.activeRideId = null;
        this.driverToken = null;
        this.refreshToken = null;
        this.isTracking = false;
        this.offlineQueue = [];
        this.queueStorageKey = 'liphtup_offline_location_queue';
        this.webWatchId = null;
        this.queueFlushTimer = null;
        this.backgroundPluginWatcherId = null;

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

    RideTrackingService.getInstance = function () {
        if (!instance) {
            instance = new RideTrackingService();
        }
        return instance;
    };

    /**
     * Sequential permission flow:
     * 1. Foreground Location
     * 2. Notifications (Android 13+)
     * 3. Background Location
     * 4. Battery Optimization Exemption
     */
    RideTrackingService.prototype.requestPermissionsSequentially = function () {
        var self = this;
        var status = {
            location: false,
            backgroundLocation: false,
            notifications: false,
            batteryOptimizationIgnored: false,
        };

        return Promise.resolve()
            .then(function () {
                // 1. Foreground Location
                if (navigator.permissions && navigator.permissions.query) {
                    return navigator.permissions.query({ name: 'geolocation' })
                        .then(function (geoPerm) {
                            status.location = (geoPerm.state === 'granted');
                        })
                        .catch(function () {});
                }
            })
            .then(function () {
                if (!status.location && navigator.geolocation) {
                    return new Promise(function (resolve) {
                        navigator.geolocation.getCurrentPosition(
                            function () {
                                status.location = true;
                                resolve();
                            },
                            function (err) {
                                console.warn('[RideTrackingService] Foreground location permission check:', err.message);
                                resolve();
                            },
                            { timeout: 5000, enableHighAccuracy: true }
                        );
                    });
                }
            })
            .then(function () {
                // 2. Notification Permissions
                var PushNotifications = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
                if (PushNotifications && typeof PushNotifications.requestPermissions === 'function') {
                    return PushNotifications.requestPermissions().then(function (p) {
                        status.notifications = (p.receive === 'granted');
                    }).catch(function () {
                        status.notifications = true;
                    });
                } else if (typeof Notification !== 'undefined' && Notification.requestPermission) {
                    return Notification.requestPermission().then(function (p) {
                        status.notifications = (p === 'granted');
                    }).catch(function () {
                        status.notifications = true;
                    });
                } else {
                    status.notifications = true;
                }
            })
            .then(function () {
                // 3. Background Location Plugin (if installed)
                var BackgroundGeo = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) || window.BackgroundGeolocation;
                if (BackgroundGeo && typeof BackgroundGeo.requestPermissions === 'function') {
                    return BackgroundGeo.requestPermissions().then(function (res) {
                        status.backgroundLocation = (res.location === 'granted' || res.background === 'granted');
                    }).catch(function () {});
                } else {
                    status.backgroundLocation = true; // Handled by custom native DriverLocationService
                }
            })
            .then(function () {
                // 4. Battery Optimization Exemption
                if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.isBatteryOptimizationIgnored === 'function') {
                    try {
                        status.batteryOptimizationIgnored = window.LiphtUpNativeStatus.isBatteryOptimizationIgnored();
                        if (!status.batteryOptimizationIgnored && window.LiphtUpNativeStatus.requestIgnoreBatteryOptimizations) {
                            window.LiphtUpNativeStatus.requestIgnoreBatteryOptimizations();
                        }
                    } catch (e) {
                        console.warn('[RideTrackingService] Battery exemption error:', e);
                    }
                } else {
                    status.batteryOptimizationIgnored = true;
                }
                return status;
            });
    };

    RideTrackingService.prototype.startRideTracking = function (rideId, driverToken, refreshToken, userOptions) {
        var self = this;
        if (!rideId || !driverToken) {
            return Promise.reject(new Error('[RideTrackingService] rideId and driverToken are required.'));
        }

        self.activeRideId = rideId;
        self.driverToken = driverToken;
        if (refreshToken) self.refreshToken = refreshToken;
        if (userOptions) {
            for (var key in userOptions) {
                if (Object.prototype.hasOwnProperty.call(userOptions, key)) {
                    self.options[key] = userOptions[key];
                }
            }
        }

        return self.requestPermissionsSequentially().then(function () {
            // 1. Launch native Android Foreground Service with sticky notification
            if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.startDriverTracking === 'function') {
                try {
                    var configPayload = {
                        state: 'active_ride',
                        rideId: self.activeRideId,
                        authToken: self.driverToken,
                        refreshToken: self.refreshToken || '',
                        apiBaseUrl: self.options.apiBaseUrl,
                        distanceFilter: self.options.distanceFilter,
                        interval: self.options.interval,
                        notificationTitle: self.options.notificationTitle,
                        notificationText: self.options.notificationText,
                        ongoing: true,
                    };
                    window.LiphtUpNativeStatus.startDriverTracking(JSON.stringify(configPayload));
                    self.isTracking = true;
                    console.log('[RideTrackingService] Native Android foreground service launched.');
                } catch (e) {
                    console.error('[RideTrackingService] Native startDriverTracking failed:', e);
                }
            }

            // 2. Launch Capgo / Capacitor Community Background Geolocation Plugin (if present)
            var BackgroundGeo = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) || window.BackgroundGeolocation;
            if (BackgroundGeo && typeof BackgroundGeo.addWatcher === 'function') {
                try {
                    BackgroundGeo.addWatcher({
                        backgroundTitle: self.options.notificationTitle,
                        backgroundMessage: self.options.notificationText,
                        requestPermissions: true,
                        stale: false,
                        distanceFilter: self.options.distanceFilter,
                        interval: self.options.interval,
                        fastestInterval: self.options.fastestInterval,
                        notificationTitle: self.options.notificationTitle,
                        notificationText: self.options.notificationText,
                        ongoing: true,
                        server: {
                            url: self.options.apiBaseUrl + self.options.syncUrl,
                            headers: {
                                'Authorization': 'Bearer ' + self.driverToken,
                                'Content-Type': 'application/json',
                            },
                            postTemplate: {
                                lat: '@latitude',
                                lng: '@longitude',
                                driverAccuracy: '@accuracy',
                                driverSpeed: '@speed',
                                driverHeading: '@bearing',
                                rideId: self.activeRideId,
                                timestamp: '@time',
                            },
                        },
                    }, function (loc, err) {
                        if (err) {
                            console.warn('[RideTrackingService] BackgroundGeolocation error:', err);
                            return;
                        }
                        if (loc) {
                            self.handleLocationUpdate({
                                lat: loc.latitude,
                                lng: loc.longitude,
                                driverAccuracy: loc.accuracy,
                                driverSpeed: loc.speed,
                                driverHeading: loc.bearing,
                                rideId: self.activeRideId,
                                timestamp: loc.time || Date.now(),
                            });
                        }
                    }).then(function (wId) {
                        self.backgroundPluginWatcherId = wId;
                        self.isTracking = true;
                    }).catch(function (err) {
                        console.warn('[RideTrackingService] addWatcher error:', err);
                    });
                } catch (e) {
                    console.warn('[RideTrackingService] Plugin addWatcher error:', e);
                }
            }

            // 3. Launch foreground web watcher for smooth local UI updates
            self.startForegroundWatcher();

            // 4. Start offline queue sync worker
            self.startQueueSyncWorker();

            return self.isTracking;
        });
    };

    RideTrackingService.prototype.stopRideTracking = function () {
        var self = this;
        console.log('[RideTrackingService] Stopping ride tracking...');

        // 1. Stop Native Foreground Service
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.stopDriverTracking === 'function') {
            try {
                window.LiphtUpNativeStatus.stopDriverTracking();
            } catch (e) {
                console.warn('[RideTrackingService] stopDriverTracking error:', e);
            }
        }

        // 2. Remove Plugin Watcher
        var BackgroundGeo = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) || window.BackgroundGeolocation;
        if (BackgroundGeo && self.backgroundPluginWatcherId) {
            try {
                BackgroundGeo.removeWatcher({ id: self.backgroundPluginWatcherId });
                self.backgroundPluginWatcherId = null;
            } catch (e) {
                console.warn('[RideTrackingService] removeWatcher error:', e);
            }
        }

        // 3. Clear Web Watcher
        if (self.webWatchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(self.webWatchId);
            self.webWatchId = null;
        }

        // 4. Flush Queue
        if (self.queueFlushTimer) {
            clearInterval(self.queueFlushTimer);
            self.queueFlushTimer = null;
        }
        return self.flushQueue().then(function () {
            self.isTracking = false;
            self.activeRideId = null;
            console.log('[RideTrackingService] Stopped tracking.');
        });
    };

    RideTrackingService.prototype.updateNotificationText = function (text) {
        if (!text) return;
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.updateNotificationText === 'function') {
            window.LiphtUpNativeStatus.updateNotificationText(text);
        }
    };

    RideTrackingService.prototype.updateProgress = function (remainingKm, etaMins) {
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.updateRideProgress === 'function') {
            window.LiphtUpNativeStatus.updateRideProgress(remainingKm, etaMins);
        } else {
            var formatted = remainingKm <= 0.05
                ? 'Arrived at destination • Completing ride'
                : remainingKm.toFixed(1) + ' KM remaining • ' + etaMins + ' mins to destination';
            this.updateNotificationText(formatted);
        }
    };

    RideTrackingService.prototype.handleLocationUpdate = function (payload) {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('driver-location-updated', {
                detail: payload,
            }));
            if (typeof window.onNativeLocationUpdate === 'function') {
                try {
                    window.onNativeLocationUpdate(payload);
                } catch (e) {
                    console.error('[RideTrackingService] onNativeLocationUpdate error:', e);
                }
            }
        }

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            this.enqueueLocation(payload);
        }
    };

    RideTrackingService.prototype.startForegroundWatcher = function () {
        var self = this;
        if (!navigator.geolocation) return;
        if (self.webWatchId !== null) {
            navigator.geolocation.clearWatch(self.webWatchId);
        }

        self.webWatchId = navigator.geolocation.watchPosition(
            function (pos) {
                var payload = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    driverAccuracy: pos.coords.accuracy,
                    driverSpeed: (pos.coords.speed !== null && pos.coords.speed >= 0) ? pos.coords.speed : undefined,
                    driverHeading: (pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading >= 0) ? pos.coords.heading : undefined,
                    rideId: self.activeRideId || undefined,
                    timestamp: pos.timestamp || Date.now(),
                };
                self.handleLocationUpdate(payload);
            },
            function (err) {
                console.warn('[RideTrackingService] watchPosition warning:', err.message);
            },
            {
                enableHighAccuracy: self.options.enableHighAccuracy,
                timeout: 10000,
                maximumAge: 2000,
            }
        );
    };

    RideTrackingService.prototype.enqueueLocation = function (payload) {
        this.offlineQueue.push(payload);
        if (this.offlineQueue.length > 500) {
            this.offlineQueue.shift();
        }
        this.saveOfflineQueue();
    };

    RideTrackingService.prototype.saveOfflineQueue = function () {
        try {
            localStorage.setItem(this.queueStorageKey, JSON.stringify(this.offlineQueue));
        } catch (ignored) {}
    };

    RideTrackingService.prototype.loadOfflineQueue = function () {
        try {
            var raw = localStorage.getItem(this.queueStorageKey);
            if (raw) {
                this.offlineQueue = JSON.parse(raw);
            }
        } catch (ignored) {
            this.offlineQueue = [];
        }
    };

    RideTrackingService.prototype.startQueueSyncWorker = function () {
        var self = this;
        if (self.queueFlushTimer) clearInterval(self.queueFlushTimer);
        self.queueFlushTimer = setInterval(function () {
            if (navigator.onLine && self.offlineQueue.length > 0) {
                self.flushQueue();
            }
        }, 10000);
    };

    RideTrackingService.prototype.flushQueue = function () {
        var self = this;
        if (!self.driverToken || self.offlineQueue.length === 0) return Promise.resolve();

        var batch = self.offlineQueue.slice();
        self.offlineQueue = [];
        self.saveOfflineQueue();

        var endpoint = self.options.apiBaseUrl + self.options.syncUrl;
        var promises = batch.map(function (item) {
            return fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + self.driverToken,
                },
                body: JSON.stringify(item),
            }).catch(function () {
                self.offlineQueue.push(item);
            });
        });

        return Promise.all(promises).then(function () {
            self.saveOfflineQueue();
        });
    };

    return RideTrackingService;
}));
