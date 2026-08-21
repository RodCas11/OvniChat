import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ToastProvider } from './ui/ToastProvider.js';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element (#root) is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
