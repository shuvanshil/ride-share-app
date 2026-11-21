import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import Profile from './Profile';

const root = document.getElementById('profile-root');
if (root) {
  flushSync(() => {
    ReactDOM.createRoot(root).render(<React.StrictMode><Profile /></React.StrictMode>);
  });
}
