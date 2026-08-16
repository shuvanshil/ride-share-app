const eyeIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
        <circle cx="12" cy="12" r="2.5"></circle>
    </svg>
`;

const eyeOffIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m3 3 18 18"></path>
        <path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6 0 9.5 6 9.5 6a16.8 16.8 0 0 1-3.2 3.7M6.2 6.8C3.8 8.4 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.3 4-.8"></path>
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>
    </svg>
`;

function addPasswordToggle(input) {
    if (input.dataset.passwordToggleInitialized === "true") return;

    const field = document.createElement("div");
    field.className = "password-field";
    input.parentNode.insertBefore(field, input);
    field.appendChild(input);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "password-toggle";
    button.setAttribute("aria-label", "Show password");
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = eyeIcon;

    button.addEventListener("click", () => {
        const isVisible = input.type === "text";
        input.type = isVisible ? "password" : "text";
        button.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
        button.setAttribute("aria-pressed", String(!isVisible));
        button.innerHTML = isVisible ? eyeIcon : eyeOffIcon;
    });

    field.appendChild(button);
    input.dataset.passwordToggleInitialized = "true";
}

document.querySelectorAll('input[type="password"]').forEach(addPasswordToggle);
