#!/usr/bin/env python3
"""
Standalone runner for detecting pending Sensitive Rides and delivering Telegram alerts.
Used by the GitHub Actions workflow and internal backend recovery cron.
"""
from __future__ import annotations

import os
import sys
import logging
from typing import Any

# Configure structured, secret-safe logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("sensitive_ride_bot")

# Add project root to sys.path so internal imports resolve
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from api.core.config import get_env
from api.core.firebase import get_firestore
from api.core.telegram import (
    claim_and_send_sensitive_ride_alert,
    get_telegram_config,
)


def run_sensitive_ride_notifications() -> dict[str, Any]:
    bot_token, chat_id = get_telegram_config()
    if not bot_token or not chat_id:
        logger.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables.")
        sys.exit(1)

    try:
        db = get_firestore()
    except Exception as exc:
        logger.error("Failed to initialize Firebase Admin SDK: %s", exc)
        sys.exit(1)

    logger.info("Querying pending Sensitive Rides from Firestore...")
    
    # Query for rides marked as sensitiveRide == True and sensitiveRideNotificationSent == False
    try:
        pending_docs = list(
            db.collection("rides")
            .where("sensitiveRide", "==", True)
            .where("sensitiveRideNotificationSent", "==", False)
            .limit(50)
            .stream()
        )
    except Exception as exc:
        logger.error("Firestore query for sensitive rides failed: %s", exc)
        sys.exit(1)

    logger.info("Found %d pending Sensitive Ride candidate(s).", len(pending_docs))

    stats = {
        "found": len(pending_docs),
        "sent": 0,
        "skipped": 0,
        "failed": 0,
    }

    worker_id = f"gha-{os.environ.get('GITHUB_RUN_ID', 'manual')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"

    for doc in pending_docs:
        ride_id = doc.id
        logger.info("Processing sensitive ride %s...", ride_id)
        try:
            res = claim_and_send_sensitive_ride_alert(
                db=db,
                ride_id=ride_id,
                bot_token=bot_token,
                chat_id=chat_id,
                worker_id=worker_id,
            )
            if res.get("sent"):
                logger.info("Telegram alert delivered successfully for ride %s.", ride_id)
                stats["sent"] += 1
            elif res.get("skipped"):
                logger.info("Ride %s skipped: %s", ride_id, res.get("skipped"))
                stats["skipped"] += 1
            else:
                logger.warning("Ride %s delivery failed: %s", ride_id, res.get("error", "Unknown error"))
                stats["failed"] += 1
        except Exception as exc:
            logger.error("Unexpected error processing ride %s: %s", ride_id, exc)
            stats["failed"] += 1

    logger.info("Summary: %s", stats)
    return stats


if __name__ == "__main__":
    results = run_sensitive_ride_notifications()
    if results.get("failed", 0) > 0 and results.get("sent", 0) == 0:
        # If all candidates failed, exit with non-zero code to notify GitHub Actions
        sys.exit(1)
    sys.exit(0)
