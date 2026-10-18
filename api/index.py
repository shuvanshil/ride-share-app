"""
LiphtUp Vercel Serverless Function entrypoint.

This is the SINGLE Serverless Function entrypoint for LiphtUp on Vercel.
By hosting the entire FastAPI application in this solitary entrypoint,
the deployment strictly consumes exactly 1 Serverless Function (well under
the Vercel Hobby plan maximum of 12 functions).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is on sys.path for Vercel Serverless
_API_DIR = Path(__file__).resolve().parent
_ROOT_DIR = _API_DIR.parent
if str(_ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(_ROOT_DIR))
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from backend.main import *
from backend.main import (
    app,
    ForceCORSMiddleware,
    api_error_handler,
    validation_error_handler,
    http_error_handler,
    unhandled_error_handler,
)

__all__ = [
    "app",
    "ForceCORSMiddleware",
    "api_error_handler",
    "validation_error_handler",
    "http_error_handler",
    "unhandled_error_handler",
]
