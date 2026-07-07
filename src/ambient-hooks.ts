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

import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Bumped whenever a hook script changes so installers can upgrade old hooks. */
export const AMBIENT_HOOK_VERSION = 'v1';

/**
 * The CLI subcommand the hooks pipe their payload to. It reads the hook JSON on
 * stdin, runs smart_recall through the relevance gate (ambient-recall.ts), and
 * prints the `hookSpecificOutput` JSON Claude Code injects as additionalContext.
 * The CLI self-limits its latency budget (§6.3 guardrail 4). See ambient-cli.ts.
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

// ── Installer ────────────────────────────────────────────────────────────────
// Writes the two hook scripts into `.claude/hooks/` and merges the settings
// fragment into `.claude/settings.json`. Idempotent and non-destructive:
//   • re-running upgrades the scripts in place (version marker) and never
//     duplicates a settings entry that already points at our script,
//   • foreign hooks in the user's settings are preserved (we append, never
//     overwrite the arrays).
// Never throws — returns a status the caller can log.

const HOOK_DIR = '.claude/hooks';
const SESSION_START_SCRIPT = 'cachly-ambient-session-start.sh';
const PROMPT_SUBMIT_SCRIPT = 'cachly-ambient-prompt-submit.sh';
const SETTINGS_FILE = '.claude/settings.json';

export interface AmbientInstallResult {
  sessionStartPath: string;
  promptSubmitPath: string;
  scripts: 'written' | 'upgraded' | 'unchanged';
  settings: 'written' | 'merged' | 'unchanged';
}

interface HookCommandEntry {
  hooks?: Array<{ type?: string; command?: string }>;
}
interface ClaudeSettings {
  hooks?: Record<string, HookCommandEntry[]>;
  [k: string]: unknown;
}

/** True when some matcher group in `groups` already wires exactly `command`. */
function hasHookCommand(groups: HookCommandEntry[] | undefined, command: string): boolean {
  return (groups ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === command));
}

/**
 * Merge our SessionStart + UserPromptSubmit entries into an existing settings
 * object without disturbing anything else. Returns the new object and whether it
 * changed. Pure — unit-tested.
 */
export function mergeAmbientSettings(
  existing: ClaudeSettings,
  paths: AmbientHookPaths,
): { settings: ClaudeSettings; changed: boolean } {
  const next: ClaudeSettings = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const hooks = next.hooks!;
  let changed = false;

  const ensure = (event: 'SessionStart' | 'UserPromptSubmit', command: string) => {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    if (hasHookCommand(groups, command)) {
      hooks[event] = groups;
      return;
    }
    groups.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = groups;
    changed = true;
  };

  ensure('SessionStart', paths.sessionStart);
  ensure('UserPromptSubmit', paths.userPromptSubmit);
  return { settings: next, changed };
}

/**
 * Install/upgrade the Ambient Recall hooks in `projectDir`. Best-effort:
 * a filesystem error surfaces as a thrown error only for the top-level caller,
 * which wraps it in try/catch (the git-hook feature is non-critical).
 */
export async function installAmbientHooks(
  projectDir: string,
  instanceId: string,
  apiKey?: string,
): Promise<AmbientInstallResult> {
  const hookDir = resolve(projectDir, HOOK_DIR);
  const sessionStartPath = resolve(hookDir, SESSION_START_SCRIPT);
  const promptSubmitPath = resolve(hookDir, PROMPT_SUBMIT_SCRIPT);
  await mkdir(hookDir, { recursive: true });

  const opts: AmbientHookOptions = { instanceId, apiKey };
  const sessionScript = buildSessionStartHook(opts);
  const promptScript = buildUserPromptSubmitHook(opts);

  const readIf = async (p: string): Promise<string> => {
    try { return await readFile(p, 'utf-8'); } catch { return ''; }
  };
  const prevSession = await readIf(sessionStartPath);
  const prevPrompt = await readIf(promptSubmitPath);

  let scripts: AmbientInstallResult['scripts'];
  if (!prevSession && !prevPrompt) scripts = 'written';
  else if (prevSession === sessionScript && prevPrompt === promptScript) scripts = 'unchanged';
  else scripts = 'upgraded';

  if (scripts !== 'unchanged') {
    await writeFile(sessionStartPath, sessionScript + '\n', 'utf-8');
    await writeFile(promptSubmitPath, promptScript + '\n', 'utf-8');
    await chmod(sessionStartPath, 0o755).catch(() => {});
    await chmod(promptSubmitPath, 0o755).catch(() => {});
  }

  // Merge the settings fragment.
  const settingsPath = resolve(projectDir, SETTINGS_FILE);
  const settingsExisted = existsSync(settingsPath);
  let existingSettings: ClaudeSettings = {};
  if (settingsExisted) {
    try { existingSettings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeSettings; }
    catch { existingSettings = {}; } // corrupt/empty file → start fresh (still non-destructive to hooks we add)
  }
  const { settings, changed } = mergeAmbientSettings(existingSettings, {
    sessionStart: sessionStartPath,
    userPromptSubmit: promptSubmitPath,
  });
  let settingsStatus: AmbientInstallResult['settings'];
  if (!settingsExisted) settingsStatus = 'written';
  else if (!changed) settingsStatus = 'unchanged';
  else settingsStatus = 'merged';
  if (settingsStatus !== 'unchanged') {
    await mkdir(resolve(projectDir, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  return { sessionStartPath, promptSubmitPath, scripts, settings: settingsStatus };
}
