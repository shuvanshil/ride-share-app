const ROOT_ID = "lu-dialog-root";
const queue = [];
let isShowing = false;

function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
        <div class="lu-dialog-overlay" id="lu-dialog-overlay">
            <div class="lu-dialog-box" id="lu-dialog-box" role="alertdialog" aria-modal="true" aria-describedby="lu-dialog-message" tabindex="-1">
                <p class="lu-dialog-message" id="lu-dialog-message"></p>
                <div class="lu-dialog-actions" id="lu-dialog-actions">
                    <button type="button" class="lu-dialog-btn lu-dialog-btn-cancel" id="lu-dialog-cancel-btn">Cancel</button>
                    <button type="button" class="lu-dialog-btn lu-dialog-btn-ok" id="lu-dialog-ok-btn">OK</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    return root;
}

function processQueue() {
    if (isShowing || queue.length === 0) return;
    isShowing = true;

    const { message, okText, cancelText, showCancel, resolve } = queue.shift();
    const root = ensureRoot();
    const overlay = root.querySelector("#lu-dialog-overlay");
    const box = root.querySelector("#lu-dialog-box");
    const actions = root.querySelector("#lu-dialog-actions");
    const messageEl = root.querySelector("#lu-dialog-message");
    const okBtn = root.querySelector("#lu-dialog-ok-btn");
    const cancelBtn = root.querySelector("#lu-dialog-cancel-btn");

    messageEl.textContent = message;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    cancelBtn.classList.toggle("d-none", !showCancel);
    actions.classList.toggle("lu-dialog-single", !showCancel);

    const previouslyFocused = document.activeElement;

    function finish(result) {
        overlay.classList.remove("is-open");
        document.removeEventListener("keydown", onKeydown, true);
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        overlay.removeEventListener("mousedown", onOverlayClick);
        window.setTimeout(() => {
            isShowing = false;
            if (previouslyFocused && typeof previouslyFocused.focus === "function") {
                previouslyFocused.focus();
            }
            processQueue();
        }, 180);
        resolve(result);
    }

    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onOverlayClick(event) {
        if (event.target === overlay && showCancel) finish(false);
    }
    function onKeydown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            finish(showCancel ? false : true);
        } else if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
        } else if (event.key === "Tab") {
            const focusable = showCancel ? [cancelBtn, okBtn] : [okBtn];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onOverlayClick);
    document.addEventListener("keydown", onKeydown, true);

    overlay.classList.add("is-open");
    window.requestAnimationFrame(() => box.focus());
}

function openDialog(options) {
    return new Promise((resolve) => {
        queue.push({ ...options, resolve });
        processQueue();
    });
}

/**
 * Shows a themed, in-app alert dialog with a single "OK" button.
 * Replaces window.alert().
 * @param {string} message
 * @param {{ okText?: string }} [opts]
 * @returns {Promise<true>}
 */
export function showAlert(message, opts = {}) {
    return openDialog({
        message: String(message ?? ""),
        okText: opts.okText || "OK",
        cancelText: "Cancel",
        showCancel: false
    });
}

/**
 * Shows a themed, in-app confirm dialog with "OK" and "Cancel" buttons.
 * Replaces window.confirm().
 * @param {string} message
 * @param {{ okText?: string, cancelText?: string }} [opts]
 * @returns {Promise<boolean>} resolves true if the user confirmed, false otherwise
 */
export function showConfirm(message, opts = {}) {
    const tOk = (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t('common.confirm') : "OK";
    const tCancel = (window.LiphtUpI18n && typeof window.LiphtUpI18n.t === 'function') ? window.LiphtUpI18n.t('common.cancel') : "Cancel";
    return openDialog({
        message: String(message ?? ""),
        okText: opts.okText || tOk,
        cancelText: opts.cancelText || tCancel,
        showCancel: true
    });
}

// Initialized once and exposed globally so non-module scripts (e.g. navigation.js, pwa.js)
// can also call the same in-app dialog instead of the browser's native alert/confirm boxes.
window.LiphtUpDialog = window.LiphtUpDialog || { alert: showAlert, confirm: showConfirm };
