import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, Loader2, Trash2, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Field, Input, Switch, Textarea, useToast } from '@/components/ui';
import { db } from '@/services/storage/db';
import { sendToSw } from '@/background/messages';
import { uid } from '@/lib/utils';

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

export function GroupsCard() {
  const toast = useToast();
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? [];
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; message?: string }>>({});

  const add = async () => {
    const err = validateGroupUrl(url.trim());
    if (err) return toast(err, 'err');
    if (!name.trim()) return toast('Enter the group name', 'err');
    await db.groups.add({ id: uid(), name: name.trim(), url: url.trim().replace(/\/$/, ''), rules: rules.trim(), enabled: true });
    setName('');
    setUrl('');
    setRules('');
  };
  const run = async (id: string, kind: 'check' | 'dry') => {
    setBusy(`${kind}:${id}`);
    const r =
      kind === 'check'
        ? await sendToSw({ type: 'checkGroup', groupId: id })
        : await sendToSw({ type: 'dryRun', platform: 'fbgroup', groupId: id, text: 'Tes SocialPilot AI — dry run, tidak akan diposting. 🧺' });
    setResult((s) => ({ ...s, [id]: r }));
    setBusy(null);
  };

  return (
    <Card>
      <CardTitle>Facebook Groups</CardTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        Post into groups you are a member of. Posts appear as whoever is active on Facebook (your Page, if you switched into it and the Page
        joined the group). Max 1 post per group per 24 h, {`≥`}30 min between groups, and the same text is never sent to two groups. Many
        groups require admin approval — those posts are marked “pending”.
      </p>
      <div className="grid gap-2 md:grid-cols-[1fr_1.4fr]">
        <Field label="Group name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pengusaha Laundry Indonesia" />
        </Field>
        <Field label="Group URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.facebook.com/groups/namagrup" />
        </Field>
        <div className="md:col-span-2">
          <Field label="Group rules (the AI follows these)">
            <Textarea rows={2} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="mis. Dilarang jualan langsung, link hanya di komentar, promosi hanya hari Jumat" />
          </Field>
        </div>
      </div>
      <Button className="mt-2" onClick={add}>
        Add group
      </Button>

      <ul className="mt-4 divide-y divide-border">
        {groups.map((g) => (
          <li key={g.id} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Switch checked={g.enabled} onChange={(v) => db.groups.update(g.id, { enabled: v })} label={`Enable ${g.name}`} />
                <a href={g.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {g.name}
                </a>
                {g.lastCheckOk === true && <Badge tone="success">OK</Badge>}
                {g.lastCheckOk === false && <Badge tone="danger">Check failed</Badge>}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(g.id, 'check')}>
                  {busy === `check:${g.id}` && <Loader2 className="h-3 w-3 animate-spin" />} Check
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(g.id, 'dry')}>
                  {busy === `dry:${g.id}` && <Loader2 className="h-3 w-3 animate-spin" />} Dry run
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Delete ${g.name}`} onClick={() => confirm(`Remove ${g.name}?`) && db.groups.delete(g.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <Textarea
              rows={1}
              defaultValue={g.rules}
              placeholder="Group rules"
              onBlur={(e) => e.target.value !== g.rules && db.groups.update(g.id, { rules: e.target.value })}
              aria-label={`Rules for ${g.name}`}
            />
            {(result[g.id] || g.lastCheckMessage) && (
              <p className={`flex items-center gap-1 text-xs ${(result[g.id]?.ok ?? g.lastCheckOk) ? 'text-emerald-600' : 'text-red-500'}`}>
                {(result[g.id]?.ok ?? g.lastCheckOk) ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {result[g.id]?.message ?? g.lastCheckMessage}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
