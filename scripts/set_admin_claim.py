"""
Grant or revoke LiphtUp admin dashboard access.

This is a one-off operator script, not part of the deployed API. Run it
locally (or from a trusted machine) with the same Firebase Admin
environment variables the app already uses:

    FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

Usage (from the repo root):

    pip install firebase-admin
    export FIREBASE_PROJECT_ID=...
    export FIREBASE_CLIENT_EMAIL=...
    export FIREBASE_PRIVATE_KEY=...          # keep the literal \n form; the
                                              # script fixes it up the same
                                              # way the API does

    python scripts/set_admin_claim.py grant   someone@example.com
    python scripts/set_admin_claim.py revoke  someone@example.com
    python scripts/set_admin_claim.py grant   --uid AbCdEf123456

After granting, the person must sign out and back in to `/admin` (or wait
for their existing ID token to expire, up to one hour) -- custom claims are
embedded in the ID token at mint time, not read live from Firestore.

This does NOT create the Firebase Auth account. Create the admin's user
account first (Firebase Console, or the existing self-registration flow),
then grant the claim.
"""
from __future__ import annotations

import argparse
import sys

import firebase_admin
from firebase_admin import auth, credentials


def _get_env(name: str) -> str:
    import os

    value = os.environ.get(name, "")
    if not value:
        print(f"Missing required environment variable: {name}", file=sys.stderr)
        sys.exit(1)
    return value


def _init_app() -> firebase_admin.App:
    project_id = _get_env("FIREBASE_PROJECT_ID")
    client_email = _get_env("FIREBASE_CLIENT_EMAIL")
    private_key = _get_env("FIREBASE_PRIVATE_KEY").replace("\\n", "\n")

    cred = credentials.Certificate(
        {
            "type": "service_account",
            "project_id": project_id,
            "client_email": client_email,
            "private_key": private_key,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )
    return firebase_admin.initialize_app(cred, name="liphtup-admin-claim-script")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["grant", "revoke"])
    parser.add_argument("email", nargs="?", help="Admin's account email")
    parser.add_argument("--uid", help="Use a Firebase UID instead of an email")
    args = parser.parse_args()

    if not args.email and not args.uid:
        parser.error("Provide an email or --uid")

    app = _init_app()
    user = auth.get_user_by_email(args.email, app=app) if args.email else auth.get_user(args.uid, app=app)

    claims = dict(user.custom_claims or {})
    if args.action == "grant":
        claims["admin"] = True
    else:
        claims.pop("admin", None)

    auth.set_custom_user_claims(user.uid, claims, app=app)
    # Force existing sessions to re-mint their ID token with the new claim.
    auth.revoke_refresh_tokens(user.uid, app=app)

    print(f"{'Granted' if args.action == 'grant' else 'Revoked'} admin claim for {user.uid} ({user.email}).")
    print("They must sign in again at /admin for this to take effect.")


if __name__ == "__main__":
    main()
