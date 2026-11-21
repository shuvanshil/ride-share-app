import React from 'react';

export default function ProfileAccount() {
  return (
    <div id="profile-account-layer" className="profile-account-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-account-title">
      <button id="profile-account-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close account options" />
      <section className="profile-account-sheet">
        <header className="profile-share-head">
          <div>
            <span data-i18n="profile.account_settings">Account</span>
            <h2 id="profile-account-title" data-i18n="profile.account_options">Account options</h2>
          </div>
          <button id="profile-account-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button>
        </header>

        <div className="profile-account-actions">
          <button id="profile-account-logout-btn" className="profile-account-action" type="button">
            <span data-i18n="common.logout">Log out</span>
            <strong data-i18n="profile.logout_desc">End this session on your device.</strong>
          </button>
          <button id="profile-account-delete-open-btn" className="profile-account-action is-danger" type="button">
            <span data-i18n="profile.delete_account">Delete account permanently</span>
            <strong data-i18n="profile.delete_account_desc">Remove your login, profile, and saved account access.</strong>
          </button>
        </div>
      </section>
    </div>
  );
}
