// Reusable Tabler Confirmation Modal Dialog

export function showTablerConfirm(message, { title = "Are you sure?", variant = "primary", confirmText = "Confirm", cancelText = "Cancel" } = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById("admin-confirm-modal");
        const statusEl = document.getElementById("admin-confirm-status");
        const iconEl = document.getElementById("admin-confirm-icon");
        const titleEl = document.getElementById("admin-confirm-title");
        const textEl = document.getElementById("admin-confirm-text");
        const proceedBtn = document.getElementById("admin-confirm-proceed-btn");
        const cancelBtn = document.getElementById("admin-confirm-cancel-btn");
        const closeBtn = document.getElementById("admin-confirm-close-btn");

        if (!modal) {
            // Fallback to native confirm if modal element is absent
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        textEl.textContent = message;
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
        iconEl.innerHTML = `<i class="ti ${style.icon}" style="font-size: 3rem;"></i>`;
        proceedBtn.className = `btn ${style.btn} w-100`;

        function cleanup() {
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

        modal.classList.remove("d-none");
    });
}
