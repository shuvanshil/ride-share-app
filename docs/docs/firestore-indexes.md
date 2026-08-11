# Firestore composite indexes (admin console)

The admin console's `/api/admin/*` endpoints run several `.where(...).order_by(...)`
queries. Firestore auto-indexes every field on its own, but a query that
combines an equality/`in` filter on one field with sorting (or a range
filter) on a *different* field needs a composite index created ahead of
time. Without it, Firestore raises `FailedPrecondition`, which the admin
API now turns into a clear `503` instead of a raw `500` -- but the queries
still won't return data until the indexes below exist.

## Deploy them

```bash
firebase deploy --only firestore:indexes
```

This reads `firestore.indexes.json` at the repo root. (If you'd rather not
use the CLI, Firestore also includes a direct "create this index" link in
the full error text for any query that's missing one -- that link creates
exactly the index that query needs.)

## What's in firestore.indexes.json and why

| Collection | Fields (in order) | Used by |
|---|---|---|
| `users` | `role`, `createdAt` | Drivers list / passengers list, sorted, no status filter |
| `users` | `role`, `verificationStatus`, `createdAt` | Drivers list filtered by approval status |
| `users` | `role`, `driverAvailability`, `createdAt` | Drivers list filtered by online/busy/offline |
| `users` | `role`, `verificationStatus`, `driverAvailability`, `createdAt` | Drivers list filtered by both status and availability at once |
| `rides` | `status`, `createdAt` | Ride History default view, Live Rides, and any dashboard drill-down filtered by one status/status-group |
| `rides` | `status`, `vehicle_type`, `createdAt` | Ride History filtered by status + vehicle type |
| `rides` | `status`, `driver_id`, `createdAt` | Ride History filtered by status + a specific driver |
| `rides` | `status`, `passenger_id`, `createdAt` | Ride History filtered by status + a specific passenger |
| `rides` | `driver_id`, `createdAt` | A driver's own recent rides (driver profile drawer) |
| `rides` | `vehicle_type`, `createdAt` | Ride History filtered by vehicle type with "All statuses" + a date range |
| `rides` | `passenger_id`, `createdAt` | Ride History filtered by a specific passenger with "All statuses" + a date range |
| `sosAlerts` | `status`, `createdAt` | Admin Safety section: SOS Alerts list filtered to open/resolved, newest first |
| `safetyReports` | `status`, `createdAt` | Admin Safety section: Reports list filtered to open/resolved, newest first |

`driverDailyStats` (Feature 1, driver dashboard) is read by direct document
ID (`{driverId}_{YYYY-MM-DD}`), never queried with a `.where(...)`, so it
needs no composite index at all.

A few queries deliberately need **no** composite index and aren't listed
here: plain equality-only filters (e.g. `role == driver` combined with
`verificationStatus == X`, with no `order_by`), and single-field range
filters like `createdAt >= today` with nothing else. Firestore's automatic
per-field indexes cover those on their own.

## Also check: firestore.rules is actually deployed

A local `firestore.rules` file being correct doesn't mean the *live*
Firebase project is running it -- that requires a separate deploy:

```bash
firebase deploy --only firestore:rules
```

If the admin console's realtime listeners show `permission-denied` in the
browser console even though this repo's rules already grant admin reads,
this is the most common cause. The second most common cause is a stale
cached ID token from *before* the `admin` custom claim was granted; the
console now force-refreshes the token automatically on both write calls
and the realtime listeners, but signing out and back in also fixes it.
