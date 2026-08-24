// Shared loading UI primitives used across every page.
// Mirrors the pattern in dialog.js: a singleton DOM node lazily injected
// into <body>, plus small exported helpers that pages/modules call directly.
// Nothing here touches business logic; it only toggles visual state.

const OVERLAY_ID = "lu-loading-overlay";
let overlayHideTimer = null;
let overlayRefCount = 0;

function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "lu-loading-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
        <div class="lu-loading-card" role="status" aria-live="polite">
            <span class="lu-spinner" aria-hidden="true"></span>
            <span class="lu-loading-text" id="lu-loading-overlay-text">Loading…</span>
        </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
}

/**
 * Shows a full-screen, non-blocking-to-read loading overlay.
 * Reference-counted so nested show/hide calls from different code paths
 * (e.g. auth check + map init both loading at once) don't hide it early.
 * @param {string} [message]
 */
export function showPageLoader(message) {
    const tLoading = (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t('common.loading') : "Loading…";
    const finalMsg = (!message || message === "Loading…") ? tLoading : message;
    overlayRefCount += 1;
    const overlay = ensureOverlay();
    const textEl = overlay.querySelector("#lu-loading-overlay-text");
    if (textEl) textEl.textContent = finalMsg;
    if (overlayHideTimer) {
        window.clearTimeout(overlayHideTimer);
        overlayHideTimer = null;
    }
    overlay.classList.add("is-visible");
    overlay.setAttribute("aria-hidden", "false");
}

/**
 * Hides the full-screen loading overlay. Pass `force: true` to ignore the
 * reference count and hide immediately (e.g. on error/navigation abort).
 */
export function hidePageLoader({ force = false } = {}) {
    overlayRefCount = force ? 0 : Math.max(0, overlayRefCount - 1);
    if (overlayRefCount > 0) return;

    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.classList.remove("is-visible");
    overlay.setAttribute("aria-hidden", "true");
}

/**
 * Puts a button into a busy state: shows an inline spinner, swaps its
 * label, and disables it. Returns a restore() function that puts the
 * button back exactly how it was.
 * @param {HTMLElement} button
 * @param {string} [busyText]
 */
export function setButtonBusy(button, busyText) {
    if (!button) return () => {};
    if (button.dataset.luBusy === "1") return () => {};

    const tWait = (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t('common.please_wait') : "Please wait…";
    const finalText = (busyText !== undefined && busyText !== "Please wait…") ? busyText : tWait;

    const originalHtml = button.innerHTML;
    const originalDisabled = button.disabled;
    button.dataset.luBusy = "1";
    button.disabled = true;
    button.innerHTML = `<span class="lu-spinner lu-spinner-sm" aria-hidden="true"></span><span>${finalText}</span>`;

    return function restore() {
        if (button.dataset.luBusy !== "1") return;
        delete button.dataset.luBusy;
        button.innerHTML = originalHtml;
        button.disabled = originalDisabled;
    };
}

/**
 * Renders `count` skeleton placeholder rows into a container, matching a
 * given block "kind" (card | line | avatar-row). Returns a clear() function.
 * @param {HTMLElement} container
 * @param {{ kind?: string, count?: number }} [opts]
 */
export function showSkeleton(container, { kind = "card", count = 2 } = {}) {
    if (!container) return () => {};
    const previousHtml = container.innerHTML;
    const previousLoadingAttr = container.getAttribute("data-lu-skeleton");

    const block = kind === "line"
        ? `<div class="lu-skeleton lu-skeleton-line"></div>`
        : kind === "avatar-row"
            ? `<div class="lu-skeleton-row"><span class="lu-skeleton lu-skeleton-avatar"></span><span class="lu-skeleton lu-skeleton-line lu-skeleton-flex"></span></div>`
            : `<div class="lu-skeleton lu-skeleton-card"></div>`;

    container.setAttribute("data-lu-skeleton", "1");
    container.innerHTML = Array.from({ length: Math.max(1, count) }, () => block).join("");

    return function clear() {
        if (container.getAttribute("data-lu-skeleton") !== "1") return;
        if (previousLoadingAttr === null) container.removeAttribute("data-lu-skeleton");
        else container.setAttribute("data-lu-skeleton", previousLoadingAttr);
        container.innerHTML = previousHtml;
    };
}

/**
 * Toggles a small inline spinner + label inside any element (e.g. a status
 * pill or a map's own loading badge) without replacing its other content.
 */
export function setInlineLoading(element, isLoading, loadingText = "") {
    if (!element) return;
    element.classList.toggle("lu-inline-loading", Boolean(isLoading));
    if (!isLoading) return;
    if (loadingText && element.dataset.luInlineText !== loadingText) {
        element.dataset.luInlineText = loadingText;
    }
}

/**
 * Hides the initial CSS-only loader added to the HTML body.
 * Called once the main JS logic (auth/map) is ready.
 */
export function hideInitialLoader() {
    const loader = document.getElementById("initial-loader");
    if (!loader || loader.dataset.hiding === "true") return;

    loader.dataset.hiding = "true";
    loader.style.transition = "opacity 0.4s ease, visibility 0.4s ease";
    loader.style.opacity = "0";
    loader.style.pointerEvents = "none";

    window.setTimeout(() => {
        loader.style.visibility = "hidden";
        if (loader.parentNode) {
            loader.remove();
        }
    }, 500);
}

// Global Safety: Ensure the initial loader NEVER stays longer than 8 seconds
// if a script error or network timeout happens during initialization.
window.setTimeout(hideInitialLoader, 8000);

// Exposed globally so non-module scripts (navigation.js, pwa.js, inline
// handlers) can use the same primitives instead of hand-rolled UI.
window.LiphtUpLoading = window.LiphtUpLoading || {
    showPageLoader,
    hidePageLoader,
    setButtonBusy,
    showSkeleton,
    setInlineLoading,
    hideInitialLoader
};
