import React from 'react';

const channels = [
  { key: 'whatsapp', label: 'WhatsApp', mark: 'WA' },
  { key: 'facebook', label: 'Facebook', mark: 'f' },
  { key: 'email', label: 'Email', mark: '@' },
  { key: 'copy', label: 'Copy link', mark: '⛓' },
];

export default function ProfileShare() {
  return (
    <div id="profile-share-layer" className="profile-share-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-share-title">
      <button id="profile-share-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close sharing options" />
      <section className="profile-share-sheet">
        <header className="profile-share-head">
          <div>
            <span data-i18n="profile.refer_liphtup">Refer LiphtUp</span>
            <h2 id="profile-share-title" data-i18n="profile.share_with_friends">Share with friends</h2>
          </div>
          <button id="profile-share-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button>
        </header>
        <div className="profile-share-options">
          {channels.map((channel) => (
            <button key={channel.key} type="button" data-share-channel={channel.key}>
              <strong>{channel.mark}</strong><span>{channel.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
