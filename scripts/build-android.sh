#!/bin/bash
echo "Building LiphtUp for Android..."
# Sync web assets with native project
npx cap sync android
# Optional: run the pruning script if needed
node scripts/prune-android-assets.js
echo "Android build complete. Open 'android/' in Android Studio to build APK."
