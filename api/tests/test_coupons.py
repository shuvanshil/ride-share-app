"""
Unit and Integration tests for Ride Coupon System & Platform-Funded Subsidies.
Tests integer paise math, category eligibility, auto-suggestion priority ranking,
atomic transactions, driver wallet promotional credits, idempotency, mutual exclusivity,
and admin coupon management CRUD operations.
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from api.core.errors import ApiError
from api.core.coupon_service import (
    normalize_coupon_code,
    calculate_discount_paise,
    get_completed_rides_count,
    is_passenger_eligible_for_coupon,
    get_eligible_coupons_for_ride,
    apply_coupon_to_ride_tx,
    ensure_default_coupons,
)
from api.core.wallet_service import transfer_ride_fare
from api.routers.admin_coupons import (
    CreateCouponRequest,
    UpdateCouponRequest,
    create_admin_coupon,
    update_admin_coupon,
    activate_coupon,
    deactivate_coupon,
    delete_or_archive_coupon,
    list_admin_coupons,
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

    def get(self, transaction=None):
        return self.stream()

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

    def get(self, transaction=None):
        return self.stream()


class MockTransaction:
    def __init__(self, store: dict):
        self._store = store
        self._reads_completed = False
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

    def get(self, doc_ref_or_query):
        return doc_ref_or_query.get()

    def set(self, doc_ref, data, merge=False):
        self._reads_completed = True
        doc_ref.set(data, merge=merge)

    def update(self, doc_ref, data):
        self._reads_completed = True
        doc_ref.update(data)


class MockFirestoreDb:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def transaction(self):
        return MockTransaction(self.store)


class TestCouponSystem(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.db = MockFirestoreDb()
        self.admin = {"uid": "adm_1", "email": "admin@liphtup.in", "adminRole": "super_admin"}

    # 1. Normalization Tests
    def test_normalize_coupon_code(self):
        self.assertEqual(normalize_coupon_code("  welcome "), "WELCOME")
        self.assertEqual(normalize_coupon_code("super10"), "SUPER10")
        self.assertEqual(normalize_coupon_code(" fest_2026 "), "FEST_2026")
        self.assertEqual(normalize_coupon_code(""), "")
        self.assertEqual(normalize_coupon_code(None), "")

    # 2. Calculation Precision Tests
    def test_calculate_discount_fixed(self):
        # ₹50 fixed discount on ₹500 (50000 paise)
        discount = calculate_discount_paise(50000, "fixed", 50.0)
        self.assertEqual(discount, 5000) # ₹50.00

        # Fixed discount exceeds fare -> capped to fare
        discount_capped = calculate_discount_paise(50000, "fixed", 600.0)
        self.assertEqual(discount_capped, 50000)

    def test_calculate_discount_percentage(self):
        # 10% on ₹500 (50000 paise) = ₹50 (5000 paise)
        discount = calculate_discount_paise(50000, "percentage", 10.0)
        self.assertEqual(discount, 5000)

        # 15% on ₹127.50 (12750 paise) = 1912.5 -> rounded to 1913 paise (₹19.13)
        discount_round = calculate_discount_paise(12750, "percentage", 15.0)
        self.assertEqual(discount_round, 1913)

        # 100% on ₹100
        discount_full = calculate_discount_paise(10000, "percentage", 100.0)
        self.assertEqual(discount_full, 10000)

    # 3. Eligibility Tests
    def test_welcome_coupon_eligibility_first_3_rides(self):
        coupon = {
            "couponId": "coupon_default_welcome",
            "code": "WELCOME",
            "codeNormalized": "WELCOME",
            "eligibilityCategory": "first_ride",
            "usageLimitPerPassenger": 3,
            "status": "active",
        }
        # 1st ride (0 completed rides, 0 uses) -> Eligible
        is_el, _ = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=0, previous_redemptions_count=0)
        self.assertTrue(is_el)

        # 2nd ride (1 completed ride, 1 use) -> Eligible
        is_el2, _ = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=1, previous_redemptions_count=1)
        self.assertTrue(is_el2)

        # 3rd ride (2 completed rides, 2 uses) -> Eligible
        is_el3, _ = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=2, previous_redemptions_count=2)
        self.assertTrue(is_el3)

        # 4th ride onward (3 completed rides, even if 0 uses previously) -> Ineligible!
        is_el4, msg4 = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=3, previous_redemptions_count=0)
        self.assertFalse(is_el4)
        self.assertIn("first 3 completed rides", msg4)

        # 5th ride (4 completed rides) -> Ineligible
        is_el5, _ = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=4, previous_redemptions_count=1)
        self.assertFalse(is_el5)

        # Already used 3 times on earlier rides -> Ineligible
        is_el6, msg6 = is_passenger_eligible_for_coupon(coupon, "passenger_new", completed_rides_count=2, previous_redemptions_count=3)
        self.assertFalse(is_el6)
        self.assertIn("already used", msg6.lower())

    def test_tenth_ride_eligibility(self):
        coupon = {
            "couponId": "SUPER10",
            "eligibilityCategory": "tenth_ride",
            "status": "active",
        }
        # 10 completed rides (booking 11th) -> Eligible
        is_el, _ = is_passenger_eligible_for_coupon(coupon, "passenger_milestone", 10)
        self.assertTrue(is_el)
        # 9 completed rides -> Ineligible
        is_el2, _ = is_passenger_eligible_for_coupon(coupon, "passenger_9", 9)
        self.assertFalse(is_el2)
        # 11 completed rides -> Ineligible
        is_el3, _ = is_passenger_eligible_for_coupon(coupon, "passenger_11", 11)
        self.assertFalse(is_el3)

    def test_whitelist_user_restriction(self):
        coupon = {
            "couponId": "VIP50",
            "eligibilityCategory": "all_passengers",
            "restrictedPassengerIds": ["user_vip_1", "user_vip_2"],
            "status": "active",
        }
        is_el, _ = is_passenger_eligible_for_coupon(coupon, "user_vip_1", 5)
        self.assertTrue(is_el)
        is_el2, _ = is_passenger_eligible_for_coupon(coupon, "user_regular", 5)
        self.assertFalse(is_el2)

    # 4. Auto-Suggestion Deterministic Priority Ranking
    def test_suggestion_priority_ranking(self):
        ensure_default_coupons(self.db)
        # Add a custom 20% coupon
        self.db.collection("coupons").document("MEGA20").set({
            "couponId": "MEGA20",
            "code": "MEGA20",
            "codeNormalized": "MEGA20",
            "discountType": "percentage",
            "discountValue": 20.0,
            "eligibilityCategory": "all_passengers",
            "source": "admin",
            "status": "active",
            "createdAt": "2026-08-20T10:00:00Z",
        })

        # Set up active ride in db
        self.db.collection("rides").document("ride_1").set({
            "id": "ride_1",
            "passengerId": "p_new",
            "farePaise": 50000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })

        res = get_eligible_coupons_for_ride(self.db, "p_new", "ride_1")
        suggested = res.get("suggestedCoupon")

        self.assertIsNotNone(suggested)
        # WELCOME is default -> Ranked 1st
        self.assertEqual(suggested["code"], "WELCOME")

    # 5. Atomic Application & Financial Invariants
    def test_apply_coupon_atomic_tx(self):
        ensure_default_coupons(self.db)

        # Driver Wallet initialized with ₹200 (20000 paise)
        self.db.collection("wallets").document("driver_1").set({
            "userId": "driver_1",
            "userRole": "driver",
            "balancePaise": 20000,
            "status": "active",
            "lifetimeCreditPaise": 20000,
            "lifetimeDebitPaise": 0,
        })

        # Active Ride: ₹500 fare (50000 paise)
        self.db.collection("rides").document("ride_100").set({
            "id": "ride_100",
            "passengerId": "p_1",
            "driverId": "driver_1",
            "farePaise": 50000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })

        res = apply_coupon_to_ride_tx(
            self.db,
            passenger_id="p_1",
            ride_id="ride_100",
            coupon_code="WELCOME",
            idempotency_key="cr_test_100",
        )

        self.assertEqual(res["code"], "WELCOME")
        self.assertEqual(res["discountPaise"], 5000) # 10% of 500 = ₹50
        self.assertEqual(res["remainingFarePaise"], 45000) # ₹450

        # INVARIANT 1: Driver Wallet received +₹50 CREDIT without deducting driver earnings
        driver_wallet = self.db.collection("wallets").document("driver_1").get().to_dict()
        self.assertEqual(driver_wallet["balancePaise"], 25000) # 20000 + 5000

        # INVARIANT 2: Ledger entry recorded
        ledger_docs = [
            doc.to_dict() for doc in self.db.collection("walletTransactions").stream()
        ]
        self.assertEqual(len(ledger_docs), 1)
        self.assertEqual(ledger_docs[0]["type"], "COUPON_DISCOUNT_RECEIPT")
        self.assertEqual(ledger_docs[0]["direction"], "credit")
        self.assertEqual(ledger_docs[0]["amountPaise"], 5000)

        # INVARIANT 3: Ride document updated
        ride_doc = self.db.collection("rides").document("ride_100").get().to_dict()
        self.assertEqual(ride_doc["remainingFarePaise"], 45000)
        self.assertEqual(ride_doc["couponApplied"]["code"], "WELCOME")

    # 6. Idempotency Test
    def test_apply_coupon_idempotency(self):
        ensure_default_coupons(self.db)
        self.db.collection("wallets").document("driver_1").set({
            "userId": "driver_1",
            "userRole": "driver",
            "balancePaise": 10000,
            "status": "active",
        })
        self.db.collection("rides").document("ride_101").set({
            "id": "ride_101",
            "passengerId": "p_1",
            "driverId": "driver_1",
            "farePaise": 30000,
            "status": "accepted",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })

        res1 = apply_coupon_to_ride_tx(self.db, "p_1", "ride_101", "WELCOME", "idem_key_999")
        # Re-apply exact same idempotency key
        res2 = apply_coupon_to_ride_tx(self.db, "p_1", "ride_101", "WELCOME", "idem_key_999")

        self.assertEqual(res1["discountPaise"], res2["discountPaise"])
        # Driver balance credited exactly once!
        driver_wallet = self.db.collection("wallets").document("driver_1").get().to_dict()
        self.assertEqual(driver_wallet["balancePaise"], 13000) # 10000 + 3000 (10% of 30000)

    # 7. WELCOME Multi-Use and Non-WELCOME One-Time Redemption Enforcement
    def test_welcome_coupon_allows_up_to_3_uses_on_first_3_rides(self):
        ensure_default_coupons(self.db)
        self.db.collection("wallets").document("driver_1").set({
            "userId": "driver_1",
            "userRole": "driver",
            "balancePaise": 0,
            "status": "active",
        })

        # Ride 1 (0 completed rides) -> 1st WELCOME use
        self.db.collection("rides").document("ride_1").set({
            "id": "ride_1",
            "passengerId": "p_multi",
            "driverId": "driver_1",
            "farePaise": 20000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        res1 = apply_coupon_to_ride_tx(self.db, "p_multi", "ride_1", "WELCOME", "idem_w_1")
        self.assertEqual(res1["discountPaise"], 2000)
        # Complete ride 1
        self.db.collection("rides").document("ride_1").update({"status": "completed"})

        # Ride 2 (1 completed ride) -> 2nd WELCOME use
        self.db.collection("rides").document("ride_2").set({
            "id": "ride_2",
            "passengerId": "p_multi",
            "driverId": "driver_1",
            "farePaise": 30000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        res2 = apply_coupon_to_ride_tx(self.db, "p_multi", "ride_2", "WELCOME", "idem_w_2")
        self.assertEqual(res2["discountPaise"], 3000)
        # Complete ride 2
        self.db.collection("rides").document("ride_2").update({"status": "completed"})

        # Ride 3 (2 completed rides) -> 3rd WELCOME use
        self.db.collection("rides").document("ride_3").set({
            "id": "ride_3",
            "passengerId": "p_multi",
            "driverId": "driver_1",
            "farePaise": 40000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        res3 = apply_coupon_to_ride_tx(self.db, "p_multi", "ride_3", "WELCOME", "idem_w_3")
        self.assertEqual(res3["discountPaise"], 4000)
        # Complete ride 3
        self.db.collection("rides").document("ride_3").update({"status": "completed"})

        # Ride 4 (3 completed rides) -> 4th WELCOME attempt MUST FAIL!
        self.db.collection("rides").document("ride_4").set({
            "id": "ride_4",
            "passengerId": "p_multi",
            "driverId": "driver_1",
            "farePaise": 20000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        with self.assertRaises(ApiError) as ctx:
            apply_coupon_to_ride_tx(self.db, "p_multi", "ride_4", "WELCOME", "idem_w_4")
        self.assertTrue("first 3 completed rides" in str(ctx.exception.message).lower() or "already used" in str(ctx.exception.message).lower())

    def test_welcome_unused_opportunities_lost_from_4th_ride(self):
        ensure_default_coupons(self.db)
        self.db.collection("wallets").document("driver_1").set({
            "userId": "driver_1",
            "userRole": "driver",
            "balancePaise": 0,
            "status": "active",
        })

        # Passenger previously completed 3 rides without using WELCOME
        for i in range(1, 4):
            self.db.collection("rides").document(f"ride_old_{i}").set({
                "id": f"ride_old_{i}",
                "passengerId": "p_late",
                "status": "completed",
            })

        # 4th ride
        self.db.collection("rides").document("ride_4th").set({
            "id": "ride_4th",
            "passengerId": "p_late",
            "driverId": "driver_1",
            "farePaise": 20000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })

        with self.assertRaises(ApiError) as ctx:
            apply_coupon_to_ride_tx(self.db, "p_late", "ride_4th", "WELCOME", "idem_late")
        self.assertIn("first 3 completed rides", str(ctx.exception.message).lower())

    def test_other_coupons_remain_strictly_one_time_use(self):
        self.db.collection("coupons").document("SAVE20").set({
            "couponId": "SAVE20",
            "code": "SAVE20",
            "codeNormalized": "SAVE20",
            "discountType": "fixed",
            "discountValue": 20.0,
            "discountAmountPaise": 2000,
            "eligibilityCategory": "all_passengers",
            "usageLimitPerPassenger": 1,
            "source": "admin",
            "status": "active",
        })
        self.db.collection("wallets").document("driver_1").set({
            "userId": "driver_1",
            "userRole": "driver",
            "balancePaise": 0,
            "status": "active",
        })

        # 1st use of SAVE20
        self.db.collection("rides").document("ride_save_1").set({
            "id": "ride_save_1",
            "passengerId": "p_save",
            "driverId": "driver_1",
            "farePaise": 20000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        apply_coupon_to_ride_tx(self.db, "p_save", "ride_save_1", "SAVE20", "idem_s1")
        self.db.collection("rides").document("ride_save_1").update({"status": "completed"})

        # 2nd attempt of SAVE20 -> Must fail!
        self.db.collection("rides").document("ride_save_2").set({
            "id": "ride_save_2",
            "passengerId": "p_save",
            "driverId": "driver_1",
            "farePaise": 20000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
        })
        with self.assertRaises(ApiError) as ctx:
            apply_coupon_to_ride_tx(self.db, "p_save", "ride_save_2", "SAVE20", "idem_s2")
        self.assertIn("already used", str(ctx.exception.message).lower())

    # 8. Mutual Exclusivity Tests (Coupon OR Wallet Credits)
    def test_mutual_exclusivity_coupon_blocks_wallet(self):
        ensure_default_coupons(self.db)
        self.db.collection("wallets").document("d_1").set({
            "userId": "d_1",
            "userRole": "driver",
            "balancePaise": 0,
            "status": "active",
        })
        self.db.collection("wallets").document("p_excl").set({
            "userId": "p_excl",
            "userRole": "passenger",
            "balancePaise": 10000,
            "status": "active",
        })

        # Ride has coupon applied
        self.db.collection("rides").document("ride_excl").set({
            "id": "ride_excl",
            "passengerId": "p_excl",
            "driverId": "d_1",
            "farePaise": 50000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
            "couponApplied": {"code": "WELCOME", "discountPaise": 5000},
            "remainingFarePaise": 45000,
        })

        # Attempt to transfer wallet credits on ride with coupon -> Fails!
        with self.assertRaises(ApiError) as ctx:
            transfer_ride_fare(self.db, "p_excl", "ride_excl", 5000, "idem_w_fail")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("coupon", str(ctx.exception.message).lower())

    def test_mutual_exclusivity_wallet_blocks_coupon(self):
        ensure_default_coupons(self.db)
        self.db.collection("wallets").document("d_1").set({
            "userId": "d_1",
            "userRole": "driver",
            "balancePaise": 0,
            "status": "active",
        })

        # Ride already has wallet credits applied
        self.db.collection("rides").document("ride_w_applied").set({
            "id": "ride_w_applied",
            "passengerId": "p_2",
            "driverId": "d_1",
            "farePaise": 50000,
            "status": "started",
            "pinVerifiedAt": "2026-08-29T12:00:00Z",
            "walletPaidAmountPaise": 10000,
            "remainingFarePaise": 40000,
        })

        # Attempt to apply coupon on ride with wallet credits -> Fails!
        with self.assertRaises(ApiError) as ctx:
            apply_coupon_to_ride_tx(self.db, "p_2", "ride_w_applied", "WELCOME", "idem_excl_w")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("wallet", str(ctx.exception.message).lower())

    # 9. Admin Operations Tests
    async def test_admin_crud_lifecycle(self):
        ensure_default_coupons(self.db)

        # A. Create custom coupon
        create_req = CreateCouponRequest(
            code="FESTIVE50",
            discountType="fixed",
            discountValue=50.0,
            eligibilityCategory="all_passengers",
            description="Festive bonus",
        )
        with patch("api.routers.admin_coupons.write_audit_log") as mock_audit:
            res_create = await create_admin_coupon(create_req, admin=self.admin, db=self.db)
            self.assertTrue(res_create["ok"])
            coupon_id = res_create["couponId"]
            self.assertEqual(res_create["code"], "FESTIVE50")
            mock_audit.assert_called_once()

        # B. Deactivate coupon
        with patch("api.routers.admin_coupons.write_audit_log") as mock_audit:
            res_deact = await deactivate_coupon(coupon_id, admin=self.admin, db=self.db)
            self.assertTrue(res_deact["ok"])
            doc = self.db.collection("coupons").document(coupon_id).get().to_dict()
            self.assertEqual(doc["status"], "inactive")
            mock_audit.assert_called_once()

        # C. Reactivate coupon
        with patch("api.routers.admin_coupons.write_audit_log") as mock_audit:
            res_act = await activate_coupon(coupon_id, admin=self.admin, db=self.db)
            self.assertTrue(res_act["ok"])
            doc = self.db.collection("coupons").document(coupon_id).get().to_dict()
            self.assertEqual(doc["status"], "active")
            mock_audit.assert_called_once()

        # D. Delete/Archive coupon
        with patch("api.routers.admin_coupons.write_audit_log") as mock_audit:
            res_del = await delete_or_archive_coupon(coupon_id, admin=self.admin, db=self.db)
            self.assertTrue(res_del["ok"])
            doc = self.db.collection("coupons").document(coupon_id).get().to_dict()
            self.assertEqual(doc["status"], "deleted")
            self.assertTrue(doc["isDeleted"])
            mock_audit.assert_called_once()

        # E. Default coupon deletion rejection
        with self.assertRaises(ApiError) as ctx:
            await delete_or_archive_coupon("coupon_default_welcome", admin=self.admin, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
