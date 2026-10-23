import { watchAdminAuth, loginAdmin, logoutAdmin, adminGet, adminPatch, adminPost, adminDelete, refreshAdminToken, beginAdminBusy, setActiveAdminSectionBusy, clearAdminCache } from "./admin-api.js?v=2.7.0";
import { showTablerConfirm, showTablerPrompt } from "./admin-confirm.js?v=2.7.0";
import { DataTable } from "./data-table.js?v=2.7.0";
import { showReadOnlyDrawer, showFormDrawer, closeDrawer } from "./admin-drawer.js?v=2.7.0";
import { startLiveFeed, stopLiveFeed, trackRideOnMap, stopTracking, openLiveRideMapModal, closeLiveRideMapModal, renderRideMap } from "./admin-live.js?v=2.7.0";
import { toast } from "./admin-toast.js?v=2.7.0";
import { loadSafety, refreshSafetyBadge, startSosRealtimeAlerts, openSosDetailDrawer, openReportDetailDrawer } from "./admin-safety.js?v=2.7.0";
import { initAdminPayments, loadAdminPayments, loadAdminPassengerWallets, initAdminWalletCredit } from "./admin-payments.js?v=2.7.0";
import { loadPermissions, initPermissionsModal } from "./admin-permissions.js?v=2.7.0";
import { initAdminCoupons, loadAdminCoupons } from "./admin-coupons.js?v=2.7.0";
import { initAdminReports, loadAdminReports } from "./admin-reports.js?v=2.7.0";

const $ = (id) => document.getElementById(id);

const authGateScreen = $("admin-auth-gate-screen");
const loginScreen = $("admin-login-screen");
const deniedScreen = $("admin-denied-screen");
const shell = $("admin-shell");

let currentAdminRole = "admin"; // "super_admin", "admin", or "manager"
let currentSection = "dashboard";
let isAdminAuthenticated = false;
let isIntentionalLogout = false;
let isLoggingIn = false;
let liveRidesTimer = null;
const cursors = { drivers: null, history: null, passengers: null, audit: null };
let driversTable = null;
let passengersTable = null;
let historyTable = null;
let auditTable = null;
let driversSearchQuery = "";
let passengersSearchQuery = "";
let historySearchQuery = "";
let feedUnreadCount = 0;
let feedStarted = false;
let liveErrorShown = false;

// ---------------------------------------------------------------------
// Multi-Page URL Routing Configuration (/admin/<subpage>)
// ---------------------------------------------------------------------

const SECTION_TO_SLUG = {
    "dashboard": "dashboard",
    "live-rides": "liverides",
    "drivers": "drivers",
    "passengers": "passengers",
    "payments": "feepayment",
    "wallet-payments": "walletpayments",
    "ride-history": "ridehistory",
    "coupons": "coupons",
    "safety": "safety",
    "reports": "reports",
    "analytics": "analytics",
    "notifications": "notifications",
    "audit-log": "auditlog",
    "permissions": "permissions",
};

const SLUG_TO_SECTION = {
    "dashboard": "dashboard",
    "overview": "dashboard",
    "liverides": "live-rides",
    "live-rides": "live-rides",
    "live": "live-rides",
    "drivers": "drivers",
    "driver": "drivers",
    "passengers": "passengers",
    "passenger": "passengers",
    "feepayment": "payments",
    "feepayments": "payments",
    "fee-payment": "payments",
    "fee-payments": "payments",
    "payments": "payments",
    "walletpayments": "wallet-payments",
    "wallet-payments": "wallet-payments",
    "walletpayment": "wallet-payments",
    "wallet": "wallet-payments",
    "ridehistory": "ride-history",
    "ride-history": "ride-history",
    "history": "ride-history",
    "coupons": "coupons",
    "coupon": "coupons",
    "safety": "safety",
    "sos": "safety",
    "reports": "reports",
    "report": "reports",
    "analytics": "analytics",
    "notifications": "notifications",
    "notification": "notifications",
    "auditlog": "audit-log",
    "audit-log": "audit-log",
    "audit": "audit-log",
    "permissions": "permissions",
    "permission": "permissions",
};

const SECTION_TITLES = {
    "dashboard": "Dashboard",
    "live-rides": "Live Rides",
    "drivers": "Drivers",
    "passengers": "Passengers",
    "payments": "Fee Payments",
    "wallet-payments": "Wallet Payments",
    "ride-history": "Ride History",
    "coupons": "Promotional Coupons",
    "safety": "Safety & SOS",
    "reports": "System Reports",
    "analytics": "Analytics",
    "notifications": "Notifications Center",
    "audit-log": "Audit Log",
    "permissions": "Admin Permissions",
};

function parseRequestedAdminRoute(pathname = window.location.pathname) {
    const clean = String(pathname || "")
        .replace(/\/+$/, "")
        .replace(/\.html$/i, "");
    if (!clean || clean === "/admin" || clean === "/admin/index") {
        return { isRoot: true, section: "dashboard", rawSlug: "", isKnown: true };
    }
    const match = clean.match(/^\/admin\/([^/?#]+)/i) || clean.match(/^\/([^/?#]+)$/i);
    if (!match) {
        return { isRoot: true, section: "dashboard", rawSlug: "", isKnown: true };
    }
    const rawSlug = decodeURIComponent(match[1]).trim();
    const lookup = rawSlug.toLowerCase();
    if (lookup === "index" || lookup === "admin") {
        return { isRoot: true, section: "dashboard", rawSlug: "", isKnown: true };
    }
    const mapped = SLUG_TO_SECTION[lookup];
    return {
        isRoot: false,
        section: mapped || "dashboard",
        rawSlug,
        isKnown: Boolean(mapped),
    };
}

function getInitialBusyLabelForRoute() {
    const req = parseRequestedAdminRoute();
    const title = SECTION_TITLES[req.section] || "Dashboard";
    return `Loading ${title}...`;
}

function getCanonicalAdminPath(section) {
    const slug = SECTION_TO_SLUG[section] || "dashboard";
    return `/admin/${slug}`;
}

let pendingInitialRoute = parseRequestedAdminRoute();

// Dashboard state
let rideActivityChartInstance = null;
let driverDonutChartInstance = null;
let currentChartTimeframe = "today";
let dashboardOverviewData = null;
let recentActivityItems = [];

// Global error boundary
window.addEventListener("error", (e) => toast(`Something went wrong: ${e.message}`, "error"));
window.addEventListener("unhandledrejection", (e) => toast(`Something went wrong: ${e.reason?.message || e.reason}`, "error"));

async function withButtonSpinner(btn, actionFn, loadingText = "Processing...") {
    if (!btn) return actionFn();
    const originalHtml = btn.innerHTML;
    const originalDisabled = btn.disabled;
    btn.disabled = true;
    btn.innerHTML = loadingText
        ? `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>${loadingText}`
        : `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>`;
    try {
        return await actionFn();
    } finally {
        if (btn.isConnected) {
            btn.disabled = originalDisabled;
            btn.innerHTML = originalHtml;
        }
    }
}

// ---------------------------------------------------------------------
// Mobile Device Detection (Requirement 6 & 7)
// ---------------------------------------------------------------------

function checkMobileDevice() {
    const modal = $("modal-mobile-warning");
    if (!modal) return;
    const isDesktopMode = window.innerWidth >= 900;
    if (!isDesktopMode) {
        modal.classList.remove("d-none");
        modal.style.display = "block";
    } else {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
}

window.addEventListener("resize", checkMobileDevice);

async function performIntentionalAdminLogout() {
    isIntentionalLogout = true;
    sessionStorage.setItem("liphtup_admin_intentional_logout", "1");
    isAdminAuthenticated = false;
    pendingInitialRoute = { isRoot: true, section: "dashboard", rawSlug: "", isKnown: true };
    clearInterval(liveRidesTimer);
    stopLiveFeed();
    stopTracking();
    closeDrawer(true);
    clearAdminCache();
    loadedSections.clear();
    sessionStorage.removeItem("admin_session_active");
    localStorage.removeItem("admin_session_active");
    sessionStorage.removeItem("liphtup_user_profile");
    sessionStorage.removeItem("super_admin_notice_dismissed");
    window.history.replaceState(null, "", "/admin");
    document.title = "Sign In · LiphtUp Admin Console";
    showOnly(loginScreen);
    try {
        await logoutAdmin().catch(() => null);
    } finally {
        isIntentionalLogout = false;
        sessionStorage.removeItem("liphtup_admin_intentional_logout");
    }
}

$("btn-mobile-logout")?.addEventListener("click", async (e) => {
    await withButtonSpinner(e.currentTarget, async () => {
        $("modal-mobile-warning")?.classList.add("d-none");
        if ($("modal-mobile-warning")) $("modal-mobile-warning").style.display = "none";
        await performIntentionalAdminLogout();
    }, "Signing out...");
});

// ---------------------------------------------------------------------
// Super Admin Advisory Notice Modal (Requirement 8)
// ---------------------------------------------------------------------

function checkSuperAdminNotice(role) {
    const modal = $("modal-super-admin-notice");
    if (!modal) return;

    if (String(role).toLowerCase() !== "super_admin") {
        modal.classList.add("d-none");
        modal.style.display = "none";
        return;
    }

    const dismissed = sessionStorage.getItem("super_admin_notice_dismissed") === "true";
    if (dismissed) {
        modal.classList.add("d-none");
        modal.style.display = "none";
        return;
    }

    modal.classList.remove("d-none");
    modal.style.display = "block";
}

$("btn-super-admin-ignore")?.addEventListener("click", () => {
    sessionStorage.setItem("super_admin_notice_dismissed", "true");
    const modal = $("modal-super-admin-notice");
    if (modal) {
        modal.classList.add("d-none");
        modal.style.display = "none";
    }
});

$("btn-super-admin-logout")?.addEventListener("click", async (e) => {
    await withButtonSpinner(e.currentTarget, async () => {
        const modal = $("modal-super-admin-notice");
        if (modal) {
            modal.classList.add("d-none");
            modal.style.display = "none";
        }
        await performIntentionalAdminLogout();
    }, "Signing out...");
});

// ---------------------------------------------------------------------
// Auth gate & Role Enforcement
// ---------------------------------------------------------------------

function showOnly(el) {
    [authGateScreen, loginScreen, deniedScreen, shell].forEach((node) => {
        if (node) node.classList.toggle("d-none", node !== el);
    });
    if (el === shell) {
        checkMobileDevice();
    }
}

function redirectToAccessDeniedPage() {
    if (window.location.pathname.startsWith("/admin-access-denied")) return;
    window.location.replace("/admin-access-denied/");
}

function showDeniedSubpageNotice(routeInfo, reasonMsg) {
    const reasonEl = $("admin-denied-reason-text");
    const subNotice = $("admin-denied-subpage-notice");
    if (reasonEl && reasonMsg) {
        reasonEl.textContent = reasonMsg;
    }
    if (subNotice) {
        if (routeInfo && !routeInfo.isRoot) {
            subNotice.innerHTML = `<i class="ti ti-alert-octagon me-1"></i><strong>Blocked URL:</strong> <code>/admin/${escapeHtml(routeInfo.rawSlug)}</code> — You do not have permission to view this page. Zero admin data was loaded.`;
            subNotice.classList.remove("d-none");
        } else {
            subNotice.classList.add("d-none");
        }
    }
}

function showSectionRoleDeniedBanner(message) {
    const banner = $("admin-section-denied-banner");
    const textEl = $("admin-section-denied-banner-text");
    if (!banner || !textEl) return;
    textEl.textContent = message;
    banner.classList.remove("d-none");
}

$("admin-section-denied-banner-close")?.addEventListener("click", () => {
    $("admin-section-denied-banner")?.classList.add("d-none");
});

function applyRolePermissions(role, userDetails = {}) {
    currentAdminRole = String(role || "admin").toLowerCase();
    
    // Update Header Badge
    const badge = $("admin-header-role-badge");
    if (badge) {
        if (currentAdminRole === "super_admin") {
            badge.className = "badge bg-purple-lt text-purple ms-2 fw-bold";
            badge.textContent = "Super Admin";
        } else if (currentAdminRole === "manager") {
            badge.className = "badge bg-warning-lt text-warning ms-2 fw-bold";
            badge.textContent = "Manager";
        } else {
            badge.className = "badge bg-blue-lt text-blue ms-2 fw-bold";
            badge.textContent = "Admin";
        }
    }

    // Update Popover User Details
    const popoverName = $("admin-popover-name");
    const popoverEmail = $("admin-popover-email");
    const popoverRole = $("admin-popover-role-badge");
    if (popoverName) popoverName.textContent = userDetails.name || userDetails.email || "Admin User";
    if (popoverEmail) popoverEmail.textContent = userDetails.email || "admin@liphtup.in";
    if (popoverRole) {
        if (currentAdminRole === "super_admin") {
            popoverRole.className = "badge bg-purple-lt text-purple fw-bold";
            popoverRole.textContent = "Super Admin";
        } else if (currentAdminRole === "manager") {
            popoverRole.className = "badge bg-warning-lt text-warning fw-bold";
            popoverRole.textContent = "Manager";
        } else {
            popoverRole.className = "badge bg-blue-lt text-blue fw-bold";
            popoverRole.textContent = "Admin";
        }
    }

    // Check Super Admin Notice
    checkSuperAdminNotice(currentAdminRole);

    // Sidebar items visibility
    const hidePermissions = currentAdminRole !== "super_admin";
    const hideManagerRestricted = currentAdminRole === "manager";

    $("nav-item-permissions")?.classList.toggle("d-none", hidePermissions);
    $("nav-item-coupons")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-reports")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-passengers")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-ride-history")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-analytics")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-audit-log")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-live-rides")?.classList.toggle("d-none", hideManagerRestricted);
    $("nav-item-notifications")?.classList.toggle("d-none", hideManagerRestricted);
}

function isSectionAllowed(section) {
    if (!SECTION_TO_SLUG[section]) return false;
    if (currentAdminRole === "super_admin") return true;
    if (currentAdminRole === "admin") {
        return section !== "permissions";
    }
    if (currentAdminRole === "manager") {
        const allowed = new Set(["dashboard", "drivers", "payments", "wallet-payments", "safety"]);
        return allowed.has(section);
    }
    return false;
}

function resolveInitialAuthorizedSection() {
    const req = pendingInitialRoute || parseRequestedAdminRoute();
    pendingInitialRoute = null;

    if (!req.isKnown) {
        const msg = `Sub-page "/admin/${req.rawSlug}" does not exist. Redirected to Dashboard.`;
        toast(msg, "warning");
        showSectionRoleDeniedBanner(msg);
        return "dashboard";
    }

    if (!isSectionAllowed(req.section)) {
        const msg = `Access Restricted: Your ${currentAdminRole.toUpperCase()} role is not authorized to access "/admin/${req.rawSlug || SECTION_TO_SLUG[req.section]}". Redirected to Dashboard.`;
        toast(msg, "error");
        showSectionRoleDeniedBanner(msg);
        return "dashboard";
    }

    return req.section || "dashboard";
}

async function bootstrapAuthenticatedShell(result) {
    isAdminAuthenticated = true;
    isIntentionalLogout = false;
    sessionStorage.setItem("admin_session_active", "true");
    localStorage.setItem("admin_session_active", "true");
    applyRolePermissions(result.role, result);

    const targetSection = resolveInitialAuthorizedSection();
    currentSection = targetSection;
    setActiveAdminSectionBusy(targetSection, SECTION_TITLES[targetSection] || "Section");
    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === targetSection));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== `section-${targetSection}`));
    syncSidebarCollapseUI();
    showOnly(shell);

    initAdminPayments();
    initAdminWalletCredit();
    initLiveRidesEvents();
    initAdminCoupons();
    initAdminReports();
    initPermissionsModal();
    initNotificationsEvents();
    initAnalyticsEvents();
    refreshSafetyBadge();
    startSosRealtimeAlerts();

    await activateAdminSection(targetSection, { updateUrl: true, replaceUrl: true, forceReload: true });

    if (!feedStarted) {
        feedStarted = true;
        await refreshAdminToken();
        startLiveFeed(onFeedEvent, (message) => {
            if (liveErrorShown) return;
            liveErrorShown = true;
            toast(message, "error");
        });
    }
}

watchAdminAuth(async (user) => {
    if (isLoggingIn) return;

    const currentReq = parseRequestedAdminRoute();
    if (!currentReq.isRoot) {
        pendingInitialRoute = currentReq;
    }
    const hasPassengerOrDriverSession = Boolean(sessionStorage.getItem("liphtup_user_profile"));
    const adminSessionActive =
        sessionStorage.getItem("admin_session_active") === "true" ||
        localStorage.getItem("admin_session_active") === "true" ||
        (Boolean(user) && !hasPassengerOrDriverSession);

    if (!user || !adminSessionActive) {
        isAdminAuthenticated = false;
        stopLiveFeed();
        // If this was an intentional logout by the admin, go directly to /admin login page without showing any access-restricted page
        const wasIntentionalLogout =
            isIntentionalLogout || sessionStorage.getItem("liphtup_admin_intentional_logout") === "1";
        if (wasIntentionalLogout) {
            isIntentionalLogout = false;
            sessionStorage.removeItem("liphtup_admin_intentional_logout");
            pendingInitialRoute = { isRoot: true, section: "dashboard", rawSlug: "", isKnown: true };
            if (window.location.pathname !== "/admin" && window.location.pathname !== "/admin/") {
                window.history.replaceState(null, "", "/admin");
            }
            document.title = "Sign In · LiphtUp Admin Console";
            showOnly(loginScreen);
            return;
        }
        // Unauthenticated direct access to any protected admin subpage -> redirect to dedicated /admin-access-denied/ page
        if (!currentReq.isRoot || (pendingInitialRoute && !pendingInitialRoute.isRoot)) {
            redirectToAccessDeniedPage();
            return;
        }
        if (window.location.pathname !== "/admin" && window.location.pathname !== "/admin/") {
            window.history.replaceState(null, "", "/admin");
        }
        document.title = "Sign In · LiphtUp Admin Console";
        showOnly(loginScreen);
        return;
    }
    showOnly(authGateScreen);
    try {
        const result = await adminGet("/verify", {}, { showBusy: true, busyLabel: getInitialBusyLabelForRoute() });
        await bootstrapAuthenticatedShell(result);
    } catch (error) {
        isAdminAuthenticated = false;
        sessionStorage.removeItem("admin_session_active");
        localStorage.removeItem("admin_session_active");
        stopLiveFeed();
        isIntentionalLogout = true;
        await logoutAdmin().catch(() => null);
        isIntentionalLogout = false;
        if (!currentReq.isRoot || (pendingInitialRoute && !pendingInitialRoute.isRoot)) {
            redirectToAccessDeniedPage();
            return;
        }
        showDeniedSubpageNotice(pendingInitialRoute, "This account does not have admin privileges for LiphtUp.");
        if (window.location.pathname !== "/admin" && window.location.pathname !== "/admin/") {
            window.history.replaceState(null, "", "/admin");
        }
        document.title = "Access Denied · LiphtUp Admin Console";
        showOnly(deniedScreen);
    }
});

async function handleAdminLogin() {
    const loginBtn = $("admin-login-btn");
    await withButtonSpinner(loginBtn, async () => {
        const email = $("admin-email").value.trim();
        const password = $("admin-password").value;
        const errorEl = $("admin-login-error");
        const errorTextEl = $("admin-login-error-text");
        errorEl.classList.add("d-none");
        if (!email || !password) {
            errorTextEl.textContent = "Enter your email and password.";
            errorEl.classList.remove("d-none");
            return;
        }
        isLoggingIn = true;
        try {
            // Auto logout any previous passenger, driver, or active session to prevent role clashes
            sessionStorage.removeItem("liphtup_user_profile");
            sessionStorage.removeItem("admin_session_active");
            localStorage.removeItem("admin_session_active");
            sessionStorage.removeItem("super_admin_notice_dismissed");
            await logoutAdmin().catch(() => null);

            await loginAdmin(email, password);
            sessionStorage.setItem("admin_session_active", "true");
            localStorage.setItem("admin_session_active", "true");
            await refreshAdminToken();
            const result = await adminGet("/verify", {}, { showBusy: true, busyLabel: "Verifying admin permissions..." });
            isLoggingIn = false;
            await bootstrapAuthenticatedShell(result);
        } catch (error) {
            isLoggingIn = false;
            isAdminAuthenticated = false;
            sessionStorage.removeItem("admin_session_active");
            localStorage.removeItem("admin_session_active");
            isIntentionalLogout = true;
            await logoutAdmin().catch(() => null);
            isIntentionalLogout = false;
            errorTextEl.textContent = error?.message?.includes?.("Admin access required")
                ? "This account does not have admin privileges."
                : "Sign in failed. Check your email and password.";
            errorEl.classList.remove("d-none");
        }
    }, "Signing in...");
}

$("admin-login-btn")?.addEventListener("click", handleAdminLogin);
$("admin-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});
$("admin-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminLogin();
});

$("admin-denied-back-btn")?.addEventListener("click", () => {
    sessionStorage.removeItem("admin_session_active");
    localStorage.removeItem("admin_session_active");
    window.history.replaceState(null, "", "/admin");
    showOnly(loginScreen);
});
$("admin-logout-btn")?.addEventListener("click", async (e) => {
    await withButtonSpinner(e.currentTarget, async () => {
        await performIntentionalAdminLogout();
    }, "Logging out...");
});

// ---------------------------------------------------------------------
// Live feed panel & Recent Activity Widget (Modification 9)
// ---------------------------------------------------------------------

function getActivityCategoryMeta(item) {
    const cat = String(item?.category || "").toLowerCase();
    const type = String(item?.type || "").toLowerCase();
    if (cat === "safety" || type.includes("sos") || type.includes("safety")) {
        return { icon: "ti-shield-exclamation", bg: "bg-red-lt text-red", dot: "danger" };
    }
    if (cat === "payment" || type.includes("payment")) {
        return { icon: "ti-credit-card", bg: "bg-teal-lt text-teal", dot: "ok" };
    }
    if (cat === "wallet" || type.includes("wallet") || type.includes("credit")) {
        return { icon: "ti-wallet", bg: "bg-green-lt text-green", dot: "ok" };
    }
    if (cat === "coupon" || type.includes("coupon")) {
        return { icon: "ti-ticket", bg: "bg-purple-lt text-purple", dot: "primary" };
    }
    if (cat === "user" || type.includes("driver_") || type.includes("passenger") || type.includes("registered")) {
        return { icon: "ti-user-check", bg: "bg-azure-lt text-azure", dot: "primary" };
    }
    if (cat === "notification" || type.includes("broadcast")) {
        return { icon: "ti-speakerphone", bg: "bg-indigo-lt text-indigo", dot: "primary" };
    }
    if (cat === "admin" || type.includes("role")) {
        return { icon: "ti-user-shield", bg: "bg-purple-lt text-purple", dot: "primary" };
    }
    if (type.includes("cancelled")) {
        return { icon: "ti-car-off", bg: "bg-red-lt text-red", dot: "danger" };
    }
    if (type.includes("completed")) {
        return { icon: "ti-circle-check", bg: "bg-green-lt text-green", dot: "ok" };
    }
    return { icon: "ti-car", bg: "bg-blue-lt text-blue", dot: "primary" };
}

function getActivityEpochMs(item) {
    if (typeof item?.timestampMs === "number" && Number.isFinite(item.timestampMs) && item.timestampMs > 0) {
        return item.timestampMs;
    }
    const raw = item?.at || item?.createdAt;
    if (!raw) return 0;
    if (typeof raw === "number") return raw > 1e11 ? raw : raw * 1000;
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function sortActivitiesDescending(items) {
    return [...(items || [])].sort((a, b) => getActivityEpochMs(b) - getActivityEpochMs(a));
}

function handleActivityItemClick(item) {
    if (!item) return;
    const tType = String(item.targetType || "").toLowerCase();
    const tId = item.targetId || "";
    if (tType === "ride" && tId && currentAdminRole !== "manager") {
        openRideDrawer({ id: tId });
        return;
    }
    if (tType === "driver" && tId) {
        openDriverDrawer(tId);
        return;
    }
    if (tType === "passenger" && tId && currentAdminRole !== "manager") {
        openPassengerDrawer(tId);
        return;
    }
    if (tType === "sos" && tId) {
        openSosDetailDrawer(tId);
        return;
    }
    if (tType === "safety_report" && tId) {
        openReportDetailDrawer(tId);
        return;
    }
    if (item.section && isSectionAllowed(item.section)) {
        goToSection(item.section);
    }
}

function renderActivityFeedPanelList() {
    const list = $("admin-feed-list");
    if (!list) return;
    const sorted = sortActivitiesDescending(recentActivityItems).slice(0, 30);
    if (!sorted.length) {
        list.innerHTML = `<div class="text-center text-secondary small py-4">No recent activity logged yet.</div>`;
        return;
    }
    list.innerHTML = sorted
        .map((act, idx) => {
            const meta = getActivityCategoryMeta(act);
            const exactTime = formatTimestamp(act.at || act.timestampMs);
            const relTime = formatTimeAgo(act.timestampMs || act.at);
            return `
                <div class="admin-feed-item is-clickable" data-feed-idx="${idx}" title="${escapeAttr(exactTime || relTime)}">
                    <span class="activity-cat-icon ${meta.bg}"><i class="ti ${meta.icon}"></i></span>
                    <div class="flex-fill min-w-0">
                        <div class="text-dark fw-medium small">${escapeHtml(act.text)}</div>
                        <div class="text-secondary" style="font-size: 0.72rem;">${escapeHtml(relTime)}</div>
                    </div>
                </div>
            `;
        })
        .join("");

    list.querySelectorAll("[data-feed-idx]").forEach((el) => {
        el.addEventListener("click", () => {
            const act = sorted[Number(el.dataset.feedIdx)];
            if (act) handleActivityItemClick(act);
        });
    });
}

function onFeedEvent(event) {
    const nowMs = getActivityEpochMs(event) || Date.now();
    const enrichedEvent = {
        ...event,
        at: event.at || new Date(nowMs).toISOString(),
        timestampMs: nowMs,
        color: eventColor(event.type) === "ok" ? "success" : (eventColor(event.type) === "danger" ? "danger" : "primary"),
    };

    // Deduplicate if same text & timestamp within 2 seconds
    const isDuplicate = recentActivityItems.some(
        (existing) => existing.text === enrichedEvent.text && Math.abs(getActivityEpochMs(existing) - nowMs) < 2000
    );
    if (!isDuplicate) {
        recentActivityItems.unshift(enrichedEvent);
        recentActivityItems = sortActivitiesDescending(recentActivityItems).slice(0, 35);
    }

    renderActivityFeedPanelList();
    renderRecentActivityWidget();

    if ($("admin-feed-panel")?.classList.contains("is-open")) return;
    feedUnreadCount += 1;
    const badge = $("admin-feed-badge");
    if (badge) {
        badge.textContent = feedUnreadCount;
        badge.classList.remove("d-none");
    }
}

function eventColor(type) {
    if (!type) return "primary";
    if (type.startsWith("driver_offline") || type.includes("suspended") || type.includes("blocked")) return "warn";
    if (type.includes("cancelled") || type.includes("sos")) return "danger";
    if (type.includes("completed") || type.includes("approved") || type.includes("credit")) return "ok";
    return "primary";
}

$("admin-feed-toggle")?.addEventListener("click", () => {
    const panel = $("admin-feed-panel");
    if (!panel) return;
    panel.classList.toggle("is-open");
    panel.classList.toggle("show");
    if (panel.classList.contains("is-open")) {
        feedUnreadCount = 0;
        $("admin-feed-badge")?.classList.add("d-none");
    }
});
$("admin-feed-close")?.addEventListener("click", () => {
    const panel = $("admin-feed-panel");
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.classList.remove("show");
});

// Sidebar collapse state & toggle button synchronization
function syncSidebarCollapseUI() {
    const sidebar = $("admin-sidebar");
    const toggleBtn = $("admin-sidebar-toggle");
    const collapseBtn = $("admin-sidebar-collapse-btn");
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains("is-collapsed");
    if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        toggleBtn.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
        toggleBtn.innerHTML = isCollapsed
            ? `<i id="admin-sidebar-toggle-icon" class="ti ti-layout-sidebar-left-expand fs-2 text-primary"></i>`
            : `<i id="admin-sidebar-toggle-icon" class="ti ti-layout-sidebar-left-collapse fs-2 text-dark"></i>`;
    }
    if (collapseBtn) {
        const labelSpan = collapseBtn.querySelector(".nav-link-title");
        if (labelSpan) labelSpan.textContent = isCollapsed ? "Expand" : "Collapse";
        collapseBtn.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
    }
}

$("admin-sidebar-collapse-btn")?.addEventListener("click", () => {
    $("admin-sidebar")?.classList.toggle("is-collapsed");
    syncSidebarCollapseUI();
});

// ---------------------------------------------------------------------
// Sidebar navigation, Multi-Page URL Router & Sub-Page Loading Spinners
// ---------------------------------------------------------------------

const loadedSections = new Set();

function setSubpageLoadingState(section, isLoading) {
    const loaderEl = $("admin-subpage-loader");
    const loaderTextEl = $("admin-subpage-loader-text");
    const title = SECTION_TITLES[section] || "Section";
    if (loaderEl && (isLoading || section === currentSection)) {
        if (isLoading && section === currentSection) {
            if (loaderTextEl) loaderTextEl.textContent = `Loading ${title}...`;
            loaderEl.classList.remove("d-none");
        } else if (!isLoading && section === currentSection) {
            loaderEl.classList.add("d-none");
        }
    }

    const navBtn = document.querySelector(`.admin-nav-item[data-section="${section}"]`);
    if (navBtn) {
        const existingSpinner = navBtn.querySelector(".admin-nav-inline-spinner");
        if (isLoading && !existingSpinner) {
            const sp = document.createElement("span");
            sp.className = "spinner-border spinner-border-sm text-primary ms-auto admin-nav-inline-spinner";
            sp.setAttribute("role", "status");
            navBtn.appendChild(sp);
        } else if (!isLoading && existingSpinner) {
            existingSpinner.remove();
        }
    }
}

async function activateAdminSection(name, { updateUrl = true, replaceUrl = false, forceReload = false } = {}) {
    if (!isAdminAuthenticated) {
        redirectToAccessDeniedPage();
        return;
    }

    if (!isSectionAllowed(name)) {
        const msg = `Access Denied: Your ${currentAdminRole.toUpperCase()} role cannot access /admin/${SECTION_TO_SLUG[name] || name}.`;
        toast(msg, "error");
        showSectionRoleDeniedBanner(msg);
        name = "dashboard";
        replaceUrl = true;
    } else {
        $("admin-section-denied-banner")?.classList.add("d-none");
    }

    currentSection = name;
    const pageTitle = SECTION_TITLES[name] || "Dashboard";
    document.title = `${pageTitle} · LiphtUp Admin Console`;
    setActiveAdminSectionBusy(name, pageTitle);

    const canonicalPath = getCanonicalAdminPath(name);
    if (updateUrl && window.location.pathname !== canonicalPath) {
        if (replaceUrl) {
            window.history.replaceState({ section: name }, "", canonicalPath);
        } else {
            window.history.pushState({ section: name }, "", canonicalPath);
        }
    }

    document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("d-none", s.id !== `section-${name}`));

    if (window.innerWidth < 992) {
        $("admin-sidebar")?.classList.remove("is-open");
    }

    if (forceReload) {
        loadedSections.delete(name);
    }

    await loadSection(name);
}

document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0)) return;
        e.preventDefault();
        const targetSection = btn.dataset.section;
        const isSameSection = currentSection === targetSection;
        activateAdminSection(targetSection, { updateUrl: true, replaceUrl: false, forceReload: isSameSection });
    });
});

window.addEventListener("popstate", () => {
    const routeInfo = parseRequestedAdminRoute(window.location.pathname);
    if (!isAdminAuthenticated) {
        if (!routeInfo.isRoot) {
            redirectToAccessDeniedPage();
            return;
        }
        showOnly(loginScreen);
        return;
    }
    if (!routeInfo.isKnown) {
        toast(`Unknown admin page "/admin/${routeInfo.rawSlug}". Redirecting to Dashboard.`, "warning");
        activateAdminSection("dashboard", { updateUrl: true, replaceUrl: true, forceReload: false });
        return;
    }
    activateAdminSection(routeInfo.section, { updateUrl: false, replaceUrl: false, forceReload: false });
});

$("admin-sidebar-toggle")?.addEventListener("click", () => {
    const sidebar = $("admin-sidebar");
    if (!sidebar) return;
    if (window.innerWidth < 992) {
        sidebar.classList.toggle("is-open");
    } else {
        sidebar.classList.toggle("is-collapsed");
        syncSidebarCollapseUI();
    }
});

async function loadSection(name) {
    clearInterval(liveRidesTimer);

    if (!isSectionAllowed(name)) {
        toast(`Access Denied: Your ${currentAdminRole.toUpperCase()} role cannot access this section.`, "error");
        return activateAdminSection("dashboard", { updateUrl: true, replaceUrl: true });
    }

    const title = SECTION_TITLES[name] || "Section";

    if (name === "live-rides") {
        initLiveRidesEvents();
        setSubpageLoadingState(name, true);
        const doneBusy = beginAdminBusy(`Loading ${title}...`, { section: name, isSectionLoad: true });
        try {
            await loadLiveRides();
        } finally {
            doneBusy();
            setSubpageLoadingState(name, false);
        }
        liveRidesTimer = setInterval(loadLiveRides, 60000);
        return;
    }

    if (loadedSections.has(name)) {
        setSubpageLoadingState(name, false);
        return;
    }
    loadedSections.add(name);

    setSubpageLoadingState(name, true);
    const doneBusy = beginAdminBusy(`Loading ${title}...`, { section: name, isSectionLoad: true });
    try {
        if (name === "dashboard") await loadDashboard();
        else if (name === "drivers") await loadDrivers(true);
        else if (name === "payments") await loadAdminPayments();
        else if (name === "wallet-payments") {
            initAdminWalletCredit();
            await loadAdminPassengerWallets();
        }
        else if (name === "coupons") await loadAdminCoupons();
        else if (name === "safety") await loadSafety();
        else if (name === "ride-history") await loadHistory(true);
        else if (name === "passengers") await loadPassengers(true);
        else if (name === "analytics") await loadAnalytics();
        else if (name === "audit-log") await loadAuditLog(true);
        else if (name === "permissions") await loadPermissions();
        else if (name === "reports") await loadAdminReports(true);
        else if (name === "notifications") await loadNotificationsCenter();
    } finally {
        doneBusy();
        setSubpageLoadingState(name, false);
    }
}

function goToSection(name, filters = {}) {
    Object.entries(filters).forEach(([id, value]) => {
        const el = $(id);
        if (el) el.value = value;
    });
    closeDrawer(true);
    activateAdminSection(name, { updateUrl: true, replaceUrl: false, forceReload: true });
}

$("driver-status-filter")?.addEventListener("change", () => loadDrivers(true));
$("passenger-status-filter")?.addEventListener("change", () => loadPassengers(true));
["history-status-filter", "history-vehicle-filter", "history-ridetype-filter", "history-feedback-filter", "history-month-filter"].forEach((id) =>
    $(id)?.addEventListener("change", () => loadHistory(true))
);
$("history-day-filter")?.addEventListener("change", () => loadHistory(true));
$("history-clear-date")?.addEventListener("click", (e) => {
    $("history-month-filter").value = "";
    $("history-day-filter").value = "";
    withButtonSpinner(e.currentTarget, () => loadHistory(true), "Clearing...");
});
$("drivers-pending-chip")?.addEventListener("click", () => {
    $("driver-status-filter").value = "pending_review";
    loadDrivers(true);
});
$("audit-role-filter")?.addEventListener("change", () => loadAuditLog(true));

// ---------------------------------------------------------------------
// Dashboard Helpers & Rendering
// ---------------------------------------------------------------------

function formatTimeAgo(dateInput) {
    if (!dateInput) return "just now";
    try {
        const date = typeof dateInput === "number" ? new Date(dateInput) : new Date(dateInput);
        const now = new Date();
        const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
        if (diffSec < 60) return `${diffSec || 1}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin} min ago`;
        const diffHour = Math.floor(diffMin / 60);
        if (diffHour < 24) return `${diffHour} hr ago`;
        const diffDays = Math.floor(diffHour / 24);
        return `${diffDays} d ago`;
    } catch {
        return "just now";
    }
}

function renderRideActivityChart(activityPayload = {}, timeframe = "today") {
    const canvas = $("ride-activity-chart");
    if (!canvas || !window.Chart) return;
    
    let labels = [];
    let values = [];

    const hourlyData = activityPayload?.hourly || activityPayload || {};
    const daily7d = activityPayload?.daily7d || {};
    const daily30d = activityPayload?.daily30d || {};

    if (timeframe === "today") {
        labels = ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];
        values = labels.map((l) => Number(hourlyData[l] || 0));
    } else if (timeframe === "7d") {
        const keys = Object.keys(daily7d);
        if (keys.length > 0) {
            labels = keys;
            values = keys.map((k) => Number(daily7d[k] || 0));
        } else {
            const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            labels = Array.from({ length: 7 }, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - (6 - i));
                return days[d.getDay()];
            });
            values = [0, 0, 0, 0, 0, 0, 0];
        }
    } else if (timeframe === "30d") {
        const keys = Object.keys(daily30d);
        if (keys.length > 0) {
            labels = keys;
            values = keys.map((k) => Number(daily30d[k] || 0));
        } else {
            labels = Array.from({ length: 7 }, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - (29 - i * 4));
                return d.toISOString().slice(5, 10);
            });
            values = [0, 0, 0, 0, 0, 0, 0];
        }
    }

    if (rideActivityChartInstance) {
        rideActivityChartInstance.destroy();
        rideActivityChartInstance = null;
    }

    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, "rgba(32, 107, 196, 0.22)");
    gradient.addColorStop(1, "rgba(32, 107, 196, 0.01)");

    rideActivityChartInstance = new window.Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: [{
                label: "Rides",
                data: values,
                borderColor: "#206bc4",
                backgroundColor: gradient,
                fill: true,
                tension: 0.4,
                borderWidth: 2.5,
                pointBackgroundColor: "#206bc4",
                pointBorderColor: "#ffffff",
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1e293b",
                    padding: 8,
                    cornerRadius: 6,
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: "#626976", font: { family: "Inter, sans-serif", size: 11 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: "rgba(0, 0, 0, 0.04)" },
                    ticks: { color: "#626976", font: { family: "Inter, sans-serif", size: 11 } }
                }
            }
        }
    });
}

function renderDriverAvailabilityDonut(online = 0, busy = 0, offline = 0) {
    const canvas = $("driver-availability-donut");
    if (!canvas || !window.Chart) return;

    const total = online + busy + offline;
    const availablePct = total ? Math.round((online / total) * 100) : 0;
    const busyPct = total ? Math.round((busy / total) * 100) : 0;
    const offlinePct = total ? Math.max(0, 100 - availablePct - busyPct) : 0;

    const totalEl = $("donut-total-count");
    if (totalEl) totalEl.textContent = total;
    const legAvail = $("donut-legend-available");
    if (legAvail) legAvail.textContent = `${online} (${availablePct}%)`;
    const legBusy = $("donut-legend-busy");
    if (legBusy) legBusy.textContent = `${busy} (${busyPct}%)`;
    const legOffline = $("donut-legend-offline");
    if (legOffline) legOffline.textContent = `${offline} (${offlinePct}%)`;

    const progressLabel = $("donut-progress-label");
    const progressBar = $("donut-progress-bar");
    if (progressLabel) progressLabel.textContent = `${availablePct}% Online`;
    if (progressBar) progressBar.style.width = `${availablePct}%`;

    if (driverDonutChartInstance) {
        driverDonutChartInstance.destroy();
        driverDonutChartInstance = null;
    }

    const ctx = canvas.getContext("2d");
    const chartData = (total === 0)
        ? {
            labels: ["No drivers"],
            datasets: [{
                data: [1],
                backgroundColor: ["#e2e8f0"],
                borderWidth: 0
            }]
        }
        : {
            labels: ["Available", "On ride", "Offline"],
            datasets: [{
                data: [online, busy, offline],
                backgroundColor: ["#2fb344", "#206bc4", "#f59f00"],
                borderWidth: 0,
                hoverOffset: 4
            }]
        };

    driverDonutChartInstance = new window.Chart(ctx, {
        type: "doughnut",
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "75%",
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1e293b",
                    padding: 8,
                    cornerRadius: 6,
                }
            }
        }
    });
}

function formatRidePassengerCell(r) {
    const paxId = String(r?.passenger_id || r?.passengerId || r?.userId || r?.user_id || r?.passenger?.id || "").trim();
    let rawName = String(r?.passenger_name || r?.passengerName || r?.passenger?.name || "").trim();
    const rawPhone = String(r?.passenger_phone || r?.passengerPhone || r?.passenger?.phone || "").trim();
    const invalidNames = new Set(["passenger details unavailable", "unknown", "passenger", "n/a", "--", "—"]);
    if (rawName && (rawName === paxId || rawName === rawPhone || invalidNames.has(rawName.toLowerCase()))) {
        rawName = "";
    }
    const uidSecondary = paxId
        ? `<div class="text-secondary font-monospace" style="font-size:0.7rem;">UID: ${escapeHtml(paxId.slice(0, 12))}</div>`
        : "";
    if (rawName) {
        return `<div>
            <div class="fw-semibold text-dark">${escapeHtml(rawName)}</div>
            ${rawPhone ? `<div class="text-secondary small">${escapeHtml(rawPhone)}</div>` : uidSecondary}
        </div>`;
    }
    if (rawPhone) {
        return `<div>
            <div class="fw-semibold text-dark">${escapeHtml(rawPhone)}</div>
            <div class="text-muted small fst-italic">Passenger details unavailable</div>
            ${uidSecondary}
        </div>`;
    }
    return `<div>
        <div class="text-muted fst-italic">Passenger details unavailable</div>
        ${uidSecondary}
    </div>`;
}

function formatRideDriverCell(r) {
    const driverId = String(r?.driver_id || r?.driverId || r?.assignedDriverId || r?.assigned_driver_id || r?.driver?.id || "").trim();
    let rawName = String(r?.driver_name || r?.driverName || r?.driver?.name || "").trim();
    const assignStatus = String(r?.driver_assignment_status || "").toLowerCase();
    const vehicleType = String(r?.vehicle_type || r?.vehicleType || r?.driver?.vehicleType || "").trim().toUpperCase();
    const vehicleNumber = String(r?.vehicle_number || r?.vehicleNumber || r?.driver?.plate || "").trim();
    const vehicleInfo = [vehicleType, vehicleNumber].filter(Boolean).join(" • ");
    const invalidDriverNames = new Set(["unassigned", "unassigned driver", "driver details unavailable", "unknown", "driver", "n/a", "--", "—"]);
    if (rawName && (rawName === driverId || invalidDriverNames.has(rawName.toLowerCase()))) {
        rawName = "";
    }

    if (rawName) {
        return `<div>
            <div class="fw-semibold text-dark">${escapeHtml(rawName)}</div>
            ${vehicleInfo ? `<div class="text-secondary small">${escapeHtml(vehicleInfo)}</div>` : ""}
        </div>`;
    }
    if (driverId || assignStatus === "unavailable" || String(r?.driver_name || "") === "Driver details unavailable") {
        return `<div>
            <div class="text-muted fst-italic">Driver details unavailable</div>
            ${vehicleInfo ? `<div class="text-secondary small">${escapeHtml(vehicleInfo)}</div>` : ""}
        </div>`;
    }
    return `<span class="badge bg-secondary-lt text-secondary">Unassigned</span>`;
}

function renderRecentActivityWidget() {
    const list = $("dashboard-recent-activity-list");
    if (!list) return;

    const sorted = sortActivitiesDescending(recentActivityItems).slice(0, 8);
    if (sorted.length === 0) {
        list.innerHTML = `<div class="text-center text-secondary small py-4">No recent activity logged yet today.</div>`;
        return;
    }

    list.innerHTML = sorted
        .map((item, idx) => {
            const meta = getActivityCategoryMeta(item);
            const exactTime = formatTimestamp(item.at || item.timestampMs);
            const relTime = formatTimeAgo(item.timestampMs || item.at);
            return `
                <div class="recent-act-item is-clickable" data-recent-act-idx="${idx}" title="${escapeAttr(exactTime || relTime)}">
                    <div class="d-flex align-items-center gap-2 overflow-hidden">
                        <span class="activity-cat-icon ${meta.bg}"><i class="ti ${meta.icon}"></i></span>
                        <span class="recent-act-title text-truncate">${escapeHtml(item.text)}</span>
                    </div>
                    <span class="recent-act-time">${escapeHtml(relTime)}</span>
                </div>
            `;
        })
        .join("");

    list.querySelectorAll("[data-recent-act-idx]").forEach((el) => {
        el.addEventListener("click", () => {
            const item = sorted[Number(el.dataset.recentActIdx)];
            if (item) handleActivityItemClick(item);
        });
    });
}

function renderRecentRidesTable(rides = []) {
    const tbody = $("dashboard-recent-rides-tbody");
    if (!tbody) return;

    if (!rides || rides.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-secondary small">No recent rides found.</td></tr>`;
        return;
    }

    tbody.innerHTML = rides.slice(0, 6).map((r) => {
        const idShort = `#LP${String(r.id || "").slice(-5).toUpperCase()}`;
        const passengerCell = formatRidePassengerCell(r);
        const driverCell = formatRideDriverCell(r);
        const fare = `₹${r.fare || 0}`;
        const distance = `${r.estimated_distance_km || r.distance_km || 0} km`;
        const timeAgo = formatTimeAgo(r.createdAt || r.updatedAt);
        
        let statusBadge = `<span class="badge bg-secondary-lt text-secondary">Pending</span>`;
        const s = String(r.status || "").toLowerCase();
        if (s === "completed") {
            statusBadge = `<span class="badge bg-green-lt text-green">Completed</span>`;
        } else if (s === "accepted" || s === "arrived" || s === "started" || s === "en_route") {
            statusBadge = `<span class="badge bg-warning-lt text-warning">Ongoing</span>`;
        } else if (s === "searching" || s === "pending") {
            statusBadge = `<span class="badge bg-blue-lt text-blue">Searching</span>`;
        } else if (s.startsWith("cancelled")) {
            statusBadge = `<span class="badge bg-red-lt text-red">Cancelled</span>`;
        }

        return `
            <tr class="admin-clickable-row" tabindex="0" role="button" data-recent-ride-id="${escapeHtml(r.id)}">
                <td class="fw-bold text-dark">${idShort}</td>
                <td>${passengerCell}</td>
                <td>${driverCell}</td>
                <td class="fw-bold text-dark">${fare}</td>
                <td>${distance}</td>
                <td>${statusBadge}</td>
                <td class="text-secondary small">${timeAgo}</td>
                <td class="text-end dt-row-chevron-cell">
                    <span class="dt-row-action-indicator" title="View ride details">
                        <i class="ti ti-chevron-right"></i>
                    </span>
                </td>
            </tr>
        `;
    }).join("");

    tbody.querySelectorAll("[data-recent-ride-id]").forEach((tr) => {
        const openRow = () => {
            const rideId = tr.dataset.recentRideId;
            const found = rides.find((r) => r.id === rideId);
            if (found) openRideDrawer(found);
        };
        tr.addEventListener("click", openRow);
        tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openRow();
            }
        });
    });
}

function openAttentionDrawer(data) {
    const pendingDrivers = Number(data?.attention?.pendingDrivers ?? data?.drivers?.pendingApproval ?? 0);
    const pendingPayments = Number(data?.attention?.pendingPayments ?? 0);
    const openSos = Number(data?.attention?.openSosAlerts ?? data?.safety?.openSosAlerts ?? 0);
    const openReports = Number(data?.attention?.openSafetyReports ?? data?.safety?.openSafetyReports ?? 0);
    const total = pendingDrivers + pendingPayments + openSos + openReports;

    if (total === 0) {
        showReadOnlyDrawer("Your Attention Required", `<div class="text-center py-5 text-secondary"><i class="ti ti-circle-check fs-1 text-success mb-2 d-block"></i>All clear! No items currently require attention.</div>`);
        return;
    }

    let itemsHtml = "";
    if (pendingDrivers > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-user-check text-primary me-1"></i> Driver Approvals</div>
                        <div class="text-secondary small">${pendingDrivers} driver application(s) awaiting verification</div>
                    </div>
                    <button class="btn btn-sm btn-primary rounded-pill px-3" id="drawer-att-drivers-btn">Review</button>
                </div>
            </div>`;
    }

    if (pendingPayments > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-credit-card-off text-warning me-1"></i> Payment Approvals</div>
                        <div class="text-secondary small">${pendingPayments} driver payment submission(s) to verify</div>
                    </div>
                    <button class="btn btn-sm btn-warning text-dark rounded-pill px-3" id="drawer-att-payments-btn">Review</button>
                </div>
            </div>`;
    }

    if (openSos > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-danger fs-4"><i class="ti ti-shield-x text-danger me-1"></i> SOS Alerts</div>
                        <div class="text-secondary small">${openSos} open SOS emergency alert(s)</div>
                    </div>
                    <button class="btn btn-sm btn-danger rounded-pill px-3" id="drawer-att-sos-btn">Safety Center</button>
                </div>
            </div>`;
    }

    if (openReports > 0) {
        itemsHtml += `
            <div class="card card-sm mb-2 border-0 shadow-xs">
                <div class="card-body d-flex align-items-center justify-content-between">
                    <div>
                        <div class="fw-bold text-dark fs-4"><i class="ti ti-alert-circle text-orange me-1"></i> Safety Reports</div>
                        <div class="text-secondary small">${openReports} passenger/driver safety report(s)</div>
                    </div>
                    <button class="btn btn-sm btn-outline-danger rounded-pill px-3" id="drawer-att-reports-btn">Safety Center</button>
                </div>
            </div>`;
    }

    const html = `<div class="p-2">${itemsHtml}</div>`;
    const { bodyEl } = showReadOnlyDrawer("Actions Requiring Attention", html);
    bodyEl.querySelector("#drawer-att-drivers-btn")?.addEventListener("click", () => goToSection("drivers", { "driver-status-filter": "pending_review" }));
    bodyEl.querySelector("#drawer-att-payments-btn")?.addEventListener("click", () => goToSection("payments"));
    bodyEl.querySelector("#drawer-att-sos-btn")?.addEventListener("click", () => goToSection("safety"));
    bodyEl.querySelector("#drawer-att-reports-btn")?.addEventListener("click", () => goToSection("safety"));
}

function setDashboardLoadingSpinners() {
    // 1. Attention card hidden while loading
    $("dashboard-attention-card")?.classList.add("d-none");

    const spinner = `<span class="spinner-border spinner-border-sm text-primary" role="status"></span>`;
    const subSpinner = `<span class="spinner-border spinner-border-sm text-secondary" style="width: 0.85rem; height: 0.85rem;" role="status"></span>`;

    // 2. Rides Today Card
    if ($("kpi-rides-today-value")) $("kpi-rides-today-value").innerHTML = spinner;
    if ($("kpi-rides-today-delta")) $("kpi-rides-today-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-rides-completed")) $("kpi-rides-completed").innerHTML = subSpinner;
    if ($("kpi-rides-cancelled")) $("kpi-rides-cancelled").innerHTML = subSpinner;
    if ($("kpi-rides-ongoing")) $("kpi-rides-ongoing").innerHTML = subSpinner;

    // 3. Active Users Card
    if ($("kpi-active-users-value")) $("kpi-active-users-value").innerHTML = spinner;
    if ($("kpi-active-users-delta")) $("kpi-active-users-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-active-passengers")) $("kpi-active-passengers").innerHTML = subSpinner;
    if ($("kpi-active-drivers")) $("kpi-active-drivers").innerHTML = subSpinner;

    // 4. Driver Availability Card & Today Bike/Auto Rides
    if ($("kpi-driver-availability-value")) $("kpi-driver-availability-value").innerHTML = spinner;
    if ($("kpi-driver-availability-delta")) $("kpi-driver-availability-delta").innerHTML = `<span class="text-secondary small">Loading...</span>`;
    if ($("kpi-drivers-online")) $("kpi-drivers-online").innerHTML = subSpinner;
    if ($("kpi-drivers-busy")) $("kpi-drivers-busy").innerHTML = subSpinner;
    if ($("kpi-drivers-offline")) $("kpi-drivers-offline").innerHTML = subSpinner;
    if ($("kpi-today-auto-rides")) $("kpi-today-auto-rides").innerHTML = subSpinner;
    if ($("kpi-today-bike-rides")) $("kpi-today-bike-rides").innerHTML = subSpinner;

    // 5. Driver Donut Stats
    if ($("donut-total-count")) $("donut-total-count").innerHTML = subSpinner;
    if ($("donut-legend-available")) $("donut-legend-available").innerHTML = subSpinner;
    if ($("donut-legend-busy")) $("donut-legend-busy").innerHTML = subSpinner;
    if ($("donut-legend-offline")) $("donut-legend-offline").innerHTML = subSpinner;
    if ($("donut-progress-label")) $("donut-progress-label").innerHTML = `<span class="text-secondary small">Loading...</span>`;

    // 6. Recent Activity Feed
    if ($("dashboard-recent-activity-list")) {
        $("dashboard-recent-activity-list").innerHTML = `
            <div class="text-center py-4 text-secondary">
                <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
                <div class="small">Loading activity...</div>
            </div>`;
    }

    // 7. User Growth Stats
    if ($("growth-today-val")) $("growth-today-val").innerHTML = spinner;
    if ($("growth-week-val")) $("growth-week-val").innerHTML = spinner;
    if ($("growth-month-val")) $("growth-month-val").innerHTML = spinner;
    if ($("growth-passengers-count")) $("growth-passengers-count").innerHTML = subSpinner;
    if ($("growth-drivers-count")) $("growth-drivers-count").innerHTML = subSpinner;

    // 8. Recent Rides Table
    if ($("dashboard-recent-rides-tbody")) {
        $("dashboard-recent-rides-tbody").innerHTML = `
            <tr>
                <td colspan="8" class="text-center py-5 text-secondary">
                    <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
                    <span>Loading recent rides...</span>
                </td>
            </tr>`;
    }
}

async function loadDashboard() {
    // 1. Dynamic Date Display
    const dateEl = $("dashboard-date-badge");
    if (dateEl) {
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
        dateEl.textContent = dateStr;
    }

    // Show initial loading spinners across all sections
    setDashboardLoadingSpinners();

    try {
        const data = await adminGet("/overview", {}, { cacheable: false });
        dashboardOverviewData = data;

        // 2. Attention Required Banner - Only show items with count >= 1; hide completely if all 0
        const pendingDrivers = Number(data.attention?.pendingDrivers ?? data.drivers?.pendingApproval ?? 0);
        const pendingPayments = Number(data.attention?.pendingPayments ?? 0);
        const openSos = Number(data.attention?.openSosAlerts ?? data.safety?.openSosAlerts ?? 0);
        const openReports = Number(data.attention?.openSafetyReports ?? data.safety?.openSafetyReports ?? 0);
        const totalAttention = pendingDrivers + pendingPayments + openSos + openReports;

        const attCard = $("dashboard-attention-card");
        if (totalAttention === 0) {
            if (attCard) {
                attCard.classList.add("d-none");
                attCard.style.display = "none";
            }
        } else {
            if (attCard) {
                attCard.classList.remove("d-none");
                attCard.style.display = "block";
            }

            // Driver Approvals
            const btnDrivers = $("att-drivers-btn");
            if (btnDrivers) {
                if (pendingDrivers > 0) {
                    btnDrivers.classList.remove("d-none");
                    btnDrivers.classList.add("d-inline-flex");
                    const c = $("att-drivers-count");
                    const b = $("att-drivers-badge");
                    if (c) c.textContent = pendingDrivers;
                    if (b) b.textContent = pendingDrivers;
                } else {
                    btnDrivers.classList.add("d-none");
                    btnDrivers.classList.remove("d-inline-flex");
                }
            }

            // Payment Approvals
            const btnPayments = $("att-payments-btn");
            if (btnPayments) {
                if (pendingPayments > 0) {
                    btnPayments.classList.remove("d-none");
                    btnPayments.classList.add("d-inline-flex");
                    const c = $("att-payments-count");
                    const b = $("att-payments-badge");
                    if (c) c.textContent = pendingPayments;
                    if (b) b.textContent = pendingPayments;
                } else {
                    btnPayments.classList.add("d-none");
                    btnPayments.classList.remove("d-inline-flex");
                }
            }

            // SOS Alerts
            const btnSos = $("att-sos-btn");
            if (btnSos) {
                if (openSos > 0) {
                    btnSos.classList.remove("d-none");
                    btnSos.classList.add("d-inline-flex");
                    const c = $("att-sos-count");
                    const b = $("att-sos-badge");
                    if (c) c.textContent = openSos;
                    if (b) b.textContent = openSos;
                } else {
                    btnSos.classList.add("d-none");
                    btnSos.classList.remove("d-inline-flex");
                }
            }

            // Safety Reports
            const btnSafety = $("att-safety-btn");
            if (btnSafety) {
                if (openReports > 0) {
                    btnSafety.classList.remove("d-none");
                    btnSafety.classList.add("d-inline-flex");
                    const c = $("att-safety-count");
                    const b = $("att-safety-badge");
                    if (c) c.textContent = openReports;
                    if (b) b.textContent = openReports;
                } else {
                    btnSafety.classList.add("d-none");
                    btnSafety.classList.remove("d-inline-flex");
                }
            }
        }

        // Wire attention banner buttons (idempotent onclick assignment)
        if ($("att-drivers-btn")) $("att-drivers-btn").onclick = () => goToSection("drivers", { "driver-status-filter": "pending_review" });
        if ($("att-payments-btn")) $("att-payments-btn").onclick = () => goToSection("payments");
        if ($("att-sos-btn")) $("att-sos-btn").onclick = () => goToSection("safety");
        if ($("att-safety-btn")) $("att-safety-btn").onclick = () => goToSection("safety");
        if ($("btn-attention-view-all")) $("btn-attention-view-all").onclick = () => openAttentionDrawer(data);

        // 3. First Row: 3 KPI Cards
        // Card 1: Rides Today
        const ridesTodayVal = $("kpi-rides-today-value");
        const ridesTodayDelta = $("kpi-rides-today-delta");
        const ridesComp = $("kpi-rides-completed");
        const ridesCanc = $("kpi-rides-cancelled");
        const ridesOngo = $("kpi-rides-ongoing");

        const ridesDeltaVal = Number(data.today?.vsYesterdayPercent ?? 0);
        const ridesDeltaArrow = ridesDeltaVal >= 0 ? "ti-arrow-up-right" : "ti-arrow-down-right";
        if (ridesTodayVal) ridesTodayVal.textContent = data.today?.totalRides ?? 0;
        if (ridesTodayDelta) ridesTodayDelta.innerHTML = `<i class="ti ${ridesDeltaArrow} me-1"></i>${ridesDeltaVal}% vs yesterday`;
        if (ridesComp) ridesComp.textContent = data.today?.completedRides ?? 0;
        if (ridesCanc) ridesCanc.textContent = data.today?.cancelledRides ?? 0;
        if (ridesOngo) ridesOngo.textContent = data.today?.activeRides ?? 0;

        // Card 2: Active Users
        const activeUsersVal = $("kpi-active-users-value");
        const activeUsersDelta = $("kpi-active-users-delta");
        const activePass = $("kpi-active-passengers");
        const activeDriv = $("kpi-active-drivers");

        const usersDeltaVal = Number(data.activeUsers?.vsYesterdayPercent ?? 0);
        const usersDeltaArrow = usersDeltaVal >= 0 ? "ti-arrow-up-right" : "ti-arrow-down-right";
        if (activeUsersVal) activeUsersVal.textContent = data.activeUsers?.total ?? ((data.drivers?.activeOnline || 0) + (data.today?.activeRides || 0));
        if (activeUsersDelta) activeUsersDelta.innerHTML = `<i class="ti ${usersDeltaArrow} me-1"></i>${usersDeltaVal}% vs yesterday`;
        if (activePass) activePass.textContent = data.activeUsers?.passengers ?? (data.passengers?.newRegistrationsToday || 0);
        if (activeDriv) activeDriv.textContent = data.activeUsers?.drivers ?? ((data.drivers?.activeOnline || 0) + (data.drivers?.busy || 0));

        // Card 3: Driver Availability
        const driverAvailVal = $("kpi-driver-availability-value");
        const driverAvailDelta = $("kpi-driver-availability-delta");
        const driversOnline = $("kpi-drivers-online");
        const driversBusy = $("kpi-drivers-busy");
        const driversOffline = $("kpi-drivers-offline");

        const onlineCount = data.drivers?.activeOnline ?? 0;
        const busyCount = data.drivers?.busy ?? 0;
        const totalDrivers = data.drivers?.total ?? (onlineCount + busyCount);
        const offlineCount = data.drivers?.offline ?? Math.max(0, totalDrivers - onlineCount - busyCount);
        const onlinePct = totalDrivers ? Math.round((onlineCount / totalDrivers) * 100) : 0;

        if (driverAvailVal) driverAvailVal.textContent = `${onlineCount} / ${totalDrivers}`;
        if (driverAvailDelta) driverAvailDelta.textContent = `${onlinePct}% online`;
        if (driversOnline) driversOnline.textContent = onlineCount;
        if (driversBusy) driversBusy.textContent = busyCount;
        if (driversOffline) driversOffline.textContent = offlineCount;

        // Bind Bike & Auto Rides Today + Pool Utilization KPI Cards
        const todayAutoEl = $("kpi-today-auto-rides");
        const todayBikeEl = $("kpi-today-bike-rides");
        const shareRidesVal = $("kpi-share-rides-value");
        const shareAvgVal = $("kpi-share-avg-riders-value");
        if (todayAutoEl) todayAutoEl.textContent = data.today?.autoRides ?? data.todayVehicleSplit?.auto ?? 0;
        if (todayBikeEl) todayBikeEl.textContent = data.today?.bikeRides ?? data.todayVehicleSplit?.bike ?? 0;
        if (shareRidesVal) shareRidesVal.textContent = data.share?.totalShareRides ?? 0;
        if (shareAvgVal) shareAvgVal.textContent = Number(data.share?.avgRidersPerShareTrip ?? 0).toFixed(1);

        const navPayBadge = $("admin-payments-nav-badge");
        if (navPayBadge) {
            navPayBadge.textContent = pendingPayments > 0 ? `${pendingPayments}` : "0";
            navPayBadge.classList.toggle("d-none", pendingPayments === 0);
        }

        // 4. Second Row Charts
        renderRideActivityChart(data.rideActivity || {}, currentChartTimeframe);
        renderDriverAvailabilityDonut(onlineCount, busyCount, offlineCount);

        // Chart Range Toggles
        const btnToday = $("btn-chart-today");
        const btn7d = $("btn-chart-7d");
        const btn30d = $("btn-chart-30d");
        const rangeLabel = $("ride-activity-range-label");

        if (btnToday) {
            btnToday.onclick = () => {
                currentChartTimeframe = "today";
                btnToday.className = "btn btn-primary active";
                if (btn7d) btn7d.className = "btn btn-outline-secondary";
                if (btn30d) btn30d.className = "btn btn-outline-secondary";
                if (rangeLabel) rangeLabel.textContent = "(Today)";
                renderRideActivityChart(dashboardOverviewData?.rideActivity || {}, "today");
            };
        }

        if (btn7d) {
            btn7d.onclick = () => {
                currentChartTimeframe = "7d";
                if (btnToday) btnToday.className = "btn btn-outline-secondary";
                btn7d.className = "btn btn-primary active";
                if (btn30d) btn30d.className = "btn btn-outline-secondary";
                if (rangeLabel) rangeLabel.textContent = "(7 days)";
                renderRideActivityChart(dashboardOverviewData?.rideActivity || {}, "7d");
            };
        }

        if (btn30d) {
            btn30d.onclick = () => {
                currentChartTimeframe = "30d";
                if (btnToday) btnToday.className = "btn btn-outline-secondary";
                if (btn7d) btn7d.className = "btn btn-outline-secondary";
                btn30d.className = "btn btn-primary active";
                if (rangeLabel) rangeLabel.textContent = "(30 days)";
                renderRideActivityChart(dashboardOverviewData?.rideActivity || {}, "30d");
            };
        }

        // 5. Recent Activity Feed - use real data from server API (sorted strictly descending by UTC timestamp)
        const incomingActivities = Array.isArray(data.recentActivity)
            ? data.recentActivity
            : (Array.isArray(data.activities) ? data.activities : []);
        recentActivityItems = sortActivitiesDescending(incomingActivities).slice(0, 35);
        renderRecentActivityWidget();
        renderActivityFeedPanelList();

        if ($("btn-recent-act-view-all")) {
            $("btn-recent-act-view-all").onclick = () => {
                $("admin-feed-toggle")?.click();
            };
        }

        // 6. User Growth Section
        const growthToday = $("growth-today-val");
        const growthWeek = $("growth-week-val");
        const growthMonth = $("growth-month-val");
        const growthPass = $("growth-passengers-count");
        const growthDriv = $("growth-drivers-count");

        if (growthToday) growthToday.textContent = `+${data.userGrowth?.today ?? data.today?.newUsersToday ?? 0}`;
        if (growthWeek) growthWeek.textContent = `+${data.userGrowth?.thisWeek ?? 0}`;
        if (growthMonth) growthMonth.textContent = `+${data.userGrowth?.thisMonth ?? 0}`;
        if (growthPass) growthPass.textContent = data.userGrowth?.passengers ?? data.passengers?.total ?? 0;
        if (growthDriv) growthDriv.textContent = data.userGrowth?.drivers ?? data.drivers?.total ?? 0;

        if ($("btn-user-growth-view-all")) {
            $("btn-user-growth-view-all").onclick = () => goToSection("passengers");
        }

        // 7. Recent Rides Table
        renderRecentRidesTable(data.recentRides || []);
        if ($("btn-recent-rides-view-all")) {
            $("btn-recent-rides-view-all").onclick = () => goToSection("ride-history");
        }

    } catch (error) {
        toast(`Error loading dashboard: ${error.message}`, "error");
    }
}

function openHealthDrawer(health) {
    const notes = health?.notes || [];
    showReadOnlyDrawer(
        "System Health",
        `${detailRow("Status", health?.status || "unknown")}
         ${detailRow("Last admin action", formatTimestamp(health?.lastAdminActionAt))}
         <h4 class="admin-drawer-subsection">Notes</h4>
         ${notes.length ? notes.map((n) => `<p class="admin-detail-row"><span>${escapeHtml(n)}</span></p>`).join("") : `<p class="text-secondary text-center py-3">Nothing needs attention.</p>`}`
    );
}

function summaryTable(rows, columns, emptyText) {
    if (!rows.length) return `<p class="text-secondary text-center py-4 my-0">${emptyText}</p>`;
    return `
        <div class="card border-0 shadow-xs mb-2">
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-striped table-hover m-0">
                    <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
                    <tbody>${rows.map((r) => `<tr class="dt-clickable-row" data-row-open>${columns.map((c) => `<td>${c.render(r)}</td>`).join("")}</tr>`).join("")}</tbody>
                </table>
            </div>
        </div>`;
}

async function openRidesDrillDown(title, { status, dateFrom, dateTo }) {
    if (currentAdminRole === "manager") {
        return toast("Access Denied: Ride details are restricted for Manager role.", "error");
    }
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading rides...</div></div>`);
    try {
        const data = await adminGet("/rides/history", { status, dateFrom, dateTo, limit: 50 });
        const html = summaryTable(
            data.rides,
            [
                { label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
                { label: "Driver", render: (r) => escapeHtml(r.driver_name || "Unassigned") },
                { label: "Status", render: (r) => statusChip(r.status) },
                { label: "Fare", render: (r) => `Rs ${r.fare || 0}` },
            ],
            "No rides match this yet."
        );
        const { bodyEl } = showReadOnlyDrawer(title, `${html}
            <button type="button" class="btn btn-outline-secondary w-100 mt-3" id="drill-view-all"><i class="ti ti-history me-1"></i>View all in Ride History</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(data.rides[i])));
        document.getElementById("drill-view-all").addEventListener("click", () =>
            goToSection("ride-history", { "history-status-filter": status === "all" || status === "cancelled" || status === "active" ? "" : status })
        );
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

async function openDriversDrillDown(title, { availability, status } = {}) {
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading drivers...</div></div>`);
    try {
        const data = await adminGet("/drivers", { availability, status, limit: 50 });
        const html = summaryTable(
            data.drivers,
            [
                { label: "Name", render: (r) => escapeHtml(r.name || "Unnamed") },
                { label: "Phone", render: (r) => escapeHtml(r.phone || "") },
                { label: "Status", render: (r) => statusChip(r.verificationStatus) },
                { label: "Availability", render: (r) => escapeHtml(r.driverAvailability || "") },
            ],
            "No drivers match this yet."
        );
        const { bodyEl } = showReadOnlyDrawer(title, html);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openDriverDrawer(data.drivers[i].uid)));
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

async function openLiveDrillDown(title, { passengersOnly = false } = {}) {
    if (currentAdminRole === "manager") {
        return toast("Access Denied: Live rides view is restricted for Manager role.", "error");
    }
    showReadOnlyDrawer(title, `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading live rides...</div></div>`);
    try {
        const data = await adminGet("/rides/live");
        let rows = data.rides;
        if (passengersOnly) {
            const seen = new Set();
            rows = rows.filter((r) => {
                if (!r.passenger_id || seen.has(r.passenger_id)) return false;
                seen.add(r.passenger_id);
                return true;
            });
        }
        const html = summaryTable(
            rows,
            [
                { label: "Route", render: (r) => `${escapeHtml(r.pickup_name || "")} \u2192 ${escapeHtml(r.drop_name || "")}` },
                { label: "Driver", render: (r) => escapeHtml(r.driver_name || "Unassigned") },
                { label: "Status", render: (r) => statusChip(r.status) },
            ],
            "Nothing active right now."
        );
        const { bodyEl } = showReadOnlyDrawer(title, `${html}
            <button type="button" class="btn btn-outline-secondary w-100 mt-3" id="drill-view-live"><i class="ti ti-car-side me-1"></i>View all in Live Rides</button>`);
        bodyEl.querySelectorAll("[data-row-open]").forEach((tr, i) => tr.addEventListener("click", () => openRideDrawer(rows[i])));
        document.getElementById("drill-view-live").addEventListener("click", () => goToSection("live-rides"));
    } catch (error) {
        showReadOnlyDrawer(title, `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

// ---------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------

function ensureDriversTable() {
    if (driversTable) return driversTable;
    driversTable = new DataTable({
        container: $("drivers-table-wrap"),
        exportFileName: "liphtup-drivers",
        searchPlaceholder: "Search drivers by name, phone, email, or vehicle...",
        getRowId: (r) => r.uid,
        onRowClick: (r) => openDriverDrawer(r.uid),
        onLoadMore: () => loadDrivers(false),
        onSearch: (q) => {
            driversSearchQuery = q;
            loadDrivers(true);
        },
        bulkActions: [
            { label: "Approve selected", onClick: (ids) => bulkDriverAction(ids, "approve") },
            { label: "Suspend selected", onClick: (ids) => bulkDriverAction(ids, "suspend") },
        ],
        columns: [
            { key: "name", label: "Name", sortable: true },
            { key: "phone", label: "Phone", sortable: true },
            { key: "vehicleNumber", label: "Vehicle", sortable: true, render: (r) => `${(r.vehicleType || "").toUpperCase()} ${r.vehicleNumber || ""}` },
            { key: "verificationStatus", label: "Status", sortable: true, render: (r) => statusChip(r.verificationStatus) },
            { key: "driverAvailability", label: "Availability", sortable: true },
            { key: "totalCompletedTrips", label: "Trips", sortable: true },
        ],
    });
    return driversTable;
}

async function bulkDriverAction(ids, action) {
    let notes = "";
    if (action === "reject") {
        const reason = await showTablerPrompt({
            title: `Reject ${ids.length} Selected Drivers`,
            message: "Enter rejection reason for the selected drivers:",
            placeholder: "e.g. Documents failed verification",
            defaultValue: "Application requirements were not met.",
            required: true,
            variant: "danger",
            confirmText: "Reject Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else if (action === "suspend") {
        const reason = await showTablerPrompt({
            title: `Suspend ${ids.length} Selected Drivers`,
            message: "Enter reason for suspension (optional):",
            placeholder: "Enter reason...",
            defaultValue: "",
            required: false,
            variant: "warning",
            confirmText: "Suspend Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else if (action === "block") {
        const reason = await showTablerPrompt({
            title: `Block ${ids.length} Selected Drivers`,
            message: "Enter reason for blocking (optional):",
            placeholder: "Enter reason...",
            defaultValue: "",
            required: false,
            variant: "danger",
            confirmText: "Block Selected"
        });
        if (reason === null) return;
        notes = reason;
    } else {
        const confirmed = await showTablerConfirm(`Are you sure you want to ${action} ${ids.length} selected driver(s)?`, {
            title: `${action.toUpperCase()} Drivers`,
            variant: action === "approve" ? "success" : "primary",
            confirmText: `${action.charAt(0).toUpperCase() + action.slice(1)} Drivers`
        });
        if (!confirmed) return;
    }

    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/drivers/${uid}`, { action, notes, fields: { rejectionReason: notes, suspensionReason: notes, blockingReason: notes } });
            ok += 1;
        } catch (error) {
            /* continue */
        }
    }
    toast(`${action} applied to ${ok}/${ids.length} drivers.`);
    loadDrivers(true);
}

async function loadDrivers(reset) {
    if (reset) cursors.drivers = null;
    const status = $("driver-status-filter")?.value || "";
    const table = ensureDriversTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/drivers", {
            status,
            q: driversSearchQuery || undefined,
            cursor: reset ? null : cursors.drivers,
        });
        cursors.drivers = data.nextCursor;
        table.setRows(data.drivers, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

function renderDriverRatingHtml(ratingSummary) {
    if (!ratingSummary || !ratingSummary.totalFeedbackCount) {
        return `<span class="text-secondary">No passenger ratings yet</span>`;
    }
    const avg = Number(ratingSummary.averageRating || 0).toFixed(2);
    const total = ratingSummary.totalFeedbackCount;
    const bd = ratingSummary.breakdown || {};
    const topReasons = (ratingSummary.topReasons || [])
        .map((r) => `<span class="badge bg-azure-lt text-azure me-1 mb-1">${escapeHtml(String(r.reason || "").replace(/_/g, " "))} (${r.count})</span>`)
        .join("");
    return `
        <div>
            <div class="d-flex align-items-center gap-2">
                <span class="badge bg-yellow-lt text-yellow fw-bold"><i class="ti ti-star-filled me-1"></i>${avg} / 5.0</span>
                <span class="text-secondary small">(${total} feedback${total === 1 ? "" : "s"})</span>
            </div>
            <div class="text-secondary small mt-1">
                Loved: <strong>${bd.loved || 0}</strong> &bull;
                Good: <strong>${bd.good || 0}</strong> &bull;
                Decent: <strong>${bd.decent || 0}</strong> &bull;
                Poor: <strong class="text-danger">${bd.poor || 0}</strong>
            </div>
            ${topReasons ? `<div class="mt-1">${topReasons}</div>` : ""}
        </div>
    `;
}

function renderKycDocumentsSection(d) {
    const docItems = [
        { label: "Driving License Photo", url: d.licensePhotoUrl },
        { label: "Vehicle RC Document", url: d.rcPhotoUrl },
        { label: "Aadhaar / ID Proof", url: d.aadhaarUrl },
        { label: "Vehicle Photo", url: d.vehiclePhotoUrl },
    ];
    if (d.kycDocuments && typeof d.kycDocuments === "object") {
        Object.entries(d.kycDocuments).forEach(([k, v]) => {
            if (typeof v === "string" && v.trim()) {
                docItems.push({ label: k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim(), url: v });
            }
        });
    }
    const availableDocs = docItems.filter((item) => item.url);
    const docsLinksHtml = availableDocs.length
        ? `<div class="d-flex flex-wrap gap-2 mt-1">${availableDocs
              .map(
                  (doc) => `<a href="${escapeAttr(doc.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline-primary">
                      <i class="ti ti-file-certificate me-1"></i>${escapeHtml(doc.label)}
                  </a>`
              )
              .join("")}</div>`
        : `<div class="text-secondary small py-1">No uploaded document URLs on file.</div>`;

    return `
        <details class="admin-collapsible mb-3" open>
            <summary class="admin-collapsible-summary">
                <span><i class="ti ti-id-badge-2 me-2 text-primary"></i>KYC &amp; Vehicle Verification</span>
                <i class="ti ti-chevron-down admin-collapsible-chevron"></i>
            </summary>
            <div class="admin-collapsible-body">
                <div class="admin-detail-grid p-0">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Driving License #</span>
                        <strong class="admin-detail-value">${escapeHtml(d.drivingLicenseNumber || "Not recorded")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Vehicle Type &amp; Model</span>
                        <strong class="admin-detail-value">${escapeHtml((d.vehicleType || "auto").toUpperCase())} &mdash; ${escapeHtml(d.vehicleModel || "Not specified")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Registration Plate</span>
                        <strong class="admin-detail-value">${escapeHtml(d.vehicleNumber || "Not recorded")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">UPI ID</span>
                        <span class="admin-detail-value">${escapeHtml(d.upiId || "Not recorded")}</span>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Uploaded Verification Documents</span>
                        ${docsLinksHtml}
                    </div>
                </div>
            </div>
        </details>
    `;
}

async function openDriverDrawer(uid) {
    showReadOnlyDrawer("Driver Profile", `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading profile...</div></div>`);
    try {
        const data = await adminGet(`/drivers/${uid}`);
        const d = data.driver || {};
        const ratingSummary = data.ratingSummary || d.ratingSummary;
        const recentRides = Array.isArray(data.recentRides) ? data.recentRides.slice(0, 10) : [];
        const recentRidesHtml = recentRides.length
            ? `<div class="table-responsive"><table class="table table-sm table-vcenter card-table table-striped table-hover m-0"><thead><tr><th>Route</th><th>Fare</th><th>Status</th><th></th></tr></thead><tbody>${recentRides
                  .map((r, idx) => `<tr class="admin-clickable-row" tabindex="0" data-driver-ride-idx="${idx}"><td>${escapeHtml(r.pickup_name || "Pickup")} \u2192 ${escapeHtml(r.drop_name || "Drop")}</td><td>₹${r.fare || 0}</td><td>${statusChip(r.status)}</td><td class="text-end dt-row-chevron-cell"><span class="dt-row-action-indicator"><i class="ti ti-chevron-right"></i></span></td></tr>`)
                  .join("")}</tbody></table></div>`
            : `<p class="text-secondary text-center py-3 m-0">No rides recorded yet.</p>`;

        const availStr = String(d.driverAvailability || "offline").toLowerCase();
        const availBadge = availStr === "online"
            ? `<span class="badge bg-success-lt text-success"><i class="ti ti-point-filled me-1"></i>Online</span>`
            : availStr === "busy"
            ? `<span class="badge bg-info-lt text-info"><i class="ti ti-steering-wheel me-1"></i>Busy</span>`
            : `<span class="badge bg-secondary-lt text-secondary">Offline</span>`;

        const summary = `
            <!-- Header Summary Card -->
            <div class="admin-detail-header-card mb-3">
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-3">
                    <div class="d-flex align-items-center gap-3">
                        ${d.profilePhotoUrl
                            ? `<img src="${escapeAttr(d.profilePhotoUrl)}" class="admin-drawer-photo" alt="">`
                            : `<div class="admin-drawer-photo admin-drawer-photo-placeholder d-flex align-items-center justify-content-center text-secondary"><i class="ti ti-user fs-2"></i></div>`}
                        <div>
                            <div class="d-flex align-items-center gap-2 flex-wrap">
                                <span class="admin-drawer-name">${escapeHtml(d.name || "Unnamed Driver")}</span>
                                ${statusChip(d.verificationStatus)}
                                ${availBadge}
                            </div>
                            <div class="admin-drawer-sub mt-1">Driver UID: <code>${escapeHtml(d.uid || uid)}</code></div>
                        </div>
                    </div>
                    <div class="d-flex flex-wrap gap-1">
                        ${d.verificationStatus === "pending_review" ? `
                            ${actionBtn("approve", '<i class="ti ti-check me-1"></i>Approve', "btn-success")}
                            ${actionBtn("reject", '<i class="ti ti-x me-1"></i>Reject', "btn-danger")}
                        ` : ""}
                        ${d.verificationStatus === "approved" ? `
                            ${actionBtn("suspend", '<i class="ti ti-pause me-1"></i>Suspend', "btn-warning")}
                            ${actionBtn("block", '<i class="ti ti-ban me-1"></i>Block', "btn-danger")}
                        ` : ""}
                        ${d.verificationStatus === "suspended" ? `
                            ${actionBtn("unsuspend", '<i class="ti ti-play me-1"></i>Unsuspend (Restore)', "btn-success")}
                        ` : ""}
                        ${d.verificationStatus === "blocked" ? `
                            ${actionBtn("unblock", '<i class="ti ti-lock-open me-1"></i>Unblock (Restore)', "btn-success")}
                        ` : ""}
                    </div>
                </div>
                ${d.verificationStatus === "rejected" ? `
                    <div class="alert alert-danger py-2 px-3 mt-2 mb-0 small">
                        <i class="ti ti-alert-circle me-1"></i>Application rejected: <strong>${escapeHtml(d.rejectionReason || "Requirements not met")}</strong>
                    </div>
                ` : ""}
                ${d.suspensionReason ? `<div class="alert alert-warning py-2 px-3 mt-2 mb-0 small"><strong>Suspension Reason:</strong> ${escapeHtml(d.suspensionReason)}</div>` : ""}
                ${d.blockingReason ? `<div class="alert alert-danger py-2 px-3 mt-2 mb-0 small"><strong>Blocking Reason:</strong> ${escapeHtml(d.blockingReason)}</div>` : ""}
            </div>

            <!-- Driver Overview & Performance Card -->
            <div class="admin-detail-card mb-3">
                <div class="admin-detail-card-header">
                    <i class="ti ti-chart-bar text-primary me-2"></i>
                    <span>Contact, Earnings &amp; Performance</span>
                </div>
                <div class="admin-detail-grid">
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Phone Number</span>
                        <strong class="admin-detail-value">${escapeHtml(d.phone || "Not recorded")}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Email Address</span>
                        <span class="admin-detail-value">${escapeHtml(d.email || "Not recorded")}</span>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Lifetime Earnings</span>
                        <strong class="admin-detail-value text-success">₹${escapeHtml(d.lifetimeEarnings || 0)}</strong>
                    </div>
                    <div class="admin-detail-cell">
                        <span class="admin-detail-label">Completed Trips</span>
                        <strong class="admin-detail-value">${escapeHtml(d.totalCompletedTrips || 0)}</strong>
                    </div>
                    <div class="admin-detail-cell admin-detail-cell-full">
                        <span class="admin-detail-label">Passenger Rating Summary</span>
                        <div class="admin-detail-value mt-1">${renderDriverRatingHtml(ratingSummary)}</div>
                    </div>
                    ${d.approvedAt ? `<div class="admin-detail-cell"><span class="admin-detail-label">Approved Date</span><span class="admin-detail-value">${escapeHtml(formatTimestamp(d.approvedAt))}</span></div>` : ""}
                    ${d.reappliedAt ? `<div class="admin-detail-cell"><span class="admin-detail-label">Re-applied Date</span><span class="admin-detail-value">${escapeHtml(formatTimestamp(d.reappliedAt))}</span></div>` : ""}
                </div>
            </div>

            ${renderKycDocumentsSection(d)}

            <!-- Collapsible Recent Rides (Limited to latest 10) -->
            <details class="admin-collapsible mb-3" open>
                <summary class="admin-collapsible-summary">
                    <span><i class="ti ti-history me-2 text-secondary"></i>Recent Rides (Latest ${recentRides.length} of max 10)</span>
                    <i class="ti ti-chevron-down admin-collapsible-chevron"></i>
                </summary>
                <div class="admin-collapsible-body p-0">
                    ${recentRidesHtml}
                </div>
            </details>

            <h4 class="admin-drawer-subsection"><i class="ti ti-edit me-1"></i>Edit Driver Details</h4>
        `;

        showFormDrawer(d.name || "Driver Profile", {
            extraHtml: summary,
            fields: [
                { key: "name", label: "Name", required: true },
                { key: "email", label: "Email", type: "email" },
                { key: "vehicleType", label: "Vehicle type" },
                { key: "vehicleNumber", label: "Vehicle number" },
                { key: "vehicleModel", label: "Vehicle model" },
                { key: "drivingLicenseNumber", label: "Licence number" },
                { key: "upiId", label: "UPI ID" },
            ],
            initialValues: d,
            onSave: async (values) => {
                await adminPatch(`/drivers/${uid}`, {
                    action: "update",
                    fields: {
                        name: values.name,
                        email: values.email,
                        vehicleType: values.vehicleType,
                        vehicleNumber: values.vehicleNumber,
                        vehicleModel: values.vehicleModel,
                        drivingLicenseNumber: values.drivingLicenseNumber,
                        upiId: values.upiId,
                    },
                });
                toast("Driver profile updated.");
                loadDrivers(true);
            },
        });

        document.querySelectorAll("#admin-drawer-body [data-driver-ride-idx]").forEach((tr) => {
            const openRow = () => {
                const r = recentRides[Number(tr.dataset.driverRideIdx)];
                if (r) openRideDrawer(r);
            };
            tr.addEventListener("click", openRow);
            tr.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openRow();
                }
            });
        });

        document.querySelectorAll("#admin-drawer-body [data-action]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const action = btn.dataset.action;
                let notes = "";

                if (action === "approve") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to APPROVE this driver registration? The driver will be enabled to go online and accept ride bookings.`, {
                        title: "Approve Driver Registration",
                        variant: "success",
                        confirmText: "Approve Driver"
                    });
                    if (!confirmed) return;
                } else if (action === "reject") {
                    const reason = await showTablerPrompt({
                        title: "Reject Driver Registration",
                        message: "Enter the rejection reason that will be displayed to the driver:",
                        placeholder: "e.g. Driver license is unreadable or expired",
                        defaultValue: "Application requirements were not met.",
                        required: true,
                        variant: "danger",
                        confirmText: "Reject Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "suspend") {
                    const reason = await showTablerPrompt({
                        title: "Suspend Driver Account",
                        message: "Enter reason for suspension (optional):",
                        placeholder: "e.g. Account suspended pending safety review",
                        defaultValue: "",
                        required: false,
                        variant: "warning",
                        confirmText: "Suspend Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "block") {
                    const reason = await showTablerPrompt({
                        title: "Block Driver Account",
                        message: "Enter reason for permanently blocking this driver (optional):",
                        placeholder: "e.g. Account blocked due to repeated policy violations",
                        defaultValue: "",
                        required: false,
                        variant: "danger",
                        confirmText: "Block Driver"
                    });
                    if (reason === null) return;
                    notes = reason;
                } else if (action === "unsuspend") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to UNSUSPEND this driver? Their account will be restored to Approved status.`, {
                        title: "Unsuspend Driver Account",
                        variant: "success",
                        confirmText: "Unsuspend Driver"
                    });
                    if (!confirmed) return;
                } else if (action === "unblock") {
                    const confirmed = await showTablerConfirm(`Are you sure you want to UNBLOCK this driver? Their account will be restored to Approved status.`, {
                        title: "Unblock Driver Account",
                        variant: "success",
                        confirmText: "Unblock Driver"
                    });
                    if (!confirmed) return;
                } else {
                    const confirmed = await showTablerConfirm(`Are you sure you want to ${btn.textContent.trim()} this driver?`, {
                        title: `${action.toUpperCase()} Driver`,
                        variant: "primary"
                    });
                    if (!confirmed) return;
                }

                await withButtonSpinner(btn, async () => {
                    try {
                        await adminPatch(`/drivers/${uid}`, { action, notes, fields: { rejectionReason: notes, suspensionReason: notes, blockingReason: notes } });
                        toast(`Driver status updated to ${action}.`);
                        closeDrawer(true);
                        loadDrivers(true);
                    } catch (error) {
                        toast(error.message, "error");
                    }
                });
            });
        });
    } catch (error) {
        showReadOnlyDrawer("Driver Profile", `<p class="text-danger text-center py-4 my-0">${error.message}</p>`);
    }
}

// ---------------------------------------------------------------------
// Live rides + waiting pools + Dispatch Diagnostics (Modification 2)
// ---------------------------------------------------------------------

let liveEventsInitialized = false;
let currentLiveTab = "all";
let liveSearchQuery = "";
let liveRidesHierarchy = [];
let liveCounts = { all: 0, single: 0, share: 0, child: 0 };
let waitingPoolsData = { passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } };
let latestDispatchStats = null;
const expandedParentIds = new Set();

function initLiveRidesEvents() {
    if (liveEventsInitialized) return;
    liveEventsInitialized = true;

    // Tabs navigation
    document.querySelectorAll(".live-tab-pill").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".live-tab-pill").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentLiveTab = btn.dataset.liveTab || "all";
            renderLiveSectionViews();
        });
    });

    // Search input
    $("live-rides-search")?.addEventListener("input", (e) => {
        liveSearchQuery = (e.target.value || "").trim().toLowerCase();
        renderLiveSectionViews();
    });

    // Refresh button
    $("live-rides-refresh-btn")?.addEventListener("click", async () => {
        const icon = $("live-rides-refresh-icon");
        if (icon) icon.classList.add("ti-spin");
        try {
            await loadLiveRides();
            toast("Live rides refreshed.");
        } finally {
            if (icon) icon.classList.remove("ti-spin");
        }
    });

    // Filter button - focuses search or toggles view
    $("live-rides-filters-btn")?.addEventListener("click", () => {
        $("live-rides-search")?.focus();
    });

    // Dispatch diagnostics buttons
    $("btn-open-dispatch-drawer")?.addEventListener("click", () => openDispatchDiagnosticsDrawer());
    $("live-dispatch-diagnostics-btn")?.addEventListener("click", () => openDispatchDiagnosticsDrawer());

    // Waiting pools filters
    $("wpp-type-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("wpp-sort-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("dap-type-filter")?.addEventListener("change", renderWaitingPoolsView);
    $("dap-sort-filter")?.addEventListener("change", renderWaitingPoolsView);
}

function formatCurrentTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}

function renderDispatchDiagnosticsBanner(stats) {
    if (!stats) return;
    const banner = $("dispatch-stats-banner");
    if (banner) banner.classList.remove("d-none");

    const wppCount = stats.pools?.waiting_passenger_pool?.total ?? 0;
    const dapCount = stats.pools?.driver_available_pool?.total ?? 0;
    const activeOffers = stats.offers?.active_pending ?? 0;
    const oldestWaitSec = stats.pools?.waiting_passenger_pool?.oldest_wait_seconds ?? 0;
    const oldestWaitMin = oldestWaitSec ? `${Math.round(oldestWaitSec / 60)}m` : "0m";
    const violations = Array.isArray(stats.invariant_violations) ? stats.invariant_violations : [];

    if ($("diag-wpp-size")) $("diag-wpp-size").textContent = wppCount;
    if ($("diag-dap-size")) $("diag-dap-size").textContent = dapCount;
    if ($("diag-offers-size")) $("diag-offers-size").textContent = activeOffers;
    if ($("diag-oldest-wpp")) $("diag-oldest-wpp").textContent = oldestWaitMin;

    const vBadge = $("diag-violations-badge");
    const hPill = $("dispatch-health-pill");
    if (violations.length > 0) {
        if (vBadge) {
            vBadge.className = "badge bg-danger-lt text-danger";
            vBadge.textContent = `${violations.length} violation${violations.length === 1 ? "" : "s"}`;
        }
        if (hPill) {
            hPill.className = "badge bg-danger-lt text-danger ms-1";
            hPill.textContent = `${violations.length} issue${violations.length === 1 ? "" : "s"}`;
        }
    } else {
        if (vBadge) {
            vBadge.className = "badge bg-success-lt text-success";
            vBadge.textContent = "0 violations";
        }
        if (hPill) {
            hPill.className = "badge bg-success-lt text-success ms-1";
            hPill.textContent = "OK";
        }
    }
}

async function openDispatchDiagnosticsDrawer() {
    showReadOnlyDrawer(
        "Dispatch Engine Diagnostics",
        `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Inspecting dispatch pools &amp; invariants...</div></div>`
    );
    try {
        const stats = await adminGet("/dispatch-stats", {}, { cacheable: false });
        latestDispatchStats = stats;
        renderDispatchDiagnosticsBanner(stats);

        const wpp = stats.pools?.waiting_passenger_pool || {};
        const dap = stats.pools?.driver_available_pool || {};
        const offers = stats.offers || {};
        const recon = stats.reconciliation || {};
        const violations = Array.isArray(stats.invariant_violations) ? stats.invariant_violations : [];

        const violationsHtml = violations.length
            ? `<div class="list-group list-group-flush border rounded mb-3">${violations
                  .map(
                      (v) => `<div class="list-group-item py-2">
                          <div class="fw-bold text-danger small"><i class="ti ti-alert-triangle me-1"></i>${escapeHtml(v.type || v.code || "Invariant Violation")}</div>
                          <div class="text-secondary small">${escapeHtml(v.detail || v.message || JSON.stringify(v))}</div>
                      </div>`
                  )
                  .join("")}</div>`
            : `<div class="alert alert-success py-2 px-3 small"><i class="ti ti-circle-check me-1"></i>Zero invariant violations detected across pools, rides, and offers.</div>`;

        const html = `
            <h4 class="admin-drawer-subsection">Invariant Health</h4>
            ${violationsHtml}

            <h4 class="admin-drawer-subsection">Waiting Passenger Pool (WPP)</h4>
            ${detailRow("Total Waiting", wpp.total ?? 0)}
            ${detailRow("Oldest Wait (seconds)", wpp.oldest_wait_seconds ?? 0)}
            ${detailRow("By Vehicle Type", JSON.stringify(wpp.by_vehicle_type || {}))}

            <h4 class="admin-drawer-subsection">Driver Available Pool (DAP)</h4>
            ${detailRow("Total Available", dap.total ?? 0)}
            ${detailRow("Fresh Heartbeat (< 2 min)", dap.fresh_heartbeat ?? 0)}
            ${detailRow("Stale Heartbeat", dap.stale_heartbeat ?? 0)}
            ${detailRow("By Vehicle Type", JSON.stringify(dap.by_vehicle_type || {}))}

            <h4 class="admin-drawer-subsection">Ride Offers &amp; Reconciliation</h4>
            ${detailRow("Active Pending Offers", offers.active_pending ?? 0)}
            ${detailRow("Expired Uncleaned Offers", offers.expired_uncleaned ?? 0)}
            ${detailRow("Searching Rides in DB", recon.searching_rides_count ?? 0)}
            ${detailRow("Active Trips in DB", recon.active_rides_count ?? 0)}
        `;
        showReadOnlyDrawer("Dispatch Engine Diagnostics", html);
    } catch (error) {
        showReadOnlyDrawer("Dispatch Engine Diagnostics", `<p class="text-danger text-center py-4">${escapeHtml(error.message)}</p>`);
    }
}

async function loadLiveRides() {
    const tbody = $("live-rides-hierarchy-tbody");
    const legacyList = $("live-rides-list");
    if (tbody && liveRidesHierarchy.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5 text-secondary"><span class="spinner-border spinner-border-sm text-primary me-2"></span>Loading live rides &amp; pools...</td></tr>`;
    }
    try {
        const [liveRes, poolsRes, diagRes] = await Promise.all([
            adminGet("/rides/live"),
            adminGet("/waiting-pools").catch(() => ({ ok: true, passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } })),
            adminGet("/dispatch-stats", {}, { cacheable: false }).catch(() => null),
        ]);

        liveRidesHierarchy = liveRes?.hierarchy || [];
        liveCounts = liveRes?.counts || { all: 0, single: 0, share: 0, child: 0 };
        waitingPoolsData = poolsRes || { passengers: [], drivers: [], counts: { passengers: 0, drivers: 0, total: 0 } };
        if (diagRes) {
            latestDispatchStats = diagRes;
            renderDispatchDiagnosticsBanner(diagRes);
        }

        // By default on first load, expand first parent if any share rides
        if (expandedParentIds.size === 0 && liveRidesHierarchy.length > 0) {
            const firstShare = liveRidesHierarchy.find((h) => h.rideType === "share");
            if (firstShare) expandedParentIds.add(firstShare.id);
        }

        // Update last updated timestamp
        const timeStr = formatCurrentTime();
        if ($("live-rides-last-updated")) {
            $("live-rides-last-updated").textContent = `Last updated: ${timeStr}`;
        }

        // Update tab pill counts
        if ($("tab-count-all")) $("tab-count-all").textContent = liveCounts.all ?? liveRidesHierarchy.length;
        if ($("tab-count-single")) $("tab-count-single").textContent = liveCounts.single ?? 0;
        if ($("tab-count-share")) $("tab-count-share").textContent = liveCounts.share ?? 0;
        if ($("tab-count-child")) $("tab-count-child").textContent = liveCounts.child ?? 0;
        if ($("tab-count-waiting")) $("tab-count-waiting").textContent = waitingPoolsData.counts?.total ?? ((waitingPoolsData.passengers?.length || 0) + (waitingPoolsData.drivers?.length || 0));

        renderLiveSectionViews();
    } catch (error) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">${escapeHtml(error.message)}</td></tr>`;
        }
        if (legacyList) {
            legacyList.innerHTML = `<div class="col-12 text-center text-danger py-4">${escapeHtml(error.message)}</div>`;
        }
    }
}

function renderLiveSectionViews() {
    const isPools = currentLiveTab === "waiting-pools";
    $("live-rides-table-view")?.classList.toggle("d-none", isPools);
    $("waiting-pools-view")?.classList.toggle("d-none", !isPools);

    if (isPools) {
        renderWaitingPoolsView();
    } else {
        renderHierarchyTableView();
    }
}

function getAvatarColor(name = "") {
    const palette = [
        "bg-orange-lt text-orange",
        "bg-purple-lt text-purple",
        "bg-blue-lt text-blue",
        "bg-teal-lt text-teal",
        "bg-pink-lt text-pink",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash << 5) - hash + name.charCodeAt(i);
        hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
}

function renderHierarchyTableView() {
    const tbody = $("live-rides-hierarchy-tbody");
    if (!tbody) return;

    let items = [...liveRidesHierarchy];

    // Tab filter
    if (currentLiveTab === "single") {
        items = items.filter((h) => h.rideType !== "share");
    } else if (currentLiveTab === "share") {
        items = items.filter((h) => h.rideType === "share");
    } else if (currentLiveTab === "child") {
        items = items.filter((h) => h.childRides && h.childRides.length > 0);
    }

    // Search query filter
    if (liveSearchQuery) {
        items = items.filter((h) => {
            const hay = [
                h.id, h.displayId, h.description,
                h.driver?.name, h.driver?.phone, h.driver?.plate,
                h.route?.pickup, h.route?.drop,
                h.status,
                ...(h.childRides || []).flatMap((c) => [
                    c.id, c.displayId, c.status,
                    c.passenger?.name, c.passenger?.phone,
                    c.driver?.name, c.driver?.phone, c.driver?.plate,
                    c.route?.pickup, c.route?.drop
                ]),
            ].filter(Boolean).join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5 text-secondary">
            <i class="ti ti-car-off text-muted mb-2" style="font-size: 2.2rem; display: block;"></i>
            No active rides match this view right now.
        </td></tr>`;
        return;
    }

    let rowsHtml = "";

    items.forEach((parent) => {
        const isExpanded = expandedParentIds.has(parent.id) || currentLiveTab === "child" || Boolean(liveSearchQuery);
        const hasChildren = parent.childRides && parent.childRides.length > 0;
        const vType = (parent.vehicleType || "auto").toLowerCase();
        const isShare = parent.rideType === "share";

        // Vehicle / Ride icon
        let iconHtml = "";
        if (isShare) {
            iconHtml = `<span class="avatar avatar-sm bg-blue-lt text-blue rounded-circle flex-shrink-0"><i class="ti ti-users"></i></span>`;
        } else if (vType === "bike") {
            iconHtml = `<span class="avatar avatar-sm bg-azure-lt text-azure rounded-circle flex-shrink-0"><i class="ti ti-motorbike"></i></span>`;
        } else {
            iconHtml = `<span class="avatar avatar-sm bg-green-lt text-green rounded-circle flex-shrink-0"><i class="ti ti-car"></i></span>`;
        }

        // Type badge
        let typeBadge = "";
        if (isShare) {
            typeBadge = `<span class="badge-type-pill badge-type-share"><i class="ti ti-users"></i> Share Ride</span>`;
        } else if (vType === "bike") {
            typeBadge = `<span class="badge-type-pill badge-type-bike"><i class="ti ti-motorbike"></i> Bike</span>`;
        } else {
            typeBadge = `<span class="badge-type-pill badge-type-auto"><i class="ti ti-car"></i> Auto</span>`;
        }

        // Status badge
        const isFinding = parent.status === "Finding Riders";
        const statusBadge = isFinding
            ? `<span class="badge-status-pill badge-status-finding"><i class="ti ti-clock"></i> Finding Riders</span>`
            : `<span class="badge-status-pill badge-status-ontrip"><i class="ti ti-circle-check"></i> ${escapeHtml(parent.status || "On Trip")}</span>`;

        // Driver initials circle with deterministic color
        const drvInitials = parent.driver?.initials || "DR";
        const drvName = escapeHtml(parent.driver?.name || "Unassigned");
        const drvColor = getAvatarColor(parent.driver?.name || "Driver");
        const drvPhone = escapeHtml(parent.driver?.phone || "");
        const drvPlate = escapeHtml(parent.driver?.plate || "");

        const isAuto = vType === "auto" && !isShare;
        const barClass = isAuto ? "passenger-progress-bar progress-bar-auto" : "passenger-progress-bar";

        // Parent Row
        rowsHtml += `
            <tr class="parent-ride-row ${isExpanded ? 'is-expanded' : ''}" data-row-id="${escapeHtml(parent.id)}">
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <button type="button" class="chevron-expand-btn ${isExpanded ? 'is-expanded' : ''}" data-expand-id="${escapeHtml(parent.id)}" title="${isExpanded ? 'Collapse' : 'Expand'} nested rides">
                            <i class="ti ti-chevron-${isExpanded ? 'down' : 'right'} fs-3"></i>
                        </button>
                        ${iconHtml}
                        <div>
                            <div class="d-flex align-items-center gap-2">
                                <span class="fw-bold text-dark fs-4">${escapeHtml(parent.displayId)}</span>
                                ${isShare ? `<span class="badge-parent-pill">&bull; Parent</span><span class="badge bg-secondary-lt text-secondary px-1"><i class="ti ti-users" style="font-size: 0.75rem;"></i></span>` : ''}
                            </div>
                            <div class="text-secondary small mt-0">${escapeHtml(parent.description || "")}</div>
                        </div>
                    </div>
                </td>
                <td>${typeBadge}</td>
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <div class="avatar-initials-circle ${drvColor}">${drvInitials}</div>
                        <div>
                            <div class="fw-bold text-dark">${drvName}</div>
                            ${drvPhone ? `<div class="text-secondary small">${drvPhone}</div>` : ''}
                            ${drvPlate ? `<div class="text-secondary small fw-medium">${drvPlate}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td>
                    <div class="fw-semibold text-dark">${escapeHtml(parent.passengers?.label || "1 / 1")}</div>
                    <div class="passenger-progress-track">
                        <div class="${barClass}" style="width: ${parent.passengers?.pct || 100}%;"></div>
                    </div>
                </td>
                <td>
                    <div class="d-flex align-items-center">
                        <span class="route-dot-green"></span>
                        <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(parent.route?.pickup || "Pickup")}</span>
                    </div>
                    <div class="d-flex align-items-center mt-1">
                        <span class="route-dot-red"></span>
                        <span class="text-truncate text-secondary" style="max-width: 170px;">${escapeHtml(parent.route?.drop || "Drop")}</span>
                    </div>
                </td>
                <td>${statusBadge}</td>
                <td>
                    <div class="fw-semibold text-dark">${escapeHtml(parent.startedAt || "--")}</div>
                    <div class="text-secondary small">${escapeHtml(parent.elapsedText || "")}</div>
                </td>
                <td class="text-end">
                    <div class="d-inline-flex align-items-center gap-1">
                        <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-ride="${escapeHtml(parent.id)}">View</button>
                        <div class="dropdown">
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center dropdown-toggle-clean" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                <i class="ti ti-chevron-down"></i>
                            </button>
                            <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                <button type="button" class="dropdown-item text-danger d-flex align-items-center gap-2" data-action-cancel="${escapeHtml(parent.id)}" data-is-parent="true" data-display-id="${escapeHtml(parent.displayId)}">
                                    <i class="ti ti-x"></i> Cancel
                                </button>
                                <button type="button" class="dropdown-item text-primary d-flex align-items-center gap-2" data-action-map="${escapeHtml(parent.id)}" data-is-parent="true">
                                    <i class="ti ti-map-2"></i> View on Map
                                </button>
                            </div>
                        </div>
                    </div>
                </td>
            </tr>
        `;

        // Nested Child Rows
        if (isExpanded && hasChildren) {
            parent.childRides.forEach((child, idx) => {
                const paxName = escapeHtml(child.passenger?.name || "Passenger");
                const paxPhone = escapeHtml(child.passenger?.phone || "");
                const avatarBg = idx % 2 === 0 ? "bg-azure-lt text-azure" : "bg-pink-lt text-pink";

                rowsHtml += `
                    <tr class="child-ride-row" data-parent-id="${escapeHtml(parent.id)}" data-child-id="${escapeHtml(child.id)}">
                        <td>
                            <div class="tree-branch-container">
                                <span class="avatar avatar-sm ${avatarBg} rounded-circle flex-shrink-0">
                                    <i class="ti ti-user"></i>
                                </span>
                                <div class="ms-2">
                                    <div class="d-flex align-items-center gap-2">
                                        <span class="fw-bold text-dark">${escapeHtml(child.displayId)}</span>
                                        <span class="badge-child-pill">Child</span>
                                    </div>
                                    <div class="text-secondary small">Passenger: ${paxName}</div>
                                    ${paxPhone ? `<div class="text-secondary small">${paxPhone}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td>${typeBadge}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${drvColor}">${drvInitials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${drvName}</div>
                                    ${drvPlate ? `<div class="text-secondary small fw-medium">${drvPlate}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td><span class="text-muted">&mdash;</span></td>
                        <td>
                            <div class="d-flex align-items-center">
                                <span class="route-dot-green"></span>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(child.route?.pickup || "Pickup")}</span>
                            </div>
                            <div class="d-flex align-items-center mt-1">
                                <span class="route-dot-red"></span>
                                <span class="text-truncate text-secondary" style="max-width: 170px;">${escapeHtml(child.route?.drop || "Drop")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="badge-status-pill badge-status-ontrip">
                                <i class="ti ti-circle-check"></i> ${escapeHtml(child.status || "On Trip")}
                            </span>
                        </td>
                        <td>
                            <div class="fw-semibold text-dark">${escapeHtml(child.startedAt || "--")}</div>
                            <div class="text-secondary small">${escapeHtml(child.elapsedText || "")}</div>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-ride="${escapeHtml(child.id)}">View</button>
                                <div class="dropdown">
                                    <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center dropdown-toggle-clean" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                        <i class="ti ti-chevron-down"></i>
                                    </button>
                                    <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                        <button type="button" class="dropdown-item text-danger d-flex align-items-center gap-2" data-action-cancel="${escapeHtml(child.id)}" data-is-parent="false" data-display-id="${escapeHtml(child.displayId)}" data-pax-name="${paxName}">
                                            <i class="ti ti-x"></i> Cancel
                                        </button>
                                        <button type="button" class="dropdown-item text-primary d-flex align-items-center gap-2" data-action-map="${escapeHtml(child.id)}" data-is-parent="false">
                                            <i class="ti ti-map-2"></i> View on Map
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }
    });

    tbody.innerHTML = rowsHtml;

    // Attach event listeners for expand/collapse chevron
    tbody.querySelectorAll("[data-expand-id]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = btn.dataset.expandId;
            if (expandedParentIds.has(id)) {
                expandedParentIds.delete(id);
            } else {
                expandedParentIds.add(id);
            }
            renderHierarchyTableView();
        });
    });

    // View button
    tbody.querySelectorAll("[data-view-ride]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const rideId = btn.dataset.viewRide;
            const foundParent = liveRidesHierarchy.find((h) => h.id === rideId);
            if (foundParent) return openRideDrawer(foundParent);
            for (const p of liveRidesHierarchy) {
                const c = (p.childRides || []).find((cr) => cr.id === rideId);
                if (c) return openRideDrawer(c);
            }
            openRideDrawer({ id: rideId });
        });
    });

    // Cancel action
    tbody.querySelectorAll("[data-action-cancel]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const rideId = btn.dataset.actionCancel;
            const isParent = btn.dataset.isParent === "true";
            const displayId = btn.dataset.displayId || `#${rideId}`;
            const paxName = btn.dataset.paxName || "";

            const confirmMsg = isParent
                ? `Are you sure you want to cancel the entire parent ride ${displayId}? All passengers in this trip will be cancelled.`
                : `Are you sure you want to cancel child ride ${displayId}${paxName ? ` for passenger ${paxName}` : ''}?`;

            const confirmed = await showTablerConfirm(confirmMsg, {
                title: isParent ? "Cancel Entire Ride" : "Cancel Passenger Ride",
                variant: "danger",
                confirmText: "Cancel Ride",
            });
            if (!confirmed) return;

            const dropdownToggleBtn = btn.closest(".dropdown")?.querySelector(".dropdown-toggle-clean") || btn;
            await withButtonSpinner(dropdownToggleBtn, async () => {
                try {
                    await adminPatch(`/rides/${rideId}`, {
                        action: "cancel",
                        cancel_all_children: isParent,
                    });
                    toast(`${displayId} has been cancelled.`);
                    await loadLiveRides();
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });
    });

    // View on Map action
    tbody.querySelectorAll("[data-action-map]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const rideId = btn.dataset.actionMap;
            let targetRide = liveRidesHierarchy.find((h) => h.id === rideId);
            if (!targetRide) {
                for (const p of liveRidesHierarchy) {
                    const c = (p.childRides || []).find((cr) => cr.id === rideId);
                    if (c) {
                        targetRide = c;
                        break;
                    }
                }
            }
            openLiveRideMapModal(rideId, targetRide || {});
        });
    });
}

function openAssignDriverModal(passenger) {
    const paxId = passenger.passenger_id || passenger.id;
    const rideId = passenger.ride_id || "";
    const paxName = passenger.name || "Passenger";
    const paxVehicle = (passenger.vehicleType || passenger.type || "auto").toLowerCase();

    const availableDrivers = [...(waitingPoolsData.drivers || [])];
    const driverOptionsHtml = availableDrivers.length
        ? availableDrivers
              .map(
                  (d) => `<option value="${escapeAttr(d.driver_id || d.id)}">
                      ${escapeHtml(d.name)} (${escapeHtml(d.vehicleType || "Auto")} - ${escapeHtml(d.plate || "No Plate")})
                  </option>`
              )
              .join("")
        : `<option value="">No drivers currently in Available Pool</option>`;

    const html = `
        <div class="mb-3">
            <div class="fw-bold text-dark mb-1">Manual Dispatch Override</div>
            <div class="text-secondary small">Assigning an available driver directly to waiting passenger <strong>${escapeHtml(paxName)}</strong> (${escapeHtml(passenger.pickupLocation || "Pickup")}).</div>
        </div>
        ${detailRow("Passenger ID", paxId)}
        ${rideId ? detailRow("Ride ID", rideId) : ""}
        ${detailRow("Requested Type", paxVehicle.toUpperCase())}
        <div class="mt-3">
            <label class="form-label fw-semibold">Select Available Driver</label>
            <select id="manual-assign-driver-select" class="form-select mb-2">
                ${driverOptionsHtml}
            </select>
            <div class="text-secondary small mb-3">Or enter a specific Driver UID manually:</div>
            <input type="text" id="manual-assign-driver-uid" class="form-control mb-3" placeholder="Optional override Driver UID">
            <button type="button" id="btn-confirm-manual-assign" class="btn btn-primary w-100">
                <i class="ti ti-steering-wheel me-1"></i>Assign Driver Now
            </button>
        </div>
    `;

    const { bodyEl } = showReadOnlyDrawer("Assign Driver to Passenger", html);
    const confirmBtn = bodyEl.querySelector("#btn-confirm-manual-assign");
    confirmBtn?.addEventListener("click", async () => {
        const manualUid = bodyEl.querySelector("#manual-assign-driver-uid")?.value?.trim();
        const selectUid = bodyEl.querySelector("#manual-assign-driver-select")?.value?.trim();
        const driverId = manualUid || selectUid;
        if (!driverId) {
            return toast("Select or enter a driver ID to assign.", "error");
        }
        await withButtonSpinner(confirmBtn, async () => {
            try {
                await adminPost("/waiting-pools/assign", {
                    passenger_id: paxId,
                    driver_id: driverId,
                    ride_id: rideId || undefined,
                });
                toast(`Assigned driver to ${paxName}.`);
                closeDrawer(true);
                await loadLiveRides();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });
}

async function removeWaitingPassenger(passenger, triggerBtn = null) {
    const paxId = passenger.id || passenger.passenger_id;
    const paxName = passenger.name || paxId;
    const confirmed = await showTablerConfirm(
        `Remove ${paxName} from the waiting passenger pool and cancel their searching ride request?`,
        {
            title: "Remove from Waiting Pool",
            variant: "danger",
            confirmText: "Remove Passenger",
        }
    );
    if (!confirmed) return;
    await withButtonSpinner(triggerBtn, async () => {
        try {
            await adminDelete(`/waiting-pools/passengers/${encodeURIComponent(paxId)}`);
            toast(`${paxName} removed from waiting pool.`);
            await loadLiveRides();
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

function renderWaitingPoolsView() {
    // 1. Passenger Pool
    const wppTbody = $("wpp-table-tbody");
    const wppType = $("wpp-type-filter")?.value || "all";
    const wppSort = $("wpp-sort-filter")?.value || "oldest";

    let passengers = [...(waitingPoolsData.passengers || [])];

    if (wppType !== "all") {
        passengers = passengers.filter((p) => (p.type || "").toLowerCase() === wppType.toLowerCase());
    }

    // Search query filter for passengers
    if (liveSearchQuery) {
        passengers = passengers.filter((p) => {
            const hay = [
                p.id, p.passenger_id, p.ride_id,
                p.name, p.phone, p.type,
                p.pickupLocation,
            ].join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (wppSort === "newest") {
        passengers.sort((a, b) => (a.waitTimeMinutes || 0) - (b.waitTimeMinutes || 0));
    } else {
        passengers.sort((a, b) => (b.waitTimeMinutes || 0) - (a.waitTimeMinutes || 0));
    }

    if ($("wpp-header-badge")) {
        $("wpp-header-badge").textContent = `${passengers.length} waiting`;
    }

    if (wppTbody) {
        if (passengers.length === 0) {
            wppTbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small">No waiting passengers match this filter.</td></tr>`;
        } else {
            wppTbody.innerHTML = passengers.map((p, idx) => {
                const initials = p.initials || "PA";
                const typeClass = p.type === "Share" ? "badge-type-share" : (p.type === "Bike" ? "badge-type-bike" : "badge-type-auto");
                const typeIcon = p.type === "Share" ? "ti-users" : (p.type === "Bike" ? "ti-motorbike" : "ti-car");
                const urgencyClass = `badge-urgency-${p.urgencyBadge || 'low'}`;
                const avatarColor = getAvatarColor(p.name || `PA_${idx}`);

                return `
                    <tr>
                        <td class="text-secondary small fw-medium">${idx + 1}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${avatarColor}">${initials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${escapeHtml(p.name)}</div>
                                    <div class="text-secondary small">${escapeHtml(p.phone || "")}</div>
                                </div>
                            </div>
                        </td>
                        <td>
                            <span class="badge-type-pill ${typeClass}">
                                <i class="ti ${typeIcon}"></i> ${escapeHtml(p.type)}
                            </span>
                        </td>
                        <td>
                            <div class="d-flex align-items-center gap-1">
                                <i class="ti ti-map-pin text-success fs-3 flex-shrink-0"></i>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(p.pickupLocation || "Pickup")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="text-dark small">${escapeHtml(p.waitingSince || "--")}</span>
                        </td>
                        <td>
                            <span class="badge ${urgencyClass}">${escapeHtml(p.waitTimeText || "0 min")}</span>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-primary rounded-pill px-2 py-1 wpp-assign-btn" data-wpp-idx="${idx}" title="Manually assign driver">
                                    <i class="ti ti-steering-wheel me-1"></i>Assign Driver
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-danger rounded-pill px-2 py-1 wpp-remove-btn" data-wpp-idx="${idx}" title="Remove from pool">
                                    Remove
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill px-2 py-1" data-view-pax="${escapeHtml(p.passenger_id || p.id)}">Profile</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");

            wppTbody.querySelectorAll("[data-view-pax]").forEach((btn) => {
                btn.addEventListener("click", () => openPassengerDrawer(btn.dataset.viewPax));
            });
            wppTbody.querySelectorAll(".wpp-assign-btn").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const p = passengers[Number(btn.dataset.wppIdx)];
                    if (p) openAssignDriverModal(p);
                });
            });
            wppTbody.querySelectorAll(".wpp-remove-btn").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const p = passengers[Number(btn.dataset.wppIdx)];
                    if (p) removeWaitingPassenger(p, btn);
                });
            });
        }
    }

    // 2. Driver Pool
    const dapTbody = $("dap-table-tbody");
    const dapType = $("dap-type-filter")?.value || "all";
    const dapSort = $("dap-sort-filter")?.value || "nearest";

    let drivers = [...(waitingPoolsData.drivers || [])];

    if (dapType !== "all") {
        drivers = drivers.filter((d) => (d.vehicleType || "").toLowerCase() === dapType.toLowerCase());
    }

    // Search query filter for drivers
    if (liveSearchQuery) {
        drivers = drivers.filter((d) => {
            const hay = [
                d.id, d.driver_id,
                d.name, d.phone, d.plate, d.vehicleType,
                d.currentLocation,
            ].join(" ").toLowerCase();
            return hay.includes(liveSearchQuery);
        });
    }

    if (dapSort === "longest_idle") {
        drivers.sort((a, b) => (b.idleTimeMinutes || 0) - (a.idleTimeMinutes || 0));
    } else {
        const refLat = 23.8315;
        const refLng = 91.2868;
        const getDistSq = (d) => {
            if (d.lat != null && d.lng != null) {
                return (d.lat - refLat) ** 2 + (d.lng - refLng) ** 2;
            }
            return 9999;
        };
        drivers.sort((a, b) => getDistSq(a) - getDistSq(b));
    }

    if ($("dap-header-badge")) {
        $("dap-header-badge").textContent = `${drivers.length} available`;
    }

    if (dapTbody) {
        if (drivers.length === 0) {
            dapTbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-secondary small">No available drivers match this filter.</td></tr>`;
        } else {
            dapTbody.innerHTML = drivers.map((d, idx) => {
                const initials = d.initials || "DR";
                const typeClass = d.vehicleType === "Bike" ? "badge-type-bike" : "badge-type-auto";
                const typeIcon = d.vehicleType === "Bike" ? "ti-motorbike" : "ti-car";
                const idleClass = `badge-urgency-${d.idleBadge || 'low'}`;
                const avatarColor = getAvatarColor(d.name || `DR_${idx}`);

                return `
                    <tr>
                        <td class="text-secondary small fw-medium">${idx + 1}</td>
                        <td>
                            <div class="d-flex align-items-center gap-2">
                                <div class="avatar-initials-circle ${avatarColor}">${initials}</div>
                                <div>
                                    <div class="fw-bold text-dark">${escapeHtml(d.name)}</div>
                                    <div class="text-secondary small">${escapeHtml(d.phone || "")}</div>
                                    ${d.plate ? `<div class="text-secondary small fw-medium">${escapeHtml(d.plate)}</div>` : ''}
                                </div>
                            </div>
                        </td>
                        <td>
                            <span class="badge-type-pill ${typeClass}">
                                <i class="ti ${typeIcon}"></i> ${escapeHtml(d.vehicleType)}
                            </span>
                        </td>
                        <td>
                            <div class="d-flex align-items-center gap-1">
                                <i class="ti ti-map-pin text-success fs-3 flex-shrink-0"></i>
                                <span class="text-truncate text-dark fw-medium" style="max-width: 170px;">${escapeHtml(d.currentLocation || "Agartala")}</span>
                            </div>
                        </td>
                        <td>
                            <span class="badge ${idleClass}">${escapeHtml(d.idleTimeText || "0 min")}</span>
                        </td>
                        <td class="text-end">
                            <div class="d-inline-flex align-items-center gap-1">
                                <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-3 py-1" data-view-drv="${escapeHtml(d.driver_id || d.id)}">View</button>
                                <div class="dropdown">
                                    <button type="button" class="btn btn-sm btn-outline-secondary rounded-circle p-0 d-inline-flex align-items-center justify-content-center" data-bs-toggle="dropdown" aria-expanded="false" style="width: 28px; height: 28px;">
                                        <i class="ti ti-dots"></i>
                                    </button>
                                    <div class="dropdown-menu dropdown-menu-end shadow-sm">
                                        <button type="button" class="dropdown-item" data-view-drv="${escapeHtml(d.driver_id || d.id)}">
                                            <i class="ti ti-user me-2"></i> Driver Profile
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");

            dapTbody.querySelectorAll("[data-view-drv]").forEach((btn) => {
                btn.addEventListener("click", () => openDriverDrawer(btn.dataset.viewDrv));
            });
        }
    }
}

// ---------------------------------------------------------------------
// Ride history
// ---------------------------------------------------------------------

function ensureHistoryTable() {
    if (historyTable) return historyTable;
    historyTable = new DataTable({
        container: $("history-table-wrap"),
        exportFileName: "liphtup-ride-history",
        searchPlaceholder: "Search rides by route, driver, passenger, or ID...",
        getRowId: (r) => r.id,
        onRowClick: (r) => openRideDrawer(r),
        onLoadMore: () => loadHistory(false),
        onSearch: (q) => {
            historySearchQuery = q;
            loadHistory(true);
        },
        columns: [
            { key: "driver_name", label: "Driver", sortable: true, render: (r) => formatRideDriverCell(r) },
            { key: "passenger_name", label: "Passenger", sortable: true, render: (r) => formatRidePassengerCell(r) },
            { key: "route", label: "Route", render: (r) => `${escapeHtml(r.pickup_name || r.pickupName || "Not recorded")} \u2192 ${escapeHtml(r.drop_name || r.dropName || "Not recorded")}` },
            { key: "rideType", label: "Type", sortable: true, render: (r) => r.rideType === "share" ? `<span class="badge bg-teal-lt text-teal">Share</span>` : `<span class="badge bg-secondary-lt text-secondary">Normal</span>` },
            { key: "fare", label: "Fare", sortable: true, render: (r) => `Rs ${r.fare || 0}` },
            { key: "feedback", label: "Feedback", sortable: false, render: (r) => r.feedback?.submitted ? `<span class="badge bg-success-lt text-success"><i class="ti ti-check me-1"></i>Feedback</span>` : `<span class="text-secondary">&mdash;</span>` },
            { key: "status", label: "Status", sortable: true, render: (r) => statusChip(r.status) },
        ],
    });
    return historyTable;
}

function populateHistoryMonthFilter() {
    const select = $("history-month-filter");
    if (!select || select.dataset.populated) return;
    select.dataset.populated = "1";
    const now = new Date();
    for (let i = 0; i < 12; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const value = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    }
}

async function loadHistory(reset) {
    populateHistoryMonthFilter();
    if (reset) cursors.history = null;
    const status = $("history-status-filter")?.value || "";
    const vehicleType = $("history-vehicle-filter")?.value || "";
    const rideType = $("history-ridetype-filter")?.value || "";
    const hasFeedbackVal = $("history-feedback-filter")?.value;
    let hasFeedback = undefined;
    if (hasFeedbackVal === "true") hasFeedback = true;
    else if (hasFeedbackVal === "false") hasFeedback = false;

    const day = $("history-day-filter")?.value || "";
    const month = $("history-month-filter")?.value || "";
    let dateFrom, dateTo;
    if (day) {
        dateFrom = day;
        dateTo = new Date(new Date(`${day}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    } else if (month) {
        const start = new Date(`${month}T00:00:00Z`);
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        dateFrom = month;
        dateTo = end.toISOString().slice(0, 10);
    }
    const table = ensureHistoryTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/rides/history", {
            status: status || (dateFrom ? "all" : undefined),
            vehicleType,
            rideType: rideType || undefined,
            hasFeedback,
            dateFrom,
            dateTo,
            q: historySearchQuery || undefined,
            cursor: reset ? null : cursors.history,
        });
        cursors.history = data.nextCursor;
        table.setRows(data.rides, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

async function openRideDrawer(ride) {
    showReadOnlyDrawer(
        "Ride Details",
        `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading ride details...</div></div>`
    );
    let fullRide = ride;
    let siblingChildRides = [];
    try {
        const res = await adminGet(`/rides/${ride.id}`);
        if (res?.ride) {
            fullRide = res.ride;
            siblingChildRides = res.siblingChildRides || [];
        }
    } catch (_) {}

    const r = fullRide;
    const timeline = [
        ["Requested", r.createdAt],
        ["Accepted", r.acceptedAt],
        ["Started / PIN Verified", r.startedAt || r.pinVerifiedAt],
        ["Completed", r.completedAt],
        ["Cancelled", r.cancelledAt],
    ].filter(([, ts]) => ts);

    const notes = Array.isArray(r.adminNotes) ? r.adminNotes : [];

    let feedbackHtml = "";
    if (r.feedback && r.feedback.submitted) {
        const expMap = {
            poor: "🔴 Poor",
            decent: "🟠 Decent",
            good: "🟢 Good",
            loved: "🟢 Loved it!"
        };
        const expLabel = expMap[r.feedback.experience] || r.feedback.experience;
        const reasonsList = (r.feedback.reasons || [])
            .map(x => x.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))
            .join(", ");
        feedbackHtml = `
            <details class="admin-collapsible" open>
                <summary>
                    <span><i class="ti ti-message-star me-1 text-success"></i>Passenger Feedback</span>
                    <span class="badge bg-success-lt text-success">${escapeHtml(expLabel)}</span>
                </summary>
                <div class="admin-collapsible-body">
                    <div class="admin-detail-grid">
                        <div class="admin-detail-field"><div class="admin-detail-label">Experience</div><div class="admin-detail-value">${escapeHtml(expLabel)}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Highlights / Reasons</div><div class="admin-detail-value">${escapeHtml(reasonsList || "None selected")}</div></div>
                    </div>
                </div>
            </details>
        `;
    }

    let shareHtml = "";
    if (r.rideType === "share" || r.parentTripId) {
        let siblingsHtml = "";
        if (siblingChildRides.length) {
            siblingsHtml = `
                <div class="table-responsive mt-2">
                    <table class="table table-sm table-vcenter card-table table-bordered m-0">
                        <thead>
                            <tr>
                                <th>Ride ID</th>
                                <th>Status</th>
                                <th>Seats</th>
                                <th>Fare</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${siblingChildRides.map(s => {
                                const sId = String(s?.id || s?.rideId || s?.childRideId || '');
                                const isCurrent = sId && (sId === r.id);
                                const idLabel = sId ? escapeHtml(sId.slice(0, 8)) : 'Child Ride';
                                return `
                                <tr class="${isCurrent ? 'table-active fw-bold' : ''}">
                                    <td>${idLabel} ${isCurrent ? '(This)' : ''}</td>
                                    <td>${statusChip(s?.status)}</td>
                                    <td>${s?.seatsBooked || 1}</td>
                                    <td>₹${s?.fare || 0}</td>
                                </tr>
                                `;
                            }).join("")}
                        </tbody>
                    </table>
                </div>
            `;
        } else {
            siblingsHtml = `<p class="text-secondary small mb-0">No sibling rides found.</p>`;
        }

        shareHtml = `
            <details class="admin-collapsible">
                <summary>
                    <span><i class="ti ti-users-group me-1 text-teal"></i>Share Auto Trip Details</span>
                    <span class="badge bg-teal-lt text-teal">${r.seatsBooked || 1} seat(s)</span>
                </summary>
                <div class="admin-collapsible-body">
                    <div class="admin-detail-grid mb-2">
                        <div class="admin-detail-field"><div class="admin-detail-label">Ride Type</div><div class="admin-detail-value"><span class="badge bg-teal-lt text-teal">Share Auto</span></div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Parent Trip ID</div><div class="admin-detail-value font-monospace small">${escapeHtml(r.parentTripId || "Not applicable")}</div></div>
                    </div>
                    <div class="fw-medium small mb-1">Sibling Child Rides:</div>
                    ${siblingsHtml}
                </div>
            </details>
        `;
    }

    const paxId = String(r.passenger_id || r.passengerId || r.userId || r.user_id || r.passenger?.id || "").trim();
    const rawPaxName = String(r.passenger_name || r.passengerName || r.passenger?.name || "").trim();
    const passengerPhone = String(r.passenger_phone || r.passengerPhone || r.passenger?.phone || "").trim();
    const passengerName =
        rawPaxName &&
        rawPaxName !== paxId &&
        rawPaxName !== passengerPhone &&
        !["passenger details unavailable", "unknown", "passenger", "n/a", "--", "—"].includes(rawPaxName.toLowerCase())
            ? rawPaxName
            : "";
    const drvId = String(r.driver_id || r.driverId || r.assignedDriverId || r.assigned_driver_id || r.driver?.id || "").trim();
    const rawDrvName = String(r.driver_name || r.driverName || r.driver?.name || "").trim();
    const driverPhone = String(r.driver_phone || r.driverPhone || r.driver?.phone || "").trim();
    const driverName =
        rawDrvName &&
        rawDrvName !== drvId &&
        rawDrvName !== driverPhone &&
        !["unassigned", "unassigned driver", "driver details unavailable", "unknown", "driver", "n/a", "--", "—"].includes(rawDrvName.toLowerCase())
            ? rawDrvName
            : "";
    const driverAssignFallback =
        drvId || String(r.driver_assignment_status || "").toLowerCase() === "unavailable" || rawDrvName === "Driver details unavailable"
            ? `<span class="text-muted fst-italic">Driver details unavailable</span>`
            : `<span class="badge bg-secondary-lt text-secondary">Unassigned</span>`;

    const html = `
        <div class="admin-detail-header-card">
            <div class="admin-drawer-photo admin-drawer-photo-placeholder d-flex align-items-center justify-content-center text-primary">
                <i class="ti ti-route fs-2"></i>
            </div>
            <div class="flex-fill">
                <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div class="admin-drawer-name">Ride #${escapeHtml(String(r.id || "").slice(0, 10))}</div>
                    <div class="d-flex gap-1 align-items-center">
                        ${r.rideType === "share" ? `<span class="badge bg-teal-lt text-teal">Share Auto</span>` : `<span class="badge bg-blue-lt text-blue">${escapeHtml(String(r.vehicleType || r.vehicle_type || "Ride").toUpperCase())}</span>`}
                        ${statusChip(r.status)}
                    </div>
                </div>
                <div class="admin-drawer-sub font-monospace mt-1">ID: ${escapeHtml(r.id || "")} &bull; ${formatTimestamp(r.createdAt)}</div>
            </div>
        </div>

        <div class="admin-detail-card">
            <div class="admin-detail-card-header">
                <span><i class="ti ti-users me-1"></i>Participants</span>
            </div>
            <div class="admin-detail-card-body">
                <div class="admin-detail-grid">
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Passenger</div>
                        <div class="admin-detail-value">${passengerName ? escapeHtml(passengerName) : `<span class="text-muted fst-italic">Passenger details unavailable</span>`}</div>
                        ${passengerPhone ? `<div class="text-secondary small">${escapeHtml(passengerPhone)}</div>` : ""}
                        ${paxId ? `<div class="text-secondary font-monospace" style="font-size:0.7rem;">UID: ${escapeHtml(paxId.slice(0, 14))}</div>` : ""}
                    </div>
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Assigned Driver</div>
                        <div class="admin-detail-value">${driverName ? escapeHtml(driverName) : driverAssignFallback}</div>
                        ${driverPhone ? `<div class="text-secondary small">${escapeHtml(driverPhone)}</div>` : ""}
                        ${r.vehicle_number || r.vehicleNumber ? `<div class="text-secondary small font-monospace">${escapeHtml(r.vehicle_number || r.vehicleNumber)}</div>` : ""}
                    </div>
                </div>
            </div>
        </div>

        <div class="admin-detail-card">
            <div class="admin-detail-card-header">
                <span><i class="ti ti-map-pins me-1"></i>Route &amp; Fare Summary</span>
                <span class="fw-bold text-primary">₹${r.fare || 0}${r.fareAdjustedByAdmin ? " (Adjusted)" : ""}</span>
            </div>
            <div class="admin-detail-card-body">
                <div class="admin-detail-grid">
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Pickup Location</div>
                        <div class="admin-detail-value">${escapeHtml(r.pickup_name || r.pickupName || "Not recorded")}</div>
                    </div>
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Destination</div>
                        <div class="admin-detail-value">${escapeHtml(r.drop_name || r.dropName || "Not recorded")}</div>
                    </div>
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Payment Status</div>
                        <div class="admin-detail-value">${escapeHtml(r.payment_status || r.paymentStatus || "pending")}</div>
                    </div>
                    <div class="admin-detail-field">
                        <div class="admin-detail-label">Cancellation Reason</div>
                        <div class="admin-detail-value">${escapeHtml(r.cancellationReason || (r.status === "cancelled" ? "Not recorded" : "Not applicable"))}</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="admin-detail-card">
            <div class="admin-detail-card-header">
                <span><i class="ti ti-map-2 me-1"></i>Route Map</span>
                <span class="badge bg-blue-lt text-blue">Road Route</span>
            </div>
            <div class="admin-detail-card-body">
                <div id="ride-drawer-map" class="rounded border" style="height: 230px; width: 100%; background: #f8fafc;"></div>
                <div id="ride-drawer-map-readout" class="mt-2"></div>
            </div>
        </div>

        <details class="admin-collapsible" open>
            <summary>
                <span><i class="ti ti-clock me-1"></i>Ride Timeline (${timeline.length})</span>
                <i class="ti ti-chevron-down text-secondary"></i>
            </summary>
            <div class="admin-collapsible-body">
                ${timeline.length ? timeline.map(([label, ts]) => detailRow(label, formatTimestamp(ts))).join("") : `<p class="text-secondary text-center py-2 m-0">No timestamps recorded.</p>`}
            </div>
        </details>

        ${shareHtml}
        ${feedbackHtml}

        <details class="admin-collapsible">
            <summary>
                <span><i class="ti ti-currency-rupee me-1"></i>Adjust Fare</span>
                <i class="ti ti-chevron-down text-secondary"></i>
            </summary>
            <div class="admin-collapsible-body">
                <div class="input-group input-group-sm">
                    <span class="input-group-text">₹</span>
                    <input type="number" min="0" id="ride-fare-input" class="form-control" value="${r.fare || 0}">
                    <button id="ride-fare-save" class="btn btn-primary" type="button">Update Fare</button>
                </div>
            </div>
        </details>

        <details class="admin-collapsible" ${notes.length ? "open" : ""}>
            <summary>
                <span><i class="ti ti-notes me-1"></i>Admin Notes (${notes.length})</span>
                <i class="ti ti-chevron-down text-secondary"></i>
            </summary>
            <div class="admin-collapsible-body">
                <div class="admin-notes-list mb-2">
                    ${notes.length ? notes.map((n) => `<div class="admin-note"><div>${escapeHtml(n.text)}</div><div class="admin-note-meta">${escapeHtml(n.byEmail || "")} \u00b7 ${formatTimestamp(n.at)}</div></div>`).join("") : `<p class="text-secondary small text-center py-2 m-0">No internal notes recorded.</p>`}
                </div>
                <div class="input-group input-group-sm">
                    <input type="text" id="ride-note-input" class="form-control" placeholder="Add an internal note...">
                    <button id="ride-note-save" class="btn btn-outline-secondary" type="button">Add Note</button>
                </div>
            </div>
        </details>
    `;

    const { bodyEl } = showReadOnlyDrawer("Ride Details", html);

    const mapEl = bodyEl.querySelector("#ride-drawer-map");
    const mapReadoutEl = bodyEl.querySelector("#ride-drawer-map-readout");
    if (mapEl) {
        renderRideMap(mapEl, r, {
            isSnapshot: ["completed", "cancelled"].includes(String(r.status || "").toLowerCase()),
            readoutEl: mapReadoutEl,
        });
    }

    const saveFareBtn = document.getElementById("ride-fare-save");
    saveFareBtn?.addEventListener("click", async () => {
        const fare = Number(document.getElementById("ride-fare-input").value);
        if (!(fare >= 0)) return toast("Enter a valid fare.", "error");
        await withButtonSpinner(saveFareBtn, async () => {
            try {
                await adminPatch(`/rides/${r.id}`, { action: "update_fare", fare });
                toast("Fare updated.");
                loadHistory(true);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    });

    const saveNoteBtn = document.getElementById("ride-note-save");
    saveNoteBtn?.addEventListener("click", async () => {
        const notesText = document.getElementById("ride-note-input").value.trim();
        if (!notesText) return;
        await withButtonSpinner(saveNoteBtn, async () => {
            try {
                const result = await adminPatch(`/rides/${r.id}`, { action: "add_note", notes: notesText });
                toast("Note added.");
                openRideDrawer(result.ride);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    });
}

// ---------------------------------------------------------------------
// Passengers
// ---------------------------------------------------------------------

function ensurePassengersTable() {
    if (passengersTable) return passengersTable;
    passengersTable = new DataTable({
        container: $("passengers-table-wrap"),
        exportFileName: "liphtup-passengers",
        searchPlaceholder: "Search passengers by name, phone, email, or UID...",
        getRowId: (r) => r.uid,
        onRowClick: (r) => openPassengerDrawer(r.uid),
        onLoadMore: () => loadPassengers(false),
        onSearch: (q) => {
            passengersSearchQuery = q;
            loadPassengers(true);
        },
        bulkActions: [
            { label: "Restrict selected", onClick: (ids) => bulkPassengerAction(ids, "restrict") },
            { label: "Block selected", onClick: (ids) => bulkPassengerAction(ids, "block") },
        ],
        columns: [
            { key: "name", label: "Name", sortable: true },
            { key: "phone", label: "Phone", sortable: true },
            { key: "email", label: "Email", sortable: true },
            { key: "accountStatus", label: "Status", sortable: true, render: (r) => statusChip(r.accountStatus || "active") },
            {
                key: "actions",
                label: "Action",
                render: (r) => `<select class="form-select form-select-sm w-auto" data-passenger-action="${r.uid}">
                    <option value="">Action...</option>
                    <option value="restrict">Restrict</option>
                    <option value="unrestrict">Unrestrict</option>
                    <option value="block">Block</option>
                    <option value="unblock">Unblock</option>
                </select>`,
            },
        ],
    });
    return passengersTable;
}

async function bulkPassengerAction(ids, action) {
    const confirmed = await showTablerConfirm(`Are you sure you want to ${action} ${ids.length} selected passenger(s)?`, {
        title: `${action.toUpperCase()} Passengers`,
        variant: action === "block" || action === "restrict" ? "warning" : "primary"
    });
    if (!confirmed) return;
    let ok = 0;
    for (const uid of ids) {
        try {
            await adminPatch(`/passengers/${uid}`, { action });
            ok += 1;
        } catch (error) {
            /* continue */
        }
    }
    toast(`${action} applied to ${ok}/${ids.length} passengers.`);
    loadPassengers(true);
}

async function loadPassengers(reset) {
    if (reset) cursors.passengers = null;
    const status = $("passenger-status-filter")?.value || "";
    const table = ensurePassengersTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/passengers", {
            status: status || undefined,
            q: passengersSearchQuery || undefined,
            cursor: reset ? null : cursors.passengers,
        });
        cursors.passengers = data.nextCursor;
        table.setRows(data.passengers, { append: !reset, hasMore: !!data.nextCursor });
        table.container.querySelectorAll("[data-passenger-action]").forEach((select) => {
            select.addEventListener("click", (e) => e.stopPropagation());
            select.addEventListener("change", async () => {
                const action = select.value;
                const uid = select.dataset.passengerAction;
                if (!action) return;
                const confirmed = await showTablerConfirm(`Are you sure you want to ${action} this passenger's account?`, {
                    title: `${action.toUpperCase()} Passenger`,
                    variant: action === "block" || action === "restrict" ? "warning" : "primary"
                });
                if (!confirmed) {
                    select.value = "";
                    return;
                }
                select.disabled = true;
                const spinnerEl = document.createElement("span");
                spinnerEl.className = "spinner-border spinner-border-sm text-primary ms-2 align-middle";
                spinnerEl.setAttribute("role", "status");
                select.insertAdjacentElement("afterend", spinnerEl);
                try {
                    await adminPatch(`/passengers/${uid}`, { action });
                    toast("Passenger updated.");
                    await loadPassengers(true);
                } catch (error) {
                    toast(error.message, "error");
                    select.value = "";
                } finally {
                    select.disabled = false;
                    spinnerEl.remove();
                }
            });
        });
    } catch (error) {
        toast(error.message, "error");
    }
}

async function openPassengerDrawer(uid) {
    if (!uid) return;
    showReadOnlyDrawer(
        "Passenger Profile",
        `<div class="text-center py-5"><div class="spinner-border text-primary mb-2" role="status"></div><div class="text-secondary small">Loading passenger profile...</div></div>`
    );
    try {
        const data = await adminGet(`/passengers/${encodeURIComponent(uid)}`);
        const p = data.passenger || {};
        const stats = data.rideStats || {};
        const wallet = data.wallet || {};
        const recentRides = (data.recentRides || []).slice(0, 10);
        const redeemedCoupons = data.redeemedCoupons || [];
        const safetyEvents = data.safetyEvents || [];
        const notes = Array.isArray(p.adminNotes) ? p.adminNotes : [];

        const recentRidesHtml = recentRides.length
            ? `<div class="table-responsive"><table class="table table-sm table-vcenter card-table table-striped table-hover m-0"><thead><tr><th>Route</th><th>Driver</th><th>Fare</th><th>Status</th><th class="w-1"></th></tr></thead><tbody>${recentRides
                  .map(
                      (r) =>
                          `<tr class="admin-clickable-row" tabindex="0" role="button" data-drawer-ride-id="${escapeAttr(r.id || "")}">
                              <td class="small">${escapeHtml(r.pickup_name || r.pickupName || "Not recorded")} \u2192 ${escapeHtml(r.drop_name || r.dropName || "Not recorded")}</td>
                              <td class="small">${formatRideDriverCell(r)}</td>
                              <td class="small">₹${r.fare || 0}</td>
                              <td>${statusChip(r.status)}</td>
                              <td class="text-end text-muted pe-2"><i class="ti ti-chevron-right admin-row-chevron"></i></td>
                          </tr>`
                  )
                  .join("")}</tbody></table></div>`
            : `<p class="text-secondary text-center py-2 m-0">No rides recorded yet.</p>`;

        const walletTxns = Array.isArray(wallet.recentTransactions)
            ? wallet.recentTransactions
            : Array.isArray(wallet.transactions)
            ? wallet.transactions
            : [];
        const txnsHtml = walletTxns.length
            ? `<div class="list-group list-group-flush border rounded mb-2">${walletTxns
                  .slice(0, 5)
                  .map((tx) => {
                      const rawAmt =
                          tx.amount !== undefined && tx.amount !== null
                              ? Number(tx.amount)
                              : (Number(tx.amountPaise || 0) / 100) *
                                (String(tx.direction || "").toLowerCase() === "debit" ? -1 : 1);
                      const amtRounded = Math.round(rawAmt * 100) / 100;
                      return `<div class="list-group-item py-2 d-flex justify-content-between align-items-center">
                          <div>
                              <div class="fw-medium small">${escapeHtml(tx.description || tx.type || tx.reason || "Transaction")}</div>
                              <div class="text-secondary" style="font-size:0.75rem;">${formatTimestamp(tx.createdAt)}</div>
                          </div>
                          <span class="fw-bold ${amtRounded >= 0 ? "text-success" : "text-danger"}">${amtRounded >= 0 ? "+" : ""}₹${amtRounded}</span>
                      </div>`;
                  })
                  .join("")}</div>`
            : `<p class="text-secondary small mb-2">No recent wallet transactions.</p>`;

        const couponsHtml = redeemedCoupons.length
            ? `<div class="d-flex flex-wrap gap-1 mb-1">${redeemedCoupons
                  .map((c) => `<span class="badge bg-purple-lt text-purple">${escapeHtml(c.code || c.couponCode || c.id)} (₹${c.amount || c.discountAmount || 0})</span>`)
                  .join("")}</div>`
            : `<p class="text-secondary small mb-0">No redeemed coupons.</p>`;

        const safetyHtml = safetyEvents.length
            ? `<div class="list-group list-group-flush border rounded">${safetyEvents
                  .map(
                      (ev) => `<div class="list-group-item py-2 d-flex justify-content-between align-items-center">
                          <div>
                              <span class="badge bg-danger-lt text-danger me-1">${escapeHtml(ev.eventType || "SOS")}</span>
                              <span class="small">${escapeHtml(ev.category || ev.reason || "Incident")}</span>
                          </div>
                          <span class="small text-secondary">${escapeHtml(ev.status || "open")} &bull; ${formatTimestamp(ev.createdAt)}</span>
                      </div>`
                  )
                  .join("")}</div>`
            : `<p class="text-secondary small m-0">No SOS or safety incidents recorded.</p>`;

        const html = `
            <div class="admin-detail-header-card">
                ${p.profilePhotoUrl ? `<img src="${escapeAttr(p.profilePhotoUrl)}" class="admin-drawer-photo" alt="">` : `<div class="admin-drawer-photo admin-drawer-photo-placeholder d-flex align-items-center justify-content-center text-secondary"><i class="ti ti-user fs-2"></i></div>`}
                <div class="flex-fill">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                        <div class="admin-drawer-name">${escapeHtml(p.name || "Unnamed Passenger")}</div>
                        <div>${statusChip(p.accountStatus || "active")}</div>
                    </div>
                    <div class="admin-drawer-sub font-monospace mt-1">UID: ${escapeHtml(p.uid || uid)}</div>
                </div>
            </div>

            <div class="d-flex flex-wrap gap-1 mb-3">
                ${actionBtn("restrict", '<i class="ti ti-alert-circle me-1"></i>Restrict', "btn-warning")}
                ${actionBtn("unrestrict", '<i class="ti ti-check me-1"></i>Unrestrict', "btn-outline-success")}
                ${actionBtn("block", '<i class="ti ti-ban me-1"></i>Block', "btn-danger")}
                ${actionBtn("unblock", '<i class="ti ti-lock-open me-1"></i>Unblock', "btn-outline-primary")}
                <button type="button" id="passenger-drawer-grant-credit-toggle" class="btn btn-sm btn-outline-teal">
                    <i class="ti ti-wallet me-1"></i>Grant Wallet Credit
                </button>
            </div>

            <div id="passenger-drawer-grant-credit-box" class="card bg-teal-lt border-teal p-2 mb-3 d-none">
                <div class="fw-bold small text-dark mb-2"><i class="ti ti-coin me-1"></i>Grant Promotional / Refund Credit</div>
                <div class="row g-2 mb-2">
                    <div class="col-5">
                        <input type="number" id="drawer-credit-amount" class="form-control form-control-sm" min="1" max="10000" step="1" placeholder="Amount (₹)">
                    </div>
                    <div class="col-7">
                        <select id="drawer-credit-tag" class="form-select form-select-sm">
                            <option value="Bonus" selected>Bonus</option>
                            <option value="Refund">Refund</option>
                            <option value="Changes settlement">Changes settlement</option>
                            <option value="Conflict settlement">Conflict settlement</option>
                        </select>
                    </div>
                </div>
                <div class="input-group input-group-sm">
                    <input type="text" id="drawer-credit-desc" class="form-control" placeholder="Reason / note (optional)">
                    <button type="button" id="drawer-credit-submit" class="btn btn-teal">Grant</button>
                </div>
            </div>

            <div class="admin-detail-card">
                <div class="admin-detail-card-header">
                    <span><i class="ti ti-address-book me-1"></i>Contact &amp; Account Info</span>
                </div>
                <div class="admin-detail-card-body">
                    <div class="admin-detail-grid">
                        <div class="admin-detail-field"><div class="admin-detail-label">Phone</div><div class="admin-detail-value">${escapeHtml(p.phone || "Not recorded")}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Email</div><div class="admin-detail-value">${escapeHtml(p.email || "Not recorded")}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Joined</div><div class="admin-detail-value">${formatTimestamp(p.createdAt) || "Not recorded"}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Wallet Balance</div><div class="admin-detail-value fw-bold text-success">₹${wallet.balance ?? p.walletBalance ?? 0}</div></div>
                    </div>
                </div>
            </div>

            <div class="admin-detail-card">
                <div class="admin-detail-card-header">
                    <span><i class="ti ti-chart-bar me-1"></i>Ride Statistics</span>
                    <span class="badge bg-blue-lt text-blue">₹${stats.totalSpent ?? 0} spent</span>
                </div>
                <div class="admin-detail-card-body">
                    <div class="admin-detail-grid">
                        <div class="admin-detail-field"><div class="admin-detail-label">Total Rides</div><div class="admin-detail-value fw-bold">${stats.totalRides ?? 0}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Completed Rides</div><div class="admin-detail-value text-success fw-bold">${stats.completedRides ?? 0}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Cancelled by Passenger</div><div class="admin-detail-value">${stats.cancelledByPassenger ?? 0}</div></div>
                        <div class="admin-detail-field"><div class="admin-detail-label">Cancelled by Driver</div><div class="admin-detail-value">${stats.cancelledByDriver ?? 0}</div></div>
                    </div>
                </div>
            </div>

            <details class="admin-collapsible" open>
                <summary>
                    <span><i class="ti ti-history me-1"></i>Recent Rides (Latest ${recentRides.length} of max 10)</span>
                    <i class="ti ti-chevron-down text-secondary"></i>
                </summary>
                <div class="admin-collapsible-body p-0">
                    ${recentRidesHtml}
                </div>
            </details>

            <details class="admin-collapsible">
                <summary>
                    <span><i class="ti ti-wallet me-1"></i>Wallet Activity &amp; Coupons</span>
                    <i class="ti ti-chevron-down text-secondary"></i>
                </summary>
                <div class="admin-collapsible-body">
                    ${txnsHtml}
                    <div class="fw-medium small mb-1">Redeemed Coupons:</div>
                    ${couponsHtml}
                </div>
            </details>

            <details class="admin-collapsible" ${safetyEvents.length ? "open" : ""}>
                <summary>
                    <span><i class="ti ti-shield-exclamation me-1"></i>Safety &amp; SOS History (${safetyEvents.length})</span>
                    <i class="ti ti-chevron-down text-secondary"></i>
                </summary>
                <div class="admin-collapsible-body">
                    ${safetyHtml}
                </div>
            </details>

            <details class="admin-collapsible" ${notes.length ? "open" : ""}>
                <summary>
                    <span><i class="ti ti-notes me-1"></i>Admin Notes (${notes.length})</span>
                    <i class="ti ti-chevron-down text-secondary"></i>
                </summary>
                <div class="admin-collapsible-body">
                    <div class="admin-notes-list mb-2">
                        ${notes.length ? notes.map((n) => `<div class="admin-note"><div>${escapeHtml(n.text)}</div><div class="admin-note-meta">${escapeHtml(n.byEmail || "")} \u00b7 ${formatTimestamp(n.at)}</div></div>`).join("") : `<p class="text-secondary small text-center py-2 m-0">No internal notes recorded.</p>`}
                    </div>
                    <div class="input-group input-group-sm">
                        <input type="text" id="passenger-note-input" class="form-control" placeholder="Add an internal note...">
                        <button id="passenger-note-save" class="btn btn-outline-secondary" type="button">Add Note</button>
                    </div>
                </div>
            </details>
        `;

        const { bodyEl } = showReadOnlyDrawer(p.name || "Passenger Profile", html);

        bodyEl.querySelectorAll("[data-drawer-ride-id]").forEach((row) => {
            const activate = () => {
                const rId = row.dataset.drawerRideId;
                const matched = recentRides.find((x) => x.id === rId);
                if (matched) openRideDrawer(matched);
            };
            row.addEventListener("click", activate);
            row.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                }
            });
        });

        bodyEl.querySelectorAll("[data-action]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const action = btn.dataset.action;
                const confirmed = await showTablerConfirm(
                    `Are you sure you want to ${action} passenger ${p.name || uid}?`,
                    {
                        title: `${action.toUpperCase()} Passenger`,
                        variant: action === "block" || action === "restrict" ? "danger" : "primary",
                    }
                );
                if (!confirmed) return;
                await withButtonSpinner(btn, async () => {
                    try {
                        await adminPatch(`/passengers/${encodeURIComponent(uid)}`, { action });
                        toast(`Passenger status updated (${action}).`);
                        openPassengerDrawer(uid);
                        loadPassengers(true);
                    } catch (err) {
                        toast(err.message, "error");
                    }
                });
            });
        });

        const creditToggleBtn = bodyEl.querySelector("#passenger-drawer-grant-credit-toggle");
        const creditBox = bodyEl.querySelector("#passenger-drawer-grant-credit-box");
        creditToggleBtn?.addEventListener("click", () => {
            creditBox?.classList.toggle("d-none");
            if (!creditBox?.classList.contains("d-none")) {
                bodyEl.querySelector("#drawer-credit-amount")?.focus();
            }
        });

        const creditSubmitBtn = bodyEl.querySelector("#drawer-credit-submit");
        creditSubmitBtn?.addEventListener("click", async () => {
            const amount = parseFloat(bodyEl.querySelector("#drawer-credit-amount")?.value || "0");
            const tag = bodyEl.querySelector("#drawer-credit-tag")?.value || "Bonus";
            const description = bodyEl.querySelector("#drawer-credit-desc")?.value?.trim() || "Admin drawer credit";
            if (!amount || amount <= 0) {
                return toast("Enter a valid credit amount greater than ₹0.", "error");
            }
            await withButtonSpinner(creditSubmitBtn, async () => {
                try {
                    const res = await adminPost("/wallet/passenger/grant-credit", {
                        passengerId: uid,
                        amount,
                        tags: [tag],
                        description,
                    });
                    toast(res.message || `Granted ₹${amount} wallet credit.`);
                    openPassengerDrawer(uid);
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });

        const noteBtn = bodyEl.querySelector("#passenger-note-save");
        noteBtn?.addEventListener("click", async () => {
            const text = bodyEl.querySelector("#passenger-note-input")?.value?.trim();
            if (!text) return;
            await withButtonSpinner(noteBtn, async () => {
                try {
                    await adminPatch(`/passengers/${encodeURIComponent(uid)}`, { action: "add_note", notes: text });
                    toast("Note added to passenger profile.");
                    openPassengerDrawer(uid);
                } catch (err) {
                    toast(err.message, "error");
                }
            });
        });
    } catch (error) {
        showReadOnlyDrawer("Passenger Profile", `<p class="text-danger text-center py-4 my-0">${escapeHtml(error.message)}</p>`);
    }
}

// ---------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------

let ridesDailyChart = null;
let analyticsCancelChart = null;
let analyticsVehicleChart = null;
let currentAnalyticsDays = 14;
let analyticsEventsInitialized = false;

function initAnalyticsEvents() {
    if (analyticsEventsInitialized) return;
    analyticsEventsInitialized = true;
    document.querySelectorAll(".analytics-period-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            document.querySelectorAll(".analytics-period-btn").forEach((b) => {
                b.className = "btn btn-sm btn-outline-secondary analytics-period-btn";
            });
            btn.className = "btn btn-sm btn-primary active analytics-period-btn";
            const days = Number(btn.dataset.days || 14);
            currentAnalyticsDays = days;
            await withButtonSpinner(btn, () => loadAnalytics(days));
        });
    });
}

async function loadAnalytics(days = currentAnalyticsDays) {
    initAnalyticsEvents();
    try {
        const data = await adminGet("/analytics/rides-daily", { days }, { cacheable: true });
        const summary = data.summary || {};
        const cancelBd = data.cancellationBreakdown || {};
        const vehicleSplit = data.vehicleSplit || {};

        // 1. KPI Summary Cards
        if ($("analytics-kpi-total-rides")) $("analytics-kpi-total-rides").textContent = summary.totalRides ?? 0;
        if ($("analytics-kpi-distance")) $("analytics-kpi-distance").textContent = `${summary.totalDistanceKm ?? 0} km total distance`;
        if ($("analytics-kpi-completion-rate")) $("analytics-kpi-completion-rate").textContent = `${summary.completionRate ?? 0}%`;
        if ($("analytics-kpi-completed-count")) $("analytics-kpi-completed-count").textContent = `${summary.completedRides ?? 0} completed`;
        if ($("analytics-kpi-cancel-rate")) $("analytics-kpi-cancel-rate").textContent = `${summary.cancellationRate ?? 0}%`;
        if ($("analytics-kpi-cancelled-count")) $("analytics-kpi-cancelled-count").textContent = `${summary.cancelledRides ?? 0} cancelled`;
        if ($("analytics-kpi-revenue")) $("analytics-kpi-revenue").textContent = `₹${summary.totalFare ?? 0}`;
        if ($("analytics-kpi-avg-fare")) $("analytics-kpi-avg-fare").textContent = `₹${summary.avgFarePerCompletedRide ?? 0} avg / ride`;

        // 2. Daily Rides & Fare Chart
        const labels = (data.days || []).map((d) => d.date.slice(5));
        const rides = (data.days || []).map((d) => d.rides);
        const fare = (data.days || []).map((d) => d.fare);
        const ctx = document.getElementById("rides-daily-chart");
        if (ctx && window.Chart) {
            if (ridesDailyChart) ridesDailyChart.destroy();
            ridesDailyChart = new window.Chart(ctx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        { label: "Total Rides", data: rides, backgroundColor: "#206bc4", yAxisID: "y" },
                        { label: "Fare collected (₹)", data: fare, type: "line", borderColor: "#2fb344", yAxisID: "y1" },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: { position: "left", beginAtZero: true },
                        y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } },
                    },
                },
            });
        }

        // 3. Cancellation Breakdown Chart & Reasons
        const cancelCtx = document.getElementById("analytics-cancellation-chart");
        if (cancelCtx && window.Chart) {
            if (analyticsCancelChart) analyticsCancelChart.destroy();
            analyticsCancelChart = new window.Chart(cancelCtx, {
                type: "doughnut",
                data: {
                    labels: ["By Passenger", "By Driver", "Admin / System"],
                    datasets: [
                        {
                            data: [
                                cancelBd.byPassenger || 0,
                                cancelBd.byDriver || 0,
                                cancelBd.byAdminOrSystem || 0,
                            ],
                            backgroundColor: ["#f59f00", "#d63939", "#64748b"],
                            borderWidth: 0,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: "65%",
                    plugins: { legend: { position: "bottom" } },
                },
            });
        }

        const reasonsEl = $("analytics-cancel-reasons-list");
        if (reasonsEl) {
            const topReasons = Array.isArray(cancelBd.topReasons) ? cancelBd.topReasons : [];
            reasonsEl.innerHTML = topReasons.length
                ? `<div class="fw-semibold text-dark mb-1">Top Cancellation Reasons:</div>` +
                  topReasons
                      .map(
                          (r) =>
                              `<div class="d-flex justify-content-between"><span>${escapeHtml(r.reason)}</span><span class="fw-bold">${r.count}</span></div>`
                      )
                      .join("")
                : `<div class="text-secondary">No cancellation reasons recorded in this window.</div>`;
        }

        // 4. Vehicle & Ride Type Split Chart
        const vehicleCtx = document.getElementById("analytics-vehicle-split-chart");
        const byVeh = vehicleSplit.byVehicle || {};
        const byType = vehicleSplit.byRideType || {};
        if (vehicleCtx && window.Chart) {
            if (analyticsVehicleChart) analyticsVehicleChart.destroy();
            analyticsVehicleChart = new window.Chart(vehicleCtx, {
                type: "doughnut",
                data: {
                    labels: ["Auto", "Bike", "Car"],
                    datasets: [
                        {
                            data: [byVeh.auto || 0, byVeh.bike || 0, byVeh.car || 0],
                            backgroundColor: ["#2fb344", "#0054a6", "#7950f2"],
                            borderWidth: 0,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: "65%",
                    plugins: { legend: { position: "bottom" } },
                },
            });
        }

        const splitSummaryEl = $("analytics-vehicle-split-summary");
        if (splitSummaryEl) {
            const singleCount = byType.single || 0;
            const shareCount = byType.share || 0;
            const totalTyped = singleCount + shareCount;
            const sharePct = totalTyped ? Math.round((shareCount / totalTyped) * 100) : 0;
            splitSummaryEl.innerHTML = `
                <div class="d-flex justify-content-between mb-1">
                    <span>Single / Private Rides:</span>
                    <span class="fw-bold text-dark">${singleCount} (${totalTyped ? 100 - sharePct : 0}%)</span>
                </div>
                <div class="d-flex justify-content-between">
                    <span>Share Auto Rides:</span>
                    <span class="fw-bold text-teal">${shareCount} (${sharePct}%)</span>
                </div>
            `;
        }
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Broadcast & Push Notification Center (Priority 2)
// ---------------------------------------------------------------------

let notificationsEventsInitialized = false;
let selectedBroadcastIds = new Set();
let cachedBroadcastRows = [];

function updateBroadcastBulkBar() {
    const countBadge = $("broadcast-selected-count");
    const deleteBtn = $("broadcast-bulk-delete-btn");
    const selectAll = $("broadcast-select-all");
    const count = selectedBroadcastIds.size;
    if (countBadge) {
        countBadge.textContent = `${count} selected`;
        countBadge.classList.toggle("d-none", count === 0);
    }
    if (deleteBtn) {
        deleteBtn.classList.toggle("d-none", count === 0);
    }
    if (selectAll) {
        selectAll.checked = cachedBroadcastRows.length > 0 && cachedBroadcastRows.every((b) => selectedBroadcastIds.has(b.id));
    }
}

function initNotificationsEvents() {
    if (notificationsEventsInitialized) return;
    notificationsEventsInitialized = true;

    const targetSelect = $("broadcast-target-select");
    const uidWrap = $("broadcast-target-uid-wrap");
    targetSelect?.addEventListener("change", () => {
        const isSpecific = targetSelect.value === "user" || targetSelect.value === "specific_user";
        uidWrap?.classList.toggle("d-none", !isSpecific);
    });

    $("broadcast-history-refresh-btn")?.addEventListener("click", (e) => {
        withButtonSpinner(e.currentTarget, () => loadNotificationsCenter());
    });
    $("btn-refresh-broadcasts")?.addEventListener("click", (e) => {
        withButtonSpinner(e.currentTarget, () => loadNotificationsCenter());
    });

    $("broadcast-select-all")?.addEventListener("change", (e) => {
        const checked = e.target.checked;
        cachedBroadcastRows.forEach((b) => {
            if (checked) selectedBroadcastIds.add(b.id);
            else selectedBroadcastIds.delete(b.id);
        });
        document.querySelectorAll("[data-select-broadcast]").forEach((cb) => {
            cb.checked = checked;
        });
        updateBroadcastBulkBar();
    });

    $("broadcast-bulk-delete-btn")?.addEventListener("click", async (e) => {
        const ids = Array.from(selectedBroadcastIds);
        if (!ids.length) return;
        const confirmed = await showTablerConfirm(
            `Permanently delete ${ids.length} selected broadcast history record(s)? This cannot be undone.`,
            {
                title: "Delete Selected Broadcasts",
                confirmText: `Delete (${ids.length})`,
                variant: "danger",
            }
        );
        if (!confirmed) return;
        await withButtonSpinner(e.currentTarget, async () => {
            try {
                const res = await adminPost("/notifications/broadcasts/bulk-delete", { ids });
                ids.forEach((id) => selectedBroadcastIds.delete(id));
                toast(`Deleted ${res.deletedCount || ids.length} broadcast record(s).`);
                await loadNotificationsCenter();
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });

    const form = $("form-admin-broadcast");
    form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const target = $("broadcast-target-select")?.value || "all";
        const targetUid = $("broadcast-target-uid")?.value?.trim() || "";
        const category = $("broadcast-category-select")?.value || "announcement";
        const deepLink = $("broadcast-deeplink-input")?.value?.trim() || "/";
        const channelId = $("broadcast-channel-select")?.value || "general";
        const title = $("broadcast-title-input")?.value?.trim() || "";
        const body = $("broadcast-body-input")?.value?.trim() || "";
        const isSpecific = target === "user" || target === "specific_user";

        if (!title || !body) {
            return toast("Enter both a notification title and message body.", "error");
        }
        if (isSpecific && !targetUid) {
            return toast("Enter a Target User UID, phone, or email for specific user delivery.", "error");
        }

        const confirmed = await showTablerConfirm(
            `Send push & in-app notification "${title}" to ${target.replace(/_/g, " ")}?`,
            {
                title: "Confirm Broadcast Dispatch",
                variant: "primary",
                confirmText: "Send Notification",
            }
        );
        if (!confirmed) return;

        const submitBtn = $("broadcast-submit-btn") || $("btn-send-broadcast");
        await withButtonSpinner(submitBtn, async () => {
            try {
                const res = await adminPost("/notifications/broadcast", {
                    target,
                    targetUid: isSpecific ? targetUid : undefined,
                    category,
                    deepLink,
                    channelId,
                    title,
                    body,
                });
                const bInfo = res.broadcast || res;
                const recCount = bInfo.recipientCount ?? 0;
                const delivCount = bInfo.deliveredCount ?? bInfo.sentCount ?? 0;
                const qCount = bInfo.queuedCount ?? Math.max(0, recCount - delivCount);
                if (delivCount > 0 && qCount === 0) {
                    toast(`Broadcast delivered to ${delivCount} recipient(s).`);
                } else if (delivCount > 0 && qCount > 0) {
                    toast(`Delivered to ${delivCount} online user(s); scheduled for ${qCount} user(s) when online.`);
                } else {
                    toast(`Broadcast scheduled for ${recCount} recipient(s) — will deliver immediately when online.`);
                }
                if ($("broadcast-title-input")) $("broadcast-title-input").value = "";
                if ($("broadcast-body-input")) $("broadcast-body-input").value = "";
                await loadNotificationsCenter();
                setTimeout(() => {
                    if (currentSection === "notifications") loadNotificationsCenter();
                }, 3500);
                setTimeout(() => {
                    if (currentSection === "notifications") loadNotificationsCenter();
                }, 8500);
            } catch (err) {
                toast(err.message, "error");
            }
        });
    });
}

async function loadNotificationsCenter() {
    initNotificationsEvents();
    const tbody = $("admin-broadcast-history-tbody") || $("broadcast-history-tbody");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small"><span class="spinner-border spinner-border-sm me-2"></span>Loading broadcast history...</td></tr>`;
    try {
        const data = await adminGet("/notifications/broadcasts", { limit: 30 }, { cacheable: false });
        const broadcasts = data.broadcasts || [];
        cachedBroadcastRows = broadcasts;
        const validIds = new Set(broadcasts.map((b) => b.id));
        for (const id of Array.from(selectedBroadcastIds)) {
            if (!validIds.has(id)) selectedBroadcastIds.delete(id);
        }
        updateBroadcastBulkBar();

        if (broadcasts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-secondary small">No broadcasts dispatched yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = broadcasts
            .map((b) => {
                const targetLabel = String(b.target || "all").replace(/_/g, " ");
                const recipientCount = b.recipientCount ?? 0;
                const sentCount = b.sentCount ?? 0;
                const deliveredCount = Math.max(b.deliveredCount ?? 0, sentCount > 0 ? Math.min(recipientCount, sentCount) : 0);
                const queuedCount = b.queuedCount !== undefined ? b.queuedCount : Math.max(0, recipientCount - deliveredCount);
                let deliveryBadge = "";
                if (recipientCount === 0) {
                    deliveryBadge = `<span class="badge bg-secondary-lt text-secondary">No recipients</span>`;
                } else if (deliveredCount >= recipientCount) {
                    deliveryBadge = `<span class="badge bg-green-lt text-green"><i class="ti ti-check me-1"></i>${deliveredCount}/${recipientCount} Delivered</span>`;
                } else if (deliveredCount > 0) {
                    deliveryBadge = `
                        <span class="badge bg-green-lt text-green me-1"><i class="ti ti-check me-1"></i>${deliveredCount} Delivered</span>
                        <span class="badge bg-azure-lt text-azure"><i class="ti ti-clock me-1"></i>${queuedCount} Scheduled (Online)</span>
                    `;
                } else {
                    deliveryBadge = `<span class="badge bg-azure-lt text-azure" title="Queued in inbox — delivers automatically when recipient is online on Web or App"><i class="ti ti-clock-play me-1"></i>Scheduled (${queuedCount} pending online)</span>`;
                }
                const pushDetail = sentCount > 0
                    ? `<div class="text-secondary small mt-1">${sentCount} instant push sent</div>`
                    : `<div class="text-secondary small mt-1">Auto-delivers via Web/App inbox</div>`;
                const isSelected = selectedBroadcastIds.has(b.id);
                return `
                    <tr>
                        <td>
                            <input type="checkbox" class="form-check-input m-0 align-middle" data-select-broadcast="${escapeAttr(b.id)}" ${isSelected ? "checked" : ""} aria-label="Select broadcast">
                        </td>
                        <td>
                            <div class="fw-bold text-dark">${escapeHtml(b.title || "")}</div>
                            <div class="text-secondary small text-truncate" style="max-width: 280px;">${escapeHtml(b.body || "")}</div>
                        </td>
                        <td>
                            <span class="badge bg-blue-lt text-blue text-uppercase">${escapeHtml(targetLabel)}</span>
                            ${b.targetInput || b.targetUid ? `<div class="text-secondary small font-monospace mt-1">${escapeHtml(String(b.targetInput || b.targetUid).slice(0, 18))}</div>` : ""}
                        </td>
                        <td>
                            <div class="d-flex align-items-center flex-wrap gap-1">
                                <span class="fw-semibold text-dark me-1">${recipientCount} ${recipientCount === 1 ? "user" : "users"}</span>
                                ${deliveryBadge}
                            </div>
                            ${pushDetail}
                        </td>
                        <td class="text-secondary small">${escapeHtml(b.sentByEmail || "Admin")}</td>
                        <td class="text-secondary small">${formatTimestamp(b.createdAt)}</td>
                        <td class="text-end">
                            <button type="button" class="btn btn-sm btn-ghost-danger" data-delete-broadcast="${escapeAttr(b.id)}" title="Delete broadcast record">
                                <i class="ti ti-trash"></i>
                            </button>
                        </td>
                    </tr>
                `;
            })
            .join("");

        tbody.querySelectorAll("[data-select-broadcast]").forEach((cb) => {
            cb.addEventListener("change", () => {
                const id = cb.dataset.selectBroadcast;
                if (cb.checked) selectedBroadcastIds.add(id);
                else selectedBroadcastIds.delete(id);
                updateBroadcastBulkBar();
            });
        });

        tbody.querySelectorAll("[data-delete-broadcast]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.deleteBroadcast;
                const confirmed = await showTablerConfirm(
                    "Permanently delete this broadcast history record? This action cannot be undone.",
                    {
                        title: "Delete Broadcast Record",
                        confirmText: "Delete",
                        variant: "danger",
                    }
                );
                if (!confirmed) return;
                await withButtonSpinner(btn, async () => {
                    try {
                        await adminDelete(`/notifications/broadcasts/${encodeURIComponent(id)}`);
                        selectedBroadcastIds.delete(id);
                        toast("Broadcast record deleted.");
                        await loadNotificationsCenter();
                    } catch (err) {
                        toast(err.message, "error");
                    }
                });
            });
        });
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-danger small">${escapeHtml(error.message)}</td></tr>`;
    }
}

// ---------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------

function ensureAuditTable() {
    if (auditTable) return auditTable;
    auditTable = new DataTable({
        container: $("audit-log-table-wrap"),
        exportFileName: "liphtup-audit-log",
        getRowId: (r) => r.id,
        onLoadMore: () => loadAuditLog(false),
        columns: [
            {
                key: "adminEmail",
                label: "Admin & Role",
                sortable: true,
                render: (r) => {
                    const role = String(r.adminRole || "super_admin").toLowerCase();
                    const badgeClass = {
                        super_admin: "bg-purple-lt text-purple",
                        manager: "bg-warning-lt text-warning",
                        admin: "bg-blue-lt text-blue"
                    }[role] || "bg-secondary-lt text-secondary";
                    const roleLabel = {
                        super_admin: "Super Admin",
                        manager: "Manager",
                        admin: "Admin"
                    }[role] || "Admin";
                    return `<div><strong>${escapeHtml(r.adminEmail || "System")}</strong></div>
                            <span class="badge ${badgeClass} small ms-0 mt-1">${roleLabel}</span>`;
                }
            },
            { key: "action", label: "Action", sortable: true, render: (r) => `<span class="badge bg-secondary-lt text-dark font-monospace">${escapeHtml(r.action || "")}</span>` },
            { key: "targetType", label: "Target Type", sortable: true, render: (r) => escapeHtml(r.targetType || "") },
            { key: "notes", label: "Details / Notes", render: (r) => escapeHtml(r.notes || r.targetId || "") },
            { key: "createdAt", label: "When", sortable: true, render: (r) => formatTimestamp(r.createdAt) },
        ],
    });
    return auditTable;
}

async function loadAuditLog(reset) {
    if (reset) cursors.audit = null;
    const roleFilter = $("audit-role-filter")?.value || "";
    const table = ensureAuditTable();
    if (reset) table.setLoading(true);
    try {
        const data = await adminGet("/audit-logs", { role: roleFilter, cursor: reset ? null : cursors.audit });
        cursors.audit = data.nextCursor;
        table.setRows(data.logs, { append: !reset, hasMore: !!data.nextCursor });
    } catch (error) {
        toast(error.message, "error");
    }
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function detailRow(label, value) {
    const isHtml = typeof value === "string" && (
        value.includes("<span") ||
        value.includes("<i ") ||
        value.includes("<div") ||
        value.includes("<badge") ||
        value.includes("<a ") ||
        value.includes("<strong") ||
        value.includes("<em")
    );
    const rendered = isHtml ? (value ?? "") : escapeHtml(value ?? "");
    return `<div class="admin-detail-row"><span>${escapeHtml(label)}</span><span>${rendered}</span></div>`;
}

const STATUS_TONES = {
    pending: "amber", accepted: "blue", arrived: "blue", started: "blue", en_route: "blue",
    completed: "green", cancelled_by_passenger: "red", cancelled_by_driver: "red",
    pending_review: "amber", approved: "green", rejected: "red", suspended: "red", blocked: "red",
    active: "green", restricted: "amber",
};

function statusChip(status) {
    const value = String(status || "").trim();
    const tone = STATUS_TONES[value] || "grey";
    const label = value ? value.replace(/_/g, " ") : "unknown";
    
    const iconMap = {
        green: '<i class="ti ti-circle-check me-1"></i>',
        amber: '<i class="ti ti-clock me-1"></i>',
        blue: '<i class="ti ti-navigation me-1"></i>',
        red: '<i class="ti ti-circle-x me-1"></i>',
        grey: ''
    };
    const badgeClass = {
        green: "bg-success-lt text-success",
        amber: "bg-warning-lt text-warning",
        blue: "bg-info-lt text-info",
        red: "bg-danger-lt text-danger",
        grey: "bg-secondary-lt text-secondary"
    }[tone] || "bg-secondary-lt text-secondary";

    return `<span class="badge ${badgeClass}">${iconMap[tone] || ''}${escapeHtml(label)}</span>`;
}

function actionBtn(action, label, btnClass = "btn-outline-secondary") {
    return `<button class="btn ${btnClass} btn-sm me-1 mb-1" data-action="${action}" type="button">${label}</button>`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}
function escapeAttr(value) {
    return escapeHtml(value);
}

function formatTimestamp(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
