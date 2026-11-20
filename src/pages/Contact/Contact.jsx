import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

export default function Contact() {
  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-contact-us" aria-hidden="true" />
        </div>
        <h1>Contact Us</h1>
        <p>We're here to help. Get in touch with our team anytime.</p>
      </section>

      <section className="content-body-container">
        <article className="content-card">
          <div className="card-section-header">
            <h2>Reach Us</h2>
          </div>
          <p>
            Have a question, need assistance with a ride, or want to get in touch
            with the LiphtUp team? Reach out to us through any of the channels below.
          </p>

          <div className="contact-methods-grid">
            <a href="mailto:liphtup.in@gmail.com" className="contact-method-card">
              <div className="contact-icon">📧</div>
              <div className="contact-details">
                <span className="contact-label">Email Support</span>
                <strong>liphtup.in@gmail.com</strong>
                <small>Send us an email anytime</small>
              </div>
            </a>

            <a href="tel:+917628901050" className="contact-method-card">
              <div className="contact-icon">📞</div>
              <div className="contact-details">
                <span className="contact-label">Phone Support</span>
                <strong>+91 7628901050 / 9436908760</strong>
                <small>Mon-Sun, 9:00 AM - 9:00 PM IST</small>
              </div>
            </a>

            <div className="contact-method-card static-card">
              <div className="contact-icon">📍</div>
              <div className="contact-details">
                <span className="contact-label">Location</span>
                <strong>Tripura, India</strong>
                <small>Headquarters &amp; Operations</small>
              </div>
            </div>
          </div>
        </article>

        <article className="content-card">
          <div className="card-section-header">
            <h2>How We Can Help</h2>
          </div>
          <p>
            Whether you need help with your account, ride bookings, fare inquiries,
            or have business and partnership opportunities, our dedicated team is
            here to support you.
          </p>
          <div className="help-topics-pills">
            <span className="topic-pill">🚗 Ride Support</span>
            <span className="topic-pill">👤 Account &amp; Profile</span>
            <span className="topic-pill">💳 Fare &amp; Payment</span>
            <span className="topic-pill">🛡️ Safety &amp; Trust</span>
            <span className="topic-pill">💼 Driver Onboarding</span>
            <span className="topic-pill">🤝 Partnerships</span>
          </div>
        </article>

        <article className="content-card quote-highlight-card">
          <h3>Thank you for choosing LiphtUp</h3>
          <p className="mb-0">
            We aim to respond to all inquiries as quickly as possible and provide
            the best support experience for riders and drivers alike.
          </p>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
