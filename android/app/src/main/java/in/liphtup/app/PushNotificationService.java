package in.liphtup.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class PushNotificationService extends FirebaseMessagingService {
    private static final String TAG = "PushNotificationService";
    private static final String CHANNEL_RIDE_REQUESTS = "ride_requests";
    private static final String CHANNEL_WALLET = "liphtup_wallet_channel";
    private static final String CHANNEL_DRIVER = "liphtup_driver_channel";
    private static final String CHANNEL_DEFAULT = "default";

    private static final java.util.Map<String, Long> RECENT_PROCESSED_MESSAGES = new java.util.concurrent.ConcurrentHashMap<>();
    private static final long DEDUP_WINDOW_MS = 5000;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Log.d(TAG, "Push message received from: " + remoteMessage.getFrom());

        // Deduplication guard against repeated triggers and FCM retries
        Map<String, String> dataMap = remoteMessage.getData();
        String dedupKey = null;
        if (dataMap != null && dataMap.containsKey("eventId")) {
            dedupKey = dataMap.get("eventId");
        } else if (remoteMessage.getMessageId() != null) {
            dedupKey = remoteMessage.getMessageId();
        } else if (dataMap != null && dataMap.containsKey("tag")) {
            dedupKey = dataMap.get("tag");
        }

        long now = System.currentTimeMillis();
        if (dedupKey != null && !dedupKey.isEmpty()) {
            Long lastSeen = RECENT_PROCESSED_MESSAGES.get(dedupKey);
            if (lastSeen != null && (now - lastSeen) < DEDUP_WINDOW_MS) {
                Log.d(TAG, "Suppressed duplicate push message in service: " + dedupKey);
                return;
            }
            RECENT_PROCESSED_MESSAGES.put(dedupKey, now);

            if (RECENT_PROCESSED_MESSAGES.size() > 100) {
                for (Map.Entry<String, Long> entry : RECENT_PROCESSED_MESSAGES.entrySet()) {
                    if (now - entry.getValue() > DEDUP_WINDOW_MS * 2) {
                        RECENT_PROCESSED_MESSAGES.remove(entry.getKey());
                    }
                }
            }
        }

        // 1. Forward message to Capacitor PushNotificationsPlugin so JS listeners get pushNotificationReceived
        try {
            PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
        } catch (Throwable t) {
            Log.w(TAG, "Could not forward remote message to Capacitor plugin", t);
        }

        String msgType = dataMap != null ? dataMap.get("type") : null;
        String rideId = dataMap != null ? dataMap.get("rideId") : null;

        // If this is a ride cancellation event, cancel existing notifications for this ride immediately
        if ("ride_cancelled".equalsIgnoreCase(msgType) || "RIDE_CANCELLED".equalsIgnoreCase(msgType)) {
            cancelRideNotification(rideId, dataMap != null ? dataMap.get("tag") : null);
            return;
        }

        // 2. Role-based filtering: Suppress any driver ride request notifications unless active user is logged in as a driver
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

        if (isRideRequestPush && isPassengerLoggedIn() && !isDriverLoggedIn()) {
            Log.d(TAG, "Suppressing driver ride request notification: Active user is logged in as a passenger. Current role: "
                    + getSharedPreferences("liphtup_prefs", MODE_PRIVATE).getString("user_role", "none"));
            return;
        }

        String title = null;
        String body = null;
        String url = rawUrl;
        if (url != null) {
            try {
                Uri parsed = Uri.parse(url);
                if ("https".equalsIgnoreCase(parsed.getScheme()) && ("liphtup.in".equalsIgnoreCase(parsed.getHost()) || "www.liphtup.in".equalsIgnoreCase(parsed.getHost()))) {
                    String p = parsed.getPath();
                    String q = parsed.getQuery();
                    url = (p != null ? p : "/") + (q != null && !q.isEmpty() ? "?" + q : "");
                }
            } catch (Exception ignored) {}
        }

        if (dataMap != null && !dataMap.isEmpty()) {
            Log.d(TAG, "Message data payload: " + dataMap);
            if ("NEW_PASSENGER_AVAILABLE".equals(msgType)) {
                if (rideId == null) rideId = dataMap.get("rideId");
                String passengerName = dataMap.get("passengerName");
                String pickupLocation = dataMap.get("pickupLocation");
                String estimatedEarning = dataMap.get("estimatedEarning");

                title = "New Ride Request on LiphtUP";
                StringBuilder bodyBuilder = new StringBuilder();
                if (passengerName != null) bodyBuilder.append("Passenger: ").append(passengerName).append("\n");
                if (pickupLocation != null) bodyBuilder.append("Pickup: ").append(pickupLocation).append("\n");
                if (estimatedEarning != null) bodyBuilder.append("Fare: ₹").append(estimatedEarning);
                body = bodyBuilder.toString();
            } else {
                title = dataMap.get("title");
                body = dataMap.get("body");
                if (rideId == null) rideId = dataMap.get("rideId");
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

        if (title == null || title.isEmpty()) {
            title = "LiphtUp Alert";
        }
        if (body == null || body.isEmpty()) {
            body = "You have a new update in LiphtUp.";
        }

        String channelId = dataMap != null ? dataMap.get("channel_id") : null;
        if (channelId == null || channelId.isEmpty()) {
            if (remoteNotif != null) {
                channelId = remoteNotif.getChannelId();
            }
        }
        if (channelId == null || channelId.isEmpty()) {
            channelId = CHANNEL_RIDE_REQUESTS;
        }

        String tag = dataMap != null ? dataMap.get("tag") : null;
        if (tag == null || tag.isEmpty()) {
            if (rideId != null && !rideId.isEmpty()) {
                tag = "liphtup-ride-" + rideId;
            } else {
                tag = "liphtup-general";
            }
        }

        String messageId = remoteMessage.getMessageId();
        showNotification(title, body, rideId, url, channelId, tag, messageId, dataMap);
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

    private void cancelRideNotification(String rideId, String customTag) {
        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(this);
        if (customTag != null && !customTag.isEmpty()) {
            notificationManager.cancel(customTag, Math.abs(customTag.hashCode()));
        }
        if (rideId != null && !rideId.isEmpty()) {
            String rideTag = "liphtup-ride-" + rideId;
            notificationManager.cancel(rideTag, Math.abs(rideTag.hashCode()));
        }
        Log.d(TAG, "Cancelled notification for ride: " + rideId);
    }

    private void showNotification(
            String title,
            String body,
            String rideId,
            String url,
            String channelId,
            String tag,
            String messageId,
            Map<String, String> dataMap
    ) {
        createNotificationChannels(this);

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (rideId != null && !rideId.isEmpty()) {
            intent.putExtra("rideId", rideId);
        }
        if (url != null && !url.isEmpty()) {
            intent.putExtra("url", url);
        } else if (rideId != null && !rideId.isEmpty()) {
            intent.putExtra("url", "/driver-service.html?rideId=" + rideId + "&from=push");
        }

        // Copy all data extras so MainActivity and Capacitor get full context
        if (dataMap != null) {
            for (Map.Entry<String, String> entry : dataMap.entrySet()) {
                intent.putExtra(entry.getKey(), entry.getValue());
            }
        }

        // Add google.message_id so Capacitor PushNotificationsPlugin handles the tap action
        intent.putExtra("google.message_id", messageId != null ? messageId : String.valueOf(System.currentTimeMillis()));

        // Deterministic notification ID based on tag to replace existing notifications and avoid duplicate cards
        int notificationId = Math.abs(tag.hashCode());

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                notificationId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        long[] vibrationPattern = new long[]{0, 500, 250, 500, 250, 500};

        NotificationCompat.Builder notificationBuilder =
                new NotificationCompat.Builder(this, channelId)
                        .setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(title)
                        .setContentText(body)
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_MAX)
                        .setCategory(NotificationCompat.CATEGORY_CALL)
                        .setSound(soundUri)
                        .setVibrate(vibrationPattern)
                        .setDefaults(Notification.DEFAULT_ALL)
                        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                        .setContentIntent(pendingIntent);

        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(this);

        try {
            notificationManager.notify(tag, notificationId, notificationBuilder.build());
            Log.d(TAG, "Posted notification [tag=" + tag + ", id=" + notificationId + ", channel=" + channelId + "]");
        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException: No permission to post notifications", e);
        }
    }

    public static void createNotificationChannels(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && context != null) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;

            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build();
            long[] vibrationPattern = new long[]{0, 500, 250, 500, 250, 500};

            // 1. Ride requests channel
            if (manager.getNotificationChannel(CHANNEL_RIDE_REQUESTS) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_RIDE_REQUESTS,
                        "Ride Requests & Alerts",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Critical notifications for incoming rides and status updates");
                channel.enableLights(true);
                channel.enableVibration(true);
                channel.setVibrationPattern(vibrationPattern);
                channel.setSound(soundUri, audioAttributes);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }

            // 2. Wallet channel
            if (manager.getNotificationChannel(CHANNEL_WALLET) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_WALLET,
                        "Wallet & Payments",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Platform fee dues, payment verification, and wallet credits");
                channel.enableLights(true);
                channel.enableVibration(true);
                channel.setVibrationPattern(vibrationPattern);
                channel.setSound(soundUri, audioAttributes);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }

            // 3. Driver channel
            if (manager.getNotificationChannel(CHANNEL_DRIVER) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_DRIVER,
                        "Driver Updates",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Driver onboarding, document approval, and operational updates");
                channel.enableLights(true);
                channel.enableVibration(true);
                channel.setVibrationPattern(vibrationPattern);
                channel.setSound(soundUri, audioAttributes);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }

            // 4. Default channel
            if (manager.getNotificationChannel(CHANNEL_DEFAULT) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_DEFAULT,
                        "LiphtUp Notifications",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("General system notices and passenger booking alerts");
                channel.enableLights(true);
                channel.enableVibration(true);
                channel.setVibrationPattern(vibrationPattern);
                channel.setSound(soundUri, audioAttributes);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.d(TAG, "Refreshed token: " + token);
        try {
            PushNotificationsPlugin.onNewToken(token);
        } catch (Throwable t) {
            Log.w(TAG, "Could not forward refreshed token to Capacitor plugin", t);
        }
    }
}
