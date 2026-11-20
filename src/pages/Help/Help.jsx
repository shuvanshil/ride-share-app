import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

const faqs = [
  {
    q: '1. How do I book a ride?',
    a: <>Open the LiphtUp app, enter your pickup location and destination, select your preferred ride option (Bike or Auto), check the fare estimate, and tap <strong>Book Now</strong>.</>
  },
  {
    q: '2. How can I cancel a ride?',
    a: 'You can cancel a ride before it starts through the active trip screen in the app. Please note that cancellation charges may apply if cancelled after a specific grace period.'
  },
  {
    q: '3. How do I contact my assigned driver?',
    a: 'Once your booking is accepted by a driver, you will see call and message buttons on the trip tracking screen to communicate directly with your driver.'
  },
  {
    q: '4. What should I do if I leave an item in the vehicle?',
    a: 'Contact our support team immediately with your ride details (date, time, pickup/destination). We will help connect you with your driver to retrieve your lost item.'
  },
  {
    q: '5. How do I report a safety concern?',
    a: 'You can report safety concerns directly from the Safety section in your Profile menu or from your active ride screen. In any immediate emergency, contact local emergency services (112 / 100) first.'
  },
  {
    q: '6. How do I update my account information?',
    a: <> Navigate to the <strong>Profile</strong> tab in the app, tap the <strong>Edit Profile</strong> button, update your details (name, email, photo), and save changes.</>
  },
];

export default function Help() {
  const navigate = (url) => {
    if (typeof window.navigateToPage === 'function') {
      window.navigateToPage(url);
    } else {
      window.location.href = url;
    }
  };

  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-help" aria-hidden="true" />
        </div>
        <h1>Help Center</h1>
        <p>Find answers to common questions or reach our support team.</p>
      </section>

      <section className="content-body-container">
        <article className="content-card">
          <div className="card-section-header">
            <h2>Frequently Asked Questions</h2>
          </div>
          <div className="faq-list">
            {faqs.map((item, i) => (
              <div className="faq-item" key={i}>
                <div className="faq-question">{item.q}</div>
                <div className="faq-answer">{item.a}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="content-card">
          <div className="card-section-header">
            <h2>Need More Help?</h2>
          </div>
          <p>If you couldn't find the answer to your question, our support team is available 7 days a week to assist you.</p>
          <div className="contact-support-bar">
            <div className="support-info-text">
              <strong>Contact Customer Support</strong>
              <span>Email: liphtup.in@gmail.com</span>
              <span>Phone: +91 7628901050 / 9436908760</span>
              <span>Hours: Mon-Sun, 9:00 AM - 9:00 PM IST</span>
            </div>
            <button
              className="gy-btn gy-btn-primary mt-3 w-100"
              type="button"
              onClick={() => navigate('contact.html')}
            >
              Get in Touch
            </button>
          </div>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
