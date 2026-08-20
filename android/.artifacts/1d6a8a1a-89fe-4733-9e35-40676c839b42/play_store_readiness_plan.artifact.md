# Technical Readiness Plan for Google Play Store Submission

This plan outlines the essential technical steps required to prepare the **LiphtUp** Android app for a safe and professional release on the Google Play Store. These steps focus on security, performance, and compliance with modern Android standards.

## 1. Security & Code Optimization (R8/ProGuard)

Currently, the release build does not shrink or obfuscate the code, which leaves the app larger than necessary and the source code easier to reverse-engineer.

- [ ] **Enable Minification:** In [app/build.gradle](file:///C:/Users/theto/ride-share-app/android/app/build.gradle), set `minifyEnabled true` and `shrinkResources true` in the `release` block.
- [ ] **Configure ProGuard Rules:** Update [proguard-rules.pro](file:///C:/Users/theto/ride-share-app/android/app/proguard-rules.pro) to include rules for Capacitor and any third-party plugins to prevent them from being accidentally stripped during minification.

## 2. Secrets Management & API Security

Hardcoded API keys are a significant security risk as they can be extracted from the APK.

- [ ] **Remove Hardcoded Keys:** Identify and remove the hardcoded Google Maps key in `js/map/map-core.js` and any other secrets in the frontend assets.
- [ ] **Implement Build-time Injection:** Use `BuildConfig` or restricted resources to inject these keys at build time, or fetch them from a secure backend.
- [ ] **Key Restriction:** Ensure all API keys (Google Maps, Firebase, etc.) are restricted in their respective consoles (Google Cloud, Firebase) to only work with the app's production package name (`in.liphtup.app`) and the production SHA-1 certificate.

## 3. Versioning & Signing

- [ ] **Versioning Strategy:** Increment `versionCode` (must be an integer higher than the previous release) and `versionName` in [app/build.gradle](file:///C:/Users/theto/ride-share-app/android/app/build.gradle) before every build destined for the Play Store.
- [ ] **Automated Signing:** Configure `signingConfigs` in the Gradle build script. Use environment variables to reference the keystore file and passwords so they are not committed to version control.

## 4. Privacy & Permissions Compliance

The Play Store has strict policies regarding sensitive data, especially location.

- [ ] **Location Justification:** Since the app uses `ACCESS_FINE_LOCATION`, ensure the app's privacy policy clearly explains why this is needed (e.g., for ride matching and navigation).
- [ ] **Background Location:** If the driver tracking needs to continue when the app is minimized, you MUST add `ACCESS_BACKGROUND_LOCATION` to the manifest and undergo a specific review process by Google.
- [ ] **Data Safety Section:** Review the app's data collection (e.g., Firebase Analytics) and prepare to accurately fill out the "Data Safety" section in the Play Console.

## 5. Network Security & Performance

- [ ] **Network Security Configuration:** Add a `network_security_config.xml` to `res/xml` to explicitly allow traffic only to trusted domains.
- [ ] **Refine Cordova Access:** Change `<access origin="*" />` in [config.xml](file:///C:/Users/theto/ride-share-app/android/app/src/main/res/xml/config.xml) to specific domains to reduce the attack surface.
- [ ] **App Bundle Generation:** Always build and upload an **Android App Bundle (.aab)** instead of an APK. This allows Google Play to generate optimized APKs for each user's device configuration.

## 6. Verification & Quality Assurance

- [ ] **Lint Analysis:** Run `./gradlew lintRelease` to identify potential bugs, security vulnerabilities, and performance issues. Fix all "Fatal" and "Error" level warnings.
- [ ] **Splash Screen Audit:** Verify that the `core-splashscreen` implementation works seamlessly across Android 11, 12, and 13+ to avoid "double splash" or branding issues.
- [ ] **Log Cleanup:** Ensure that debug logging (e.g., `Log.d`, `console.log`) is disabled or removed in the release build to prevent leaking internal app state.
