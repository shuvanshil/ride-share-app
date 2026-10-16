package in.liphtup.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DriverLocationService
 *
 * Production-ready Android Foreground Service for LiphtUp.
 * Continues to acquire and transmit driver GPS location when the driver navigates
 * away, switches to Google Maps for turn-by-turn navigation, locks the device,
 * or backgrounds the application.
 */
public class DriverLocationService extends Service implements LocationListener {
    private static final String TAG = "DriverLocationService";

    public static final String CHANNEL_ID = "driver_tracking_channel";
    public static final int NOTIFICATION_ID = 4001;

    public static final String ACTION_START = "in.liphtup.app.action.START_TRACKING";
    public static final String ACTION_UPDATE_STATE = "in.liphtup.app.action.UPDATE_TRACKING_STATE";
    public static final String ACTION_STOP = "in.liphtup.app.action.STOP_TRACKING";

    public static final String EXTRA_TRACKING_STATE = "tracking_state"; // "on_duty" or "active_ride"
    public static final String EXTRA_RIDE_ID = "ride_id";
    public static final String EXTRA_AUTH_TOKEN = "auth_token";
    public static final String EXTRA_REFRESH_TOKEN = "refresh_token";
    public static final String EXTRA_API_BASE_URL = "api_base_url";

    public static final String DEFAULT_API_BASE_URL = "https://liphtup.in";
    private static final String FIREBASE_API_KEY = "AIzaSyCyzfuJy3DuhVQ5mL6OTXpkZLs7EgVklws";

    public interface LocationCallback {
        void onLocationUpdated(Location location, Float bearing, String trackingState, String rideId);
    }

    private static volatile LocationCallback activeCallback = null;
    private static volatile boolean isServiceRunning = false;
    private static volatile boolean isAppInForeground = false;
    private static volatile DriverLocationService activeInstance = null;
    private volatile String dynamicNotificationText = null;

    public static void setLocationCallback(LocationCallback callback) {
        activeCallback = callback;
    }

    public static boolean isRunning() {
        return isServiceRunning;
    }

    public static void updateNotificationTextDynamic(String text) {
        if (activeInstance != null) {
            activeInstance.dynamicNotificationText = text;
            activeInstance.mainHandler.post(activeInstance::updateNotification);
        }
    }

    public static void updateRideProgress(double remainingKm, int etaMins) {
        if (activeInstance != null) {
            String formatted;
            if (remainingKm <= 0.05) {
                formatted = "Arrived at destination • Completing ride";
            } else {
                formatted = String.format(java.util.Locale.US, "%.1f KM remaining • %d mins to destination", remainingKm, etaMins);
            }
            activeInstance.dynamicNotificationText = formatted;
            activeInstance.mainHandler.post(activeInstance::updateNotification);
        }
    }

    public static void setAppInForeground(boolean inForeground) {
        isAppInForeground = inForeground;
        Log.d(TAG, "App foreground state changed to: " + inForeground);
    }

    public static boolean isAppInForeground() {
        return isAppInForeground;
    }

    private LocationManager locationManager;
    private NotificationManager notificationManager;
    private android.os.PowerManager.WakeLock wakeLock = null;
    private ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private String trackingState = "on_duty";
    private String activeRideId = "";
    private String authToken = "";
    private String refreshToken = "";
    private String apiBaseUrl = DEFAULT_API_BASE_URL;

    private Location lastBroadcastLocation = null;
    private long lastBroadcastTimeMs = 0;
    private Location lastHttpTransmitLocation = null;
    private long lastHttpTransmitTimeMs = 0;
    private Float lastBearing = null;
    private long lastGpsFixTimeMs = 0;

    private static final int MAX_OFFLINE_QUEUE_SIZE = 60;
    private final java.util.concurrent.ConcurrentLinkedQueue<JSONObject> offlineQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();

    public static String normalizeApiBaseUrl(String url) {
        if (url == null || url.trim().isEmpty()) {
            return DEFAULT_API_BASE_URL;
        }
        String trimmed = url.trim();
        if (trimmed.contains("localhost") || trimmed.contains("127.0.0.1") || trimmed.startsWith("capacitor:") || trimmed.startsWith("file:")) {
            return DEFAULT_API_BASE_URL;
        }
        if (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private synchronized void ensureWakeLockAcquired() {
        try {
            if (wakeLock == null) {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "LiphtUp:DriverLocationTracking");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
                Log.d(TAG, "Continuous partial WakeLock acquired for driver location tracking.");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not acquire partial WakeLock: " + e.getMessage());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        isServiceRunning = true;
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureWakeLockAcquired();
        createNotificationChannel();

        SharedPreferences prefs = getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE);
        trackingState = prefs.getString("tracking_state", "on_duty");
        activeRideId = prefs.getString("ride_id", "");
        authToken = prefs.getString("auth_token", "");
        refreshToken = prefs.getString("refresh_token", "");
        apiBaseUrl = normalizeApiBaseUrl(prefs.getString("api_base_url", DEFAULT_API_BASE_URL));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureWakeLockAcquired();
        if (intent == null) {
            startForegroundWithNotification();
            requestLocationUpdates();
            return START_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            Log.d(TAG, "Stopping driver background location service.");
            dynamicNotificationText = null;
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent.hasExtra(EXTRA_TRACKING_STATE)) {
            trackingState = intent.getStringExtra(EXTRA_TRACKING_STATE);
        }
        if (intent.hasExtra(EXTRA_RIDE_ID)) {
            String newRideId = intent.getStringExtra(EXTRA_RIDE_ID);
            if (newRideId != null && !newRideId.equals(activeRideId)) {
                dynamicNotificationText = null;
            }
            activeRideId = newRideId != null ? newRideId : "";
        }
        if (intent.hasExtra(EXTRA_AUTH_TOKEN)) {
            String token = intent.getStringExtra(EXTRA_AUTH_TOKEN);
            if (token != null && !token.isEmpty()) {
                authToken = token;
            }
        }
        if (intent.hasExtra(EXTRA_REFRESH_TOKEN)) {
            String rToken = intent.getStringExtra(EXTRA_REFRESH_TOKEN);
            if (rToken != null && !rToken.isEmpty()) {
                refreshToken = rToken;
            }
        }
        if (intent.hasExtra(EXTRA_API_BASE_URL)) {
            String url = intent.getStringExtra(EXTRA_API_BASE_URL);
            if (url != null && !url.isEmpty()) {
                apiBaseUrl = normalizeApiBaseUrl(url);
            }
        }

        // Persist parameters for restart resilience
        getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE).edit()
                .putString("tracking_state", trackingState)
                .putString("ride_id", activeRideId)
                .putString("auth_token", authToken)
                .putString("refresh_token", refreshToken)
                .putString("api_base_url", apiBaseUrl)
                .apply();

        startForegroundWithNotification();
        requestLocationUpdates();
        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "LiphtUp Driver Tracking",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Broadcasting driver location for passenger navigation and dispatch.");
            channel.enableVibration(false);
            channel.setShowBadge(false);
            notificationManager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        boolean isActiveRide = "active_ride".equalsIgnoreCase(trackingState) && activeRideId != null && !activeRideId.isEmpty();
        String title = isActiveRide ? "LiphtUp Navigation Active" : "LiphtUp Driver On-Duty";
        String content;
        if (dynamicNotificationText != null && !dynamicNotificationText.trim().isEmpty() && isActiveRide) {
            content = dynamicNotificationText.trim();
        } else {
            content = isActiveRide
                    ? "Broadcasting live route location to passenger"
                    : "GPS active. Ready for new ride requests";
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (isActiveRide) {
            launchIntent.putExtra("url", "/driver-service.html?rideId=" + activeRideId);
        } else {
            launchIntent.putExtra("url", "/driver-service.html");
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        int iconRes = getResources().getIdentifier("ic_stat_liphtup", "drawable", getPackageName());
        if (iconRes == 0) {
            iconRes = android.R.drawable.ic_menu_mylocation;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(iconRes)
                .setContentTitle(title)
                .setContentText(content)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);

        return builder.build();
    }

    private void startForegroundWithNotification() {
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to start foreground service with notification: " + e.getMessage(), e);
        }
    }

    private void updateNotification() {
        if (notificationManager != null && isServiceRunning) {
            notificationManager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private void requestLocationUpdates() {
        if (locationManager == null) return;

        boolean isActiveRide = "active_ride".equalsIgnoreCase(trackingState);
        long minTimeMs = isActiveRide ? 2000L : 6000L;
        // Use 0.0f minDistance so timed updates and stationary heartbeats are not dropped by the OS
        float minDistanceMeters = 0.0f;

        try {
            locationManager.removeUpdates(this);
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER,
                        minTimeMs,
                        minDistanceMeters,
                        this,
                        Looper.getMainLooper()
                );
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER,
                        minTimeMs * 2,
                        minDistanceMeters,
                        this,
                        Looper.getMainLooper()
                );
            }
            Log.d(TAG, "Requested location updates with state=" + trackingState + ", minTime=" + minTimeMs);
        } catch (SecurityException se) {
            Log.e(TAG, "Missing location permissions for background tracking", se);
        } catch (Exception e) {
            Log.e(TAG, "Failed to request location updates", e);
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null) return;

        // Filter fixes with poor accuracy (greater than 60m)
        if (location.hasAccuracy() && location.getAccuracy() > 60f) {
            Log.d(TAG, "Discarded location fix with poor accuracy: " + location.getAccuracy() + "m");
            return;
        }

        long now = System.currentTimeMillis();
        String provider = location.getProvider();
        if (LocationManager.GPS_PROVIDER.equals(provider)) {
            lastGpsFixTimeMs = now;
        } else if (LocationManager.NETWORK_PROVIDER.equals(provider)) {
            // If GPS has delivered a fresh fix within the last 15 seconds, ignore coarse network fixes to eliminate jumping
            if (now - lastGpsFixTimeMs < 15000L) {
                Log.d(TAG, "Ignored network fix because GPS is actively reporting.");
                return;
            }
        }

        boolean isActiveRide = "active_ride".equalsIgnoreCase(trackingState);

        // Compute motion bearing if GPS did not provide heading and we have moved >= 3m
        if (lastBroadcastLocation != null) {
            float distanceMoved = lastBroadcastLocation.distanceTo(location);
            long elapsed = now - lastBroadcastTimeMs;

            // Plausibility check: speed > 55 m/s (~198 km/h) jump is rejected
            if (elapsed > 0) {
                float speedMps = distanceMoved / (elapsed / 1000f);
                if (speedMps > 55f) {
                    Log.w(TAG, "Rejected implausible speed jump: " + speedMps + " m/s");
                    return;
                }
            }

            if (distanceMoved >= 3.0f) {
                float computedBearing = lastBroadcastLocation.bearingTo(location);
                if (computedBearing < 0) computedBearing += 360f;
                lastBearing = computedBearing;
            }
        }

        if (location.hasBearing() && !Float.isNaN(location.getBearing()) && location.getBearing() >= 0) {
            lastBearing = location.getBearing();
        }

        lastBroadcastLocation = location;
        lastBroadcastTimeMs = now;

        // 1. Immediately forward all valid fixes to WebView callback when in foreground
        // This ensures the driver's map UI and vehicle icon animate smoothly without lag
        final Location finalLoc = location;
        final Float finalHeading = lastBearing;
        mainHandler.post(() -> {
            if (activeCallback != null) {
                activeCallback.onLocationUpdated(finalLoc, finalHeading, trackingState, activeRideId);
            }
        });

        // 2. Direct HTTP Post to backend when app is backgrounded / WebView is suspended
        // When foregrounded AND activeCallback is attached, the WebView handles location ingestion
        // to avoid duplicate HTTP requests.
        // When backgrounded (minimized, screen off, or driver navigating in Google Maps) OR if
        // the WebView callback is disconnected, DriverLocationService independently posts telemetry
        // directly over HTTPS to /api/rides/driver-location so live tracking never stops.
        boolean isForegroundReady = isAppInForeground && (activeCallback != null);
        if (!isForegroundReady && authToken != null && !authToken.isEmpty()) {
            float distanceSinceLastHttp = lastHttpTransmitLocation != null ? lastHttpTransmitLocation.distanceTo(location) : Float.MAX_VALUE;
            long elapsedHttp = now - lastHttpTransmitTimeMs;

            long minHttpInterval = isActiveRide ? 2200L : 5500L;
            long heartbeatHttpInterval = isActiveRide ? 8000L : 25000L;

            boolean shouldTransmit = false;
            if (lastHttpTransmitLocation == null) {
                shouldTransmit = true;
            } else if (distanceSinceLastHttp < 2.0f) {
                shouldTransmit = (elapsedHttp >= heartbeatHttpInterval);
            } else {
                shouldTransmit = (elapsedHttp >= minHttpInterval);
            }

            if (shouldTransmit) {
                lastHttpTransmitLocation = location;
                lastHttpTransmitTimeMs = now;
                transmitLocationToBackend(location, finalHeading, activeRideId);
            }
        }
    }

    private synchronized boolean refreshAuthTokenSync() {
        if (refreshToken == null || refreshToken.trim().isEmpty()) {
            Log.w(TAG, "No refresh token available to refresh auth token.");
            return false;
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://securetoken.googleapis.com/v1/token?key=" + FIREBASE_API_KEY);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);

            String body = "grant_type=refresh_token&refresh_token=" + java.net.URLEncoder.encode(refreshToken.trim(), "UTF-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
                os.flush();
            }

            int code = conn.getResponseCode();
            if (code == 200) {
                java.io.InputStream is = conn.getInputStream();
                java.util.Scanner s = new java.util.Scanner(is, StandardCharsets.UTF_8.name()).useDelimiter("\\A");
                String responseStr = s.hasNext() ? s.next() : "";
                JSONObject resJson = new JSONObject(responseStr);
                String newIdToken = resJson.optString("id_token", resJson.optString("access_token", ""));
                String newRefresh = resJson.optString("refresh_token", refreshToken);
                if (!newIdToken.isEmpty()) {
                    this.authToken = newIdToken;
                    this.refreshToken = newRefresh;
                    getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE).edit()
                            .putString("auth_token", authToken)
                            .putString("refresh_token", refreshToken)
                            .apply();
                    Log.i(TAG, "Successfully refreshed Firebase Auth token in background service.");
                    return true;
                }
            } else {
                Log.w(TAG, "Token refresh request failed with HTTP " + code);
            }
        } catch (Exception e) {
            Log.e(TAG, "Exception during background auth token refresh: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
        return false;
    }

    private void transmitLocationToBackend(Location location, Float heading, String rideId) {
        if (networkExecutor == null || networkExecutor.isShutdown()) {
            networkExecutor = Executors.newSingleThreadExecutor();
        }
        networkExecutor.execute(() -> {
            boolean success = doTransmit(location, heading, rideId);
            if (!success && authToken != null && !authToken.isEmpty()) {
                // If failed due to 401 or token expiration during long ride, refresh and retry once
                if (refreshAuthTokenSync()) {
                    doTransmit(location, heading, rideId);
                }
            }
        });
    }

    private void enqueueOfflineFix(JSONObject payload) {
        if (payload == null) return;
        if (offlineQueue.size() >= MAX_OFFLINE_QUEUE_SIZE) {
            offlineQueue.poll();
        }
        offlineQueue.offer(payload);
        Log.d(TAG, "Enqueued offline location fix, queue size: " + offlineQueue.size());
    }

    private void flushOfflineQueue() {
        if (offlineQueue.isEmpty()) return;
        int drained = 0;
        while (!offlineQueue.isEmpty() && drained < 5) {
            JSONObject queued = offlineQueue.poll();
            if (queued == null) break;
            drained++;
            int code = sendPayloadHttp(queued);
            if (code != 200 && code != 204) {
                enqueueOfflineFix(queued);
                break;
            }
        }
    }

    private int sendPayloadHttp(JSONObject payload) {
        HttpURLConnection conn = null;
        try {
            String endpoint = normalizeApiBaseUrl(apiBaseUrl) + "/api/rides/driver-location";
            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + authToken);
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setDoOutput(true);

            byte[] postBytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(postBytes);
                os.flush();
            }

            int code = conn.getResponseCode();
            Log.d(TAG, "Transmitted location via native background service: status=" + code);
            if (code == 200) {
                try (java.io.InputStream is = conn.getInputStream()) {
                    if (is != null) {
                        java.util.Scanner scanner = new java.util.Scanner(is, StandardCharsets.UTF_8.name()).useDelimiter("\\A");
                        String respBody = scanner.hasNext() ? scanner.next() : "";
                        if (!respBody.isEmpty()) {
                            JSONObject json = new JSONObject(respBody);
                            if (json.has("remaining_km") && !json.isNull("remaining_km") &&
                                json.has("eta_mins") && !json.isNull("eta_mins")) {
                                double remainingKm = json.getDouble("remaining_km");
                                int etaMins = json.getInt("eta_mins");
                                updateRideProgress(remainingKm, etaMins);
                            }
                        }
                    }
                } catch (Exception ex) {
                    Log.d(TAG, "Could not parse response for dynamic notification: " + ex.getMessage());
                }
            }
            return code;
        } catch (Exception e) {
            Log.w(TAG, "Native background location transmission failed: " + e.getMessage());
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean doTransmit(Location location, Float heading, String rideId) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("lat", location.getLatitude());
            payload.put("lng", location.getLongitude());
            if (rideId != null && !rideId.isEmpty()) {
                payload.put("rideId", rideId);
            }
            if (location.hasSpeed() && !Float.isNaN(location.getSpeed()) && location.getSpeed() >= 0 && location.getSpeed() <= 55.0f) {
                payload.put("driverSpeed", location.getSpeed());
            }
            if (location.hasAccuracy() && !Float.isNaN(location.getAccuracy()) && location.getAccuracy() >= 0) {
                payload.put("driverAccuracy", location.getAccuracy());
            }
            if (heading != null && !Float.isNaN(heading) && heading >= 0 && heading <= 360.0f) {
                payload.put("driverHeading", heading.doubleValue());
            }
        } catch (Exception ignored) {}

        int code = sendPayloadHttp(payload);
        if (code == 200 || code == 204) {
            flushOfflineQueue();
            return true;
        }
        if (code == 401) {
            Log.w(TAG, "Backend returned 401 Unauthorized for background location.");
            return false;
        }
        if (code == 404 || code == 409) {
            Log.w(TAG, "Active ride terminated on backend (status=" + code + "). Resetting to on_duty.");
            mainHandler.post(() -> {
                activeRideId = "";
                trackingState = "on_duty";
                getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE).edit()
                        .putString("tracking_state", "on_duty")
                        .putString("ride_id", "")
                        .apply();
                updateNotification();
                requestLocationUpdates();
            });
            return true;
        }
        if (code == -1 || code >= 500) {
            enqueueOfflineFix(payload);
        }
        return false;
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {
        Log.d(TAG, "Location provider enabled: " + provider);
        requestLocationUpdates();
    }

    @Override
    public void onProviderDisabled(String provider) {
        Log.w(TAG, "Location provider disabled: " + provider);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (activeInstance == this) {
            activeInstance = null;
        }
        isServiceRunning = false;
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {}
        }
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (Exception ignored) {}
        }
        networkExecutor.shutdown();
        Log.d(TAG, "Driver location service destroyed.");
    }
}
