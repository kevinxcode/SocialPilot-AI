import type { Language } from '@/types/models';

const ID_WORDS = new Set(['yang', 'dan', 'di', 'untuk', 'ini', 'itu', 'dengan', 'kamu', 'anda', 'ada', 'tidak', 'bisa', 'atau', 'ke', 'dari', 'jadi', 'kalau', 'sudah', 'biar', 'aja', 'supaya', 'pakai', 'nggak', 'gak', 'saja', 'lebih', 'kita', 'sering']);

/**
 * Cheap rule-based checks for broken AI output before it is published automatically.
 * Returns human-readable problems; empty = OK. The runner regenerates when anything is found.
 */
export function qualityIssues(text: string, language: Language): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (/<\/?think>/i.test(t)) out.push('contains model reasoning (<think>) text');
  if (/^\s*[[{]|"(caption|hook|body|variations)"\s*:/.test(t)) out.push('contains raw JSON instead of a post');
  if (/```/.test(t)) out.push('contains a code block');
  if (/\\[nrt]/.test(t)) out.push('contains a literal \\n instead of a real line break');
  if (/\[[^\]]{2,40}\]|\{\{?[^}]{2,40}\}?\}|lorem ipsum|\bTODO\b/i.test(t)) out.push('contains a placeholder like [Name] — write the real text');
  const words = t.replace(/https?:\/\/\S+|#[\p{L}\p{N}_]+/gu, ' ').match(/[\p{L}']+/gu) ?? [];
  if (words.length < 12) out.push(`too short (${words.length} words) — write a complete post`);
  if (language === 'id' && words.length >= 12 && words.filter((w) => ID_WORDS.has(w.toLowerCase())).length < 2)
    out.push('not written in Bahasa Indonesia — the post language must be Indonesian');
  const tags = t.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > 6) out.push(`too many hashtags (${tags.length}) — use at most 5`);
  return out;
}
