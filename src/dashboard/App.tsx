import { useEffect, useState, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button, Empty, ToastProvider } from '@/components/ui';
import { Sidebar, type PageId } from '@/layouts/Sidebar';
import { useSettings, useT, useTheme } from '@/hooks/useSettings';
import { seedIfEmpty } from '@/services/storage/db';
import { PAGES } from './pages';

function readHash(): PageId {
  const h = location.hash.replace('#/', '') as PageId;
  return h && h in PAGES ? h : 'dashboard';
}

export function App() {
  const { settings, update } = useSettings();
  const t = useT();
  useTheme(settings?.theme);
  const [page, setPage] = useState<PageId>(readHash);

  useEffect(() => {
    seedIfEmpty();
    const onHash = () => setPage(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (p: PageId) => {
    location.hash = `#/${p}`;
    setPage(p);
  };
  const isDark = document.documentElement.classList.contains('dark');
  const render = PAGES[page] as ((nav: (p: PageId) => void) => ReactNode) | undefined;

  return (
    <ToastProvider>
      <div className="flex min-h-screen">
        <Sidebar page={page} onNavigate={navigate} t={t} />
        <main className="min-w-0 flex-1">
          <header className="flex h-14 items-center justify-between border-b border-border px-6">
            <h1 className="text-lg font-semibold">{t(page)}</h1>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => update({ theme: isDark ? 'light' : 'dark' })}
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </header>
          <div className="mx-auto max-w-6xl p-6">{render ? render(navigate) : <Empty>Not available.</Empty>}</div>
        </main>
      </div>
    </ToastProvider>
  );
}
