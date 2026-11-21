import React from 'react';

function navigate(url) {
  window.location.href = url;
}

const menuItems = [
  { action: 'rides', icon: 'webicon-history', label: 'history.title', text: 'My Rides' },
  { action: 'wallet', id: 'profile-menu-wallet-row', icon: 'wallet', label: 'wallet.title', text: 'Wallet' },
  { action: 'payments', id: 'profile-menu-payments-row', icon: 'webicon-payments', label: 'driver.weekly_payment', text: 'Payment', hidden: true },
  { action: 'safety', icon: 'webicon-safety', label: 'profile.safety_center', text: 'Safety' },
  { action: 'refer', icon: 'webicon-share', label: 'common.share', text: 'Share' },
  { action: 'contact', icon: 'webicon-contact-us', label: 'profile.contact_us', text: 'Contact Us' },
  { action: 'about', icon: 'webicon-about-us', label: 'profile.about_app', text: 'About Us' },
  { action: 'terms', icon: 'webicon-terms', label: 'profile.terms_conditions', text: 'Terms & Conditions' },
  { action: 'privacy', icon: 'webicon-privacy', label: 'profile.privacy_policy', text: 'Privacy Policy' },
  { action: 'help', icon: 'webicon-help', label: 'profile.help_support', text: 'Help' },
];

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#1A7A2E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <path d="M16 14h2" />
    </svg>
  );
}

export default function Profile() {
  return (
    <main className="profile-page">
      <header className="profile-app-head">
        <div className="brand-logo"><img src="assets/branding/liphtup-logo.jpeg" alt="LiphtUp" /></div>
        <div id="profile-lang-switcher" className="app-bar-actions d-flex align-items-center gap-2 d-none" />
        <button className="guest-login-btn d-none" type="button" onClick={() => navigate('/login.html')} data-i18n="common.login">Login</button>
      </header>

      <section className="profile-title-block">
        <h1 data-i18n="profile.title">Profile</h1>
      </section>

      <section className="profile-user-card">
        <div className="profile-avatar" id="profile-avatar">G</div>
        <div className="profile-user-copy">
          <h2 id="profile-user-name">LiphtUp User</h2>
          <p id="profile-user-phone">Loading phone number...</p>
          <small id="profile-user-email" className="profile-user-email" />
        </div>
        <button id="profile-edit-btn" className="profile-edit-btn" type="button" aria-haspopup="dialog" disabled data-i18n="profile.edit_profile">Edit</button>
      </section>

      <section className="profile-menu" aria-label="Profile menu">
        {menuItems.map((item) => (
          <button
            key={item.action}
            id={item.id}
            className={`profile-menu-row${item.hidden ? ' d-none' : ''}`}
            type="button"
            data-action={item.action}
          >
            <span className="profile-menu-icon">
              {item.icon === 'wallet' ? <WalletIcon /> : <span className={`webicon ${item.icon}`} aria-hidden="true" />}
            </span>
            <span data-i18n={item.label}>{item.text}</span>
            <span className="webicon webicon-view-more profile-menu-more" aria-hidden="true" />
          </button>
        ))}
      </section>

      <section className="profile-footer-actions">
        <button id="profile-logout-btn" className="profile-logout-btn d-none" type="button" data-i18n="profile.account_settings">Account</button>
      </section>

      <nav className="bottom-nav profile-bottom-nav">
        <button type="button" onClick={() => navigate('/index.html')}><span className="webicon webicon-home" aria-hidden="true" /><span data-i18n="nav.home">Home</span></button>
        <button type="button" onClick={() => navigate('/services.html')}><span className="webicon webicon-services" aria-hidden="true" /><span data-i18n="nav.services">Services</span></button>
        <button type="button" onClick={() => navigate('/history.html')}><span className="webicon webicon-history" aria-hidden="true" /><span data-i18n="nav.history">History</span></button>
        <button className="active" type="button"><span className="webicon webicon-profile" aria-hidden="true" /><span data-i18n="nav.profile">Profile</span></button>
      </nav>
    </main>
  );
}
