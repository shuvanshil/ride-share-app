const PROFILE_CACHE_KEY = "liphtup_user_profile";

function getCachedRole() {
    try {
        const profile = JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null");
        return profile?.role || "";
    } catch {
        return "";
    }
}

function getRoleHomeUrl() {
    return getCachedRole() === "driver" ? "/driver.html" : "/index.html";
}

function getRoleServiceUrl() {
    return getCachedRole() === "driver" ? "/driver-service.html" : "/services.html";
}

window.liphtUpGoHome = function liphtUpGoHome() {
    window.location.href = getRoleHomeUrl();
};

document.querySelectorAll('[data-home-link]').forEach((button) => {
    button.addEventListener('click', window.liphtUpGoHome);
});

document.querySelectorAll('[data-service-link]').forEach((button) => {
    button.addEventListener('click', () => {
        window.location.href = getRoleServiceUrl();
    });
});
