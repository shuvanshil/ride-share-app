import React from 'react';

export default function ProfileContact() {
  return (
    <div id="profile-contact-layer" className="profile-contact-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-contact-title">
      <button id="profile-contact-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close contact information" />
      <section className="profile-contact-sheet">
        <header className="profile-share-head"><div><span>Contact LiphtUp</span><h2 id="profile-contact-title">Contact Us</h2></div><button id="profile-contact-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button></header>
        <article className="profile-terms-content">
          <section><h3>Contact</h3><p>Have a question, need assistance, or want to get in touch with the LiphtUp team? We're here to help.</p></section>
          <section><h3>Reach Us</h3><ul><li><strong>Email:</strong> <a href="mailto:liphtup.in@gmail.com">liphtup.in@gmail.com</a></li><li><strong>Phone:</strong> <a href="tel:+917628901050">+91 7628901050 / 9436908760</a></li><li><strong>Address:</strong> Tripura, India</li><li><strong>Support Hours:</strong> Monday-Sunday, 9:00 AM-9:00 PM</li></ul></section>
          <section><h3>How We Can Help</h3><p>Whether you need help with your account, a ride, or have business or partnership inquiries, feel free to contact us. We aim to respond as quickly as possible and provide the best support experience.</p><p>Thank you for choosing LiphtUp. We look forward to hearing from you!</p></section>
        </article>
      </section>
    </div>
  );
}
