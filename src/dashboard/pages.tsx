import type { ReactNode } from 'react';
import type { PageId } from '@/layouts/Sidebar';
import { AIProvidersPage } from '@/pages/AIProviders';
import { SettingsPage } from '@/pages/Settings';
import { BrandKnowledgePage } from '@/pages/BrandKnowledge';
import { ContentStudioPage } from '@/pages/ContentStudio';
import { ResearchPage } from '@/pages/Research';
import { MediaLibraryPage } from '@/pages/MediaLibrary';

type Render = (navigate: (p: PageId) => void) => ReactNode;

export const PAGES: Partial<Record<PageId, Render>> = {
  providers: () => <AIProvidersPage />,
  settings: () => <SettingsPage />,
  brand: () => <BrandKnowledgePage />,
  studio: () => <ContentStudioPage />,
  research: () => <ResearchPage />,
  media: () => <MediaLibraryPage />,
};
