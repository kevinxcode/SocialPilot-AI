import type { ReactNode } from 'react';
import type { PageId } from '@/layouts/Sidebar';
import { AIProvidersPage } from '@/pages/AIProviders';
import { SettingsPage } from '@/pages/Settings';
import { AutopilotSettings } from '@/pages/AutopilotSettings';
import { BrandKnowledgePage } from '@/pages/BrandKnowledge';
import { ContentStudioPage } from '@/pages/ContentStudio';
import { ResearchPage } from '@/pages/Research';
import { MediaLibraryPage } from '@/pages/MediaLibrary';
import { SocialAccountsPage } from '@/pages/SocialAccounts';
import { ScheduledPostsPage } from '@/pages/ScheduledPosts';
import { CalendarPage } from '@/pages/Calendar';
import { DashboardPage } from '@/pages/Dashboard';
import { AnalyticsPage } from '@/pages/Analytics';

type Render = (navigate: (p: PageId) => void) => ReactNode;

export const PAGES: Partial<Record<PageId, Render>> = {
  providers: () => <AIProvidersPage />,
  settings: () => <SettingsPage extra={<AutopilotSettings />} />,
  brand: () => <BrandKnowledgePage />,
  studio: () => <ContentStudioPage />,
  research: () => <ResearchPage />,
  media: () => <MediaLibraryPage />,
  accounts: () => <SocialAccountsPage />,
  scheduled: () => <ScheduledPostsPage />,
  calendar: () => <CalendarPage />,
  dashboard: (navigate) => <DashboardPage navigate={navigate} />,
  analytics: () => <AnalyticsPage />,
};
