"""Track pools management, validate-on-read, spatial queries, and sweeper invariants."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from firebase_admin import firestore as fb_firestore

from .dispatch_config import (
    HEARTBEAT_FRESHNESS_SECONDS,
    POOL_ENTRY_TTL_SECONDS,
    RADIUS_MAX_KM,
    SCHEDULED_ACTIVATION_LEAD_MINUTES,
    TIER_DWELL_SECONDS,
    TOTAL_SEARCH_TIMEOUT_SECONDS,
    get_radius_for_tier,
    get_tier_sequence,
)
from .spatial_index import (
    compute_zone_id,
    get_overlapping_cells_for_circle,
    lat_lng_to_cell_id,
)

logger = logging.getLogger("liphtup.dispatch.pools")


def _to_utc(dt_val: Any) -> Optional[datetime]:
    if not dt_val:
        return None
    if isinstance(dt_val, datetime):
        return dt_val.astimezone(timezone.utc) if dt_val.tzinfo else dt_val.replace(tzinfo=timezone.utc)
    if hasattr(dt_val, "timestamp"):
        return datetime.fromtimestamp(dt_val.timestamp(), tz=timezone.utc)
    return None


class DispatchPools:
    def __init__(self, db):
        self.db = db
        self.driver_pool_ref = db.collection("dispatchDriverPool")
        self.passenger_pool_ref = db.collection("dispatchPassengerPool")

    # -----------------------------------------------------------------------
    # Driver Pool Operations
    # -----------------------------------------------------------------------
    def upsert_driver(
        self,
        driver_id: str,
        lat: float,
        lng: float,
        vehicle_type: str,
        state: str = "available",
        available_since: Optional[datetime] = None,
        declines_recent: int = 0,
        scheduled_commitment: Optional[dict[str, Any]] = None,
    ) -> None:
        now = datetime.now(timezone.utc)
        cell_id = lat_lng_to_cell_id(lat, lng)
        doc_ref = self.driver_pool_ref.document(driver_id)

        @fb_firestore.transactional
        def _upsert_tx(tx):
            snap = doc_ref.get(transaction=tx)
            curr_data = snap.to_dict() or {}
            curr_version = int(curr_data.get("version", 0))

            # Preserve original available_since if already set and still available
            orig_avail = curr_data.get("available_since")
            if state == "available":
                if orig_avail:
                    avail_dt = _to_utc(orig_avail)
                else:
                    avail_dt = available_since or now
            else:
                avail_dt = None

            doc_data = {
                "driver_id": driver_id,
                "location": {"lat": lat, "lng": lng},
                "cell_id": cell_id,
                "vehicle_type": vehicle_type.lower(),
                "last_heartbeat": now,
                "available_since": avail_dt,
                "state": state,
                "active_offer": curr_data.get("active_offer") if state == "offered" else None,
                "declines_recent": declines_recent if declines_recent > 0 else int(curr_data.get("declines_recent", 0)),
                "last_cancel_at": curr_data.get("last_cancel_at"),
                "scheduled_commitment": scheduled_commitment or curr_data.get("scheduled_commitment"),
                "version": curr_version + 1,
                "updated_at": fb_firestore.SERVER_TIMESTAMP,
            }
            tx.set(doc_ref, doc_data, merge=True)

        transaction = self.db.transaction()
        _upsert_tx(transaction)

    def remove_driver(self, driver_id: str, reason: str = "explicit_removal") -> None:
        try:
            self.driver_pool_ref.document(driver_id).delete()
            logger.info("Driver %s removed from pool: %s", driver_id, reason)
        except Exception:
            pass

    def get_candidate_drivers(self, candidate_cells: set[str]) -> list[dict[str, Any]]:
        """Fetch available drivers belonging to the candidate spatial cells."""
        if not candidate_cells:
            return []

        now = datetime.now(timezone.utc)
        freshness_cutoff = now - timedelta(seconds=HEARTBEAT_FRESHNESS_SECONDS)

        # Query drivers with state == "available"
        # If cells count is reasonable, query by cells; Firestore allows 'in' queries up to 30 items
        cell_list = list(candidate_cells)
        available_drivers: list[dict[str, Any]] = []

        if len(cell_list) <= 30:
            query = self.driver_pool_ref.where("state", "==", "available").where("cell_id", "in", cell_list)
            snaps = list(query.stream())
        else:
            # Query all available drivers and filter by candidate cells in memory
            query = self.driver_pool_ref.where("state", "==", "available")
            snaps = [s for s in query.stream() if (s.to_dict() or {}).get("cell_id") in candidate_cells]

        for snap in snaps:
            data = snap.to_dict() or {}
            driver_id = str(data.get("driver_id") or snap.id)
            last_hb = _to_utc(data.get("last_heartbeat"))

            if not last_hb or last_hb < freshness_cutoff:
                # Driver heartbeat is stale; lazily evict
                self.remove_driver(driver_id, reason="heartbeat_stale_on_read")
                continue

            # Check if driver is committed to a scheduled ride soon
            sched = data.get("scheduled_commitment")
            if sched:
                act_time = _to_utc(sched.get("activates_at"))
                if act_time and (act_time - now) < timedelta(minutes=SCHEDULED_ACTIVATION_LEAD_MINUTES + 15):
                    # Blocked by scheduled ride
                    continue

            avail_since = _to_utc(data.get("available_since")) or last_hb
            idle_min = max(0.0, (now - avail_since).total_seconds() / 60.0)

            available_drivers.append({
                **data,
                "driver_id": driver_id,
                "idle_minutes": idle_min,
            })

        return available_drivers

    # -----------------------------------------------------------------------
    # Passenger Pool Operations
    # -----------------------------------------------------------------------
    def upsert_passenger(
        self,
        request_id: str,
        passenger_id: str,
        pickup: dict[str, Any],
        drop: dict[str, Any],
        vehicle_type: str,
        mode: str = "searching",
        scheduled_for: Optional[datetime] = None,
        fare: float = 0.0,
        fare_estimate: Optional[dict[str, Any]] = None,
        was_driver_cancelled: bool = False,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        tier = 0
        current_radius = get_radius_for_tier(tier)
        zone_id = compute_zone_id(pickup["lat"], pickup["lng"], tier)
        next_tier_at = now + timedelta(seconds=TIER_DWELL_SECONDS)
        search_expires_at = now + timedelta(seconds=TOTAL_SEARCH_TIMEOUT_SECONDS)

        doc_ref = self.passenger_pool_ref.document(request_id)
        transaction = self.db.transaction()

        @fb_firestore.transactional
        def _upsert_tx(tx):
            snap = doc_ref.get(transaction=tx)
            curr = snap.to_dict() or {}
            curr_version = int(curr.get("version", 0))

            doc_data = {
                "request_id": request_id,
                "passenger_id": passenger_id,
                "pickup": pickup,
                "drop": drop,
                "vehicle_type": vehicle_type.lower(),
                "mode": mode,
                "status": "searching" if mode == "searching" else mode,
                "waiting_since": curr.get("waiting_since") or now,
                "tier": curr.get("tier", tier),
                "current_radius_km": curr.get("current_radius_km", current_radius),
                "zone_id": zone_id,
                "next_tier_at": next_tier_at,
                "search_expires_at": search_expires_at,
                "excluded_driver_ids": curr.get("excluded_driver_ids", []),
                "active_offer": curr.get("active_offer") if curr.get("status") == "offered" else None,
                "scheduled_for": scheduled_for,
                "fare": fare,
                "fare_estimate": fare_estimate or {},
                "was_driver_cancelled": was_driver_cancelled or bool(curr.get("was_driver_cancelled", False)),
                "version": curr_version + 1,
                "updated_at": fb_firestore.SERVER_TIMESTAMP,
            }
            tx.set(doc_ref, doc_data, merge=True)
            return doc_data

        return _upsert_tx(transaction)

    def remove_passenger(self, request_id: str, reason: str = "explicit_removal") -> None:
        try:
            self.passenger_pool_ref.document(request_id).delete()
            logger.info("Passenger %s removed from pool: %s", request_id, reason)
        except Exception:
            pass

    def get_active_searching_passengers(self) -> list[dict[str, Any]]:
        """Fetch all passengers in 'searching' mode, advancing tiers or expiring as needed."""
        now = datetime.now(timezone.utc)
        query = self.passenger_pool_ref.where("status", "in", ["searching", "offered"])
        snaps = list(query.stream())

        active: list[dict[str, Any]] = []
        for snap in snaps:
            data = snap.to_dict() or {}
            req_id = str(data.get("request_id") or snap.id)
            status = data.get("status")

            # Check total search timeout
            exp_at = _to_utc(data.get("search_expires_at"))
            if exp_at and now > exp_at:
                snap.reference.update({
                    "status": "no_drivers_found",
                    "updated_at": fb_firestore.SERVER_TIMESTAMP,
                })
                logger.info("Passenger %s search expired -> status set to no_drivers_found", req_id)
                continue

            # If holding an active offer, verify offer expiry
            if status == "offered":
                offer = data.get("active_offer") or {}
                offer_exp = _to_utc(offer.get("expires_at"))
                if offer_exp and now > offer_exp:
                    # Offer expired: return passenger to searching and exclude driver
                    offered_driver = offer.get("driver_id")
                    excl = list(data.get("excluded_driver_ids") or [])
                    if offered_driver and offered_driver not in excl:
                        excl.append(offered_driver)

                    snap.reference.update({
                        "status": "searching",
                        "active_offer": None,
                        "excluded_driver_ids": excl,
                        "updated_at": fb_firestore.SERVER_TIMESTAMP,
                    })
                    data["status"] = "searching"
                    data["active_offer"] = None
                    data["excluded_driver_ids"] = excl

                    # Also release the offered driver if still pointing to this offer
                    if offered_driver:
                        d_ref = self.driver_pool_ref.document(offered_driver)
                        d_snap = d_ref.get()
                        if d_snap.exists:
                            d_data = d_snap.to_dict() or {}
                            d_off = d_data.get("active_offer") or {}
                            if d_off.get("request_id") == req_id:
                                d_ref.update({
                                    "state": "available",
                                    "active_offer": None,
                                    "declines_recent": int(d_data.get("declines_recent", 0)) + 1,
                                    "updated_at": fb_firestore.SERVER_TIMESTAMP,
                                })
                else:
                    # Live offer is still valid; passenger is waiting for driver response
                    continue

            # Check tier dwell progression
            curr_tier = int(data.get("tier", 0))
            tier_seq = get_tier_sequence()
            next_tier_at = _to_utc(data.get("next_tier_at"))

            if next_tier_at and now >= next_tier_at and curr_tier < len(tier_seq) - 1:
                new_tier = curr_tier + 1
                new_radius = get_radius_for_tier(new_tier)
                new_zone_id = compute_zone_id(data["pickup"]["lat"], data["pickup"]["lng"], new_tier)
                snap.reference.update({
                    "tier": new_tier,
                    "current_radius_km": new_radius,
                    "zone_id": new_zone_id,
                    "next_tier_at": now + timedelta(seconds=TIER_DWELL_SECONDS),
                    "updated_at": fb_firestore.SERVER_TIMESTAMP,
                })
                data["tier"] = new_tier
                data["current_radius_km"] = new_radius
                data["zone_id"] = new_zone_id

            waiting_since = _to_utc(data.get("waiting_since")) or now
            wait_min = max(0.0, (now - waiting_since).total_seconds() / 60.0)

            active.append({
                **data,
                "request_id": req_id,
                "wait_minutes": wait_min,
            })

        return active

    # -----------------------------------------------------------------------
    # Sweeper & Two-Way Reconciliation
    # -----------------------------------------------------------------------
    def run_sweeper(self) -> dict[str, int]:
        """Reconciles pools in both directions against driverPresence, users, and rides."""
        metrics = {
            "driver_evictions_heartbeat": 0,
            "driver_evictions_busy": 0,
            "driver_seeds_reconciled": 0,
            "passenger_evictions_expired": 0,
            "passenger_evictions_resolved": 0,
            "scheduled_activations": 0,
        }
        now = datetime.now(timezone.utc)
        fresh_cutoff = now - timedelta(seconds=HEARTBEAT_FRESHNESS_SECONDS)

        # 1. Driver Invariants & Evictions
        existing_pool_drivers: set[str] = set()
        for dsnap in self.driver_pool_ref.stream():
            ddata = dsnap.to_dict() or {}
            driver_id = dsnap.id
            existing_pool_drivers.add(driver_id)
            last_hb = _to_utc(ddata.get("last_heartbeat"))

            # Invariant: No entry past freshness threshold without fresh heartbeat
            if not last_hb or last_hb < fresh_cutoff:
                self.remove_driver(driver_id, reason="sweeper_heartbeat_expired")
                metrics["driver_evictions_heartbeat"] += 1
                continue

            # Invariant: No driver in available pool while on active ride
            active_rides = list(
                self.db.collection("rides")
                .where("driver_id", "==", driver_id)
                .where("status", "in", ["accepted", "arrived", "started", "en_route"])
                .limit(1)
                .stream()
            )
            if active_rides and ddata.get("state") == "available":
                dsnap.reference.update({"state": "busy", "updated_at": fb_firestore.SERVER_TIMESTAMP})
                metrics["driver_evictions_busy"] += 1

        # 2. Two-Way Reconciliation: Seed missing online drivers from driverPresence / users
        try:
            presence_query = self.db.collection("driverPresence").stream()
            for psnap in presence_query:
                pdata = psnap.to_dict() or {}
                driver_id = psnap.id
                if driver_id in existing_pool_drivers:
                    continue

                p_hb = _to_utc(pdata.get("updatedAt") or pdata.get("last_heartbeat"))
                if p_hb and p_hb >= fresh_cutoff and pdata.get("availability") == "available":
                    loc = pdata.get("location") or {}
                    lat = float(loc.get("lat") or 0.0)
                    lng = float(loc.get("lng") or 0.0)
                    if lat != 0.0 and lng != 0.0:
                        vtype = str(pdata.get("vehicleType") or "auto")
                        self.upsert_driver(
                            driver_id=driver_id,
                            lat=lat,
                            lng=lng,
                            vehicle_type=vtype,
                            state="available",
                        )
                        metrics["driver_seeds_reconciled"] += 1
        except Exception as exc:
            logger.debug("Two-way driver seeding pass handled: %s", exc)

        # 3. Passenger Invariants & Mode-Specific TTLs
        for psnap in self.passenger_pool_ref.stream():
            pdata = psnap.to_dict() or {}
            req_id = psnap.id
            mode = pdata.get("mode", "on_demand")
            status = pdata.get("status")
            created_at = _to_utc(pdata.get("created_at") or pdata.get("waiting_since")) or now

            # Invariant: No pool passenger with an active or completed ride document
            p_user_id = pdata.get("passenger_id")
            if p_user_id:
                resolved_rides = list(
                    self.db.collection("rides")
                    .where("passenger_id", "==", p_user_id)
                    .where("status", "in", ["accepted", "arrived", "started", "en_route", "completed"])
                    .limit(1)
                    .stream()
                )
                if resolved_rides and status in ["searching", "offered", "no_drivers_found"]:
                    self.remove_passenger(req_id, reason="sweeper_ride_already_active")
                    metrics["passenger_evictions_resolved"] += 1
                    continue

            # Mode-Specific TTL Eviction Policies
            if mode == "scheduled":
                # Scheduled rides: valid until scheduled_for + 1 hour
                sched_dt = _to_utc(pdata.get("scheduled_for"))
                if sched_dt:
                    if now >= (sched_dt - timedelta(minutes=SCHEDULED_ACTIVATION_LEAD_MINUTES)) and status != "searching":
                        psnap.reference.update({
                            "mode": "searching",
                            "status": "searching",
                            "waiting_since": now,
                            "tier": 0,
                            "current_radius_km": get_radius_for_tier(0),
                            "next_tier_at": now + timedelta(seconds=TIER_DWELL_SECONDS),
                            "search_expires_at": max(now + timedelta(seconds=TOTAL_SEARCH_TIMEOUT_SECONDS), sched_dt + timedelta(hours=1)),
                            "updated_at": fb_firestore.SERVER_TIMESTAMP,
                        })
                        metrics["scheduled_activations"] += 1
                    elif now > (sched_dt + timedelta(hours=1)):
                        self.remove_passenger(req_id, reason="scheduled_ride_expired")
                        metrics["passenger_evictions_expired"] += 1

            elif mode == "notify_me":
                # Notify-Me requests: valid for 2 hours (7200s)
                if (now - created_at).total_seconds() > 7200.0:
                    self.remove_passenger(req_id, reason="notify_me_ttl_expired")
                    metrics["passenger_evictions_expired"] += 1

            elif status == "no_drivers_found":
                # If passenger does nothing after search timeout, evict after 5 minutes
                if (now - created_at).total_seconds() > (TOTAL_SEARCH_TIMEOUT_SECONDS + 300.0):
                    self.remove_passenger(req_id, reason="no_drivers_choice_timeout")
                    metrics["passenger_evictions_expired"] += 1

            else:
                # Standard on-demand searching: TTL is 10 minutes
                if (now - created_at).total_seconds() > POOL_ENTRY_TTL_SECONDS:
                    self.remove_passenger(req_id, reason="on_demand_ttl_expired")
                    metrics["passenger_evictions_expired"] += 1

        return metrics
