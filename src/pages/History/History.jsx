import React, { useEffect, useState } from 'react';

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
  useEffect(() => {
    if (window.__HISTORY_CONTROLLER_STARTED__) return undefined;

    window.__HISTORY_CONTROLLER_STARTED__ = true;
    const startController = () => window.LiphtUpHistoryController?.bootstrap?.();

    if (window.LiphtUpHistoryController) {
      startController();
      return undefined;
    }

    window.addEventListener('liphtup:history-controller-ready', startController, { once: true });
    return () => window.removeEventListener('liphtup:history-controller-ready', startController);
  }, []);

  return (
    <main className="history-page">
      <header className="history-app-head">
        <div className="brand-logo"><img src="assets/branding/liphtup-logo.jpeg" alt="LiphtUp" /></div>
        <div className="app-bar-actions d-flex align-items-center gap-2">
          <div id="history-lang-switcher" />
          <HistoryGuestAction />
          <button id="history-refresh-btn" className="mini-action" type="button" data-i18n="common.refresh">Refresh</button>
        </div>
      </header>

      <section className="history-title-block"><h1 data-i18n="history.title">Ride History</h1><HistoryStatus /></section>

      <section id="history-summary-grid" className="history-summary-grid d-none" aria-label="Trip summary">
        <div className="history-summary-card"><span data-i18n="history.total_trips">Total Trips</span><strong id="history-total-trips">0</strong></div>
        <div className="history-summary-card"><span id="history-money-label" data-i18n="history.total_fare">Total Fare</span><strong id="history-total-fare">₹0</strong></div>
        <div className="history-summary-card"><span data-i18n="history.total_distance">Distance</span><strong id="history-total-distance">0 km</strong></div>
      </section>

      <section className="history-filter-row" aria-label="History filters"><HistoryFilters /></section>

      <section className="standalone-history-list"><div id="history-list-status-root"><HistoryListStatus /></div><div id="history-list" /><HistoryLoadMore /></section>

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

export function HistoryStatus() {
  const [status, setStatus] = useState({ context: 'Trip by you as passenger', showGuest: false });

  useEffect(() => {
    const update = (event) => setStatus((current) => ({ ...current, ...(event.detail || {}) }));
    window.addEventListener('liphtup:history-status', update);
    return () => window.removeEventListener('liphtup:history-status', update);
  }, []);

  return <p id="history-user-context" data-i18n="history.subtitle">{status.context}</p>;
}

export function HistoryGuestAction() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const update = (event) => setShow(Boolean(event.detail?.showGuest));
    window.addEventListener('liphtup:history-status', update);
    return () => window.removeEventListener('liphtup:history-status', update);
  }, []);

  return show ? <button className="guest-login-btn" type="button" onClick={() => go('/login.html')} data-i18n="common.login">Login</button> : null;
}

export function HistoryListStatus() {
  const [state, setState] = useState({ listState: 'loading', loadingText: 'Loading ride history...' });

  useEffect(() => {
    const update = (event) => setState((current) => ({ ...current, ...(event.detail || {}) }));
    window.addEventListener('liphtup:history-status', update);
    return () => window.removeEventListener('liphtup:history-status', update);
  }, []);

  useEffect(() => {
    const list = document.getElementById('history-list');
    if (list) list.classList.toggle('d-none', state.listState !== 'data');
    return () => list?.classList.remove('d-none');
  }, [state.listState]);

  if (state.listState === 'data') return null;
  if (state.listState === 'error') return <div className="history-empty-card"><div className="history-empty-icon">!</div><h3>{state.errorTitle}</h3><p>{state.errorDescription}</p><button id="history-retry-btn" className="gy-btn gy-btn-primary" type="button" onClick={() => window.LiphtUpHistoryController?.refresh?.()}>Try Again</button></div>;
  if (state.listState === 'guest') return <div className="history-empty-card"><div className="history-empty-icon">‹</div><h3>{state.guestTitle}</h3><p>{state.guestDescription}</p><button className="gy-btn gy-btn-primary" type="button" onClick={() => go('/login.html')}>Go to Login</button></div>;
  if (state.listState === 'empty') return <div className="history-empty-card"><div className="history-empty-icon">·</div><h3>{state.emptyTitle} {state.filterText}</h3><p>{state.emptyDescription}</p><button className="gy-btn gy-btn-primary" type="button" onClick={() => go(state.emptyActionLink)}>{state.emptyActionLabel}</button></div>;
  return <div className="history-loading-card">{state.loadingText}</div>;
}

export function HistoryFilters() {
  const [activeFilter, setActiveFilter] = useState('all');
  const filters = [['day', 'history.filter_day', 'Day'], ['week', 'history.filter_week', 'Week'], ['month', 'history.filter_month', 'Month'], ['all', 'history.filter_all', 'All']];
  const selectFilter = (filter) => { setActiveFilter(filter); window.LiphtUpHistoryController?.setFilter?.(filter); };
  return <>{filters.map(([filter, translation, label]) => <button key={filter} className={`history-filter${activeFilter === filter ? ' active' : ''}`} type="button" data-filter={filter} data-i18n={translation} onClick={() => selectFilter(filter)}>{label}</button>)}</>;
}

export function HistoryLoadMore() {
  const [pagination, setPagination] = useState({ hasMore: false, remaining: 0 });

  useEffect(() => {
    const update = (event) => setPagination((current) => ({ ...current, ...(event.detail || {}) }));
    window.addEventListener('liphtup:history-pagination', update);
    return () => window.removeEventListener('liphtup:history-pagination', update);
  }, []);

  useEffect(() => {
    const legacyButton = document.getElementById('load-more-history-btn');
    legacyButton?.classList.add('d-none');
  }, [pagination.hasMore, pagination.remaining]);

  if (!pagination.hasMore) return null;
  return <div className="load-more-container"><button type="button" className="load-more-btn" onClick={() => window.LiphtUpHistoryController?.loadMore?.()}><span>Load More ({pagination.remaining} remaining)</span><span className="chevron-down">↓</span></button></div>;
}
