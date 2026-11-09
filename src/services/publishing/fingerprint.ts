/** Stable caption fingerprint used for feed confirmation and dedupe (first 60 normalised chars). */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(text: string): string {
  return normalizeText(text).slice(0, 60).trim();
}
