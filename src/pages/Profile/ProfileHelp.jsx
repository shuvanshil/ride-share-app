import React from 'react';

const faqs = [
  ['1. How do I book a ride?', 'Open the LiphtUp app, enter your pickup and destination locations, choose your preferred ride option, and confirm your booking.'],
  ['2. How can I cancel a ride?', 'You can cancel a ride before it begins through the app. Cancellation charges may apply based on our cancellation policy.'],
  ['3. How do I contact my driver?', 'Once your ride is confirmed, you can use the contact option available in the app to communicate with your driver.'],
  ['4. What should I do if I leave an item in the vehicle?', 'Report the issue through the app or contact our support team as soon as possible. We will do our best to help you reconnect with the driver.'],
  ['5. How do I report a safety concern?', 'If you experience any unsafe behavior or encounter an emergency, use the in-app reporting feature or contact our support team immediately. If there is an immediate danger, contact your local emergency services first.'],
  ['6. How do I update my account information?', 'You can update your profile details from the account settings section of the LiphtUp app.'],
  ['7. Need More Help?', "If you couldn't find the answer you're looking for, please contact our support team."],
];

export default function ProfileHelp() {
  return (
    <div id="profile-help-layer" className="profile-help-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-help-title">
      <button id="profile-help-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close help center" />
      <section className="profile-help-sheet">
        <header className="profile-share-head"><div><span>LiphtUp support</span><h2 id="profile-help-title">Help Center</h2></div><button id="profile-help-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button></header>
        <article className="profile-terms-content">
          <section><h3>Help Center</h3><p>Welcome to the LiphtUp Help Center. We're here to help you get the most out of our platform. If you have questions, need assistance, or encounter any issues, you'll find guidance below.</p></section>
          <section><h3>Frequently Asked Questions</h3>{faqs.map(([question, answer]) => <React.Fragment key={question}><h4>{question}</h4><p>{answer}</p></React.Fragment>)}</section>
          <section><h3>Contact Support</h3><ul><li><strong>Email:</strong> liphtup.in@gmail.com</li><li><strong>Phone:</strong> +91 7628901050 / 9436908760</li><li><strong>Support Hours:</strong> Monday-Sunday, 9:00 AM-9:00 PM (IST)</li></ul><p>We are committed to providing quick, reliable, and friendly support to ensure every journey with LiphtUp is smooth and hassle-free.</p></section>
        </article>
      </section>
    </div>
  );
}
