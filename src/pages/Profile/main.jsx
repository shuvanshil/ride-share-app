import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import Profile from './Profile';
import ProfileEdit from './ProfileEdit';
import ProfileAccount from './ProfileAccount';

const root = document.getElementById('profile-root');
const editRoot = document.getElementById('profile-edit-root');
const accountRoot = document.getElementById('profile-account-root');
if (root || editRoot || accountRoot) {
  flushSync(() => {
    if (root) ReactDOM.createRoot(root).render(<React.StrictMode><Profile /></React.StrictMode>);
    if (editRoot) ReactDOM.createRoot(editRoot).render(<React.StrictMode><ProfileEdit /></React.StrictMode>);
    if (accountRoot) ReactDOM.createRoot(accountRoot).render(<React.StrictMode><ProfileAccount /></React.StrictMode>);
  });
}
