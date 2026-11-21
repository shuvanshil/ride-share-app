import React from 'react';

const collected = ['Full name', 'Mobile number', 'Email address', 'Profile photo, if provided', 'Location data during rides', 'Ride history', 'Payment information, where applicable', 'Device and app usage information'];
const uses = ['Create and manage your account.', 'Connect passengers with drivers.', 'Process ride bookings and payments.', 'Improve the quality and security of our services.', 'Provide customer support.', 'Send important notifications and service updates.', 'Prevent fraud and ensure platform safety.', 'Comply with applicable legal requirements.'];
const sharing = ['With the assigned driver or passenger to complete a ride.', 'With trusted service providers that help operate our platform.', 'When required by law or a valid legal request.', 'To protect the safety, rights, or property of LiphtUp, our users, or others.'];
const rights = ['Access your personal information.', 'Request correction of inaccurate information.', 'Request deletion of your account, subject to legal obligations.', 'Contact us with privacy-related questions.'];

function List({ items }) { return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>; }

export default function ProfilePrivacy() {
  return (
    <div id="profile-privacy-layer" className="profile-privacy-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-privacy-title">
      <button id="profile-privacy-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close privacy policy" />
      <section className="profile-privacy-sheet">
        <header className="profile-share-head"><div><span>LiphtUp policy</span><h2 id="profile-privacy-title">Privacy Policy</h2></div><button id="profile-privacy-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button></header>
        <article className="profile-terms-content">
          <section><h3>LiphtUp Privacy Policy</h3><p><strong>Last Updated:</strong> July 8, 2026</p><p>At <strong>LiphtUp</strong>, we value your privacy and are committed to protecting your personal information. This Privacy Policy explains how we collect, use, store, and protect your data when you use our services.</p></section>
          <section><h3>Information We Collect</h3><p>We may collect:</p><List items={collected} /></section>
          <section><h3>How We Use Your Information</h3><p>Your information is used to:</p><List items={uses} /></section>
          <section><h3>Location Information</h3><p>Location data is used only to provide ride booking, driver matching, navigation, trip tracking, and related safety features. We do not use your location for unrelated purposes without your permission.</p></section>
          <section><h3>Data Security</h3><p>We use reasonable administrative, technical, and organizational measures to help protect your personal information from unauthorized access, misuse, alteration, or disclosure.</p></section>
          <section><h3>Information Sharing</h3><p>We do not sell your personal information. We may share your information only:</p><List items={sharing} /></section>
          <section><h3>Your Rights</h3><p>You may:</p><List items={rights} /></section>
          <section><h3>Data Retention</h3><p>We retain your information only for as long as necessary to provide our services, comply with legal obligations, resolve disputes, and enforce our policies.</p></section>
          <section><h3>Children's Privacy</h3><p>LiphtUp is not intended for children below the minimum age permitted by applicable law to use our services. We do not knowingly collect personal information from children.</p></section>
          <section><h3>Changes to This Privacy Policy</h3><p>We may update this Privacy Policy from time to time. Any changes will be published within the app or on our official website with the updated effective date.</p></section>
          <section><h3>Contact Us</h3><p>If you have any questions about this Privacy Policy, please contact the LiphtUp support team through our official app or website.</p></section>
        </article>
      </section>
    </div>
  );
}
