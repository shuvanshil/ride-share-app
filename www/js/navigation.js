const PROFILE_CACHE_KEY = "goyatra_user_profile";

function getCachedRole() {
    try {
        const profile = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null");
        return profile?.role || "";
    } catch {
        return "";
    }
}

function getRoleHomeUrl() {
    return getCachedRole() === "driver" ? "driver.html" : "index.html";
}

window.goYatraGoHome = function goYatraGoHome() {
    window.location.href = getRoleHomeUrl();
};

document.querySelectorAll('[data-home-link]').forEach((button) => {
    button.addEventListener('click', window.goYatraGoHome);
});
