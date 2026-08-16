# Build and Environment Optimization Plan

This plan addresses the Gradle warnings, JDK mismatch notifications, and performance recommendations identified in the Build Output and Build Analyzer.

## User Review Required

> [!IMPORTANT]
> **JDK Alignment**: I am setting the Gradle JDK to match your system's `JAVA_HOME` (`C:\Program Files\Android\Android Studio\jbr`). This will prevent multiple Gradle daemons from starting, which saves system memory and speeds up builds.

> [!NOTE]
> **Performance Tweaks**: I am increasing the maximum heap size for Gradle from 1.5GB to 4GB and enabling parallel execution. This should make your builds faster and more stable as the project grows.

## Proposed Changes

### Gradle Configuration

#### [MODIFY] [gradle.properties](file:///C:/Users/theto/ride-share-app/android/gradle.properties)
- Increase heap size (`org.gradle.jvmargs`) to 4GB for better performance.
- Enable parallel builds (`org.gradle.parallel=true`).
- Enable build caching (`org.gradle.caching=true`).
- Set `org.gradle.java.home` to match the system `JAVA_HOME` to resolve the "Multiple Gradle daemons" warning.

### Project Build Scripts

#### [MODIFY] [app/build.gradle](file:///C:/Users/theto/ride-share-app/android/app/build.gradle)
- Remove `flatDir` repository declaration. This resolves the warning "Using flatDir should be avoided" since no local `.aar` or `.jar` files were found in the specified directories.

#### [MODIFY] [capacitor-cordova-android-plugins/build.gradle](file:///C:/Users/theto/ride-share-app/android/capacitor-cordova-android-plugins/build.gradle)
- Remove `flatDir` repository declaration to resolve the same warning in this module.

---

## Verification Plan

### Automated Tests
- Run `gradlew clean assembleDebug` to ensure the project still builds correctly without `flatDir`.
- Verify that the "Using flatDir should be avoided" warning is gone.
- Check that no new "Multiple Gradle daemons" warnings appear in the build output.

### Manual Verification
- Observe Build Analyzer in Android Studio to confirm that memory utilization is healthy.
- Confirm that the JDK mismatch notification no longer appears.
