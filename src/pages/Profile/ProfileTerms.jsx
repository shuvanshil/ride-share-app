import React from 'react';

function Items({ children }) { return <ul>{children}</ul>; }
function Item({ label, children }) { return <li><strong>{label}:</strong> {children}</li>; }

export default function ProfileTerms() {
  return (
    <div id="profile-terms-layer" className="profile-terms-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-terms-title">
      <button id="profile-terms-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close terms and conditions" />
      <section className="profile-terms-sheet">
        <header className="profile-share-head"><div><span>LiphtUp policy</span><h2 id="profile-terms-title">Terms &amp; Conditions</h2></div><button id="profile-terms-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button></header>
        <article className="profile-terms-content">
          <section><h3>Rider Terms &amp; Conditions</h3>
            <h4>1. Account Registration &amp; Eligibility</h4><Items><Item label="Age Requirement">Riders must be at least 18 years old to create an account.</Item><Item label="Account Security">Users are solely responsible for maintaining password confidentiality.</Item><Item label="Accuracy of Information">Riders must provide true, accurate, and updated personal profiles.</Item></Items>
            <h4>2. Services &amp; Booking</h4><Items><Item label="Platform Role">The app acts purely as a digital intermediary connecting riders with independent third-party drivers.</Item><Item label="Booking Rules">A booking is confirmed only when a driver accepts the request.</Item><Item label="Usage Restrictions">Vehicles must not be used to transport illegal goods, hazardous materials, or excess luggage beyond capacity.</Item></Items>
            <h4>3. Fares, Payments &amp; Cancellation</h4><Items><Item label="Fare Calculation">Fares are dynamic and based on distance, time, traffic, and peak hours.</Item><Item label="Payment Methods">Riders agree to pay via linked credit/debit cards, digital wallets, or direct cash to the driver.</Item><Item label="Cancellation Fee">Fees apply if a ride is cancelled after a specific time window or if the driver waits past the grace period.</Item><Item label="Taxes &amp; Tolls">Standard government taxes and route tolls are added to the final trip fare.</Item></Items>
            <h4>4. Code of Conduct</h4><Items><Item label="Behavior">Riders must treat drivers with respect. Verbal abuse, physical aggression, or harassment results in immediate bans.</Item><Item label="Vehicle Care">Damaging or fouling the vehicle will incur cleaning or repair charges.</Item><Item label="Safety">Seatbelts, if available, must be worn, and riders must not force drivers to violate traffic laws.</Item></Items>
          </section>
          <section><h3>Driver Terms &amp; Conditions</h3>
            <h4>1. Driver Eligibility &amp; Documentation</h4><Items><Item label="Licensing">Drivers must hold a valid commercial driving licence for 3-wheelers.</Item><Item label="Vehicle Requirements">The auto-rickshaw must have valid registration, fitness certificates, and updated commercial insurance.</Item><Item label="Background Verification">Drivers consent to mandatory criminal record and driving history background checks.</Item></Items>
            <h4>2. Nature of Relationship</h4><Items><Item label="Independent Contractor">Drivers are independent service providers. They are not employees, agents, or partners of the app.</Item><Item label="Flexibility">Drivers maintain full autonomy to log on/off the app and accept or decline trip requests at will.</Item></Items>
            <h4>3. Fares, Commission &amp; Payouts</h4><Items><Item label="Platform Fee">The app deducts a predefined percentage, or commission, from each completed trip fare.</Item><Item label="Payout Schedule">Driver earnings from digital payments are processed and transferred on a weekly or daily schedule.</Item><Item label="Tipping">Drivers retain 100% of any voluntary tips provided by riders.</Item></Items>
            <h4>4. Operating Rules &amp; Conduct</h4><Items><Item label="Safety &amp; Compliance">Drivers must strictly follow all regional traffic rules, speed limits, and transport guidelines.</Item><Item label="Route Choice">Drivers must follow the app's GPS navigation unless the rider requests a specific alternative.</Item><Item label="Device Usage">Mobile devices must be mounted safely. Texting or calling while driving is strictly prohibited.</Item><Item label="Discrimination">Zero-tolerance policy for discrimination based on race, religion, gender, nationality, or disability.</Item></Items>
          </section>
          <section><h3>Mutual Clauses</h3>
            <h4>1. Data Privacy &amp; Location Tracking</h4><Items><Item label="GPS Tracking">Real-time location tracking is active during trips for safety and fare validation.</Item><Item label="Data Privacy">Personal data handling strictly follows the platform's standard Privacy Policy.</Item></Items>
            <h4>2. Limitation of Liability</h4><Items><Item label="Service Interruptions">The platform is provided "as-is" and is not liable for app downtime or GPS inaccuracies.</Item><Item label="Third-Party Actions">The company is not liable for any property damage, injury, or loss caused by the actions of riders or drivers.</Item></Items>
            <h4>3. Termination &amp; Suspension</h4><Items><Item label="Account Deactivation">The platform reserves the right to suspend accounts instantly for fraud, low ratings, or policy violations.</Item></Items>
          </section>
        </article>
      </section>
    </div>
  );
}
