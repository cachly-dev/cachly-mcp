// Ambient Recall (Phase 4) — Claude Code hook-script generators.
//
// Builds the SessionStart + UserPromptSubmit hook scripts (and the
// .claude/settings.json fragment that wires them) so recall is PUSHED into
// context automatically, without the agent having to remember to call it
// (roadmap §6.1). This is the packaging that turns cachly's existing recall
// into "memory that is just there".
//
// Design mirrors cls-hook.ts:
//   • Pure string builders — exhaustively unit-tested.
//   • No untrusted input is interpolated into the script; the hook payload
//     (which contains the user's prompt) is piped to the CLI on stdin, never
//     spliced into shell/JS source.
//   • Versioned so installers can upgrade old hooks in place.
//   • Graceful: a crashing hook must NEVER block the agent — every path exits 0
//     with no output, so Claude Code simply proceeds without the extra context
//     (§6.3 guardrail 5).

/** Bumped whenever a hook script changes so installers can upgrade old hooks. */
export const AMBIENT_HOOK_VERSION = 'v1';

/**
 * The CLI subcommand the hooks pipe their payload to. It reads the hook JSON on
 * stdin, runs smart_recall through the relevance gate (ambient-recall.ts), and
 * prints the `hookSpecificOutput` JSON Claude Code injects as additionalContext.
 * The CLI self-limits its latency budget (§6.3 guardrail 4) — added in the next
 * slice; until then the hook is a silent no-op (the `|| true` guarantees exit 0).
 */
export const AMBIENT_CLI_SUBCOMMAND = 'ambient-recall';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit';

export interface AmbientHookOptions {
  instanceId: string;
  /** Optional cky_… / JWT embedded so the CLI can authenticate. */
  apiKey?: string;
  /**
   * Command that resolves the ambient-recall CLI. Defaults to the published
   * package via npx; an installer SHOULD pass a resolved local binary to avoid
   * npx resolution latency on every prompt (UserPromptSubmit runs per-turn).
   */
  cliCommand?: string;
}

const DEFAULT_CLI = `npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`;

function buildHook(event: AmbientHookEvent, opts: AmbientHookOptions): string {
  const cli = opts.cliCommand ?? DEFAULT_CLI;
  return [
    `#!/bin/sh`,
    `# cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `# Pushes relevant memory into context automatically. Never blocks the agent:`,
    `# any failure exits 0 with no output (graceful degrade).`,
    `export CACHLY_BRAIN_INSTANCE_ID="${opts.instanceId}"`,
    ...(opts.apiKey ? [`export CACHLY_JWT="${opts.apiKey}"`] : []),
    `export CACHLY_HOOK_EVENT="${event}"`,
    // Claude Code delivers the hook payload as JSON on stdin; pipe it verbatim to
    // the CLI (no shell re-parsing of prompt content). The CLI enforces its own
    // recall timeout and prints the hookSpecificOutput JSON, or nothing.
    `cat | ${cli} 2>/dev/null || true`,
    `exit 0`,
  ].join('\n');
}

/**
 * SessionStart hook: emits the session briefing as additionalContext at the
 * start of every session — the automatic replacement for "the agent should call
 * session_start".
 */
export function buildSessionStartHook(opts: AmbientHookOptions): string {
  return buildHook('SessionStart', opts);
}

/**
 * UserPromptSubmit hook — the core of Ambient Recall. Runs before every user
 * message, recalls on the prompt through the relevance gate, and pushes gated
 * hits into context. This is the most-forgotten call, made automatic.
 */
export function buildUserPromptSubmitHook(opts: AmbientHookOptions): string {
  return buildHook('UserPromptSubmit', opts);
}

export interface AmbientHookPaths {
  sessionStart: string;
  userPromptSubmit: string;
}

/**
 * Build the `.claude/settings.json` `hooks` fragment that wires both scripts.
 * The caller merges this into the user's existing settings (never overwrites).
 * Shape matches Claude Code's hooks config: an array of matcher groups, each
 * with a list of `{ type: "command", command }` entries.
 */
export function buildAmbientSettingsHooks(paths: AmbientHookPaths): {
  SessionStart: Array<{ hooks: Array<{ type: 'command'; command: string }> }>;
  UserPromptSubmit: Array<{ hooks: Array<{ type: 'command'; command: string }> }>;
} {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: paths.sessionStart }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: paths.userPromptSubmit }] }],
  };
}
