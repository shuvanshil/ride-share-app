# LiphtUp production-readiness checklist

This checklist is the release gate for the `shuvan` branch. A release is not production-ready until every required item is checked, the evidence is linked in the release record, and an owner has signed off.

Status at handoff: core backend migration complete; backend/security tests pass (`16 passed`). Items marked `OPEN` still require deployment or operational verification.

## Release evidence

- [ ] `OPEN` Release commit, deployment URL, and rollback target recorded.
- [ ] `OPEN` Production smoke-test run recorded with timestamp, browser/device, and test account IDs.
- [ ] `OPEN` Vercel deployment is healthy and production environment variables are present.
- [ ] `OPEN` Firebase production project and Vercel production domain are explicitly confirmed.

## Security and privacy

- [x] Firebase ID tokens are verified by FastAPI Admin SDK on protected routes.
- [x] Sensitive ride, profile, presence, and history writes go through FastAPI.
- [x] Firestore rules deny client business writes and restrict reads by ownership/eligibility.
- [x] Backend responses do not expose raw exception details.
- [x] OTP verification uses signed, short-lived tokens and abuse limits.
- [ ] `OPEN` Remove the fallback Firebase Web API key from backend configuration; require the environment variable.
- [ ] `OPEN` Rotate any secret that has ever been committed, pasted into tickets, or exposed in logs.
- [ ] `OPEN` Verify Google browser-key referrer restrictions and server-key API restrictions in production.
- [ ] `OPEN` Move phone-index lookup behind FastAPI, return only the minimum login data, and rate-limit it.
- [ ] `OPEN` Confirm account deletion, privacy policy, and terms have been reviewed for the production jurisdiction.

## Reliability and data protection

- [x] Race-sensitive ride and OTP operations use transaction/atomicity protections where implemented.
- [ ] `OPEN` Configure Firestore export/backup and document restore ownership and recovery steps.
- [ ] `OPEN` Add Firebase budget alerts and review quota limits for Auth, Firestore, Maps, and OTP.
- [ ] `OPEN` Verify stale-driver handling, reconnect behavior, and duplicate transition behavior under failure.
- [ ] `OPEN` Confirm required Firestore indexes and Vercel function timeout/cold-start behavior.
- [ ] `OPEN` Document deployment rollback and incident escalation procedures.

## Observability and operations

- [ ] `OPEN` Add structured server logs with request IDs, route, latency, status, and safe error class.
- [ ] `OPEN` Add alerts for repeated 5xx responses, OTP abuse, failed ride transitions, and notification failures.
- [ ] `OPEN` Confirm logs never contain passwords, OTP values, Firebase tokens, private keys, or full payment data.
- [ ] `OPEN` Define support ownership for account deletion, driver verification, ride disputes, and outages.
- [ ] `OPEN` Add an admin workflow and audit trail for driver approval, rejection, and suspension.

## Product completeness

- [ ] `OPEN` Resolve and verify FCM registration (including background notifications on supported mobile browsers).
- [ ] `OPEN` Decide and document the payment strategy; current payment confirmation is not a gateway transaction.
- [ ] `OPEN` Publish final privacy policy and terms links in the deployed application.
- [ ] `OPEN` Confirm user-facing error, offline, and permission-denied states on mobile devices.

## Test gates

- [x] Backend/security suite passes: `\.venv\Scripts\python.exe -m pytest www/api/tests -q`.
- [ ] `OPEN` Firestore rules tests pass against the Emulator Suite or Firebase Rules Playground evidence.
- [ ] `OPEN` Automated browser smoke suite passes for passenger and driver journeys.
- [ ] `OPEN` Concurrency and retry tests cover two drivers accepting one ride and repeated transitions.
- [ ] `OPEN` Mobile/offline/reconnection checks pass on the supported browser matrix.

## Sign-off

| Area | Owner | Evidence | Signed/date |
| --- | --- | --- | --- |
| Security/privacy |  |  |  |
| Backend/reliability |  |  |  |
| Frontend/mobile |  |  |  |
| Operations/deployment |  |  |  |
| Product/payments |  |  |  |
