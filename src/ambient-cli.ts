// Ambient Recall — the CLI core that the installed hook scripts pipe to.
//
// The hooks written by `init`/`setup`/`autopilot` (ambient-hooks.ts) pipe
// Claude Code's hook payload JSON on stdin to `cachly ambient-recall`. This
// module is that command's brain: it parses the payload and runs the ONE
// injection core (einblendung.ts) — the same function our own repo hooks in
// tools/ambient-recall/ call. There is no second path.
//
// Why (08.10.2026): this command used to call `smart_recall` under a 3 s
// budget. Measured with 10 real questions against the live brain it injected
// 0 of 10 — every question ended exactly at the 3 s cap (3004–3018 ms), and
// with a 120 s cap still none returned. Our own hooks meanwhile sorted the
// whole lesson stock locally and injected on the same questions. Customers got
// the worse path; now they get the same one.
//
// Design constraints:
//   • Graceful: EVERY failure path returns '' (no output) — the caller exits 0
//     so a crashing hook can never block or corrupt the agent's turn.
//   • Bounded: the lesson stock comes from disk (refreshed in a detached side
//     run); only a cold start waits for `/export`, under `abrufMs`. The reader
//     (Leser) has its own 2.5 s cap and falls back to the local order.

import {
  promptEinblendung,
  holeBestand,
  sitzungsKontext,
  hookAusgabe,
  estimateTokens,
  type EinblendConfig,
} from './einblendung.js';

/** The subset of the Claude Code hook payload we care about. */
export interface HookPayload {
  hook_event_name?: string;
  /** Present on UserPromptSubmit — the text the user just typed. */
  prompt?: string;
  /** Present on SessionStart — 'startup' | 'resume' | 'clear' | 'compact'. */
  source?: string;
  /** Present on PreToolUse — the tool about to run and its input. */
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: unknown };
  /** Present on Stop — what the assistant just said (auto-learn signal). */
  last_assistant_message?: string;
  /** Present on every event — the session transcript (JSONL). Stop reads it for the Schreibbeleg. */
  transcript_path?: string;
  /** Present on Stop — true when this turn already continues because of a Stop hook. */
  stop_hook_active?: boolean;
  session_id?: string;
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

// PreToolUse fires for every tool; only file-mutating tools carry a wrong-path
// risk worth a recall (roadmap §6.1: file-open briefing on Edit/Write).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The query to sort the lesson stock against, or null when nothing should be
 * injected for this payload:
 *   • UserPromptSubmit → the prompt itself. No separate "trivial" filter: the
 *     core's gate needs two distinct content words in a lesson, so "danke" or
 *     "ok mach" never inject — exactly as in our own repo hook.
 *   • PreToolUse       → the edited file's path (relative to cwd when possible),
 *     for Edit/Write-class tools only.
 *   • SessionStart / Stop → null (SessionStart briefs from the whole stock, Stop learns).
 */
export function recallQueryFor(payload: HookPayload): string | null {
  const event = payload.hook_event_name ?? 'UserPromptSubmit';
  if (event === 'SessionStart' || event === 'Stop') return null;
  if (event === 'PreToolUse') {
    if (payload.tool_name && !FILE_TOOLS.has(payload.tool_name)) return null;
    const filePath = payload.tool_input?.file_path;
    if (typeof filePath !== 'string' || !filePath.trim()) return null;
    const f = filePath.trim().replace(/\\/g, '/');
    const cwd = (payload.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    // The absolute prefix (C:/Users/<name>/Documents/...) would match half the
    // stock on words like "users" or "documents" — only the project part counts.
    return cwd && f.toLowerCase().startsWith(cwd.toLowerCase() + '/') ? f.slice(cwd.length + 1) : f;
  }
  const prompt = (payload.prompt ?? '').trim();
  return prompt || null;
}

export interface StopObservation {
  action: string;
  outcome: 'success';
  details: string;
  severity: 'minor';
}

// Conservative fix-signal: only turns whose final message clearly reports a
// resolved problem become auto-lessons. Anything looser floods the brain with
// junk on every turn-end — the exact noise §6.4 warns about.
const FIX_SIGNAL_RE =
  /\b(fixed|resolved|behoben|gefixt|root cause|the bug was|der fehler (lag|war)|ursache (war|gefunden)|now passes|tests? (are|is|sind) (green|grün)|deployed successfully)\b/i;

/**
 * Derive an auto-learn observation from a Stop payload, or null when the turn
 * carries no clear fix signal. Pure — the caller feeds it to auto_learn_session.
 */
export function stopObservation(payload: HookPayload): StopObservation | null {
  const msg = (payload.last_assistant_message ?? '').trim();
  if (msg.length < 80) return null; // too short to describe a real fix
  if (!FIX_SIGNAL_RE.test(msg)) return null;
  const firstLine = msg.split('\n').find((l) => l.trim().length > 0)?.trim() ?? msg;
  return {
    action: firstLine.slice(0, 200),
    outcome: 'success',
    details: msg.slice(0, 500),
    severity: 'minor',
  };
}

/**
 * Build the JSON Claude Code expects from a hook. Empty context → '' (no output),
 * which Claude Code treats as "hook contributed nothing".
 */
export const buildHookOutput = hookAusgabe;

/**
 * How long a cold start (nothing on disk yet) may wait for `/export` on a
 * per-prompt event. The installed hook has a 10 s outer timeout and npx
 * resolution alone costs ~2 s, so 5 s keeps the whole hook inside it.
 * SessionStart (30 s outer timeout) uses the core default of 8 s.
 */
export const PROMPT_ABRUF_MS = 5000;

export interface EinblendDeps {
  cfg: EinblendConfig;
  /** `node` arguments that start the detached stock refresh (see starteNebenlauf). */
  nebenlauf?: string[];
  /** Called with the estimated injected tokens whenever context is emitted. */
  onInject?: (tokens: number, event: string) => void;
  /** Write the per-prompt net log line (default true). */
  protokoll?: boolean;
  /** Tests only. */
  fetchFn?: typeof fetch;
}

/**
 * The whole `ambient-recall` flow, as a function of (stdin, deps). Returns the
 * string to print on stdout — the hookSpecificOutput JSON or '' (nothing).
 * Never throws.
 */
export async function runEinblendung(raw: string, deps: EinblendDeps): Promise<string> {
  try {
    const payload = parseHookPayload(raw);
    if (!payload) return '';
    const event = payload.hook_event_name ?? 'UserPromptSubmit';
    if (!deps.cfg.jwt || !deps.cfg.instanceId) return '';

    let kontext = '';
    if (event === 'SessionStart') {
      // Fetch fresh — this warms the stock for every prompt of the session.
      const { lessons } = await holeBestand(deps.cfg, { force: true, fetchFn: deps.fetchFn });
      kontext = sitzungsKontext(lessons);
    } else {
      const query = recallQueryFor(payload);
      if (query === null) return '';
      const r = await promptEinblendung(query, deps.cfg, {
        nebenlauf: deps.nebenlauf,
        abrufMs: PROMPT_ABRUF_MS,
        // Before every Edit each second counts: local order only, no reader call.
        leser: event !== 'PreToolUse',
        session: payload.session_id ?? null,
        protokoll: deps.protokoll,
        fetchFn: deps.fetchFn,
      });
      kontext = r.kontext;
    }
    if (!kontext) return '';
    try {
      deps.onInject?.(estimateTokens(kontext), event);
    } catch {
      // ledger is telemetry — never block the injection over it
    }
    return hookAusgabe(event, kontext);
  } catch {
    return '';
  }
}
