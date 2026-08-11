# LiphtUp

Unified repository for the LiphtUp ride-booking platform, supporting both Web (PWA) and Native Android (Capacitor) targets from a single source.

## Project Structure

- `www/`: Shared frontend application (HTML/JS/CSS).
- `api/`: Python FastAPI backend.
- `android/`: Native Android project (Capacitor).
- `docs/`: Documentation.
- `scripts/`: Build and utility scripts.

## Getting Started

### Prerequisites
- Node.js & npm (for Capacitor/Android)
- Python 3.x (for Backend)
- Android Studio (for Android development)

### Web Development
1. Configure environment variables (see `Environment Variables` below).
2. Run the API:
   ```bash
   pip install -r requirements.txt
   uvicorn api.index:app --reload --port 3000
   ```
3. Serve `www/` using any static file server.

### Android Development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Sync with Android project:
   ```bash
   npm run android:sync
   ```
3. Open `android/` in Android Studio.

## Build Scripts
- `scripts/build-web.sh`: Prepares the web build for deployment.
- `scripts/build-android.sh`: Prepares the Android build and syncs with Capacitor.

## Environment Variables
The backend expects the following:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `GOOGLE_MAPS_BROWSER_KEY`
- `GOOGLE_MAPS_SERVER_KEY`
- `TWOFACTOR_API_KEY`
- `OTP_SESSION_SECRET`

## License
No license file is currently present in this repository.
