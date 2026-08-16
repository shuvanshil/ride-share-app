let deferredInstallPrompt = null;
const PWA_SCRIPT_URL = document.currentScript?.src || new URL('js/shared/pwa.js', window.location.origin).href;
const APP_BASE_URL = new URL('../../', PWA_SCRIPT_URL);

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

function isIosDevice() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
        || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function getInstallButtons() {
    return Array.from(document.querySelectorAll('.pwa-install-btn'));
}

function setInstallButtonsVisible(visible) {
    getInstallButtons().forEach((button) => {
        button.classList.toggle('d-none', !visible);
        button.disabled = false;
    });
}

function closeIosInstallHelp() {
    document.getElementById('pwa-ios-install-layer')?.remove();
}

function showManualInstallHelp() {
    closeIosInstallHelp();
    const ios = isIosDevice();
    const instructions = ios
        ? `
            <li>Tap the Share button in Safari.</li>
            <li>Select <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong> to install LiphtUp.</li>
        `
        : `
            <li>Open your browser menu.</li>
            <li>Select <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
            <li>Confirm to install LiphtUp.</li>
        `;

    const layer = document.createElement('div');
    layer.id = 'pwa-ios-install-layer';
    layer.className = 'pwa-ios-install-layer';
    layer.innerHTML = `
        <button class="pwa-ios-install-backdrop" type="button" aria-label="Close install instructions"></button>
        <section class="pwa-ios-install-sheet" role="dialog" aria-modal="true" aria-labelledby="pwa-ios-install-title">
            <header>
                <img src="${new URL('assets/icons/liphtup-icon-192.png', APP_BASE_URL).href}" alt="">
                <div>
                    <span>Install LiphtUp</span>
                    <h2 id="pwa-ios-install-title">${ios ? 'Add to Home Screen' : 'Install LiphtUp'}</h2>
                </div>
                <button class="pwa-ios-install-close" type="button" aria-label="Close">&times;</button>
            </header>
            <ol>
                ${instructions}
            </ol>
        </section>
    `;
    document.body.appendChild(layer);
    layer.querySelector('.pwa-ios-install-backdrop').addEventListener('click', closeIosInstallHelp);
    layer.querySelector('.pwa-ios-install-close').addEventListener('click', closeIosInstallHelp);
}

async function installLiphtUp(button) {
    if (isStandalone()) {
        setInstallButtonsVisible(false);
        return;
    }

    if (!deferredInstallPrompt) {
        showManualInstallHelp();
        return;
    }

    button.disabled = true;
    try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') setInstallButtonsVisible(false);
    } catch (error) {
        console.warn('LiphtUp install prompt failed:', error);
    } finally {
        deferredInstallPrompt = null;
        button.disabled = false;
    }
}

function bindInstallButtons() {
    getInstallButtons().forEach((button) => {
        button.addEventListener('click', () => installLiphtUp(button));
    });

    if (isStandalone()) {
        setInstallButtonsVisible(false);
    } else {
        setInstallButtonsVisible(true);
    }
}

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setInstallButtonsVisible(true);
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setInstallButtonsVisible(false);
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Service Worker is required for the Notification API showNotification method.
        const serviceWorkerUrl = new URL('sw.js', APP_BASE_URL);
        navigator.serviceWorker.register(serviceWorkerUrl.href, { scope: APP_BASE_URL.pathname }).catch((error) => {
            console.warn('LiphtUp service worker registration failed:', error);
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindInstallButtons, { once: true });
} else {
    bindInstallButtons();
}
