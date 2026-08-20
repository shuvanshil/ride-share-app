# Implementation Plan - Google Play Store Readiness

This plan implements the technical requirements for a safe and professional Android app submission to the Google Play Store.

## Proposed Changes

### Native Bridge & Secrets Management
We will move the hardcoded Google Maps API key from the JavaScript layer to the native Android layer for better security and flexibility.

#### [NEW] [keys.xml](file:///C:/Users/theto/ride-share-app/android/app/src/main/res/values/keys.xml)
- Store the Google Maps API key as a resource string.

#### [MODIFY] [MainActivity.java](file:///C:/Users/theto/ride-share-app/android/app/src/main/java/in/liphtup/app/MainActivity.java)
- Expose the API key to the WebView via the `LiphtUpNativeStatus` JavascriptInterface.

#### [MODIFY] [map-core.js](file:///C:/Users/theto/ride-share-app/android/app/src/main/assets/public/js/map/map-core.js)
- Remove hardcoded keys and fetch the key from the native bridge.

---

### Security & Build Optimization (R8)
We will enable code shrinking and obfuscation to protect the app's logic and reduce its size.

#### [MODIFY] [app/build.gradle](file:///C:/Users/theto/ride-share-app/android/app/build.gradle)
- Enable `minifyEnabled` and `shrinkResources` for the release build.
- Increment `versionCode` to 2.

#### [MODIFY] [proguard-rules.pro](file:///C:/Users/theto/ride-share-app/android/app/proguard-rules.pro)
- Add essential ProGuard rules for Capacitor and the native bridge objects.

---

### Network Security
We will implement a Network Security Configuration to restrict the app's network traffic to trusted domains.

#### [NEW] [network_security_config.xml](file:///C:/Users/theto/ride-share-app/android/app/src/main/res/xml/network_security_config.xml)
- Define a whitelist of allowed domains (liphtup.in, googleapis.com, etc.).

#### [MODIFY] [AndroidManifest.xml](file:///C:/Users/theto/ride-share-app/android/app/src/main/AndroidManifest.xml)
- Link the Network Security Configuration to the application.

#### [MODIFY] [config.xml](file:///C:/Users/theto/ride-share-app/android/app/src/main/res/xml/config.xml)
- Refine Cordova access origins to match the security policy.

## Verification Plan

### Automated Tests
- Run `./gradlew assembleRelease` to ensure the project builds correctly with minification enabled.
- Run `./gradlew lintRelease` to check for any fatal compliance issues.

### Manual Verification
- Verify the app still loads the map correctly using the native bridge key.
- Verify that network requests to production APIs are successful under the new security policy.
