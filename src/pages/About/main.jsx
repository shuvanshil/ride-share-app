import React from 'react';
import ReactDOM from 'react-dom/client';
import About from './About';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <About />
    </React.StrictMode>
  );
}
