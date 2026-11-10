import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, LogIn, Sparkles } from 'lucide-react';
import { Button, Field, Input, useToast } from '@/components/ui';
import { getCloudConfig, setCloudConfig, type CloudConfig } from '@/services/cloud/config';
import { sendPasswordReset } from '@/services/cloud/auth';
import { login } from '@/services/cloud/login';

const SKIP_KEY = 'cloudGateSkipped';

type State = { loading: true } | { loading: false; signedIn: boolean; configured: boolean; skipped: boolean };

async function readState(): Promise<State> {
  const r = await chrome.storage.local.get(['cloudSession', SKIP_KEY]);
  const configured = !!(await getCloudConfig());
  return { loading: false, signedIn: !!r.cloudSession, configured, skipped: !!r[SKIP_KEY] };
}

/**
 * Start screen: sign in with the SocialPilot account (email + password, synced across computers) or
 * "Continue without an account" (everything stays on this computer). Until the Firebase project is set up the screen
 * also holds the 2 setup fields. Publishing in the background keeps running either way.
 */
export function LoginGate({ children, mode }: { children: ReactNode; mode: 'dashboard' | 'popup' }) {
  const toast = useToast();
  const [st, setSt] = useState<State>({ loading: true });
  const [cfg, setCfg] = useState<CloudConfig>({ apiKey: '', projectId: '' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const refresh = () => void readState().then(setSt);
    refresh();
    void getCloudConfig().then((c) => c && setCfg(c));
    const on = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && ('cloudSession' in c || 'cloudConfig' in c || SKIP_KEY in c)) refresh();
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);

  if (st.loading) return null;
  if (st.signedIn || st.skipped) return <>{children}</>;

  const skip = () => chrome.storage.local.set({ [SKIP_KEY]: true });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if ((await login(email, password, (m) => confirm(m))) === 'cancelled') toast('Sign-in cancelled — nothing was changed', 'err');
      setPassword('');
    } catch (err) {
      toast((err as Error).message.slice(0, 200), 'err');
    } finally {
      setBusy(false);
      setSt(await readState());
    }
  };
  const reset = async () => {
    try {
      await sendPasswordReset(email);
      toast('Password reset email sent — check your inbox');
    } catch (err) {
      toast((err as Error).message.slice(0, 200), 'err');
    }
  };
  const save = async () => {
    if (!cfg.apiKey.trim() || !cfg.projectId.trim()) return toast('Fill in both fields', 'err');
    await setCloudConfig(cfg);
    toast('Saved — now sign in');
  };

  if (mode === 'popup') {
    return (
      <div className="w-[360px] space-y-3 p-5 text-center text-sm">
        <Sparkles className="mx-auto h-7 w-7 text-primary" />
        <div className="font-semibold">SocialPilot AI</div>
        <p className="text-muted-foreground">Sign in to sync across computers — or use it without an account.</p>
        <Button className="w-full" onClick={() => chrome.runtime.openOptionsPage()}>
          <LogIn className="h-4 w-4" /> Open to sign in
        </Button>
        <button type="button" className="w-full text-xs text-muted-foreground underline" onClick={skip}>
          Continue without an account
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border p-8">
        <div className="text-center">
          <Sparkles className="mx-auto mb-2 h-9 w-9 text-primary" />
          <h1 className="text-xl font-semibold">SocialPilot AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in with your SocialPilot account. Use the same email on any computer and your data is there too.</p>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" disabled={!st.configured} />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={!st.configured} />
          </Field>
          <Button type="submit" className="w-full" disabled={busy || !st.configured || !email || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
          </Button>
          {st.configured && (
            <button type="button" className="w-full text-xs text-muted-foreground underline" onClick={reset}>
              Forgot password?
            </button>
          )}
        </form>
        {!st.configured && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs text-amber-500">Sign-in is available after this one-time setup (docs/SETUP-CLOUD.md): paste the values of your Firebase project.</p>
            <Field label="Web API key">
              <Input value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} placeholder="AIza…" />
            </Field>
            <Field label="Project ID">
              <Input value={cfg.projectId} onChange={(e) => setCfg({ ...cfg, projectId: e.target.value })} />
            </Field>
            <Button variant="outline" className="w-full" onClick={save}>
              Save setup
            </Button>
          </div>
        )}
        <button type="button" className="w-full text-sm text-muted-foreground underline" onClick={skip}>
          Continue without an account
        </button>
        <p className="-mt-3 text-center text-xs text-muted-foreground">Everything works on this computer; you can sign in later in Cloud & Sync.</p>
      </div>
    </div>
  );
}
