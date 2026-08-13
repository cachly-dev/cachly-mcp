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

/**
 * Bumped whenever a hook script changes so installers can upgrade old hooks.
 * v3: hooks became Node scripts (.mjs) invoked as `node "<path>"` — the
 * cross-platform shape from the Claude Code hooks guide. The v1/v2 POSIX shell
 * scripts silently never ran on native Windows (no /bin/sh); Node is already a
 * hard requirement of this package, so the hook now runs identically on
 * Windows, macOS and Linux.
 * v4 (GROW-015): the script no longer embeds the caller's key as a string
 * literal. It resolves CACHLY_JWT at run time from the environment instead,
 * so a `.claude/hooks/` script that gets committed to a repo never leaks a
 * secret. Bumping the version replaces old v1-v3 scripts (which DID embed
 * the key) the next time setup/autopilot runs.
 */
export const AMBIENT_HOOK_VERSION = 'v4';

/**
 * The CLI subcommand the hooks pipe their payload to. It reads the hook JSON on
 * stdin, runs smart_recall through the relevance gate (ambient-recall.ts), and
 * prints the `hookSpecificOutput` JSON Claude Code injects as additionalContext.
 * The CLI self-limits its latency budget (§6.3 guardrail 4). See ambient-cli.ts.
 */
export const AMBIENT_CLI_SUBCOMMAND = 'ambient-recall';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';

export interface AmbientHookOptions {
  instanceId: string;
  /**
   * Accepted for backward compatibility but never embedded in the generated
   * script (GROW-015): the hook resolves its key at run time from
   * CACHLY_JWT/CACHLY_API_KEY in the environment instead.
   */
  apiKey?: string;
  /**
   * Command that resolves the ambient-recall CLI. Defaults to the published
   * package via npx; an installer SHOULD pass a resolved local binary to avoid
   * npx resolution latency on every prompt (UserPromptSubmit runs per-turn).
   */
  cliCommand?: string;
}

const DEFAULT_CLI = `npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`;

/** Escape a value for embedding inside a single-quoted JS string literal. */
function jsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildHook(event: AmbientHookEvent, opts: AmbientHookOptions): string {
  const cli = opts.cliCommand ?? DEFAULT_CLI;
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `// Pushes relevant memory into context automatically. Cross-platform Node hook`,
    `// (no shell script — runs identically on Windows/macOS/Linux). Never blocks`,
    `// the agent: every failure path exits 0 with no output (graceful degrade).`,
    `import { spawn } from 'node:child_process';`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${jsString(opts.instanceId)}';`,
    // GROW-015: never embed the caller's key as a string literal here — read
    // it at run time instead, so a committed .claude/hooks/ script can never
    // leak a secret. Only the key's origin changed: same events, same
    // output, same 3s budget, errors still swallowed.
    `if (!process.env.CACHLY_JWT && process.env.CACHLY_API_KEY) process.env.CACHLY_JWT = process.env.CACHLY_API_KEY;`,
    `process.env.CACHLY_HOOK_EVENT = '${jsString(event)}';`,
    `try {`,
    // Claude Code delivers the hook payload as JSON on stdin; stdio 'inherit'
    // hands it verbatim to the CLI (no re-parsing of prompt content), and the
    // CLI's hookSpecificOutput JSON flows straight back to Claude Code on
    // stdout. shell:true resolves npx/npx.cmd on every platform; stderr is
    // discarded so a noisy npm can never corrupt the hook protocol.
    `  const child = spawn('${jsString(cli)}', { shell: true, stdio: ['inherit', 'inherit', 'ignore'] });`,
    `  child.on('error', () => process.exit(0));`,
    `  child.on('close', () => process.exit(0));`,
    `} catch {`,
    `  process.exit(0);`,
    `}`,
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

/**
 * PreToolUse hook (Ausbau) — file-open briefing. Fires before Edit/Write-class
 * tools (settings matcher `Edit|Write|MultiEdit`); the CLI recalls file-scoped
 * lessons and injects them as additionalContext — the automatic "prüf mal, ob's
 * zu dieser Datei Lessons gibt" (roadmap §6.1).
 */
export function buildPreToolUseHook(opts: AmbientHookOptions): string {
  return buildHook('PreToolUse', opts);
}

/**
 * Stop hook (Ausbau) — auto-learn. After a turn whose final message carries a
 * clear fix signal, the CLI feeds one observation to auto_learn_session — the
 * automatic replacement for the forgotten `learn_from_attempts` call.
 */
export function buildStopHook(opts: AmbientHookOptions): string {
  return buildHook('Stop', opts);
}

export interface AmbientHookPaths {
  sessionStart: string;
  userPromptSubmit: string;
  /** Ausbau hooks — optional so MVP-era (v1) callers keep working. */
  preToolUse?: string;
  stop?: string;
}

export interface HookCommand {
  type: 'command';
  command: string;
  /** Per-hook timeout in seconds (Claude Code hooks config). */
  timeout?: number;
}
export interface HookMatcherGroup {
  /** Tool matcher — only meaningful for PreToolUse/PostToolUse. */
  matcher?: string;
  hooks: HookCommand[];
}

// Per-event latency budgets (seconds). The CLI self-limits recall to 3s; these
// are the outer safety net so a wedged npx can never stall a turn for long.
const EVENT_TIMEOUTS: Record<string, number> = {
  SessionStart: 30,
  UserPromptSubmit: 10,
  PreToolUse: 10,
  Stop: 60, // auto-learn may do a real write; Stop is not latency-critical
};

/** Matcher for the PreToolUse briefing: only file-mutating tools. */
export const PRE_TOOL_USE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/**
 * Build the `.claude/settings.json` `hooks` fragment that wires the scripts.
 * The caller merges this into the user's existing settings (never overwrites).
 * Shape matches Claude Code's hooks config: an array of matcher groups, each
 * with a list of `{ type: "command", command, timeout }` entries.
 */
export function buildAmbientSettingsHooks(paths: AmbientHookPaths): Record<string, HookMatcherGroup[]> {
  // v3: the command is `node "<script>"` — a plain string that both /bin/sh
  // (macOS/Linux, Windows+Git-Bash) and PowerShell (native Windows fallback)
  // execute identically, so one settings shape covers every platform.
  const entry = (event: AmbientHookEvent, scriptPath: string, matcher?: string): HookMatcherGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: `node "${scriptPath}"`, timeout: EVENT_TIMEOUTS[event] }],
  });
  const frag: Record<string, HookMatcherGroup[]> = {
    SessionStart: [entry('SessionStart', paths.sessionStart)],
    UserPromptSubmit: [entry('UserPromptSubmit', paths.userPromptSubmit)],
  };
  if (paths.preToolUse) frag.PreToolUse = [entry('PreToolUse', paths.preToolUse, PRE_TOOL_USE_MATCHER)];
  if (paths.stop) frag.Stop = [entry('Stop', paths.stop)];
  return frag;
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
const SETTINGS_FILE = '.claude/settings.json';
/** Script filename per event — shared marker `cachly-ambient-` drives upgrades. */
const SCRIPT_NAMES: Record<AmbientHookEvent, string> = {
  SessionStart: 'cachly-ambient-session-start.mjs',
  UserPromptSubmit: 'cachly-ambient-prompt-submit.mjs',
  PreToolUse: 'cachly-ambient-pre-tool.mjs',
  Stop: 'cachly-ambient-stop.mjs',
};
const AMBIENT_SCRIPT_MARKER = '.claude/hooks/cachly-ambient-';

export interface AmbientInstallResult {
  sessionStartPath: string;
  promptSubmitPath: string;
  preToolUsePath: string;
  stopPath: string;
  scripts: 'written' | 'upgraded' | 'unchanged';
  settings: 'written' | 'merged' | 'unchanged';
}

interface HookCommandEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
interface ClaudeSettings {
  hooks?: Record<string, HookCommandEntry[]>;
  [k: string]: unknown;
}

/** True when this matcher group only wires cachly-ambient scripts. */
function isAmbientGroup(g: HookCommandEntry, currentPaths: Set<string>): boolean {
  const hooks = g.hooks ?? [];
  return (
    hooks.length > 0 &&
    hooks.every((h) => {
      const cmd = h.command ?? '';
      // Matches v1/v2 entries (bare script path), v3 entries (`node "<path>"`),
      // and marker-less test/custom paths passed as the current fragment.
      return (
        cmd.includes(AMBIENT_SCRIPT_MARKER) ||
        currentPaths.has(cmd) ||
        [...currentPaths].some((p) => cmd.includes(`"${p}"`))
      );
    })
  );
}

/**
 * Merge our hook entries into an existing settings object without disturbing
 * anything else. Idempotent AND upgrade-safe: existing cachly-ambient groups
 * (from any prior version/paths) are replaced by the current fragment rather
 * than accumulated; foreign groups are always preserved. Pure — unit-tested.
 */
export function mergeAmbientSettings(
  existing: ClaudeSettings,
  paths: AmbientHookPaths,
): { settings: ClaudeSettings; changed: boolean } {
  const next: ClaudeSettings = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const hooks = next.hooks!;
  const fragment = buildAmbientSettingsHooks(paths);
  const currentPaths = new Set(
    [paths.sessionStart, paths.userPromptSubmit, paths.preToolUse, paths.stop].filter(
      (p): p is string => !!p,
    ),
  );

  for (const [event, ourGroups] of Object.entries(fragment)) {
    const foreign = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
      (g) => !isAmbientGroup(g, currentPaths),
    );
    hooks[event] = [...foreign, ...ourGroups];
  }
  const changed = JSON.stringify(next) !== JSON.stringify(existing);
  return { settings: next, changed };
}

export interface AmbientInstallOptions {
  /**
   * Write `"$CLAUDE_PROJECT_DIR"/.claude/hooks/…` commands into settings.json
   * instead of absolute paths. Use for hooks that are COMMITTED to a repo
   * (dogfooding/team setups): the settings stay valid on every checkout
   * location. Claude Code sets $CLAUDE_PROJECT_DIR when running hooks.
   * NOTE: never pass an apiKey together with portable — committed scripts
   * must not embed credentials; the CLI falls back to the env's CACHLY_JWT.
   */
  portable?: boolean;
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
  options: AmbientInstallOptions = {},
): Promise<AmbientInstallResult> {
  const hookDir = resolve(projectDir, HOOK_DIR);
  await mkdir(hookDir, { recursive: true });

  const opts: AmbientHookOptions = { instanceId, apiKey };
  const events: AmbientHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
  const scriptFor: Record<AmbientHookEvent, string> = {
    SessionStart: buildSessionStartHook(opts),
    UserPromptSubmit: buildUserPromptSubmitHook(opts),
    PreToolUse: buildPreToolUseHook(opts),
    Stop: buildStopHook(opts),
  };
  const pathFor = (e: AmbientHookEvent) => resolve(hookDir, SCRIPT_NAMES[e]);

  const readIf = async (p: string): Promise<string> => {
    try { return await readFile(p, 'utf-8'); } catch { return ''; }
  };

  let anyExisting = false;
  let allCurrent = true;
  for (const e of events) {
    const prev = await readIf(pathFor(e));
    if (prev) anyExisting = true;
    if (prev !== scriptFor[e] + '\n') allCurrent = false;
  }
  const scripts: AmbientInstallResult['scripts'] = allCurrent ? 'unchanged' : anyExisting ? 'upgraded' : 'written';

  if (scripts !== 'unchanged') {
    for (const e of events) {
      await writeFile(pathFor(e), scriptFor[e] + '\n', 'utf-8');
      await chmod(pathFor(e), 0o755).catch(() => {});
    }
  }

  // Merge the settings fragment (upgrade-safe: prior ambient groups replaced).
  const settingsPath = resolve(projectDir, SETTINGS_FILE);
  const settingsExisted = existsSync(settingsPath);
  let existingSettings: ClaudeSettings = {};
  if (settingsExisted) {
    try { existingSettings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeSettings; }
    catch { existingSettings = {}; } // corrupt/empty file → start fresh (still non-destructive to hooks we add)
  }
  // Portable installs (committed hooks) reference $CLAUDE_PROJECT_DIR so the
  // settings work at any checkout location; local installs use absolute paths.
  // These are SCRIPT PATHS — buildAmbientSettingsHooks wraps them as
  // `node "<path>"`, so the portable var sits inside the double quotes and is
  // expanded by the shell at hook time.
  const commandFor = (e: AmbientHookEvent) =>
    options.portable ? `$CLAUDE_PROJECT_DIR/${HOOK_DIR}/${SCRIPT_NAMES[e]}` : pathFor(e);
  const { settings, changed } = mergeAmbientSettings(existingSettings, {
    sessionStart: commandFor('SessionStart'),
    userPromptSubmit: commandFor('UserPromptSubmit'),
    preToolUse: commandFor('PreToolUse'),
    stop: commandFor('Stop'),
  });
  let settingsStatus: AmbientInstallResult['settings'];
  if (!settingsExisted) settingsStatus = 'written';
  else if (!changed) settingsStatus = 'unchanged';
  else settingsStatus = 'merged';
  if (settingsStatus !== 'unchanged') {
    await mkdir(resolve(projectDir, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  return {
    sessionStartPath: pathFor('SessionStart'),
    promptSubmitPath: pathFor('UserPromptSubmit'),
    preToolUsePath: pathFor('PreToolUse'),
    stopPath: pathFor('Stop'),
    scripts,
    settings: settingsStatus,
  };
}
