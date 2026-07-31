"""
Lazy Firebase Admin SDK initialization.

Direct port of `www/api/_firebase-admin.js`. Uses a service account built
from three env vars (same names as the old Node functions) instead of a
credentials JSON file, so no secret files need to be committed or uploaded.
"""
from __future__ import annotations

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials
from firebase_admin import firestore as fb_firestore
from firebase_admin import messaging as fb_messaging

from .config import get_env
from .errors import ApiError

_APP_NAME = "liphtup-backend"


def _get_private_key() -> str:
    key = get_env("FIREBASE_PRIVATE_KEY")
    # Env vars often store the key with literal "\n" sequences instead of
    # real newlines -- same fix-up as the original getPrivateKey().
    return key.replace("\\n", "\n") if key else ""


def get_admin_app() -> firebase_admin.App:
    try:
        return firebase_admin.get_app(_APP_NAME)
    except ValueError:
        pass

    project_id = get_env("FIREBASE_PROJECT_ID")
    client_email = get_env("FIREBASE_CLIENT_EMAIL")
    private_key = _get_private_key()

    if not project_id or not client_email or not private_key:
        raise ApiError("Missing Firebase Admin environment variables.", 500)

    cred = credentials.Certificate(
        {
            "type": "service_account",
            "project_id": project_id,
            "client_email": client_email,
            "private_key": private_key,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )
    return firebase_admin.initialize_app(cred, name=_APP_NAME)


def get_auth():
    return fb_auth.Client(get_admin_app())


def get_firestore():
    return fb_firestore.client(get_admin_app())


def get_messaging():
    return fb_messaging


def firestore_module():
    return fb_firestore
