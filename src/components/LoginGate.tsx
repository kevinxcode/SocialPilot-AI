import { useEffect, useState, type ReactNode } from 'react';
import { Copy, Loader2, LogIn, Sparkles } from 'lucide-react';
import { Button, Field, Input, useToast } from '@/components/ui';
import { getCloudConfig, setCloudConfig, type CloudConfig } from '@/services/cloud/config';
import { loginWithGoogle } from '@/services/cloud/login';

const SKIP_KEY = 'cloudGateSkipped';

type State = { loading: true } | { loading: false; signedIn: boolean; configured: boolean; skipped: boolean };

async function readState(): Promise<State> {
  const r = await chrome.storage.local.get(['cloudSession', SKIP_KEY]);
  const configured = !!(await getCloudConfig());
  return { loading: false, signedIn: !!r.cloudSession, configured, skipped: !!r[SKIP_KEY] && !configured };
}

/**
 * "Login with Google" is required before using the dashboard / popup.
 * Until the Firebase project is set up the screen also holds the 3 setup fields (and a temporary way to continue
 * offline, so nobody is locked out of their own data); once it is set up, signing in is mandatory.
 * Publishing in the background keeps running either way.
 */
export function LoginGate({ children, mode }: { children: ReactNode; mode: 'dashboard' | 'popup' }) {
  const toast = useToast();
  const [st, setSt] = useState<State>({ loading: true });
  const [cfg, setCfg] = useState<CloudConfig>({ apiKey: '', projectId: '', clientId: '' });
  const [busy, setBusy] = useState(false);
  const redirect = typeof chrome !== 'undefined' && chrome.identity ? chrome.identity.getRedirectURL() : '';

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

  const login = async () => {
    setBusy(true);
    try {
      if ((await loginWithGoogle((m) => confirm(m))) === 'cancelled') toast('Sign-in cancelled — nothing was changed', 'err');
    } catch (e) {
      toast((e as Error).message.slice(0, 200), 'err');
    } finally {
      setBusy(false);
      setSt(await readState());
    }
  };
  const save = async () => {
    if (!cfg.apiKey.trim() || !cfg.projectId.trim() || !cfg.clientId.trim()) return toast('Fill in all three fields', 'err');
    await setCloudConfig(cfg);
    toast('Saved — now sign in with Google');
  };

  if (mode === 'popup') {
    return (
      <div className="w-[360px] space-y-3 p-5 text-center text-sm">
        <Sparkles className="mx-auto h-7 w-7 text-primary" />
        <div className="font-semibold">SocialPilot AI</div>
        <p className="text-muted-foreground">Sign in with Google to continue.</p>
        <Button className="w-full" onClick={() => chrome.runtime.openOptionsPage()}>
          <LogIn className="h-4 w-4" /> Open to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border p-8">
        <div className="text-center">
          <Sparkles className="mx-auto mb-2 h-9 w-9 text-primary" />
          <h1 className="text-xl font-semibold">SocialPilot AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in with your Google account to use SocialPilot on every browser and laptop.</p>
        </div>
        <Button className="w-full" disabled={busy || !st.configured} onClick={login}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Login with Google
        </Button>
        {!st.configured && (
          <p className="-mt-2 text-center text-xs text-amber-500">Login is available after the one-time setup below is saved.</p>
        )}
        {!st.configured && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">One-time setup (docs/SETUP-CLOUD.md): paste the values of your Firebase project.</p>
            <Field label="Web API key">
              <Input value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} placeholder="AIza…" />
            </Field>
            <Field label="Project ID">
              <Input value={cfg.projectId} onChange={(e) => setCfg({ ...cfg, projectId: e.target.value })} />
            </Field>
            <Field label="OAuth client ID (Web application)">
              <Input value={cfg.clientId} onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })} placeholder="…apps.googleusercontent.com" />
            </Field>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              Redirect URI: <code className="truncate rounded bg-muted px-1">{redirect}</code>
              <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(redirect).then(() => toast('Copied'))}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button variant="outline" className="w-full" onClick={save}>
              Save setup
            </Button>
            <button type="button" className="w-full text-xs text-muted-foreground underline" onClick={() => chrome.storage.local.set({ [SKIP_KEY]: true })}>
              Continue offline until the cloud is set up
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
