// Reusable Tabler Confirmation Modal Dialog

export function showTablerConfirm(messageOrOptions, options = {}) {
    return new Promise((resolve) => {
        let message = "";
        let mergedOptions = {};

        if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
            mergedOptions = { ...messageOrOptions, ...options };
            message = mergedOptions.message || mergedOptions.text || "";
        } else {
            message = String(messageOrOptions || "");
            mergedOptions = { ...options };
        }

        const title = mergedOptions.title || "Are you sure?";
        const confirmText = mergedOptions.confirmText || "Confirm";
        const cancelText = mergedOptions.cancelText || "Cancel";
        
        let variant = mergedOptions.variant || "primary";
        if (mergedOptions.confirmBtnClass?.includes("danger") || mergedOptions.btnClass?.includes("danger")) {
            variant = "danger";
        } else if (mergedOptions.confirmBtnClass?.includes("warning") || mergedOptions.btnClass?.includes("warning")) {
            variant = "warning";
        }

        const modal = document.getElementById("admin-confirm-modal");
        const statusEl = document.getElementById("admin-confirm-status");
        const iconEl = document.getElementById("admin-confirm-icon");
        const titleEl = document.getElementById("admin-confirm-title");
        const textEl = document.getElementById("admin-confirm-text");
        const proceedBtn = document.getElementById("admin-confirm-proceed-btn");
        const cancelBtn = document.getElementById("admin-confirm-cancel-btn");
        const closeBtn = document.getElementById("admin-confirm-close-btn");

        if (!modal) {
            resolve(window.confirm(message));
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (textEl) {
            if (/<[a-z][\s\S]*>/i.test(message)) {
                textEl.innerHTML = message;
            } else {
                textEl.textContent = message;
            }
        }
        if (proceedBtn) proceedBtn.textContent = confirmText;
        if (cancelBtn) cancelBtn.textContent = cancelText;

        const colorMap = {
            danger: { status: "bg-danger", icon: "ti-alert-triangle text-danger", btn: "btn-danger" },
            warning: { status: "bg-warning", icon: "ti-alert-circle text-warning", btn: "btn-warning" },
            primary: { status: "bg-primary", icon: "ti-help-circle text-primary", btn: "btn-primary" },
            success: { status: "bg-success", icon: "ti-circle-check text-success", btn: "btn-success" }
        };
        const style = colorMap[variant] || colorMap.primary;

        if (statusEl) statusEl.className = `modal-status ${style.status}`;
        if (iconEl) iconEl.innerHTML = `<i class="ti ${style.icon}" style="font-size: 3rem;"></i>`;
        if (proceedBtn) proceedBtn.className = `btn ${style.btn} w-100`;

        function cleanup() {
            modal.style.display = "none";
            modal.classList.add("d-none");
            proceedBtn.removeEventListener("click", onProceed);
            cancelBtn.removeEventListener("click", onCancel);
            closeBtn?.removeEventListener("click", onCancel);
        }

        function onProceed() {
            cleanup();
            resolve(true);
        }

        function onCancel() {
            cleanup();
            resolve(false);
        }

        proceedBtn.addEventListener("click", onProceed);
        cancelBtn.addEventListener("click", onCancel);
        closeBtn?.addEventListener("click", onCancel);

        modal.style.display = "block";
        modal.classList.remove("d-none");
    });
}

export function showTablerPrompt({
    title = "Action Reason",
    message = "Please provide details:",
    placeholder = "Enter reason...",
    defaultValue = "",
    required = false,
    variant = "primary",
    confirmText = "Submit",
    cancelText = "Cancel",
} = {}) {
    return new Promise((resolve) => {
        let modal = document.getElementById("admin-prompt-modal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "admin-prompt-modal";
            modal.className = "modal modal-blur fade show d-none";
            modal.style.background = "rgba(15, 23, 42, 0.6)";
            modal.style.zIndex = "1060";
            modal.innerHTML = `
                <div class="modal-dialog modal-sm modal-dialog-centered" role="document">
                    <div class="modal-content">
                        <div id="admin-prompt-status" class="modal-status bg-primary"></div>
                        <div class="modal-body text-center py-4">
                            <div id="admin-prompt-icon" class="mb-2"></div>
                            <h3 id="admin-prompt-title" class="fw-bold mb-1"></h3>
                            <div id="admin-prompt-message" class="text-secondary small mb-3"></div>
                            <div class="text-start mb-3">
                                <label id="admin-prompt-input-label" class="form-label small fw-bold text-dark mb-1">Reason</label>
                                <textarea id="admin-prompt-input" class="form-control" rows="3"></textarea>
                                <div id="admin-prompt-error" class="invalid-feedback d-none">This field is required.</div>
                            </div>
                            <div class="w-100">
                                <div class="row">
                                    <div class="col"><button type="button" id="admin-prompt-cancel-btn" class="btn btn-outline-secondary w-100"></button></div>
                                    <div class="col"><button type="button" id="admin-prompt-proceed-btn" class="btn w-100"></button></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        const statusEl = document.getElementById("admin-prompt-status");
        const iconEl = document.getElementById("admin-prompt-icon");
        const titleEl = document.getElementById("admin-prompt-title");
        const messageEl = document.getElementById("admin-prompt-message");
        const inputEl = document.getElementById("admin-prompt-input");
        const errorEl = document.getElementById("admin-prompt-error");
        const proceedBtn = document.getElementById("admin-prompt-proceed-btn");
        const cancelBtn = document.getElementById("admin-prompt-cancel-btn");

        titleEl.textContent = title;
        messageEl.textContent = message;
        inputEl.value = defaultValue;
        inputEl.placeholder = placeholder;
        errorEl.classList.add("d-none");
        inputEl.classList.remove("is-invalid");
        proceedBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;

        const colorMap = {
            danger: { status: "bg-danger", icon: "ti-alert-triangle text-danger", btn: "btn-danger" },
            warning: { status: "bg-warning", icon: "ti-alert-circle text-warning", btn: "btn-warning" },
            primary: { status: "bg-primary", icon: "ti-help-circle text-primary", btn: "btn-primary" },
            success: { status: "bg-success", icon: "ti-circle-check text-success", btn: "btn-success" }
        };
        const style = colorMap[variant] || colorMap.primary;

        statusEl.className = `modal-status ${style.status}`;
        iconEl.innerHTML = `<i class="ti ${style.icon}" style="font-size: 2.5rem;"></i>`;
        proceedBtn.className = `btn ${style.btn} w-100`;

        function cleanup() {
            modal.style.display = "none";
            modal.classList.add("d-none");
            proceedBtn.removeEventListener("click", onProceed);
            cancelBtn.removeEventListener("click", onCancel);
        }

        function onProceed() {
            const val = inputEl.value.trim();
            if (required && !val) {
                inputEl.classList.add("is-invalid");
                errorEl.classList.remove("d-none");
                inputEl.focus();
                return;
            }
            cleanup();
            resolve(val);
        }

        function onCancel() {
            cleanup();
            resolve(null);
        }

        proceedBtn.addEventListener("click", onProceed);
        cancelBtn.addEventListener("click", onCancel);

        modal.style.display = "block";
        modal.classList.remove("d-none");
        setTimeout(() => inputEl.focus(), 50);
    });
}
