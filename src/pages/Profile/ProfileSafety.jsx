import React from 'react';

function Badge({ children, tone = 'green', icon = 'people' }) {
  const stroke = tone === 'red-soft' ? '#dc2626' : '#166534';
  const iconShape = icon === 'location'
    ? <><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></>
    : icon === 'shield'
      ? <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" stroke="#ffffff" /></>
    : icon === 'warning'
      ? <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
      : <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>;
  if (tone === 'red-solid') return <div className={`safety-badge badge-${tone}`}>{children}</div>;
  return <div className={`safety-badge badge-${tone}`}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconShape}</svg>{children}</div>;
}

export default function ProfileSafety() {
  const openGuidelines = () => {
    if (typeof window.navigateToPage === 'function') window.navigateToPage('safety.html');
    else window.location.href = 'safety.html';
  };

  return (
    <div id="profile-safety-layer" className="profile-safety-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-safety-title">
      <button id="profile-safety-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close safety information" />
      <section className="profile-safety-sheet safety-center-sheet">
        <header className="safety-center-header">
          <div className="safety-center-brand"><span className="webicon webicon-safety green-shield-icon" aria-hidden="true" /><span className="safety-brand-title" data-i18n="profile.safety_brand_title">LiphtUp Safety</span></div>
          <h2 id="profile-safety-title" className="safety-center-main-heading" data-i18n="profile.safety_center">Safety Center</h2>
          <p className="safety-center-subtext" data-i18n="profile.safety_center_sub">Your safety comes first. Manage emergency contacts and report safety concerns here.</p>
          <button id="profile-safety-close-btn" className="profile-sheet-close safety-close-btn" type="button" aria-label="Close">&times;</button>
        </header>

        <article className="safety-center-body">
          <section className="safety-center-card">
            <div className="safety-card-head"><Badge /><div><h3 data-i18n="profile.emergency_contacts_title">Emergency Contacts</h3><p data-i18n="profile.emergency_contacts_sub">Add up to 3 trusted contacts.</p></div></div>
            <div id="emergency-contacts-list" className="emergency-contacts-list" />
            <form id="emergency-contact-form" className="emergency-contact-form d-none">
              <input type="text" id="emergency-contact-name" className="form-control gy-input" placeholder="Contact name" data-i18n-placeholder="profile.contact_name_placeholder" maxLength="80" required />
              <input type="tel" id="emergency-contact-phone" className="form-control gy-input" placeholder="Phone number (+91...)" data-i18n-placeholder="profile.contact_phone_placeholder" maxLength="20" required />
              <div className="emergency-contact-form-actions"><button type="submit" className="gy-btn gy-btn-primary flex-fill" data-i18n="profile.save_contact">Save Contact</button><button type="button" id="emergency-contact-cancel-btn" className="gy-btn gy-btn-outline flex-fill" data-i18n="common.cancel">Cancel</button></div>
            </form>
            <button id="emergency-contact-add-btn" className="gy-btn gy-btn-outline-green w-100 mt-2" type="button" data-i18n="profile.add_emergency_contact">+ Add Emergency Contact</button>
            <div id="emergency-contact-limit-notice" className="max-contacts-notice d-none" data-i18n="profile.contact_limit_reached">You've reached the 3-contact limit.</div>
          </section>

          <section className="safety-center-card">
            <div className="safety-card-head"><Badge icon="location" /><div><h3 data-i18n="profile.during_your_ride">During your ride</h3></div></div>
            <div className="during-ride-content-box">
              <div className="during-ride-illustration" aria-hidden="true">📍</div>
              <div className="during-ride-text"><strong data-i18n="profile.share_your_trip">Share your trip</strong><p id="safety-share-trip-hint" data-i18n="profile.share_trip_hint">Send your live trip location to your emergency contacts.</p></div>
              <button type="button" id="safety-center-share-btn" className="gy-btn gy-btn-outline-green safety-share-btn" data-i18n="profile.share_trip_btn">Share Trip &rarr;</button>
            </div>
          </section>

          <section className="safety-center-card">
            <div className="safety-card-head"><Badge tone="red-soft" icon="warning" /><div><h3 data-i18n="profile.report_safety_title">Report a Safety Concern</h3><p data-i18n="profile.report_safety_sub">Help us keep LiphtUp safe for everyone.</p></div></div>
            <form id="safety-report-form" className="safety-report-form">
              <div className="form-group mb-2"><select id="safety-report-category" className="form-select gy-input" required defaultValue=""><option value="" disabled data-i18n="profile.select_concern">Select a concern</option><option value="unsafe_driving" data-i18n="profile.concern_unsafe_driving">Unsafe driving</option><option value="harassment" data-i18n="profile.concern_harassment">Harassment</option><option value="route_deviation" data-i18n="profile.concern_route_deviation">Route deviation</option><option value="vehicle_condition" data-i18n="profile.concern_vehicle_condition">Vehicle condition</option><option value="payment_dispute" data-i18n="profile.concern_payment_dispute">Payment dispute</option><option value="rude_behavior" data-i18n="profile.concern_rude_behavior">Rude behavior</option><option value="other" data-i18n="profile.concern_other">Other concern</option></select></div>
              <div className="form-group mb-3"><textarea id="safety-report-description" className="form-control gy-input" rows="3" maxLength="1000" placeholder="Tell us more (optional)" data-i18n-placeholder="profile.tell_us_more" /></div>
              <div className="safety-report-buttons"><button type="submit" className="gy-btn gy-btn-primary flex-fill" data-i18n="profile.submit_report">Submit Report</button><button type="button" id="safety-report-cancel-btn" className="gy-btn gy-btn-outline flex-fill" data-i18n="common.cancel">Cancel</button></div>
              <div className="safety-reassurance-tag"><span data-i18n="profile.report_reassurance">🔒 Your report will be reviewed by the LiphtUp safety team.</span></div>
            </form>
          </section>

          <section className="safety-center-card safety-emergency-card"><div className="safety-emergency-row"><Badge tone="red-solid"><strong>SOS</strong></Badge><div className="safety-emergency-copy"><h3 data-i18n="profile.need_immediate_help">Need immediate help?</h3><p data-i18n="profile.emergency_assistance">Get emergency assistance from LiphtUp.</p></div><button type="button" id="safety-get-help-btn" className="gy-btn gy-btn-danger safety-get-help-btn" data-i18n="profile.get_help">📞 Get Help</button></div></section>

          <section className="safety-center-card safety-standards-card"><div className="safety-standards-row"><Badge icon="shield" /><div className="safety-standards-copy"><h3 data-i18n="profile.safety_standards_title">LiphtUp Safety Standards</h3><p data-i18n="profile.safety_standards_sub">Learn about our safety standards, passenger guidelines, and driver guidelines.</p></div><button type="button" className="safety-guidelines-btn" onClick={openGuidelines} data-i18n="profile.read_safety_guidelines">Read Safety Guidelines &rarr;</button></div></section>
        </article>
      </section>
    </div>
  );
}
