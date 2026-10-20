"""Unit and Integration Tests for Fee Engine & Phase 2 Daily Platform Fees."""
from __future__ import annotations

import datetime
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from api.core.service_day import (
    IST,
    service_date,
    service_date_str,
    fee_due_at,
    calculate_paise_for_distance,
    paise_to_rupees_float,
    week_id,
)
from api.core.fee_engine import (
    fee_status,
    remaining_paise,
    evaluate_fee_restriction,
    ensure_fees_generated,
    reconcile_fee_adjustment,
    create_payment_batch,
    decide_payment_allocation,
    get_driver_fee_summary,
    allocate_manual_fee_payment,
    COLLECTION_DRIVER_FEES,
    COLLECTION_DRIVER_FEE_WEEKS,
    COLLECTION_FEE_STATE,
    COLLECTION_FEE_PAYMENT_BATCHES,
    COLLECTION_DAILY_STATS,
)
from api.core.errors import ApiError
from api.index import app

client = TestClient(app)


# ============================================================================
# 1. PURE DOMAIN LOGIC TESTS
# ============================================================================

def test_calculate_paise_for_distance_rounding():
    """Verify ₹1/km integer paise half-up calculation ((metres + 5) // 10)."""
    assert calculate_paise_for_distance(0.0) == 0
    assert calculate_paise_for_distance(-5.0) == 0

    # Exactly 1 km = 1000m -> (1000 + 5) // 10 = 100 paise (₹1.00)
    assert calculate_paise_for_distance(1.0) == 100

    # 1.004 km = 1004m -> (1004 + 5) // 10 = 1009 // 10 = 100 paise
    assert calculate_paise_for_distance(1.004) == 100

    # 1.005 km = 1005m -> (1005 + 5) // 10 = 1010 // 10 = 101 paise (Half-up rounds up)
    assert calculate_paise_for_distance(1.005) == 101

    # 12.345 km = 12345m -> (12345 + 5) // 10 = 12350 // 10 = 1235 paise (₹12.35)
    assert calculate_paise_for_distance(12.345) == 1235

    # 0.009 km = 9m -> (9 + 5) // 10 = 14 // 10 = 1 paise
    assert calculate_paise_for_distance(0.009) == 1

    # 0.004 km = 4m -> (4 + 5) // 10 = 9 // 10 = 0 paise
    assert calculate_paise_for_distance(0.004) == 0


def test_paise_to_rupees_float():
    assert paise_to_rupees_float(0) == 0.0
    assert paise_to_rupees_float(100) == 1.0
    assert paise_to_rupees_float(1235) == 12.35
    assert paise_to_rupees_float(50) == 0.5


def test_fee_status_transitions():
    """Test fee_status derivations."""
    assert fee_status(0, 0, 0) == "PAID"
    assert fee_status(-10, 0, 0) == "PAID"
    assert fee_status(500, 500, 0) == "PAID"
    assert fee_status(500, 600, 0) == "PAID"
    assert fee_status(500, 200, 0) == "PARTIAL"
    assert fee_status(500, 200, 300) == "PARTIAL"
    assert fee_status(500, 0, 500) == "UNDER_REVIEW"
    assert fee_status(500, 0, 600) == "UNDER_REVIEW"
    assert fee_status(500, 0, 0) == "UNPAID"
    assert fee_status(500, 0, 499) == "UNPAID"


def test_remaining_paise():
    """Test remaining actionable paise computation."""
    assert remaining_paise(500, 0, 0) == 500
    assert remaining_paise(500, 200, 0) == 300
    assert remaining_paise(500, 200, 200) == 100
    assert remaining_paise(500, 500, 0) == 0
    assert remaining_paise(500, 0, 500) == 0  # Under review holds the amount
    assert remaining_paise(500, 600, 0) == 0


def test_evaluate_fee_restriction_scenarios():
    """Test driver restriction evaluation based on overdue fees."""
    # Current time: Wednesday 2026-10-21 12:00:00 IST
    now = datetime.datetime(2026, 10, 21, 12, 0, 0, tzinfo=IST)

    # Case 1: Empty fees -> Not restricted
    is_rest, overdue, reason = evaluate_fee_restriction([], now)
    assert not is_rest and overdue == 0

    # Case 2: Fee due in future (e.g. Sunday 2026-10-25 23:59:59 IST) -> Not restricted
    future_fee = {
        "fee_paise": 1500,
        "paid_paise": 0,
        "review_paise": 0,
        "due_at": "2026-10-25T23:59:59+05:30",
    }
    is_rest, overdue, _ = evaluate_fee_restriction([future_fee], now)
    assert not is_rest and overdue == 0

    # Case 3: Overdue unpaid fee (due Sunday 2026-10-18 23:59:59 IST) -> RESTRICTED
    past_unpaid_fee = {
        "fee_paise": 1250,
        "paid_paise": 0,
        "review_paise": 0,
        "due_at": "2026-10-18T23:59:59+05:30",
    }
    is_rest, overdue, reason = evaluate_fee_restriction([past_unpaid_fee], now)
    assert is_rest is True
    assert overdue == 1250
    assert "₹12.50" in reason

    # Case 4: Overdue fee with active review_paise covering it -> Not restricted
    past_review_fee = {
        "fee_paise": 1250,
        "paid_paise": 0,
        "review_paise": 1250,
        "due_at": "2026-10-18T23:59:59+05:30",
    }
    is_rest, overdue, _ = evaluate_fee_restriction([past_review_fee], now)
    assert not is_rest and overdue == 0

    # Case 5: Sunday exception fee:
    # A fee incurred on Sunday 2026-10-18 has due_at set to following Sunday 2026-10-25
    sunday_exception_fee = {
        "fee_paise": 2000,
        "paid_paise": 0,
        "review_paise": 0,
        "due_at": fee_due_at("2026-10-18"),  # Resolves to 2026-10-25T23:59:59+05:30
    }
    is_rest, overdue, _ = evaluate_fee_restriction([sunday_exception_fee], now)
    assert not is_rest and overdue == 0


# ============================================================================
# 2. IN-MEMORY FIRESTORE MOCK FOR ENGINE TESTING
# ============================================================================

class InMemoryDocRef:
    def __init__(self, coll_name: str, doc_id: str, store: dict):
        self.coll_name = coll_name
        self.id = doc_id
        self.store = store

    def get(self, transaction=None):
        data = self.store.get(self.coll_name, {}).get(self.id)
        return InMemorySnap(self.coll_name, self.id, data, self.store)

    def set(self, data, merge=False):
        if self.coll_name not in self.store:
            self.store[self.coll_name] = {}
        if merge and self.id in self.store[self.coll_name]:
            existing = dict(self.store[self.coll_name][self.id])
            existing.update(data)
            self.store[self.coll_name][self.id] = existing
        else:
            self.store[self.coll_name][self.id] = dict(data)

    def update(self, data):
        if self.coll_name not in self.store or self.id not in self.store[self.coll_name]:
            raise ValueError(f"Doc {self.id} does not exist for update")
        self.store[self.coll_name][self.id].update(data)

    def delete(self):
        if self.coll_name in self.store and self.id in self.store[self.coll_name]:
            del self.store[self.coll_name][self.id]

    def collection(self, sub_name: str):
        sub_coll_key = f"{self.coll_name}/{self.id}/{sub_name}"
        return InMemoryCollectionRef(sub_coll_key, self.store)


class InMemorySnap:
    def __init__(self, coll_name: str, doc_id: str, data: Optional[dict], store: dict):
        self.coll_name = coll_name
        self.id = doc_id
        self._data = data
        self.store = store
        self.reference = InMemoryDocRef(coll_name, doc_id, store)

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict:
        return dict(self._data or {})


class InMemoryQuery:
    def __init__(self, coll_name: str, store: dict, filters: list = None, order_field: str = None, desc: bool = False, limit_val: int = None):
        self.coll_name = coll_name
        self.store = store
        self.filters = filters or []
        self.order_field = order_field
        self.desc = desc
        self.limit_val = limit_val

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return InMemoryQuery(self.coll_name, self.store, new_filters, self.order_field, self.desc, self.limit_val)

    def order_by(self, field, direction="ASCENDING"):
        is_desc = direction.upper().endswith("DESCENDING")
        return InMemoryQuery(self.coll_name, self.store, self.filters, field, is_desc, self.limit_val)

    def limit(self, count):
        return InMemoryQuery(self.coll_name, self.store, self.filters, self.order_field, self.desc, count)

    def stream(self, transaction=None):
        docs = self.store.get(self.coll_name, {})
        results = []
        for doc_id, data in docs.items():
            match = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    match = False
                    break
                elif op == ">=" and (doc_val is None or doc_val < val):
                    match = False
                    break
                elif op == "<=" and (doc_val is None or doc_val > val):
                    match = False
                    break
                elif op == ">" and (doc_val is None or doc_val <= val):
                    match = False
                    break
                elif op == "<" and (doc_val is None or doc_val >= val):
                    match = False
                    break
            if match:
                results.append(InMemorySnap(self.coll_name, doc_id, data, self.store))

        if self.order_field:
            results.sort(key=lambda s: s.to_dict().get(self.order_field, ""), reverse=self.desc)
        if self.limit_val:
            results = results[:self.limit_val]
        return results


class InMemoryCollectionRef(InMemoryQuery):
    def __init__(self, coll_name: str, store: dict):
        super().__init__(coll_name, store)

    def document(self, doc_id: str):
        return InMemoryDocRef(self.coll_name, doc_id, self.store)


class InMemoryTransaction:
    def __init__(self, store: dict):
        self.store = store

    def get(self, doc_ref):
        return doc_ref.get(transaction=self)

    def set(self, doc_ref, data, merge=False):
        doc_ref.set(data, merge=merge)

    def update(self, doc_ref, data):
        doc_ref.update(data)

    def delete(self, doc_ref):
        doc_ref.delete()


class InMemoryFirestore:
    def __init__(self):
        self.store: Dict[str, Dict[str, dict]] = {}

    def collection(self, coll_name: str):
        return InMemoryCollectionRef(coll_name, self.store)

    def transaction(self):
        return InMemoryTransaction(self.store)


# ============================================================================
# 3. LEVEL-TRIGGERED GENERATION & RECONCILIATION TESTS
# ============================================================================

def test_ensure_fees_generated_workflow():
    db = InMemoryFirestore()
    uid = "drv_test_001"

    # Seed driverDailyStats for two closed days:
    # Day 1: 2026-10-18 (Sunday), distance = 25.5 km
    # Day 2: 2026-10-19 (Monday), distance = 0.0 km (No driving)
    # Day 3: 2026-10-20 (Tuesday), distance = 14.2 km
    stats_coll = db.collection(COLLECTION_DAILY_STATS)
    stats_coll.document(f"{uid}_2026-10-18").set({
        "driver_id": uid,
        "dayKey": "2026-10-18",
        "distance_km": 25.5,
    })
    stats_coll.document(f"{uid}_2026-10-19").set({
        "driver_id": uid,
        "dayKey": "2026-10-19",
        "distance_km": 0.0,
    })
    stats_coll.document(f"{uid}_2026-10-20").set({
        "driver_id": uid,
        "dayKey": "2026-10-20",
        "distance_km": 14.2,
    })

    # Set initial feeState pointer at 2026-10-17
    db.collection(COLLECTION_FEE_STATE).document(uid).set({
        "uid": uid,
        "last_generated_day": "2026-10-17",
    })

    # Now is 2026-10-21 00:00:00 IST (All 3 service days are closed)
    now = datetime.datetime(2026, 10, 21, 0, 0, 0, tzinfo=IST)

    created_fees = ensure_fees_generated(db, uid, now=now)
    assert len(created_fees) == 2  # Day 18 and Day 20 created, Day 19 had 0 km

    # Verify Day 18 fee
    fee_18 = db.collection(COLLECTION_DRIVER_FEES).document(f"{uid}_2026-10-18").get().to_dict()
    assert fee_18["fee_paise"] == calculate_paise_for_distance(25.5)  # 2550 paise
    assert fee_18["status"] == "UNPAID"
    # Sunday exception: Day 18 (Sunday) fee due_at is next Sunday (2026-10-25)
    assert fee_18["due_at"] == "2026-10-25T23:59:59+05:30"

    # Verify Day 19 has NO driverFees doc (zero distance)
    snap_19 = db.collection(COLLECTION_DRIVER_FEES).document(f"{uid}_2026-10-19").get()
    assert not snap_19.exists

    # Verify Day 20 fee
    fee_20 = db.collection(COLLECTION_DRIVER_FEES).document(f"{uid}_2026-10-20").get().to_dict()
    assert fee_20["fee_paise"] == calculate_paise_for_distance(14.2)  # 1420 paise
    assert fee_20["due_at"] == "2026-10-25T23:59:59+05:30"

    # Verify pointer advanced to 2026-10-20
    ptr = db.collection(COLLECTION_FEE_STATE).document(uid).get().to_dict()
    assert ptr["last_generated_day"] == "2026-10-20"

    # Re-running ensure_fees_generated must be idempotent (no new fees)
    created_again = ensure_fees_generated(db, uid, now=now)
    assert len(created_again) == 0


def test_reconcile_fee_adjustment_level_triggered():
    db = InMemoryFirestore()
    uid = "drv_test_002"
    service_day_str = "2026-10-15"
    fee_id = f"{uid}_{service_day_str}"

    # Initial fee of 10 km (1000 paise)
    initial_paise = calculate_paise_for_distance(10.0)
    db.collection(COLLECTION_DRIVER_FEES).document(fee_id).set({
        "feeId": fee_id,
        "uid": uid,
        "serviceDate": service_day_str,
        "weekId": week_id(service_day_str),
        "distance_km": 10.0,
        "fee_paise": initial_paise,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": initial_paise,
        "status": "UNPAID",
        "billed_distance_m": 10000,
        "version": 1,
    })
    db.collection(COLLECTION_DAILY_STATS).document(fee_id).set({
        "driver_id": uid,
        "dayKey": service_day_str,
        "distance_km": 10.0,
    })

    # Test Step 1: Upward adjustment to 15.5 km
    db.collection(COLLECTION_DAILY_STATS).document(fee_id).update({"distance_km": 15.5})
    res1 = reconcile_fee_adjustment(db, uid, service_day_str)
    assert res1["adjusted"] is True
    assert res1["fee_paise"] == calculate_paise_for_distance(15.5)  # 1550 paise
    assert res1["delta_paise"] == 550

    # Verify updated fee doc
    fee_updated = db.collection(COLLECTION_DRIVER_FEES).document(fee_id).get().to_dict()
    assert fee_updated["fee_paise"] == 1550
    assert fee_updated["remaining_paise"] == 1550
    assert fee_updated["billed_distance_m"] == 15500

    # Test Step 2: Downward adjustment to 8.2 km (flags needs_attention)
    db.collection(COLLECTION_DAILY_STATS).document(fee_id).update({"distance_km": 8.2})
    res2 = reconcile_fee_adjustment(db, uid, service_day_str)
    assert res2["adjusted"] is False
    assert res2["needs_attention"] is True


def test_payment_batch_creation_and_allocation_lifecycle():
    db = InMemoryFirestore()
    uid = "drv_test_003"
    day1 = "2026-10-16"
    day2 = "2026-10-17"
    fee_id_1 = f"{uid}_{day1}"
    fee_id_2 = f"{uid}_{day2}"

    # Create two unpaid fees
    db.collection(COLLECTION_DRIVER_FEES).document(fee_id_1).set({
        "feeId": fee_id_1,
        "uid": uid,
        "serviceDate": day1,
        "weekId": week_id(day1),
        "fee_paise": 1000,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 1000,
        "status": "UNPAID",
        "version": 1,
    })
    db.collection(COLLECTION_DRIVER_FEES).document(fee_id_2).set({
        "feeId": fee_id_2,
        "uid": uid,
        "serviceDate": day2,
        "weekId": week_id(day2),
        "fee_paise": 1500,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 1500,
        "status": "UNPAID",
        "version": 1,
    })

    # Driver submits a batch paying 1000 for day1 and 1500 for day2
    batch_res = create_payment_batch(
        db,
        uid=uid,
        idempotency_key="idem_batch_001",
        allocations_input=[
            {"fee_id": fee_id_1, "amount_paise": 1000},
            {"fee_id": fee_id_2, "amount_paise": 1500},
        ],
        proof_data={
            "paymentReference": "UPI/TXN/998877",
            "paymentMethod": "upi",
            "proofDownloadUrl": "https://example.com/shot.png",
        },
        profile={"name": "Test Driver", "phone": "+919876543210"},
    )
    assert batch_res["ok"] is True
    batch = batch_res["batch"]
    batch_id = batch["batchId"]
    assert batch["total_paise"] == 2500

    # Verify fees are now UNDER_REVIEW
    snap1 = db.collection(COLLECTION_DRIVER_FEES).document(fee_id_1).get().to_dict()
    assert snap1["review_paise"] == 1000
    assert snap1["status"] == "UNDER_REVIEW"

    snap2 = db.collection(COLLECTION_DRIVER_FEES).document(fee_id_2).get().to_dict()
    assert snap2["review_paise"] == 1500
    assert snap2["status"] == "UNDER_REVIEW"

    # Admin APPROVES fee 1
    dec1 = decide_payment_allocation(
        db,
        batch_id=batch_id,
        fee_id=fee_id_1,
        decision="approve",
        note="UPI verified against bank statement",
        admin_user={"email": "admin@liphtup.com"},
    )
    assert dec1["allocation"]["status"] == "APPROVED"
    snap1_dec = db.collection(COLLECTION_DRIVER_FEES).document(fee_id_1).get().to_dict()
    assert snap1_dec["paid_paise"] == 1000
    assert snap1_dec["review_paise"] == 0
    assert snap1_dec["status"] == "PAID"

    # Admin DECLINES fee 2
    dec2 = decide_payment_allocation(
        db,
        batch_id=batch_id,
        fee_id=fee_id_2,
        decision="decline",
        note="Amount does not match screenshot",
        admin_user={"email": "admin@liphtup.com"},
    )
    assert dec2["allocation"]["status"] == "DECLINED"
    snap2_dec = db.collection(COLLECTION_DRIVER_FEES).document(fee_id_2).get().to_dict()
    assert snap2_dec["paid_paise"] == 0
    assert snap2_dec["review_paise"] == 0
    assert snap2_dec["status"] == "UNPAID"
    assert snap2_dec["remaining_paise"] == 1500

    # Attempting to decide already-decided allocation with mismatch raises 409
    with pytest.raises(ApiError) as exc_info:
        decide_payment_allocation(
            db,
            batch_id=batch_id,
            fee_id=fee_id_1,
            decision="decline",
            note="Conflicting decision",
            admin_user={"email": "admin@liphtup.com"},
        )
    assert exc_info.value.status_code == 409


def test_driver_fee_summary():
    db = InMemoryFirestore()
    uid = "drv_test_004"
    date_str = "2026-10-19"
    fee_id = f"{uid}_{date_str}"

    # Setup fee and daily stats
    db.collection(COLLECTION_DRIVER_FEES).document(fee_id).set({
        "feeId": fee_id,
        "uid": uid,
        "serviceDate": date_str,
        "distance_km": 18.75,
        "fee_paise": 1875,
        "paid_paise": 1000,
        "review_paise": 0,
        "remaining_paise": 875,
        "status": "PARTIAL",
        "due_at": "2026-10-25T23:59:59+05:30",
    })

    now = datetime.datetime(2026, 10, 20, 10, 0, 0, tzinfo=IST)
    summary = get_driver_fee_summary(db, uid, now=now)
    assert summary["payable_paise"] == 875
    assert summary["payable_inr"] == 8.75
    assert summary["restriction"]["is_restricted"] is False
    assert len(summary["fees"]) == 1
    assert summary["fees"][0]["serviceDate"] == date_str


def test_allocate_manual_fee_payment_partial_and_full():
    db = InMemoryFirestore()
    uid = "drv_manual_001"
    now = datetime.datetime(2026, 10, 20, 10, 0, 0, tzinfo=IST)

    fee1_id = f"{uid}_2026-10-18"
    fee2_id = f"{uid}_2026-10-19"

    # Day 1: 1000 paise
    db.collection(COLLECTION_DRIVER_FEES).document(fee1_id).set({
        "feeId": fee1_id,
        "uid": uid,
        "serviceDate": "2026-10-18",
        "weekId": "2026-W42",
        "distance_km": 10.0,
        "fee_paise": 1000,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 1000,
        "status": "UNPAID",
        "due_at": "2026-10-25T23:59:59+05:30",
    })
    # Day 2: 1500 paise
    db.collection(COLLECTION_DRIVER_FEES).document(fee2_id).set({
        "feeId": fee2_id,
        "uid": uid,
        "serviceDate": "2026-10-19",
        "weekId": "2026-W43",
        "distance_km": 15.0,
        "fee_paise": 1500,
        "paid_paise": 0,
        "review_paise": 0,
        "remaining_paise": 1500,
        "status": "UNPAID",
        "due_at": "2026-10-25T23:59:59+05:30",
    })

    # Allocate 1500 paise: Day 1 fully paid (1000 paise), Day 2 gets 500 paise
    res = allocate_manual_fee_payment(
        db,
        uid=uid,
        amount_paise=1500,
        payment_method="cash",
        payment_reference="Manual receipt #123",
        admin_email="admin@liphtup.com",
    )
    assert res["settled_total_paise"] == 1500
    assert len(res["allocations"]) == 2

    # Verify Day 1 is PAID
    f1 = db.collection(COLLECTION_DRIVER_FEES).document(fee1_id).get().to_dict()
    assert f1["status"] == "PAID"
    assert f1["paid_paise"] == 1000
    assert f1["remaining_paise"] == 0

    # Verify Day 2 is PARTIAL
    f2 = db.collection(COLLECTION_DRIVER_FEES).document(fee2_id).get().to_dict()
    assert f2["status"] == "PARTIAL"
    assert f2["paid_paise"] == 500
    assert f2["remaining_paise"] == 1000

    # Settle remaining dues with amount_paise=None (clears everything)
    res2 = allocate_manual_fee_payment(
        db,
        uid=uid,
        amount_paise=None,
        payment_method="cash",
        payment_reference="Settle rest",
        admin_email="admin@liphtup.com",
    )
    assert res2["settled_total_paise"] == 1000
    f2_cleared = db.collection(COLLECTION_DRIVER_FEES).document(fee2_id).get().to_dict()
    assert f2_cleared["status"] == "PAID"
    assert f2_cleared["remaining_paise"] == 0


def test_driver_fee_summary_with_under_review_items():
    db = InMemoryFirestore()
    uid = "drv_review_002"
    now = datetime.datetime(2026, 10, 20, 10, 0, 0, tzinfo=IST)

    fee_id = f"{uid}_2026-10-19"
    db.collection(COLLECTION_DRIVER_FEES).document(fee_id).set({
        "feeId": fee_id,
        "uid": uid,
        "serviceDate": "2026-10-19",
        "weekId": "2026-W43",
        "distance_km": 12.5,
        "fee_paise": 1250,
        "paid_paise": 0,
        "review_paise": 1250,
        "remaining_paise": 0,
        "status": "UNDER_REVIEW",
        "due_at": "2026-10-25T23:59:59+05:30",
    })

    batch_ref = db.collection(COLLECTION_FEE_PAYMENT_BATCHES).document("batch_rev_1")
    batch_ref.set({
        "batchId": "batch_rev_1",
        "uid": uid,
        "status": "PENDING",
        "total_paise": 1250,
        "created_at": now.isoformat(),
        "proofDownloadUrl": "https://storage.googleapis.com/proof.jpg",
    })
    batch_ref.collection("allocations").document(fee_id).set({
        "fee_id": fee_id,
        "serviceDate": "2026-10-19",
        "amount_paise": 1250,
        "status": "PENDING",
    })

    summary = get_driver_fee_summary(db, uid, now=now)
    assert len(summary["under_review_batches"]) == 1
    assert len(summary["under_review_items"]) == 1
    item = summary["under_review_items"][0]
    assert item["feeId"] == fee_id
    assert item["serviceDate"] == "2026-10-19"
    assert item["amount_inr"] == 12.5
    assert item["distance_km"] == 12.5
    assert item["status"] == "UNDER_REVIEW"


def test_sunday_fee_exception_in_actionable_reminders():
    # Sunday 2026-10-18 fee due_at must be pushed to next Sunday 2026-10-25
    sun_date = datetime.date(2026, 10, 18)
    due_dt = fee_due_at(sun_date)
    assert due_dt.strftime("%Y-%m-%d") == "2026-10-25"

    # For any reminder check evaluating this Sunday's immediate deadline (2026-10-18 23:59:59),
    # the Sunday fee has due_at > immediate deadline, so it is strictly not actionable
    immediate_deadline = datetime.datetime(2026, 10, 18, 23, 59, 59, tzinfo=IST)
    assert due_dt > immediate_deadline


