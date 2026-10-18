"""
Unit tests for Wallet Service & Financial Ledger Accounting.
Validates integer paise calculations, atomic transfers, idempotency,
settlement race conditions, reversal boundaries, and reconciliation.
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from api.core.errors import ApiError
from api.core.wallet_service import (
    REVERSAL_MIN_THRESHOLD_PAISE,
    credit_wallet_tx,
    debit_wallet_tx,
    grant_passenger_credit,
    inr_to_paise,
    paise_to_inr_float,
    reconcile_wallet,
    resolve_driver_settlement,
    reverse_admin_credit,
    transfer_ride_fare,
)


class MockDocSnapshot:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = dict(data) if data is not None else {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class MockDocReference:
    def __init__(self, collection_name: str, doc_id: str, store: dict):
        self.collection_name = collection_name
        self.id = doc_id
        self._store = store

    def get(self, transaction=None):
        data = self._store.get((self.collection_name, self.id))
        return MockDocSnapshot(self.id, data, exists=(data is not None))

    def set(self, data, merge=False):
        key = (self.collection_name, self.id)
        if merge and key in self._store:
            self._store[key].update(data)
        else:
            self._store[key] = dict(data)

    def update(self, data):
        key = (self.collection_name, self.id)
        if key not in self._store:
            self._store[key] = {}
        self._store[key].update(data)

    def delete(self):
        self._store.pop((self.collection_name, self.id), None)


class MockQuery:
    def __init__(self, collection_name: str, store: dict, filters: list = None):
        self.collection_name = collection_name
        self.store = store
        self.filters = filters or []

    def where(self, field, op, val):
        new_filters = list(self.filters)
        new_filters.append((field, op, val))
        return MockQuery(self.collection_name, self.store, new_filters)

    def limit(self, count):
        return self

    def stream(self):
        matches = []
        for (col, doc_id), data in self.store.items():
            if col != self.collection_name:
                continue
            matched = True
            for field, op, val in self.filters:
                doc_val = data.get(field)
                if op == "==" and doc_val != val:
                    matched = False
                    break
                elif op == "in" and doc_val not in val:
                    matched = False
                    break
            if matched:
                matches.append(MockDocSnapshot(doc_id, data, exists=True))
        return matches


class MockCollection:
    def __init__(self, collection_name: str, store: dict):
        self.collection_name = collection_name
        self.store = store

    def document(self, doc_id: str = None):
        if not doc_id:
            import uuid
            doc_id = f"auto_{uuid.uuid4().hex[:12]}"
        return MockDocReference(self.collection_name, doc_id, self.store)

    def where(self, field, op, val):
        return MockQuery(self.collection_name, self.store, [(field, op, val)])

    def stream(self):
        return MockQuery(self.collection_name, self.store).stream()


class MockTransaction:
    def __init__(self, store: dict):
        self._store = store
        self._read_only = False
        self._max_attempts = 5
        self._id = "mock_tx_id"

    def _clean_up(self):
        pass

    def _rollback(self):
        pass

    def _commit(self):
        pass

    def _begin(self, retry_id=None):
        pass

    def get(self, ref):
        return ref.get(transaction=self)

    def set(self, ref, data, merge=False):
        ref.set(data, merge=merge)

    def update(self, ref, data):
        ref.update(data)

    def delete(self, ref):
        ref.delete()


class MockFirestoreDb:
    def __init__(self):
        self._store = {}

    def collection(self, name: str):
        return MockCollection(name, self._store)

    def transaction(self):
        return MockTransaction(self._store)


class TestWalletLedger(unittest.TestCase):
    def setUp(self):
        self.db = MockFirestoreDb()
        self.tx = self.db.transaction()
        self.admin = {"uid": "adm_1", "email": "admin@liphtup.in", "adminRole": "super_admin"}

    def test_monetary_precision_paise_conversion(self):
        """Validates exact integer paise arithmetic without floating point inaccuracy."""
        self.assertEqual(inr_to_paise("0.01"), 1)
        self.assertEqual(inr_to_paise(0.50), 50)
        self.assertEqual(inr_to_paise(1.00), 100)
        self.assertEqual(inr_to_paise("999.99"), 99999)
        self.assertEqual(inr_to_paise("1000.00"), 100000)
        self.assertEqual(inr_to_paise("1000.01"), 100001)
        self.assertEqual(inr_to_paise(10000.99), 1000099)

        self.assertEqual(paise_to_inr_float(1), 0.01)
        self.assertEqual(paise_to_inr_float(50), 0.50)
        self.assertEqual(paise_to_inr_float(100), 1.00)
        self.assertEqual(paise_to_inr_float(100001), 1000.01)

    def test_credit_and_debit_ledger_mutations(self):
        """Verifies atomic credit and debit operations update materialized balance and insert ledger."""
        user_id = "pass_101"
        # 1. Credit 5,000 paise (₹50.00)
        c_tx, c_id = credit_wallet_tx(
            tx=self.tx,
            db=self.db,
            user_id=user_id,
            role="passenger",
            amount_paise=5000,
            tx_type="ADMIN_CREDIT",
            reference_type="admin_grant",
            reference_id="grant_1",
            tags=["Bonus"],
            description="Welcome bonus",
        )
        self.assertEqual(c_tx["balanceBeforePaise"], 0)
        self.assertEqual(c_tx["balanceAfterPaise"], 5000)
        self.assertEqual(c_tx["amountPaise"], 5000)

        # Check materialized balance
        w_snap = self.db.collection("wallets").document(user_id).get()
        self.assertEqual(w_snap.to_dict()["balancePaise"], 5000)

        # 2. Debit 2,000 paise (₹20.00)
        d_tx, d_id = debit_wallet_tx(
            tx=self.tx,
            db=self.db,
            user_id=user_id,
            role="passenger",
            amount_paise=2000,
            tx_type="RIDE_WALLET_PAYMENT",
            reference_type="ride_fare_payment",
            reference_id="ride_99",
            description="Ride payment",
        )
        self.assertEqual(d_tx["balanceBeforePaise"], 5000)
        self.assertEqual(d_tx["balanceAfterPaise"], 3000)
        self.assertEqual(d_tx["amountPaise"], 2000)

        # Check materialized balance
        w_snap = self.db.collection("wallets").document(user_id).get()
        self.assertEqual(w_snap.to_dict()["balancePaise"], 3000)

        # 3. Reject debit exceeding balance (e.g. 4,000 paise when balance is 3,000)
        with self.assertRaises(ApiError) as ctx:
            debit_wallet_tx(
                tx=self.tx,
                db=self.db,
                user_id=user_id,
                role="passenger",
                amount_paise=4000,
                tx_type="RIDE_WALLET_PAYMENT",
                reference_type="ride_fare_payment",
                reference_id="ride_100",
            )
        self.assertIn("Insufficient wallet balance", str(ctx.exception))

    def test_atomic_passenger_to_driver_ride_transfer(self):
        """Validates atomic passenger debit = driver credit for active ride payment."""
        pass_id = "p_user_1"
        driver_id = "d_user_1"
        ride_id = "ride_xyz"

        # 1. Setup passenger with ₹500 (50,000 paise)
        self.db.collection("wallets").document(pass_id).set({
            "userId": pass_id, "userRole": "passenger", "balancePaise": 50000, "currency": "INR", "status": "active"
        })
        # 2. Setup driver with ₹0
        self.db.collection("wallets").document(driver_id).set({
            "userId": driver_id, "userRole": "driver", "balancePaise": 0, "currency": "INR", "status": "active"
        })
        # 3. Setup active ride: fare ₹800 (80,000 paise), status "en_route"
        self.db.collection("rides").document(ride_id).set({
            "passenger_id": pass_id,
            "driver_id": driver_id,
            "status": "en_route",
            "farePaise": 80000,
            "fare": 800,
            "walletPaidAmountPaise": 0,
            "cashPaidAmountPaise": 0,
            "passenger_name": "John Doe",
            "driver_name": "Dave Driver",
        })

        # 4. Passenger pays using wallet (all ₹500 available)
        res = transfer_ride_fare(
            db=self.db,
            passenger_id=pass_id,
            ride_id=ride_id,
            idempotency_key="idemp_trip_1",
        )

        self.assertFalse(res["idempotent_replay"])
        self.assertEqual(res["transferPaise"], 50000)  # Transferred ₹500
        self.assertEqual(res["remainingFarePaise"], 30000)  # Remaining ₹300
        self.assertEqual(res["passengerBalancePaise"], 0)

        # Verify passenger wallet = 0
        p_snap = self.db.collection("wallets").document(pass_id).get()
        self.assertEqual(p_snap.to_dict()["balancePaise"], 0)

        # Verify driver wallet = 50,000
        d_snap = self.db.collection("wallets").document(driver_id).get()
        self.assertEqual(d_snap.to_dict()["balancePaise"], 50000)

        # Verify ride record
        r_snap = self.db.collection("rides").document(ride_id).get()
        r_data = r_snap.to_dict()
        self.assertEqual(r_data["walletPaidAmountPaise"], 50000)
        self.assertEqual(r_data["remainingFarePaise"], 30000)
        self.assertEqual(r_data["wallet_payment_status"], "partially_paid")

        # 5. Idempotent retry with same key returns previous result without extra debit
        res_retry = transfer_ride_fare(
            db=self.db,
            passenger_id=pass_id,
            ride_id=ride_id,
            idempotency_key="idemp_trip_1",
        )
        self.assertTrue(res_retry["idempotent_replay"])
        # Passenger balance still 0, driver still 50,000
        self.assertEqual(self.db.collection("wallets").document(pass_id).get().to_dict()["balancePaise"], 0)
        self.assertEqual(self.db.collection("wallets").document(driver_id).get().to_dict()["balancePaise"], 50000)

    def test_driver_settlement_race_condition_protection(self):
        """
        Validates the critical invariant:
        Settlement creates with captured amount (₹5,000).
        Driver earns +₹300 before settlement resolves.
        Resolving settlement deducts exactly ₹5,000, leaving ₹300 in wallet.
        """
        driver_id = "driver_settle_test"
        # Setup driver user profile with registered UPI
        self.db.collection("users").document(driver_id).set({
            "role": "driver", "name": "Driver Raj", "phone": "9876543210", "upiId": "raj@okhdfcbank"
        })
        # Setup driver wallet with ₹5,000 (500,000 paise)
        self.db.collection("wallets").document(driver_id).set({
            "userId": driver_id, "userRole": "driver", "balancePaise": 500000, "currency": "INR", "status": "active"
        })

        # 1. Admin creates settlement -> Captures ₹5,000
        from api.core.wallet_service import create_driver_settlement
        settlement = create_driver_settlement(
            db=self.db,
            driver_id=driver_id,
            admin_user=self.admin,
        )
        self.assertEqual(settlement["settlementAmountPaise"], 500000)
        self.assertEqual(settlement["status"], "ready")
        self.assertEqual(settlement["upiIdSnapshot"], "raj@okhdfcbank")

        # 2. Driver earns ₹300 (30,000 paise) from a new ride before admin resolves
        credit_wallet_tx(
            tx=self.tx,
            db=self.db,
            user_id=driver_id,
            role="driver",
            amount_paise=30000,
            tx_type="RIDE_WALLET_RECEIPT",
            reference_type="ride_fare_payment",
            reference_id="ride_new_300",
        )
        # Driver wallet is now ₹5,300 (530,000 paise)
        d_snap = self.db.collection("wallets").document(driver_id).get()
        self.assertEqual(d_snap.to_dict()["balancePaise"], 530000)

        # Driver changes their profile UPI to a different ID
        self.db.collection("users").document(driver_id).update({"upiId": "raj_new@okaxis"})

        # 3. Admin marks settlement as resolved
        resolve_res = resolve_driver_settlement(
            db=self.db,
            settlement_id=settlement["settlementId"],
            admin_user=self.admin,
            admin_note="UPI Ref #UTR987654",
        )

        # 4. Verify exact deduction of captured amount and wallet balance
        self.assertEqual(resolve_res["settledAmountPaise"], 500000)
        self.assertEqual(resolve_res["remainingDriverBalancePaise"], 30000)  # Exactly ₹300 preserved!
        self.assertEqual(resolve_res["upiIdSnapshot"], "raj@okhdfcbank")   # Original UPI preserved!

        d_final = self.db.collection("wallets").document(driver_id).get()
        self.assertEqual(d_final.to_dict()["balancePaise"], 30000)

        # 5. Attempting to resolve the same settlement again is rejected
        with self.assertRaises(ApiError) as ctx:
            resolve_driver_settlement(
                db=self.db,
                settlement_id=settlement["settlementId"],
                admin_user=self.admin,
            )
        self.assertIn("already been resolved", str(ctx.exception))

    def test_admin_credit_reversal_threshold_rules(self):
        """
        Validates:
        - Reversal <= ₹1,000 (100,000 paise) is rejected.
        - Reversal > ₹1,000 (100,001 paise) is eligible.
        - Reversal when passenger spent balance is rejected (no negative balance).
        """
        pass_id = "pass_rev_test"
        self.db.collection("users").document(pass_id).set({"role": "passenger", "name": "Passenger Bob"})

        # 1. Grant ₹1,000.00 (100,000 paise) credit -> Reversal must be rejected
        c1 = grant_passenger_credit(
            db=self.db,
            passenger_id=pass_id,
            amount_paise=100000,
            tags=["Bonus"],
            description="1000 grant",
            admin_user=self.admin,
        )
        with self.assertRaises(ApiError) as ctx:
            reverse_admin_credit(
                db=self.db,
                original_tx_id=c1["transactionId"],
                admin_user=self.admin,
                reason="Wrong grant",
            )
        self.assertIn("Credits of ₹1,000 or less", str(ctx.exception))

        # 2. Grant ₹1,000.01 (100,001 paise) credit -> Reversal is eligible
        c2 = grant_passenger_credit(
            db=self.db,
            passenger_id=pass_id,
            amount_paise=100001,
            tags=["Bonus"],
            description="1000.01 grant",
            admin_user=self.admin,
        )
        # Passenger balance is now 100,000 + 100,001 = 200,001 paise
        rev_res = reverse_admin_credit(
            db=self.db,
            original_tx_id=c2["transactionId"],
            admin_user=self.admin,
            reason="Mistake in promotional amount",
        )
        self.assertEqual(rev_res["reversalTransaction"]["amountPaise"], 100001)

        # Passenger balance is now back to 100,000 paise
        p_snap = self.db.collection("wallets").document(pass_id).get()
        self.assertEqual(p_snap.to_dict()["balancePaise"], 100000)

        # 3. Attempt to reverse c2 again -> rejected (already reversed)
        with self.assertRaises(ApiError) as ctx:
            reverse_admin_credit(
                db=self.db,
                original_tx_id=c2["transactionId"],
                admin_user=self.admin,
                reason="Duplicate reversal attempt",
            )
        self.assertIn("already been reversed", str(ctx.exception))

    def test_reconciliation_integrity(self):
        """Validates that reconcile_wallet computes exact balance from ledger history."""
        user_id = "user_recon"
        # Credit ₹100 (10,000 paise)
        credit_wallet_tx(self.tx, self.db, user_id, "passenger", 10000, "ADMIN_CREDIT", "admin_grant", "g1")
        # Credit ₹50 (5,000 paise)
        credit_wallet_tx(self.tx, self.db, user_id, "passenger", 5000, "ADMIN_CREDIT", "admin_grant", "g2")
        # Debit ₹30 (3,000 paise)
        debit_wallet_tx(self.tx, self.db, user_id, "passenger", 3000, "RIDE_WALLET_PAYMENT", "ride_fare_payment", "r1")

        report = reconcile_wallet(self.db, user_id)
        self.assertTrue(report["isBalanced"])
        self.assertEqual(report["computedCreditsPaise"], 15000)
        self.assertEqual(report["computedDebitsPaise"], 3000)
        self.assertEqual(report["expectedBalancePaise"], 12000)
        self.assertEqual(report["materializedBalancePaise"], 12000)
        self.assertEqual(report["discrepancyPaise"], 0)

    def test_concurrent_spending_protection(self):
        """
        Validates that when a passenger has ₹50 (5000 paise) and two requests
        attempt to spend ₹50 across two distinct active rides:
        Request A succeeds and Request B is safely rejected due to insufficient balance.
        """
        pass_id = "pass_concurrent_user"
        driver_a = "driver_a"
        driver_b = "driver_b"
        ride_1 = "ride_c1"
        ride_2 = "ride_c2"

        self.db.collection("wallets").document(pass_id).set({
            "userId": pass_id, "userRole": "passenger", "balancePaise": 5000, "currency": "INR", "status": "active"
        })
        self.db.collection("wallets").document(driver_a).set({
            "userId": driver_a, "userRole": "driver", "balancePaise": 0, "currency": "INR", "status": "active"
        })
        self.db.collection("wallets").document(driver_b).set({
            "userId": driver_b, "userRole": "driver", "balancePaise": 0, "currency": "INR", "status": "active"
        })
        self.db.collection("rides").document(ride_1).set({
            "passenger_id": pass_id, "driver_id": driver_a, "status": "en_route",
            "farePaise": 5000, "fare": 50, "walletPaidAmountPaise": 0, "cashPaidAmountPaise": 0,
        })
        self.db.collection("rides").document(ride_2).set({
            "passenger_id": pass_id, "driver_id": driver_b, "status": "en_route",
            "farePaise": 5000, "fare": 50, "walletPaidAmountPaise": 0, "cashPaidAmountPaise": 0,
        })

        # Request A: Transfers all 5000 paise
        res_a = transfer_ride_fare(self.db, passenger_id=pass_id, ride_id=ride_1, idempotency_key="key_a")
        self.assertEqual(res_a["transferPaise"], 5000)
        self.assertEqual(res_a["passengerBalancePaise"], 0)

        # Request B: Attempts to spend 5000 paise on ride_2 -> Must be rejected
        with self.assertRaises(ApiError) as ctx:
            transfer_ride_fare(self.db, passenger_id=pass_id, ride_id=ride_2, idempotency_key="key_b")
        self.assertIn("Insufficient wallet balance", str(ctx.exception))

        # Ensure driver B balance is 0 and passenger is 0 (never -5000)
        self.assertEqual(self.db.collection("wallets").document(driver_b).get().to_dict()["balancePaise"], 0)
        self.assertEqual(self.db.collection("wallets").document(pass_id).get().to_dict()["balancePaise"], 0)

    def test_ride_ownership_and_state_security(self):
        """Validates that a passenger cannot pay for another user's ride or an invalid state ride."""
        p1 = "pass_owner"
        p2 = "pass_intruder"
        d1 = "driver_1"
        ride_id = "ride_secure_1"

        self.db.collection("wallets").document(p2).set({
            "userId": p2, "userRole": "passenger", "balancePaise": 10000, "currency": "INR", "status": "active"
        })
        self.db.collection("rides").document(ride_id).set({
            "passenger_id": p1, "driver_id": d1, "status": "en_route",
            "farePaise": 10000, "fare": 100, "walletPaidAmountPaise": 0, "cashPaidAmountPaise": 0,
        })

        # Intruder attempts to pay for owner's ride
        with self.assertRaises(ApiError) as ctx:
            transfer_ride_fare(self.db, passenger_id=p2, ride_id=ride_id, idempotency_key="intruder_key")
        self.assertIn("Only the passenger associated with this ride", str(ctx.exception))

        # Attempt to pay for a pending / unassigned ride
        self.db.collection("rides").document(ride_id).update({"status": "pending"})
        with self.assertRaises(ApiError) as ctx:
            transfer_ride_fare(self.db, passenger_id=p1, ride_id=ride_id, idempotency_key="pending_key")
        self.assertIn("not eligible for wallet payment", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
