package in.liphtup.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String pendingNotificationUrl = null;
    private String pendingRideId = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
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

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        
        // Handle explicit notification extras
        if (intent.hasExtra("url")) {
            pendingNotificationUrl = intent.getStringExtra("url");
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
                pendingNotificationUrl = targetPath;
            } else if ("https".equalsIgnoreCase(scheme) && ("liphtup.in".equalsIgnoreCase(host) || "www.liphtup.in".equalsIgnoreCase(host))) {
                String targetPath = path != null ? path : "/";
                if (query != null && !query.isEmpty()) {
                    targetPath += "?" + query;
                }
                pendingNotificationUrl = targetPath;
            }
        }
    }

    private void dispatchPendingIntentToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(new Runnable() {
                @Override
                public void run() {
                    if (pendingNotificationUrl != null && !pendingNotificationUrl.isEmpty()) {
                        String target = pendingNotificationUrl;
                        pendingNotificationUrl = null;
                        getBridge().getWebView().evaluateJavascript(
                            "(function(){ if (window.navigateToPage) { window.navigateToPage('" + target.replace("'", "\\'") + "'); } else { window.location.href = '" + target.replace("'", "\\'") + "'; } })();", null
                        );
                    } else if (pendingRideId != null && !pendingRideId.isEmpty()) {
                        String rId = pendingRideId;
                        pendingRideId = null;
                        getBridge().getWebView().evaluateJavascript(
                            "(function(){ window.location.href = '/driver.html?rideId=" + rId.replace("'", "\\'") + "&from=push'; })();", null
                        );
                    }
                }
            });
        }
    }
}
