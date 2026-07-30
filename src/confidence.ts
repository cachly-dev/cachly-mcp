import { createHash } from 'node:crypto';

// ── Confidence Decay Config ───────────────────────────────────────────────────
export const CONFIDENCE_WARN_DAYS  = Number(process.env.CACHLY_CONFIDENCE_WARN_DAYS  ?? 5);
export const CONFIDENCE_STALE_DAYS = Number(process.env.CACHLY_CONFIDENCE_STALE_DAYS ?? 10);
export const CONFIDENCE_WARN_VALUE  = 0.7;
export const CONFIDENCE_STALE_VALUE = 0.5;

// ── One of THREE deliberately-different age/decay curves. Do NOT unify them. ──
// This one (SHARP: 0.7@5d, 0.5@10d) is a user-facing *staleness warning* — it
// drives the recall_best_solution freshness badge and brain_predict, where the
// point is to shout "verify before applying" once a lesson is old.
//   • Ranking uses a SEPARATE, gentle curve — search.ts `recencyBoost`
//     (0.5^(age/7)+0.5, range [0.5,1.5]). It is bench-tuned. Feeding THIS sharp
//     curve into the recall rerank regressed every Cachly-Bench floor (home P@1
//     92→77%) and was reverted — see PR #228. Relevant lessons are often days
//     /weeks old; penalising age hard in ranking buries the right answer.
//   • The knowledge_decay *report* uses a THIRD, points-based curve
//     (advanced.ts) that also folds in recall_count + outcome.
// Three purposes, three curves — that divergence is intentional, not a bug.
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
