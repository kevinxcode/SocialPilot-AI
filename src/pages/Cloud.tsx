import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Cloud, Loader2, LogIn, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Field, Input, useToast } from '@/components/ui';
import { sendToSw } from '@/background/messages';
import { builtInConfig, deviceId, getCloudConfig, getSession, setCloudConfig, type CloudConfig, type CloudSession } from '@/services/cloud/config';
import { sendPasswordReset, signOut } from '@/services/cloud/auth';
import { login } from '@/services/cloud/login';
import { getPassphrase, setPassphrase } from '@/services/cloud/crypto';
import { resealSettings, resetPull, SYNC_STATUS_KEY } from '@/services/cloud/sync';
import { currentLease, takeOver, type Lease } from '@/services/cloud/leader';

type Status = { at: number; ok: boolean; pushed?: number; pulled?: number; error?: string } | undefined;

function useStorage<T>(key: string): T | undefined {
  const [v, setV] = useState<T>();
  useEffect(() => {
    void chrome.storage.local.get(key).then((r) => setV(r[key] as T));
    const on = (c: Record<string, chrome.storage.StorageChange>, area: string) => area === 'local' && key in c && setV(c[key].newValue as T);
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [key]);
  return v;
}

export function CloudPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<CloudConfig>({ apiKey: '', projectId: '' });
  const [session, setSession] = useState<CloudSession | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pass, setPass] = useState('');
  const [hasPass, setHasPass] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lease, setLease] = useState<Lease | null>(null);
  const [me, setMe] = useState('');
  const status = useStorage<Status>(SYNC_STATUS_KEY);
  const keysLocked = useStorage<boolean>('cloudKeysLocked');

  const refresh = async () => {
    const c = await getCloudConfig();
    if (c) setCfg(c);
    const s = await getSession();
    setSession(s);
    setHasPass(!!(await getPassphrase()));
    setMe(await deviceId());
    if (s) setLease(await currentLease().catch(() => null));
  };
  useEffect(() => {
    void refresh();
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok);
      await refresh();
    } catch (e) {
      toast((e as Error).message.slice(0, 200), 'err');
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = () =>
    run('cfg', async () => {
      if (!cfg.apiKey.trim() || !cfg.projectId.trim()) throw new Error('Fill in both Firebase fields');
      await setCloudConfig(cfg);
    }, 'Cloud settings saved');

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    void run('login', async () => {
      if ((await login(email, password, (m) => confirm(m))) === 'cancelled') throw new Error('Sign-in cancelled — nothing was changed');
      setPassword('');
    }, 'Signed in — syncing now');
  };

  const savePass = () =>
    run('pass', async () => {
      if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters');
      await setPassphrase(pass);
      setPass('');
      resealSettings(); // upload the API keys encrypted with this passphrase
      await resetPull(); // and decrypt keys synced from other devices
      await sendToSw({ type: 'tick' });
    }, 'Passphrase saved on this device');


  const signedIn = !!session;
  const isMain = lease?.deviceId === me && (lease?.until ?? 0) > Date.now();

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="mb-1 flex items-center gap-2">
              <Cloud className="h-5 w-5" /> Cloud & Sync
            </CardTitle>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign in with your SocialPilot account to use the same brand, settings, groups, topics, ideas and posts on every browser and laptop.
              Images and videos stay on the computer where you added them (not synced), so posts with media are published from that
              computer. Facebook and Threads logins stay in each browser. Without an account everything keeps working on this computer only.
            </p>
          </div>
          {signedIn && (
            <Button variant="outline" disabled={!!busy} onClick={() => run('out', signOut, 'Signed out — this device works locally')}>
              <LogOut className="h-4 w-4" /> Sign out {session.email}
            </Button>
          )}
        </div>
        {!signedIn && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={signIn}>
            <Field label="Email">
              <Input type="email" className="w-64" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </Field>
            <Field label="Password">
              <Input type="password" className="w-56" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <Button type="submit" disabled={!!busy || !cfg.apiKey || !email || !password}>
              {busy === 'login' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
            </Button>
            <Button type="button" variant="ghost" disabled={!!busy || !email} onClick={() => run('reset', () => sendPasswordReset(email), 'Password reset email sent')}>
              Forgot password?
            </Button>
          </form>
        )}
        {signedIn && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="success">
              <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
              {session.email}
            </Badge>
            {status && (
              <span className={status.ok ? 'text-muted-foreground' : 'text-red-500'}>
                {status.ok ? `Last sync ${new Date(status.at).toLocaleTimeString()} · sent ${status.pushed ?? 0}, received ${status.pulled ?? 0}` : `Sync failed: ${status.error}`}
              </span>
            )}
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('sync', () => sendToSw({ type: 'tick' }), 'Sync started')}>
              <RefreshCw className="h-3.5 w-3.5" /> Sync now
            </Button>
          </div>
        )}
      </Card>

      {signedIn && (
        <Card>
          <CardTitle className="mb-1">Publishing device</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Only one browser posts at a time, so nothing is ever posted twice. If it is offline for 15 minutes another device takes over. While the cloud is unreachable for that long, a signed-in browser pauses publishing (safety: it cannot be sure no other device is posting).
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {isMain ? <Badge tone="success">This browser is publishing</Badge> : <Badge>{lease ? `Publishing on another device (${lease.label.slice(0, 40)}…)` : 'No publishing device yet'}</Badge>}
            {!isMain && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('lead', async () => toast((await takeOver()) === 'now' ? 'This browser now publishes' : 'Requested — the other device hands over between posts (a few minutes)'))}>
                Publish from this browser
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardTitle className="mb-1 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> AI API keys — encrypted sync
        </CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Your AI API keys are encrypted with this passphrase before they leave the browser; the cloud only stores ciphertext.
          Use the same passphrase on every device. If you forget it the keys cannot be recovered — just paste them again.
        </p>
        {keysLocked && <p className="mb-2 text-sm text-red-500">Synced keys are locked: enter the passphrase you used on your other device.</p>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={hasPass ? 'Passphrase (saved on this device) — enter a new one to change it' : 'Passphrase (min. 8 characters)'}>
            <Input type="password" className="w-72" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button disabled={!!busy || pass.length < 8} onClick={savePass}>
            Save passphrase
          </Button>
        </div>
      </Card>


      {!builtInConfig() && (
        <Card>
          <CardTitle className="mb-1">Firebase project</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">One-time setup — follow docs/SETUP-CLOUD.md. These values stay on this device.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Web API key">
              <Input value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} placeholder="AIza…" />
            </Field>
            <Field label="Project ID">
              <Input value={cfg.projectId} onChange={(e) => setCfg({ ...cfg, projectId: e.target.value })} placeholder="socialpilot-12345" />
            </Field>
          </div>
          <div className="mt-3">
            <Button disabled={!!busy} onClick={saveConfig}>
              Save
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
