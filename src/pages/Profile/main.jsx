import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import Profile from './Profile';
import ProfileEdit from './ProfileEdit';
import ProfileAccount from './ProfileAccount';
import ProfileDelete from './ProfileDelete';
import ProfileShare from './ProfileShare';
import ProfileSafety from './ProfileSafety';

const root = document.getElementById('profile-root');
const editRoot = document.getElementById('profile-edit-root');
const accountRoot = document.getElementById('profile-account-root');
const deleteRoot = document.getElementById('profile-delete-root');
const shareRoot = document.getElementById('profile-share-root');
const safetyRoot = document.getElementById('profile-safety-root');
if (root || editRoot || accountRoot || deleteRoot || shareRoot || safetyRoot) {
  flushSync(() => {
    if (root) ReactDOM.createRoot(root).render(<React.StrictMode><Profile /></React.StrictMode>);
    if (editRoot) ReactDOM.createRoot(editRoot).render(<React.StrictMode><ProfileEdit /></React.StrictMode>);
    if (accountRoot) ReactDOM.createRoot(accountRoot).render(<React.StrictMode><ProfileAccount /></React.StrictMode>);
    if (deleteRoot) ReactDOM.createRoot(deleteRoot).render(<React.StrictMode><ProfileDelete /></React.StrictMode>);
    if (shareRoot) ReactDOM.createRoot(shareRoot).render(<React.StrictMode><ProfileShare /></React.StrictMode>);
    if (safetyRoot) ReactDOM.createRoot(safetyRoot).render(<React.StrictMode><ProfileSafety /></React.StrictMode>);
  });
}
