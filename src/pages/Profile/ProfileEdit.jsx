import React from 'react';

function PersonIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
}

function CameraIcon({ small = false }) {
  return <svg width={small ? 16 : 13} height={small ? 16 : 13} viewBox="0 0 24 24" fill="none" stroke={small ? 'currentColor' : '#ffffff'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>;
}

function TrashIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>;
}

function SimpleIcon({ type }) {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: '#0f172a', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (type === 'email') return <svg {...common}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>;
  if (type === 'gender') return <svg {...common}><circle cx="10" cy="14" r="5" /><line x1="19" y1="5" x2="13.6" y2="10.4" /><line x1="19" y1="5" x2="14" y2="5" /><line x1="19" y1="5" x2="19" y2="10" /></svg>;
  if (type === 'phone') return <svg {...common}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>;
  if (type === 'link') return <svg {...common}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>;
  if (type === 'bike') return <svg {...common}><circle cx="18.5" cy="17.5" r="3.5" /><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="15" cy="5" r="1" /><path d="M12 17.5V14l-3-3 4-3 2 3h2" /></svg>;
  if (type === 'vehicle') return <svg {...common}><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></svg>;
  if (type === 'number') return <svg {...common}><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="6" cy="12" r="1" /><circle cx="18" cy="12" r="1" /><path d="M10 12h4" /></svg>;
  if (type === 'license') return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><line x1="15" y1="8" x2="17" y2="8" /><line x1="15" y1="12" x2="17" y2="12" /><line x1="7" y1="16" x2="17" y2="16" /></svg>;
  return <svg {...common}><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>;
}

function Field({ icon, label, optional, required, children }) {
  return <div className="profile-field-row"><div className="profile-field-icon-box">{icon}</div><div className="profile-field-content"><label>{label}{optional && <span className="profile-optional-badge" data-i18n="common.optional">Optional</span>}{required && <span className="required-star">*</span>}</label>{children}</div></div>;
}

export default function ProfileEdit() {
  return (
    <div id="profile-edit-layer" className="profile-edit-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-edit-title">
      <button id="profile-edit-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close profile editor" />
      <section className="profile-edit-sheet">
        <header className="profile-edit-head">
          <div className="profile-edit-head-left">
            <div className="profile-edit-head-icon"><PersonIcon /></div>
            <div className="profile-edit-head-titles">
              <span id="profile-edit-role" className="profile-role-badge">Passenger Account</span>
              <h2 id="profile-edit-title" data-i18n="profile.edit_profile">Edit Profile</h2>
              <p className="profile-edit-subtitle" data-i18n="profile.edit_subtitle">Keep your information up to date</p>
            </div>
          </div>
          <button id="profile-edit-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button>
        </header>

        <form id="profile-edit-form" className="profile-edit-form" noValidate>
          <section className="profile-photo-editor-card" aria-label="Profile photo">
            <div className="profile-avatar-wrapper">
              <div id="profile-edit-avatar" className="profile-avatar profile-edit-avatar">G</div>
              <div className="profile-avatar-camera-badge" aria-hidden="true"><CameraIcon /></div>
            </div>
            <div className="profile-photo-card-actions">
              <div className="profile-photo-btns-row">
                <label className="profile-photo-upload-btn" htmlFor="profile-photo-file"><CameraIcon small /><span data-i18n="profile.change_photo">Change Photo</span></label>
                <input id="profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp" hidden />
                <button id="profile-photo-remove-btn" className="profile-photo-remove-btn" type="button"><TrashIcon /><span data-i18n="common.remove">Remove</span></button>
              </div>
              <p className="profile-photo-hint-text" data-i18n="profile.photo_hint">JPG, PNG or WebP. The image is resized before saving.</p>
            </div>
          </section>

          <Field icon={<PersonIcon />} label={<span data-i18n="auth.full_name">Full Name</span>} required>
            <input id="profile-edit-name" className="form-control profile-field-input" type="text" maxLength="80" autoComplete="name" required />
          </Field>

          <Field icon={<SimpleIcon type="email" />} label={<span data-i18n="profile.email">Email Address</span>} optional>
            <input id="profile-edit-email" className="form-control profile-field-input" type="email" maxLength="120" autoComplete="email" />
          </Field>

          <Field icon={<SimpleIcon type="gender" />} label={<span data-i18n="auth.gender">Gender</span>} required>
            <select id="profile-edit-gender" className="form-select profile-field-input" defaultValue="">
              <option value="" disabled data-i18n="auth.select_gender_placeholder">Select Gender Preferences</option>
              <option value="Male" data-i18n="auth.gender_male">Male</option>
              <option value="Female" data-i18n="auth.gender_female">Female</option>
              <option value="Others" data-i18n="auth.gender_others">Others</option>
            </select>
          </Field>

          <Field icon={<SimpleIcon type="phone" />} label={<span data-i18n="auth.mobile_number">Mobile Number</span>} required>
            <input id="profile-edit-phone" className="form-control profile-field-input field-readonly" type="tel" readOnly aria-readonly="true" />
            <small className="profile-field-hint" data-i18n="profile.phone_readonly_hint">Mobile number is secured by phone authentication and cannot be changed here.</small>
          </Field>

          <Field icon={<SimpleIcon type="link" />} label={<span data-i18n="profile.photo_url_label">Profile Photo URL</span>} optional>
            <input id="profile-photo-url" className="form-control profile-field-input" type="url" maxLength="1500" placeholder="https://example.com/photo.jpg" />
          </Field>

          <section id="profile-driver-fields" className="profile-driver-fields d-none">
            <div className="profile-form-section-title"><h3 data-i18n="profile.driver_details">Driver Details</h3><p data-i18n="profile.driver_details_hint">Keep these details identical to your registered documents.</p></div>
            <Field icon={<SimpleIcon type="bike" />} label={<span data-i18n="profile.ride_service_label">Ride service</span>} required>
              <select id="profile-edit-vehicle-type" className="form-select profile-field-input" defaultValue=""><option value="" data-i18n="profile.select_vehicle_type">Select vehicle type</option><option value="bike" data-i18n="services.bike">Bike / Scooty</option><option value="auto" data-i18n="services.auto">Auto</option></select>
            </Field>
            <Field icon={<SimpleIcon type="vehicle" />} label={<span data-i18n="profile.vehicle_model">Vehicle model</span>}>
              <input id="profile-edit-vehicle-model" className="form-control profile-field-input" type="text" maxLength="80" />
            </Field>
            <Field icon={<SimpleIcon type="number" />} label={<span data-i18n="profile.vehicle_number">Vehicle number</span>} required>
              <input id="profile-edit-vehicle-number" className="form-control profile-field-input text-uppercase" type="text" maxLength="20" />
            </Field>
            <Field icon={<SimpleIcon type="license" />} label={<span data-i18n="profile.driving_licence">Driving licence number</span>} required>
              <input id="profile-edit-license" className="form-control profile-field-input text-uppercase" type="text" maxLength="30" />
            </Field>
            <Field icon={<SimpleIcon type="wallet" />} label={<span data-i18n="profile.upi_id">UPI ID</span>} required>
              <input id="profile-edit-upi" className="form-control profile-field-input" type="text" maxLength="100" inputMode="email" placeholder="drivername@upi" />
            </Field>
          </section>

          <div id="profile-edit-error" className="profile-edit-error d-none" role="alert" />
          <footer className="profile-edit-footer">
            <button id="profile-edit-cancel-btn" className="gy-btn profile-redesign-cancel-btn" type="button" data-i18n="common.cancel">Cancel</button>
            <button id="profile-save-btn" className="gy-btn profile-redesign-save-btn" type="submit" data-i18n="profile.save_changes">Save Changes</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
