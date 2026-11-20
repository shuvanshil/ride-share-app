import React from 'react';
import ReactDOM from 'react-dom/client';
import Contact from './Contact';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Contact />
    </React.StrictMode>
  );
}
