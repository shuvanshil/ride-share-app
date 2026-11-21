import React from 'react';

export default function ProfileAbout() {
  return (
    <div id="profile-about-layer" className="profile-about-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-about-title">
      <button id="profile-about-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close about us information" />
      <section className="profile-about-sheet">
        <header className="profile-share-head">
          <div><span>About LiphtUp</span><h2 id="profile-about-title">About Us</h2></div>
          <button id="profile-about-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button>
        </header>
        <article className="profile-terms-content">
          <section><h3>About Us</h3><p>Welcome to <strong>LiphtUp</strong> — a technology-driven ride-hailing platform built to make everyday travel safer, smarter, and more accessible.</p><p>Our mission is to connect passengers with trusted drivers through a seamless digital experience, making transportation convenient, reliable, and affordable for everyone. Whether you're commuting to work, traveling across the city, or heading to an important destination, LiphtUp is designed to help you reach there with confidence.</p><p>At LiphtUp, we believe that transportation is more than just getting from one place to another. It's about creating opportunities, supporting local communities, and improving mobility through innovation. By combining modern technology with a user-friendly platform, we aim to deliver a ride experience that is fast, transparent, and dependable.</p></section>
          <section><h3>Our Mission</h3><p>To provide safe, reliable, and affordable transportation while empowering local drivers and delivering exceptional service to every passenger.</p></section>
          <section><h3>Our Vision</h3><p>To become one of India's most trusted mobility platforms by connecting communities through innovative, secure, and customer-focused transportation solutions.</p></section>
          <section><h3>Why Choose LiphtUp?</h3><ul><li>Safe and reliable ride experience</li><li>Easy and fast booking process</li><li>Transparent and fair pricing</li><li>Verified driver and vehicle information</li><li>Customer-first support</li><li>Continuous innovation to improve mobility</li></ul></section>
          <section><h3>Every Journey Matters</h3><p>At LiphtUp, every journey matters. We are committed to building a transportation platform that people can trust — one ride at a time.</p></section>
        </article>
      </section>
    </div>
  );
}
