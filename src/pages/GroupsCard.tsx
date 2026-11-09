import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, Search, Sparkles, Trash2, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Switch, Textarea, useToast } from '@/components/ui';
import { db } from '@/services/storage/db';
import { sendToSw } from '@/background/messages';
import { uid } from '@/lib/utils';
import { aiRouter } from '@/services/ai/AIRouter';
import { getSettings } from '@/services/storage/settings';
import type { FbGroup } from '@/types/models';

export function validateGroupUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return 'Group URL must be on facebook.com';
    if (!/^\/groups\/[^/]+\/?$/.test(u.pathname)) return 'Use the group URL, e.g. https://www.facebook.com/groups/namagrup';
    return null;
  } catch {
    return 'Enter a full URL starting with https://';
  }
}

/** Parses the AI's "1, 4, 7" reply into 1-based indexes. */
export function parseIndexes(text: string): Set<number> {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return new Set((clean.match(/\d+/g) ?? []).map(Number));
}

/** Asks the AI which groups fit the brand's audience; returns their ids. */
async function relevantGroupIds(groups: FbGroup[]): Promise<string[]> {
  const s = await getSettings();
  const b = s.activeBrandId ? await db.brands.get(s.activeBrandId) : await db.brands.toCollection().first();
  const list = groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
  const r = await aiRouter.generate({
    purpose: 'interactive',
    temperature: 0,
    maxTokens: 200,
    messages: [
      {
        role: 'system',
        content:
          'You decide which Facebook groups are a good, non-spammy place for this brand to share helpful posts (its audience is actually there). Reply ONLY with the numbers of the suitable groups, comma-separated, or "none".',
      },
      { role: 'user', content: `Brand: ${b?.name ?? ''} (${b?.industry ?? ''}). ${b?.description ?? ''}\nAudience: ${b?.audience ?? ''}\n\nGroups:\n${list}` },
    ],
  });
  const nums = parseIndexes(r.text);
  return groups.filter((_g, i) => nums.has(i + 1)).map((g) => g.id);
}

type Result = { ok: boolean; message?: string };

function GroupRow({ g, busy, onRun, result }: { g: FbGroup; busy: string | null; onRun: (id: string, k: 'check' | 'dry') => void; result?: Result }) {
  const [open, setOpen] = useState(false);
  const status = result ?? (g.lastCheckOk === undefined ? undefined : { ok: g.lastCheckOk, message: g.lastCheckMessage });
  return (
    <li className="py-2">
      <div className="flex items-center gap-3">
        <Switch checked={g.enabled} onChange={(v) => db.groups.update(g.id, { enabled: v, ...(v ? { disabledReason: undefined } : {}) })} label={`Enable ${g.name}`} />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className={`truncate text-sm font-medium ${g.enabled ? '' : 'text-muted-foreground'}`} title={g.name}>
            {g.name}
          </span>
          {g.rules && <Badge>rules</Badge>}
          {status && (status.ok ? <Badge tone="success">OK</Badge> : <Badge tone="danger">check failed</Badge>)}
          {g.disabledReason && !g.enabled && (
            <Badge tone="danger" title={g.disabledReason}>
              auto-off
            </Badge>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onRun(g.id, 'check')}>
            {busy === `check:${g.id}` && <Loader2 className="h-3 w-3 animate-spin" />} Check
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onRun(g.id, 'dry')}>
            {busy === `dry:${g.id}` && <Loader2 className="h-3 w-3 animate-spin" />} Dry run
          </Button>
          <a href={g.url} target="_blank" rel="noreferrer" aria-label={`Open ${g.name}`} className="p-2 text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-4 w-4" />
          </a>
          <Button size="icon" variant="ghost" aria-label={`Delete ${g.name}`} onClick={() => confirm(`Remove ${g.name}?`) && db.groups.delete(g.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {open && (
        <div className="ml-14 mt-2 space-y-1">
          <Textarea
            rows={2}
            defaultValue={g.rules}
            placeholder="Group rules the AI must follow, e.g. no direct selling, links only in comments"
            onBlur={(e) => e.target.value !== g.rules && db.groups.update(g.id, { rules: e.target.value })}
            aria-label={`Rules for ${g.name}`}
          />
          {status?.message && (
            <p className={`flex items-center gap-1 text-xs ${status.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {status.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {status.message}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function GroupsPage() {
  const toast = useToast();
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? [];
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'on' | 'off'>('all');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [msg, setMsg] = useState<Result | null>(null);

  const enabledCount = groups.filter((g) => g.enabled).length;
  const visible = groups
    .filter((g) => (show === 'all' || (show === 'on') === g.enabled) && g.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

  const wrap = async (key: string, fn: () => Promise<Result>) => {
    setBusy(key);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const scan = () => wrap('scan', () => sendToSw({ type: 'scanGroups' }));
  const enableRelevant = () =>
    wrap('ai', async () => {
      const ids = await relevantGroupIds(groups);
      await db.transaction('rw', db.groups, async () => {
        for (const g of groups) await db.groups.update(g.id, { enabled: ids.includes(g.id) });
      });
      return { ok: true, message: `AI enabled ${ids.length} relevant groups and disabled ${groups.length - ids.length}.` };
    });
  const setAll = async (enabled: boolean) => {
    if (
      enabled &&
      !confirm(`Enable all ${groups.length} groups? Autopilot may then post in any of them (max 1 post per group per day). Unrelated groups often delete such posts or report them as spam.`)
    )
      return;
    await db.groups.toCollection().modify({ enabled });
  };
  const add = async () => {
    const err = validateGroupUrl(url.trim());
    if (err) return toast(err, 'err');
    if (!name.trim()) return toast('Enter the group name', 'err');
    await db.groups.add({ id: uid(), name: name.trim(), url: url.trim().replace(/\/$/, ''), rules: rules.trim(), enabled: true });
    setName('');
    setUrl('');
    setRules('');
    setAdding(false);
  };
  const run = async (id: string, kind: 'check' | 'dry') => {
    setBusy(`${kind}:${id}`);
    const r =
      kind === 'check'
        ? await sendToSw({ type: 'checkGroup', groupId: id })
        : await sendToSw({ type: 'dryRun', platform: 'fbgroup', groupId: id, text: 'Tes SocialPilot AI — dry run, tidak akan diposting. 🧺' });
    setResults((s) => ({ ...s, [id]: r }));
    setBusy(null);
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="mb-1">Facebook Groups</CardTitle>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Posts go to enabled groups only: max 1 post per group per day, ≥30 min between groups, never the same text twice. Many groups need
              admin approval; those posts show as “pending”.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy} onClick={scan}>
              {busy === 'scan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find my joined groups
            </Button>
            <Button variant="outline" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-4 w-4" /> Add manually
            </Button>
          </div>
        </div>
        {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{msg.message}</p>}
        {adding && (
          <div className="mt-4 grid gap-2 rounded-md border border-border p-3 md:grid-cols-2">
            <Field label="Group name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pengusaha Laundry Indonesia" />
            </Field>
            <Field label="Group URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.facebook.com/groups/namagrup" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Group rules (the AI follows these)">
                <Textarea rows={2} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="mis. Dilarang jualan langsung, link hanya di komentar" />
              </Field>
            </div>
            <div>
              <Button onClick={add}>Add group</Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups…" aria-label="Search groups" />
          <div className="flex rounded-md border border-border text-xs">
            {(['all', 'on', 'off'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setShow(k)}
                className={`px-3 py-1.5 ${show === k ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
              >
                {k === 'all' ? `All ${groups.length}` : k === 'on' ? `Enabled ${enabledCount}` : `Disabled ${groups.length - enabledCount}`}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" disabled={!!busy || groups.length === 0} onClick={enableRelevant}>
              {busy === 'ai' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Enable relevant (AI)
            </Button>
            <Button size="sm" variant="outline" disabled={groups.length === 0} onClick={() => setAll(true)}>
              Enable all
            </Button>
            <Button size="sm" variant="outline" disabled={groups.length === 0} onClick={() => setAll(false)}>
              Disable all
            </Button>
          </div>
        </div>
        {visible.length === 0 ? (
          <Empty>{groups.length ? 'No groups match.' : 'No groups yet. Click “Find my joined groups”.'}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((g) => (
              <GroupRow key={g.id} g={g} busy={busy} onRun={run} result={results[g.id]} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
