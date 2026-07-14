"""Server-authoritative ride lifecycle operations."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from firebase_admin import firestore as fb_firestore

from ..core.auth import current_user
from ..core.errors import ApiError
from ..core.firebase import get_admin_app

router = APIRouter(prefix="/rides", tags=["rides"])

ACTIVE_PASSENGER_STATUSES = {"pending", "accepted", "arrived", "started", "en_route"}


def _history_update(ride_id: str, ride: dict[str, Any]) -> dict[str, Any]:
    """Create the minimum compatible history record for a verified ride."""
    return {
        "ride_id": ride_id,
        "passenger_id": ride.get("passenger_id"),
        "driver_id": ride.get("driver_id"),
        "pickup_location": ride.get("pickup_display_address") or ride.get("pickup_name") or "Pickup not recorded",
        "pickup_display_address": ride.get("pickup_display_address") or "",
        "pickup_formatted_address": ride.get("pickup_formatted_address") or "",
        "pickup_landmark": ride.get("pickup_landmark") or "",
        "drop_location": ride.get("drop_display_address") or ride.get("drop_name") or "Drop not recorded",
        "drop_display_address": ride.get("drop_display_address") or "",
        "drop_formatted_address": ride.get("drop_formatted_address") or ride.get("drop_full_address") or "",
        "drop_full_address": ride.get("drop_full_address") or "",
        "drop_landmark": ride.get("drop_landmark") or "",
        "verifiedAt": ride.get("pinVerifiedAt") or ride.get("verifiedAt") or fb_firestore.SERVER_TIMESTAMP,
        "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
        "finalStatusAt": fb_firestore.SERVER_TIMESTAMP,
        "distance_km": float(ride.get("distance_km") or 0),
        "duration_minutes": float(ride.get("duration_minutes") or 0),
        "fare_amount": float(ride.get("fare") or 0),
        "trip_status": "cancelled_by_passenger",
        "final_status": "cancelled",
        "cancelled_by": "passenger",
        "payment_status": ride.get("payment_status") or "pending",
        "driver_name": ride.get("driver_name") or "Driver",
        "passenger_name": ride.get("passenger_name") or "Passenger",
        "vehicle_model": ride.get("vehicle_model") or "Vehicle",
        "vehicle_number": ride.get("vehicle_number") or "Number not recorded",
        "vehicle_type": ride.get("vehicle_type") or "",
        "service_name": ride.get("service_name") or "",
        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
        "source": "fastapi_passenger_cancellation",
    }


@router.post("/{ride_id}/cancel")
def cancel_passenger_ride(
    ride_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Cancel an active passenger ride with ownership/state enforcement."""
    uid = str(user.get("uid") or "").strip()
    clean_ride_id = str(ride_id or "").strip()[:160]
    if not uid:
        raise ApiError("Authenticated user identity is missing.", 401)
    if not clean_ride_id:
        raise ApiError("Ride ID is required.", 400)

    try:
        db = fb_firestore.client(get_admin_app())
        ride_ref = db.collection("rides").document(clean_ride_id)
        history_ref = db.collection("tripHistory").document(clean_ride_id)
        transaction = db.transaction()

        @fb_firestore.transactional
        def cancel_transaction(tx):
            snapshot = ride_ref.get(transaction=tx)
            if not snapshot.exists:
                raise ApiError("Ride not found.", 404)

            ride = snapshot.to_dict() or {}
            if ride.get("passenger_id") != uid:
                raise ApiError("Only the passenger can cancel this ride.", 403)

            status = ride.get("status")
            if status not in ACTIVE_PASSENGER_STATUSES:
                raise ApiError("This ride can no longer be cancelled.", 409)

            tx.update(
                ride_ref,
                {
                    "status": "cancelled_by_passenger",
                    "cancelledAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            if ride.get("pinVerifiedAt"):
                tx.set(history_ref, _history_update(clean_ride_id, ride), merge=True)

        cancel_transaction(transaction)
        return {"ok": True, "rideId": clean_ride_id, "status": "cancelled_by_passenger"}
    except ApiError:
        raise
    except Exception as error:  # noqa: BLE001
        raise ApiError("Could not cancel this ride.", 503, {"message": str(error)})
