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
    public static final String EXTRA_API_BASE_URL = "api_base_url";

    public interface LocationCallback {
        void onLocationUpdated(Location location, Float bearing, String trackingState, String rideId);
    }

    private static volatile LocationCallback activeCallback = null;
    private static volatile boolean isServiceRunning = false;
    private static volatile boolean isAppInForeground = true;

    public static void setLocationCallback(LocationCallback callback) {
        activeCallback = callback;
    }

    public static boolean isRunning() {
        return isServiceRunning;
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
    private String apiBaseUrl = "https://liphtup.in";

    private Location lastBroadcastLocation = null;
    private long lastBroadcastTimeMs = 0;
    private Float lastBearing = null;
    private long lastGpsFixTimeMs = 0;

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
        isServiceRunning = true;
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureWakeLockAcquired();
        createNotificationChannel();

        SharedPreferences prefs = getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE);
        trackingState = prefs.getString("tracking_state", "on_duty");
        activeRideId = prefs.getString("ride_id", "");
        authToken = prefs.getString("auth_token", "");
        apiBaseUrl = prefs.getString("api_base_url", "https://liphtup.in");
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
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent.hasExtra(EXTRA_TRACKING_STATE)) {
            trackingState = intent.getStringExtra(EXTRA_TRACKING_STATE);
        }
        if (intent.hasExtra(EXTRA_RIDE_ID)) {
            activeRideId = intent.getStringExtra(EXTRA_RIDE_ID);
        }
        if (intent.hasExtra(EXTRA_AUTH_TOKEN)) {
            String token = intent.getStringExtra(EXTRA_AUTH_TOKEN);
            if (token != null && !token.isEmpty()) {
                authToken = token;
            }
        }
        if (intent.hasExtra(EXTRA_API_BASE_URL)) {
            String url = intent.getStringExtra(EXTRA_API_BASE_URL);
            if (url != null && !url.isEmpty()) {
                apiBaseUrl = url;
            }
        }

        // Persist parameters for restart resilience
        getSharedPreferences("liphtup_driver_tracking", MODE_PRIVATE).edit()
                .putString("tracking_state", trackingState)
                .putString("ride_id", activeRideId)
                .putString("auth_token", authToken)
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
        String content = isActiveRide
                ? "Broadcasting live route location to passenger"
                : "GPS active. Ready for new ride requests";

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
        long minTimeMs = isActiveRide ? 2500L : 8000L;
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

            // Stationary heartbeat & cadence:
            // In active ride: updates every 2.5s if moving, or every 8s if stationary.
            // In on_duty idle: updates every 6s if moving, or every 25s if stationary.
            long minInterval = isActiveRide ? 2500L : 6000L;
            long heartbeatInterval = isActiveRide ? 8000L : 25000L;
            if (distanceMoved < 2.0f && elapsed < heartbeatInterval) {
                return;
            }
            if (elapsed < minInterval) {
                return;
            }
        }

        if (location.hasBearing()) {
            lastBearing = location.getBearing();
        }

        lastBroadcastLocation = location;
        lastBroadcastTimeMs = now;

        // 1. Notify WebView callback if attached (moves driver UI smoothly when in foreground)
        final Location finalLoc = location;
        final Float finalHeading = lastBearing;
        mainHandler.post(() -> {
            if (activeCallback != null) {
                activeCallback.onLocationUpdated(finalLoc, finalHeading, trackingState, activeRideId);
            }
        });

        // 2. Direct HTTP Post to backend if token is available
        // Foreground/Background Handoff:
        // When in foreground AND activeCallback is attached, the WebView handles location ingestion
        // to avoid duplicate HTTP requests.
        // When backgrounded (minimized, screen off, or driver navigating in Google Maps) OR if
        // the WebView callback is disconnected, DriverLocationService independently posts telemetry
        // directly over HTTPS to /api/rides/driver-location so live tracking never stops.
        if (authToken != null && !authToken.isEmpty()) {
            if (!isAppInForeground || activeCallback == null) {
                transmitLocationToBackend(location, finalHeading, activeRideId);
            }
        }
    }

    private void transmitLocationToBackend(Location location, Float heading, String rideId) {
        if (networkExecutor == null || networkExecutor.isShutdown()) {
            networkExecutor = Executors.newSingleThreadExecutor();
        }
        networkExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                String endpoint = (apiBaseUrl != null ? apiBaseUrl : "https://liphtup.in") + "/api/rides/driver-location";
                URL url = new URL(endpoint);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Authorization", "Bearer " + authToken);
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(6000);
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("lat", location.getLatitude());
                payload.put("lng", location.getLongitude());
                if (rideId != null && !rideId.isEmpty()) {
                    payload.put("rideId", rideId);
                }
                if (location.hasSpeed()) {
                    payload.put("driverSpeed", location.getSpeed());
                }
                if (location.hasAccuracy()) {
                    payload.put("driverAccuracy", location.getAccuracy());
                }
                if (heading != null && !Float.isNaN(heading)) {
                    payload.put("driverHeading", heading.doubleValue());
                }

                byte[] postBytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(postBytes);
                    os.flush();
                }

                int code = conn.getResponseCode();
                Log.d(TAG, "Transmitted location via native background service: status=" + code);
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
                }
            } catch (Exception e) {
                Log.w(TAG, "Native background location transmission failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
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
