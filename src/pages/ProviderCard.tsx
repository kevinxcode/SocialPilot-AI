import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Select, Switch } from '@/components/ui';
import type { AIModel, ProviderConfig, ProviderId, ProviderStatus } from '@/types/models';
import type { TestResult } from '@/services/ai/types';

export interface ProviderCardProps {
  id: ProviderId;
  label: string;
  cfg: ProviderConfig;
  status?: ProviderStatus;
  models: AIModel[];
  onChange: (patch: Partial<ProviderConfig>) => void;
  onTest: () => Promise<TestResult>;
  onRefresh: () => Promise<void>;
}

export function modelOptionLabel(m: AIModel): string {
  const tag = m.providerId === 'ollama' ? '' : m.isFree ? '(free)' : m.providerId === 'nvidia' ? '(credits)' : '(paid)';
  const name = tag && m.name.toLowerCase().includes(tag) ? m.name : [m.name, tag].filter(Boolean).join(' ');
  return m.vision ? `${name} 👁` : name;
}

export function modelBadges(m: AIModel) {
  return (
    <>
      {m.providerId === 'ollama' ? <Badge tone="success">Local</Badge> : m.isFree ? <Badge tone="success">Free</Badge> : <Badge tone="warning">{m.providerId === 'nvidia' ? 'Credits' : 'Paid'}</Badge>}
      {m.vision && <Badge tone="info">Vision</Badge>}
    </>
  );
}

export function ProviderCard(p: ProviderCardProps) {
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const needsKey = p.id !== 'ollama';
  const selected = p.models.find((m) => m.id === p.cfg.model);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await p.onTest());
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message, latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await p.onRefresh();
    } catch (e) {
      setRefreshError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const configured = needsKey ? !!p.cfg.apiKey : true;
  return (
    <Card data-testid={`provider-${p.id}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{p.label}</h3>
          {!configured ? (
            <Badge>Not configured</Badge>
          ) : p.status?.lastTestOk === true ? (
            <Badge tone="success">Connected</Badge>
          ) : p.status?.lastTestOk === false ? (
            <Badge tone="danger">Error</Badge>
          ) : (
            <Badge>Untested</Badge>
          )}
        </div>
        <Switch checked={p.cfg.enabled} onChange={(v) => p.onChange({ enabled: v })} label={`Enable ${p.label}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={p.id === 'ollama' ? 'Host' : 'Base URL'}>
          <Input value={p.cfg.baseUrl} onChange={(e) => p.onChange({ baseUrl: e.target.value })} />
        </Field>
        {needsKey && (
          <Field label="API key (stored locally, never exported)">
            <KeyInput
              value={p.cfg.apiKey ?? ''}
              placeholder={p.id === 'nvidia' ? 'nvapi-…' : 'sk-or-…'}
              onSave={(v) => p.onChange({ apiKey: v || undefined })}
            />
          </Field>
        )}
        <Field label="Default model">
          <div className="flex gap-2">
            <Select value={p.cfg.model ?? ''} onChange={(e) => p.onChange({ model: e.target.value || undefined })}>
              <option value="">— select —</option>
              {p.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelOptionLabel(m)}
                </option>
              ))}
            </Select>
            <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} aria-label="Refresh models" title="Refresh models">
              <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
          </div>
          {selected && <div className="mt-1 flex gap-1">{modelBadges(selected)}</div>}
          {refreshError && <p className="mt-1 text-xs text-red-500">{refreshError}</p>}
        </Field>
        <Field label="Timeout (s)">
          <Input
            type="number"
            min={5}
            value={Math.round(p.cfg.timeoutMs / 1000)}
            onChange={(e) => p.onChange({ timeoutMs: Math.max(5, Number(e.target.value) || 60) * 1000 })}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {result && (
          <span role="status" className={result.ok ? 'flex items-center gap-1 text-emerald-600' : 'flex items-center gap-1 text-red-500'}>
            {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {result.ok ? 'OK' : 'Failed'} — {result.message}
            {result.latencyMs ? ` (${result.latencyMs} ms)` : ''}
          </span>
        )}
        {p.status?.lastSuccessAt && (
          <span className="text-xs text-muted-foreground">Last success: {new Date(p.status.lastSuccessAt).toLocaleString()}</span>
        )}
      </div>
      {p.id === 'ollama' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cost Rp0 — local hardware/electricity not included. If tests return 403, start Ollama with{' '}
          <code>OLLAMA_ORIGINS=chrome-extension://*</code>.
        </p>
      )}
      {p.id === 'nvidia' && (
        <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <Switch checked={!!p.cfg.freeTier} onChange={(v) => p.onChange({ freeTier: v })} label="NVIDIA free developer tier" />
          <span>
            My NVIDIA account is the free developer tier (no billing). Treat its models as <b>free</b> so “only free” and Autopilot can use them.
            Click ↻ refresh models after switching. Leave off if your account has paid billing.
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * Local state while typing/pasting (settings are saved asynchronously, so a controlled input could drop a paste);
 * saved on blur, Enter or the Save button.
 */
function KeyInput({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [show, setShow] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.replace(/\s+/g, '');
    if (v !== value) onSave(v);
  };
  return (
    <div className="flex gap-2">
      <Input
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <Button variant="outline" size="sm" type="button" onClick={() => setShow((s) => !s)}>
        {show ? 'Hide' : 'Show'}
      </Button>
      <Button size="sm" type="button" onClick={commit}>
        Save
      </Button>
    </div>
  );
}
