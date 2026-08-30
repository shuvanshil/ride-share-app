package in.liphtup.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class PushNotificationService extends FirebaseMessagingService {
    private static final String TAG = "PushNotificationService";
    private static final String CHANNEL_ID = "ride_requests";
    private static final String CHANNEL_NAME = "Ride Requests";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Log.d(TAG, "From: " + remoteMessage.getFrom());

        // Role-based filtering: Suppress any driver ride request notifications unless active user is logged in as a driver
        Map<String, String> dataMap = remoteMessage.getData();
        String msgType = dataMap != null ? dataMap.get("type") : null;
        String rawUrl = dataMap != null ? dataMap.get("url") : null;
        String rawTitle = dataMap != null ? dataMap.get("title") : null;

        RemoteMessage.Notification remoteNotif = remoteMessage.getNotification();
        if (remoteNotif != null && (rawTitle == null || rawTitle.isEmpty())) {
            rawTitle = remoteNotif.getTitle();
        }

        boolean isRideRequestPush = "ride_request".equalsIgnoreCase(msgType)
                || "NEW_PASSENGER_AVAILABLE".equalsIgnoreCase(msgType)
                || "ride_dispatch".equalsIgnoreCase(msgType)
                || "pending_driver_available".equalsIgnoreCase(msgType)
                || (rawUrl != null && rawUrl.contains("/driver"))
                || (rawTitle != null && (rawTitle.toLowerCase().contains("ride request") || rawTitle.toLowerCase().contains("new passenger")));

        if (isRideRequestPush && !isDriverLoggedIn()) {
            Log.d(TAG, "Suppressing driver ride request notification: Active user is not logged in as a driver. Current role: "
                    + getSharedPreferences("liphtup_prefs", MODE_PRIVATE).getString("user_role", "none"));
            return;
        }

        String title = null;
        String body = null;
        String rideId = null;
        String url = rawUrl;

        if (dataMap != null && !dataMap.isEmpty()) {
            Log.d(TAG, "Message data payload: " + dataMap);
            if ("NEW_PASSENGER_AVAILABLE".equals(msgType)) {
                rideId = dataMap.get("rideId");
                String passengerName = dataMap.get("passengerName");
                String pickupLocation = dataMap.get("pickupLocation");
                String estimatedEarning = dataMap.get("estimatedEarning");

                title = "New Ride Request!";
                StringBuilder bodyBuilder = new StringBuilder();
                if (passengerName != null) bodyBuilder.append("Passenger: ").append(passengerName).append("\n");
                if (pickupLocation != null) bodyBuilder.append("Pickup: ").append(pickupLocation).append("\n");
                if (estimatedEarning != null) bodyBuilder.append("Fare: ₹").append(estimatedEarning);
                body = bodyBuilder.toString();
            } else {
                title = dataMap.get("title");
                body = dataMap.get("body");
                rideId = dataMap.get("rideId");
            }
        }

        if (remoteNotif != null) {
            Log.d(TAG, "Message Notification Body: " + remoteNotif.getBody());
            if (title == null || title.isEmpty()) {
                title = remoteNotif.getTitle();
            }
            if (body == null || body.isEmpty()) {
                body = remoteNotif.getBody();
            }
        }

        if (title != null && body != null) {
            showNotification(title, body, rideId, url);
        }
    }

    private boolean isDriverLoggedIn() {
        android.content.SharedPreferences prefs = getSharedPreferences("liphtup_prefs", MODE_PRIVATE);
        String role = prefs.getString("user_role", "");
        return "driver".equalsIgnoreCase(role.trim());
    }

    private boolean isPassengerLoggedIn() {
        android.content.SharedPreferences prefs = getSharedPreferences("liphtup_prefs", MODE_PRIVATE);
        String role = prefs.getString("user_role", "");
        return "passenger".equalsIgnoreCase(role.trim());
    }

    private void showNotification(String title, String body, String rideId, String url) {
        createNotificationChannel();

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (rideId != null && !rideId.isEmpty()) {
            intent.putExtra("rideId", rideId);
        }
        if (url != null && !url.isEmpty()) {
            intent.putExtra("url", url);
        }
        
        // requestCode should be unique if multiple notifications are shown
        int requestCode = (int) System.currentTimeMillis();
        
        PendingIntent pendingIntent = PendingIntent.getActivity(this, requestCode, intent,
                PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder notificationBuilder =
                new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(title)
                        .setContentText(body)
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setCategory(NotificationCompat.CATEGORY_CALL)
                        .setDefaults(Notification.DEFAULT_ALL)
                        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                        .setContentIntent(pendingIntent);

        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(this);
        
        try {
            notificationManager.notify(requestCode, notificationBuilder.build());
        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException: No permission to post notifications", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                // Check if channel already exists
                NotificationChannel existingChannel = manager.getNotificationChannel(CHANNEL_ID);
                if (existingChannel == null) {
                    NotificationChannel channel = new NotificationChannel(
                            CHANNEL_ID,
                            CHANNEL_NAME,
                            NotificationManager.IMPORTANCE_HIGH
                    );
                    channel.setDescription("Notifications for new ride requests");
                    channel.enableLights(true);
                    channel.enableVibration(true);
                    channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                    manager.createNotificationChannel(channel);
                }
            }
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.d(TAG, "Refreshed token: " + token);
    }
}
