# LiphtUp Admin Console

Everything admin-specific lives under the top-level `admin_console/`
directory:

- `admin_console/static/`: frontend HTML/CSS/JS.
- `admin_console/api/admin.py`: admin API router.
- `admin_console/api/core/admin.py`: admin auth/audit helpers.
- `admin_console/api/static.py`: serves the isolated static files through
  `/api/admin-console-static/*`.

The only files left under `www/` are compatibility shims: `/admin`
loads the isolated static page, and `www/api/routers/admin.py` plus
`www/api/core/admin.py` import the isolated backend. Deleting
`admin_console/` removes the admin console while leaving the passenger,
driver, and core API routes importable.

## URL

`https://liphtup.in/admin` -- served by a tiny bridge at
`www/admin/index.html`, which loads `admin_console/static/index.html`
through `/api/admin-console-static/index.html`. It is not linked from any
public page and carries `<meta name="robots" content="noindex,nofollow">`.

## How admin access works

- Admins sign in with the **same Firebase Authentication** every other
  user uses (email + password). There is no separate admin auth system.
- What makes an authenticated user an *admin* is a Firebase Auth **custom
  claim**, `admin: true`, checked by `require_admin` in
  `admin_console/api/core/admin.py`. The claim lives in the signed ID token, so
  `verify_firebase_token` (already used everywhere else) picks it up for
  free -- no extra Firestore read, no extra round trip.
- The admin frontend never talks to Firestore directly. Every read and
  write goes through `/api/admin/*`, authenticated with a Bearer ID token,
  exactly like `/api/rides/*` and `/api/profile`. This is why
  **`firestore.rules` did not need to change**: the Admin SDK bypasses
  rules entirely, and the existing catch-all (`allow read, write: if
  false`) already protects every collection, including the new
  `auditLogs` collection, from any direct client access.

## Adding the first administrator

Two ways to do this. Option A needs nothing but a browser and the
Firebase Console. Option B is for anyone comfortable running a local
Python script and copying Firebase Admin SDK credentials.

### Option A -- `/api/admin/bootstrap` (no local script, no Firebase credentials)

1. **Create the Firebase Auth account**: Firebase Console -> your project
   -> Authentication -> Users -> Add user -> enter an email + password.
   (Or have the person register normally through LiphtUp's own
   `/login` page.)
2. **Add one new Vercel env var** -- Vercel dashboard -> your project ->
   Settings -> Environment Variables -> add `ADMIN_BOOTSTRAP_SECRET`
   with any long random value *you make up yourself* (this is not a
   Firebase credential -- think of it as a one-time setup password).
   Redeploy so the new env var takes effect.
3. **Call the endpoint once**, from anywhere (Mac/Linux Terminal,
   Windows PowerShell, or a tool like Postman/reqbin.com):

   ```
   curl -X POST https://liphtup.in/api/admin/bootstrap \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@example.com","secret":"THE_SECRET_YOU_SET"}'
   ```

   A successful response looks like
   `{"ok": true, "uid": "...", "email": "admin@example.com", ...}`.
4. Sign in at `/admin` with that email + password.
5. (Optional but recommended) Remove `ADMIN_BOOTSTRAP_SECRET` from
   Vercel afterward to close off this endpoint, or just keep it secret --
   it only ever *grants* the claim, and only to accounts you tell it to,
   and only with the correct secret.

To add more admins later, repeat step 3 with a different email (keep
the env var, or set it again temporarily).

### Option B -- local script (needs Firebase Admin SDK credentials)

1. Create the Firebase Auth account (same as step 1 above).
2. Run this from a trusted machine, using the same
   `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`
   values already configured in Vercel:

   ```
   pip install firebase-admin
   export FIREBASE_PROJECT_ID=...
   export FIREBASE_CLIENT_EMAIL=...
   export FIREBASE_PRIVATE_KEY=...
   python scripts/set_admin_claim.py grant admin@example.com
   ```

3. Sign in at `/admin`.

To revoke: `python scripts/set_admin_claim.py revoke admin@example.com`
(the bootstrap endpoint only ever grants; use the local script to revoke).

Either option: sign out and back in at `/admin` if you were already
logged in somewhere -- custom claims are embedded at ID-token mint time,
so an open session won't see the claim until it refreshes.

## What's implemented

- **Dashboard**: top KPI strip (today's rides, active rides, online/offline
  drivers) plus the fuller stat breakdown below it.
- **Live Feed**: a realtime activity panel (driver online/offline, ride
  accepted/started/cancelled/completed, payment completed, new passenger/
  driver registered, driver suspended/blocked) via Firestore `onSnapshot`
  listeners -- see "Realtime reads" below.
- **Driver management**: sortable/searchable/exportable table with column
  visibility, bulk approve/suspend, and a full profile drawer (photo, ID,
  status, vehicle, licence, lifetime earnings, recent rides) with an
  editable-fields form (validated, dirty-tracked, Save / Save & Close /
  Discard) and one-click approve/reject/suspend/block/unblock.
- **Live ride tracking**: a live Google Map per active ride -- driver
  marker, pickup/drop markers, and a live speed + route-progress readout,
  updating in realtime from Firestore.
- **Ride management**: detail drawer with a status timeline, route, fare
  (with one-click correction), payment status, driver/passenger, and an
  internal admin-notes thread.
- **Ride history / Passengers / Audit log**: the same reusable data table
  everywhere -- sort, client-side search, column visibility, CSV export,
  Excel export, bulk selection (passengers), sticky header, resizable
  columns, and infinite scroll.
- **Toasts, a basic error boundary** (global JS error handler -> toast
  instead of a silent break), and a small **response cache** in the API
  client (15s TTL, cleared on any write) for background-refresh-style
  section switching.

### Realtime reads: a deliberate rules change

To make the Live Feed and live ride map genuinely realtime (not polling),
the admin frontend now reads `rides` and `users` directly via Firestore
`onSnapshot`, instead of only through `/api/admin/*`. This needed one
small, additive change to `firestore.rules`: a `isAdmin()` function
(checks the same `admin` custom claim as the backend) or'd into the
existing read conditions for `rides`, `tripHistory`, and `users`. Nothing
about who can *write* changed -- every write, admin included, still goes
through the FastAPI Admin SDK in `admin_console/api/admin.py`, and the
`isAdmin()` check can't be satisfied by anything a client can set on its
own (it's a server-set Auth custom claim). Reads for non-admin rules are
untouched.

## Known extension points (not built yet)

- **Driver document review** (vehicle photo / licence / selfie viewer) --
  the data model has no document-upload fields yet; the drawer shows
  "Not collected yet" for address, insurance, documents, and rating for
  the same reason -- add those fields to driver registration first.
- **True road-route polyline for live tracking** -- the live map currently
  draws a straight line between pickup / driver / drop (labelled as such
  in the UI). Swapping in the real route means calling the existing
  `/api/google-route` proxy from the admin map too.
- **Cross-dataset sort/virtualization** -- the data table sorts and
  searches only the rows already loaded (fine at current/near-term scale;
  infinite scroll keeps loading more as you scroll). True server-side sort
  across the whole collection would need a Firestore composite index per
  sortable column; true virtualization (windowed DOM rendering) is worth
  adding if any single table regularly holds many thousands of rows.
- **TypeScript / strict typing** -- the whole site (this console included)
  is plain ES modules with no build step, matching how the rest of the
  repo is deployed to Vercel. Introducing TypeScript means introducing a
  bundler/build step for the first time, which is a bigger call than this
  change should make unilaterally -- happy to do it as its own step if
  you want it.
- **Tiered permissions** (e.g. support-admin vs super-admin) -- right now
  `admin` is a single yes/no claim. A real permission system needs a
  defined set of roles/capabilities first; happy to build it once those
  are decided.
- "Request additional info from driver" and admin-triggered push
  notifications would reuse `www/api/routers/notify.py`'s FCM setup.
- `_count()` in `admin.py` uses Firestore aggregation queries, and several
  list/filter/sort combinations will need Firestore composite indexes the
  first time they run in production -- Firestore's error message includes
  a direct console link to create the exact index needed.
