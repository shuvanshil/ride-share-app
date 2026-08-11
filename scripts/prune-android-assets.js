#!/usr/bin/env node
/**
 * prune-android-assets.js
 *
 * `www/` is dual-purpose: it's both the Vercel project root (static site +
 * `www/api/*.py` FastAPI functions) AND the Capacitor `webDir`. `npx cap
 * sync` copies the ENTIRE webDir verbatim into
 * android/app/src/main/assets/public, which means the FastAPI backend's
 * Python source, tests, and requirements.txt were being bundled straight
 * into the shipped APK -- extractable by anyone who unzips the APK.
 *
 * This script removes the server-only paths from the copied Android assets
 * AFTER `cap sync`/`cap copy`, without touching www/ itself (so the Vercel
 * deployment is completely unaffected). Run automatically via the
 * `android:sync` npm script.
 */
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'public');

// Server-only / non-runtime paths that the Android app never needs at runtime.
const PRUNE_PATHS = [
    'api',               // FastAPI backend source (www/api/**/*.py)
    'admin',             // Web-only admin dashboard
    'requirements.txt',
    'requirements-dev.txt',
    'vercel.json',
    'sitemap.xml',
    'robots.txt',
];

function removePath(targetPath) {
    if (!fs.existsSync(targetPath)) return false;
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
}

if (!fs.existsSync(ASSETS_DIR)) {
    console.error(`[prune-android-assets] ${ASSETS_DIR} does not exist. Run "npx cap sync android" first.`);
    process.exit(1);
}

let removedCount = 0;
for (const relPath of PRUNE_PATHS) {
    const fullPath = path.join(ASSETS_DIR, relPath);
    if (removePath(fullPath)) {
        console.log(`[prune-android-assets] Removed ${relPath}`);
        removedCount += 1;
    }
}

console.log(`[prune-android-assets] Done. Removed ${removedCount} server-only path(s) from the Android bundle.`);
