import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Empty, Input, Switch, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { recordTopic, researchTopics } from '@/services/content/topics';
import { aiRouter } from '@/services/ai/AIRouter';
import { getActiveBrandId } from './BrandKnowledge';

export function TopicsPage() {
  const toast = useToast();
  const { settings, update } = useSettings();
  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sorted = [...topics].sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.uses - a.uses || a.name.localeCompare(b.name));

  const add = async () => {
    if (!name.trim()) return;
    await recordTopic(name.trim(), 'manual', false);
    setName('');
  };

  const research = async () => {
    setBusy(true);
    try {
      const brandId = await getActiveBrandId(settings?.activeBrandId);
      const b = brandId ? await db.brands.get(brandId) : undefined;
      const summary = b ? `${b.name} — ${b.industry}\n${b.description}\nAudience: ${b.audience}\nProducts: ${b.products}` : 'Laundry business software';
      const added = await researchTopics(summary, aiRouter);
      toast(added.length ? `Added ${added.length} topics` : 'No new topics found');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Threads topics</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Before each Threads post the AI picks one topic (the “Community or topic” field), preferring enabled topics below. New topics the AI
          chooses are added here automatically — disable or delete the ones you don’t want.
        </p>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Switch checked={!!settings?.autoTopic} onChange={(v) => update({ autoTopic: v })} label="Auto topic" />
          Auto-pick a topic for every Threads post
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Bisnis Laundry" />
          <Button variant="outline" onClick={add}>
            Add
          </Button>
          <Button onClick={research} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Research topics with AI
          </Button>
        </div>
      </Card>
      <Card>
        {sorted.length === 0 ? (
          <Empty>No topics yet. Add some or let the AI research them.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Switch checked={t.enabled} onChange={(v) => db.topics.update(t.id, { enabled: v })} label={`Enable ${t.name}`} />
                  <span className={t.enabled ? '' : 'text-muted-foreground line-through'}>{t.name}</span>
                  {t.source === 'ai' && <Badge tone="info">AI</Badge>}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>used {t.uses}×</span>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => db.topics.delete(t.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
