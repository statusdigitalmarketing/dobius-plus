import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { attachKeyboardFit } from './keyboard-fit';
import '@xterm/xterm/css/xterm.css';

attachKeyboardFit();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker for offline shell + install (v1.0.43 Phase 4).
// Service workers need a secure context, so this is a no-op on plain HTTP
// (raw-IP / no-cert mode); the app still works, just without offline/install.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
  });
}
