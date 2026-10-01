from __future__ import annotations

import json
from unittest.mock import MagicMock

from api.core import failures


def test_redact_sensitive_data_nested_dict() -> None:
    raw = {
        "userId": "usr_12345",
        "password": "SuperSecretPassword123!",
        "authToken": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "verification_pin": "5432",
        "nested": {
            "secretKey": "my-secret-key",
            "normalField": "safe text",
            "phone": "+919876543210",
            "email": "driver.tojo@liphtup.in",
        },
        "listItems": [
            {"apiKey": "AIzaSyD-1234567"},
            "Contact user at baibaswata@gmail.com or 9876543210",
        ],
    }

    cleaned = failures.redact_sensitive_data(raw)

    assert cleaned["userId"] == "usr_12345"
    assert cleaned["password"] == "[REDACTED]"
    assert cleaned["authToken"] == "[REDACTED]"
    assert cleaned["verification_pin"] == "[REDACTED]"
    assert cleaned["nested"]["secretKey"] == "[REDACTED]"
    assert cleaned["nested"]["normalField"] == "safe text"
    assert "9876543210" not in cleaned["nested"]["phone"]
    assert "driver.tojo@liphtup.in" not in cleaned["nested"]["email"]
    assert cleaned["listItems"][0]["apiKey"] == "[REDACTED]"
    assert "baibaswata@gmail.com" not in cleaned["listItems"][1]


def test_report_backend_failure_never_crashes_on_db_exception(monkeypatch) -> None:
    # Force Firestore to fail to verify failsafe fallback
    def failing_get_app():
        raise RuntimeError("Database connection timed out")

    monkeypatch.setattr("api.core.firebase.get_admin_app", failing_get_app)

    try:
        raise ValueError("Simulated unhandled transaction error with token=abc12345 secret=xyz")
    except Exception as exc:
        report = failures.report_backend_failure(
            service="wallet",
            operation="transfer_ride_fare",
            error=exc,
            severity="CRITICAL",
            actor_type="passenger",
            actor_id="user_abc123",
            resource_id="ride_xyz789",
            context={"attempt": 3, "amountPaise": 5000},
        )

    assert report["failureId"].startswith("fail_")
    assert report["service"] == "wallet"
    assert report["operation"] == "transfer_ride_fare"
    assert report["errorType"] == "ValueError"
    assert report["severity"] == "CRITICAL"
    assert report["status"] == "open"
    assert report["occurrenceCount"] == 1
    assert "fingerprint" in report
    assert "Database connection timed out" in report.get("dbPersistError", "")


def test_failure_fingerprint_deterministic() -> None:
    fp1 = failures.generate_failure_fingerprint("rides", "accept_ride", "ApiError", "rides.py:1500")
    fp2 = failures.generate_failure_fingerprint("rides", "accept_ride", "ApiError", "rides.py:1500")
    fp3 = failures.generate_failure_fingerprint("rides", "transition", "ApiError", "rides.py:1100")

    assert fp1 == fp2
    assert fp1 != fp3
    assert len(fp1) == 16
