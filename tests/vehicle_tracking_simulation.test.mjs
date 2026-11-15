import test from "node:test";
import assert from "node:assert/strict";

// Core geometry, bearing, orientation, route-snapping, outlier-filtering, and green-line
// progress functions matching www/js/driver/driver-service.js, www/js/map/map-core.js,
// and www/js/passenger/passenger-tracking.js.

const VEHICLE_ICON_ROTATION_OFFSET = {
    bike: 0,
    auto: 0
};

const ROUTE_SNAP_MAX_METERS = 120;
const ROUTE_SNAP_HYSTERESIS_METERS = 75;
const ROUTE_MATCH_SEARCH_WINDOW = 60;
const ROUTE_MATCH_BACKWARD_TOLERANCE = 2;

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function toDegrees(value) {
    return (value * 180) / Math.PI;
}

function normalizeDegrees(angle) {
    const value = Number(angle);
    if (!Number.isFinite(value)) return null;
    return ((value % 360) + 360) % 360;
}

function normalizeHeading(heading) {
    return normalizeDegrees(heading);
}

function shortestHeadingDelta(fromHeading, toHeading) {
    const from = normalizeHeading(fromHeading) ?? 0;
    const to = normalizeHeading(toHeading) ?? 0;
    return ((to - from + 540) % 360) - 180;
}

function smoothHeading(previousHeading, nextHeading, factor = 0.35) {
    const next = normalizeHeading(nextHeading);
    const previous = normalizeHeading(previousHeading);
    if (next == null) return previous;
    if (previous == null) return next;
    const delta = shortestHeadingDelta(previous, next);
    if (Math.abs(delta) < 0.5) return next;
    return normalizeHeading(previous + (delta * factor));
}

function calculateBearing(from, to) {
    if (!from || !to) return null;
    const lat1 = Number(from.lat);
    const lng1 = Number(from.lng);
    const lat2 = Number(to.lat);
    const lng2 = Number(to.lng);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
    if (Math.abs(lat1 - lat2) < 1e-7 && Math.abs(lng1 - lng2) < 1e-7) return null;

    const rLat1 = toRadians(lat1);
    const rLat2 = toRadians(lat2);
    const dLng = toRadians(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(rLat2);
    const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLng);
    return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    const earthRadius = 6371000;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function movePointByBearing(origin, bearingDeg, distMeters) {
    const R = 6371000;
    const brng = toRadians(bearingDeg);
    const dByR = distMeters / R;
    const lat1 = toRadians(origin.lat);
    const lng1 = toRadians(origin.lng);

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(dByR) +
        Math.cos(lat1) * Math.sin(dByR) * Math.cos(brng)
    );
    const lng2 = lng1 + Math.atan2(
        Math.sin(brng) * Math.sin(dByR) * Math.cos(lat1),
        Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    );
    return {
        lat: toDegrees(lat2),
        lng: toDegrees(lng2)
    };
}

function computeDisplayedScreenRotation(heading, vehicleType = "auto", mapHeading = 0) {
    const baseOffset = VEHICLE_ICON_ROTATION_OFFSET[vehicleType] ?? 0;
    return normalizeDegrees(heading - mapHeading + baseOffset) ?? 0;
}

function projectRawFractionOntoSegment(point, segStart, segEnd) {
    const lngScale = Math.cos((segStart.lat * Math.PI) / 180) || 1e-9;
    const segLat = segEnd.lat - segStart.lat;
    const segLng = (segEnd.lng - segStart.lng) * lngScale;
    const pointLat = point.lat - segStart.lat;
    const pointLng = (point.lng - segStart.lng) * lngScale;

    const segLengthSq = (segLat * segLat) + (segLng * segLng);
    if (segLengthSq <= 1e-18) return 0;

    return ((pointLat * segLat) + (pointLng * segLng)) / segLengthSq;
}

function matchPositionToRoute(position, routePath, lastIndex = -1, vehicleHeading = null, lastFraction = 0) {
    if (!position || !Array.isArray(routePath) || routePath.length < 2) return null;

    let searchFullRange = lastIndex < 0 || lastIndex >= routePath.length - 1;
    let windowStart = searchFullRange ? 0 : Math.max(0, lastIndex - ROUTE_MATCH_BACKWARD_TOLERANCE);
    let windowEnd = searchFullRange ? routePath.length - 2 : Math.min(routePath.length - 2, lastIndex + ROUTE_MATCH_SEARCH_WINDOW);

    if (windowStart > windowEnd) {
        searchFullRange = true;
        windowStart = 0;
        windowEnd = routePath.length - 2;
    }

    const maxSnapMeters = searchFullRange ? ROUTE_SNAP_MAX_METERS : ROUTE_SNAP_HYSTERESIS_METERS;
    const normalizedVehicleHeading = normalizeHeading(vehicleHeading);

    const evaluateCandidate = (currentBest, segIndex, segStart, segEnd, isWindowSearch, snapLimit = maxSnapMeters) => {
        if (!segStart || !segEnd) return currentBest;
        const rawFraction = projectRawFractionOntoSegment(position, segStart, segEnd);
        let fraction = Math.max(0, Math.min(1, rawFraction));

        const nearEndZone = routePath.length <= 4 || lastIndex >= routePath.length - 4;
        if (segIndex === routePath.length - 2 && rawFraction > 1.0 && nearEndZone) {
            const distPastDest = distanceMeters(position, segEnd);
            if (distPastDest > 6 && distPastDest <= 350) {
                return {
                    index: routePath.length - 1,
                    fraction: 1.0,
                    point: position,
                    distanceMeters: distPastDest,
                    heading: normalizedVehicleHeading ?? calculateBearing(segStart, segEnd),
                    isPastDestination: true,
                    score: 0
                };
            }
        }

        if (isWindowSearch && segIndex === lastIndex && Number.isFinite(lastFraction) && fraction < lastFraction) {
            const segLen = distanceMeters(segStart, segEnd);
            const backwardMeters = (lastFraction - fraction) * segLen;
            if (backwardMeters <= 15) {
                fraction = lastFraction;
            }
        }

        const projected = {
            lat: segStart.lat + ((segEnd.lat - segStart.lat) * fraction),
            lng: segStart.lng + ((segEnd.lng - segStart.lng) * fraction)
        };
        const dist = distanceMeters(position, projected);
        if (dist > snapLimit) return currentBest;

        let segHeading = calculateBearing(segStart, segEnd);
        if (segHeading == null && segIndex + 2 < routePath.length) {
            segHeading = calculateBearing(segStart, routePath[segIndex + 2]);
        }
        const isHeadingAligned = (normalizedVehicleHeading != null && segHeading != null)
            ? Math.abs(shortestHeadingDelta(normalizedVehicleHeading, segHeading)) <= 100
            : true;

        let score = dist;
        if (isWindowSearch && segIndex < lastIndex) {
            score += (lastIndex - segIndex) * 12;
        }
        if (!isHeadingAligned) {
            score += 24;
        }

        if (!currentBest || score < currentBest.score) {
            return {
                index: segIndex,
                fraction,
                point: projected,
                distanceMeters: dist,
                heading: segHeading,
                isPastDestination: false,
                score
            };
        }
        return currentBest;
    };

    let best = null;
    for (let i = windowStart; i <= windowEnd; i += 1) {
        best = evaluateCandidate(best, i, routePath[i], routePath[i + 1], !searchFullRange, maxSnapMeters);
    }
    if (!best && !searchFullRange) {
        for (let i = 0; i <= routePath.length - 2; i += 1) {
            best = evaluateCandidate(best, i, routePath[i], routePath[i + 1], false, ROUTE_SNAP_MAX_METERS);
        }
    }
    return best;
}

class SimulatedVehicleTracker {
    constructor(routePath, vehicleType = "auto") {
        this.routePath = routePath;
        this.vehicleType = vehicleType;
        this.lastIndex = -1;
        this.lastFraction = 0;
        this.lastRawPosition = null;
        this.lastHeading = null;
        this.markerPosition = null;
        this.hasPassedDestination = false;
        this.offRouteCount = 0;
        this.lastAcceptedEpochMs = 0;
        this.lastAcceptedFixAt = null;
        this.pendingOutlier = null;
        this.remainingPolyline = [...routePath];
    }

    ingestUpdate({ position, heading = null, speed = null, nowMs = 1000, epochMs = 0, mapHeading = 0 }) {
        // 1. Out-of-order timestamp check
        if (epochMs > 0 && epochMs < this.lastAcceptedEpochMs) {
            return { accepted: false, reason: "stale_timestamp" };
        }

        // 2. Outlier speed check
        if (this.lastRawPosition) {
            const elapsedSec = (epochMs > 0 && this.lastAcceptedEpochMs > 0 && (epochMs - this.lastAcceptedEpochMs) >= 200)
                ? (epochMs - this.lastAcceptedEpochMs) / 1000
                : Math.max(0.5, (nowMs - (this.lastAcceptedFixAt || nowMs)) / 1000);
            const jumpDist = distanceMeters(this.lastRawPosition, position);
            const impliedSpeed = jumpDist / elapsedSec;
            if (impliedSpeed > 45) {
                if (this.pendingOutlier && distanceMeters(this.pendingOutlier, position) <= 60) {
                    this.pendingOutlier = null;
                } else {
                    this.pendingOutlier = position;
                    return {
                        accepted: true,
                        outlierHeld: true,
                        position: this.markerPosition,
                        heading: this.lastHeading,
                        screenRotation: computeDisplayedScreenRotation(this.lastHeading ?? 0, this.vehicleType, mapHeading),
                        remainingPolyline: this.remainingPolyline,
                        hasPassedDestination: this.hasPassedDestination
                    };
                }
            } else {
                this.pendingOutlier = null;
            }
        }

        const prevRaw = this.lastRawPosition;
        const rawMoveDist = prevRaw ? distanceMeters(prevRaw, position) : 0;
        const hasValidSpeed = speed !== null && Number.isFinite(Number(speed)) && Number(speed) >= 0;
        const isMoving = hasValidSpeed
            ? (Number(speed) >= 0.8 && (prevRaw == null || rawMoveDist >= 1.5))
            : (rawMoveDist >= 2.5);

        if (epochMs > 0) this.lastAcceptedEpochMs = epochMs;
        this.lastAcceptedFixAt = nowMs;
        this.lastRawPosition = position;

        const motionBearing = (isMoving && prevRaw && rawMoveDist >= 2.5)
            ? calculateBearing(prevRaw, position)
            : null;
        const reliableGpsHeading = (isMoving && heading != null && heading !== 0 && hasValidSpeed && speed >= 1.0)
            ? normalizeHeading(heading)
            : null;

        let renderPos = position;
        let matchedHeading = null;
        const destPt = this.routePath[this.routePath.length - 1];

        if (this.hasPassedDestination && destPt && distanceMeters(position, destPt) > 6) {
            renderPos = position;
            this.lastIndex = this.routePath.length - 1;
            this.lastFraction = 1.0;
            this.remainingPolyline = [];
        } else if (this.routePath.length >= 2) {
            const candidateH = reliableGpsHeading ?? motionBearing ?? this.lastHeading ?? normalizeHeading(heading);
            const match = matchPositionToRoute(position, this.routePath, this.lastIndex, candidateH, this.lastFraction);
            if (match) {
                this.offRouteCount = 0;
                this.lastIndex = match.index;
                this.lastFraction = match.fraction;
                if (match.isPastDestination) {
                    this.hasPassedDestination = true;
                    renderPos = position;
                    this.remainingPolyline = [];
                } else {
                    renderPos = match.point;
                    matchedHeading = match.heading;
                }
            } else if (this.lastIndex >= 0 && this.offRouteCount < 3) {
                this.offRouteCount += 1;
                renderPos = this.markerPosition || position;
                matchedHeading = this.lastHeading;
            }
        }

        if (!isMoving && this.markerPosition && distanceMeters(this.markerPosition, renderPos) < 2.5) {
            renderPos = this.markerPosition;
        }

        let resolvedHeading = this.lastHeading;
        if (isMoving) {
            const rawMoveH = reliableGpsHeading ?? motionBearing ?? normalizeHeading(heading);
            if (matchedHeading != null && !this.hasPassedDestination && (rawMoveH == null || Math.abs(shortestHeadingDelta(matchedHeading, rawMoveH)) <= 65)) {
                resolvedHeading = matchedHeading;
            } else {
                resolvedHeading = rawMoveH ?? matchedHeading ?? this.lastHeading;
            }
        } else if (this.lastHeading != null) {
            resolvedHeading = this.lastHeading;
        } else if (matchedHeading != null) {
            resolvedHeading = matchedHeading;
        }

        // Frame-by-frame green route-line progress update at renderPos
        if (this.hasPassedDestination) {
            this.remainingPolyline = [];
        } else if (this.routePath.length >= 2 && this.lastIndex >= 0) {
            if (resolvedHeading != null && matchedHeading != null && Math.abs(shortestHeadingDelta(matchedHeading, resolvedHeading)) > 120) {
                // Reversing / moving backward: hide green line
                this.remainingPolyline = [];
            } else if (this.lastIndex >= this.routePath.length - 1) {
                this.remainingPolyline = [];
            } else {
                const rem = [renderPos].concat(this.routePath.slice(this.lastIndex + 1));
                this.remainingPolyline = rem.length >= 2 ? rem : [];
            }
        }

        this.markerPosition = renderPos;
        this.lastHeading = resolvedHeading;

        return {
            accepted: true,
            outlierHeld: false,
            position: renderPos,
            heading: resolvedHeading,
            screenRotation: computeDisplayedScreenRotation(resolvedHeading ?? 0, this.vehicleType, mapHeading),
            remainingPolyline: this.remainingPolyline,
            hasPassedDestination: this.hasPassedDestination
        };
    }
}

test("Scenarios 1–4: Straight Vertical, Horizontal, Diagonal & Slightly Tilted Roads (Auto & Bike)", () => {
    const origin = { lat: 23.8315, lng: 91.2868 };
    const testAngles = [
        // Scenario 1: Vertical (North / South)
        0, 180,
        // Scenario 2: Horizontal (East / West)
        90, 270,
        // Scenario 3: Diagonal (NE, SE, SW, NW)
        45, 135, 225, 315,
        // Scenario 4: Slightly tilted / arbitrary angles
        5, 12, 23, 78, 103, 168, 192, 247, 285, 348
    ];

    for (const vehicleType of ["auto", "bike"]) {
        for (const angle of testAngles) {
            const p0 = origin;
            const p1 = movePointByBearing(p0, angle, 100);
            const p2 = movePointByBearing(p0, angle, 200);
            const route = [p0, p1, p2];
            const tracker = new SimulatedVehicleTracker(route, vehicleType);

            tracker.ingestUpdate({ position: p0, speed: 8, nowMs: 1000, epochMs: 1000 });
            const mid = movePointByBearing(p0, angle, 50);
            const res = tracker.ingestUpdate({ position: mid, speed: 8, nowMs: 4000, epochMs: 4000 });

            const delta = Math.abs(shortestHeadingDelta(angle, res.heading));
            assert.ok(delta < 0.5, `${vehicleType} at ${angle}° had heading ${res.heading}° (delta ${delta}°)`);
            const screenDelta = Math.abs(shortestHeadingDelta(angle, res.screenRotation));
            assert.ok(screenDelta < 0.5, `${vehicleType} screen rotation at ${angle}° was ${res.screenRotation}°`);

            // Verify rotated camera compensation (e.g. map rotated to 60°)
            const resRotatedMap = tracker.ingestUpdate({
                position: movePointByBearing(p0, angle, 80),
                speed: 8,
                nowMs: 7000,
                epochMs: 7000,
                mapHeading: 60
            });
            const expectedScreenAngle = normalizeDegrees(angle - 60);
            assert.ok(
                Math.abs(shortestHeadingDelta(expectedScreenAngle, resRotatedMap.screenRotation)) < 0.5,
                `${vehicleType} on rotated map (60°) expected ${expectedScreenAngle}°, got ${resRotatedMap.screenRotation}°`
            );
        }
    }
});

test("Scenarios 5–8: Gradually Curved Road, Sharp 90° Turns, S-Curve & U-Turn + 0°/360° Wraparound", () => {
    const p0 = { lat: 23.8315, lng: 91.2868 };
    // Scenario 5: Gradual curve (10° -> 25° -> 40° -> 55°)
    const c1 = movePointByBearing(p0, 10, 60);
    const c2 = movePointByBearing(c1, 25, 60);
    const c3 = movePointByBearing(c2, 40, 60);
    const c4 = movePointByBearing(c3, 55, 60);
    const curvedTracker = new SimulatedVehicleTracker([p0, c1, c2, c3, c4], "auto");

    curvedTracker.ingestUpdate({ position: p0, speed: 9, nowMs: 1000, epochMs: 1000 });
    const rSeg1 = curvedTracker.ingestUpdate({ position: movePointByBearing(p0, 10, 30), speed: 9, nowMs: 3000, epochMs: 3000 });
    const rSeg2 = curvedTracker.ingestUpdate({ position: movePointByBearing(c1, 25, 30), speed: 9, nowMs: 6000, epochMs: 6000 });
    const rSeg3 = curvedTracker.ingestUpdate({ position: movePointByBearing(c2, 40, 30), speed: 9, nowMs: 9000, epochMs: 9000 });
    assert.ok(Math.abs(shortestHeadingDelta(10, rSeg1.heading)) < 1);
    assert.ok(Math.abs(shortestHeadingDelta(25, rSeg2.heading)) < 1);
    assert.ok(Math.abs(shortestHeadingDelta(40, rSeg3.heading)) < 1);

    // Scenario 6 & 7: Sharp 90° right turn (0° -> 90°) then 90° left turn (90° -> 0°) S-curve
    const t1 = movePointByBearing(p0, 0, 80);
    const t2 = movePointByBearing(t1, 90, 80);
    const t3 = movePointByBearing(t2, 0, 80);
    const sTracker = new SimulatedVehicleTracker([p0, t1, t2, t3], "bike");
    sTracker.ingestUpdate({ position: movePointByBearing(p0, 0, 40), speed: 7, nowMs: 1000, epochMs: 1000 });
    const turnRight = sTracker.ingestUpdate({ position: movePointByBearing(t1, 90, 40), heading: 90, speed: 7, nowMs: 4000, epochMs: 4000 });
    assert.ok(Math.abs(shortestHeadingDelta(90, turnRight.heading)) < 1);
    const turnLeft = sTracker.ingestUpdate({ position: movePointByBearing(t2, 0, 40), heading: 360, speed: 7, nowMs: 7000, epochMs: 7000 });
    assert.ok(Math.abs(shortestHeadingDelta(0, turnLeft.heading)) < 1);

    // Scenario 8 & 0°/360° wraparound: 350° -> 10° shortest delta is +20° (not -340°)
    assert.equal(shortestHeadingDelta(350, 10), 20);
    assert.equal(shortestHeadingDelta(10, 350), -20);
    const wrapped = smoothHeading(350, 10, 0.5);
    assert.equal(wrapped, 0);
});

test("Scenarios 9–14: Stop-and-Go, High-Speed, Reverse Movement, Stationary Jitter, Single Noisy Spike & Missing Heading", () => {
    const p0 = { lat: 23.8315, lng: 91.2868 };
    const p1 = movePointByBearing(p0, 45, 200);
    const p2 = movePointByBearing(p1, 45, 200);
    const tracker = new SimulatedVehicleTracker([p0, p1, p2], "auto");

    // Scenario 14: Missing heading in GPS payload -> derived accurately from movement/road
    tracker.ingestUpdate({ position: p0, heading: null, speed: 10, nowMs: 1000, epochMs: 1000 });
    const m1 = tracker.ingestUpdate({
        position: movePointByBearing(p0, 45, 40),
        heading: null,
        speed: 10,
        nowMs: 4000,
        epochMs: 4000
    });
    assert.ok(Math.abs(shortestHeadingDelta(45, m1.heading)) < 1);

    // Scenario 9 & 12: Stop-and-go + stationary GPS jitter (< 2.5m with wild compass noise)
    const stoppedJitter = tracker.ingestUpdate({
        position: movePointByBearing(m1.position, 210, 1.2),
        heading: 275, // Compass noise while stopped
        speed: 0.0,
        nowMs: 7000,
        epochMs: 7000
    });
    assert.ok(Math.abs(shortestHeadingDelta(45, stoppedJitter.heading)) < 1, "Stationary heading must remain locked at 45°");
    assert.equal(distanceMeters(m1.position, stoppedJitter.position), 0, "Stationary position within noise floor must not drift");

    // Scenario 13: Single noisy GPS jump (500m away in 2 seconds -> 250 m/s > 45 m/s)
    const noisySpike = tracker.ingestUpdate({
        position: movePointByBearing(m1.position, 120, 500),
        heading: 120,
        speed: 10,
        nowMs: 9000,
        epochMs: 9000
    });
    assert.equal(noisySpike.outlierHeld, true, "Single noisy GPS teleport must be held by outlier filter");
    assert.equal(distanceMeters(m1.position, noisySpike.position), 0);

    // Scenario 11: Reverse / backward movement along the road (225° on a 45° road)
    const revPos = movePointByBearing(m1.position, 225, 20);
    const revRes = tracker.ingestUpdate({
        position: revPos,
        heading: 225,
        speed: 3.5,
        nowMs: 13000,
        epochMs: 13000
    });
    assert.equal(revRes.remainingPolyline.length, 0, "Green route line must hide when vehicle is reversing");
});

test("Scenarios 15–20: Delayed, Out-of-Order, Duplicate, Reconnection Burst & Lifecycle Resume", () => {
    const p0 = { lat: 23.8315, lng: 91.2868 };
    const p1 = movePointByBearing(p0, 60, 300);
    const tracker = new SimulatedVehicleTracker([p0, p1], "auto");

    tracker.ingestUpdate({ position: p0, speed: 10, nowMs: 1000, epochMs: 10000 });
    const posT2 = movePointByBearing(p0, 60, 80);
    const rNewer = tracker.ingestUpdate({ position: posT2, speed: 10, nowMs: 5000, epochMs: 18000 });
    assert.equal(rNewer.accepted, true);

    // Scenario 16: Out-of-order older packet (epochMs = 14000 < 18000)
    const posT1 = movePointByBearing(p0, 60, 40);
    const rStale = tracker.ingestUpdate({ position: posT1, speed: 10, nowMs: 6000, epochMs: 14000 });
    assert.equal(rStale.accepted, false);
    assert.equal(rStale.reason, "stale_timestamp");
    assert.equal(distanceMeters(tracker.markerPosition, rNewer.position), 0, "Marker must never move backward on stale packet");

    // Scenario 17: Duplicate packet (same epochMs & position)
    const rDup = tracker.ingestUpdate({ position: posT2, speed: 10, nowMs: 6500, epochMs: 18000 });
    assert.equal(rDup.accepted, true);
    assert.equal(distanceMeters(rDup.position, rNewer.position), 0);

    // Scenario 18–20: Reconnection burst / app resume after 10s gap (120m progress over 10s = 12 m/s <= 45 m/s)
    const posAfterResume = movePointByBearing(p0, 60, 200);
    const rResume = tracker.ingestUpdate({ position: posAfterResume, speed: 12, nowMs: 16500, epochMs: 28000 });
    assert.equal(rResume.accepted, true);
    assert.equal(rResume.outlierHeld, false);
    assert.ok(distanceMeters(rResume.position, posAfterResume) < 2);
});

test("Scenarios 21–26: Approaching Destination, Stopping at Destination, Passing Destination (50m–1km), Additional Turns & Noisy Spike Near Destination", () => {
    const p0 = { lat: 23.8315, lng: 91.2868 };
    const p1 = movePointByBearing(p0, 30, 100);
    const p2 = movePointByBearing(p1, 30, 100);
    const p3 = movePointByBearing(p2, 30, 100);
    const p4 = movePointByBearing(p3, 30, 100);
    const dest = movePointByBearing(p4, 30, 100);
    const route = [p0, p1, p2, p3, p4, dest];
    const tracker = new SimulatedVehicleTracker(route, "auto");

    // Start at p0
    tracker.ingestUpdate({ position: p0, speed: 10, nowMs: 1000, epochMs: 1000 });

    // Scenario 26: Single noisy GPS spike beyond destination while vehicle is still on segment 0 (near p0)
    // Because lastIndex is 0 (not in nearEndZone), matchPositionToRoute must NOT falsely trigger isPastDestination!
    const earlyMatch = matchPositionToRoute(movePointByBearing(dest, 30, 40), route, 0, 30, 0.2);
    assert.ok(!earlyMatch || !earlyMatch.isPastDestination, "Early segment must never falsely latch isPastDestination on noisy jump");

    // Scenario 21: Progressively approach destination along segments 1 -> 2 -> 3 -> 4
    let prevRemainingLen = Infinity;
    for (let i = 1; i <= 4; i++) {
        const res = tracker.ingestUpdate({
            position: route[i],
            speed: 10,
            nowMs: 1000 + i * 3000,
            epochMs: 1000 + i * 3000
        });
        assert.equal(res.hasPassedDestination, false);
        assert.ok(res.remainingPolyline.length >= 2, "Green remaining route line must stay visible before destination");
        assert.equal(distanceMeters(res.remainingPolyline[0], res.position), 0, "Green line start must exactly match vehicle marker position");
        assert.ok(res.remainingPolyline.length <= prevRemainingLen);
        prevRemainingLen = res.remainingPolyline.length;
    }

    // Scenario 22: Reach exact destination
    const atDest = tracker.ingestUpdate({
        position: dest,
        speed: 4,
        nowMs: 16000,
        epochMs: 16000
    });
    assert.ok(distanceMeters(atDest.position, dest) < 1);

    // Scenario 23: Pass destination by 50m, 200m, 500m, and 1000m at realistic driving speed
    for (const [idx, overMeters] of [50, 200, 500, 1000].entries()) {
        const overPos = movePointByBearing(dest, 30, overMeters);
        const resOver = tracker.ingestUpdate({
            position: overPos,
            heading: 30,
            speed: 12,
            nowMs: 20000 + idx * 20000,
            epochMs: 20000 + idx * 20000
        });
        assert.equal(resOver.hasPassedDestination, true, `Passed destination must be true at +${overMeters}m`);
        assert.equal(resOver.remainingPolyline.length, 0, `Green line must remain hidden at +${overMeters}m past destination`);
        assert.ok(distanceMeters(resOver.position, overPos) < 1, `Vehicle marker must continue moving to real position at +${overMeters}m`);
    }

    // Scenario 24: Make a 90° turn onto a new road after passing destination (heading 120°)
    const afterTurnPos = movePointByBearing(movePointByBearing(dest, 30, 1000), 120, 60);
    const resTurn = tracker.ingestUpdate({
        position: afterTurnPos,
        heading: 120,
        speed: 8,
        nowMs: 90000,
        epochMs: 90000
    });
    assert.equal(resTurn.hasPassedDestination, true);
    assert.equal(resTurn.remainingPolyline.length, 0);
    assert.ok(Math.abs(shortestHeadingDelta(120, resTurn.heading)) < 1, "Vehicle must rotate to new road heading (120°) after destination");
});
