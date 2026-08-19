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
 * proven-ness (recall_count), severity and human review (endorsements) — so the
 * lesson most likely to help surfaces first. A flat-file memory has none of these
 * signals; a senior-confirmed, ten-times-recalled success reads identically to a
 * one-off failed attempt.
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
  // ── Governance (Phase 3): human review raises trust above mere usage ──
  reviewed_by?: string;    // handle of the reviewer who endorsed it (latest)
  review_level?: string;   // 'senior' | 'peer' (weight differs)
  endorsements?: number;   // distinct human endorsements
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

// Governance: a human-confirmed lesson is more trustworthy than one proven only
// by automated recall. A senior review weighs more than a peer review; multiple
// endorsements add a small, saturating bump on top.
const REVIEW_LEVEL_WEIGHT: Record<string, number> = {
  senior: 1.25,
  peer: 1.1,
};

// Clamp so a strong text match is never fully buried by quality, and a weak text
// match is never catapulted to the top purely on quality.
// MAX lowered 2.5→1.8: on larger corpora a high-quality but weakly-matching lesson
// could overtake a strongly-matching relevant one and push it out of the top-k.
// 1.8 keeps the home-corpus Precision@1 lift while improving external-corpus
// Precision@1 + MRR (validated by src/bench/external-corpus.ts).
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 1.8;

const LESSON_KEY_PREFIX = 'cachly:lesson:best:';

/**
 * Compute the quality multiplier for a single lesson.
 * Returns 1.0 (neutral) for documents that carry no quality signal (e.g. context).
 */
export function qualityMultiplier(lesson: LessonQuality | null): number {
  if (!lesson || (lesson.outcome === undefined && lesson.confidence === undefined
      && lesson.recall_count === undefined && lesson.reviewed_by === undefined
      && lesson.endorsements === undefined)) {
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

  // 5. Governance — a human-confirmed lesson outranks an unreviewed one.
  //    Base weight from the review level, plus a small saturating bump for
  //    additional endorsements (rc-style log curve, capped at +0.1).
  const reviewBase = lesson.reviewed_by
    ? (REVIEW_LEVEL_WEIGHT[lesson.review_level ?? 'peer'] ?? REVIEW_LEVEL_WEIGHT.peer)
    : 1.0;
  const extraEndorse = Math.max(0, (lesson.endorsements ?? 0) - 1);
  const reviewBoost = reviewBase * (1 + Math.min(0.1, Math.log1p(extraEndorse) / 20));

  const m = outcome * confidenceFactor * provenBoost * severity * reviewBoost;
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
 * BM25 scores are compressed with a 0.3-power root before quality is applied.
 * Compression is the key: a distractor lesson whose `what_failed` contains the
 * exact query phrase can score 5–6× higher in BM25 than the correct success lesson.
 * A linear quality multiplier of ±40% cannot overcome that gap; after ^0.3
 * compression the ratio shrinks to ~1.5×, well within the quality range.
 *
 * The formula  compressed_score * (0.4 + 0.6 * boost)  gives quality 60% weight
 * on the compressed axis. A failure lesson (boost ≈ 0.5) retains 70% of its
 * compressed score; a senior-confirmed success (boost ≈ 1.8) gets 148%.
 * Ties are broken by the raw BM25 score (stable, deterministic).
 */
/**
 * Wie stark Qualitaetsmerkmale die Rangfolge bewegen duerfen.
 *
 * Bleibt bei 0.6 — dem Wert von vorher. Die Messreihe vom 19.08.2026 zeigt,
 * dass dieser Wert auf echten Daten NICHTS kostet: bei ungestauchter Relevanz
 * liefern 0.6, 0.3 und 0.15 dasselbe Ergebnis (30 Prozent auf Platz 1).
 *
 * Das ist der Grund, hier nichts zu aendern. Der Schaden kam allein von der
 * Stauchung darunter. Wer zwei Dinge gleichzeitig verstellt, weiss hinterher
 * nicht, welches gewirkt hat.
 */
const QUALITAETS_GEWICHT = 0.6;

export function rerankByQuality(matches: KeywordMatch[]): RerankedMatch[] {
  if (matches.length === 0) return [];

  const reranked: RerankedMatch[] = matches.map(m => {
    // ── Die Relevanz wird NICHT mehr plattgedrueckt ─────────────────────────
    //
    // Hier stand `Math.pow(score, 0.3)`. Das war Absicht: die Relevanz wurde
    // zusammengestaucht, damit die Qualitaetsmerkmale (Zuversicht, Abnahme,
    // Zustimmungen) die Rangfolge mitbestimmen koennen. Aus einem
    // zehnfachen Relevanzvorsprung wurde ein doppelter.
    //
    // Auf dem Pruefstand mit 17 Lektionen war das ein Gewinn: 92,3 statt
    // 69,2 Prozent. Genau diese Zahl steht seit Monaten auf der Landingpage.
    //
    // Auf 498 echten Lektionen, am 19.08.2026 gemessen, ist es der Verlust:
    //
    //   Stauchung   echter Bestand   Pruefstand
    //   ^0.3            15 %            92,3 %
    //   ^0.6            25 %            76,9 %
    //   ^1.0 (keine)    30 %            69,2 %
    //
    // Der gesamte gemessene Vorteil auf dem Pruefstand IST der Schaden auf
    // echten Daten. Bei 17 Lektionen ist der richtige Treffer so eindeutig,
    // dass er auch gestaucht gewinnt. Bei 498 ist die Relevanz das knappe
    // Gut, und wer sie staucht, wirft weg, was er hat.
    const compressed = Math.max(0, m.score);
    const lesson = extractLessonQuality(m);
    const boost = qualityMultiplier(lesson);
    // Qualitaet wirkt unveraendert auf die UNGESTAUCHTE Relevanz. Damit kann
    // sie einen knappen Textvorsprung noch drehen (eine belegte Loesung schlaegt
    // einen etwas besser passenden Fehlversuch), einen deutlichen aber nicht
    // mehr.
    const finalScore = compressed * (1 - QUALITAETS_GEWICHT + QUALITAETS_GEWICHT * boost);
    return { ...m, finalScore, qualityBoost: boost };
  });

  reranked.sort((a, b) => (b.finalScore - a.finalScore) || (b.score - a.score));
  return reranked;
}
