# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep JavaScript interface methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep the Application classes, MainActivity, and native bridge
-keep class in.liphtup.app.** { *; }
-keep class com.getcapacitor.** { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep public class * extends com.getcapacitor.BridgeActivity { *; }
-keep public class * extends com.getcapacitor.BridgeFragment { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public *;
}

# Keep all Capacitor official and community plugin classes
-keep class com.capacitorjs.plugins.** { *; }
-keep class com.getcapacitor.community.** { *; }

# Keep Firebase classes
-keep class com.google.firebase.** { *; }

# Prevent shrinking of the native bridge objects and annotations
-keepattributes JavascriptInterface
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# Preserve line numbers for stack traces
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
