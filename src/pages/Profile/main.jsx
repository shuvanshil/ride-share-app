import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import Profile from './Profile';
import ProfileEdit from './ProfileEdit';

const root = document.getElementById('profile-root');
const editRoot = document.getElementById('profile-edit-root');
if (root || editRoot) {
  flushSync(() => {
    if (root) ReactDOM.createRoot(root).render(<React.StrictMode><Profile /></React.StrictMode>);
    if (editRoot) ReactDOM.createRoot(editRoot).render(<React.StrictMode><ProfileEdit /></React.StrictMode>);
  });
}
