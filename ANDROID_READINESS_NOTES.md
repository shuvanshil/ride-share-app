# LiphtUp Android Readiness — What Was Broken, What Was Fixed

Two git commits are in this zip:
- `baseline: state as received from teammate` — exact starting point, untouched
- `Android readiness: fix build blocker, permissions, API connectivity, native push` — everything below

Run `git log -p` or `git show f1ec0f0` (or your local hash) to see the full diff.

## What was actually broken

1. **The project would not build.** `styles.xml` references `@color/colorPrimary`,
   `colorPrimaryDark`, `colorAccent`, but `res/values/colors.xml` did not exist
   anywhere in the project. This is a hard Android resource-linking failure —
   nothing else mattered until this was fixed.
2. **`npx cap sync` had never been run.** `android/app/src/main/assets/public`
   didn't exist, so even a successful build would have shipped an app with no
   web content in it.
3. **No location or notification permissions.** The manifest only declared
   `INTERNET`. `navigator.geolocation` (used throughout `map.js`, `driver.js`,
   `driver-service.js`, `dashboard.js`) and any notification prompt would
   silently fail on-device.
4. **Every API call was broken inside the app.** `fetch("/api/...")` is
   relative everywhere in the codebase. On the website that's same-origin and
   fine. Inside the bundled Capacitor app, the app's origin is
   `https://localhost`, so those calls were resolving to
   `https://localhost/api/...` — nothing there. Login, ride requests, SOS,
   dispatch, everything that talks to the backend was silently failing.
5. **No CORS on the backend.** Never needed before (same-origin website), but
   required now that the app calls the API cross-origin.
6. **Push notifications were web-push only** (Firebase Messaging JS SDK +
   service worker `getToken`). This does not reliably deliver in a bare
   Android WebView, especially when the app is backgrounded or killed — there
   is no persistent Push API service the way a real Chrome browser has one.
   The backend's FCM message also only carried a `webpush` config block,
   which native Android tokens ignore entirely.
7. **Zero Capacitor plugins installed** — no back-button handling, no status
   bar/splash control, no native push plugin.
8. **Backend Python source was being shipped inside the APK.** `www/` is
   dual-purpose (Vercel project root *and* Capacitor `webDir`), so
   `cap sync` was copying `www/api/*.py`, `requirements.txt`, and tests
   straight into `assets/public` — extractable by unzipping the released APK.

## What was fixed

| # | Fix | File(s) |
|---|-----|---------|
| 1 | Added the missing `colors.xml` (brand green `#1A7A2E`, matching `manifest.webmanifest`) | `android/app/src/main/res/values/colors.xml` |
| 2 | Ran `npm install` + `npx cap sync android` so the native project actually has plugins registered and web assets copied | — |
| 3 | Added `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE` permissions | `android/app/src/main/AndroidManifest.xml` |
| 4 | New `native-bridge.js`, loaded first on every page: patches `fetch()` so any relative `/api/...` call is redirected to `https://liphtup.in` **only** when running inside the native app (website is untouched); wires the hardware back button to in-page history instead of instantly exiting; sets status bar color; hides the splash screen; creates the Android notification channel | `www/js/native-bridge.js` + one `<script>` line added to the top of every page (`index.html`, `login.html`, `driver.html`, `driver-dashboard.html`, `driver-service.html`, `history.html`, `profile.html`, `services.html`, `track.html`) |
| 5 | Added `CORSMiddleware` allowing the app's origin (`https://localhost`) plus the real website domain | `www/api/index.py` |
| 6 | Added `android=AndroidConfig(...)` to the FCM message so ride-request pushes show a real system notification (sound, channel, tag) on native Android, not just the web-push block | `www/api/routers/notify.py` |
| 7 | `messaging.js` now branches: native FCM registration inside the app, unchanged web-push flow on the website | `www/js/messaging.js` |
| 8 | New prune script strips `api/`, `requirements*.txt` out of the **Android-only** copy after every sync, so backend source no longer ships inside the APK. Nothing about `www/` itself or the Vercel deployment changes. | `scripts/prune-android-assets.js`, `package.json` (`npm run android:sync`) |

**Nothing about the website/PWA was changed in a way that affects it** — `native-bridge.js`'s fetch patch and all native-only behavior is gated behind `Capacitor.isNativePlatform()`, which is `false` on the regular website.

## What you still need to do locally (can't be done in this environment — no Android SDK here)

1. **Pull this branch/zip, then run:**
   ```
   npm install
   npm run android:sync
   ```
   (This runs `cap sync android` and prunes the backend source from the Android copy — always use this instead of a bare `cap sync` from now on.)

2. **Firebase Cloud Messaging (required for native push to work at all):**
   - In the Firebase console, add an **Android app** to the existing `tripura-rideshare` project with package name `in.liphtup.app`.
   - Download the generated `google-services.json` and place it at
     `android/app/google-services.json` (the root `build.gradle` and
     `app/build.gradle` already conditionally apply the Google Services
     plugin if this file is present — no gradle changes needed).

3. **Open in Android Studio, let Gradle sync, and build a debug APK** to confirm it compiles and installs on a device/emulator. Given how far behind this was, I'd genuinely test:
   - App launches without crashing (colors.xml fix)
   - Login/OTP flow completes (API connectivity fix)
   - Location permission prompt appears and map/GPS works
   - A ride-request test push shows up as a real notification with sound

4. **Deploy the backend change.** The CORS and notify.py changes need to go
   out to Vercel before the app's API calls or pushes will work end-to-end.

## What's still outstanding (not attempted — bigger, riskier changes)

- **True background location tracking.** `navigator.geolocation.watchPosition`
  pauses when the WebView is backgrounded/minimized. If drivers need their
  location to keep updating while the app isn't in the foreground, that
  requires a native foreground-service location plugin
  (`@capacitor-community/background-geolocation` or similar) plus a
  persistent notification (Play Store requires disclosure + justification for
  background location). This is a real feature addition, not a config fix —
  worth a separate, focused pass once the above is confirmed working.
- **Signing/release build, Play Console listing, Data Safety form, privacy
  policy, etc.** — none of that was touched; this pass was scoped to "make
  the app actually function," per your ask.
