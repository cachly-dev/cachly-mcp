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

import { createHash } from 'node:crypto';

export interface LessonCandidate {
  id: string;
  /** The text that would be injected into context. */
  summary: string;
  /** Brain confidence in the lesson, [0,1]. */
  confidence: number;
  /** Semantic similarity of the lesson to the current prompt, [0,1]. */
  score: number;
  severity?: 'critical' | 'major' | 'minor';
  /** Wann die Lektion gelernt wurde (ISO) — Grundlage des Belegs. */
  learnedAt?: string;
  /** Dateien, an denen sie entstand — der konkreteste Beleg. */
  files?: string[];
  /** Wie es damals ausging. */
  outcome?: "success" | "failure" | "partial";
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

/**
 * Derives a content-based candidate ID from a summary string. Enables
 * ID-based deduplication to suppress "the same advice" while allowing
 * "different advice" through. See PR #241.
 */
export function candidateIdFor(summary: string): string {
  const hash = createHash('sha256').update(summary).digest('hex');
  return hash.slice(0, 16);
}

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

// ── Timing, Dedupe und Ruhe-Budget (Enabler für antizipativen Recall) ────────
//
// Der Gate oben entscheidet, WAS relevant genug ist. Er entscheidet aber nicht,
// WANN gepusht werden darf — und genau daran scheitert proaktive Erinnerung in
// der Praxis: dieselbe Lektion in jedem zweiten Turn ist kein Hinweis mehr,
// sondern Lärm, und Lärm wird abgeschaltet. Drei Regeln schließen die Lücke:
//
//   1. Dedupe        — dieselbe Lektion nicht erneut innerhalb einer Abklingzeit
//   2. Ruhe-Budget   — höchstens N Einwürfe je gleitendem Fenster, dazu eine
//                      Mindestruhe direkt nach einem Einwurf
//   3. Auslösemoment — die Schwelle richtet sich nach dem Risiko des Prompts:
//                      vor irreversiblen Schritten früher warnen, im Geplauder
//                      strenger schweigen
//
// Alles rein und ohne Abhängigkeiten, damit es vollständig testbar bleibt.

/** Wie riskant ist der Moment — bestimmt, wie eifrig erinnert werden darf. */
export type PromptRisk = 'high' | 'normal' | 'low';

// Schritte, die man nicht zurücknehmen kann: hier ist eine verpasste Lektion
// teuer, ein überflüssiger Hinweis dagegen billig.
const RISKY_RE =
  /\b(deploy\w*|migrat\w*|rollback|revert|drop\s+(table|database|schema)|truncate|rm\s+-rf|force[- ]push|prune|restore|rotat\w*|secret\w*|credential\w*|production|prod|live|kunde\w*|customer\w*|delete|loesch\w*|lösch\w*)\b/i;
// Reine Bestätigungen/Fortsetzungen: hier beginnt keine neue Arbeit.
const CONTINUATION_RE =
  /^(ok(ay)?|ja|nein|weiter|passt|danke|thanks|go|los|mach|jup|yes|no|sure|next)\b[\s.!]*$/i;

/**
 * Risikoeinschätzung des Auslösemoments. Sie verschiebt die Schwellen, statt
 * eine zweite, konkurrierende Entscheidung zu treffen — eine Stellschraube
 * weniger, und der Gate bleibt die einzige Wahrheit über Relevanz.
 */
export function promptRisk(prompt: string): PromptRisk {
  const p = prompt.trim();
  if (CONTINUATION_RE.test(p)) return 'low';
  if (RISKY_RE.test(p)) return 'high';
  return 'normal';
}

/** Schwellen-Anpassung je Risiko (klein gehalten und bewusst begründet). */
export function gateForRisk(risk: PromptRisk, base: GateOptions = DEFAULT_GATE): GateOptions {
  if (risk === 'high') {
    // Vor irreversiblen Schritten darf eine etwas schwächere Übereinstimmung
    // reichen — die vermiedene Katastrophe ist jeden Token wert.
    return { ...base, minScore: Math.max(0, base.minScore - 0.07), topK: base.topK, maxTokens: base.maxTokens + 120 };
  }
  if (risk === 'low') {
    // Im Geplauder muss es sehr deutlich sein, sonst lieber schweigen.
    return { ...base, minScore: Math.min(1, base.minScore + 0.1), topK: 1, maxTokens: Math.min(base.maxTokens, 120) };
  }
  return { ...base };
}

export interface TimingOptions {
  /** Dieselbe Lektion frühestens nach so vielen Turns erneut. */
  repeatCooldownTurns: number;
  /** Höchstzahl Einwürfe im gleitenden Fenster. */
  maxInjectionsPerWindow: number;
  /** Größe des gleitenden Fensters in Turns. */
  windowTurns: number;
  /** Mindestruhe unmittelbar nach einem Einwurf (in Turns). */
  minSilenceTurns: number;
}

// Ein Einwurf pro ~3 Turns im Schnitt: oft genug, um zu helfen, selten genug,
// dass er auffällt, wenn er kommt.
export const DEFAULT_TIMING: TimingOptions = {
  repeatCooldownTurns: 12,
  maxInjectionsPerWindow: 3,
  windowTurns: 10,
  minSilenceTurns: 1,
};

/** Gedächtnis über die letzten Einwürfe — vom Aufrufer gehalten und übergeben. */
export interface RecallMemory {
  /** Aktueller Turn-Zähler (monoton steigend). */
  turn: number;
  /** Lektions-ID → Turn des letzten Einwurfs. */
  lastInjectedTurn: Record<string, number>;
  /** Turns, in denen etwas eingeworfen wurde (aufsteigend). */
  injectionTurns: number[];
}

export function emptyMemory(): RecallMemory {
  return { turn: 0, lastInjectedTurn: {}, injectionTurns: [] };
}

export type TimingReason = 'quiet-budget' | 'silence-window' | 'all-duplicates';

export interface RecallDecision extends GateDecision {
  risk: PromptRisk;
  /** Kandidaten, die nur wegen der Abklingzeit entfielen (Diagnose/Telemetrie). */
  suppressedDuplicates: string[];
  timingReason?: TimingReason;
}

/**
 * Die vollständige Entscheidung: Relevanz (Gate) UND Zeitpunkt (Timing).
 *
 * Reihenfolge ist Absicht: erst die billigen Ausschlüsse (Ruhe, Budget), dann
 * Dedupe, erst zuletzt der teure Relevanz-Gate — so kostet ein unterdrückter
 * Turn praktisch nichts.
 *
 * Die Funktion ist seiteneffektfrei; `commitInjection` schreibt das Gedächtnis
 * fort, damit Aufrufer selbst entscheiden, ob ein Vorschlag wirklich gezeigt
 * wurde (z. B. bei abgebrochenem Turn).
 */
export function decideRecall(
  prompt: string,
  candidates: LessonCandidate[],
  memory: RecallMemory,
  gateOverrides: Partial<GateOptions> = {},
  timingOverrides: Partial<TimingOptions> = {},
): RecallDecision {
  const t = { ...DEFAULT_TIMING, ...timingOverrides };
  const risk = promptRisk(prompt);
  const none = (reason: GateReason, timingReason?: TimingReason): RecallDecision => ({
    inject: false, reason, selected: [], tokens: 0, risk,
    suppressedDuplicates: [], timingReason,
  });

  if (isTrivialPrompt(prompt)) return none('trivial-skip');

  // Mindestruhe nach dem letzten Einwurf.
  const last = memory.injectionTurns[memory.injectionTurns.length - 1];
  if (last !== undefined && memory.turn - last <= t.minSilenceTurns) {
    return none('no-candidate-passed-gate', 'silence-window');
  }
  // Ruhe-Budget im gleitenden Fenster.
  const inWindow = memory.injectionTurns.filter((n) => memory.turn - n < t.windowTurns).length;
  if (inWindow >= t.maxInjectionsPerWindow) {
    return none('no-candidate-passed-gate', 'quiet-budget');
  }

  // Dedupe: was gerade erst gesagt wurde, wird nicht wiederholt.
  const suppressedDuplicates: string[] = [];
  const fresh = candidates.filter((c) => {
    const seen = memory.lastInjectedTurn[c.id];
    if (seen !== undefined && memory.turn - seen < t.repeatCooldownTurns) {
      suppressedDuplicates.push(c.id);
      return false;
    }
    return true;
  });
  if (candidates.length > 0 && fresh.length === 0) {
    return { ...none('no-candidate-passed-gate', 'all-duplicates'), suppressedDuplicates };
  }

  const gate = selectInjectable(prompt, fresh, { ...gateForRisk(risk), ...gateOverrides });
  return { ...gate, risk, suppressedDuplicates };
}

/**
 * Schreibt das Gedächtnis nach einem TATSÄCHLICH gezeigten Einwurf fort.
 * Der Turn-Zähler wird immer erhöht — auch ohne Einwurf, sonst laufen
 * Abklingzeit und Fenster nicht weiter.
 */
export function commitInjection(
  memory: RecallMemory,
  decision: RecallDecision,
  timingOverrides: Partial<TimingOptions> = {},
): RecallMemory {
  const t = { ...DEFAULT_TIMING, ...timingOverrides };
  const next: RecallMemory = {
    turn: memory.turn + 1,
    lastInjectedTurn: { ...memory.lastInjectedTurn },
    injectionTurns: [...memory.injectionTurns],
  };
  if (decision.inject) {
    for (const c of decision.selected) next.lastInjectedTurn[c.id] = memory.turn;
    next.injectionTurns.push(memory.turn);
  }
  // Nach Ablauf der Fenster sind Eintraege bedeutungslos — sonst waechst das
  // Gedaechtnis in langen Sitzungen unbegrenzt mit.
  const horizon = memory.turn - Math.max(t.windowTurns, t.repeatCooldownTurns);
  next.injectionTurns = next.injectionTurns.filter((n) => n >= horizon);
  for (const [id, turn] of Object.entries(next.lastInjectedTurn)) {
    if (turn < horizon) delete next.lastInjectedTurn[id];
  }
  return next;
}
