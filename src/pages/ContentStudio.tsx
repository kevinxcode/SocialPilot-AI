import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Loader2, RefreshCw, Save, Sparkles, Square } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Empty, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { generateVariations, transform } from '@/services/content/generate';
import { CONTENT_TYPES, type StudioInput, type TransformAction } from '@/services/content/prompts';
import { validatePost, visibleLength, LIMITS } from '@/services/content/validate';
import type { Variation } from '@/services/content/parse';
import { createDraft } from '@/services/publishing/posts';
import type { GenerateResult } from '@/services/ai/AIRouter';
import type { Brand, Language, Platform } from '@/types/models';
import { getActiveBrandId } from './BrandKnowledge';
import { PostActions, type PostActionsProps } from './PostActions';
import { groupInstructions } from '@/services/autopilot/runner';

const TRANSFORMS: { id: TransformAction; label: string }[] = [
  { id: 'rewrite', label: 'Rewrite' },
  { id: 'shorten', label: 'Shorten' },
  { id: 'expand', label: 'Expand' },
  { id: 'hook', label: 'Improve hook' },
  { id: 'tone', label: 'Change tone' },
  { id: 'hashtags', label: 'Hashtags' },
];
const EMPTY_BRANDS: Brand[] = [];

export function VariationCard(props: {
  v: Variation;
  brandId: string;
  language: Language;
  tone: string;
  meta?: GenerateResult;
  onChange: (caption: string) => void;
  actions?: (p: Omit<PostActionsProps, 'onDone'>) => React.ReactNode;
}) {
  const { v, brandId } = props;
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    validatePost(v.caption, v.platform, brandId).then((r) => alive && setErrors(r.errors));
    return () => {
      alive = false;
    };
  }, [v.caption, v.platform, brandId]);
  const len = visibleLength(v.caption);

  const run = async (a: TransformAction) => {
    setBusy(a);
    try {
      props.onChange(await transform(v.caption, a, { brandId, platform: v.platform, language: props.language, tone: props.tone }));
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{v.title || 'Untitled'}</div>
          <div className="text-xs text-muted-foreground">
            Suggested time: {v.suggestedTime || '—'} {props.meta && `· ${props.meta.providerId}/${props.meta.modelId}`}
          </div>
        </div>
        <Badge tone={len > LIMITS[v.platform] ? 'danger' : 'default'}>
          {len}
          {v.platform === 'threads' ? '/500' : ''}
        </Badge>
      </div>
      <Textarea rows={8} value={v.caption} onChange={(e) => props.onChange(e.target.value)} aria-label="Caption" />
      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-red-500">
          {errors.map((e) => (
            <li key={e}>⚠ {e}</li>
          ))}
        </ul>
      )}
      {v.imagePrompt && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Image prompt</summary>
          <p className="mt-1">{v.imagePrompt}</p>
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {TRANSFORMS.map((t) => (
          <Button key={t.id} size="sm" variant="outline" disabled={!!busy} onClick={() => run(t.id)}>
            {busy === t.id && <Loader2 className="h-3 w-3 animate-spin" />}
            {t.label}
          </Button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(v.caption);
            toast('Copied');
          }}
        >
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
        {props.actions?.({ text: v.caption, platform: v.platform, brandId, title: v.title, disabled: errors.length > 0 })}
      </div>
    </Card>
  );
}

export function ContentStudioPage() {
  const { settings } = useSettings();
  const toast = useToast();
  const brands = useLiveQuery(() => db.brands.toArray(), []) ?? EMPTY_BRANDS;
  const [brandId, setBrandId] = useState<string>('');
  const [input, setInput] = useState<Omit<StudioInput, 'brandId'>>({
    topic: '',
    objective: '',
    audience: '',
    language: 'id',
    platform: 'threads',
    contentType: 'educational',
    tone: 'friendly, practical',
    cta: '',
    hashtags: '',
    website: '',
  });
  const [variations, setVariations] = useState<Variation[]>([]);
  const groups = useLiveQuery(() => db.groups.toArray(), []) ?? [];
  const [groupId, setGroupId] = useState('');
  const group = groups.find((g) => g.id === groupId);
  const [meta, setMeta] = useState<GenerateResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [streamed, setStreamed] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getActiveBrandId(settings?.activeBrandId).then((id) => id && setBrandId((b) => b || id));
  }, [settings?.activeBrandId, brands.length]);
  useEffect(() => {
    const b = brands.find((x) => x.id === brandId);
    if (b) setInput((i) => ({ ...i, website: i.website || b.website, audience: i.audience || b.audience, cta: i.cta || b.cta }));
  }, [brandId, brands]);

  const set = <K extends keyof typeof input>(k: K, v: (typeof input)[K]) => setInput((i) => ({ ...i, [k]: v }));

  const generate = async () => {
    if (!brandId) return toast('Create a brand first', 'err');
    if (input.platform === 'fbgroup' && !group) return toast('Choose a Facebook Group first', 'err');
    abortRef.current = new AbortController();
    setLoading(true);
    setStreamed('');
    try {
      const out = await generateVariations({ ...input, brandId, extra: group ? groupInstructions(group) : undefined }, 3, {
        signal: abortRef.current.signal,
        onToken: (t) => setStreamed((s) => (s + t).slice(-400)),
      });
      setVariations(out);
      setMeta(out.meta);
    } catch (e) {
      if (!abortRef.current.signal.aborted) toast((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <Card className="h-fit space-y-3">
        <CardTitle>Brief</CardTitle>
        <Field label="Brand">
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Topic">
          <Textarea rows={2} value={input.topic} onChange={(e) => set('topic', e.target.value)} placeholder="mis. cara mengurangi cucian tertukar" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Platform">
            <Select value={input.platform} onChange={(e) => set('platform', e.target.value as Platform)}>
              <option value="threads">Threads</option>
              <option value="facebook">Facebook Page</option>
              <option value="fbgroup">Facebook Group</option>
            </Select>
          </Field>
          <Field label="Language">
            <Select value={input.language} onChange={(e) => set('language', e.target.value as Language)}>
              <option value="id">Indonesia</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>
        {input.platform === 'fbgroup' && (
          <Field label="Group">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">— choose a group —</option>
              {groups.filter((g) => g.enabled).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
            {!groups.length && <p className="mt-1 text-xs text-amber-600">Add groups in Social Accounts first.</p>}
          </Field>
        )}
        <Field label="Content type">
          <Select value={input.contentType} onChange={(e) => set('contentType', e.target.value)}>
            {CONTENT_TYPES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.en} — {c.id_}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Objective">
          <Input value={input.objective} onChange={(e) => set('objective', e.target.value)} placeholder="awareness, sign-ups, engagement…" />
        </Field>
        <Field label="Target audience">
          <Input value={input.audience} onChange={(e) => set('audience', e.target.value)} />
        </Field>
        <Field label="Tone">
          <Input value={input.tone} onChange={(e) => set('tone', e.target.value)} />
        </Field>
        <Field label="CTA">
          <Input value={input.cta} onChange={(e) => set('cta', e.target.value)} />
        </Field>
        <Field label="Website">
          <Input value={input.website} onChange={(e) => set('website', e.target.value)} />
        </Field>
        <Field label="Hashtag preferences">
          <Input value={input.hashtags} onChange={(e) => set('hashtags', e.target.value)} placeholder="#laundry #usahalaundry" />
        </Field>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : variations.length ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            {loading ? 'Generating…' : variations.length ? 'Regenerate' : 'Generate'}
          </Button>
          {loading && (
            <Button variant="outline" size="icon" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
              <Square className="h-4 w-4" />
            </Button>
          )}
        </div>
      </Card>
      <div className="space-y-3">
        {loading && streamed && <pre className="max-h-32 overflow-hidden whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">{streamed}</pre>}
        {!variations.length && !loading && <Empty>Fill in the brief and click Generate to get 3 variations.</Empty>}
        {variations.map((v, i) => (
          <VariationCard
            key={i}
            v={v}
            brandId={brandId}
            language={input.language}
            tone={input.tone}
            meta={meta}
            onChange={(caption) => setVariations((vs) => vs.map((x, j) => (j === i ? { ...x, caption } : x)))}
            actions={(p) => (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!p.text.trim()}
                  onClick={async () => {
                    await createDraft({ platform: p.platform, text: p.text, brandId, title: p.title, contentType: input.contentType, providerId: meta?.providerId, modelId: meta?.modelId, groupId: group?.id });
                    toast('Draft saved');
                  }}
                >
                  <Save className="h-3.5 w-3.5" /> Save draft
                </Button>
                <PostActions {...p} contentType={input.contentType} groupId={group?.id} />
              </>
            )}
          />
        ))}
      </div>
    </div>
  );
}
