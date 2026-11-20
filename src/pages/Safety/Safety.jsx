import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

export default function Safety() {
  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-safety" aria-hidden="true" />
        </div>
        <h1>Safety Standards &amp; Guidelines</h1>
        <p>Your safety is our top priority on every single trip.</p>
      </section>

      <section className="content-body-container">
        <article className="content-card">
          <div className="card-section-header">
            <h2>Safety Commitment</h2>
          </div>
          <p>At <strong>LiphtUp</strong>, your safety is our top priority. We are committed to providing a secure, reliable, and respectful ride experience for every passenger and driver.</p>
        </article>

        <article className="content-card">
          <div className="card-section-header">
            <h2>Our Safety Standards</h2>
          </div>
          <ul className="styled-list">
            <li>Verified drivers with valid driving licences and required vehicle documents.</li>
            <li>Vehicle and driver details displayed upfront before every ride.</li>
            <li>Real-time trip tracking for complete journey transparency.</li>
            <li>Live trip tracking link can be shared with up to 3 trusted emergency contacts.</li>
            <li>Easy in-app reporting for unsafe behavior or incidents.</li>
            <li>Zero tolerance policy for harassment, discrimination, violence, or fraud.</li>
            <li>Personal information protected in strict compliance with our Privacy Policy.</li>
            <li>Drivers expected to observe all traffic rules and drive responsibly.</li>
            <li>Passengers and drivers must treat each other with mutual respect.</li>
            <li>Emergency services should be alerted immediately in any life-threatening situation.</li>
          </ul>
        </article>

        <div className="row g-3 my-1">
          <div className="col-md-6">
            <article className="content-card h-100">
              <div className="card-section-header">
                <h2>Passenger Guidelines</h2>
              </div>
              <ul className="styled-list">
                <li>Verify the driver's name, photo, and vehicle number before boarding.</li>
                <li>Do not carry illegal, hazardous, or prohibited items.</li>
                <li>Report any suspicious or inappropriate behavior immediately through the app.</li>
                <li>Treat your driver and their vehicle with care and respect.</li>
              </ul>
            </article>
          </div>
          <div className="col-md-6">
            <article className="content-card h-100">
              <div className="card-section-header">
                <h2>Driver Guidelines</h2>
              </div>
              <ul className="styled-list">
                <li>Keep your vehicle clean, safe, and roadworthy at all times.</li>
                <li>Never drive under the influence of alcohol, drugs, or illegal substances.</li>
                <li>Follow all speed limits, traffic signals, and safety laws strictly.</li>
                <li>Do not request payments outside the official LiphtUp fare system.</li>
                <li>Respect every passenger regardless of age, gender, religion, or background.</li>
              </ul>
            </article>
          </div>
        </div>

        <article className="content-card quote-highlight-card">
          <h3>Building a Safe Community Together</h3>
          <p className="mb-0">LiphtUp continuously works to improve safety through secure technology, identity verification, and responsive customer support. Together, we build a trusted mobility network for everyone.</p>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
