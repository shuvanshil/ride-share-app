"""End-to-end serverless matching engine orchestrator."""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging

from .config import get_env
from .dispatch_config import (
    MAX_DIRTY_PASS_ITERATIONS,
    OFFER_TIMEOUT_SECONDS,
)
from .dispatch_lease import DispatchLease
from .dispatch_pools import DispatchPools
from .matching_solver import build_candidate_graph_and_solve
from .spatial_index import get_overlapping_cells_for_circle

logger = logging.getLogger("liphtup.dispatch.engine")
APP_BASE_URL = (get_env("PUBLIC_APP_URL") or get_env("APP_BASE_URL") or "https://liphtup.in").rstrip("/")


def _send_driver_offer_notification(
    db,
    driver_id: str,
    offer_id: str,
    request_id: str,
    pickup_name: str,
    drop_name: str,
    fare: float,
) -> None:
    try:
        token_doc = db.collection("driverPushTokens").document(driver_id).get()
        if not token_doc.exists:
            return
        token_data = token_doc.to_dict() or {}
        tokens = token_data.get("tokens") or []
        if not tokens and token_data.get("token"):
            tokens = [token_data["token"]]
        if not tokens:
            return

        title = "New Ride Request"
        body = f"Pickup: {pickup_name[:40]} | Drop: {drop_name[:40]} | Fare: Rs {round(fare)}"
        link_url = f"{APP_BASE_URL}/driver/service?offerId={offer_id}&requestId={request_id}"

        message = fb_messaging.MulticastMessage(
            tokens=tokens,
            data={
                "type": "new_ride_offer",
                "offerId": offer_id,
                "requestId": request_id,
                "pickupName": pickup_name[:60],
                "dropName": drop_name[:60],
                "fare": str(round(fare)),
                "link": link_url,
            },
            webpush=fb_messaging.WebpushConfig(
                fcm_options=fb_messaging.WebpushFCMOptions(link=link_url),
                notification=fb_messaging.WebpushNotification(
                    title=title,
                    body=body,
                    icon=f"{APP_BASE_URL}/assets/icons/liphtup-icon-192.png",
                    tag=f"offer-{offer_id}",
                    renotify=True,
                    require_interaction=True,
                ),
            ),
        )
        fb_messaging.send_each_for_multicast(message)
    except Exception as exc:
        logger.warning("FCM offer notification skipped for driver %s: %s", driver_id, exc)


class DispatchEngine:
    def __init__(self, db):
        self.db = db
        self.lease = DispatchLease(db, region_id="main_region")
        self.pools = DispatchPools(db)

    def trigger_matching_pass(self, caller_id: str = "dispatch_trigger") -> dict[str, Any]:
        """Executes a complete serverless matching pass with lease fencing and dirty looping."""
        start_time = time.perf_counter()
        metrics: dict[str, Any] = {
            "pass_duration_ms": 0.0,
            "passengers_count": 0,
            "drivers_count": 0,
            "matches_count": 0,
            "offers_issued": 0,
            "iterations": 0,
            "status": "skipped_lease_held",
        }

        if not self.lease.try_acquire(caller_id=caller_id):
            return metrics

        metrics["status"] = "completed"
        iteration = 0

        try:
            while iteration < MAX_DIRTY_PASS_ITERATIONS:
                iteration += 1
                metrics["iterations"] = iteration

                # 1. Fetch active searching passengers
                passengers = self.pools.get_active_searching_passengers()
                metrics["passengers_count"] = max(metrics["passengers_count"], len(passengers))
                if not passengers:
                    break

                # 2. Derive candidate spatial cells across all passengers
                candidate_cells: set[str] = set()
                for p in passengers:
                    p_lat = float(p["pickup"]["lat"])
                    p_lng = float(p["pickup"]["lng"])
                    p_rad = float(p.get("current_radius_km", 2.0))
                    cells = get_overlapping_cells_for_circle(p_lat, p_lng, p_rad)
                    candidate_cells.update(cells)

                # 3. Query candidate drivers in those cells
                candidate_drivers = self.pools.get_candidate_drivers(candidate_cells)
                metrics["drivers_count"] = max(metrics["drivers_count"], len(candidate_drivers))
                if not candidate_drivers:
                    break

                # 4. Solve Bipartite Matching
                assignments = build_candidate_graph_and_solve(passengers, candidate_drivers)

                # 5. Issue Offers Transactionally
                for passenger, matched_driver, edge_info in assignments:
                    if not matched_driver:
                        continue

                    metrics["matches_count"] += 1
                    offer_issued = self._issue_atomic_offer(passenger, matched_driver, edge_info)
                    if offer_issued:
                        metrics["offers_issued"] += 1

                # 6. Check dirty flag for additional pending work
                was_dirty = self.lease.check_and_clear_dirty()
                if not was_dirty:
                    break

                # Renew lease for next iteration
                self.lease.renew()

        finally:
            self.lease.release()
            metrics["pass_duration_ms"] = round((time.perf_counter() - start_time) * 1000.0, 2)

        return metrics

    def _issue_atomic_offer(
        self,
        passenger: dict[str, Any],
        driver: dict[str, Any],
        edge_info: dict[str, Any],
    ) -> bool:
        """Issues an offer to a driver and passenger in a single atomic transaction."""
        req_id = passenger["request_id"]
        driver_id = driver["driver_id"]
        offer_id = f"off_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=OFFER_TIMEOUT_SECONDS)

        p_ref = self.pools.passenger_pool_ref.document(req_id)
        d_ref = self.pools.driver_pool_ref.document(driver_id)
        tx = self.db.transaction()

        @fb_firestore.transactional
        def _offer_tx(transaction):
            # 1. Verify lease fence
            if not self.lease.verify_fence(transaction):
                return False

            # 2. Verify passenger state & version
            p_snap = p_ref.get(transaction=transaction)
            if not p_snap.exists:
                return False
            p_data = p_snap.to_dict() or {}
            if p_data.get("status") != "searching" or int(p_data.get("version", 0)) != int(passenger.get("version", 0)):
                return False

            # 3. Verify driver state & version
            d_snap = d_ref.get(transaction=transaction)
            if not d_snap.exists:
                return False
            d_data = d_snap.to_dict() or {}
            if d_data.get("state") != "available" or int(d_data.get("version", 0)) != int(driver.get("version", 0)):
                return False

            # 4. Commit atomic offer updates
            p_offer = {
                "offer_id": offer_id,
                "driver_id": driver_id,
                "expires_at": expires_at,
                "distance_km": edge_info.get("distance_km"),
                "eta_minutes": edge_info.get("eta_minutes"),
            }
            d_offer = {
                "offer_id": offer_id,
                "request_id": req_id,
                "passenger_id": passenger.get("passenger_id"),
                "passenger_name": passenger.get("passenger_name", "Passenger"),
                "pickup": passenger.get("pickup"),
                "drop": passenger.get("drop"),
                "fare": passenger.get("fare", 0.0),
                "distance_km": edge_info.get("distance_km"),
                "eta_minutes": edge_info.get("eta_minutes"),
                "expires_at": expires_at,
            }

            transaction.update(p_ref, {
                "status": "offered",
                "active_offer": p_offer,
                "version": int(p_data.get("version", 0)) + 1,
                "updated_at": fb_firestore.SERVER_TIMESTAMP,
            })
            transaction.update(d_ref, {
                "state": "offered",
                "active_offer": d_offer,
                "version": int(d_data.get("version", 0)) + 1,
                "updated_at": fb_firestore.SERVER_TIMESTAMP,
            })
            return True

        try:
            success = _offer_tx(tx)
            if success:
                try:
                    self.db.collection("dispatchLogs").document().set({
                        "eventType": "offer_issued",
                        "offerId": offer_id,
                        "requestId": req_id,
                        "driverId": driver_id,
                        "passengerId": passenger.get("passenger_id"),
                        "distanceKm": edge_info.get("distance_km"),
                        "etaMinutes": edge_info.get("eta_minutes"),
                        "cost": edge_info.get("cost"),
                        "createdAt": fb_firestore.SERVER_TIMESTAMP,
                    })
                except Exception:
                    pass

                _send_driver_offer_notification(
                    self.db,
                    driver_id=driver_id,
                    offer_id=offer_id,
                    request_id=req_id,
                    pickup_name=passenger.get("pickup", {}).get("name", "Pickup"),
                    drop_name=passenger.get("drop", {}).get("name", "Drop"),
                    fare=float(passenger.get("fare", 0.0)),
                )

                # Notify passenger via pendingRideRequests doc (frontend listens here).
                # This is essential for notify_me passengers whose app may be in the
                # background: stamping lastNotifiedAt causes listenToPendingRequestUpdates
                # to show the "driver available" alert and trigger the local notification.
                try:
                    pending_ref = self.db.collection("pendingRideRequests").document(req_id)
                    pending_snap = pending_ref.get()
                    if pending_snap.exists:
                        pending_ref.update({
                            "lastNotifiedAt": fb_firestore.SERVER_TIMESTAMP,
                            "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                        })
                except Exception:
                    pass

                logger.info("Atomic offer %s issued for request %s to driver %s", offer_id, req_id, driver_id)
                return True
            return False
        except Exception as exc:
            logger.warning("Offer transaction failed for req %s -> driver %s: %s", req_id, driver_id, exc)
            return False
