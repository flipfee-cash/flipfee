import { DitherDefs } from './dither/DitherDefs.tsx';
import { Suspense, lazy, useEffect } from 'react';
import { copy } from './copy.ts';
import { router } from './lib/router.ts';
import { PHONE, useMedia } from './state/store.ts';
import { dropOverlays } from './state/ui.ts';
import { TopBar } from './shell/TopBar.tsx';
import { BottomBar, Footer } from './shell/Bottom.tsx';
import { Toasts } from './shell/Toasts.tsx';
import { Board } from './board/Board.tsx';
import { BuySheet } from './buy/BuySheet.tsx';
import { PhantomSheet } from './wallet/PhantomSheet.tsx';
import { WalletMenu } from './wallet/WalletMenu.tsx';

// the board ships in the first chunk; the other pages load on demand (and on idle right after the first paint)
const loadCoin = () => import('./coin/CoinPage.tsx');
const loadDev = () => import('./dev/DevPage.tsx');
const loadMe = () => import('./me/MePage.tsx');
const loadDocs = () => import('./docs/DocsPage.tsx');
const CoinPage = lazy(() => loadCoin().then((m) => ({ default: m.CoinPage })));
const DevPage = lazy(() => loadDev().then((m) => ({ default: m.DevPage })));
const MePage = lazy(() => loadMe().then((m) => ({ default: m.MePage })));
const DocsPage = lazy(() => loadDocs().then((m) => ({ default: m.DocsPage })));
const LegalPage = lazy(() => import('./docs/LegalPage.tsx').then((m) => ({ default: m.LegalPage })));
const ConnectCoinSheet = lazy(() => loadDev().then((m) => ({ default: m.ConnectCoinSheet })));

function prefetchPages(): void {
  const go = () => void Promise.all([loadCoin(), loadDev(), loadMe(), loadDocs()]).catch(() => null);
  const w = window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 4000 });
  else window.setTimeout(go, 2500);
}

function PageWait() {
  return (
    <div className="page" aria-hidden="true" data-page-wait>
      <span className="sk" style={{ height: 120, marginTop: 24 }} />
      <span className="sk" style={{ height: 320, marginTop: 16 }} />
    </div>
  );
}

export function App() {
  const route = router.use((s) => s.route);
  const path = router.use((s) => s.path);
  const phone = useMedia(PHONE);

  useEffect(() => {
    document.title = copy.title;
    prefetchPages();
  }, []);
  useEffect(() => {
    dropOverlays();
    window.scrollTo(0, 0);
  }, [path]);

  let page;
  switch (route.name) {
    case 'board':
      page = <Board />;
      break;
    case 'coin':
      page = <CoinPage mint={route.mint} />;
      break;
    case 'dev':
      page = <DevPage mint={route.mint} />;
      break;
    case 'me':
      page = <MePage />;
      break;
    case 'docs':
      page = <DocsPage />;
      break;
    case 'terms':
    case 'privacy':
      page = <LegalPage kind={route.name} />;
      break;
  }

  return (
    <>
      <div className={'app r-' + route.name}>
        <a
          className="skip-link"
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('main')?.focus();
          }}
        >
          {copy.nav.skip}
        </a>
        <DitherDefs />
        <TopBar />
        <main id="main" className="main" tabIndex={-1} key={path}>
          <Suspense fallback={<PageWait />}>{page}</Suspense>
        </main>
        <Footer />
        {phone && route.name === 'board' && <BottomBar />}
      </div>
      <BuySheet />
      <Suspense fallback={null}>
        <ConnectCoinSheet />
      </Suspense>
      <PhantomSheet />
      <WalletMenu />
      <Toasts />
    </>
  );
}
