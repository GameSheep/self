import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installRepositoryContractBridge } from './app/devBridge';
import './index.css';

/**
 * Dev-only bridge for the E2E contract suite.
 *
 * The guard must be **here**, at the call site, not only inside the function: a
 * top-level call is side-effecting, so Rollup keeps `devBridge` — and with it every
 * static import in that module — in the production entry chunk. The runtime check inside
 * `installRepositoryContractBridge` was not enough: the migration stack alone cost the
 * first load ~25 KB gzip (measured), because a retained module's static imports are not
 * shaken when they sit behind an early return.
 */
if (import.meta.env.DEV) {
  installRepositoryContractBridge();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="应用根节点">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
