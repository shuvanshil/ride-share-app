/**
 * Platform adapter for URL handling and routing.
 * Standardizes clean URLs on web while maintaining .html compatibility for native.
 */

(function () {
    'use strict';

    const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

    /**
     * On Web only: Rewrites all same-origin anchor hrefs to strip .html before first paint.
     */
    function rewriteLinksForWeb() {
        if (isNative) return;

        const rewrite = () => {
            const anchors = document.querySelectorAll('a[href$=".html"]');
            anchors.forEach(a => {
                try {
                    const url = new URL(a.href, window.location.origin);
                    if (url.origin === window.location.origin) {
                        // Strip .html and update the href
                        a.href = a.href.replace(/\.html(\?|#|$)/, '$1');
                    }
                } catch (e) {}
            });
        };

        // Run immediately if DOM is ready, otherwise wait.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', rewrite);
        } else {
            rewrite();
        }

        // Also observe for dynamic changes (modals, AJAX content)
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element
                        if (node.tagName === 'A' && node.href.endsWith('.html')) {
                            node.href = node.href.replace(/\.html(\?|#|$)/, '$1');
                        }
                        node.querySelectorAll('a[href$=".html"]').forEach(a => {
                            a.href = a.href.replace(/\.html(\?|#|$)/, '$1');
                        });
                    }
                });
            });
        });

        const startObserving = () => {
            if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true });
            } else {
                // If body isn't ready, wait for DOMContentLoaded to be 100% safe.
                window.addEventListener('DOMContentLoaded', () => {
                    if (document.body) {
                        observer.observe(document.body, { childList: true, subtree: true });
                    }
                }, { once: true });
            }
        };

        startObserving();
    }

    /**
     * Helper to get the correct URL for a page name.
     */
    window.getPlatformUrl = function (pageName) {
        if (!pageName || typeof pageName !== 'string') return pageName;

        // If external URL pointing to liphtup.in, convert to relative local path
        try {
            if (/^https?:\/\/(www\.)?liphtup\.in/i.test(pageName)) {
                const parsed = new URL(pageName);
                pageName = parsed.pathname + parsed.search + parsed.hash;
            }
        } catch (e) {}

        // Separate path from query/hash
        const match = pageName.match(/^([^?#]*)(.*)$/);
        let path = match ? match[1] : pageName;
        const rest = match ? match[2] : '';

        // Route incoming driver ride notifications with rideId to driver-service (Services page)
        if ((path === '/driver' || path === 'driver' || path === '/driver.html' || path === 'driver.html') && rest.includes('rideId=')) {
            path = path.startsWith('/') ? '/driver-service' : 'driver-service';
        }

        if (isNative) {
            if (!path.endsWith('.html') && !/^https?:\/\//i.test(path)) {
                if (path !== '/' && path.endsWith('/')) {
                    path = path.slice(0, -1);
                }
                if (path === '' || path === '/') {
                    path = '/index.html';
                } else {
                    path = `${path}.html`;
                }
            }
            return path + rest;
        }

        path = path.replace(/\.html$/, '');
        return path + rest;
    };

    /**
     * Navigates to a page using the platform-appropriate URL format.
     */
    window.navigateToPage = function (pageName) {
        window.location.href = window.getPlatformUrl(pageName);
    };

    // Initialize link rewriting on web
    rewriteLinksForWeb();
})();
