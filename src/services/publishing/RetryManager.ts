/** Retry policy: first attempt + up to 3 retries after 2 → 10 → 30 minutes. */
export const BACKOFF_MIN = [2, 10, 30] as const;
export const MAX_ATTEMPTS = 4; // 1 attempt + 3 retries

export function nextRetryAt(attempts: number, now: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MIN.length - 1);
  return now + BACKOFF_MIN[idx] * 60_000;
}
