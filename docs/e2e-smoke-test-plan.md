# LiphtUp automated end-to-end smoke-test plan

## Purpose

Provide a repeatable release check for the deployed frontend, FastAPI boundary, Firebase Authentication, and Firestore listeners. The suite should run against an isolated Vercel preview project or Firebase Emulator Suite; it must not mutate production data.

## Proposed harness

- Playwright for browser control and Chromium/Firefox/WebKit coverage.
- A dedicated Firebase test project (preferred) or Emulator Suite for Auth and Firestore.
- Two disposable identities: one passenger and one approved driver. Add a second driver for concurrency tests.
- Test data tagged with a run ID so cleanup can be retried safely.
- CI secrets supplied at runtime; never commit Firebase credentials, OTP secrets, or real phone numbers.

Suggested future commands:

```powershell
npx playwright install --with-deps
npx playwright test e2e --project=chromium
npx playwright test e2e --project=firefox
```

The browser suite is not yet implemented in this repository. Until then, the backend gate remains:

```powershell
.venv\Scripts\python.exe -m pytest www/api/tests -q
```

## Required test data

| Actor | Required state |
| --- | --- |
| Passenger | Verified Auth account, user profile, no active ride |
| Driver A | Verified Auth account, `role=driver`, `verificationStatus=approved`, test vehicle |
| Driver B | Same as Driver A, used for race/concurrency coverage |
| Route | Stable test pickup/destination accepted by the configured Maps provider |

## P0 release journey

1. Open the deployed app and verify the service worker/offline fallback loads.
2. Register or sign in as a passenger; verify the authenticated session survives a reload.
3. Edit passenger display name and profile photo URL; reload and verify persistence.
4. Create a ride with pickup, destination, coordinates, and a supported vehicle service.
5. Verify the passenger sees fare, ride status, and dispatch state without exposing the verification PIN in the UI.
6. Sign in as Driver A in a separate browser context and set availability online.
7. Verify Driver A receives the dispatched ride and can accept it; verify the passenger sees the assigned driver.
8. Transition the driver through arrival and trip-start. Submit the passenger PIN and verify an incorrect PIN is rejected.
9. Complete the trip, confirm payment, and verify both passenger and driver history records.
10. Set the driver offline and verify presence reflects the change after refresh/reconnect.

## P0 negative and authorization checks

- Unauthenticated requests to protected API routes return 401.
- A passenger cannot call driver availability, GPS, accept, or transition operations.
- A driver cannot create, dispatch, or cancel another passenger's ride.
- A passenger cannot read another passenger's ride or trip history.
- An unapproved driver is not eligible for dispatch or ride reads.
- Duplicate ride acceptance has one winner; the other driver receives a safe conflict response.
- Repeating a completed transition is idempotent or safely rejected without corrupting history/earnings.
- Account deletion is blocked during an active ride and succeeds after the ride is closed.

## Registration and recovery coverage

- Passenger OTP send, verify, registration, and custom-token sign-in.
- Driver registration stores vehicle/licence/UPI data and starts as `pending_review`.
- Password reset OTP flow succeeds for a known account and does not reveal whether an unknown phone exists.
- OTP resend cooldown, hourly send limit, and failed-attempt limit are enforced.

## Browser/device matrix

Run P0 on Chromium desktop and one Android Chrome or iOS Safari device. Run notification and geolocation cases only where the browser supports them.

- Chromium: login, ride lifecycle, profile, history, account deletion.
- Firefox: login, ride lifecycle, Firestore listener reconnect.
- Mobile browser: permissions, GPS updates, wake lock behavior, offline page, responsive UI.
- Notification-capable browser: FCM registration and foreground/background ride notification.

## Isolation, cleanup, and evidence

- Use a unique run ID in every created test document.
- Delete test Auth users and Firestore documents in teardown, with a separate cleanup job for interrupted runs.
- Capture Playwright trace, screenshot, console errors, failed network responses, and deployment URL on failure.
- Treat unexpected 4xx/5xx responses, uncaught console errors, listener permission errors, and leaked secrets as release failures.

## Implementation order

1. Add Playwright config and authenticated browser-context fixture.
2. Implement passenger registration/login and profile tests.
3. Implement driver login, availability, and ride lifecycle tests.
4. Add authorization, OTP abuse, cancellation, deletion, and concurrency tests.
5. Add Firebase Rules Emulator coverage and CI cleanup.
6. Run the suite against a Vercel preview before each production deployment.
