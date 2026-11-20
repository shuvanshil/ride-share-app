import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

export default function Terms() {
  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-terms" aria-hidden="true" />
        </div>
        <h1>Terms &amp; Conditions</h1>
        <p>Guidelines and terms for riders and drivers using LiphtUp.</p>
      </section>

      <section className="content-body-container">
        {/* Rider Terms */}
        <article className="content-card">
          <div className="card-section-header">
            <div className="header-tag">Riders</div>
            <h2>Rider Terms &amp; Conditions</h2>
          </div>

          <div className="terms-sub-block">
            <h3>1. Account Registration &amp; Eligibility</h3>
            <ul className="styled-list">
              <li><strong>Age Requirement:</strong> Riders must be at least 18 years old to register an account and book rides independently.</li>
              <li><strong>Account Security:</strong> Users are solely responsible for keeping login credentials confidential and secure.</li>
              <li><strong>Accuracy of Information:</strong> Riders must provide accurate, current, and complete profile information.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>2. Services &amp; Booking</h3>
            <ul className="styled-list">
              <li><strong>Platform Role:</strong> LiphtUp acts purely as a digital intermediary technology platform connecting riders with independent drivers.</li>
              <li><strong>Booking Confirmation:</strong> A booking request is confirmed only when an available driver accepts the request.</li>
              <li><strong>Usage Restrictions:</strong> Vehicles must not be used to transport illegal contraband, hazardous substances, or luggage beyond vehicle capacity.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>3. Fares, Payments &amp; Cancellation</h3>
            <ul className="styled-list">
              <li><strong>Fare Calculation:</strong> Fares are calculated dynamically based on distance, estimated time, vehicle type, and local fare policies.</li>
              <li><strong>Payment Methods:</strong> Riders agree to settle trip fares via direct cash or supported online digital payment options.</li>
              <li><strong>Cancellation Policy:</strong> Standard cancellation guidelines apply if a ride is cancelled after driver acceptance or arrival.</li>
              <li><strong>Tolls &amp; Charges:</strong> Applicable road tolls or government taxes are included in or added to the total trip fare.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>4. Code of Conduct</h3>
            <ul className="styled-list">
              <li><strong>Respectful Behavior:</strong> Riders must treat drivers with respect. Physical harassment, verbal abuse, or property damage results in immediate account deactivation.</li>
              <li><strong>Vehicle Care:</strong> Riders are liable for any intentional damage or soiling caused to the vehicle.</li>
              <li><strong>Traffic Compliance:</strong> Riders must not ask drivers to violate traffic signals, speed limits, or safety laws.</li>
            </ul>
          </div>
        </article>

        {/* Driver Terms */}
        <article className="content-card">
          <div className="card-section-header">
            <div className="header-tag">Drivers</div>
            <h2>Driver Terms &amp; Conditions</h2>
          </div>

          <div className="terms-sub-block">
            <h3>1. Driver Eligibility &amp; Documentation</h3>
            <ul className="styled-list">
              <li><strong>Licensing:</strong> Drivers must possess a valid, non-expired driving licence for the corresponding vehicle category (Bike / Auto).</li>
              <li><strong>Vehicle Compliance:</strong> Vehicles must maintain active registration certificates, fitness, commercial permits, and updated insurance.</li>
              <li><strong>Verification:</strong> Drivers consent to identity, document, and background verification before activation.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>2. Independent Contractor Relationship</h3>
            <ul className="styled-list">
              <li><strong>Contractor Status:</strong> Drivers operate as independent service providers and are not employees, agents, or partners of LiphtUp.</li>
              <li><strong>Full Autonomy:</strong> Drivers retain full freedom to go online/offline and accept or decline trip requests at their discretion.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>3. Fares &amp; Earnings</h3>
            <ul className="styled-list">
              <li><strong>Platform Fee:</strong> LiphtUp deducts standard platform service charges or fixed commissions from trip fares where applicable.</li>
              <li><strong>Payouts:</strong> Digital earnings collected on behalf of drivers are disbursed regularly according to local payout terms.</li>
            </ul>
          </div>

          <div className="terms-sub-block">
            <h3>4. Operating Safety &amp; Conduct</h3>
            <ul className="styled-list">
              <li><strong>Safety Rules:</strong> Drivers must follow all traffic laws, speed limits, helmet/seatbelt regulations, and drive responsibly.</li>
              <li><strong>Zero Tolerance:</strong> Driving under the influence of alcohol, drugs, or engaging in unsafe driving leads to permanent suspension.</li>
              <li><strong>Non-Discrimination:</strong> Zero tolerance for discrimination based on gender, religion, race, age, or disability.</li>
            </ul>
          </div>
        </article>

        {/* Mutual Clauses */}
        <article className="content-card">
          <div className="card-section-header">
            <div className="header-tag">General</div>
            <h2>Mutual Clauses &amp; Liability</h2>
          </div>
          <div className="terms-sub-block">
            <h3>1. Data Privacy &amp; GPS Tracking</h3>
            <p>Real-time location tracking is enabled during active trips for rider safety, navigation, and fare calculation in accordance with our Privacy Policy.</p>
          </div>
          <div className="terms-sub-block">
            <h3>2. Limitation of Liability</h3>
            <p>LiphtUp provides its digital service on an "as-is" basis and is not liable for indirect losses, unexpected service interruptions, or third-party conduct outside its control.</p>
          </div>
          <div className="terms-sub-block">
            <h3>3. Account Termination</h3>
            <p>LiphtUp reserves the right to suspend or deactivate any rider or driver account for policy violations, fraud, safety reports, or illegal conduct.</p>
          </div>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
