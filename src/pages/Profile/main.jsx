import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import Profile from './Profile';
import ProfileEdit from './ProfileEdit';
import ProfileAccount from './ProfileAccount';
import ProfileDelete from './ProfileDelete';
import ProfileShare from './ProfileShare';
import ProfileSafety from './ProfileSafety';
import ProfileAbout from './ProfileAbout';
import ProfileContact from './ProfileContact';
import ProfileHelp from './ProfileHelp';
import ProfilePrivacy from './ProfilePrivacy';
import ProfileTerms from './ProfileTerms';

const root = document.getElementById('profile-root');
const editRoot = document.getElementById('profile-edit-root');
const accountRoot = document.getElementById('profile-account-root');
const deleteRoot = document.getElementById('profile-delete-root');
const shareRoot = document.getElementById('profile-share-root');
const safetyRoot = document.getElementById('profile-safety-root');
const aboutRoot = document.getElementById('profile-about-root');
const contactRoot = document.getElementById('profile-contact-root');
const helpRoot = document.getElementById('profile-help-root');
const privacyRoot = document.getElementById('profile-privacy-root');
const termsRoot = document.getElementById('profile-terms-root');
if (root || editRoot || accountRoot || deleteRoot || shareRoot || safetyRoot || aboutRoot || contactRoot || helpRoot || privacyRoot || termsRoot) {
  flushSync(() => {
    if (root) ReactDOM.createRoot(root).render(<React.StrictMode><Profile /></React.StrictMode>);
    if (editRoot) ReactDOM.createRoot(editRoot).render(<React.StrictMode><ProfileEdit /></React.StrictMode>);
    if (accountRoot) ReactDOM.createRoot(accountRoot).render(<React.StrictMode><ProfileAccount /></React.StrictMode>);
    if (deleteRoot) ReactDOM.createRoot(deleteRoot).render(<React.StrictMode><ProfileDelete /></React.StrictMode>);
    if (shareRoot) ReactDOM.createRoot(shareRoot).render(<React.StrictMode><ProfileShare /></React.StrictMode>);
    if (safetyRoot) ReactDOM.createRoot(safetyRoot).render(<React.StrictMode><ProfileSafety /></React.StrictMode>);
    if (aboutRoot) ReactDOM.createRoot(aboutRoot).render(<React.StrictMode><ProfileAbout /></React.StrictMode>);
    if (contactRoot) ReactDOM.createRoot(contactRoot).render(<React.StrictMode><ProfileContact /></React.StrictMode>);
    if (helpRoot) ReactDOM.createRoot(helpRoot).render(<React.StrictMode><ProfileHelp /></React.StrictMode>);
    if (privacyRoot) ReactDOM.createRoot(privacyRoot).render(<React.StrictMode><ProfilePrivacy /></React.StrictMode>);
    if (termsRoot) ReactDOM.createRoot(termsRoot).render(<React.StrictMode><ProfileTerms /></React.StrictMode>);
  });
}
