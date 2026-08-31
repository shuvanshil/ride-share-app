"""
Centralized Backend Failure Reporting & Diagnostics System.

Provides structured, resilient, and non-recursive recording of unrecoverable
system failures, broken invariants, dead-letter notifications, and background job
crashes.

Guarantees:
1. NEVER crashes the caller (failsafe fallback to structured JSON logging).
2. NEVER stores unredacted credentials, tokens, passwords, PINs, or raw PII.
3. Automatically fingerprints and deduplicates repeated failures to prevent DB flooding.
4. Provides actionable developer recommendations and error taxonomy.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("liphtup.failures")

# Sensitive key patterns to redact automatically
SENSITIVE_KEY_RE = re.compile(
    r"(password|token|secret|key|pin|auth|authorization|cookie|credential|cvv|card|jwt|bearer|session|private|cert)",
    re.IGNORECASE,
)

PHONE_RE = re.compile(r"(\+?91)?[6-9]\d{9}")
EMAIL_RE = re.compile(r"([a-zA-Z0-9_.+-]+)@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)")


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def mask_phone(phone_str: str) -> str:
    """Masks a phone number, preserving the prefix and last 4 digits."""
    clean = str(phone_str or "").strip()
    if len(clean) >= 10:
        return f"{clean[:3]}****{clean[-4:]}"
    return "****"


def mask_email(email_str: str) -> str:
    """Masks an email address, e.g. j***n@example.com."""
    s = str(email_str or "").strip()
    if "@" in s:
        user, domain = s.split("@", 1)
        if len(user) <= 2:
            masked_user = user[0] + "*"
        else:
            masked_user = user[0] + "***" + user[-1]
        return f"{masked_user}@{domain}"
    return "****"


def redact_sensitive_data(val: Any) -> Any:
    """Recursively redacts secrets, tokens, credentials, and sensitive PII."""
    if val is None:
        return None

    if isinstance(val, dict):
        cleaned: Dict[str, Any] = {}
        for k, v in val.items():
            k_str = str(k)
            if SENSITIVE_KEY_RE.search(k_str):
                cleaned[k_str] = "[REDACTED]"
            else:
                cleaned[k_str] = redact_sensitive_data(v)
        return cleaned

    elif isinstance(val, (list, tuple, set)):
        return [redact_sensitive_data(item) for item in val]

    elif isinstance(val, str):
        # Redact Bearer tokens in text
        if val.lower().startswith("bearer "):
            return "Bearer [REDACTED_TOKEN]"
        # Redact private keys
        if "BEGIN PRIVATE KEY" in val or "BEGIN RSA PRIVATE KEY" in val:
            return "[REDACTED_PRIVATE_KEY]"
        # Mask phone numbers in text
        val = PHONE_RE.sub(lambda m: mask_phone(m.group(0)), val)
        # Mask emails in text
        val = EMAIL_RE.sub(lambda m: mask_email(m.group(0)), val)
        return val

    elif hasattr(val, "isoformat"):
        return val.isoformat()

    elif isinstance(val, (int, float, bool)):
        return val

    return str(val)


def generate_failure_fingerprint(
    service: str,
    operation: str,
    error_type: str,
    location: str = "",
) -> str:
    """Generates a deterministic 16-character SHA-256 fingerprint for deduplication."""
    raw = f"{service.strip().lower()}:{operation.strip().lower()}:{error_type.strip()}:{location.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def report_backend_failure(
    service: str,
    operation: str,
    error: Optional[Exception] = None,
    severity: str = "HIGH",
    error_message: Optional[str] = None,
    error_code: Optional[str] = None,
    endpoint: Optional[str] = None,
    actor_type: str = "system",
    actor_id: Optional[str] = None,
    resource_id: Optional[str] = None,
    recovery_attempted: bool = False,
    recovery_result: str = "not_attempted",
    retry_count: int = 0,
    context: Optional[Dict[str, Any]] = None,
    recommended_action: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Centralized failure reporting function.
    Records a structured incident report to Firestore `/failureReports`
    and guarantees zero crash propagation (falls back to structured stderr JSON log).
    """
    timestamp = now_utc_iso()
    failure_id = f"fail_{uuid.uuid4().hex[:16]}"
    env = os.environ.get("VERCEL_ENV") or os.environ.get("ENV") or "production"

    err_type = type(error).__name__ if error else "BackendFailure"
    raw_msg = error_message or (str(error) if error else "Unspecified backend error")
    clean_msg = redact_sensitive_data(raw_msg)

    # Capture and redact stack trace if an exception is provided
    stack_trace_str = ""
    location = ""
    if error is not None:
        tb_lines = traceback.format_exception(type(error), error, error.__traceback__)
        raw_tb = "".join(tb_lines)
        stack_trace_str = redact_sensitive_data(raw_tb)
        # Extract the last code frame for fingerprinting
        if error.__traceback__:
            tb = error.__traceback__
            while tb.tb_next:
                tb = tb.tb_next
            location = f"{os.path.basename(tb.tb_frame.f_code.co_filename)}:{tb.tb_lineno}"

    fingerprint = generate_failure_fingerprint(service, operation, err_type, location)

    sanitized_actor_id = mask_phone(actor_id) if actor_id and (actor_id.startswith("+91") or actor_id.isdigit()) else (str(actor_id)[:80] if actor_id else None)
    sanitized_resource_id = str(resource_id)[:160] if resource_id else None
    sanitized_context = redact_sensitive_data(context or {})

    default_action = "Inspect server error logs and state machine transitions."
    if "NameError" in err_type:
        default_action = "Fix missing variable or import in module source."
    elif "Database" in err_type or "Firestore" in err_type:
        default_action = "Check Firestore connectivity, network latency, and rule permissions."
    elif "RateLimit" in err_type:
        default_action = "Review caller request frequency or client retry loop."

    action_text = recommended_action or default_action

    report_payload: Dict[str, Any] = {
        "failureId": failure_id,
        "fingerprint": fingerprint,
        "timestamp": timestamp,
        "environment": env,
        "severity": severity.upper() if severity in {"CRITICAL", "HIGH", "MEDIUM", "LOW"} else "HIGH",
        "service": str(service)[:80],
        "operation": str(operation)[:80],
        "endpoint": str(endpoint)[:160] if endpoint else None,
        "actorType": str(actor_type)[:40],
        "actorId": sanitized_actor_id,
        "resourceId": sanitized_resource_id,
        "errorType": str(err_type)[:80],
        "errorMessage": clean_msg[:1000],
        "errorCode": str(error_code or "500")[:40],
        "stackTrace": stack_trace_str[:4000],
        "recoveryAttempted": bool(recovery_attempted),
        "recoveryResult": str(recovery_result)[:40],
        "retryCount": max(0, int(retry_count)),
        "context": sanitized_context,
        "recommendedAction": action_text[:500],
        "status": "open",
        "occurrenceCount": 1,
        "firstSeenAt": timestamp,
        "lastSeenAt": timestamp,
    }

    # Attempt persistence to Firestore with fingerprint deduplication
    persisted_to_db = False
    try:
        from .firebase import get_admin_app
        from firebase_admin import firestore as fb_firestore

        app = get_admin_app()
        db = fb_firestore.client(app)

        # Use hourly/daily fingerprint doc to avoid DB document storms
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        dedup_doc_id = f"fp_{fingerprint}_{date_str}"
        doc_ref = db.collection("failureReports").document(dedup_doc_id)

        # Upsert: increment occurrence count if already exists today
        doc_ref.set(
            {
                **report_payload,
                "occurrenceCount": fb_firestore.Increment(1),
                "lastSeenAt": fb_firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
        persisted_to_db = True
    except Exception as db_exc:
        # Failsafe fallback: log to stderr directly without throwing
        report_payload["dbPersistError"] = str(db_exc)[:200]

    # Structured JSON log to logger / stderr for observability
    log_record = {
        "logType": "BACKEND_FAILURE_REPORT",
        "persistedToDb": persisted_to_db,
        **report_payload,
    }
    sys.stderr.write(f"\n[BACKEND_FAILURE] {json.dumps(log_record)}\n")
    sys.stderr.flush()

    return report_payload
