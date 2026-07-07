// Ambient Recall (Phase 4) — the CLI core that the hook scripts pipe to.
//
// The SessionStart / UserPromptSubmit hooks (ambient-hooks.ts) pipe Claude Code's
// hook payload JSON on stdin to `npx @cachly-dev/mcp-server ambient-recall`. This
// module is that command's brain: it parses the payload, runs the §6.3 relevance
// gate (ambient-recall.ts), and prints the `hookSpecificOutput` JSON Claude Code
// injects as additionalContext — or nothing at all when the gate says skip.
//
// Design constraints (roadmap §6.3):
//   • Pure + dependency-injected (recall is passed in) so it is exhaustively
//     unit-tested without any network.
//   • Graceful: EVERY failure path returns '' (no output) — the caller exits 0 so
//     a crashing hook can never block or corrupt the agent's turn.
//   • Self-limited: recall runs under a hard timeout budget; a slow brain never
//     stalls the user's prompt.

import {
  isTrivialPrompt,
  selectInjectable,
  estimateTokens,
  type LessonCandidate,
  type GateOptions,
} from './ambient-recall.js';

/** The subset of the Claude Code hook payload we care about. */
export interface HookPayload {
  hook_event_name?: string;
  /** Present on UserPromptSubmit — the text the user just typed. */
  prompt?: string;
  /** Present on SessionStart — 'startup' | 'resume' | 'clear' | 'compact'. */
  source?: string;
  cwd?: string;
}

/** Parse the hook payload from stdin. Never throws — returns null on any problem. */
export function parseHookPayload(raw: string): HookPayload | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const p = JSON.parse(trimmed) as unknown;
    if (p && typeof p === 'object') return p as HookPayload;
    return null;
  } catch {
    return null;
  }
}

/**
 * The query to recall on for a payload, or null when recall should be skipped
 * before any brain call:
 *   • UserPromptSubmit → the prompt, unless it is trivial (§6.3 guardrail 2).
 *   • SessionStart     → a fixed briefing query (there is no user prompt yet);
 *     skipped on 'compact'/'clear' resumes where a mid-session briefing is noise.
 */
export function recallQueryFor(payload: HookPayload): string | null {
  const event = payload.hook_event_name ?? 'UserPromptSubmit';
  if (event === 'SessionStart') {
    if (payload.source === 'compact' || payload.source === 'clear') return null;
    return 'session start: recent lessons, active pitfalls, and known failure modes for this project';
  }
  const prompt = (payload.prompt ?? '').trim();
  if (!prompt || isTrivialPrompt(prompt)) return null;
  return prompt;
}

/** Truncate text to fit an estimated token budget (~4 chars/token), on a word edge. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const t = text.trim();
  if (estimateTokens(t) <= maxTokens) return t;
  const maxChars = Math.max(0, maxTokens * 4);
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Render the gated lessons into a context block for the agent.
 *   • A single already-formatted briefing (multi-line summary — what smart_recall
 *     returns) is injected verbatim; it carries its own headings.
 *   • Multiple short lessons are rendered as a titled bullet list.
 */
export function formatContextBlock(lessons: LessonCandidate[]): string {
  if (lessons.length === 0) return '';
  if (lessons.length === 1 && lessons[0].summary.includes('\n')) {
    return lessons[0].summary.trim();
  }
  const bullets = lessons.map((l) => `- ${l.summary.trim()}`).join('\n');
  return `🧠 Relevant memory from your cachly brain (auto-recalled):\n${bullets}`;
}

/**
 * Build the JSON Claude Code expects from a hook. `additionalContext` is spliced
 * into the model's context for the turn. Empty context → empty string (no output),
 * which Claude Code treats as "hook contributed nothing".
 */
export function buildHookOutput(event: string, additionalContext: string): string {
  if (!additionalContext) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  });
}

export interface AmbientDeps {
  /** Fetch candidate lessons for a query. Should already be scoped to the brain. */
  recall: (query: string, event: string) => Promise<LessonCandidate[]>;
  /** Overrides for the relevance gate. */
  gate?: Partial<GateOptions>;
  /** Hard latency budget for the whole recall step (ms). Default 3000. */
  timeoutMs?: number;
}

/** Resolve a promise to a fallback if it does not settle within `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The whole ambient-recall CLI flow, as a pure function of (stdin, deps).
 * Returns the string to print on stdout — either the hookSpecificOutput JSON or
 * '' (nothing to inject). Never throws.
 */
export async function runAmbient(raw: string, deps: AmbientDeps): Promise<string> {
  const payload = parseHookPayload(raw);
  if (!payload) return '';
  const event = payload.hook_event_name ?? 'UserPromptSubmit';

  const query = recallQueryFor(payload);
  if (query === null) return ''; // trivial / non-recallable event → skip before any brain call

  let candidates: LessonCandidate[] = [];
  try {
    candidates = await withTimeout(deps.recall(query, event), deps.timeoutMs ?? 3000, []);
  } catch {
    return ''; // recall failed → inject nothing, never block the turn
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return '';

  // SessionStart has no user prompt, so its trivial-skip is meaningless; pass the
  // recall query itself so selectInjectable's non-trivial branch runs the gate.
  const gateInput = event === 'SessionStart' ? query : (payload.prompt ?? query);
  const decision = selectInjectable(gateInput, candidates, deps.gate);
  if (!decision.inject) return '';

  return buildHookOutput(event, formatContextBlock(decision.selected));
}
