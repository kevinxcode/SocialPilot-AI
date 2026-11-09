import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { installSyncHooks } from '@/services/cloud/sync';

installSyncHooks(); // local edits are marked for cloud sync
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
