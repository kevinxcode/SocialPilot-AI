import {
  BarChart3,
  BookOpen,
  Bot,
  Camera,
  CalendarDays,
  Clock,
  Cloud,
  Image,
  Hash,
  Users,
  LayoutDashboard,
  Lightbulb,
  Settings as SettingsIcon,
  Share2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TKey } from '@/i18n';

export type PageId =
  | 'dashboard'
  | 'studio'
  | 'research'
  | 'calendar'
  | 'scheduled'
  | 'media'
  | 'topics'
  | 'groups'
  | 'instagram'
  | 'accounts'
  | 'analytics'
  | 'brand'
  | 'providers'
  | 'cloud'
  | 'settings';

export const NAV: { id: PageId; icon: LucideIcon }[] = [
  { id: 'dashboard', icon: LayoutDashboard },
  { id: 'studio', icon: Sparkles },
  { id: 'research', icon: Lightbulb },
  { id: 'calendar', icon: CalendarDays },
  { id: 'scheduled', icon: Clock },
  { id: 'media', icon: Image },
  { id: 'topics', icon: Hash },
  { id: 'accounts', icon: Share2 },
  { id: 'groups', icon: Users },
  { id: 'instagram', icon: Camera },
  { id: 'analytics', icon: BarChart3 },
  { id: 'brand', icon: BookOpen },
  { id: 'providers', icon: Bot },
  { id: 'cloud', icon: Cloud },
  { id: 'settings', icon: SettingsIcon },
];

export function Sidebar({ page, onNavigate, t }: { page: PageId; onNavigate: (p: PageId) => void; t: (k: TKey) => string }) {
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-border p-3" aria-label="Main">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <span className="font-semibold">SocialPilot AI</span>
      </div>
      {NAV.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onNavigate(id)}
          aria-current={page === id ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
            page === id && 'bg-muted font-medium text-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
          {t(id)}
        </button>
      ))}
    </nav>
  );
}
