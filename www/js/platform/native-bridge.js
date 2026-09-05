// native-bridge.js
// Runs ONLY inside the Capacitor Android app (no-op on the regular website/PWA).
// Patches window.fetch to redirect relative API calls to the production server.
(function () {
    'use strict';

    if (window.LIPHTUP_NATIVE_BRIDGE_INITIALIZED) return;
    window.LIPHTUP_NATIVE_BRIDGE_INITIALIZED = true;

    // Default to false. Injected interface or evaluateJavascript will override.
    window.LIPHTUP_NATIVE_FIREBASE_READY = window.LIPHTUP_NATIVE_FIREBASE_READY || false;

    var Cap = window.Capacitor;
    // Robust detection for Capacitor environment
    var isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform())
        || window.location.hostname === 'localhost'
        || window.location.hostname === '127.0.0.1'
        || window.location.protocol === 'capacitor:'
        || navigator.userAgent.includes('Capacitor');

    window.LIPHTUP_IS_NATIVE = isNative;

    /**
     * Robust check for current page name, handling Capacitor's various path formats.
     */
    window.isCurrentPage = function(pageName) {
        var path = window.location.pathname.toLowerCase();
        var search = pageName.toLowerCase();
        // Handle exact matches, matches with extensions, and Capacitor root-less paths
        return path.endsWith('/' + search) ||
               path.endsWith('/' + search + '.html') ||
               path === search ||
               path === '/' + search;
    };

    if (!isNative) {
        console.log('[native-bridge] standard web environment.');
        return;
    }

    console.log('[native-bridge] native environment detected.');

    // Production API origin.
    var API_BASE = 'https://liphtup.in';

    // --- Fetch Patch ----------------------------------------------------------
    // Redirects all /api/... calls to the production server.
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            var url = typeof input === 'string' ? input : (input && input.url);
            var origin = window.location.origin;

            // Detect paths like "/api/..."
            if (typeof url === 'string' && url.charAt(0) === '/' && !url.startsWith('//')) {
                if (url.startsWith('/api/')) {
                    var targetUrl = API_BASE + url;
                    console.log('[native-bridge] redirecting API:', url, '->', targetUrl);
                    if (typeof input === 'string') {
                        return originalFetch(targetUrl, init);
                    } else {
                        return originalFetch(new Request(targetUrl, input), init);
                    }
                }
            }

            // Detect absolute paths to local origin that start with /api/
            if (typeof url === 'string' && url.startsWith(origin + '/api/')) {
                var path = url.substring(origin.length);
                var targetUrl = API_BASE + path;
                console.log('[native-bridge] redirecting absolute local API:', path, '->', targetUrl);
                if (typeof input === 'string') {
                    return originalFetch(targetUrl, init);
                } else {
                    return originalFetch(new Request(targetUrl, input), init);
                }
            }
        } catch (patchError) {
            console.error('[native-bridge] fetch patch error:', patchError);
        }
        return originalFetch(input, init);
    };

    document.addEventListener('DOMContentLoaded', function () {
        var Plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
        var Push = Plugins.PushNotifications;
        var AppPlugin = Plugins.App;
        var StatusBarPlugin = Plugins.StatusBar;
        var SplashPlugin = Plugins.SplashScreen;

        // --- Status Bar Configuration --------------------------------------------
        if (StatusBarPlugin) {
            try {
                if (typeof StatusBarPlugin.setBackgroundColor === 'function') {
                    StatusBarPlugin.setBackgroundColor({ color: '#1A7A2E' }).catch(function () {});
                }
                if (typeof StatusBarPlugin.setStyle === 'function') {
                    StatusBarPlugin.setStyle({ style: 'DARK' }).catch(function () {});
                }
                if (typeof StatusBarPlugin.setOverlaysWebView === 'function') {
                    StatusBarPlugin.setOverlaysWebView({ overlay: false }).catch(function () {});
                }
            } catch (sbErr) {
                console.warn('[native-bridge] StatusBar init warning:', sbErr);
            }
        }

        // --- Splash Screen Auto-Hide ---------------------------------------------
        if (SplashPlugin && typeof SplashPlugin.hide === 'function') {
            try {
                SplashPlugin.hide({ fadeOutDuration: 300 }).catch(function () {});
            } catch (spErr) {
                console.warn('[native-bridge] SplashScreen.hide warning:', spErr);
            }
        }

        // --- Hardware Back Button Handler ----------------------------------------
        if (AppPlugin && typeof AppPlugin.addListener === 'function') {
            AppPlugin.addListener('backButton', function (status) {
                console.log('[native-bridge] Hardware back button pressed, canGoBack:', status && status.canGoBack);

                // 1. Check for closable visible modals / dialogs / drawers
                var openModals = document.querySelectorAll('.modal.show, .modal-layer:not(.d-none), .py-modal-overlay:not(.d-none):not(.non-closable), .custom-flow-modal:not(.d-none), .history-detail-modal:not(.d-none), .driver-status-modal-overlay.closable:not(.d-none)');
                if (openModals && openModals.length > 0) {
                    var topModal = openModals[openModals.length - 1];
                    var closeBtn = topModal.querySelector('.btn-close, .modal-close-btn, .py-modal-close, #qr-modal-close-btn, #py-modal-close-btn, [data-bs-dismiss="modal"], .js-close-modal');
                    if (closeBtn) {
                        closeBtn.click();
                        return;
                    }
                    topModal.classList.add('d-none');
                    return;
                }

                // 2. Check if currently on a subpage that should navigate back
                var isRootPage = window.isCurrentPage('index.html') ||
                                 window.isCurrentPage('driver.html') ||
                                 window.isCurrentPage('') ||
                                 window.location.pathname === '/' ||
                                 window.location.pathname.endsWith('/index.html');

                if (!isRootPage) {
                    if (window.history.length > 1) {
                        window.history.back();
                    } else {
                        var role = (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.getUserRole === 'function')
                            ? window.LiphtUpNativeStatus.getUserRole()
                            : '';
                        var fallbackHome = (role === 'driver') ? '/driver.html' : '/index.html';
                        window.location.href = fallbackHome;
                    }
                    return;
                }

                // 3. On root page: exit app gracefully
                if (typeof AppPlugin.exitApp === 'function') {
                    AppPlugin.exitApp();
                }
            });
        }

        // --- Pending Notification / Deep Link Dispatch --------------------------
        if (window.LiphtUpNativeStatus) {
            try {
                if (typeof window.LiphtUpNativeStatus.consumePendingNotificationUrl === 'function') {
                    var pendingUrl = window.LiphtUpNativeStatus.consumePendingNotificationUrl();
                    if (pendingUrl && pendingUrl.length > 0) {
                        console.log('[native-bridge] consuming pending notification url:', pendingUrl);
                        if (window.navigateToPage) {
                            window.navigateToPage(pendingUrl);
                        } else {
                            window.location.href = pendingUrl;
                        }
                    }
                }
                if (typeof window.LiphtUpNativeStatus.consumePendingRideId === 'function') {
                    var pendingRide = window.LiphtUpNativeStatus.consumePendingRideId();
                    if (pendingRide && pendingRide.length > 0) {
                        console.log('[native-bridge] consuming pending ride id:', pendingRide);
                        window.location.href = '/driver.html?rideId=' + encodeURIComponent(pendingRide) + '&from=push';
                    }
                }
            } catch (e) {
                console.warn('[native-bridge] pending url error:', e);
            }
        }

        // Auto-detect driver vs passenger pages and sync native role
        if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.setUserRole === 'function') {
            if (window.isCurrentPage && (window.isCurrentPage('driver.html') || window.isCurrentPage('driver-service.html') || window.isCurrentPage('driver-dashboard.html') || window.isCurrentPage('driver-payments.html'))) {
                window.LiphtUpNativeStatus.setUserRole('driver');
                console.log('[native-bridge] auto-set native user_role to driver');
            } else if (window.isCurrentPage && (window.isCurrentPage('index.html') || window.isCurrentPage('services.html') || window.isCurrentPage('history.html') || window.isCurrentPage('profile.html') || window.isCurrentPage('login.html'))) {
                window.LiphtUpNativeStatus.setUserRole('passenger');
                console.log('[native-bridge] auto-set native user_role to passenger');
            }
        }

        // --- Push Notification Handlers (Global) ---------------------------------
        if (Push) {
            Push.addListener('pushNotificationReceived', function (notification) {
                console.log('[native-bridge] push received:', notification);
            });

            Push.addListener('pushNotificationActionPerformed', function (notification) {
                console.log('[native-bridge] push action:', notification);
                var data = (notification && notification.notification && notification.notification.data) || {};
                if (data.url) {
                    if (window.navigateToPage) {
                        window.navigateToPage(data.url);
                    } else {
                        window.location.href = data.url;
                    }
                } else if (data.rideId) {
                    window.location.href = '/driver.html?rideId=' + encodeURIComponent(data.rideId) + '&from=push';
                }
            });
        }

        // --- Native Bridge for App Logic (Push Registration & Role Sync) ---------
        window.LiphtUpNative = {
            setUserRole: function (role) {
                if (window.LiphtUpNativeStatus && typeof window.LiphtUpNativeStatus.setUserRole === 'function') {
                    window.LiphtUpNativeStatus.setUserRole(role);
                }
            },
            registerPushNotifications: function () {
                if (!Push) return Promise.reject(new Error("push-unsupported"));

                return Push.checkPermissions().then(function (perm) {
                    if (perm.receive !== 'granted') {
                        return Push.requestPermissions();
                    }
                    return perm;
                }).then(function (perm) {
                    if (perm.receive !== 'granted') {
                        throw new Error("permission-denied");
                    }

                    return new Promise(function (resolve, reject) {
                        Push.removeAllListeners();

                        Push.addListener('pushNotificationReceived', function (notification) {
                            console.log('[native-bridge] push received:', notification);
                        });
                        Push.addListener('pushNotificationActionPerformed', function (notification) {
                            console.log('[native-bridge] push action:', notification);
                            var data = (notification && notification.notification && notification.notification.data) || {};
                            if (data.url) {
                                if (window.navigateToPage) {
                                    window.navigateToPage(data.url);
                                } else {
                                    window.location.href = data.url;
                                }
                            } else if (data.rideId) {
                                window.location.href = '/driver.html?rideId=' + encodeURIComponent(data.rideId) + '&from=push';
                            }
                        });

                        Push.addListener('registration', function (token) {
                            console.log('[native-bridge] push registered:', token.value);
                            resolve(token.value);
                        });

                        Push.addListener('registrationError', function (error) {
                            console.error('[native-bridge] push error:', error.error);
                            reject(new Error(error.error));
                        });

                        console.log('[native-bridge] attempting native push registration...');
                        try {
                            Push.register();
                        } catch (e) {
                            console.error('[native-bridge] push.register exception:', e);
                            reject(e);
                        }
                    });
                });
            }
        };

        // --- Push Notification Channels (Android 8.0+) ---------------------------
        if (Plugins.PushNotifications && Plugins.PushNotifications.createChannel) {
            var channels = [
                { id: 'ride_requests', name: 'Ride Requests & Alerts', importance: 5 },
                { id: 'liphtup_wallet_channel', name: 'Wallet & Credits', importance: 5 },
                { id: 'liphtup_driver_channel', name: 'Driver Updates', importance: 5 },
                { id: 'default', name: 'LiphtUp Notifications', importance: 5 }
            ];
            channels.forEach(function(ch) {
                Plugins.PushNotifications.createChannel({
                    id: ch.id,
                    name: ch.name,
                    description: ch.name,
                    importance: ch.importance,
                    visibility: 1,
                    sound: 'default',
                    vibration: true,
                    lights: true
                }).catch(function () {});
            });
        }
    });

    // --- Extension Interceptor ------------------------------------------------
    // Ensures internal links without .html still work (e.g. <a href="/login">)
    document.addEventListener('click', function (event) {
        var anchor = event.target.closest('a');
        if (anchor && anchor.href) {
            try {
                var url = new URL(anchor.href);
                if (url.origin === window.location.origin) {
                    var path = url.pathname;
                    if (path.length > 1 && !path.includes('.') && !path.endsWith('.html')) {
                        event.preventDefault();
                        window.location.href = path + '.html' + url.search + url.hash;
                    }
                }
            } catch (e) {}
        }
    }, true);

    // Diagnostic logging for Logcat
    window.addEventListener('error', function (event) {
        console.error('[native-bridge] JS Error:', event.message, 'at', event.filename, ':', event.lineno);
    });
    window.addEventListener('unhandledrejection', function (event) {
        console.error('[native-bridge] Promise Rejection:', event.reason);
    });
})();
