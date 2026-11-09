import { aiRouter, type GenerateRequest, type GenerateResult } from '@/services/ai/AIRouter';
import type { Language, Platform } from '@/types/models';
import { buildBrandContext } from './brandContext';
import { parseIdeas, parseVariations, type Variation } from './parse';
import { researchPrompt, studioPrompt, transformPrompt, type ResearchKind, type StudioInput, type TransformAction } from './prompts';

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
