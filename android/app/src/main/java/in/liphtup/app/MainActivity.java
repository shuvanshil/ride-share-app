package in.liphtup.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String pendingNotificationUrl = null;
    private String pendingRideId = null;
    private String lastDispatchedUrl = null;
    private long lastDispatchedAt = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
        PushNotificationService.createNotificationChannels(this);
        handleIncomingIntent(getIntent());

        DriverLocationService.setLocationCallback((location, bearing, state, rideId) -> {
            if (getBridge() != null && getBridge().getWebView() != null) {
                try {
                    org.json.JSONObject json = new org.json.JSONObject();
                    json.put("lat", location.getLatitude());
                    json.put("lng", location.getLongitude());
                    json.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : 10.0);
                    json.put("speed", location.hasSpeed() ? location.getSpeed() : 0.0);
                    Float headingToReport = location.hasBearing() ? location.getBearing() : bearing;
                    if (headingToReport != null && !Float.isNaN(headingToReport)) {
                        json.put("heading", headingToReport.doubleValue());
                    } else {
                        json.put("heading", org.json.JSONObject.NULL);
                    }
                    json.put("timestamp", location.getTime());
                    json.put("state", state);
                    json.put("rideId", rideId != null ? rideId : "");
                    final String payloadStr = json.toString();
                    getBridge().getWebView().post(() -> {
                        getBridge().getWebView().evaluateJavascript(
                            "if (window.onNativeLocationUpdate) { window.onNativeLocationUpdate(" + payloadStr + "); }",
                            null
                        );
                    });
                } catch (Exception ignored) {}
            }
        });
        
        // Defensive check: Does the app have the Firebase configuration resource?
        // google-services.json adds a string resource named 'google_app_id'.
        int resourceId = getResources().getIdentifier("google_app_id", "string", getPackageName());
        final boolean firebaseReady = (resourceId != 0);

        // Expose synchronous checks, pending intents, and role management to Javascript.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public boolean isFirebaseReady() {
                return firebaseReady;
            }

            @JavascriptInterface
            public String getGoogleMapsKey() {
                int keyResId = getResources().getIdentifier("google_maps_browser_key", "string", getPackageName());
                if (keyResId != 0) {
                    return getString(keyResId);
                }
                return "";
            }

            @JavascriptInterface
            public void setUserRole(String role) {
                if (role == null) role = "";
                getSharedPreferences("liphtup_prefs", MODE_PRIVATE)
                        .edit()
                        .putString("user_role", role.trim().toLowerCase())
                        .apply();
                android.util.Log.d("MainActivity", "User role set to: " + role);
            }

            @JavascriptInterface
            public String getUserRole() {
                return getSharedPreferences("liphtup_prefs", MODE_PRIVATE)
                        .getString("user_role", "");
            }

            @JavascriptInterface
            public String consumePendingNotificationUrl() {
                String url = pendingNotificationUrl;
                pendingNotificationUrl = null;
                return url != null ? url : "";
            }

            @JavascriptInterface
            public String consumePendingRideId() {
                String rId = pendingRideId;
                pendingRideId = null;
                return rId != null ? rId : "";
            }

            @JavascriptInterface
            public void startDriverTracking(String configJson) {
                try {
                    org.json.JSONObject config = new org.json.JSONObject(configJson != null ? configJson : "{}");
                    Intent serviceIntent = new Intent(MainActivity.this, DriverLocationService.class);
                    serviceIntent.setAction(DriverLocationService.ACTION_START);
                    if (config.has("state")) serviceIntent.putExtra(DriverLocationService.EXTRA_TRACKING_STATE, config.getString("state"));
                    if (config.has("rideId")) serviceIntent.putExtra(DriverLocationService.EXTRA_RIDE_ID, config.getString("rideId"));
                    if (config.has("authToken")) serviceIntent.putExtra(DriverLocationService.EXTRA_AUTH_TOKEN, config.getString("authToken"));
                    if (config.has("refreshToken")) serviceIntent.putExtra(DriverLocationService.EXTRA_REFRESH_TOKEN, config.getString("refreshToken"));
                    if (config.has("apiBaseUrl")) serviceIntent.putExtra(DriverLocationService.EXTRA_API_BASE_URL, config.getString("apiBaseUrl"));
                    androidx.core.content.ContextCompat.startForegroundService(MainActivity.this, serviceIntent);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to start driver tracking service", e);
                }
            }

            @JavascriptInterface
            public void updateTrackingState(String configJson) {
                try {
                    org.json.JSONObject config = new org.json.JSONObject(configJson != null ? configJson : "{}");
                    Intent serviceIntent = new Intent(MainActivity.this, DriverLocationService.class);
                    serviceIntent.setAction(DriverLocationService.ACTION_UPDATE_STATE);
                    if (config.has("state")) serviceIntent.putExtra(DriverLocationService.EXTRA_TRACKING_STATE, config.getString("state"));
                    if (config.has("rideId")) serviceIntent.putExtra(DriverLocationService.EXTRA_RIDE_ID, config.getString("rideId"));
                    if (config.has("authToken")) serviceIntent.putExtra(DriverLocationService.EXTRA_AUTH_TOKEN, config.getString("authToken"));
                    if (config.has("refreshToken")) serviceIntent.putExtra(DriverLocationService.EXTRA_REFRESH_TOKEN, config.getString("refreshToken"));
                    if (config.has("apiBaseUrl")) serviceIntent.putExtra(DriverLocationService.EXTRA_API_BASE_URL, config.getString("apiBaseUrl"));
                    androidx.core.content.ContextCompat.startForegroundService(MainActivity.this, serviceIntent);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to update driver tracking state", e);
                }
            }

            @JavascriptInterface
            public void stopDriverTracking() {
                try {
                    Intent serviceIntent = new Intent(MainActivity.this, DriverLocationService.class);
                    serviceIntent.setAction(DriverLocationService.ACTION_STOP);
                    startService(serviceIntent);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to stop driver tracking service", e);
                }
            }

            @JavascriptInterface
            public boolean isTrackingActive() {
                return DriverLocationService.isRunning();
            }

            @JavascriptInterface
            public void openGoogleMapsNavigation(double lat, double lng, String label) {
                try {
                    Uri navUri = Uri.parse("google.navigation:q=" + lat + "," + lng + "&mode=d");
                    Intent mapIntent = new Intent(Intent.ACTION_VIEW, navUri);
                    mapIntent.setPackage("com.google.android.apps.maps");
                    mapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(mapIntent);
                        return;
                    } catch (Exception e1) {
                        android.util.Log.w("MainActivity", "Direct google.navigation intent failed: " + e1.getMessage());
                    }

                    Uri geoUri = Uri.parse("geo:" + lat + "," + lng + "?q=" + lat + "," + lng + (label != null && !label.isEmpty() ? "(" + Uri.encode(label) + ")" : ""));
                    Intent geoIntent = new Intent(Intent.ACTION_VIEW, geoUri);
                    geoIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(geoIntent);
                        return;
                    } catch (Exception e2) {
                        android.util.Log.w("MainActivity", "Geo intent failed: " + e2.getMessage());
                    }

                    Uri genericUri = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng + "&travelmode=driving");
                    Intent genericIntent = new Intent(Intent.ACTION_VIEW, genericUri);
                    genericIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(genericIntent);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to open Google Maps navigation", e);
                }
            }

            @JavascriptInterface
            public boolean isBatteryOptimizationIgnored() {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                    try {
                        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(android.content.Context.POWER_SERVICE);
                        if (pm != null) {
                            return pm.isIgnoringBatteryOptimizations(getPackageName());
                        }
                    } catch (Exception e) {
                        android.util.Log.w("MainActivity", "Failed to check battery optimization: " + e.getMessage());
                    }
                }
                return true;
            }

            @JavascriptInterface
            public void requestIgnoreBatteryOptimizations() {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                    try {
                        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(android.content.Context.POWER_SERVICE);
                        if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                            intent.setData(Uri.parse("package:" + getPackageName()));
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(intent);
                            return;
                        }
                    } catch (Exception e) {
                        android.util.Log.w("MainActivity", "Direct battery exemption intent failed: " + e.getMessage());
                        try {
                            Intent intent = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(intent);
                        } catch (Exception ex) {
                            android.util.Log.e("MainActivity", "Failed to open battery optimization settings: " + ex.getMessage());
                        }
                    }
                }
            }

            @JavascriptInterface
            public void updateNotificationText(String text) {
                try {
                    DriverLocationService.updateNotificationTextDynamic(text);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to update notification text: " + e.getMessage());
                }
            }

            @JavascriptInterface
            public void updateRideProgress(double remainingKm, int etaMins) {
                try {
                    DriverLocationService.updateRideProgress(remainingKm, etaMins);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Failed to update ride progress: " + e.getMessage());
                }
            }
        }, "LiphtUpNativeStatus");
    }

    @Override
    public void onResume() {
        super.onResume();
        DriverLocationService.setAppInForeground(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        DriverLocationService.setAppInForeground(false);
    }

    @Override
    public void onStop() {
        super.onStop();
        DriverLocationService.setAppInForeground(false);
    }

    @Override
    public void onDestroy() {
        DriverLocationService.setLocationCallback(null);
        DriverLocationService.setAppInForeground(false);
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
        dispatchPendingIntentToWebView();
    }

    private String normalizeNativeUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) return rawUrl;
        String url = rawUrl;
        try {
            Uri parsed = Uri.parse(url);
            if ("https".equalsIgnoreCase(parsed.getScheme()) && ("liphtup.in".equalsIgnoreCase(parsed.getHost()) || "www.liphtup.in".equalsIgnoreCase(parsed.getHost()))) {
                String p = parsed.getPath();
                String q = parsed.getQuery();
                url = (p != null ? p : "/") + (q != null && !q.isEmpty() ? "?" + q : "");
            }
        } catch (Exception ignored) {}

        int queryIndex = url.indexOf('?');
        String path = queryIndex >= 0 ? url.substring(0, queryIndex) : url;
        String query = queryIndex >= 0 ? url.substring(queryIndex) : "";

        if ((path.equals("/driver") || path.equals("driver") || path.equals("/driver.html") || path.equals("driver.html")) && query.contains("rideId=")) {
            path = "/driver-service.html";
        } else if (path.equals("/driver-service") || path.equals("driver-service")) {
            path = "/driver-service.html";
        } else if (!path.endsWith(".html") && !path.startsWith("http://") && !path.startsWith("https://")) {
            if (path.isEmpty() || path.equals("/")) {
                path = "/index.html";
            } else {
                if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
                path = path + ".html";
            }
        }

        return path + query;
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        
        // Handle explicit notification extras
        if (intent.hasExtra("url")) {
            String rawUrl = intent.getStringExtra("url");
            pendingNotificationUrl = normalizeNativeUrl(rawUrl);
        }
        if (intent.hasExtra("rideId")) {
            pendingRideId = intent.getStringExtra("rideId");
        }

        // Handle Deep Links (in.liphtup.app:// or https://liphtup.in/...)
        Uri data = intent.getData();
        if (data != null) {
            String scheme = data.getScheme();
            String host = data.getHost();
            String path = data.getPath();
            String query = data.getQuery();
            
            if ("in.liphtup.app".equalsIgnoreCase(scheme)) {
                String targetPath = (host != null ? host : "") + (path != null ? path : "");
                if (!targetPath.startsWith("/")) {
                    targetPath = "/" + targetPath;
                }
                if (query != null && !query.isEmpty()) {
                    targetPath += "?" + query;
                }
                pendingNotificationUrl = normalizeNativeUrl(targetPath);
            } else if ("https".equalsIgnoreCase(scheme) && ("liphtup.in".equalsIgnoreCase(host) || "www.liphtup.in".equalsIgnoreCase(host))) {
                String targetPath = path != null ? path : "/";
                if (query != null && !query.isEmpty()) {
                    targetPath += "?" + query;
                }
                pendingNotificationUrl = normalizeNativeUrl(targetPath);
            }
        }
    }

    private void dispatchPendingIntentToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(new Runnable() {
                @Override
                public void run() {
                    String target = null;
                    if (pendingNotificationUrl != null && !pendingNotificationUrl.isEmpty()) {
                        target = normalizeNativeUrl(pendingNotificationUrl);
                        pendingNotificationUrl = null;
                    } else if (pendingRideId != null && !pendingRideId.isEmpty()) {
                        String rId = pendingRideId;
                        pendingRideId = null;
                        target = "/driver-service.html?rideId=" + rId.replace("'", "\\'") + "&from=push";
                    }
                    if (target != null && !target.isEmpty()) {
                        long now = System.currentTimeMillis();
                        if (target.equals(lastDispatchedUrl) && (now - lastDispatchedAt) < 2000) {
                            return;
                        }
                        lastDispatchedUrl = target;
                        lastDispatchedAt = now;
                        getBridge().getWebView().evaluateJavascript(
                            "(function(){ var url = '" + target.replace("'", "\\'") + "'; if (window.navigateToPage) { window.navigateToPage(url); } else if (window.location.pathname + window.location.search !== url) { window.location.href = url; } })();", null
                        );
                    }
                }
            });
        }
    }
}
