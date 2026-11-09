import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Field, Input, Textarea, useToast } from '@/components/ui';
import { db } from '@/services/storage/db';
import { sendToSw } from '@/background/messages';
import { uid } from '@/lib/utils';
import type { Account, Platform } from '@/types/models';
import { GroupsCard } from './GroupsCard';

export function validateAccount(platform: Platform, profileUrl: string, name: string): string | null {
  let u: URL;
  try {
    u = new URL(profileUrl);
  } catch {
    return 'Enter a full URL starting with https://';
  }
  if (platform === 'threads') {
    if (!/(^|\.)threads\.(net|com)$/.test(u.hostname)) return 'Threads URL must be on threads.com or threads.net';
    if (!/^\/@[A-Za-z0-9._]+\/?$/.test(u.pathname)) return 'Use your profile URL, e.g. https://www.threads.com/@username';
  } else {
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return 'Facebook Page URL must be on facebook.com';
    if (u.pathname === '/' || /^\/(profile\.php)?$/.test(u.pathname)) return 'Use the Page URL, e.g. https://www.facebook.com/YourPage';
    if (!name.trim()) return 'Enter the exact Page name — it is used to confirm you are posting as the Page';
  }
  return null;
}

function AccountCard({ platform }: { platform: Platform }) {
  const toast = useToast();
  const acc = useLiveQuery(() => db.accounts.where('platform').equals(platform).first(), [platform]);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'check' | 'dry' | null>(null);
  const [dryText, setDryText] = useState('Tes SocialPilot AI — dry run, tidak akan diposting. 🧺');
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (acc) {
      setUrl(acc.profileUrl);
      setName(acc.name);
    }
  }, [acc]);

  const save = async () => {
    const err = validateAccount(platform, url.trim(), name);
    if (err) return toast(err, 'err');
    const handle = url.match(/@([A-Za-z0-9._]+)/)?.[1];
    const next: Account = {
      id: acc?.id ?? uid(),
      platform,
      profileUrl: url.trim().replace(/\/$/, ''),
      name: platform === 'threads' ? (handle ?? name) : name.trim(),
    };
    await db.accounts.put(next);
    // keep posts pointing at the single account for this platform
    await db.posts.where('platform').equals(platform).modify({ accountId: next.id });
    toast('Account saved');
  };

  const run = async (kind: 'check' | 'dry') => {
    setBusy(kind);
    setResult(null);
    const r = await sendToSw(kind === 'check' ? { type: 'checkLogin', platform } : { type: 'dryRun', platform, text: dryText });
    setResult(r);
    setBusy(null);
  };

  const title = platform === 'threads' ? 'Threads account' : 'Facebook Page';
  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        {title}
        {acc?.lastCheckAt &&
          (acc.lastCheckOk ? <Badge tone="success">Logged in</Badge> : <Badge tone="danger">Check failed</Badge>)}
      </CardTitle>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={platform === 'threads' ? 'Profile URL' : 'Page URL'}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={platform === 'threads' ? 'https://www.threads.com/@cuciqu.pro' : 'https://www.facebook.com/cuciqupro'}
          />
        </Field>
        {platform === 'facebook' && (
          <Field label="Page name (exactly as shown on Facebook)">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CuciQu Pro" />
          </Field>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="outline" disabled={!acc || !!busy} onClick={() => run('check')}>
          {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" />} Check login
        </Button>
      </div>
      {acc?.lastCheckMessage && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last check {new Date(acc.lastCheckAt ?? 0).toLocaleString()}: {acc.lastCheckMessage}
        </p>
      )}
      <div className="mt-4 rounded-md border border-border p-3">
        <div className="mb-2 text-sm font-medium">Test publisher (dry run)</div>
        <p className="mb-2 text-xs text-muted-foreground">
          Opens the composer in an automation window, types this text and stops before clicking Post. Nothing is published. The window stays
          open so you can inspect it, then close it yourself.
        </p>
        <Textarea rows={2} value={dryText} onChange={(e) => setDryText(e.target.value)} />
        <Button className="mt-2" variant="outline" disabled={!acc || !!busy} onClick={() => run('dry')}>
          {busy === 'dry' && <Loader2 className="h-4 w-4 animate-spin" />} Run dry run
        </Button>
      </div>
      {result && (
        <p role="status" className={`mt-2 flex items-center gap-1 text-sm ${result.ok ? 'text-emerald-600' : 'text-red-500'}`}>
          {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {result.message ?? (result.ok ? 'OK' : 'Failed')}
        </p>
      )}
    </Card>
  );
}

export function SocialAccountsPage() {
  return (
    <div className="space-y-4">
      <Card className="flex gap-3 border-amber-500/40 bg-amber-500/5 text-sm">
        <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" />
        <div>
          Publishing works by automating the Threads and Facebook websites in this Chrome profile (no Meta API). Chrome must be open and you
          must stay logged in. SocialPilot never asks for or stores your password. Automated posting may break when Meta changes its UI and may
          be against Meta&apos;s terms — use at your own risk.
        </div>
      </Card>
      <AccountCard platform="threads" />
      <AccountCard platform="facebook" />
      <GroupsCard />
    </div>
  );
}
