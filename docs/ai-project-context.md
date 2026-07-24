# LiphtUp — AI Project Context

Use this file as the short working context for an AI agent. It describes the repository as audited on 2026-07-24. The live URL is `https://liphtup.in/`; a direct request from this environment timed out, so production availability must still be verified separately. The source, deployment configuration, and existing readiness documents were reviewed.

## 1. Purpose

LiphtUp is a local ride-booking PWA for Tripura, India. Passengers choose a pickup and destination, select Bike/Scooty or Auto, see a route and fare, request a ride, track the assigned driver, verify a pickup PIN, and view trip history. Approved drivers go online, receive matching requests, accept one, broadcast GPS, progress the ride, collect payment through displayed UPI details, and view history.

This is a small, location-focused marketplace rather than a general social ride-share product. The current service area is capped at 120 km. Fares are calculated for Bike and Auto using shared client/server policy.

## 2. Repository shape

```text
/
├─ www/                         Deployed Vercel root and static web app
│  ├─ *.html                    Pages: home, login, booking, driver, history, profile
│  ├─ css/                      Global and driver-service styles
│  ├─ js/                       Browser modules
│  ├─ assets/                   Logo, PWA icons, map markers, marketing images
│  ├─ api/                      FastAPI Vercel function
│  │  ├─ index.py               App entrypoint; mounts all /api routes
│  │  ├─ core/                  Firebase, auth, config, errors, OTP, Google helpers
│  │  ├─ routers/               account, auth, google, notify, otp, rides
│  │  └─ tests/                 pytest security/provider/rate-limit/OTP tests
│  ├─ sw.js                     Firebase Messaging service worker and offline cache
│  ├─ offline.html              Offline fallback
│  ├─ manifest.webmanifest      Installable PWA metadata
│  ├─ vercel.json               Vercel configuration
│  └─ requirements.txt          Runtime Python dependencies
├─ firestore.rules              Client read/write security boundary
├─ docs/                        Production checklist and E2E plan
├─ requirements-dev.txt         Development/test dependencies
└─ README.md                    Minimal project overview
```

There is no package manager manifest or frontend build pipeline. Browser code is native ES modules loaded from HTML; Firebase SDK 10.8.0, Bootstrap 5.3.2, Google Fonts, and Google Maps JS are external CDN/provider dependencies.

## 3. Stack and deployment

- Frontend: static HTML, CSS, vanilla JavaScript ES modules, Bootstrap utilities, responsive mobile-first UI.
- Backend: Python 3 + FastAPI on Vercel's Python runtime; `httpx` calls Google Maps and 2Factor.in.
- Identity: Firebase Authentication. Password login is the normal session; phone OTP is used for phone verification during registration and password reset.
- Database: Cloud Firestore, accessed directly for authorized reads/listeners and through Firebase Admin SDK for all business writes.
- Maps: Google Maps JavaScript API in the browser; server-proxied Places/autocomplete, geocoding, reverse geocoding, and routes.
- Notifications: Firebase Cloud Messaging/web push plus in-app notification/ring behavior.
- Hosting: deploy `www/` as the Vercel project root. FastAPI `www/api/index.py` serves all `/api/*` endpoints. Static pages use relative paths.
- PWA: service worker, manifest, install prompt, offline fallback, and wake lock during active rides.

Required server environment variables are `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_SERVER_KEY`, `TWOFACTOR_API_KEY`, and `OTP_SESSION_SECRET`. Optional variables are `FIREBASE_WEB_API_KEY`, `TWOFACTOR_OTP_TEMPLATE`, `PUBLIC_APP_URL`, and `APP_BASE_URL` (default `https://liphtup.in`). Never commit service-account values, OTP secrets, provider keys, or real test identities.

## 4. Architecture and data flow

The browser owns presentation, map rendering, Firebase Auth session state, and Firestore realtime listeners. The FastAPI boundary owns identity verification, validation, dispatch, ride transitions, GPS/presence writes, account/profile writes, OTP security, notifications, and provider proxying.

Typical passenger flow:

1. `services.html` obtains location and loads Google Maps through `map.js`.
2. Destination search calls `/api/google-autocomplete`, `/api/google-place-detail`, reverse geocoding, and `/api/google-route`.
3. Client and server fare policy produce Bike/Auto quotes.
4. Booking calls `POST /api/rides` with coordinates, labels, and vehicle type. The backend transaction rejects duplicate active passenger rides, finds approved matching drivers, stores the ride, and creates a 4-digit verification PIN.
5. The client listens to `rides/{rideId}`. It can call dispatch/notify and cancel; assigned driver location is reflected on the map.
6. Driver actions are server-authoritative transactions. Firestore updates notify both clients.
7. Completion writes/merges `tripHistory`, finalizes fare, and then the driver marks payment received. The passenger sees a completion/payment modal.

Realtime reads use Firestore `onSnapshot` for the active ride, eligible driver requests, trip history, and public `driverMapPresence`. The client may cache a sanitized profile in `sessionStorage` and pickup coordinates in `localStorage`; these caches are only navigation/UI optimizations, never authorization.

## 5. Browser modules

- `firebase-init.js`: Firebase app/Auth/Firestore initialization for project `tripura-rideshare`.
- `auth.js`: shared auth guards and role routing.
- `login.js`: login/register tabs, password login, OTP send/verify, password reset, driver registration, profile cache.
- `app.js`: passenger home/booking lifecycle, active ride listener, dispatch/notify, cancellation, driver card, payment completion.
- `map.js`: Maps bootstrap, pickup/destination selection, autocomplete, route, fare quote, public driver markers, assigned-driver tracking.
- `services.js`: service selector and login gate; coordinates booking UI with the map/app lifecycle.
- `driver.js` / `driver-service.js`: legacy/current driver consoles; availability, incoming rides, GPS smoothing/throttling, acceptance, transitions, UPI/payment UI.
- `history.js`: passenger/driver history query and details modal.
- `profile.js`: profile editing, driver details, share/safety/help/legal modals, logout, account deletion.
- `messaging.js`: FCM token registration and foreground/background ride request notifications.
- `navigation.js`: role-aware links between home, services, history, and profile.
- `dialog.js`: app alerts/confirmations; `wake-lock.js`: screen wake lock while a ride is active.
- `pwa.js`: service-worker registration and install UX.

## 6. API contract

All API errors intentionally return `{"error":"..."}` rather than FastAPI's default `detail` shape. Protected routes require `Authorization: Bearer <Firebase ID token>`; `current_user` verifies the token with Firebase Admin SDK and checks revocation.

| Route | Purpose | Auth |
|---|---|---|
| `GET /api/health` | Health response | Public |
| `GET /api/google-config` | Return browser Maps key | Public |
| `GET /api/google-autocomplete` | Destination/pickup suggestions | Public |
| `GET /api/google-place-detail` | Normalize selected place | Public |
| `GET /api/google-reverse-geocode` | Address from coordinates | Public |
| `GET /api/google-route` | Route distance/duration/polyline data | Public |
| `POST /api/send-otp` | Send 2Factor OTP with cooldown/window limits | Public |
| `POST /api/verify-otp` | Verify OTP and issue signed short-lived verification token | Public |
| `POST /api/register-account` | Create Firebase Auth user + profile/index after OTP | Public, token in body |
| `POST /api/reset-password` | Reset Firebase password after OTP | Public, token in body |
| `GET /api/auth/session` | Validate current Firebase session | Bearer |
| `GET /api/profile` | Current profile | Bearer |
| `PATCH /api/profile` | Validated profile/driver update | Bearer |
| `POST /api/delete-account` | Password-confirmed deletion/anonymization | Bearer |
| `POST /api/rides` | Create passenger ride | Bearer passenger |
| `POST /api/rides/{id}/dispatch` | Add next eligible driver batch | Bearer passenger |
| `POST /api/notify-ride-request` | Send FCM to eligible drivers | Bearer passenger |
| `POST /api/rides/{id}/accept` | Atomic driver acceptance | Bearer approved driver |
| `POST /api/rides/{id}/transition` | Arrive, start, verify PIN, complete, cancel, mark paid | Bearer assigned driver |
| `POST /api/rides/{id}/cancel` | Passenger cancellation | Bearer ride passenger |
| `POST /api/rides/driver-availability` | Online/offline/searching/busy presence | Bearer approved driver |
| `POST /api/rides/driver-location` | GPS and ride location telemetry | Bearer approved driver |
| `POST /api/rides/driver-push-token` | Store FCM token | Bearer approved driver |

## 7. Ride state machine

The normal path is `pending → accepted → arrived → started/en_route → completed`; payment then changes `payment_status` to `paid`. Alternate terminal paths are `cancelled_by_passenger` and `cancelled_by_driver`.

- `accept`: only approved driver, matching vehicle, eligible ID, and no existing active driver ride; Firestore transaction gives one driver the race winner.
- `arrive`: assigned driver only, from `accepted`.
- `start`: assigned driver only, from `arrived`.
- `verify_pin`: assigned driver supplies the passenger's 4-digit `verification_pin`; moves from `accepted`/`arrived` to `en_route` and timestamps start.
- `complete`: from `started`/`en_route`; server recalculates/finalizes fare using current driver location and writes history.
- `mark_paid`: only after completed; records driver and timestamp. This is a confirmation flag, not a payment gateway transaction.
- GPS writes are smoothed/throttled in the browser and persisted through FastAPI to `users`, `driverPresence`, `driverMapPresence`, and the assigned ride.

Fare policy: Bike base ₹15 + ₹7/km, Auto base ₹25 + ₹12.50/km, minimum equal to base. First 20 km use the full rate; distance after 20 km uses an 0.85 multiplier; distance above 120 km is rejected as outside service area. Keep `www/js/fare-policy.js` and `www/api/routers/rides.py` synchronized when changing pricing.

## 8. Firestore data model and security

- `users/{uid}`: name, email, phone, role (`passenger`/`driver`), profile photo, driver vehicle/license/UPI fields, `verificationStatus`, availability, GPS telemetry, lifetime earnings, completed trip count. Client may read only its own document; FastAPI writes.
- `phoneLoginIndex/{phone}`: minimal phone → Firebase UID/email/role lookup for password login. Direct document get is public, list and writes are denied.
- `rides/{rideId}`: passenger/driver IDs and contact snapshots, pickup/drop coordinates and labels, vehicle/fare, status, PIN (server/client behavior must not expose it to the driver until needed), eligible/notified/rejected driver arrays, location, timestamps, fare adjustment, payment fields. Reads are allowed only to the passenger, assigned/eligible approved drivers; all writes are server-only.
- `driverPresence/{uid}`: private availability, fresh location, notification eligibility, push tokens. No client reads/writes.
- `driverMapPresence/{uid}`: coarse public map presence for searching/online drivers; server-only writes, public reads.
- `tripHistory/{rideId}`: passenger/driver history snapshot and final status/fare; participants can read, server writes.
- `otpSecurity/{phone/securityId}`: OTP cooldown, send window, failed-attempt counters; server-only.
- `deletedAccounts/{uid}`: server audit/anonymization record; not client-readable under the catch-all deny rule.

`firestore.rules` is deliberately strict: business mutations cannot bypass FastAPI/Admin SDK. Queries must include ownership/eligibility constraints that match the rules. Any new collection or client listener needs a corresponding rule review.

## 9. Authentication and authorization

Registration: user enters Indian phone, receives OTP from 2Factor.in, verifies it, then submits name/email/password and role. Driver registration additionally requires vehicle number/type/model, license number, UPI ID, and terms/privacy agreement; driver status starts `pending_review`. Only an operator/admin can make it `approved` (there is no admin workflow in this repository).

Login: phone is resolved through `phoneLoginIndex`, then Firebase email/password login is used. Email can also be entered directly. Password reset uses phone OTP and the backend's Firebase Identity Toolkit call. Backend routes never trust a browser role; they verify the Firebase ID token and read the authoritative profile.

Account deletion blocks active rides, removes driver presence, removes the user/index, and anonymizes historical ride references. It requires explicit confirmation and password verification.

## 10. UI/UX flows

- Landing/home: local Tripura branding, map/driver visibility, navigation to services/history/profile; guest users can explore.
- Booking: location permission/GPS status, pickup field with current-location action, destination autocomplete, live map, route/fare pill, Bike/Auto cards, and a login modal when a guest tries to book. After booking, the same screen shows dispatch, assigned driver, cancellation, live driver tracking, PIN/payment completion states.
- Driver: approved drivers see Online/Offline duty switch, incoming local ride requests, active-trip lifecycle buttons, GPS/background notification behavior, history, and a payment modal with UPI QR/details. Pending drivers see an account-review screen.
- History: role-aware passenger/driver history list with detail modal; Firestore listener updates it.
- Profile: edit sheet for identity/photo and driver fields plus account, share, safety, help, contact, privacy, and terms modals.
- Visual system: green `#1A7A2E` primary, white/light-gray cards, Inter/system font, compact mobile cards, bottom navigation, responsive desktop expansion, SVG mask icons, accessible labels/live regions where implemented.

## 11. Coding conventions for future changes

- Preserve relative static paths and `/api/...` route names; there is no bundler.
- Use native ES modules and semicolon-terminated JavaScript consistent with existing files. Keep DOM IDs/classes in HTML and JS synchronized.
- Use `ApiError` for expected backend failures and preserve the `{"error": ...}` response shape. Do not leak provider/credential/exception details.
- Validate request bodies with Pydantic, trim/limit strings, normalize phone/email, and authorize by token UID plus Firestore profile—not cached session data.
- Treat ride transitions, acceptance, completion, cancellation, and history writes as transaction-sensitive. Preserve idempotency/conflict checks.
- If changing fares, status names, Firestore fields, or API payloads, update both Python and browser code plus tests/docs.
- Keep secrets in Vercel environment variables. Firebase browser config is public client configuration; Admin credentials are not.
- Test backend changes with `.venv\Scripts\python.exe -m pytest www\api\tests -q`. Browser E2E/Firestore Emulator coverage is planned but not yet implemented.

## 12. Release reality / known gaps

The existing readiness checklist says the backend/security suite passes, but production evidence is still open: deployment/environment confirmation, Firestore backup/restore, budget alerts, stale-driver/reconnect tests, structured logs/alerts, admin driver-review workflow, FCM verification, payment strategy, final legal review, rules/emulator tests, browser smoke tests, concurrency tests, and mobile/offline permission checks. Do not claim these are done without new evidence.

The most important product/security follow-ups are: remove the fallback Firebase Web API key, move phone-index lookup behind FastAPI and rate-limit it, verify Maps key restrictions, confirm account deletion/legal requirements, and decide whether “payment confirmed” should be replaced or supplemented by a real gateway.

