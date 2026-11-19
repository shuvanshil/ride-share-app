import React from 'react';

/**
 * Reusable top header for content and informational pages.
 * Displays a back button and the brand logo.
 */
export default function ContentHeader({ fallbackUrl = 'profile.html' }) {
  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else if (typeof window.navigateToPage === 'function') {
      window.navigateToPage(fallbackUrl);
    } else {
      window.location.href = fallbackUrl;
    }
  };

  return (
    <header className="content-page-head">
      <button
        className="head-back-btn"
        type="button"
        onClick={handleBack}
        aria-label="Go back"
      >
        <span className="webicon webicon-view-more back-chevron" aria-hidden="true" />
      </button>
      <div className="brand-logo">
        <img src="assets/branding/liphtup-logo.jpeg" alt="LiphtUp" />
      </div>
      <div className="head-spacer" />
    </header>
  );
}
