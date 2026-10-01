"""Authoritative Server-Side Dispatch Engine and Tick Orchestration."""
from __future__ import annotations

import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
import uuid

from firebase_admin import firestore as fb_firestore

from .dispatch_config import DispatchConfig, load_dispatch_config
from .eta import compute_cheap_eta_minutes
from .firebase import get_admin_app
from .geo import get_all_zone_ids, get_zone_ring, point_to_zone
from .matching import compute_pair_cost, solve_batch_matching

_LAST_OPPORTUNISTIC_TICK = 0.0
_OPPORTUNISTIC_THROTTLE_SECONDS = 5.0


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp_to_dt(val: Any) -> Optional[datetime]:
    if not val:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    if hasattr(val, "timestamp"):
        return datetime.fromtimestamp(val.timestamp(), tz=timezone.utc)
    if isinstance(val, (int, float)):
        return datetime.fromtimestamp(val, tz=timezone.utc)
    if isinstance(val, str):
        try:
            return datetime.fromisoformat(val.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


async def run_dispatch_tick(
    caller_ride_id: Optional[str] = None,
    force: bool = False,
) -> dict[str, Any]:
    """Execute a single authoritative, idempotent, lease-protected dispatch tick."""
    cfg = load_dispatch_config()
    db = fb_firestore.client(get_admin_app())
    now = _now_utc()
    now_ts = now.timestamp()

    # 1. Acquire Distributed Lease (2s TTL)
    lease_ref = db.collection("dispatch").document("lease")
    lease_holder = str(uuid.uuid4())
    lease_acquired = False

    try:
        @fb_firestore.transactional
        def acquire_lease_tx(tx):
            snap = lease_ref.get(transaction=tx)
            if snap.exists:
                data = snap.to_dict() or {}
                expires_at = _timestamp_to_dt(data.get("expiresAt"))
                if expires_at and expires_at > now:
                    return False
            tx.set(lease_ref, {
                "holder": lease_holder,
                "acquiredAt": fb_firestore.SERVER_TIMESTAMP,
                "expiresAt": now + timedelta(seconds=2),
            })
            return True

        lease_acquired = acquire_lease_tx(db.transaction())
    except Exception:
        lease_acquired = False

    if not lease_acquired and not force:
        return {"ok": False, "reason": "lease_locked"}

    try:
        # 2. Query Pending Rides
        rides_query = db.collection("rides").where("status", "==", "pending")
        if caller_ride_id:
            rides_query = rides_query.where("__name__", "==", caller_ride_id)
        
        pending_snaps = list(rides_query.stream())
        if not pending_snaps:
            return {"ok": True, "matched": 0, "pending_count": 0}

        pending_rides: list[dict[str, Any]] = []
        zones_to_query: set[str] = set()

        for snap in pending_snaps:
            r = snap.to_dict() or {}
            r["id"] = snap.id

            # Filter: batch hold
            not_before = _timestamp_to_dt(r.get("dispatchNotBefore"))
            if not_before and not_before > now:
                continue

            # Expiration check (5 min TTL)
            created_at = _timestamp_to_dt(r.get("createdAt"))
            if created_at and (now_ts - created_at.timestamp()) > 300:
                snap.reference.update({"status": "timeout", "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                continue

            # Check if active offer is still live
            curr_offer = r.get("currentOffer") or {}
            offer_expires = _timestamp_to_dt(curr_offer.get("expiresAt"))
            if curr_offer.get("driverId") and offer_expires and offer_expires > now:
                # Offer is currently ticking for this ride; skip matching until it expires or resolves
                continue

            # Determine search ring and zones needed
            p_lat = float(r.get("pickup_lat", 0.0))
            p_lng = float(r.get("pickup_lng", 0.0))
            home_zone = point_to_zone(p_lat, p_lng)
            
            search_ring = int(r.get("searchRing") or 1)
            search_started_at = _timestamp_to_dt(r.get("searchStartedAt")) or created_at or now

            # Ring expansion check: if expand_after_seconds elapsed
            if (now - search_started_at).total_seconds() >= (search_ring * cfg.expand_after_seconds):
                search_ring = min(10, search_ring + 1)
                snap.reference.update({"searchRing": search_ring, "updatedAt": fb_firestore.SERVER_TIMESTAMP})

            r["home_zone"] = home_zone
            r["search_ring"] = search_ring
            r["waiting_minutes"] = max(0.0, (now_ts - (created_at.timestamp() if created_at else now_ts)) / 60.0)

            active_zones = get_zone_ring(home_zone, ring_level=search_ring)
            r["active_zones"] = active_zones
            zones_to_query.update(active_zones)
            pending_rides.append(r)

        if not pending_rides:
            return {"ok": True, "matched": 0, "pending_count": 0}

        # 3. Query Eligible Drivers across LLA Zones (all 12 zones)
        all_zones_list = get_all_zone_ids()
        eligible_drivers: dict[str, dict[str, Any]] = {}

        if all_zones_list:
            driver_query = (
                db.collection("driverPresence")
                .where("driverAvailability", "in", ["searching", "online"])
                .where("zoneId", "in", all_zones_list)
            )
            for d_snap in driver_query.stream():
                d = d_snap.to_dict() or {}
                d_id = str(d.get("uid") or d_snap.id)
                
                # Verify approval and desired availability
                v_status = d.get("verificationStatus")
                if v_status != "approved" and not d.get("is_verified") and not d.get("isApproved"):
                    continue
                if str(d.get("desiredAvailability") or "").lower() == "offline":
                    continue

                # Check dispatch lock
                lock = d.get("dispatchLock") or {}
                lock_expires = _timestamp_to_dt(lock.get("expiresAt"))
                if lock.get("rideId") and lock_expires and lock_expires > now:
                    continue

                # Check location freshness
                last_loc_dt = _timestamp_to_dt(d.get("lastLocationAt") or d.get("lastSeenAt"))
                age_sec = (now - last_loc_dt).total_seconds() if last_loc_dt else 999.0
                
                push_valid = False
                notif_until = _timestamp_to_dt(d.get("notificationEligibleUntil"))
                if notif_until and notif_until > now:
                    push_valid = True

                # Hard cutoff
                if age_sec > cfg.max_location_age_seconds_with_push:
                    continue
                if age_sec > cfg.location_freshness_seconds and not push_valid:
                    continue

                loc = d.get("driverLocation") or {}
                if not isinstance(loc, dict) or "lat" not in loc or "lng" not in loc:
                    continue

                d["age_sec"] = age_sec
                d["push_valid"] = push_valid
                d["lat"] = float(loc["lat"])
                d["lng"] = float(loc["lng"])
                eligible_drivers[d_id] = d

        # 4 & 5. Multi-pass solve within single tick (up to 3 passes)
        solver_start = time.time()
        proposals: dict[str, Optional[str]] = {}
        active_rides = list(pending_rides)
        free_drivers = dict(eligible_drivers)

        for pass_idx in range(1, 4):
            if not active_rides or not free_drivers:
                break

            pass_candidate_map: dict[str, list[tuple[str, float]]] = {}
            for r in active_rides:
                r_id = r["id"]
                p_lat = float(r["pickup_lat"])
                p_lng = float(r["pickup_lng"])
                v_type = str(r.get("vehicle_type") or "").lower()
                excluded = set(r.get("excludedDriverIds") or []) | set(r.get("rejected_driver_ids") or [])

                if pass_idx == 1:
                    eff_ring = r["search_ring"]
                    eff_max_eta = min(cfg.max_pickup_eta_minutes, cfg.hard_max_pickup_eta_minutes)
                elif pass_idx == 2:
                    eff_ring = min(10, r["search_ring"] + 1)
                    eff_max_eta = min(cfg.max_pickup_eta_minutes + 10.0, cfg.hard_max_pickup_eta_minutes)
                else:
                    eff_ring = 10
                    eff_max_eta = cfg.hard_max_pickup_eta_minutes

                eff_zones = get_zone_ring(r["home_zone"], ring_level=eff_ring)

                ride_cands: list[tuple[str, float]] = []
                for d_id, d in free_drivers.items():
                    if d_id in excluded:
                        continue
                    if str(d.get("vehicle_type") or "").lower() != v_type:
                        continue
                    if pass_idx < 3 and d.get("zoneId") not in eff_zones:
                        continue

                    cheap_eta = compute_cheap_eta_minutes(
                        d["lat"], d["lng"], p_lat, p_lng,
                        driver_location_age_sec=d["age_sec"],
                        notification_eligible_until_valid=d["push_valid"],
                        config=cfg,
                    )

                    if cheap_eta > eff_max_eta:
                        continue

                    cost = compute_pair_cost(
                        cheap_eta,
                        waiting_minutes=r["waiting_minutes"],
                        alpha=cfg.cost_exponent_alpha,
                        gamma=cfg.aging_weight_gamma,
                    )
                    ride_cands.append((d_id, cost))

                ride_cands.sort(key=lambda item: item[1])
                pass_candidate_map[r_id] = ride_cands[:cfg.candidates_k]

            pass_proposals = solve_batch_matching(
                active_rides,
                pass_candidate_map,
                max_exact_size=cfg.max_exact_size,
                time_budget_ms=cfg.exact_solver_timeout_ms,
            )

            new_matched = 0
            remaining_active = []
            for r in active_rides:
                r_id = r["id"]
                d_id = pass_proposals.get(r_id)
                if d_id and d_id in free_drivers:
                    proposals[r_id] = d_id
                    free_drivers.pop(d_id, None)
                    new_matched += 1
                else:
                    remaining_active.append(r)

            active_rides = remaining_active
            if new_matched == 0:
                break

        for r in pending_rides:
            if r["id"] not in proposals:
                proposals[r["id"]] = None

        solver_time_ms = (time.time() - solver_start) * 1000.0

        # 6. Apply Proposals Atomically
        matched_count = 0
        offer_duration = timedelta(seconds=cfg.offer_timeout_seconds)

        for r_id, d_id in proposals.items():
            if not d_id:
                continue

            ride_ref = db.collection("rides").document(r_id)
            driver_ref = db.collection("driverPresence").document(d_id)

            try:
                def lock_and_offer_tx(tx):
                    r_snap = ride_ref.get(transaction=tx)
                    d_snap = driver_ref.get(transaction=tx)
                    if not r_snap.exists or not d_snap.exists:
                        return False

                    r_data = r_snap.to_dict() or {}
                    d_data = d_snap.to_dict() or {}

                    # Ride status check
                    if r_data.get("status") != "pending" or r_data.get("driver_id"):
                        return False
                    cur_off = r_data.get("currentOffer") or {}
                    off_exp = _timestamp_to_dt(cur_off.get("expiresAt"))
                    if cur_off.get("driverId") and off_exp and off_exp > now:
                        return False

                    # Driver lock check
                    d_lock = d_data.get("dispatchLock") or {}
                    d_exp = _timestamp_to_dt(d_lock.get("expiresAt"))
                    if d_lock.get("rideId") and d_exp and d_exp > now:
                        return False

                    offer_expires_at = now + offer_duration
                    tx.update(ride_ref, {
                        "eligible_driver_ids": [d_id],
                        "currentOffer": {
                            "driverId": d_id,
                            "createdAt": now,
                            "expiresAt": offer_expires_at,
                        },
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    })
                    tx.update(driver_ref, {
                        "dispatchLock": {
                            "rideId": r_id,
                            "expiresAt": offer_expires_at,
                        },
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                    })
                    return True

                tx = db.transaction()
                if callable(getattr(fb_firestore, "transactional", None)):
                    try:
                        applied = fb_firestore.transactional(lock_and_offer_tx)(tx)
                    except Exception:
                        applied = lock_and_offer_tx(tx)
                else:
                    applied = lock_and_offer_tx(tx)

                if applied:
                    matched_count += 1
            except Exception:
                pass

        # Record operational metrics
        try:
            db.collection("dispatchMetrics").add({
                "timestamp": fb_firestore.SERVER_TIMESTAMP,
                "pendingCount": len(pending_rides),
                "matchedCount": matched_count,
                "solverTimeMs": solver_time_ms,
                "algorithm": "hex_batch",
            })
        except Exception:
            pass

        return {"ok": True, "matched": matched_count, "pending_count": len(pending_rides)}

    finally:
        # Always release lease
        try:
            lease_ref.delete()
        except Exception:
            pass


async def trigger_opportunistic_tick(caller_ride_id: Optional[str] = None):
    """Trigger a throttled non-blocking opportunistic tick."""
    global _LAST_OPPORTUNISTIC_TICK
    now = time.time()
    if (now - _LAST_OPPORTUNISTIC_TICK) < _OPPORTUNISTIC_THROTTLE_SECONDS:
        return
    _LAST_OPPORTUNISTIC_TICK = now
    try:
        await run_dispatch_tick(caller_ride_id=caller_ride_id)
    except Exception:
        pass
