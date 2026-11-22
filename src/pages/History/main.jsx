import React from 'react';
import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import History from './History';

const root = document.getElementById('history-root');
if (root) {
  window.__REACT_HISTORY_MODE__ = true;
  flushSync(() => ReactDOM.createRoot(root).render(<React.StrictMode><History /></React.StrictMode>));
}
