/**
 * notification-manager.js
 *
 * Persistent Notification Text Manager for LiphtUp.
 * Listens to incoming socket payloads and server events to dynamically update
 * the foreground service's notification text string in Android notification drawer.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PersistentNotificationManager = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var instance = null;

    function PersistentNotificationManager() {
        this.attachedSockets = [];
        this.eventListeners = [];
        this.lastUpdateTime = 0;
        this.minUpdateIntervalMs = 1500;
        this.lastFormattedText = '';

        this.bindGlobalEvents();
    }

    PersistentNotificationManager.getInstance = function () {
        if (!instance) {
            instance = new PersistentNotificationManager();
        }
        return instance;
    };

    PersistentNotificationManager.prototype.bindGlobalEvents = function () {
        var self = this;
        if (typeof window === 'undefined') return;

        var onProgress = function (evt) {
            if (evt && evt.detail) {
                self.handlePayload(evt.detail);
            }
        };

        window.addEventListener('ride-progress-updated', onProgress);
        self.eventListeners.push({ target: window, type: 'ride-progress-updated', handler: onProgress });

        var onLocation = function (evt) {
            if (evt && evt.detail) {
                var det = evt.detail;
                if (det.remaining_km !== undefined || det.remainingKm !== undefined) {
                    self.handlePayload(det);
                }
            }
        };

        window.addEventListener('driver-location-updated', onLocation);
        self.eventListeners.push({ target: window, type: 'driver-location-updated', handler: onLocation });
    };

    PersistentNotificationManager.prototype.attachSocket = function (socket) {
        var self = this;
        if (!socket || typeof socket.on !== 'function') return;
        if (self.attachedSockets.indexOf(socket) !== -1) return;

        self.attachedSockets.push(socket);

        var onProgress = function (data) {
            if (data) {
                self.handlePayload(data);
            }
        };

        socket.on('ride-progress', onProgress);
        socket.on('ride_progress', onProgress);
        socket.on('location-update', onProgress);
        socket.on('driver-location', onProgress);

        console.log('[PersistentNotificationManager] Attached to Socket.io instance.');
    };

    PersistentNotificationManager.prototype.handlePayload = function (payload) {
        var remainingKm = payload.remaining_km !== undefined ? payload.remaining_km : payload.remainingKm;
        var etaMins = payload.eta_mins !== undefined ? payload.eta_mins : payload.etaMins;
        var status = payload.status || '';

        if (remainingKm === undefined || remainingKm === null) {
            return;
        }

        var remKmVal = typeof remainingKm === 'number' ? remainingKm : parseFloat(String(remainingKm));
        var etaVal = typeof etaMins === 'number' ? etaMins : (etaMins ? parseInt(String(etaMins), 10) : 0);

        if (isNaN(remKmVal)) return;

        this.updateDrawer(remKmVal, isNaN(etaVal) ? 0 : etaVal, status);
    };

    PersistentNotificationManager.prototype.updateDrawer = function (remainingKm, etaMins, status) {
        var now = Date.now();
        if (now - this.lastUpdateTime < this.minUpdateIntervalMs) {
            return;
        }

        var formatted;
        if (remainingKm <= 0.05) {
            formatted = 'Arrived at destination • Completing ride';
        } else if (status === 'accepted' || status === 'arrived') {
            formatted = 'Approaching pickup • ' + remainingKm.toFixed(1) + ' KM • ' + etaMins + ' mins';
        } else {
            formatted = remainingKm.toFixed(1) + ' KM remaining • ' + etaMins + ' mins to destination';
        }

        if (formatted === this.lastFormattedText) {
            return;
        }

        this.lastUpdateTime = now;
        this.lastFormattedText = formatted;

        if (typeof window !== 'undefined' && window.LiphtUpNativeStatus) {
            if (typeof window.LiphtUpNativeStatus.updateRideProgress === 'function') {
                window.LiphtUpNativeStatus.updateRideProgress(remainingKm, etaMins);
            } else if (typeof window.LiphtUpNativeStatus.updateNotificationText === 'function') {
                window.LiphtUpNativeStatus.updateNotificationText(formatted);
            }
        }
    };

    PersistentNotificationManager.prototype.detach = function () {
        var self = this;
        for (var i = 0; i < self.eventListeners.length; i++) {
            var item = self.eventListeners[i];
            item.target.removeEventListener(item.type, item.handler);
        }
        self.eventListeners = [];
        self.attachedSockets = [];
    };

    return PersistentNotificationManager;
}));
