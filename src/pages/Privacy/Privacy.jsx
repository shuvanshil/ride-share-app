import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

export default function Privacy() {
  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-privacy" aria-hidden="true" />
        </div>
        <h1>Privacy Policy</h1>
        <p>Last Updated: July 8, 2026</p>
      </section>

      <section className="content-body-container">
        <article className="content-card">
          <div className="card-section-header"><h2>LiphtUp Privacy Policy</h2></div>
          <p>At <strong>LiphtUp</strong>, we value your privacy and are committed to protecting your personal information. This Privacy Policy explains how we collect, use, store, and protect your data when you use our website, mobile application, and related ride-hailing services.</p>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Information We Collect</h2></div>
          <p>We may collect the following personal and usage data:</p>
          <ul className="styled-list">
            <li><strong>Account Details:</strong> Full name, mobile phone number, email address, profile photo (if provided).</li>
            <li><strong>Location Data:</strong> Real-time GPS location during active rides, pickup/destination searches, and driver navigation.</li>
            <li><strong>Trip History:</strong> Ride records, pickup/drop-off points, timestamps, distance, and fare details.</li>
            <li><strong>Payment Data:</strong> Transaction references and payment method preferences (where applicable).</li>
            <li><strong>Device &amp; App Data:</strong> Device model, operating system version, browser type, app version, IP address, and system diagnostic logs.</li>
          </ul>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>How We Use Your Information</h2></div>
          <p>Your information is collected and processed strictly to:</p>
          <ul className="styled-list">
            <li>Create, verify, and maintain your user or driver account.</li>
            <li>Connect passengers with nearby available drivers seamlessly.</li>
            <li>Calculate accurate fares and process ride bookings.</li>
            <li>Enable live trip-tracking and safety features (e.g. sharing trip status with trusted contacts).</li>
            <li>Provide responsive customer support and investigate safety concerns.</li>
            <li>Send transaction receipts, service updates, and important security alerts.</li>
            <li>Prevent fraudulent activities, unauthorized access, and ensure platform safety.</li>
            <li>Comply with applicable statutory and legal requirements in India.</li>
          </ul>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Location Information</h2></div>
          <p>Location data is essential to the core functionality of LiphtUp. It is collected and processed only to provide ride bookings, driver-rider matching, navigation, real-time trip tracking, and emergency safety features.</p>
          <p>We do not track your location in the background when the app is not in use for active rides or navigation, and we never sell your location data to third parties.</p>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Data Security</h2></div>
          <p>We implement strict administrative, technical, and physical security measures to safeguard your personal information against unauthorized access, loss, misuse, disclosure, or alteration.</p>
          <p>Data transmission between your device and LiphtUp servers is encrypted using standard Secure Sockets Layer (SSL/TLS) technology.</p>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Information Sharing</h2></div>
          <p>We do not sell, rent, or trade your personal data. Information is shared only under the following strictly defined conditions:</p>
          <ul className="styled-list">
            <li><strong>With Drivers / Passengers:</strong> Contact details, pickup location, and first name are shared with your assigned driver or passenger solely to complete the trip.</li>
            <li><strong>Service Providers:</strong> Trusted cloud hosting, SMS authentication, and Firebase infrastructure partners who operate under strict confidentiality agreements.</li>
            <li><strong>Legal Obligations:</strong> When required by law enforcement, court order, or valid government request under applicable Indian laws.</li>
            <li><strong>Safety Emergency:</strong> To protect the immediate safety, health, rights, or property of riders, drivers, or the public.</li>
          </ul>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Your Rights &amp; Choices</h2></div>
          <p>You have full control over your data. Subject to applicable laws, you have the right to:</p>
          <ul className="styled-list">
            <li>Access and view your profile information anytime in the app.</li>
            <li>Request correction of inaccurate or incomplete personal details.</li>
            <li>Delete your account permanently from the Profile settings section.</li>
            <li>Manage app permissions (such as camera or location access) through your device settings.</li>
          </ul>
        </article>

        <article className="content-card">
          <div className="card-section-header"><h2>Data Retention &amp; Children's Privacy</h2></div>
          <p>We retain your personal data only for as long as your account remains active or as needed to comply with legal, tax, accounting, and safety obligations.</p>
          <p>LiphtUp services are not directed to individuals under the age of 18. We do not knowingly collect personal data from children.</p>
        </article>

        <article className="content-card quote-highlight-card">
          <h3>Questions about your privacy?</h3>
          <p className="mb-0">If you have any questions or concerns regarding this Privacy Policy, please contact our support team at <a href="mailto:liphtup.in@gmail.com">liphtup.in@gmail.com</a>.</p>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
