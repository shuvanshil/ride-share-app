import React from 'react';

export default function ProfileDelete() {
  return (
    <div id="profile-delete-layer" className="profile-delete-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-delete-title">
      <button id="profile-delete-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close delete account confirmation" />
      <section className="profile-delete-sheet">
        <header className="profile-share-head">
          <div>
            <span data-i18n="profile.permanent_deletion">Permanent deletion</span>
            <h2 id="profile-delete-title" data-i18n="profile.delete_account">Delete account</h2>
          </div>
          <button id="profile-delete-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button>
        </header>

        <form id="profile-delete-form" className="profile-delete-form" noValidate>
          <div className="profile-delete-warning">
            <h3 data-i18n="profile.cannot_undo">This cannot be undone.</h3>
            <p data-i18n="profile.delete_warning">Your LiphtUp login and profile will be permanently deleted. Completed ride records may remain for safety, support, payment, or legal reasons, but your personal account details will be removed from them.</p>
          </div>

          <ul className="profile-delete-list">
            <li data-i18n="profile.delete_list_1">Any active ride must be completed or cancelled before deletion.</li>
            <li data-i18n="profile.delete_list_2">Your phone number and email can be used again to create a new passenger or driver account.</li>
            <li data-i18n="profile.delete_list_3">Your old completed trips will not be automatically linked to a new account.</li>
          </ul>

          <div className="profile-form-field">
            <label htmlFor="profile-delete-confirmation" data-i18n="profile.type_delete">Type DELETE</label>
            <input id="profile-delete-confirmation" className="form-control gy-input" type="text" autoComplete="off" spellCheck="false" required />
          </div>

          <div className="profile-form-field">
            <label htmlFor="profile-delete-password" data-i18n="profile.account_password">Account password</label>
            <input id="profile-delete-password" className="form-control gy-input" type="password" autoComplete="current-password" required />
          </div>

          <div id="profile-delete-error" className="profile-edit-error d-none" role="alert" />

          <footer className="profile-edit-footer">
            <button id="profile-delete-cancel-btn" className="gy-btn profile-cancel-btn" type="button" data-i18n="common.cancel">Cancel</button>
            <button id="profile-delete-submit-btn" className="gy-btn profile-delete-submit" type="submit" data-i18n="profile.delete_my_account">Delete my account</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
