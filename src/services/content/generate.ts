import { aiRouter, type GenerateRequest, type GenerateResult } from '@/services/ai/AIRouter';
import type { Language, Platform } from '@/types/models';
import { buildBrandContext } from './brandContext';
import { extractJson, normalizeHashtags, parseIdeas, parseVariations, type Variation } from './parse';
import { instagramImagePrompt, researchPrompt, studioPrompt, transformPrompt, type ResearchKind, type StudioInput, type TransformAction } from './prompts';

export interface RouterLike {
  generate(req: GenerateRequest, onToken?: (t: string) => void): Promise<GenerateResult>;
}
interface Deps {
  router?: RouterLike;
  purpose?: GenerateRequest['purpose'];
  signal?: AbortSignal;
  onToken?: (t: string) => void;
}

const SYSTEM_SUFFIX =
  '\n\nYou are an expert social media copywriter for this brand. Write natural, engaging, non-repetitive content appropriate for each platform.';

export async function generateVariations(input: StudioInput, n = 3, deps: Deps = {}): Promise<Variation[] & { meta?: GenerateResult }> {
  const router = deps.router ?? aiRouter;
  const system = (await buildBrandContext(input.brandId)) + SYSTEM_SUFFIX;
  const r = await router.generate(
    {
      purpose: deps.purpose ?? 'interactive',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: studioPrompt(input, n) },
      ],
      signal: deps.signal,
      temperature: 0.9,
    },
    deps.onToken,
  );
  const out = parseVariations(r.text, input.platform) as Variation[] & { meta?: GenerateResult };
  out.meta = { ...r, text: '' };
  return out;
}

export async function transform(
  text: string,
  action: TransformAction,
  opts: { brandId: string; platform: Platform; language: Language; tone?: string },
  deps: Deps = {},
): Promise<string> {
  const router = deps.router ?? aiRouter;
  const r = await router.generate({
    purpose: deps.purpose ?? 'interactive',
    messages: [
      { role: 'system', content: (await buildBrandContext(opts.brandId)) + SYSTEM_SUFFIX },
      { role: 'user', content: transformPrompt(text, action, opts.platform, opts.language, opts.tone) },
    ],
    signal: deps.signal,
  });
  return r.text.replace(/^```\w*\n?|```$/g, '').replace(/^"|"$/g, '').trim();
}

export async function research(
  kind: ResearchKind,
  opts: { brandId: string; language: Language; focus: string; source?: string },
  deps: Deps = {},
): Promise<{ title: string; body: string }[]> {
  const router = deps.router ?? aiRouter;
  const r = await router.generate({
    purpose: 'interactive',
    messages: [
      { role: 'system', content: (await buildBrandContext(opts.brandId)) + '\n\nYou are a content strategist for this brand.' },
      { role: 'user', content: researchPrompt(kind, opts.language, opts.focus, opts.source) },
    ],
    signal: deps.signal,
  });
  return parseIdeas(r.text);
}

/** Parses the vision model's answer: JSON {caption, hashtags} — or, if a model ignores JSON, the plain text. */
export function parseImageCaption(text: string): { caption: string; hashtags: string[] } {
  const j = extractJson(text) as { caption?: unknown; hashtags?: unknown } | undefined;
  if (j && typeof j === 'object' && typeof j.caption === 'string' && j.caption.trim()) {
    const tags = normalizeHashtags(j.hashtags).slice(0, 30);
    // A model may also put hashtags inside the caption: keep them out of the body, merged into the list.
    const inline = j.caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    const caption = j.caption.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, '').trim();
    return { caption, hashtags: [...new Set([...tags, ...inline])].slice(0, 30) };
  }
  const plain = text.replace(/^```\w*\n?|```$/g, '').trim();
  if (!plain) throw new Error('The AI returned an empty caption — try again or pick another model.');
  const hashtags = [...new Set(plain.match(/#[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 30);
  return { caption: plain.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[ \t]+\n/g, '\n').trim(), hashtags };
}

/**
 * Instagram caption + hashtags generated FROM THE IMAGE (needs a model with vision).
 * `imageDataUrl` should already be downscaled (see shrinkImage) to keep the request small.
 */
export async function generateInstagramCaption(
  imageDataUrl: string,
  opts: { brandId: string; language: Language; hint?: string },
  deps: Deps = {},
): Promise<{ caption: string; hashtags: string[]; meta: GenerateResult }> {
  const router = deps.router ?? aiRouter;
  const r = await router.generate({
    purpose: deps.purpose ?? 'interactive',
    needsVision: true,
    messages: [
      { role: 'system', content: (await buildBrandContext(opts.brandId)) + SYSTEM_SUFFIX },
      { role: 'user', content: instagramImagePrompt(opts.language, opts.hint), images: [imageDataUrl] },
    ],
    signal: deps.signal,
    temperature: 0.8,
  });
  return { ...parseImageCaption(r.text), meta: { ...r, text: '' } };
}
