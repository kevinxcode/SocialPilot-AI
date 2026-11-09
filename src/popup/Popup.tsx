import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { Copy, ExternalLink, Loader2, Save, Sparkles } from 'lucide-react';
import { Badge, Button, Select, Switch, Textarea, ToastProvider, useToast } from '@/components/ui';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { db, seedIfEmpty } from '@/services/storage/db';
import { generateVariations } from '@/services/content/generate';
import { createDraft } from '@/services/publishing/posts';
import { getActiveBrandId } from '@/pages/BrandKnowledge';
import type { Platform } from '@/types/models';

function PopupBody() {
  const { settings, update } = useSettings();
  useTheme(settings?.theme);
  const toast = useToast();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  // The real next attempt is the queue item's runAt (gap rules and retries move it), not the original schedule.
  const next = useLiveQuery(async () => {
    const items = (await db.queue.orderBy('runAt').toArray()).filter((q) => q.kind === 'post' && q.postId);
    for (const q of items) {
      const p = await db.posts.get(q.postId!);
      if (p && ['scheduled', 'verifying'].includes(p.status)) return { ...p, scheduledAt: q.runAt };
    }
    return undefined;
  }, []);
  const failed = useLiveQuery(() => db.posts.where('status').equals('failed').filter((p) => p.updatedAt > Date.now() - 86_400_000).count(), []);
  const [topic, setTopic] = useState('');
  const [platform, setPlatform] = useState<Platform>('threads');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void seedIfEmpty();
  }, []);

  const generate = async () => {
    const brandId = await getActiveBrandId(settings?.activeBrandId);
    if (!brandId) return toast('No brand configured', 'err');
    setBusy(true);
    try {
      const v = await generateVariations(
        { brandId, topic, objective: '', audience: '', language: settings?.language ?? 'id', platform, contentType: 'educational', tone: '', cta: '', hashtags: '' },
        1,
      );
      setOut(v[0]?.caption ?? '');
    } catch (e) {
      toast((e as Error).message.slice(0, 160), 'err');
    } finally {
      setBusy(false);
    }
  };
  const ap = settings?.autopilot;

  return (
    <div className="w-[360px] space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">SocialPilot AI</span>
        <Button size="sm" variant="ghost" onClick={() => chrome.runtime.openOptionsPage()}>
          Dashboard <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="rounded-md bg-muted p-3">
        <div className="text-xs text-muted-foreground">Next post</div>
        {next ? (
          <div>
            <span className="font-medium">{formatInTimeZone(next.scheduledAt ?? 0, tz, 'EEE dd MMM HH:mm')}</span> ·{' '}
            {next.platform === 'threads' ? 'Threads' : 'Facebook'} {next.source === 'autopilot' && <Badge tone="info">Auto</Badge>}
            <div className="truncate text-xs text-muted-foreground">{next.text}</div>
          </div>
        ) : (
          <div className="text-muted-foreground">Nothing scheduled</div>
        )}
        {!!failed && <div className="mt-1 text-xs text-red-500">{failed} failed in the last 24 h</div>}
      </div>
      <div className="flex items-center justify-between rounded-md border border-border p-3">
        <div>
          <div className="font-medium">Autopilot</div>
          <div className="text-xs text-muted-foreground">{ap?.enabled ? `${ap.postsPerDay}/day · ${ap.paused ? 'paused' : 'running'}` : 'off — set up in Settings'}</div>
        </div>
        {ap?.enabled && <Switch checked={!ap.paused} onChange={(v) => update({ autopilot: { paused: !v } })} label="Autopilot running" />}
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Textarea rows={2} placeholder="Quick generate — topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Select className="w-28" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} aria-label="Platform">
            <option value="threads">Threads</option>
            <option value="facebook">Facebook</option>
          </Select>
        </div>
        <Button className="w-full" onClick={generate} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {busy ? 'Generating…' : 'Generate'}
        </Button>
        {out && (
          <>
            <Textarea rows={6} value={out} onChange={(e) => setOut(e.target.value)} aria-label="Generated post" />
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(out).then(() => toast('Copied'))}>
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await createDraft({ platform, text: out, brandId: await getActiveBrandId(settings?.activeBrandId) });
                  toast('Draft saved — schedule it from the dashboard');
                }}
              >
                <Save className="h-3.5 w-3.5" /> Save draft
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Popup() {
  return (
    <ToastProvider>
      <PopupBody />
    </ToastProvider>
  );
}
