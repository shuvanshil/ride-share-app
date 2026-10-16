/**
 * marker-animation.js
 *
 * Smooth Google Maps Marker Animation Utility for LiphtUp.
 *
 * Implements high-precision Linear Interpolation (LERP), shortest-arc heading
 * interpolation, antimeridian wrap-around handling, and requestAnimationFrame
 * scheduling to glide vehicle markers smoothly down roads without snapping or flickering.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        var exp = factory();
        root.animateMarkerMove = exp.animateMarkerMove;
        root.calculateBearing = exp.calculateBearing;
        root.MarkerAnimation = exp;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var activeAnimations = typeof WeakMap !== 'undefined' ? new WeakMap() : {
        map: [],
        get: function (k) {
            for (var i = 0; i < this.map.length; i++) {
                if (this.map[i].key === k) return this.map[i].val;
            }
            return null;
        },
        set: function (k, val) {
            this.delete(k);
            this.map.push({ key: k, val: val });
        },
        delete: function (k) {
            for (var i = 0; i < this.map.length; i++) {
                if (this.map[i].key === k) {
                    this.map.splice(i, 1);
                    return;
                }
            }
        }
    };

    function normalizeDegrees(deg) {
        return ((deg % 360) + 360) % 360;
    }

    function shortestAngleDelta(fromDeg, toDeg) {
        var diff = (toDeg - fromDeg) % 360;
        return ((diff + 540) % 360) - 180;
    }

    function calculateBearing(lat1, lng1, lat2, lng2) {
        var phi1 = (lat1 * Math.PI) / 180;
        var phi2 = (lat2 * Math.PI) / 180;
        var deltaLambda = ((lng2 - lng1) * Math.PI) / 180;

        var y = Math.sin(deltaLambda) * Math.cos(phi2);
        var x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

        var radians = Math.atan2(y, x);
        return normalizeDegrees((radians * 180) / Math.PI);
    }

    function haversineKm(lat1, lng1, lat2, lng2) {
        var R = 6371.0;
        var dLat = ((lat2 - lat1) * Math.PI) / 180;
        var dLng = ((lng2 - lng1) * Math.PI) / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function applyEasing(t, easing) {
        if (easing === 'linear') {
            return t;
        }
        if (easing === 'easeOutQuad') {
            return t * (2 - t);
        }
        // Default: easeInOutCubic for realistic vehicle acceleration & deceleration
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function extractMarkerPosition(marker) {
        if (!marker) return null;

        if (typeof marker.getPosition === 'function') {
            var pos = marker.getPosition();
            if (!pos) return null;
            var lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
            var lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
            if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
        }

        if (marker.position) {
            var p = marker.position;
            var pLat = typeof p.lat === 'function' ? p.lat() : p.lat;
            var pLng = typeof p.lng === 'function' ? p.lng() : p.lng;
            if (isFinite(pLat) && isFinite(pLng)) return { lat: pLat, lng: pLng };
        }

        return null;
    }

    function setMarkerPosition(marker, lat, lng) {
        if (typeof window !== 'undefined' && window.google && window.google.maps && window.google.maps.LatLng) {
            var latLng = new window.google.maps.LatLng(lat, lng);
            if (typeof marker.setPosition === 'function') {
                marker.setPosition(latLng);
                return;
            }
        }
        if (typeof marker.setPosition === 'function') {
            marker.setPosition({ lat: lat, lng: lng });
        } else {
            marker.position = { lat: lat, lng: lng };
        }
    }

    function setMarkerHeading(marker, heading) {
        if (typeof marker.setHeading === 'function') {
            marker.setHeading(heading);
            return;
        }
        var icon = marker.getIcon ? marker.getIcon() : marker.icon;
        if (icon && typeof icon === 'object' && icon.path !== undefined) {
            var updated = {};
            for (var k in icon) {
                if (Object.prototype.hasOwnProperty.call(icon, k)) {
                    updated[k] = icon[k];
                }
            }
            updated.rotation = heading;
            marker.setIcon(updated);
        }
    }

    /**
     * Animates marker movement using requestAnimationFrame and Linear Interpolation (LERP).
     */
    function animateMarkerMove(marker, targetLat, targetLng, durationMs, options) {
        if (!marker) {
            console.warn('[animateMarkerMove] Invalid marker.');
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        if (!isFinite(targetLat) || targetLat < -90 || targetLat > 90) {
            console.warn('[animateMarkerMove] Invalid targetLat:', targetLat);
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        if (!isFinite(targetLng) || targetLng < -180 || targetLng > 180) {
            console.warn('[animateMarkerMove] Invalid targetLng:', targetLng);
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        // Cancel previous animation frame first so marker freezes at its exact intermediate position
        var prev = activeAnimations.get(marker);
        if (prev) {
            prev.cancel();
            activeAnimations.delete(marker);
        }

        var startPos = extractMarkerPosition(marker);
        if (!startPos) {
            setMarkerPosition(marker, targetLat, targetLng);
            if (options && options.onComplete) options.onComplete();
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        var startLat = startPos.lat;
        var startLng = startPos.lng;

        var distKm = haversineKm(startLat, startLng, targetLat, targetLng);
        if (distKm < 0.0001) {
            if (options && options.onComplete) options.onComplete();
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        if (distKm > 30.0) {
            // Teleport threshold: snap directly
            setMarkerPosition(marker, targetLat, targetLng);
            if (options && options.onComplete) options.onComplete();
            return { cancel: function () {}, isFinished: function () { return true; } };
        }

        var deltaLng = targetLng - startLng;
        if (deltaLng > 180) {
            deltaLng -= 360;
        } else if (deltaLng < -180) {
            deltaLng += 360;
        }

        var targetHeading = (options && options.targetHeading !== undefined)
            ? options.targetHeading
            : calculateBearing(startLat, startLng, targetLat, targetLng);

        var startHeading = marker.__currentHeading;
        if (startHeading === undefined) {
            var icon = typeof marker.getIcon === 'function' ? marker.getIcon() : marker.icon;
            if (icon && typeof icon === 'object' && typeof icon.rotation === 'number') {
                startHeading = icon.rotation;
            } else if (typeof marker.getHeading === 'function') {
                startHeading = marker.getHeading();
            }
        }
        if (startHeading === undefined || isNaN(startHeading)) {
            startHeading = targetHeading;
        }

        var headingDelta = shortestAngleDelta(startHeading, targetHeading);
        var easingType = (options && options.easing) || 'easeInOutCubic';
        var effectiveDuration = Math.max(100, durationMs || 1200);

        var isDone = false;
        var startTime = null;
        var frameId = 0;

        var cancel = function () {
            if (!isDone) {
                isDone = true;
                if (frameId && typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(frameId);
                }
                activeAnimations.delete(marker);
            }
        };

        var step = function (timestamp) {
            if (isDone) return;

            if (startTime === null) {
                startTime = timestamp;
            }

            var elapsed = timestamp - startTime;
            var rawProgress = Math.min(1.0, Math.max(0.0, elapsed / effectiveDuration));
            var progress = applyEasing(rawProgress, easingType);

            // Incremental LERP calculations
            var currentLat = startLat + (targetLat - startLat) * progress;
            var currentLng = startLng + deltaLng * progress;
            if (currentLng > 180) {
                currentLng -= 360;
            } else if (currentLng < -180) {
                currentLng += 360;
            }

            setMarkerPosition(marker, currentLat, currentLng);

            var currentHeading = targetHeading;
            if (!options || options.updateHeading !== false) {
                currentHeading = normalizeDegrees(startHeading + headingDelta * progress);
                marker.__currentHeading = currentHeading;
                setMarkerHeading(marker, currentHeading);
            }

            if (options && options.onStep) {
                options.onStep(currentLat, currentLng, currentHeading);
            }

            if (rawProgress < 1.0) {
                frameId = requestAnimationFrame(step);
                activeAnimations.set(marker, { frameId: frameId, cancel: cancel });
            } else {
                setMarkerPosition(marker, targetLat, targetLng);
                if (!options || options.updateHeading !== false) {
                    marker.__currentHeading = targetHeading;
                    setMarkerHeading(marker, targetHeading);
                }
                isDone = true;
                activeAnimations.delete(marker);
                if (options && options.onComplete) {
                    options.onComplete();
                }
            }
        };

        frameId = requestAnimationFrame(step);
        activeAnimations.set(marker, { frameId: frameId, cancel: cancel });

        return {
            cancel: cancel,
            isFinished: function () { return isDone; }
        };
    }

    return {
        animateMarkerMove: animateMarkerMove,
        calculateBearing: calculateBearing,
        haversineKm: haversineKm,
        normalizeDegrees: normalizeDegrees,
        shortestAngleDelta: shortestAngleDelta
    };
}));
