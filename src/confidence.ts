import { createHash } from 'node:crypto';

// ── Confidence Decay Config ───────────────────────────────────────────────────
export const CONFIDENCE_WARN_DAYS  = Number(process.env.CACHLY_CONFIDENCE_WARN_DAYS  ?? 5);
export const CONFIDENCE_STALE_DAYS = Number(process.env.CACHLY_CONFIDENCE_STALE_DAYS ?? 10);
export const CONFIDENCE_WARN_VALUE  = 0.7;
export const CONFIDENCE_STALE_VALUE = 0.5;

/** Calculate current confidence for a lesson based on how long since last verified. */
export function calculateConfidence(lesson: { verified_at?: string; ts: string; recall_count?: number }): number {
  const ref = lesson.verified_at ?? lesson.ts;
  const ageMs = Date.now() - new Date(ref).getTime();
  const ageDays = ageMs / 86400000;
  if (ageDays >= CONFIDENCE_STALE_DAYS) return CONFIDENCE_STALE_VALUE;
  if (ageDays >= CONFIDENCE_WARN_DAYS)  return CONFIDENCE_WARN_VALUE;
  return 1.0 - (ageDays / CONFIDENCE_WARN_DAYS) * (1.0 - CONFIDENCE_WARN_VALUE);
}

/** Render a confidence badge string. */
export function confidenceBadge(confidence: number, ageDays: number): string {
  if (confidence >= 0.9) return '✅';
  if (confidence >= 0.7) return `⚠️ (${Math.round(ageDays)}d old, confidence ${(confidence * 100).toFixed(0)}% — verify before applying)`;
  return `🔴 STALE (${Math.round(ageDays)}d old, confidence ${(confidence * 100).toFixed(0)}% — likely outdated!)`;
}

/** Category-specific required fields for structured lessons. */
export const STRUCTURED_TEMPLATES: Record<string, { required: string[]; hint: string }> = {
  'deploy':  { required: ['commands'],                hint: 'deploy:* needs commands[]' },
  'bash':    { required: ['commands'],                hint: 'bash:* needs commands[]' },
  'infra':   { required: ['commands'],                hint: 'infra:* needs commands[] + verified on real system' },
  'pricing': { required: [],                          hint: 'pricing:* — add context with source (e.g. "Stripe Dashboard Apr 2026")' },
  'stripe':  { required: [],                          hint: 'stripe:* — add context with Stripe API version' },
};

/** Fast content hash for index invalidation (not cryptographic, just change detection) */
export function simpleHash(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 12);
}
