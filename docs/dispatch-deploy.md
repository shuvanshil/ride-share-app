# LiphtUp Pool-Based Dispatch: Deployment & Operations Guide

**Version:** 2.0 (Phase 2 Hardened)  
**Date:** 2026-10-05  

---

## 1. Firestore Composite Indexes

The following composite indexes are defined in `firestore.indexes.json` to support high-throughput pool streams and sweeper queries:

```json
{
  "indexes": [
    {
      "collectionGroup": "dispatchWPP",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "state", "order": "ASCENDING" },
        { "fieldPath": "req_time", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchDAP",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "state", "order": "ASCENDING" },
        { "fieldPath": "idle_since", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchDAP",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "state", "order": "ASCENDING" },
        { "fieldPath": "last_seen", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchScheduled",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "activatesAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchNotifyMe",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "expiresAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchAssignments",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "state", "order": "ASCENDING" },
        { "fieldPath": "created_at", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "dispatchRuns",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    }
  ]
}
```

---

## 2. Firestore Security Rules

Client devices communicate exclusively via the authenticated backend API. Direct read/write access to dispatch collections is strictly blocked to ensure atomic transactional integrity:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Dispatch system collections: Internal backend access only
    match /dispatchWPP/{docId} {
      allow read, write: if false;
    }
    match /dispatchDAP/{docId} {
      allow read, write: if false;
    }
    match /dispatchControl/{docId} {
      allow read, write: if false;
    }
    match /dispatchAssignments/{docId} {
      allow read, write: if false;
    }
    match /dispatchRuns/{docId} {
      allow read, write: if false;
    }
    match /dispatchEvents/{docId} {
      allow read, write: if false;
    }
    match /dispatchNotifications/{docId} {
      allow read, write: if false;
    }
    match /dispatchScheduled/{docId} {
      allow read, write: if false;
    }
    match /dispatchNotifyMe/{docId} {
      allow read, write: if false;
    }
    match /dispatchStats/{docId} {
      allow read, write: if false;
    }
    match /dispatchStatsDaily/{docId} {
      allow read, write: if false;
    }
  }
}
```

---

## 3. TTL & Automatic Expiration Policies

To prevent indefinite document accumulation, automatic Firestore TTL policies are enabled on epoch timestamp fields:

| Collection | TTL Field | Retention Period | Action |
| :--- | :--- | :---: | :--- |
| `dispatchRuns` | `expireAt` | 14 days | Automated cleanup of run performance telemetry. |
| `dispatchEvents` | `expireAt` | 30 days | Automated cleanup of detailed audit events. |
| `dispatchNotifications`| `expireAt` | 7 days | Automated cleanup of delivered outbox messages. |
| `dispatchAssignments`| `expireAt` | 14 days | Automated cleanup of historic assignment pairing records. |

---

## 4. Background Sweeper Daemon & Crontab Setup

### 4.1 In-Process Sweeper Daemon
In local and containerized environments, `api/index.py` executes `_bg_scheduled_ride_sweeper` in a dedicated background daemon thread running every 10 seconds.

### 4.2 Serverless Cron Configuration (`vercel.json`)
For Vercel or Cloud Scheduler deployments where background threads do not persist:

```json
{
  "crons": [
    {
      "path": "/api/dispatch/sweep",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/dispatch/nudge",
      "schedule": "* * * * *"
    }
  ]
}
```

---

## 5. Operational REST Endpoints

| Method | Endpoint | Authorization | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/dispatch/nudge` | Public / Cron | Flags `dirty=true` and immediately triggers matching loop. |
| `POST` | `/api/dispatch/sweep` | Public / Cron | Triggers full sweeper pass (stale drivers, expired offers, scheduled release, notify-me). |
| `GET` | `/api/dispatch/status` | User / Driver | Returns operational health, current pool counts, and lease status. |
| `GET` | `/api/dispatch/runs` | Admin | Returns recent solver run telemetry records. |
| `GET` | `/api/dispatch/assignments`| Admin | Returns recent driver-passenger assignments. |
| `GET` | `/api/dispatch/events` | Admin | Returns audit trail of recent dispatch pool transitions. |
| `GET` | `/api/admin/dispatch-stats` | Admin | Invariant validator, reciprocity checks, pool counts, and daily reconciliation. |
