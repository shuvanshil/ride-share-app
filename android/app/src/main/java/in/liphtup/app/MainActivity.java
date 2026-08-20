package in.liphtup.app;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Defensive check: Does the app have the Firebase configuration resource?
        // google-services.json adds a string resource named 'google_app_id'.
        int resourceId = getResources().getIdentifier("google_app_id", "string", getPackageName());
        final boolean firebaseReady = (resourceId != 0);

        // Expose synchronous checks and role management to Javascript that survives page navigation.
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
        }, "LiphtUpNativeStatus");
    }
}
