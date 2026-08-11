const container = document.getElementById("admin-toast-container");

export function toast(message, variant = "success") {
    const el = document.createElement("div");
    el.className = `admin-toast admin-toast-${variant}`;
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-visible"));
    setTimeout(() => {
        el.classList.remove("is-visible");
        setTimeout(() => el.remove(), 250);
    }, 3200);
}
