#!/usr/bin/env node
/**
 * sync-android-assets.js
 *
 * Fully standalone asset synchronizer for Capacitor Android.
 * Copies runtime web files from `www/` to `android/app/src/main/assets/public/`
 * and copies `capacitor.config.json` to `android/app/src/main/assets/capacitor.config.json`.
 * 
 * Excludes server-only / backend paths:
 * - api/ (FastAPI backend)
 * - admin/ (Web admin)
 * - requirements*.txt, vercel.json, sitemap.xml, robots.txt, *.py, *.pyc
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const WWW_DIR = path.join(ROOT_DIR, 'www');
const ANDROID_ASSETS_DIR = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'assets');
const PUBLIC_DIR = path.join(ANDROID_ASSETS_DIR, 'public');
const CONFIG_SRC = path.join(ROOT_DIR, 'capacitor.config.json');
const CONFIG_DEST = path.join(ANDROID_ASSETS_DIR, 'capacitor.config.json');

const EXCLUDED_NAMES = new Set([
  'api',
  'admin',
  'requirements.txt',
  'requirements-dev.txt',
  'vercel.json',
  'sitemap.xml',
  'robots.txt',
  '.git',
  '.DS_Store'
]);

function isExcluded(fileName) {
  if (EXCLUDED_NAMES.has(fileName)) return true;
  if (fileName.endsWith('.py') || fileName.endsWith('.pyc')) return true;
  return false;
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (isExcluded(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('[sync-android-assets] Starting synchronization...');

// 1. Ensure directories exist
if (!fs.existsSync(ANDROID_ASSETS_DIR)) {
  fs.mkdirSync(ANDROID_ASSETS_DIR, { recursive: true });
}

// 2. Clean previous public directory
if (fs.existsSync(PUBLIC_DIR)) {
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// 3. Copy www -> public
copyRecursive(WWW_DIR, PUBLIC_DIR);
console.log(`[sync-android-assets] Copied web assets from ${WWW_DIR} to ${PUBLIC_DIR}`);

// 4. Copy capacitor.config.json
if (fs.existsSync(CONFIG_SRC)) {
  fs.copyFileSync(CONFIG_SRC, CONFIG_DEST);
  console.log(`[sync-android-assets] Copied capacitor.config.json to assets.`);
}

console.log('[sync-android-assets] Synchronization complete!');
