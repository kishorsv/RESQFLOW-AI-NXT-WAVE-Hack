import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { isSimulatedOffline } from './lib/offlineQueue.ts';
import './index.css';

// Register RESQFLOW AI Service Worker in production builds
// (offline caching + persistent IndexedDB Background Sync via /sw.js;
// in development, IndexedDB queue & online/WebSocket auto-sync run directly without dev-sw.js)
if (import.meta.env.PROD && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      const syncFlag = () => {
        const target = navigator.serviceWorker.controller || registration?.active;
        if (target) {
          target.postMessage({
            type: 'SET_SIMULATED_OFFLINE',
            enabled: isSimulatedOffline(),
          });
        }
      };
      syncFlag();
      navigator.serviceWorker.addEventListener('controllerchange', syncFlag);
    },
    onRegisterError(err) {
      console.warn('Service Worker registration deferred:', err);
    },
  });
}

// Tier 1 Google Maps Platform Demo Key Quota Defense (registered BEFORE React mounts)
declare global {
  interface Window {
    gm_authFailure?: () => void;
    __gmpQuotaExceeded?: boolean;
  }
}

const triggerGmpQuotaExceeded = () => {
  if (!window.__gmpQuotaExceeded) {
    window.__gmpQuotaExceeded = true;
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
};

window.gm_authFailure = () => {
  triggerGmpQuotaExceeded();
};

const origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const joined = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  if (
    joined.includes('OverQuotaMapError') ||
    joined.includes('QuotaExceededError') ||
    joined.includes('QuotaExceeded') ||
    joined.includes('exceeded your request quota') ||
    joined.includes('RefererNotAllowedMapError')
  ) {
    triggerGmpQuotaExceeded();
  }
  origConsoleError(...args);
};

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
