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
        if (isNative) {
            return pageName.endsWith('.html') ? pageName : `${pageName}.html`;
        }
        return pageName.replace(/\.html$/, '');
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
