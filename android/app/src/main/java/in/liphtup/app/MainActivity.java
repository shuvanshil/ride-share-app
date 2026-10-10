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
        handleIncomingIntent(getIntent());
        
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
        }, "LiphtUpNativeStatus");
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
