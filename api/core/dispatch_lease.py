"""Distributed lease locking and fencing for serverless matching execution."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from firebase_admin import firestore as fb_firestore

from .dispatch_config import LEASE_DURATION_SECONDS


class LeaseLostError(Exception):
    """Raised when fencing token is invalid or lease was lost mid-pass."""
    pass


class DispatchLease:
    def __init__(self, db, region_id: str = "main_region"):
        self.db = db
        self.region_id = region_id
        self.doc_ref = db.collection("dispatchLeases").document(region_id)
        self.lease_token: Optional[str] = None
        self.acquired_at: Optional[datetime] = None
        self.expires_at: Optional[datetime] = None

    def try_acquire(self, caller_id: str = "serverless_worker") -> bool:
        """Attempt to acquire the lease. Returns True if acquired, False otherwise."""
        token = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=LEASE_DURATION_SECONDS)

        def _acquire_tx(tx):
            snap = self.doc_ref.get(transaction=tx) if tx else self.doc_ref.get()
            if snap.exists:
                data = snap.to_dict() or {}
                exp = data.get("expires_at")
                if exp:
                    exp_dt = exp if isinstance(exp, datetime) else datetime.fromtimestamp(exp.timestamp(), tz=timezone.utc)
                    if exp_dt > now and data.get("lease_token"):
                        if tx:
                            tx.update(self.doc_ref, {"is_dirty": True, "updated_at": fb_firestore.SERVER_TIMESTAMP})
                        else:
                            self.doc_ref.update({"is_dirty": True, "updated_at": fb_firestore.SERVER_TIMESTAMP})
                        return False

            payload = {
                "region_id": self.region_id,
                "lease_token": token,
                "locked_by": caller_id,
                "acquired_at": now,
                "expires_at": expires,
                "is_dirty": False,
                "updated_at": fb_firestore.SERVER_TIMESTAMP,
            }
            if tx:
                tx.set(self.doc_ref, payload, merge=True)
            else:
                self.doc_ref.set(payload, merge=True)
            return True

        try:
            if hasattr(self.db, "transaction"):
                try:
                    tx_wrapper = fb_firestore.transactional(_acquire_tx)
                    acquired = tx_wrapper(self.db.transaction())
                except Exception:
                    acquired = _acquire_tx(None)
            else:
                acquired = _acquire_tx(None)

            if acquired:
                self.lease_token = token
                self.acquired_at = now
                self.expires_at = expires
                return True
            return False
        except Exception:
            return False

    def verify_fence(self, tx) -> bool:
        """Fencing verification inside a transaction before any write."""
        if not self.lease_token:
            return False
        snap = self.doc_ref.get(transaction=tx)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        now = datetime.now(timezone.utc)
        exp = data.get("expires_at")
        if not exp:
            return False
        exp_dt = exp if isinstance(exp, datetime) else datetime.fromtimestamp(exp.timestamp(), tz=timezone.utc)
        if exp_dt <= now:
            return False
        return str(data.get("lease_token")) == self.lease_token

    def renew(self) -> bool:
        """Extend lease duration if current worker still owns the valid token."""
        if not self.lease_token:
            return False
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=LEASE_DURATION_SECONDS)

        transaction = self.db.transaction()

        @fb_firestore.transactional
        def _renew_tx(tx):
            if not self.verify_fence(tx):
                return False
            tx.update(self.doc_ref, {"expires_at": expires, "updated_at": fb_firestore.SERVER_TIMESTAMP})
            return True

        try:
            success = _renew_tx(transaction)
            if success:
                self.expires_at = expires
            return success
        except Exception:
            return False

    def check_and_clear_dirty(self) -> bool:
        """Checks if another trigger requested a pass while lease was held."""
        if not self.lease_token:
            return False
        transaction = self.db.transaction()

        @fb_firestore.transactional
        def _clear_dirty_tx(tx):
            if not self.verify_fence(tx):
                return False
            snap = self.doc_ref.get(transaction=tx)
            data = snap.to_dict() or {}
            was_dirty = bool(data.get("is_dirty", False))
            if was_dirty:
                tx.update(self.doc_ref, {"is_dirty": False, "updated_at": fb_firestore.SERVER_TIMESTAMP})
            return was_dirty

        try:
            return bool(_clear_dirty_tx(transaction))
        except Exception:
            return False

    def release(self) -> None:
        """Release the lease lock."""
        if not self.lease_token:
            return
        transaction = self.db.transaction()

        @fb_firestore.transactional
        def _release_tx(tx):
            if self.verify_fence(tx):
                tx.update(
                    self.doc_ref,
                    {
                        "lease_token": None,
                        "expires_at": datetime.now(timezone.utc),
                        "is_dirty": False,
                        "updated_at": fb_firestore.SERVER_TIMESTAMP,
                    },
                )

        try:
            _release_tx(transaction)
        except Exception:
            pass
        finally:
            self.lease_token = None


def mark_lease_dirty_if_locked(db, region_id: str = "main_region") -> None:
    """Marks the region dirty so the active leaseholder runs an additional pass."""
    try:
        doc_ref = db.collection("dispatchLeases").document(region_id)
        doc_ref.update({"is_dirty": True, "updated_at": fb_firestore.SERVER_TIMESTAMP})
    except Exception:
        pass


ServerlessDispatchLease = DispatchLease
