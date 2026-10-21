/**
 * LiphtUp i18n Translation & Cache Management Engine
 * Compatible with ES Modules & Traditional Script Tags
 */

import { TRANSLATIONS, TRANSLATIONS_VERSION } from './translations.js?v=20261019-v1';

const STORAGE_LANG_KEY = 'LIPHTUP_LANG';
const STORAGE_VERSION_KEY = 'LIPHTUP_I18N_VERSION';

let currentLang = 'en';

/**
 * Hard Cache Reset Mechanism:
 * Compares client version against TRANSLATIONS_VERSION.
 * Flushes stale client translation cache if version changed.
 */
function checkCacheReset() {
    try {
        const storedVersion = localStorage.getItem(STORAGE_VERSION_KEY);
        if (storedVersion !== TRANSLATIONS_VERSION) {
            console.log(`[i18n] Cache Reset: Updating translation version from ${storedVersion} to ${TRANSLATIONS_VERSION}`);
            localStorage.setItem(STORAGE_VERSION_KEY, TRANSLATIONS_VERSION);
            // Re-verify language selection validity
            const savedLang = localStorage.getItem(STORAGE_LANG_KEY);
            if (savedLang && !TRANSLATIONS[savedLang]) {
                localStorage.setItem(STORAGE_LANG_KEY, 'en');
            }
        }
    } catch (e) {
        console.warn('[i18n] Storage access warning:', e);
    }
}

/**
 * Gets currently active language code ('en' or 'bn').
 */
export function getCurrentLanguage() {
    return currentLang;
}

/**
 * Fetches string by dot-notation key (e.g. 'auth.welcome_back').
 * Supports template variables: i18n.t('home.greeting', { name: 'Tojo' }).
 */
export function t(keyPath, fallbackOrParams = {}, maybeParams = {}) {
    if (!keyPath) return '';
    let fallback = '';
    let params = {};

    if (typeof fallbackOrParams === 'string') {
        fallback = fallbackOrParams;
        if (maybeParams && typeof maybeParams === 'object') {
            params = maybeParams;
        }
    } else if (fallbackOrParams && typeof fallbackOrParams === 'object') {
        params = fallbackOrParams;
    }

    const keys = String(keyPath).split('.');
    
    // 1. Try current language
    let result = getNestedKey(TRANSLATIONS[currentLang], keys);
    
    // 2. Fallback to English if missing in current language
    if (result === undefined && currentLang !== 'en') {
        result = getNestedKey(TRANSLATIONS['en'], keys);
    }

    // 3. Fallback to provided fallback string or key itself if not found anywhere
    if (result === undefined) {
        result = fallback || keyPath;
    }

    let text = String(result);

    // Replace template parameters {variable}
    if (params && typeof params === 'object') {
        Object.keys(params).forEach(param => {
            text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), params[param] ?? '');
        });
    }

    return text;
}

function getNestedKey(obj, keys) {
    if (!obj) return undefined;
    let curr = obj;
    for (const k of keys) {
        if (curr && typeof curr === 'object' && k in curr) {
            curr = curr[k];
        } else {
            return undefined;
        }
    }
    return curr;
}

/**
 * Translates DOM nodes with data-i18n attributes.
 */
export function translateDOM(container = document) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    // 0. Inner HTML (for rich text with HTML tags like hero accent spans)
    container.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        if (!key) return;
        const fallback = el.innerHTML || '';
        const translated = t(key, fallback);
        if (translated) {
            el.innerHTML = translated;
        }
    });

    // 1. Text Content
    container.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const fallback = el.textContent ? el.textContent.trim() : '';
        const translated = t(key, fallback);
        if (translated) {
            // Handle line breaks (\n) cleanly if present
            if (translated.includes('\n')) {
                el.innerHTML = translated.replace(/\n/g, '<br>');
            } else {
                el.textContent = translated;
            }
        }
    });

    // 2. Placeholders
    container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) {
            const fallback = el.placeholder || '';
            el.placeholder = t(key, fallback);
        }
    });

    // 3. Titles
    container.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) {
            const fallback = el.title || '';
            el.title = t(key, fallback);
        }
    });

    // 4. Aria Labels
    container.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (key) {
            const fallback = el.getAttribute('aria-label') || '';
            el.setAttribute('aria-label', t(key, fallback));
        }
    });

    // Update document title if present
    const docTitleKey = document.documentElement.getAttribute('data-i18n-doc-title');
    if (docTitleKey) {
        document.title = t(docTitleKey);
    }
}

/**
 * Sets app language and triggers brief smooth loading spinner + DOM translation.
 */
export function setLanguage(lang) {
    const targetLang = (lang === 'bn' || lang === 'bengali') ? 'bn' : 'en';
    
    // Save to storage
    currentLang = targetLang;
    try {
        localStorage.setItem(STORAGE_LANG_KEY, targetLang);
    } catch (e) {}

    // Update HTML root attributes
    document.documentElement.lang = targetLang;
    document.documentElement.setAttribute('data-current-lang', targetLang);

    // Show brief non-intrusive loading spinner overlay during language switch
    showLanguageSwitchSpinner();

    setTimeout(() => {
        // Translate static DOM elements
        translateDOM(document);

        // Update all language switcher pills on page
        updateSwitcherUI();

        // Dispatch custom global event for dynamic JS components to re-render
        window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: targetLang } }));

        hideLanguageSwitchSpinner();
    }, 200);
}

/**
 * Brief loading overlay during language switch
 */
function showLanguageSwitchSpinner() {
    let loader = document.getElementById('lang-switch-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'lang-switch-loader';
        loader.className = 'lang-switch-loader-overlay';
        loader.innerHTML = `
            <div class="lang-switch-spinner-card">
                <div class="lang-switch-spinner"></div>
                <span>${t('common.switching_language')}</span>
            </div>
        `;
        document.body.appendChild(loader);
    } else {
        const span = loader.querySelector('span');
        if (span) span.textContent = t('common.switching_language');
    }
    requestAnimationFrame(() => loader.classList.add('is-active'));
}

function hideLanguageSwitchSpinner() {
    const loader = document.getElementById('lang-switch-loader');
    if (loader) {
        loader.classList.remove('is-active');
        setTimeout(() => {
            if (loader.parentNode && !loader.classList.contains('is-active')) {
                loader.parentNode.removeChild(loader);
            }
        }, 250);
    }
}

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=in.liphtup.app';

/**
 * Checks if the current execution environment is inside the native Capacitor Android app.
 * Returns true only for the native app; returns false for standard web browsers (mobile and desktop).
 */
export function isCapacitorApp() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('preview_app') === '1') return true;
        if (urlParams.get('preview_web') === '1') return false;

        if (typeof window.Capacitor !== 'undefined' && typeof window.Capacitor.isNativePlatform === 'function') {
            return window.Capacitor.isNativePlatform();
        }
        if (window.location.protocol === 'capacitor:') {
            return true;
        }
        if (navigator.userAgent && navigator.userAgent.indexOf('Capacitor') !== -1) {
            return true;
        }
        if (typeof window.LiphtUpNative !== 'undefined' || typeof window.LiphtUpNativeStatus !== 'undefined') {
            return true;
        }
    } catch (e) {}
    return false;
}

/**
 * Returns true if the current page should display the Google Play Store button pill
 * when accessed on the web version.
 * Target pages:
 * - Passenger home page ('/', '/index.html')
 * - Passenger services page ('/services.html', '/services')
 * - Passenger history page ('/history.html', '/history')
 * - Driver home page ('/driver.html', '/driver')
 * - Driver services page ('/driver-service.html', '/driver-service')
 * - Driver history / dashboard ('/driver-dashboard.html', '/driver-dashboard')
 * 
 * Specifically excludes profile, login, and signup pages (language pill is kept).
 */
export function isPlayStorePillPage() {
    try {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.includes('profile') || path.includes('login') || path.includes('signup')) {
            return false;
        }
        const segments = path.replace(/\/+$/, '').split('/');
        const page = segments.pop() || '';

        return (
            page === '' ||
            page === 'index' ||
            page === 'index.html' ||
            page === 'services' ||
            page === 'services.html' ||
            page === 'history' ||
            page === 'history.html' ||
            page === 'driver' ||
            page === 'driver.html' ||
            page === 'driver-service' ||
            page === 'driver-service.html' ||
            page === 'driver-dashboard' ||
            page === 'driver-dashboard.html'
        );
    } catch (e) {}
    return false;
}

/**
 * Renders the sleek "Get it on Google Play" button pill for the web version.
 */
export function renderGooglePlayBadge(container) {
    if (!container) return;
    container.innerHTML = `
        <div class="google-play-pill-wrap">
            <a href="${PLAY_STORE_URL}"
               target="_blank"
               rel="noopener noreferrer"
               class="play-store-pill-btn"
               aria-label="Get it on Google Play">
                <img src="assets/branding/google-play-badge.png"
                     alt="Get it on Google Play"
                     class="play-store-badge-img"
                     width="121"
                     height="36"
                     loading="eager"
                     decoding="async">
            </a>
        </div>
    `;
}

/**
 * Renders the Header Action Pill:
 * - On Web version for designated pages: "Get it on Google Play" button pill.
 * - In Capacitor Native App (or profile/login/signup): Sleek Language Switcher Pill.
 */
export function renderLanguageSwitcher(container, options = {}) {
    if (!container) return;

    const forceLanguage = options.forceLanguage === true;
    const forcePlayStore = options.forcePlayStore === true;
    const isNative = isCapacitorApp();

    if (!isNative && !forceLanguage && (forcePlayStore || isPlayStorePillPage())) {
        renderGooglePlayBadge(container);
        return;
    }

    container.innerHTML = `
        <div class="lang-switcher-pill-wrap">
            <button type="button" class="lang-toggle-btn" aria-label="Select Language" aria-expanded="false">
                <div class="lang-globe-icon-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1A7A2E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M2 12h20"/>
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    </svg>
                </div>
                <div class="lang-divider"></div>
                <div class="lang-label-group">
                    <span class="lang-label-primary">${currentLang === 'en' ? 'English' : 'বাংলা'}</span>
                    <span class="lang-label-secondary">${currentLang === 'en' ? 'বাংলা' : 'English'}</span>
                </div>
                <svg class="lang-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1A7A2E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </button>
            <div class="lang-dropdown-menu d-none">
                <button type="button" class="lang-option-item${currentLang === 'en' ? ' active' : ''}" data-lang="en">
                    <span class="lang-option-title">English</span>
                    <span class="lang-option-sub">English</span>
                </button>
                <button type="button" class="lang-option-item${currentLang === 'bn' ? ' active' : ''}" data-lang="bn">
                    <span class="lang-option-title">বাংলা</span>
                    <span class="lang-option-sub">Bengali</span>
                </button>
            </div>
        </div>
    `;

    const btn = container.querySelector('.lang-toggle-btn');
    const menu = container.querySelector('.lang-dropdown-menu');

    if (btn && menu) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpened = !menu.classList.contains('d-none');
            // Close any other open menus
            document.querySelectorAll('.lang-dropdown-menu').forEach(m => m.classList.add('d-none'));
            if (!isOpened) {
                menu.classList.remove('d-none');
                btn.setAttribute('aria-expanded', 'true');
            } else {
                btn.setAttribute('aria-expanded', 'false');
            }
        });

        menu.querySelectorAll('.lang-option-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const selected = item.dataset.lang;
                menu.classList.add('d-none');
                btn.setAttribute('aria-expanded', 'false');
                if (selected !== currentLang) {
                    setLanguage(selected);
                }
            });
        });
    }
}

/**
 * Automatically initializes header pills on standard containers across all pages.
 */
export function autoInitHeaderPill() {
    const selector = [
        '#home-lang-switcher',
        '#services-lang-switcher',
        '#history-lang-switcher',
        '#driver-lang-switcher',
        '#driver-service-lang-switcher',
        '#driver-dashboard-lang-switcher',
        '[data-header-lang-pill]'
    ].join(',');

    document.querySelectorAll(selector).forEach(el => {
        if (!el.dataset.pillInitialized) {
            el.dataset.pillInitialized = 'true';
            renderLanguageSwitcher(el);
        }
    });
}

function updateSwitcherUI() {
    document.querySelectorAll('.lang-switcher-pill-wrap').forEach(wrap => {
        const primary = wrap.querySelector('.lang-label-primary');
        const secondary = wrap.querySelector('.lang-label-secondary');
        if (primary && secondary) {
            primary.textContent = currentLang === 'en' ? 'English' : 'বাংলা';
            secondary.textContent = currentLang === 'en' ? 'বাংলা' : 'English';
        }
        wrap.querySelectorAll('.lang-option-item').forEach(item => {
            item.classList.toggle('active', item.dataset.lang === currentLang);
        });
    });
}

// Global click handler to close open language dropdowns
document.addEventListener('click', () => {
    document.querySelectorAll('.lang-dropdown-menu').forEach(m => m.classList.add('d-none'));
});

// --- Initialize i18n Engine ---
checkCacheReset();

// Load initial language selection from localStorage
try {
    const saved = localStorage.getItem(STORAGE_LANG_KEY);
    if (saved && TRANSLATIONS[saved]) {
        currentLang = saved;
    }
} catch (e) {}

document.documentElement.lang = currentLang;

// Translate DOM & initialize header pill on ready
function onDomReady() {
    translateDOM(document);
    autoInitHeaderPill();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
} else {
    onDomReady();
}

// Global window reference for legacy non-module scripts
window.LiphtUpI18n = {
    t,
    getCurrentLanguage,
    setLanguage,
    translateDOM,
    renderLanguageSwitcher,
    renderGooglePlayBadge,
    autoInitHeaderPill,
    isCapacitorApp,
    isPlayStorePillPage,
    PLAY_STORE_URL
};
