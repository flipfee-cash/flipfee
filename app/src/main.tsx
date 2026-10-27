import '@fontsource-variable/geist/index.css';
import '@fontsource-variable/geist-mono/index.css';
import '@fontsource-variable/doto/index.css';
import './styles/base.css';
import './styles/flap.css';
import './styles/shell.css';
import './styles/board.css';
import './styles/sheets.css';
import './styles/pages.css';
import './styles/market.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootLive } from './api/live.ts';
import { startWallets } from './wallet/wallet.ts';
import { startMine } from './state/mine.ts';
import { App } from './App.tsx';

// the snapshot is already on its way (index.html); wire the stream before the first paint
bootLive();
startWallets();
startMine();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
