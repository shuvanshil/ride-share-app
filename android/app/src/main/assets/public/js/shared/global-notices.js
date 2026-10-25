/**
 * LiphtUp Global Notices Client Service
 *
 * Displays scheduled, audience-targeted in-app modal notices to authenticated
 * drivers and passengers without interrupting initial page loading.
 *
 * Visual design matches media_1792951826760_66451992.jpg (English only).
 */

import { auth, db } from '../platform/firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const UNPROTECTED_PAGES = [
    'login.html',
    'driver-signup.html',
    'about.html',
    'contact.html',
    'help.html',
    'privacy.html',
    'terms.html',
    'offline.html',
    'admin-access-denied.html'
];

let activeModalEl = null;
let activeNoticeTimer = null;
let firestoreUnsubscribe = null;
let currentDisplayedNoticeId = null;
let currentDisplayedNoticeVersion = null;

function isUnprotectedRoute() {
    const path = (window.location.pathname || '').toLowerCase();
    if (path.includes('/admin')) return true;
    return UNPROTECTED_PAGES.some((page) => path.includes(page));
}

function resolveUserRole() {
    if (window.LIPHTUP_USER_ROLE) return window.LIPHTUP_USER_ROLE.toLowerCase();
    try {
        const cached = JSON.parse(sessionStorage.getItem("liphtup_user_profile") || localStorage.getItem("liphtup_user_profile") || "null");
        if (cached?.role) return String(cached.role).toLowerCase();
    } catch (_) {}
    const path = (window.location.pathname || '').toLowerCase();
    if (path.includes('driver')) return 'driver';
    return 'passenger';
}

function ensureModalStyles() {
    if (document.getElementById('liphtup-global-notice-styles')) return;

    const style = document.createElement('style');
    style.id = 'liphtup-global-notice-styles';
    style.textContent = `
        .lup-notice-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.6);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            box-sizing: border-box;
            animation: lupNoticeFadeIn 0.25s ease-out forwards;
        }
        @keyframes lupNoticeFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        .lup-notice-card {
            background: #ffffff;
            border-radius: 24px;
            width: 100%;
            max-width: 400px;
            padding: 32px 24px 28px 24px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            position: relative;
            text-align: center;
            box-sizing: border-box;
            transform: scale(0.96);
            animation: lupNoticePopIn 0.25s ease-out forwards;
        }
        @keyframes lupNoticePopIn {
            from { transform: scale(0.92); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }
        .lup-notice-close-x {
            position: absolute;
            top: 16px;
            right: 16px;
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: #f1f5f9;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #334155;
            transition: background 0.15s ease, transform 0.1s ease;
            padding: 0;
        }
        .lup-notice-close-x:hover {
            background: #e2e8f0;
        }
        .lup-notice-close-x:active {
            transform: scale(0.92);
        }
        .lup-notice-icon-circle {
            width: 88px;
            height: 88px;
            border-radius: 50%;
            background: #e0f2fe;
            margin: 0 auto 20px auto;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .lup-notice-title {
            font-size: 20px;
            font-weight: 700;
            color: #0f172a;
            margin: 0 0 12px 0;
            line-height: 1.35;
            letter-spacing: -0.01em;
        }
        .lup-notice-description {
            font-size: 14.5px;
            color: #475569;
            line-height: 1.55;
            margin: 0 0 20px 0;
            word-break: break-word;
            max-height: 220px;
            overflow-y: auto;
        }
        .lup-notice-callout {
            background: #f0f7ff;
            border: 1px solid #dbeafe;
            border-radius: 12px;
            padding: 12px 14px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
            text-align: left;
        }
        .lup-notice-callout-icon {
            flex-shrink: 0;
            width: 20px;
            height: 20px;
            color: #0284c7;
        }
        .lup-notice-callout-text {
            font-size: 13.5px;
            color: #0369a1;
            font-weight: 500;
            line-height: 1.4;
            margin: 0;
        }
        .lup-notice-btn-close {
            width: 100%;
            height: 48px;
            background: #0066f5;
            color: #ffffff;
            font-size: 16px;
            font-weight: 600;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            transition: background 0.15s ease, transform 0.1s ease;
        }
        .lup-notice-btn-close:hover {
            background: #0052cc;
        }
        .lup-notice-btn-close:active {
            transform: scale(0.98);
        }
        .lup-notice-lock-badge {
            font-size: 12px;
            color: #64748b;
            font-weight: 500;
            margin-top: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
    `;
    document.head.appendChild(style);
}

function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function parseNoticeTimestamp(isoStr) {
    try {
        if (!isoStr) return 0;
        return new Date(isoStr).getTime();
    } catch (_) {
        return 0;
    }
}

export function dismissNoticeModal() {
    if (activeNoticeTimer) {
        clearTimeout(activeNoticeTimer);
        activeNoticeTimer = null;
    }
    if (activeModalEl) {
        activeModalEl.remove();
        activeModalEl = null;
    }
    try {
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.overflow = '';
        }
    } catch (_) {}
    currentDisplayedNoticeId = null;
    currentDisplayedNoticeVersion = null;
}

function renderNoticeModal(notice, userUid, userRole) {
    ensureModalStyles();

    const noticeId = notice.noticeId || notice.id;
    const version = Number(notice.version || 1);
    const closable = notice.closable !== false;

    // Pick content based on user role and driverContentEnabled
    const isDriver = (userRole === "driver");
    const useDriverContent = isDriver && !!notice.driverContentEnabled;

    const titleText = (useDriverContent ? (notice.driverTitle || notice.title) : notice.title) || "Important Update";
    const descText = (useDriverContent ? (notice.driverDescription || notice.description) : notice.description) || "";
    const calloutText = (useDriverContent ? (notice.driverCallout || notice.callout) : notice.callout) || "";

    // If modal already shows this exact notice and version, don't re-render
    if (activeModalEl && currentDisplayedNoticeId === noticeId && currentDisplayedNoticeVersion === version) {
        return;
    }

    // Dismiss any existing modal before showing new one
    dismissNoticeModal();

    currentDisplayedNoticeId = noticeId;
    currentDisplayedNoticeVersion = version;

    try {
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.overflow = 'hidden';
        }
    } catch (_) {}

    const backdrop = document.createElement('div');
    backdrop.className = 'lup-notice-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'lup-notice-dialog-title');

    backdrop.innerHTML = `
        <div class="lup-notice-card">
            ${closable ? `
                <button type="button" class="lup-notice-close-x" id="btn-lup-notice-x" aria-label="Close">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            ` : ''}

            <!-- Megaphone Icon (Matching Demo Mockup Image) -->
            <div class="lup-notice-icon-circle">
                <svg width="52" height="52" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <!-- Megaphone Cone -->
                    <path d="M11 27.5V20.5C11 19.4 11.9 18.5 13 18.5H18L29 11V37L18 29.5H13C11.9 29.5 11 28.6 11 27.5Z" fill="#0066f5" />
                    <!-- Megaphone Handle -->
                    <path d="M18 29.5V36.5C18 38 16.8 39.2 15.3 39.2C13.8 39.2 12.6 38 12.6 36.5V29.5H18Z" fill="#024cb5" />
                    <!-- Megaphone Mouth -->
                    <ellipse cx="29" cy="24" rx="2.5" ry="13" fill="#38bdf8" />
                    <!-- Sound Waves (Yellow/Amber) -->
                    <path d="M34 17C36.5 19 38 21.3 38 24C38 26.7 36.5 29 34 31" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" />
                    <path d="M39 12C42.5 15.2 44.5 19.3 44.5 24C44.5 28.7 42.5 32.8 39 36" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" />
                </svg>
            </div>

            <!-- Title -->
            <h3 class="lup-notice-title" id="lup-notice-dialog-title">${escapeHtml(titleText)}</h3>

            <!-- Description -->
            <div class="lup-notice-description">${escapeHtml(descText)}</div>

            <!-- Callout Note (if provided) -->
            ${calloutText ? `
                <div class="lup-notice-callout">
                    <svg class="lup-notice-callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                    <p class="lup-notice-callout-text">${escapeHtml(calloutText)}</p>
                </div>
            ` : ''}

            <!-- Bottom Button or Non-closable Indicator -->
            ${closable ? `
                <button type="button" class="lup-notice-btn-close" id="btn-lup-notice-close">Close</button>
            ` : `
                <div class="lup-notice-lock-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                    <span>Required Notice &bull; Active until ${escapeHtml((() => {
                    try {
                        return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(notice.endsAt)) + ' IST';
                    } catch (_) {
                        return new Date(notice.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    }
                })())}</span>
                </div>
            `}
        </div>
    `;

    const handleDismiss = () => {
        if (!closable) return;
        const dismissKey = `liphtup_notice_dismissed_${userUid}_${noticeId}_v${version}`;
        try {
            localStorage.setItem(dismissKey, "1");
        } catch (_) {}
        dismissNoticeModal();
    };

    if (closable) {
        backdrop.querySelector('#btn-lup-notice-x')?.addEventListener('click', handleDismiss);
        backdrop.querySelector('#btn-lup-notice-close')?.addEventListener('click', handleDismiss);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) handleDismiss();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape' && activeModalEl) {
                document.removeEventListener('keydown', escHandler);
                handleDismiss();
            }
        });
    } else {
        // Non-closable: Prevent dismissal via clicking backdrop or Escape key
        backdrop.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    // Schedule auto-dismiss when endsAt arrives
    const endsMs = parseNoticeTimestamp(notice.endsAt);
    const nowMs = Date.now();
    if (endsMs > nowMs) {
        activeNoticeTimer = setTimeout(() => {
            dismissNoticeModal();
        }, endsMs - nowMs);
    }

    document.body.appendChild(backdrop);
    activeModalEl = backdrop;
}

let upcomingNoticeTimer = null;

function processNoticesList(notices, userUid, userRole) {
    const nowMs = Date.now();

    if (upcomingNoticeTimer) {
        clearTimeout(upcomingNoticeTimer);
        upcomingNoticeTimer = null;
    }

    // Check for future scheduled notices for this audience to set a wakeup timer
    let earliestFutureStartsMs = Infinity;
    for (const n of notices) {
        if (n.state !== "enabled") continue;
        const aud = String(n.audience || "both").toLowerCase();
        const matchesAudience = (aud === "both") || (aud === "drivers" && userRole === "driver") || (aud === "passengers" && userRole === "passenger");
        if (!matchesAudience) continue;

        const startMs = parseNoticeTimestamp(n.startsAt);
        const endMs = parseNoticeTimestamp(n.endsAt);
        if (startMs > nowMs && endMs > nowMs && startMs < earliestFutureStartsMs) {
            earliestFutureStartsMs = startMs;
        }
    }

    if (earliestFutureStartsMs !== Infinity) {
        const delay = Math.max(200, earliestFutureStartsMs - nowMs);
        if (delay < 2147483647) {
            upcomingNoticeTimer = setTimeout(() => {
                processNoticesList(notices, userUid, userRole);
            }, delay);
        }
    }

    // Filter notices that are:
    // 1. state == "enabled"
    // 2. startsAt <= now <= endsAt
    // 3. audience matches (both, or user's specific role)
    const activeNotices = notices.filter((n) => {
        if (n.state !== "enabled") return false;
        const startMs = parseNoticeTimestamp(n.startsAt);
        const endMs = parseNoticeTimestamp(n.endsAt);
        if (startMs > nowMs || endMs < nowMs) return false;

        const aud = String(n.audience || "both").toLowerCase();
        if (aud === "both") return true;
        if (aud === "drivers" && userRole === "driver") return true;
        if (aud === "passengers" && userRole === "passenger") return true;
        return false;
    });

    if (!activeNotices.length) {
        // No active eligible notice; dismiss any visible modal
        dismissNoticeModal();
        return;
    }

    // Sort by startsAt descending to pick the latest
    activeNotices.sort((a, b) => parseNoticeTimestamp(b.startsAt) - parseNoticeTimestamp(a.startsAt));
    const targetNotice = activeNotices[0];

    const noticeId = targetNotice.noticeId || targetNotice.id;
    const version = Number(targetNotice.version || 1);
    const closable = targetNotice.closable !== false;

    // Check if dismissed
    const dismissKey = `liphtup_notice_dismissed_${userUid}_${noticeId}_v${version}`;
    if (closable && localStorage.getItem(dismissKey) === "1") {
        // User already dismissed this exact version
        dismissNoticeModal();
        return;
    }

    renderNoticeModal(targetNotice, userUid, userRole);
}

export function initGlobalNotices() {
    if (isUnprotectedRoute()) return;

    const startNoticeService = (user) => {
        if (!user || !user.uid) {
            dismissNoticeModal();
            if (upcomingNoticeTimer) {
                clearTimeout(upcomingNoticeTimer);
                upcomingNoticeTimer = null;
            }
            if (firestoreUnsubscribe) {
                firestoreUnsubscribe();
                firestoreUnsubscribe = null;
            }
            return;
        }

        const userRole = resolveUserRole();
        const userUid = user.uid;

        // Clean up any old subscription
        if (firestoreUnsubscribe) {
            firestoreUnsubscribe();
            firestoreUnsubscribe = null;
        }

        try {
            // Subscribe to enabled notices in Firestore
            const q = query(collection(db, "globalNotices"), where("state", "==", "enabled"));
            firestoreUnsubscribe = onSnapshot(q, (snapshot) => {
                const notices = [];
                snapshot.forEach((doc) => {
                    const data = doc.data();
                    data.id = doc.id;
                    data.noticeId = data.noticeId || doc.id;
                    notices.push(data);
                });
                processNoticesList(notices, userUid, userRole);
            }, async (err) => {
                console.warn("[GlobalNotices] Firestore listener error, using API fallback:", err);
                // Fallback to active notice API
                try {
                    const token = await user.getIdToken();
                    const res = await fetch("/api/admin/notices/active", {
                        headers: { "Authorization": `Bearer ${token}` }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data.active && data.notice) {
                            processNoticesList([data.notice], userUid, userRole);
                        } else {
                            dismissNoticeModal();
                        }
                    }
                } catch (_) {}
            });
        } catch (e) {
            console.warn("[GlobalNotices] Failed to setup realtime listener:", e);
        }
    };

    // Revalidate on visibility change (app coming back to foreground)
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && auth.currentUser) {
            startNoticeService(auth.currentUser);
        }
    });

    window.addEventListener("online", () => {
        if (auth.currentUser) {
            startNoticeService(auth.currentUser);
        }
    });

    window.addEventListener("user-logged-out", () => {
        dismissNoticeModal();
        if (firestoreUnsubscribe) {
            firestoreUnsubscribe();
            firestoreUnsubscribe = null;
        }
    });

    // Wait until document is ready and auth state resolves
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            onAuthStateChanged(auth, startNoticeService);
        });
    } else {
        // Run asynchronously without blocking initial rendering
        setTimeout(() => {
            onAuthStateChanged(auth, startNoticeService);
        }, 100);
    }
}

// Auto-run if script is directly included
if (typeof window !== "undefined") {
    initGlobalNotices();
}
