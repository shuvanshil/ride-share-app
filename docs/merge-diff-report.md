# Merge Diff Report - LiphtUp Web vs Android

This report documents the divergences between the `www/` folders of the Web and Android repositories and the backend logic.

## Overview
The Android repository (`liphtup-android`) contains more recent logic fixes and architectural improvements. The target repo uses this as the baseline.

## Categorized Differences

### 1. Identical (Byte-for-byte)
- `api/__init__.py`
- `api/core/admin.py`, `auth.py`, `config.py`, `errors.py`, `fare_policy.py`, `firebase.py`, `geo.py`, `google_client.py`, `otp.py`, `rate_limit.py`, `__init__.py`.
- `api/routers/account.py`, `admin.py`, `auth.py`, `google.py`, `otp.py`.
- `assets/liphtup-logo.jpeg`, `assets/vehicle-markers/*.png`.
- `css/driver-dashboard.css`, `css/track.css`.

### 2. Differing (Size/Logic Diffs)
- `api/routers/notify.py`:
    - **Web**: Basic FCM multicast.
    - **Android**: Added `android` block and top-level `notification` block for reliable native background push.
    - **Resolution**: Use Android version (more feature-complete).
- `api/routers/rides.py`:
    - **Web**: Uses 2 decimal places for coarse location (~1.1km).
    - **Android**: Uses 4 decimal places (~11m) to prevent "jumping" markers while maintaining privacy.
    - **Resolution**: Use Android version (better UX).

### 3. Web-only logic accidentally missing from Android's copy
- `assets/icons/webicons/about-us.png`, `contact-us.png`, `safety.png`, `sos.png`, `view-more.png`.
- **Resolution**: Merged into unified `www/assets/`.

### 4. Android-only improvements (Baselined)
- `js/native-bridge.js`: Native interface for Capacitor. Moved to `js/platform/`.
- `js/wake-lock.js`: Screen wake lock for drivers. Replaced by `js/platform/wake-lock.js`.
- `auth.js`, `map.js`, `login.html`: Included Android-readiness fixes (loading states, robust page detection, `.html` suffixes).

## Notification Backend Status
- **Storage**: The backend stores an array of tokens in `pushTokens` and `pushTokenDetails` per user/driver.
- **Dispatch**: `api/routers/notify.py` sends to all tokens in the array using `MulticastMessage`.
- **Capability**: The backend **can** dispatch to both FCM (native) and Web Push (PWA) channels today, as long as both tokens are registered to the same user. The Android-repo version of `notify.py` correctly handles the payload differences for both platforms.

## URL Handling Resolution
- **Standard**: All internal links (`href`, `location.href`, `location.replace`) have been standardized to include explicit `.html` extensions.
- **Web (Vercel)**: `vercel.json` continues to use `cleanUrls: true`. This allows users on the web to see pretty URLs (e.g., `/login`) while the code uses the more robust `/login.html` path which works natively in the Android static shell.
- **Safety**: `native-bridge.js` includes an extension interceptor to automatically add `.html` to any internal link that might be missing it.

## Directory Expansion

### [www/js/platform/](file:///C:/Users/theto/Downloads/liphtup/www/js/platform)
- `firebase-init.js` (Moved from `js/`)
- `native-bridge.js` (Moved from `js/`)
- `notifications.js` (Unified adapter)
- `geolocation.js` (Unified adapter)
- `share.js` (Unified adapter)
- `storage.js` (Unified adapter)
- `wake-lock.js` (Unified adapter)

### [www/js/core/](file:///C:/Users/theto/Downloads/liphtup/www/js/core)
- `auth.js`
- `dashboard.js`
- `dialog.js`
- `driver-availability.js`
- `driver-dashboard.js`
- `driver-service.js`
- `driver.js`
- `fare-policy.js`
- `history.js`
- `loading.js`
- `login.js`
- `map.js`
- `messaging.js`
- `navigation.js`
- `password-toggle.js`
- `profile.js`
- `pwa.js`
- `services.js`
- `track.js`
