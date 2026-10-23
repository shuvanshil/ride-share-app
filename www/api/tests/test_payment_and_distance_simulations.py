"""Comprehensive Simulation Test Suite for LiphtUp Driver Payments and Distance Conflict Systems.

This suite simulates and verifies:
1. Driver Distance Conflicts & Admin Decision Workflows:
   - Disparity detection (under-travel, over-travel, mock-location)
   - Admin approving estimated distance (P)
   - Admin approving counter distance (T)
   - Admin declining entire distance (0 km)
   - Edge cases: idempotency, conflict guards, bounds validation, late fee reconciliation
2. Driver Payments, 8 PM IST Cutoff & Admin Operations:
   - 8:00 PM IST service day cutoff boundary (today not payable before 8 PM)
   - Sunday-only carryover exception (never blocks on immediate Sunday)
   - Overdue restriction evaluation and automatic lifting
   - Admin pause/unpause payments
   - Admin reset all driver payments
   - Admin offline manual cash payment recording
3. Single Payment Batch Divided into Day-based Allocations & Independent Decisions:
   - 1 batch creates multiple separate day-based allocations in subcollection
   - Admin independently approves Monday and Tuesday, and declines Wednesday
   - Declining Wednesday returns ONLY Wednesday's fee to payable without affecting Monday/Tuesday
   - Payment history lists each day allocation as a separate payment instance
   - Resubmission of declined allocation completes full clearance
"""
from __future__ import annotations

import copy
import datetime
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.index import app
from api.core.admin import require_admin
from api.core.auth import current_user
from api.core.service_day import (
    IST,
    service_date,
    service_date_str,
    fee_due_at,
    calculate_paise_for_distance,
    paise_to_rupees_float,
    get_ist_now,
    week_id,
)
from api.core.distance_reconciliation import (
    reconcile_ride_distance,
    STATUS_AUTO_ACCEPTED,
    STATUS_AUTO_RESOLVED,
    STATUS_UNDER_REVIEW,
)
from api.core.fee_engine import (
    COLLECTION_DRIVER_FEES,
    COLLECTION_DRIVER_FEE_WEEKS,
    COLLECTION_FEE_PAYMENT_BATCHES,
    COLLECTION_DAILY_STATS,
    ensure_fees_generated,
    get_driver_fee_summary,
    create_payment_batch,
    decide_payment_allocation,
    reconcile_fee_adjustment,
    evaluate_fee_restriction,
    remaining_paise,
    fee_status,
)


# ============================================================================
# COMPREHENSIVE IN-MEMORY FIRESTORE MOCK SUPPORTING SUBCOLLECTIONS & QUERIES
# ============================================================================

class SimSnapshot:
    def __init__(self, doc_id: str, data: Optional[dict], path: str, exists: bool = True):
        self.id = doc_id
        self._data = copy.deepcopy(data) if data is not None else {}
        self.exists = exists
        self.reference = SimDocRef(path, None)

    def to_dict(self) -> dict:
        return copy.deepcopy(self._data)


class SimDocRef:
    def __init__(self, path: str, db: Any):
        self.path = path.strip("/")
        parts = self.path.split("/")
        self.id = parts[-1]
        self._db = db

    def get(self, transaction=None) -> SimSnapshot:
        store = self._db.store if self._db else {}
        data = store.get(self.path)
        snap = SimSnapshot(self.id, data, self.path, exists=(data is not None))
        snap.reference = self
        return snap

    def set(self, data: dict, merge: bool = False):
        store = self._db.store
        if not merge or self.path not in store:
            store[self.path] = {}
        for k, v in data.items():
            if hasattr(v, "_increment_val"):
                store[self.path][k] = store[self.path].get(k, 0) + v._increment_val
            elif hasattr(v, "value"):
                store[self.path][k] = store[self.path].get(k, 0) + v.value
            else:
                store[self.path][k] = copy.deepcopy(v)

    def update(self, data: dict):
        store = self._db.store
        if self.path not in store:
            store[self.path] = {}
        for k, v in data.items():
            if hasattr(v, "_increment_val"):
                store[self.path][k] = store[self.path].get(k, 0) + v._increment_val
            elif hasattr(v, "value"):
                store[self.path][k] = store[self.path].get(k, 0) + v.value
            else:
                store[self.path][k] = copy.deepcopy(v)

    def delete(self):
        store = self._db.store
        if self.path in store:
            del store[self.path]

    def collection(self, name: str) -> SimCollectionRef:
        return SimCollectionRef(f"{self.path}/{name}", self._db)


class SimCollectionRef:
    def __init__(self, path: str, db: Any):
        self.path = path.strip("/")
        self._db = db
        self.filters: List[tuple] = []
        self._limit: Optional[int] = None

    def document(self, doc_id: Optional[str] = None) -> SimDocRef:
        if not doc_id:
            import uuid
            doc_id = f"auto_{uuid.uuid4().hex[:8]}"
        return SimDocRef(f"{self.path}/{doc_id}", self._db)

    def where(self, field: str, op: str, val: Any) -> SimCollectionRef:
        q = SimCollectionRef(self.path, self._db)
        q.filters = list(self.filters) + [(field, op, val)]
        q._limit = self._limit
        return q

    def limit(self, count: int) -> SimCollectionRef:
        q = SimCollectionRef(self.path, self._db)
        q.filters = list(self.filters)
        q._limit = count
        return q

    def order_by(self, field: str, direction=None) -> SimCollectionRef:
        return self

    def stream(self, transaction=None) -> List[SimSnapshot]:
        store = self._db.store
        prefix = self.path + "/"
        matches: List[SimSnapshot] = []
        for p, data in list(store.items()):
            if not p.startswith(prefix):
                continue
            remainder = p[len(prefix):]
            if "/" in remainder:
                continue
            doc_id = remainder
            matched = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    matched = False
                    break
                elif op == "!=" and doc_val == val:
                    matched = False
                    break
            if matched:
                snap = SimSnapshot(doc_id, data, p, exists=True)
                snap.reference = SimDocRef(p, self._db)
                matches.append(snap)
        if self._limit is not None:
            matches = matches[:self._limit]
        return matches

    def get(self, transaction=None) -> List[SimSnapshot]:
        return self.stream(transaction=transaction)


class SimTransaction:
    def __init__(self, db: Any):
        self._db = db

    def get(self, ref: SimDocRef) -> SimSnapshot:
        return ref.get(transaction=self)

    def set(self, ref: SimDocRef, data: dict, merge: bool = False):
        ref.set(data, merge=merge)

    def update(self, ref: SimDocRef, data: dict):
        ref.update(data)

    def delete(self, ref: SimDocRef):
        ref.delete()


class SimFirestoreClient:
    def __init__(self):
        self.store: Dict[str, dict] = {}

    def collection(self, name: str) -> SimCollectionRef:
        return SimCollectionRef(name, self)

    def transaction(self) -> SimTransaction:
        return SimTransaction(self)


class FakeIncrement:
    def __init__(self, val):
        self._increment_val = val


# ============================================================================
# FIXTURES
# ============================================================================

@pytest.fixture
def sim_db():
    db = SimFirestoreClient()
    return db


@pytest.fixture
def client(sim_db):
    app.dependency_overrides[require_admin] = lambda: {
        "uid": "admin_sim_user",
        "email": "admin@liphtup.com",
        "role": "admin",
    }
    app.dependency_overrides[current_user] = lambda: {
        "uid": "drv_sim_001",
        "email": "driver001@example.com",
        "role": "driver",
    }
    with patch("api.core.firebase.get_firestore", return_value=sim_db), \
         patch("api.routers.fees.get_firestore", return_value=sim_db), \
         patch("api.routers.driver_payments.get_firestore", return_value=sim_db), \
         patch("api.routers.admin.fb_firestore.client", return_value=sim_db), \
         patch("api.routers.admin.get_admin_app", return_value=MagicMock()), \
         patch("api.routers.admin.fb_firestore.transactional", lambda f: (lambda tx, *a, **kw: f(tx, *a, **kw))):
        with TestClient(app) as tc:
            yield tc
    app.dependency_overrides.clear()


# ============================================================================
# TYPE 1: DRIVER DISTANCE CONFLICTS & ADMIN APPROVAL SIMULATIONS
# ============================================================================

def test_simulation_distance_conflict_flow_and_admin_approve_estimated(client, sim_db):
    """Simulation 1.1: Driver distance conflict where P=12.0km and T=1.5km.
    Reconciles to UNDER_REVIEW, creates distanceReviews doc, freezes dayKey,
    and admin approves estimated distance (12.0 km).
    """
    driver_uid = "drv_sim_001"
    ride_id = "ride_conflict_est_01"
    day_key = "2026-10-20"

    # Setup initial driver profile & daily stats
    sim_db.store[f"users/{driver_uid}"] = {
        "uid": driver_uid,
        "name": "Sim Driver One",
        "lifetime_distance_km": 50.0,
    }
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"] = {
        "driver_id": driver_uid,
        "date": day_key,
        "distance_km": 0.0,
        "under_review_km": 0.0,
        "under_review_count": 0,
    }

    # 1. Run distance reconciliation engine
    inputs = {
        "P": 12.0,
        "T": 1.5,
        "C0": 12.0,
        "extra_past_drop_km": 0.0,
        "D": 35.0,
        "PD": 30.0,
        "n_samples": 3,
        "coverage": 0.30,
        "max_gap_s": 250.0,
        "last_sample_age_s": 150.0,
        "final_dist_to_drop_m": 800.0,
        "terminated_by": "driver_complete",
        "passenger_confirmed": None,
        "mock_location": False,
    }
    result = reconcile_ride_distance(inputs)
    assert result.status == STATUS_UNDER_REVIEW
    assert result.provisional_km == 12.0

    # 2. Simulate ride completion transaction creating review
    review_path = f"distanceReviews/{ride_id}"
    sim_db.store[review_path] = {
        "rideId": ride_id,
        "driverId": driver_uid,
        "dayKey": day_key,
        "dailyStatsDocId": f"{driver_uid}_{day_key}",
        "status": "PENDING",
        "provisional_km": 12.0,
        "planned_km": 12.0,
        "travelled_km": 1.5,
        "reason_codes": result.reason_codes,
        "evidence": result.evidence,
        "created_at": "2026-10-20T10:00:00+05:30",
        "version": 1,
    }
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["under_review_km"] = 12.0
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["under_review_count"] = 1

    # 3. Admin lists distance reviews
    res_list = client.get("/api/admin/distance-reviews?status=PENDING")
    assert res_list.status_code == 200
    reviews = res_list.json().get("reviews") or []
    assert any(r["rideId"] == ride_id for r in reviews)

    # 4. Admin approves estimated distance (12.0 km)
    decision_payload = {
        "decision": "approve",
        "approved_km": 12.0,
        "note": "Verified genuine trip; passenger confirmed destination drop.",
    }
    res_dec = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json=decision_payload)
    assert res_dec.status_code == 200
    dec_json = res_dec.json()
    assert dec_json["status"] == "APPROVED"
    assert dec_json["decided_km"] == 12.0

    # 5. Verify database state
    review_doc = sim_db.store[review_path]
    assert review_doc["status"] == "APPROVED"
    assert review_doc["decided_km"] == 12.0

    daily_doc = sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]
    assert daily_doc["distance_km"] == 12.0
    assert daily_doc["under_review_km"] == 0.0
    assert daily_doc["under_review_count"] == 0

    user_doc = sim_db.store[f"users/{driver_uid}"]
    assert user_doc["lifetime_distance_km"] == 62.0  # 50.0 + 12.0

    # Verify audit adjustment record created
    adj_path = f"driverDailyStats/{driver_uid}_{day_key}/adjustments/{ride_id}"
    assert adj_path in sim_db.store
    assert sim_db.store[adj_path]["decided_km"] == 12.0


def test_simulation_distance_conflict_flow_and_admin_approve_counter(client, sim_db):
    """Simulation 1.2: Driver distance conflict where P=6.0km and T=14.0km (over-travel).
    Admin approves counter distance (14.0 km).
    """
    driver_uid = "drv_sim_001"
    ride_id = "ride_conflict_cnt_02"
    day_key = "2026-10-21"

    sim_db.store[f"users/{driver_uid}"] = {"uid": driver_uid, "lifetime_distance_km": 10.0}
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"] = {
        "driver_id": driver_uid,
        "date": day_key,
        "distance_km": 0.0,
        "under_review_km": 6.0,
        "under_review_count": 1,
    }
    sim_db.store[f"distanceReviews/{ride_id}"] = {
        "rideId": ride_id,
        "driverId": driver_uid,
        "dayKey": day_key,
        "dailyStatsDocId": f"{driver_uid}_{day_key}",
        "status": "PENDING",
        "provisional_km": 6.0,
        "planned_km": 6.0,
        "travelled_km": 14.0,
        "reason_codes": ["OVER_TRAVEL_UNCORROBORATED"],
        "created_at": "2026-10-21T12:00:00+05:30",
    }

    # Admin approves counter distance = 14.0 km
    res = client.post(
        f"/api/admin/distance-reviews/{ride_id}/decision",
        json={"decision": "approve", "approved_km": 14.0, "note": "Driver took police-directed detour."}
    )
    assert res.status_code == 200
    assert res.json()["decided_km"] == 14.0

    assert sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["distance_km"] == 14.0
    assert sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["under_review_km"] == 0.0
    assert sim_db.store[f"users/{driver_uid}"]["lifetime_distance_km"] == 24.0  # 10.0 + 14.0


def test_simulation_distance_conflict_flow_and_admin_decline_entire(client, sim_db):
    """Simulation 1.3: Driver mock location detected. Reconciles to UNDER_REVIEW.
    Admin declines entire distance (0 km counted).
    """
    driver_uid = "drv_sim_001"
    ride_id = "ride_conflict_mock_03"
    day_key = "2026-10-22"

    sim_db.store[f"users/{driver_uid}"] = {"uid": driver_uid, "lifetime_distance_km": 40.0}
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"] = {
        "driver_id": driver_uid,
        "date": day_key,
        "distance_km": 0.0,
        "under_review_km": 8.0,
        "under_review_count": 1,
    }
    sim_db.store[f"distanceReviews/{ride_id}"] = {
        "rideId": ride_id,
        "driverId": driver_uid,
        "dayKey": day_key,
        "dailyStatsDocId": f"{driver_uid}_{day_key}",
        "status": "PENDING",
        "provisional_km": 8.0,
        "planned_km": 8.0,
        "travelled_km": 8.5,
        "reason_codes": ["MOCK_LOCATION"],
        "created_at": "2026-10-22T14:00:00+05:30",
    }

    # Admin declines entire distance
    res = client.post(
        f"/api/admin/distance-reviews/{ride_id}/decision",
        json={"decision": "decline", "note": "Confirmed mock location tool running during trip."}
    )
    assert res.status_code == 200
    assert res.json()["status"] == "DECLINED"
    assert res.json()["decided_km"] == 0.0

    # Distance is 0 km, under_review cleared, lifetime unchanged
    assert sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["distance_km"] == 0.0
    assert sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["under_review_km"] == 0.0
    assert sim_db.store[f"users/{driver_uid}"]["lifetime_distance_km"] == 40.0


def test_simulation_distance_conflict_edge_cases(client, sim_db):
    """Simulation 1.4: Validation and concurrency edge cases on distance reviews:
    - 409 on conflicting second decision
    - 200 idempotent on identical decision
    - 422 on invalid approved_km bounds
    - 422 on missing note
    - 404 on missing review
    """
    driver_uid = "drv_sim_001"
    ride_id = "ride_edge_04"
    day_key = "2026-10-22"

    sim_db.store[f"users/{driver_uid}"] = {"uid": driver_uid, "lifetime_distance_km": 10.0}
    sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"] = {
        "driver_id": driver_uid,
        "date": day_key,
        "distance_km": 0.0,
        "under_review_km": 5.0,
        "under_review_count": 1,
    }
    sim_db.store[f"distanceReviews/{ride_id}"] = {
        "rideId": ride_id,
        "driverId": driver_uid,
        "dayKey": day_key,
        "dailyStatsDocId": f"{driver_uid}_{day_key}",
        "status": "PENDING",
        "provisional_km": 5.0,
        "planned_km": 5.0,
        "travelled_km": 5.0,
        "reason_codes": ["AMBER_BAND"],
        "created_at": "2026-10-22T14:00:00+05:30",
    }

    # 1. 422 on missing note
    res_no_note = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "approve", "note": ""})
    assert res_no_note.status_code == 422

    # 2. 422 on negative approved_km
    res_neg = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "approve", "approved_km": -1.0, "note": "Invalid"})
    assert res_neg.status_code == 422

    # 3. 422 on approved_km exceeding upper threshold (> max(3*5, 5+10) = 15)
    res_excess = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "approve", "approved_km": 20.0, "note": "Too high"})
    assert res_excess.status_code == 422

    # 4. Valid approve
    res_ok = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "approve", "approved_km": 5.0, "note": "Approved"})
    assert res_ok.status_code == 200

    # 5. Idempotent repeat: same decision returns 200 without changing counters
    res_repeat = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "approve", "approved_km": 5.0, "note": "Approved"})
    assert res_repeat.status_code == 200
    assert sim_db.store[f"driverDailyStats/{driver_uid}_{day_key}"]["distance_km"] == 5.0  # Not 10.0!

    # 6. 409 Conflict: attempt to decline an approved review
    res_conflict = client.post(f"/api/admin/distance-reviews/{ride_id}/decision", json={"decision": "decline", "note": "Conflicting decision"})
    assert res_conflict.status_code == 409

    # 7. 404 on non-existent review
    res_404 = client.post("/api/admin/distance-reviews/non_existent_ride/decision", json={"decision": "approve", "note": "Note"})
    assert res_404.status_code == 404


def test_simulation_distance_late_decision_and_fee_reconciliation(client, sim_db):
    """Simulation 1.5: Admin decides distance review AFTER the service day has closed.
    Level-triggered fee reconciliation updates the billed daily fee and weekly aggregate.
    """
    driver_uid = "drv_sim_001"
    day_key = "2026-10-18"  # Sunday
    w_id = "2026-W42"

    # Driver fee was originally billed at 0 km (fee_paise = 0)
    fee_id = f"{driver_uid}_{day_key}"
    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_id}"] = {
        "uid": driver_uid,
        "serviceDate": day_key,
        "weekId": w_id,
        "distance_km": 0.0,
        "billed_distance_m": 0,
        "fee_paise": 0,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 0,
        "status": "PAID",
    }
    sim_db.store[f"{COLLECTION_DRIVER_FEE_WEEKS}/{driver_uid}_{w_id}"] = {
        "uid": driver_uid,
        "weekId": w_id,
        "total_fee_paise": 0,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 0,
    }

    # Update daily stats with newly approved 15.0 km
    sim_db.store[f"{COLLECTION_DAILY_STATS}/{driver_uid}_{day_key}"] = {"distance_km": 15.0}

    # Now admin approves 15.0 km for that past day
    reconcile_res = reconcile_fee_adjustment(
        db=sim_db,
        uid=driver_uid,
        service_date_val=day_key,
        source="admin_distance_approval",
    )
    assert reconcile_res is not None
    assert reconcile_res["delta_paise"] == 1500  # 15.0 km = 1500 paise = ₹15.00

    # Verify updated fee doc
    fee_doc = sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_id}"]
    assert fee_doc["fee_paise"] == 1500
    assert fee_doc["remaining_paise"] == 1500
    assert fee_doc["status"] == "UNPAID"

    # Verify week aggregate updated
    week_doc = sim_db.store[f"{COLLECTION_DRIVER_FEE_WEEKS}/{driver_uid}_{w_id}"]
    assert week_doc["total_fee_paise"] == 1500
    assert week_doc["remaining_paise"] == 1500

    # Repeating reconciliation is idempotent (level-triggered)
    rep_res = reconcile_fee_adjustment(
        db=sim_db,
        uid=driver_uid,
        service_date_val=day_key,
        source="admin_distance_approval",
    )
    assert rep_res["adjusted"] is False
    assert rep_res["delta_paise"] == 0


# ============================================================================
# TYPE 2: DRIVER PAYMENTS, CUTOFF & ADMIN OPERATIONS SIMULATIONS
# ============================================================================

def test_simulation_8pm_ist_cutoff_eligible_days(sim_db):
    """Simulation 2.1: 8:00 PM IST service day cutoff.
    - Wednesday 6:00 PM IST: Wednesday has NOT closed yet; only Monday and Tuesday are billed.
    - Wednesday 8:01 PM IST: Wednesday service day is closed; Wednesday's fee is billed.
    """
    driver_uid = "drv_sim_001"

    # Populate daily stats for Monday (Oct 19), Tuesday (Oct 20), Wednesday (Oct 21)
    sim_db.store[f"driverDailyStats/{driver_uid}_2026-10-19"] = {"driver_id": driver_uid, "distance_km": 10.0}
    sim_db.store[f"driverDailyStats/{driver_uid}_2026-10-20"] = {"driver_id": driver_uid, "distance_km": 20.0}
    sim_db.store[f"driverDailyStats/{driver_uid}_2026-10-21"] = {"driver_id": driver_uid, "distance_km": 30.0}

    # At Wednesday 18:00 IST (6:00 PM), current time is before 20:00 IST cutoff
    t_wed_6pm = datetime.datetime(2026, 10, 21, 18, 0, 0, tzinfo=IST)
    created_6pm = ensure_fees_generated(sim_db, driver_uid, max_days=7, now=t_wed_6pm)
    created_dates = [f["serviceDate"] for f in created_6pm]
    assert "2026-10-19" in created_dates
    assert "2026-10-20" in created_dates
    # Wednesday is NOT closed yet, so it MUST NOT be generated!
    assert "2026-10-21" not in created_dates

    # Advance time to Wednesday 20:05 IST (8:05 PM)
    t_wed_805pm = datetime.datetime(2026, 10, 21, 20, 5, 0, tzinfo=IST)
    created_805pm = ensure_fees_generated(sim_db, driver_uid, max_days=7, now=t_wed_805pm)
    created_dates_post = [f["serviceDate"] for f in created_805pm]
    # Now Wednesday IS closed and generated!
    assert "2026-10-21" in created_dates_post


def test_simulation_sunday_only_exception_and_weekly_restriction():
    """Simulation 2.2: Sunday-only carryover exception.
    Saturday fee is due on Sunday 23:59:59 IST.
    Sunday fee is due on the FOLLOWING Sunday 23:59:59 IST.
    On Monday morning:
    - If Saturday is unpaid -> restricted.
    - If Saturday is paid and ONLY Sunday is unpaid -> NOT restricted!
    """
    now_monday_morning = datetime.datetime(2026, 10, 26, 8, 0, 0, tzinfo=IST)

    sat_due = datetime.datetime(2026, 10, 25, 23, 59, 59, tzinfo=IST)
    sun_due = datetime.datetime(2026, 11, 1, 23, 59, 59, tzinfo=IST)  # Following Sunday!

    # Case A: Saturday is unpaid (overdue)
    fees_case_a = [
        {"serviceDate": "2026-10-24", "fee_paise": 2500, "paid_paise": 0, "review_paise": 0, "remaining_paise": 2500, "due_at": sat_due.isoformat()},
        {"serviceDate": "2026-10-25", "fee_paise": 3000, "paid_paise": 0, "review_paise": 0, "remaining_paise": 3000, "due_at": sun_due.isoformat()},
    ]
    is_res_a, overdue_a, reason_a = evaluate_fee_restriction(fees_case_a, now_monday_morning)
    assert is_res_a is True
    assert overdue_a == 2500
    assert "₹25.00" in reason_a

    # Case B: Saturday was paid, only Sunday fee unpaid
    fees_case_b = [
        {"serviceDate": "2026-10-24", "fee_paise": 2500, "paid_paise": 2500, "review_paise": 0, "remaining_paise": 0, "due_at": sat_due.isoformat()},
        {"serviceDate": "2026-10-25", "fee_paise": 3000, "paid_paise": 0, "review_paise": 0, "remaining_paise": 3000, "due_at": sun_due.isoformat()},
    ]
    is_res_b, overdue_b, reason_b = evaluate_fee_restriction(fees_case_b, now_monday_morning)
    assert is_res_b is False  # Sunday fee alone NEVER restricts before following Sunday!


def test_simulation_admin_pause_and_unpause_payments(client, sim_db):
    """Simulation 2.3: Admin pauses payments.
    - Driver restriction is waived while paused.
    - Status endpoint reports isPaused=True.
    - Unpausing restores normal schedule.
    """
    # 1. Admin sets pause
    pause_payload = {
        "message": "Festival Holiday Break — payments paused.",
        "startDate": "2026-10-20",
        "endDate": "2026-10-30",
        "isPaused": True,
    }
    res_pause = client.post("/api/admin/driver-payments/pause", json=pause_payload)
    assert res_pause.status_code == 200
    assert res_pause.json()["pauseConfig"]["isPaused"] is True

    # 2. Driver status reports paused
    sim_db.store["users/drv_sim_001"] = {"uid": "drv_sim_001", "role": "driver"}
    res_status = client.get("/api/account/driver-payments/status")
    assert res_status.status_code == 200
    assert res_status.json()["isPaused"] is True
    assert res_status.json()["currentStatus"] == "paused"

    # 3. Admin unpauses
    res_unpause = client.delete("/api/admin/driver-payments/pause")
    assert res_unpause.status_code == 200
    assert res_unpause.json()["pauseConfig"]["isPaused"] is False


def test_simulation_admin_reset_all_payments(client, sim_db):
    """Simulation 2.4: Admin wipes all payment records.
    - Reset anchor written to systemSettings/driverPaymentReset.
    - All existing fees/batches/reminders deleted.
    - Driver checks summary -> 0 dues, no_dues state.
    """
    driver_uid = "drv_sim_001"

    # Populate dummy fee docs
    sim_db.store[f"driverFees/{driver_uid}_2026-10-19"] = {"uid": driver_uid, "fee_paise": 2000}
    sim_db.store[f"feePaymentBatches/batch_001"] = {"uid": driver_uid, "total_paise": 2000}

    res_reset = client.post("/api/admin/driver-payments/reset-all")
    assert res_reset.status_code == 200
    assert res_reset.json()["ok"] is True

    # Collections wiped
    assert f"driverFees/{driver_uid}_2026-10-19" not in sim_db.store
    assert f"feePaymentBatches/batch_001" not in sim_db.store

    # Reset anchor recorded
    assert "systemSettings/driverPaymentReset" in sim_db.store
    reset_doc = sim_db.store["systemSettings/driverPaymentReset"]
    assert "resetServiceDate" in reset_doc

    # Summary has 0 payable paise
    summary = get_driver_fee_summary(sim_db, driver_uid)
    assert summary["payable_paise"] == 0
    assert summary["restriction"]["is_restricted"] is False


def test_simulation_admin_record_manual_payment(client, sim_db):
    """Simulation 2.5: Admin records offline cash payment.
    - Allocates across oldest unpaid daily fees chronologically.
    - Partial manual payment pays Monday and leaves Tuesday unpaid.
    - Full manual payment clears all dues.
    """
    driver_uid = "drv_sim_001"
    sim_db.store[f"users/{driver_uid}"] = {"uid": driver_uid, "name": "Driver Cash", "role": "driver"}

    # Monday ₹20 (2000 paise), Tuesday ₹30 (3000 paise). Total = ₹50.
    fee_mon = f"{driver_uid}_2026-10-19"
    fee_tue = f"{driver_uid}_2026-10-20"
    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-19", "weekId": "2026-W43",
        "fee_paise": 2000, "paid_paise": 0, "review_paise": 0, "remaining_paise": 2000, "status": "UNPAID",
    }
    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-20", "weekId": "2026-W43",
        "fee_paise": 3000, "paid_paise": 0, "review_paise": 0, "remaining_paise": 3000, "status": "UNPAID",
    }

    # Admin records partial manual payment of ₹20
    res_part = client.post("/api/admin/driver-payments/record-manual", json={
        "driverId": driver_uid,
        "amount": 20.0,
        "paymentMethod": "cash",
        "paymentReference": "Offline cash from depot",
    })
    assert res_part.status_code == 200

    # Monday is now PAID, Tuesday is still UNPAID
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon}"]["status"] == "PAID"
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon}"]["paid_paise"] == 2000
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue}"]["status"] == "UNPAID"
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue}"]["remaining_paise"] == 3000

    # Admin records remaining ₹30
    res_full = client.post("/api/admin/driver-payments/record-manual", json={
        "driverId": driver_uid,
        "amount": 30.0,
        "paymentMethod": "cash",
    })
    assert res_full.status_code == 200
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue}"]["status"] == "PAID"
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue}"]["remaining_paise"] == 0


# ============================================================================
# TYPE 3: BATCH DIVIDED INTO DAY-BASED ALLOCATIONS & INDEPENDENT DECISIONS
# ============================================================================

def test_simulation_batch_divided_into_separate_day_allocations_and_independent_decisions(client, sim_db):
    """Simulation 3.1 & 3.2: Single payment batch covers Monday, Tuesday, Wednesday.
    - Verified that 1 batch creates 3 distinct day-based allocations in subcollection sharing 1 screenshot.
    - Admin approves Monday.
    - Admin approves Tuesday.
    - Admin declines Wednesday with note.
    - Critical: Declining Wednesday returns ₹17 to payable remaining WITHOUT declining Monday or Tuesday!
    - Monday and Tuesday remain APPROVED / PAID.
    - Week aggregates match exactly.
    - Payment history lists 3 distinct items with their individual statuses.
    """
    driver_uid = "drv_sim_001"
    w_id = "2026-W43"
    sim_db.store[f"users/{driver_uid}"] = {"uid": driver_uid, "name": "Driver Sim Multi"}

    # 3 closed fee days
    fee_mon_id = f"{driver_uid}_2026-10-19"
    fee_tue_id = f"{driver_uid}_2026-10-20"
    fee_wed_id = f"{driver_uid}_2026-10-21"

    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-19", "weekId": w_id,
        "fee_paise": 2000, "paid_paise": 0, "review_paise": 0, "remaining_paise": 2000, "status": "UNPAID",
    }
    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue_id}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-20", "weekId": w_id,
        "fee_paise": 3500, "paid_paise": 0, "review_paise": 0, "remaining_paise": 3500, "status": "UNPAID",
    }
    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_wed_id}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-21", "weekId": w_id,
        "fee_paise": 1700, "paid_paise": 0, "review_paise": 0, "remaining_paise": 1700, "status": "UNPAID",
    }
    sim_db.store[f"{COLLECTION_DRIVER_FEE_WEEKS}/{driver_uid}_{w_id}"] = {
        "uid": driver_uid, "weekId": w_id,
        "total_fee_paise": 7200, "paid_paise": 0, "review_paise": 0, "remaining_paise": 7200,
    }

    # 1. Driver submits 1 payment batch via POST /api/fees/payments
    submit_body = {
        "idempotency_key": "batch_idem_sim_301",
        "allocations": [
            {"fee_id": fee_mon_id, "amount_paise": 2000},
            {"fee_id": fee_tue_id, "amount_paise": 3500},
            {"fee_id": fee_wed_id, "amount_paise": 1700},
        ],
        "proofDownloadUrl": "https://storage.googleapis.com/liphtup/proof_combined_shot.png",
        "paymentReference": "UPI-REF-ALL-3-DAYS",
    }
    res_submit = client.post("/api/fees/payments", json=submit_body)
    assert res_submit.status_code == 200
    batch_res = res_submit.json()["batch"]
    batch_id = batch_res["batchId"]
    assert batch_res["total_paise"] == 7200
    assert batch_res["status"] == "PENDING"

    # Verify 3 separate allocations exist in subcollection
    alloc_mon_path = f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}/allocations/{fee_mon_id}"
    alloc_tue_path = f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}/allocations/{fee_tue_id}"
    alloc_wed_path = f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}/allocations/{fee_wed_id}"

    assert alloc_mon_path in sim_db.store
    assert alloc_tue_path in sim_db.store
    assert alloc_wed_path in sim_db.store

    assert sim_db.store[alloc_mon_path]["amount_paise"] == 2000
    assert sim_db.store[alloc_tue_path]["amount_paise"] == 3500
    assert sim_db.store[alloc_wed_path]["amount_paise"] == 1700
    assert sim_db.store[alloc_mon_path]["status"] == "PENDING"

    # All daily fees are under review, remaining is 0
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]["review_paise"] == 2000
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]["remaining_paise"] == 0
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue_id}"]["review_paise"] == 3500
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_wed_id}"]["review_paise"] == 1700

    # 2. Admin inspects batch via GET /api/admin/fee-batches/{id}
    res_batch_get = client.get(f"/api/admin/fee-batches/{batch_id}")
    assert res_batch_get.status_code == 200
    allocs = res_batch_get.json()["batch"]["allocations"]
    assert len(allocs) == 3

    # 3. Admin approves Monday
    res_mon = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_mon_id}/decision",
        json={"decision": "approve"}
    )
    assert res_mon.status_code == 200
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]["status"] == "PAID"
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]["paid_paise"] == 2000
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]["review_paise"] == 0
    # Batch still PENDING because Tue & Wed are not decided yet
    assert sim_db.store[f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}"]["status"] == "PENDING"

    # 4. Admin approves Tuesday
    res_tue = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_tue_id}/decision",
        json={"decision": "approve"}
    )
    assert res_tue.status_code == 200
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue_id}"]["status"] == "PAID"
    assert sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue_id}"]["paid_paise"] == 3500
    assert sim_db.store[f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}"]["status"] == "PENDING"

    # 5. Admin declines Wednesday with note
    res_wed = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_wed_id}/decision",
        json={"decision": "decline", "note": "Payment reference mismatch on Wednesday."}
    )
    assert res_wed.status_code == 200

    # CRITICAL INVARIANT CHECKS:
    # Wednesday is returned to UNPAID, review_paise is 0, remaining_paise is 1700!
    fee_wed = sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_wed_id}"]
    assert fee_wed["status"] == "UNPAID"
    assert fee_wed["paid_paise"] == 0
    assert fee_wed["review_paise"] == 0
    assert fee_wed["remaining_paise"] == 1700

    # Monday and Tuesday MUST STILL BE APPROVED / PAID!
    fee_mon = sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_mon_id}"]
    assert fee_mon["status"] == "PAID"
    assert fee_mon["paid_paise"] == 2000

    fee_tue = sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_tue_id}"]
    assert fee_tue["status"] == "PAID"
    assert fee_tue["paid_paise"] == 3500

    # Batch is now DECIDED because all allocations are resolved
    assert sim_db.store[f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}"]["status"] == "DECIDED"

    # Week aggregate reflects exact accounting:
    # Total = 7200, Paid = 5500, Review = 0, Remaining = 1700
    week_doc = sim_db.store[f"{COLLECTION_DRIVER_FEE_WEEKS}/{driver_uid}_{w_id}"]
    assert week_doc["total_fee_paise"] == 7200
    assert week_doc["paid_paise"] == 5500
    assert week_doc["review_paise"] == 0
    assert week_doc["remaining_paise"] == 1700

    # 6. Driver checks fee summary and payment history
    res_sum = client.get("/api/fees/summary")
    assert res_sum.status_code == 200
    sum_data = res_sum.json()
    assert sum_data["payable_paise"] == 1700  # Only Wednesday is payable now

    history = sum_data.get("history") or []
    assert len(history) == 3  # Exactly 3 day-based payment instances!

    hist_mon = next(h for h in history if "19 Oct" in h.get("weekLabel", "") or "2026-10-19" in str(h.get("feeId", "")))
    hist_tue = next(h for h in history if "20 Oct" in h.get("weekLabel", "") or "2026-10-20" in str(h.get("feeId", "")))
    hist_wed = next(h for h in history if "21 Oct" in h.get("weekLabel", "") or "2026-10-21" in str(h.get("feeId", "")))

    assert hist_mon["status"] == "approved"
    assert hist_mon["amount"] == 20.0

    assert hist_tue["status"] == "approved"
    assert hist_tue["amount"] == 35.0

    assert hist_wed["status"] == "declined"
    assert hist_wed["amount"] == 17.0
    assert hist_wed["declineReason"] == "Payment reference mismatch on Wednesday."

    # All 3 share the common proof download URL
    assert hist_mon["proofDownloadUrl"] == "https://storage.googleapis.com/liphtup/proof_combined_shot.png"
    assert hist_tue["proofDownloadUrl"] == "https://storage.googleapis.com/liphtup/proof_combined_shot.png"
    assert hist_wed["proofDownloadUrl"] == "https://storage.googleapis.com/liphtup/proof_combined_shot.png"

    # 7. Driver resubmits payment for Wednesday alone
    res_resub = client.post("/api/fees/payments", json={
        "idempotency_key": "batch_wed_retry_302",
        "allocations": [{"fee_id": fee_wed_id, "amount_paise": 1700}],
        "proofDownloadUrl": "https://storage.googleapis.com/liphtup/proof_wed_retry.png",
    })
    assert res_resub.status_code == 200
    wed_batch_id = res_resub.json()["batch"]["batchId"]

    # Admin approves Wednesday resubmission
    res_wed_app = client.post(
        f"/api/admin/fee-batches/{wed_batch_id}/allocations/{fee_wed_id}/decision",
        json={"decision": "approve"}
    )
    assert res_wed_app.status_code == 200

    # Wednesday is now fully PAID!
    fee_wed_final = sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_wed_id}"]
    assert fee_wed_final["status"] == "PAID"
    assert fee_wed_final["paid_paise"] == 1700
    assert fee_wed_final["remaining_paise"] == 0

    # Week aggregate is now 100% paid
    week_final = sim_db.store[f"{COLLECTION_DRIVER_FEE_WEEKS}/{driver_uid}_{w_id}"]
    assert week_final["paid_paise"] == 7200
    assert week_final["remaining_paise"] == 0


def test_simulation_allocation_decision_guards_and_conflicts(client, sim_db):
    """Simulation 3.4: Concurrency and validation guards on allocation decisions:
    - Decline requires note (422)
    - Conflicting decision on decided allocation (409)
    - Idempotent repeated identical decision (200)
    - Non-admin access forbidden (403)
    """
    driver_uid = "drv_sim_001"
    batch_id = "batch_guards_01"
    fee_id = f"{driver_uid}_2026-10-19"

    sim_db.store[f"{COLLECTION_DRIVER_FEES}/{fee_id}"] = {
        "uid": driver_uid, "serviceDate": "2026-10-19", "weekId": "2026-W43",
        "fee_paise": 2000, "paid_paise": 0, "review_paise": 2000, "remaining_paise": 0, "status": "UNDER_REVIEW",
    }
    sim_db.store[f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}"] = {
        "batchId": batch_id, "uid": driver_uid, "status": "PENDING", "total_paise": 2000,
    }
    sim_db.store[f"{COLLECTION_FEE_PAYMENT_BATCHES}/{batch_id}/allocations/{fee_id}"] = {
        "fee_id": fee_id, "serviceDate": "2026-10-19", "amount_paise": 2000, "status": "PENDING",
    }

    # 1. Decline without note -> 422
    res_no_note = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_id}/decision",
        json={"decision": "decline", "note": ""}
    )
    assert res_no_note.status_code == 422

    # 2. Approve allocation -> 200
    res_app = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_id}/decision",
        json={"decision": "approve"}
    )
    assert res_app.status_code == 200

    # 3. Repeated approve -> 200 idempotent
    res_app_rep = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_id}/decision",
        json={"decision": "approve"}
    )
    assert res_app_rep.status_code == 200

    # 4. Conflicting decline on approved allocation -> 409
    res_conf = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_id}/decision",
        json={"decision": "decline", "note": "Now declining"}
    )
    assert res_conf.status_code == 409

    # 5. Non-admin forbidden -> 403
    from api.core.errors import ApiError
    def fake_non_admin():
        raise ApiError("Forbidden: Admin privileges required.", 403)
    app.dependency_overrides[require_admin] = fake_non_admin
    res_non_admin = client.post(
        f"/api/admin/fee-batches/{batch_id}/allocations/{fee_id}/decision",
        json={"decision": "approve"}
    )
    assert res_non_admin.status_code == 403
