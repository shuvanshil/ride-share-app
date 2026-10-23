const container = document.getElementById("admin-toast-container");

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

export function toast(message, variant = "success") {
    if (!container) return;
    const el = document.createElement("div");
    el.className = `admin-toast admin-toast-${variant}`;
    
    const iconMap = {
        success: '<i class="ti ti-check" style="font-size: 1.1rem;"></i>',
        error: '<i class="ti ti-alert-triangle" style="font-size: 1.1rem;"></i>',
        warning: '<i class="ti ti-alert-circle" style="font-size: 1.1rem;"></i>',
        info: '<i class="ti ti-info-circle" style="font-size: 1.1rem;"></i>'
    };
    const icon = iconMap[variant] || iconMap.info;
    
    el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));
    setTimeout(() => {
        el.classList.remove("is-visible");
        setTimeout(() => el.remove(), 250);
    }, 3200);
}
