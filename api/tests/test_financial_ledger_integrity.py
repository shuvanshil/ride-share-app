from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.core import coupon_service, wallet_service
from api.core.errors import ApiError


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

    def stream(self, transaction=None):
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
        self.store = store

    def update(self, doc_ref, data):
        doc_ref.update(data)

    def set(self, doc_ref, data, merge=False):
        doc_ref.set(data, merge=merge)

    def delete(self, doc_ref):
        doc_ref.delete()


class MockFirestoreClient:
    def __init__(self):
        self.store = {}

    def collection(self, name: str):
        return MockCollection(name, self.store)

    def transaction(self):
        return MockTransaction(self.store)


def test_integer_paise_conversions_exact() -> None:
    assert wallet_service.inr_to_paise("140") == 14000
    assert wallet_service.inr_to_paise("140.50") == 14050
    assert wallet_service.inr_to_paise(140.75) == 14075
    assert wallet_service.inr_to_paise("0.05") == 5
    assert wallet_service.paise_to_inr_float(14050) == 140.50
    assert wallet_service.paise_to_inr_float(5) == 0.05


def test_coupon_discount_calculation_exact() -> None:
    # 10% on ₹150 (15000 paise) = 1500 paise (₹15.00)
    disc = coupon_service.calculate_discount_paise(15000, "percentage", 10.0)
    assert disc == 1500

    # Fixed ₹30 on ₹150 (15000 paise) = 3000 paise (₹30.00)
    disc_fixed = coupon_service.calculate_discount_paise(15000, "fixed", 30.0)
    assert disc_fixed == 3000

    # Discount capped at total fare
    disc_capped = coupon_service.calculate_discount_paise(2000, "fixed", 50.0)
    assert disc_capped == 2000


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
def test_mutual_exclusivity_coupon_after_wallet_fails() -> None:
    db = MockFirestoreClient()
    db.collection("coupons").document("coupon_default_welcome").set({
        "code": "WELCOME",
        "codeNormalized": "WELCOME",
        "status": "active",
        "discountType": "percentage",
        "discountValue": 10,
        "eligibilityCategory": "first_ride",
    })
    db.collection("rides").document("ride_999").set({
        "status": "started",
        "passenger_id": "pass_1",
        "driver_id": "drv_1",
        "farePaise": 20000,
        "walletPaidAmountPaise": 5000,  # Wallet was already used
    })

    with pytest.raises(ApiError) as exc_info:
        coupon_service.apply_coupon_to_ride_tx(
            db=db,
            passenger_id="pass_1",
            ride_id="ride_999",
            coupon_code="WELCOME",
        )

    assert exc_info.value.status_code == 400
    assert "Wallet credits have already been applied" in exc_info.value.message


@patch("firebase_admin.firestore.transactional", lambda fn: fn)
def test_mutual_exclusivity_wallet_after_coupon_fails() -> None:
    db = MockFirestoreClient()
    db.collection("rides").document("ride_888").set({
        "status": "started",
        "passenger_id": "pass_1",
        "driver_id": "drv_1",
        "farePaise": 20000,
        "couponApplied": {"code": "WELCOME", "discountPaise": 2000},
    })
    db.collection("wallets").document("pass_1").set({
        "balancePaise": 10000,
        "status": "active",
    })

    with pytest.raises(ApiError) as exc_info:
        wallet_service.transfer_ride_fare(
            db=db,
            passenger_id="pass_1",
            ride_id="ride_888",
        )

    assert exc_info.value.status_code == 400
    assert "promotional coupon has already been applied" in exc_info.value.message
