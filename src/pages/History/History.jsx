import React from 'react';

function go(url) { window.location.href = url; }
function goHome() { if (typeof window.liphtUpGoHome === 'function') window.liphtUpGoHome(); else go('/index.html'); }
function goServices() {
  try {
    const profile = JSON.parse(sessionStorage.getItem('liphtup_user_profile') || 'null');
    go(profile?.role === 'driver' ? '/driver-service.html' : '/services.html');
  } catch {
    go('/services.html');
  }
}

export default function History() {
  return (
    <main className="history-page">
      <header className="history-app-head">
        <div className="brand-logo"><img src="assets/branding/liphtup-logo.jpeg" alt="LiphtUp" /></div>
        <div className="app-bar-actions d-flex align-items-center gap-2">
          <div id="history-lang-switcher" />
          <button className="guest-login-btn d-none" type="button" onClick={() => go('/login.html')} data-i18n="common.login">Login</button>
          <button id="history-refresh-btn" className="mini-action" type="button" data-i18n="common.refresh">Refresh</button>
        </div>
      </header>

      <section className="history-title-block"><h1 data-i18n="history.title">Ride History</h1><p id="history-user-context" data-i18n="history.subtitle">Trip by you as passenger</p></section>

      <section id="history-summary-grid" className="history-summary-grid d-none" aria-label="Trip summary">
        <div className="history-summary-card"><span data-i18n="history.total_trips">Total Trips</span><strong id="history-total-trips">0</strong></div>
        <div className="history-summary-card"><span id="history-money-label" data-i18n="history.total_fare">Total Fare</span><strong id="history-total-fare">₹0</strong></div>
        <div className="history-summary-card"><span data-i18n="history.total_distance">Distance</span><strong id="history-total-distance">0 km</strong></div>
      </section>

      <section className="history-filter-row" aria-label="History filters">
        <button className="history-filter" type="button" data-filter="day" data-i18n="history.filter_day">Day</button>
        <button className="history-filter" type="button" data-filter="week" data-i18n="history.filter_week">Week</button>
        <button className="history-filter" type="button" data-filter="month" data-i18n="history.filter_month">Month</button>
        <button className="history-filter active" type="button" data-filter="all" data-i18n="history.filter_all">All</button>
      </section>

      <section id="history-list" className="standalone-history-list"><div className="history-loading-card" data-i18n="history.loading_history">Loading ride history...</div></section>

      <div id="history-detail-modal" className="modal-layer d-none">
        <div className="gy-modal history-detail-modal"><header className="gy-modal-head"><h2 data-i18n="history.trip_details">Trip Details</h2><button className="modal-close-btn" type="button" aria-label="Close dialog">&times;</button></header><div className="history-detail-content" id="history-detail-content" /></div>
      </div>

      <nav className="bottom-nav history-bottom-nav">
        <button type="button" data-home-link onClick={goHome}><span className="webicon webicon-home" aria-hidden="true" /><span data-i18n="nav.home">Home</span></button>
        <button type="button" data-service-link onClick={goServices}><span className="webicon webicon-services" aria-hidden="true" /><span data-i18n="nav.services">Services</span></button>
        <button className="active" type="button"><span className="webicon webicon-history" aria-hidden="true" /><span data-i18n="nav.history">History</span></button>
        <button type="button" onClick={() => go('/profile.html')}><span className="webicon webicon-profile" aria-hidden="true" /><span data-i18n="nav.profile">Profile</span></button>
      </nav>
    </main>
  );
}
