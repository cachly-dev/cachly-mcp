// Ambient Recall — the production `AmbientDeps` factory.
//
// ambient-cli.ts (`runAmbient`) is dependency-injected on purpose so it can be
// unit-tested without a network. This module is the OTHER half of that seam:
// the one place that turns a raw `smart_recall` string reply into the
// `AmbientDeps.recall` candidates the gate understands — miss-detection,
// truncation and content-based IDs (PR #241 regression: the id must come from
// the summary, never a constant like 'ambient', or "same lesson twice" and
// "different lesson" become indistinguishable in `RecallMemory`).
//
// Previously this mapping lived inline at the `ambient-recall` CLI call site
// in index.ts. Moved here so the exact production wiring — not a hand-copied
// approximation of it — is what the seam test (SDK-003) exercises across
// multiple turns.

import { truncateToTokens, type AmbientDeps } from './ambient-cli.js';
import { candidateIdFor, type RecallMemory } from './ambient-recall.js';

/** A brain reply that carries no usable lesson — same heuristic as smart_recall's own callers. */
const NO_LESSONS_RE = /No lessons found|no lessons|No matches found/i;

/** Below this length a `smart_recall` reply is boilerplate, not a real lesson. */
const MIN_LESSON_CHARS = 80;

/** Hard cap on how much of one recalled lesson may be injected (§6.2 budget). */
const MAX_LESSON_TOKENS = 500;

export interface BuildAmbientDepsOptions {
  /** Brain instance to recall from. Missing/empty → recall is a no-op (never calls `smartRecall`). */
  instanceId?: string;
  /** The raw `smart_recall` call (already scoped to `instanceId` by the caller). */
  smartRecall: (query: string) => Promise<string>;
  /** Optional trigger memory (dedupe + quiet-budget). Stateless when omitted. */
  loadMemory?: () => RecallMemory | null | undefined;
  saveMemory?: (m: RecallMemory) => void;
  /** Auto-backoff probe (§6.3 guardrail 3). */
  backoff?: () => boolean | Promise<boolean>;
  /** Called with the estimated injected tokens whenever context is emitted. */
  onInject?: (tokens: number, event: string) => void;
  /** Hard latency budget for the whole recall step (ms). Default 3000. */
  timeoutMs?: number;
}

/**
 * Builds the ONE production `AmbientDeps` used by the `ambient-recall` CLI
 * entrypoint. This is the exact mapping that used to be inlined at the call
 * site: a miss-detection heuristic, a token-truncated summary, and a
 * content-derived candidate id — wrapped around whatever `smartRecall`
 * implementation the caller passes in (production: `handleTool('smart_recall', ...)`;
 * tests: a stub).
 */
export function buildAmbientDeps(opts: BuildAmbientDepsOptions): AmbientDeps {
  const { instanceId, smartRecall, loadMemory, saveMemory, backoff, onInject, timeoutMs } = opts;
  return {
    timeoutMs: timeoutMs ?? 3000, // §6.3 guardrail 4: never stall the prompt on a slow brain
    // Ambient injection budget: one relevance-ranked briefing, hard-capped.
    // smart_recall already returns its hits best-first, so the capped head is
    // the high-signal part. Per-lesson structured candidates are a future slice.
    gate: { topK: 1, maxTokens: MAX_LESSON_TOKENS },
    loadMemory,
    saveMemory,
    backoff,
    onInject,
    recall: async (query) => {
      if (!instanceId) return [];
      const text = String((await smartRecall(query)) ?? '');
      const miss = text.length < MIN_LESSON_CHARS || NO_LESSONS_RE.test(text);
      if (miss) return [];
      const summary = truncateToTokens(text, MAX_LESSON_TOKENS);
      return [{ id: candidateIdFor(summary), summary, confidence: 0.9, score: 0.9 }];
    },
  };
}
