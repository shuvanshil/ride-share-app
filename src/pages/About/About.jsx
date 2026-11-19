import React from 'react';
import ContentHeader from '../../components/layout/ContentHeader';
import BottomNav from '../../components/layout/BottomNav';

const FEATURES = [
  {
    title: 'Safe & Reliable Rides',
    desc: 'Identity verified drivers and transparent trip tracking for your peace of mind.',
  },
  {
    title: 'Fast & Easy Booking',
    desc: 'Quick pickup matching with real-time driver tracking.',
  },
  {
    title: 'Transparent & Fair Pricing',
    desc: 'Clear fare breakdown with no hidden charges.',
  },
  {
    title: 'Verified Drivers & Vehicles',
    desc: 'Vehicle and driver details shared upfront before every ride.',
  },
  {
    title: 'Customer-First Support',
    desc: 'Dedicated support team ready to assist whenever you need help.',
  },
  {
    title: 'Community & Innovation',
    desc: 'Continuous technological improvements to serve riders and drivers better.',
  },
];

export default function About() {
  return (
    <main className="content-page-shell">
      <ContentHeader fallbackUrl="profile.html" />

      <section className="content-hero-block">
        <div className="hero-icon-badge">
          <span className="webicon webicon-about-us" aria-hidden="true" />
        </div>
        <h1>About Us</h1>
        <p>Smarter, safer, and reliable everyday travel for everyone.</p>
      </section>

      <section className="content-body-container">
        <article className="content-card">
          <div className="card-section-header">
            <h2>Welcome to LiphtUp</h2>
          </div>
          <p>
            Welcome to <strong>LiphtUp</strong> — a technology-driven ride-hailing platform built to make everyday travel safer, smarter, and more accessible across Tripura and beyond.
          </p>
          <p>
            Our mission is to connect passengers with trusted local drivers through a seamless digital experience, making transportation convenient, reliable, and affordable for everyone. Whether you're commuting to work, traveling across the city, or heading to an important destination, LiphtUp is designed to help you reach there with confidence.
          </p>
          <p>
            At LiphtUp, we believe that transportation is more than just getting from one place to another. It's about creating opportunities, supporting local drivers and communities, and improving mobility through continuous innovation.
          </p>
        </article>

        <div className="row g-3 my-1">
          <div className="col-md-6">
            <article className="content-card h-100">
              <div className="card-section-header">
                <div className="header-tag">Goal</div>
                <h2>Our Mission</h2>
              </div>
              <p>
                To provide safe, reliable, and affordable transportation while empowering local drivers and delivering exceptional service to every passenger.
              </p>
            </article>
          </div>
          <div className="col-md-6">
            <article className="content-card h-100">
              <div className="card-section-header">
                <div className="header-tag">Future</div>
                <h2>Our Vision</h2>
              </div>
              <p>
                To become one of India's most trusted mobility platforms by connecting communities through innovative, secure, and customer-focused transportation solutions.
              </p>
            </article>
          </div>
        </div>

        <article className="content-card">
          <div className="card-section-header">
            <h2>Why Choose LiphtUp?</h2>
          </div>
          <ul className="feature-checklist">
            {FEATURES.map((item, index) => (
              <li key={index}>
                <span className="check-icon">✓</span>
                <div>
                  <strong>{item.title}:</strong> {item.desc}
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="content-card quote-highlight-card">
          <h3>Every Journey Matters</h3>
          <p className="mb-0">
            At LiphtUp, every journey matters. We are committed to building a transportation platform that people can trust — one ride at a time.
          </p>
        </article>
      </section>

      <BottomNav activeTab="profile" />
    </main>
  );
}
