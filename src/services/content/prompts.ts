import type { Language, Platform } from '@/types/models';

export const CONTENT_TYPES = [
  { id: 'educational', en: 'Educational', id_: 'Edukasi' },
  { id: 'promotional', en: 'Promotional', id_: 'Promosi' },
  { id: 'storytelling', en: 'Storytelling', id_: 'Cerita' },
  { id: 'industry-news', en: 'Industry News', id_: 'Berita Industri' },
  { id: 'tips', en: 'Tips & Tricks', id_: 'Tips & Trik' },
  { id: 'product-updates', en: 'Product Updates', id_: 'Update Produk' },
  { id: 'engagement', en: 'Customer Engagement', id_: 'Interaksi Pelanggan' },
  { id: 'industry-research', en: 'Industry Research', id_: 'Riset Industri' },
  { id: 'pain-point', en: 'Problem & Solution', id_: 'Masalah & Solusi' },
  { id: 'question', en: 'Question & Discussion', id_: 'Tanya & Diskusi' },
  { id: 'comparison', en: 'Product Comparison', id_: 'Perbandingan Produk' },
  { id: 'soft-selling', en: 'Brand Awareness', id_: 'Brand Awareness' },
] as const;

export function contentTypeLabel(id: string): string {
  return CONTENT_TYPES.find((c) => c.id === id)?.en ?? id;
}

export interface StudioInput {
  brandId: string;
  topic: string;
  objective: string;
  audience: string;
  language: Language;
  platform: Platform;
  contentType: string;
  tone: string;
  cta: string;
  hashtags: string;
  website?: string;
  extra?: string;
}

const PLATFORM_RULES: Record<Platform, string> = {
  fbgroup:
    'Facebook Group: community post, 60–200 words, helpful and conversational, no hard selling, at most 2 hashtags, end with a question to start discussion. NO links or URLs at all. No markdown.',
  threads:
    'Threads: conversational, short paragraphs, max 500 characters for the whole caption INCLUDING hashtags and CTA. Use at most 3 hashtags. No markdown.',
  facebook:
    'Facebook Page: can be longer (ideally 80–250 words), skimmable short paragraphs, emojis sparingly, 3–6 hashtags at the end, a clear CTA without any link (e.g. "cari CuciQu Pro di Play Store"). NO links or URLs at all. No markdown.',
};

export const langName = (l: Language) => (l === 'id' ? 'Indonesian (Bahasa Indonesia, natural, not stiff)' : 'English');

export function studioPrompt(i: StudioInput, n: number): string {
  return [
    `Write ${n} variations of a social media post. Each variation must use a different angle and hook — never repeat phrasing.`,
    `Language: ${langName(i.language)}.`,
    `Platform rules — ${PLATFORM_RULES[i.platform]}`,
    `Content type: ${contentTypeLabel(i.contentType)}.`,
    i.topic && `Topic: ${i.topic}.`,
    i.objective && `Objective: ${i.objective}.`,
    i.audience && `Target audience: ${i.audience}.`,
    i.tone && `Tone: ${i.tone}.`,
    i.cta && `CTA to use: ${i.cta}.`,
    i.website && `Website to reference: ${i.website}.`,
    i.hashtags && `Hashtag preferences: ${i.hashtags}.`,
    i.extra,
    '',
    'Return ONLY JSON in this exact shape, no commentary:',
    '{"variations":[{"title":"","hook":"","body":"","cta":"","hashtags":["#..."],"caption":"<the complete ready-to-post text: hook, body, cta and hashtags separated by blank lines (use \n\n inside the JSON string)>","suggestedTime":"HH:mm (Asia/Jakarta)","imagePrompt":"<prompt for an image generator, English>"}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

export type TransformAction = 'rewrite' | 'shorten' | 'expand' | 'hook' | 'tone' | 'hashtags';

export function transformPrompt(text: string, action: TransformAction, platform: Platform, language: Language, tone?: string): string {
  const task: Record<TransformAction, string> = {
    rewrite: 'Rewrite the post with fresh wording while keeping the meaning and facts.',
    shorten: `Shorten the post${platform === 'threads' ? ' to well under 500 characters' : ''} while keeping the key message and CTA.`,
    expand: 'Expand the post with more helpful detail, using only facts from the knowledge base.',
    hook: 'Rewrite only the first line into a stronger, scroll-stopping hook. Keep the rest.',
    tone: `Rewrite the post in a ${tone || 'more friendly'} tone.`,
    hashtags: 'Replace the hashtags with 3–6 relevant hashtags for this post and audience.',
  };
  return [
    task[action],
    `Language: ${langName(language)}. Platform rules — ${PLATFORM_RULES[platform]}`,
    'Return ONLY the final post text, no quotes, no explanation.',
    '',
    'POST:',
    text,
  ].join('\n');
}

export const RESEARCH_KINDS = {
  topics: 'Trending-style topic ideas (AI-generated, not real-time trends)',
  themes: 'Industry discussion themes',
  educational: 'Educational topic list',
  painpoints: 'Audience pain points',
  weekly: 'Weekly marketing plan (7 days)',
  calendar: 'Content calendar for the next 4 weeks',
  questions: 'Engagement questions',
  competitor: 'Competitor content analysis (from text/URL you provide)',
} as const;
export type ResearchKind = keyof typeof RESEARCH_KINDS;

export function researchPrompt(kind: ResearchKind, language: Language, focus: string, source?: string): string {
  return [
    `Task: ${RESEARCH_KINDS[kind]}.`,
    `Language: ${langName(language)}.`,
    focus && `Focus: ${focus}.`,
    kind === 'competitor'
      ? `Analyse ONLY the competitor content below: what topics, hooks, formats and CTAs they use, gaps we can fill, and post ideas for our brand. Do not claim anything not present in the source.\n\nSOURCE:\n${(source ?? '').slice(0, 12000)}`
      : 'Do not claim these are real-time trends. Base ideas on general industry knowledge and the brand knowledge base.',
    'Return ONLY JSON: {"ideas":[{"title":"<short title>","body":"<2-4 sentence explanation or plan detail>"}]} with 6–12 ideas.',
  ]
    .filter(Boolean)
    .join('\n');
}
