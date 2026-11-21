import React from 'react';

export function ProfileWallet() {
  return (
    <div id="profile-wallet-modal" className="profile-edit-layer d-none" role="dialog" aria-modal="true" aria-labelledby="profile-wallet-title">
      <button id="profile-wallet-backdrop" className="profile-edit-backdrop" type="button" aria-label="Close wallet" />
      <section className="profile-edit-sheet" style={{ maxHeight: '90dvh' }}>
        <header className="profile-edit-head"><div><span className="profile-role-badge" data-i18n="wallet.badge">Credits</span><h2 id="profile-wallet-title" data-i18n="wallet.title">Wallet</h2></div><button id="profile-wallet-close-btn" className="profile-sheet-close" type="button" aria-label="Close">&times;</button></header>
        <div className="profile-wallet-body" style={{ padding: '16px 18px 30px', overflowY: 'auto' }}>
          <div className="wallet-balance-hero-card"><div className="wallet-balance-top"><div className="wallet-balance-icon-wrap"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /><path d="M16 14h2" /></svg></div><span className="wallet-balance-label" data-i18n="wallet.wallet_balance">Wallet Balance</span></div><div className="wallet-balance-amount" id="profile-wallet-balance-val">₹0</div><p className="wallet-balance-sub" data-i18n="wallet.available_credits">Available Wallet Credits</p></div>
          <div id="profile-wallet-active-ride-card" className="wallet-active-ride-card d-none"><div className="wallet-active-ride-left"><div className="wallet-active-ride-badge"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#166534" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.9-1.4.9l-1.5 2.8C2.1 11.6 2 11.6 2 12v4c0 .6.4 1 1 1h2" /><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /></svg></div><div className="wallet-active-ride-info"><strong data-i18n="wallet.pay_current_ride">Pay for Your Current Ride</strong><small id="profile-wallet-active-ride-desc">Remaining fare: ₹0</small></div></div><button type="button" id="profile-wallet-pay-ride-btn" className="wallet-pay-ride-action-btn" data-i18n="wallet.use_wallet_credits">Use Wallet Credits</button></div>
          <div className="wallet-tx-header-row"><h3 className="wallet-tx-title" data-i18n="wallet.transaction_history">Transaction History</h3></div>
          <div id="profile-wallet-tx-list" className="wallet-tx-list"><div className="wallet-tx-loading"><div className="spinner-border spinner-border-sm text-success" role="status" /><span className="ms-2" data-i18n="common.loading">Loading...</span></div></div>
        </div>
      </section>
    </div>
  );
}

export function ProfileWalletCelebration() {
  return (
    <div id="profile-wallet-celebration-modal" className="wallet-celebration-backdrop d-none" role="dialog" aria-modal="true">
      <div className="wallet-celebration-card"><div className="wallet-celebration-graphic"><svg viewBox="0 0 64 64" width="64" height="64" fill="none"><circle cx="32" cy="32" r="30" fill="#DCFCE7" /><path d="M32 12v8M18 18l5.6 5.6M46 18l-5.6 5.6M12 32h8M44 32h8M22 46l4-4M42 46l-4-4" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" /><rect x="20" y="24" width="24" height="18" rx="3" fill="#166534" stroke="#15803D" strokeWidth="2" /><circle cx="32" cy="33" r="3" fill="#FEF08A" /></svg></div><h3 className="wallet-celebration-title" data-i18n="wallet.credit_received_title">Wallet Credit Received!</h3><div className="wallet-celebration-amount" id="wallet-celebration-amount-val">+₹0</div><div id="wallet-celebration-tags" className="wallet-celebration-tags" /><p className="wallet-celebration-desc" data-i18n="wallet.thank_you_riding">Thank you for riding with us!</p><button type="button" id="wallet-celebration-dismiss-btn" className="gy-btn gy-btn-primary w-100 py-2 fw-bold" style={{ borderRadius: 12 }} data-i18n="wallet.awesome">Awesome</button></div>
    </div>
  );
}
