import { db } from '@/services/storage/db';
import type { Brand } from '@/types/models';

const CURRENCY = /(rp\.?|idr|usd|\$)\s?(\d[\d.,]*)\s*(juta|jt|ribu|rb|k)?\b/gi;
const PERCENT = /(\d+(?:[.,]\d+)?)\s?%/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;

function toNumber(raw: string, hasMultiplier: boolean): number {
  if (hasMultiplier) return Number(raw.replace(/\./g, '').replace(',', '.'));
  return Number(raw.replace(/[.,]/g, ''));
}

/** Normalised factual tokens: `rp99000`, `usd5`, `50%`, `3`. */
export function extractFacts(text: string): Set<string> {
  const out = new Set<string>();
  let rest = text.replace(CURRENCY, (_m, cur: string, num: string, mult?: string) => {
    const m = mult?.toLowerCase();
    const factor = m === 'juta' || m === 'jt' ? 1e6 : m === 'ribu' || m === 'rb' || m === 'k' ? 1e3 : 1;
    const value = Math.round(toNumber(num.replace(/[.,]$/, ''), !!m) * factor);
    const prefix = /usd|\$/i.test(cur) ? 'usd' : 'rp';
    if (Number.isFinite(value)) out.add(`${prefix}${value}`);
    return ' ';
  });
  rest = rest.replace(PERCENT, (_m, n: string) => {
    out.add(`${n.replace(',', '.')}%`);
    return ' ';
  });
  for (const m of rest.match(NUMBER) ?? []) out.add(m.replace(/[.,]$/, ''));
  return out;
}

async function brandAndKnowledge(brandId: string): Promise<{ brand: Brand; knowledge: string[] }> {
  const brand = await db.brands.get(brandId);
  if (!brand) throw new Error('Brand not found');
  const knowledge = (await db.knowledge.where('brandId').equals(brandId).toArray()).map((k) => `- ${k.title}: ${k.content}`);
  return { brand, knowledge };
}

function brandText(b: Brand): string {
  return [b.description, b.products, b.features, b.pricing, b.audience, b.strategy, b.cta, b.website, b.affiliateUrl ?? ''].join('\n');
}

/** System-prompt block that grounds generation in the knowledge base. */
export async function buildBrandContext(brandId: string): Promise<string> {
  const { brand: b, knowledge } = await brandAndKnowledge(brandId);
  const line = (label: string, v?: string) => (v && v.trim() ? `${label}: ${v.trim()}` : '');
  return [
    `BRAND KNOWLEDGE BASE — ${b.name}`,
    line('Website', b.website),
    line('Affiliate / sign-up link', b.affiliateUrl),
    line('Industry', b.industry),
    line('Description', b.description),
    line('Products', b.products),
    line('Features', b.features),
    line('Pricing', b.pricing || '(no pricing in knowledge base — do not mention prices)'),
    line('Target audience', b.audience),
    line('Brand voice', b.voice),
    line('Marketing strategy', b.strategy),
    line('Call to action', b.cta),
    knowledge.length ? `Additional knowledge:\n${knowledge.join('\n')}` : '',
    '',
    'RULES:',
    '- Use only the facts above. Never invent prices, features, statistics or testimonials.',
    '- Do not mention numbers, prices, percentages or discounts unless they appear above.',
    line('- Prohibited claims', b.prohibitedClaims),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export async function allowedFacts(brandId: string): Promise<Set<string>> {
  const { brand, knowledge } = await brandAndKnowledge(brandId);
  return extractFacts(`${brandText(brand)}\n${knowledge.join('\n')}`);
}
