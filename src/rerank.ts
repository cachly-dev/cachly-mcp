/**
 * Quality-aware reranking for Brain recall.
 *
 * The raw BM25+ keyword search (src/search.ts) ranks purely by *textual* relevance.
 * That is necessary but not sufficient: when an agent asks "how do I fix the flaky
 * deploy?", a *failed* attempt with similar words can out-rank the *proven success*
 * lesson that actually solves it. Anthropic's flat-file memory has exactly this
 * problem — it reads files in order, with no notion of which lesson is trustworthy.
 *
 * This module is Cachly's structural advantage made concrete: we re-rank text
 * matches by the *quality* of the underlying lesson — outcome, confidence,
 * proven-ness (recall_count) and severity — so the lesson most likely to help
 * surfaces first.
 *
 * It is intentionally pure (no I/O): the lesson JSON already travels inside each
 * KeywordMatch.content for `cachly:lesson:best:*` keys, so reranking needs no extra
 * Redis round-trips. This keeps it fast and trivially benchmarkable (see
 * src/bench/cachly-bench.ts).
 */

import type { KeywordMatch } from './search.js';
import { safeJsonParse } from './utils.js';

/** Subset of a stored lesson that influences ranking. */
export interface LessonQuality {
  outcome?: string;        // 'success' | 'partial' | 'failure'
  confidence?: number;     // 0..1
  recall_count?: number;   // times this lesson has been recalled (proven-ness)
  severity?: string;       // 'critical' | 'major' | 'minor'
  ts?: string;             // ISO timestamp (for freshness, mild)
  verified_at?: string;
}

export interface RerankedMatch extends KeywordMatch {
  /** Final score after applying the quality multiplier. */
  finalScore: number;
  /** The multiplier that was applied to the BM25 score (1.0 = neutral). */
  qualityBoost: number;
}

// ── Tunable weights (kept conservative; validated by Cachly-Bench) ─────────────
const OUTCOME_WEIGHT: Record<string, number> = {
  success: 1.0,
  partial: 0.8,
  failure: 0.55,
};
const OUTCOME_DEFAULT = 0.75; // unknown / not a lesson with an outcome

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 1.15,
  major: 1.05,
  minor: 1.0,
};
const SEVERITY_DEFAULT = 1.0;

// Clamp so a strong text match is never fully buried by quality, and a weak text
// match is never catapulted to the top purely on quality.
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 2.5;

const LESSON_KEY_PREFIX = 'cachly:lesson:best:';

/**
 * Compute the quality multiplier for a single lesson.
 * Returns 1.0 (neutral) for documents that carry no quality signal (e.g. context).
 */
export function qualityMultiplier(lesson: LessonQuality | null): number {
  if (!lesson || (lesson.outcome === undefined && lesson.confidence === undefined && lesson.recall_count === undefined)) {
    return 1.0;
  }

  // 1. Outcome — a proven success is what the agent actually wants.
  const outcome = OUTCOME_WEIGHT[lesson.outcome ?? ''] ?? OUTCOME_DEFAULT;

  // 2. Confidence — maps 0..1 → 0.7..1.3 so it nudges, not dominates.
  const conf = typeof lesson.confidence === 'number' ? Math.max(0, Math.min(1, lesson.confidence)) : 0.6;
  const confidenceFactor = 0.7 + 0.6 * conf;

  // 3. Proven-ness — a lesson recalled many times has stood the test of use.
  //    Log-scaled so it saturates: rc=0→1.0, rc=5→~1.18, rc=50→~1.30.
  const rc = Math.max(0, lesson.recall_count ?? 0);
  const provenBoost = 1 + Math.min(0.3, Math.log1p(rc) / 13);

  // 4. Severity — when two lessons tie, surface the one guarding the worse failure.
  const severity = SEVERITY_WEIGHT[lesson.severity ?? ''] ?? SEVERITY_DEFAULT;

  const m = outcome * confidenceFactor * provenBoost * severity;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, m));
}

/** Extract the quality signal from a match, if its content is a stored lesson. */
export function extractLessonQuality(match: Pick<KeywordMatch, 'key' | 'content'>): LessonQuality | null {
  if (!match.key.startsWith(LESSON_KEY_PREFIX)) return null;
  return safeJsonParse<LessonQuality | null>(match.content, null);
}

/**
 * Rerank BM25 keyword matches by lesson quality.
 *
 * The BM25 scores are first min-max normalized to [0,1] so the quality multiplier
 * acts on a comparable scale across queries; ties are broken by the original BM25
 * score (stable, deterministic).
 */
export function rerankByQuality(matches: KeywordMatch[]): RerankedMatch[] {
  if (matches.length === 0) return [];

  const maxScore = Math.max(...matches.map(m => m.score));
  const minScore = Math.min(...matches.map(m => m.score));
  const range = maxScore - minScore || 1;

  const reranked: RerankedMatch[] = matches.map(m => {
    const norm = (m.score - minScore) / range; // 0..1
    const lesson = extractLessonQuality(m);
    const boost = qualityMultiplier(lesson);
    // Blend: keep a floor of raw relevance so a top text hit stays competitive,
    // then layer the quality multiplier on the normalized component.
    const finalScore = m.score * (0.4 + 0.6 * boost) + norm * (boost - 1) * 0.0001;
    return { ...m, finalScore, qualityBoost: boost };
  });

  reranked.sort((a, b) => (b.finalScore - a.finalScore) || (b.score - a.score));
  return reranked;
}
