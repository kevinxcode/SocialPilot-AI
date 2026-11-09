import type { ReactNode } from 'react';
import type { PageId } from '@/layouts/Sidebar';
import { AIProvidersPage } from '@/pages/AIProviders';
import { SettingsPage } from '@/pages/Settings';

type Render = (navigate: (p: PageId) => void) => ReactNode;

export const PAGES: Partial<Record<PageId, Render>> = {
  providers: () => <AIProvidersPage />,
  settings: () => <SettingsPage />,
};
