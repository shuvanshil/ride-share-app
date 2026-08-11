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

        // Expose a synchronous check to Javascript that survives page navigation.
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public boolean isFirebaseReady() {
                return firebaseReady;
            }
        }, "LiphtUpNativeStatus");
    }
}
