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

        // Role-based filtering: Suppress ride request notifications ONLY if the current user is logged in as a passenger
        if (isPassengerLoggedIn()) {
            Log.d(TAG, "Suppressing push notification: Active user is logged in as a passenger.");
            return;
        }

        // Check if message contains a data payload.
        if (!remoteMessage.getData().isEmpty()) {
            Log.d(TAG, "Message data payload: " + remoteMessage.getData());
            handleDataMessage(remoteMessage.getData());
        }

        // Check if message contains a notification payload.
        if (remoteMessage.getNotification() != null) {
            Log.d(TAG, "Message Notification Body: " + remoteMessage.getNotification().getBody());
            showNotification(remoteMessage.getNotification().getTitle(), remoteMessage.getNotification().getBody(), null);
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

    private void handleDataMessage(Map<String, String> data) {
        String type = data.get("type");
        if ("NEW_PASSENGER_AVAILABLE".equals(type)) {
            String rideId = data.get("rideId");
            String passengerName = data.get("passengerName");
            String pickupLocation = data.get("pickupLocation");
            String estimatedEarning = data.get("estimatedEarning");

            String title = "New Ride Request!";
            StringBuilder body = new StringBuilder();
            if (passengerName != null) body.append("Passenger: ").append(passengerName).append("\n");
            if (pickupLocation != null) body.append("Pickup: ").append(pickupLocation).append("\n");
            if (estimatedEarning != null) body.append("Fare: ₹").append(estimatedEarning);

            showNotification(title, body.toString(), rideId);
        } else {
            // Generic fallback for other data messages
            String title = data.get("title");
            String body = data.get("body");
            if (title != null && body != null) {
                showNotification(title, body, data.get("rideId"));
            }
        }
    }

    private void showNotification(String title, String body, String rideId) {
        createNotificationChannel();

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (rideId != null) {
            intent.putExtra("rideId", rideId);
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
