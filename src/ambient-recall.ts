// Ambient Recall (Phase 4) — the relevance gate + net-token accounting that make
// push-based memory economically honest.
//
// Background (docs/make_cachly_great_again.md §6.2/§6.3): pushing recall into
// every prompt COSTS tokens; it only pays off when the injected lesson prevents
// a wrong path that would have cost far more. So the whole feature hinges on a
// sharp relevance gate (only inject high-signal, few, small) plus honest net
// accounting (injected vs prevented) with auto-backoff when it goes net-negative.
//
// This module is pure and dependency-free so it is exhaustively unit-tested; the
// hook scripts + telemetry layer build on top of it.

export interface LessonCandidate {
  id: string;
  /** The text that would be injected into context. */
  summary: string;
  /** Brain confidence in the lesson, [0,1]. */
  confidence: number;
  /** Semantic similarity of the lesson to the current prompt, [0,1]. */
  score: number;
  severity?: 'critical' | 'major' | 'minor';
}

export interface GateOptions {
  /** Minimum brain confidence to be eligible. */
  minConfidence: number;
  /** Minimum semantic similarity to the prompt. */
  minScore: number;
  /** Hard cap on how many lessons may be injected in one turn. */
  topK: number;
  /** Hard per-turn injection budget, in estimated tokens. */
  maxTokens: number;
}

// Deliberately conservative defaults: it is far cheaper to skip a marginal
// lesson than to erode the "−60% tokens" credibility by injecting noise.
export const DEFAULT_GATE: GateOptions = {
  minConfidence: 0.6,
  minScore: 0.72,
  topK: 3,
  maxTokens: 240,
};

/** Rough token estimate (~4 chars/token) — good enough for a per-turn budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

// Pure conversational openers with no engineering payload.
const TRIVIAL_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yep|nope|ty|lol|danke|hallo|servus)\b/i;
// Signals that a prompt is about code/ops, where a wrong path is expensive and a
// relevant lesson can pay for itself. Calibrated against the golden vectors in
// docs/spec/ambient-gate-vectors.json (ambient-gate-vectors.test.ts): the v1
// list false-skipped short real requests like "curl returns 403 via the proxy"
// or "rename the Settings page to Preferences" (substantive-recall 0.67), so
// v2 adds engineering verbs, infra nouns, HTTP status codes and German
// question words. Stems with \w* also match inflections ("migration",
// "updated", "evicted"). Substantive-recall on the vector set: 1.0, with
// trivial-precision unchanged at 1.0.
const CODEY_RE =
  /[/\\._{}()<>;=]|\b\d{3}\b|\b(fix|bug|error|deploy|migrat\w*|test\w*|build|refactor|auth|api|db|schema|race|crash|fail\w*|revert|rollback|why|how|debug|config|hook|token|cache|add|creat\w*|implement\w*|updat\w*|remov\w*|delet\w*|renam\w*|install\w*|upgrad\w*|write|script|component|page|button|css|style\w*|log\w*|pod\w*|node\w*|docker|k8s|kubernetes|proxy|curl|http\w*|readme|lint\w*|latenc\w*|latenz|timeout\w*|evict\w*|warum|wieso|weshalb)\b/i;

/**
 * A trivial prompt has ~zero expected wrong-path savings (§6.3 guardrail 2):
 * too short to carry risk, a pure greeting, or chit-chat with no code signal.
 * Injecting there is pure waste, so we skip recall entirely.
 */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length < 12) return true;
  if (TRIVIAL_RE.test(p) && p.length < 40) return true;
  if (!CODEY_RE.test(p) && p.length < 60) return true;
  return false;
}

export type GateReason =
  | 'trivial-skip'
  | 'no-candidate-passed-gate'
  | 'injected';

export interface GateDecision {
  inject: boolean;
  reason: GateReason;
  selected: LessonCandidate[];
  /** Estimated tokens the selection would inject (0 when nothing is injected). */
  tokens: number;
}

/**
 * The §6.3 relevance gate: decide what (if anything) to push into context for a
 * given prompt. Applies trivial-skip, a confidence AND semantic-score floor,
 * a top-K cap, and a hard per-turn token budget — strongest candidates first.
 */
export function selectInjectable(
  prompt: string,
  candidates: LessonCandidate[],
  opts: Partial<GateOptions> = {},
): GateDecision {
  const o = { ...DEFAULT_GATE, ...opts };

  if (isTrivialPrompt(prompt)) {
    return { inject: false, reason: 'trivial-skip', selected: [], tokens: 0 };
  }

  const passed = candidates
    .filter((c) => c.confidence >= o.minConfidence && c.score >= o.minScore)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);

  const selected: LessonCandidate[] = [];
  let tokens = 0;
  for (const c of passed) {
    if (selected.length >= o.topK) break;
    const t = estimateTokens(c.summary);
    if (tokens + t > o.maxTokens) break; // hard per-turn cap — never overshoot
    selected.push(c);
    tokens += t;
  }

  if (selected.length === 0) {
    return { inject: false, reason: 'no-candidate-passed-gate', selected: [], tokens: 0 };
  }
  return { inject: true, reason: 'injected', selected, tokens };
}

// ── Net-token accounting (§6.2) ──────────────────────────────────────────────
// The honest ledger: injected tokens (the cost, paid now) vs prevented tokens
// (a wrong path a lesson averted — credited when a later turn is tagged
// prevented-by-ambient). Report the NET, even when it is negative.

export interface TurnRecord {
  injected: number;
  prevented: number;
}

export interface NetBalance {
  injected: number;
  prevented: number;
  net: number;
}

export function netBalance(records: TurnRecord[]): NetBalance {
  const injected = records.reduce((s, r) => s + r.injected, 0);
  const prevented = records.reduce((s, r) => s + r.prevented, 0);
  return { injected, prevented, net: prevented - injected };
}

/**
 * Auto-backoff (§6.3 guardrail 3): if, over the recent window, Ambient Recall is
 * net-negative, tell the caller to tighten the gate (or pause). Only fires once
 * there is enough signal (>= minTurns) so early noise doesn't trip it.
 */
export function shouldBackoff(records: TurnRecord[], windowN = 20, minTurns = 8): boolean {
  const recent = records.slice(-windowN);
  if (recent.length < minTurns) return false;
  return netBalance(recent).net < 0;
}
