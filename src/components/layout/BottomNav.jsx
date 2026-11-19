import React from 'react';

/**
 * Reusable bottom navigation bar for passenger views.
 * Highlights the active tab based on the `activeTab` prop.
 */
export default function BottomNav({ activeTab = 'profile' }) {
  const navigate = (url) => {
    if (typeof window.navigateToPage === 'function') {
      window.navigateToPage(url);
    } else {
      window.location.href = url;
    }
  };

  const navItems = [
    { key: 'home', label: 'Home', icon: 'webicon-home', url: 'index.html' },
    { key: 'services', label: 'Services', icon: 'webicon-services', url: 'services.html' },
    { key: 'history', label: 'History', icon: 'webicon-history', url: 'history.html' },
    { key: 'profile', label: 'Profile', icon: 'webicon-profile', url: 'profile.html' },
  ];

  return (
    <nav className="bottom-nav profile-bottom-nav">
      {navItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={activeTab === item.key ? 'active' : ''}
          onClick={() => navigate(item.url)}
        >
          <span className={`webicon ${item.icon}`} aria-hidden="true" />
          {item.label}
        </button>
      ))}
    </nav>
  );
}
