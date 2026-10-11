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

import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURSOR_FLAG, type CursorEreignis } from './cursor-hook.js';
import { COPILOT_FLAG, COPILOT_HOOK_EVENTS, type CopilotEreignis } from './copilot-hook.js';
import { CODEX_FLAG, CODEX_HOOK_EVENTS, type CodexEreignis } from './codex-hook.js';
import { GEMINI_FLAG, GEMINI_HOOK_EVENTS, type GeminiEreignis } from './gemini-hook.js';
import { istCachlyEintrag } from './hook-zugang.js';

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
 * v5 (11.10.2026): no npx. Each script loads the hook bundle that sits next
 * to it (HOOK_BUENDEL, copied by installAmbientHooks) in the same process.
 * v4 spawned `npx @cachly-dev/mcp-server@latest ambient-recall` per prompt:
 * measured 7.7 s warm and 17.1 s cold against a 10 s limit.
 */
export const AMBIENT_HOOK_VERSION = 'v5';

/**
 * The CLI subcommand that runs one hook from the published package
 * (`cachly ambient-recall`). Hooks from v5 on no longer call it; it stays for
 * project hooks from before v5, and runs the same function as the bundle
 * (ambient-hook.ts).
 */
export const AMBIENT_CLI_SUBCOMMAND = 'ambient-recall';

/**
 * The npx-free hook bundle: one file, no node_modules, built from
 * src/ambient-hook-start.ts by scripts/plugin-hooks-schreiben.mjs. It lives in
 * the package under hooks/ (the plugin calls it there) and is copied next to
 * the project hook scripts under .claude/hooks/.
 */
export const HOOK_BUENDEL = 'cachly-ambient-einblendung.mjs';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';

export interface AmbientHookOptions {
  instanceId: string;
  /**
   * Accepted for backward compatibility but never embedded in the generated
   * script (GROW-015): the hook resolves its key at run time (hook-zugang.ts).
   */
  apiKey?: string;
}

/** Escape a value for embedding inside a single-quoted JS string literal. */
function jsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * One project hook script (v5): bakes in the instance id the user chose for
 * this project, then loads the bundle next to it in the same process — no
 * child process, no npx. The bundle reads the payload on stdin, resolves the
 * key at run time (GROW-015: never a literal here) and always exits 0.
 */
function buildHook(event: AmbientHookEvent, opts: AmbientHookOptions): string {
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `// Pushes relevant memory into context automatically. Cross-platform Node hook`,
    `// (no shell script — runs identically on Windows/macOS/Linux). Never blocks`,
    `// the agent: every failure path exits 0 with no output (graceful degrade).`,
    `// Runs the hook bundle next to this file (${HOOK_BUENDEL}) in this process.`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${jsString(opts.instanceId)}';`,
    `process.env.CACHLY_HOOK_EVENT = '${jsString(event)}';`,
    `process.argv.splice(2, process.argv.length, '${jsString(event)}');`,
    `try {`,
    `  await import('./${HOOK_BUENDEL}');`,
    `} catch {`,
    `  process.exit(0);`,
    `}`,
  ].join('\n');
}

/**
 * Where the bundle sits in this package: `hooks/` next to `src/` in the
 * monorepo (tests), or next to `dist/` in the published package. null when
 * neither exists.
 */
export function hookBuendelQuelle(): string | null {
  const hier = dirname(fileURLToPath(import.meta.url));
  for (const kandidat of [
    resolve(hier, '..', PLUGIN_HOOK_DIR, HOOK_BUENDEL),
    resolve(hier, '..', '..', PLUGIN_HOOK_DIR, HOOK_BUENDEL),
  ]) {
    if (existsSync(kandidat)) return kandidat;
  }
  return null;
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

// Per-event latency budgets (seconds). The hook self-limits its fetch and the
// reader; these are the outer safety net so a wedged hook never stalls a turn.
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
export function buildAmbientSettingsHooks(
  paths: AmbientHookPaths,
  /** Arguments after the script path, per event (the plugin passes `<Event> --plugin`). */
  argsFor?: (event: AmbientHookEvent) => string,
): Record<string, HookMatcherGroup[]> {
  // v3: the command is `node "<script>"` — a plain string that both /bin/sh
  // (macOS/Linux, Windows+Git-Bash) and PowerShell (native Windows fallback)
  // execute identically, so one settings shape covers every platform.
  const entry = (event: AmbientHookEvent, scriptPath: string, matcher?: string): HookMatcherGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{
      type: 'command',
      command: `node "${scriptPath}"${argsFor ? ` ${argsFor(event)}` : ''}`,
      timeout: EVENT_TIMEOUTS[event],
    }],
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
  /** The hook bundle the four scripts load (v5). */
  bundlePath: string;
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

  // v5: the scripts load the bundle next to them. Without it they would do
  // nothing at all — so a package without the bundle fails loudly here.
  const bundleSource = hookBuendelQuelle();
  if (!bundleSource) throw new Error(`cachly hook bundle ${HOOK_BUENDEL} missing from the package`);
  const bundle = readFileSync(bundleSource, 'utf-8');
  const bundlePath = resolve(hookDir, HOOK_BUENDEL);

  const readIf = async (p: string): Promise<string> => {
    try { return await readFile(p, 'utf-8'); } catch { return ''; }
  };

  let anyExisting = false;
  let allCurrent = (await readIf(bundlePath)) === bundle;
  for (const e of events) {
    const prev = await readIf(pathFor(e));
    if (prev) anyExisting = true;
    if (prev !== scriptFor[e] + '\n') allCurrent = false;
  }
  const scripts: AmbientInstallResult['scripts'] = allCurrent ? 'unchanged' : anyExisting ? 'upgraded' : 'written';

  if (scripts !== 'unchanged') {
    // Bundle first: a script that already runs must never find a half-written one missing.
    await writeFile(bundlePath, bundle, 'utf-8');
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
    bundlePath,
    scripts,
    settings: settingsStatus,
  };
}

// ── Cursor ───────────────────────────────────────────────────────────────────
//
// Warum (11.10.2026): Die Einblendung kam nur in Claude Code an. Cursor hat
// eigene Hooks (Rohtext https://cursor.com/docs/hooks.md). Dort kann
// beforeSubmitPrompt dem Prompt nichts anfuegen; Kontext geht nur ueber
// sessionStart und postToolUse (`additional_context`). Der Ablauf steht in
// cursor-hook.ts; hier steht nur, was setup/autopilot/init dafuer schreibt:
//   • .cursor/hooks/cachly-ambient-einblendung.mjs  das Buendel (dasselbe wie unter .claude/hooks/)
//   • .cursor/hooks/cachly-ambient-cursor.mjs       traegt die Instanz, ruft das Buendel mit --cursor
//   • .cursor/hooks.json                            drei Eintraege, fremde bleiben stehen
// Projekt-Hooks laufen laut Doku "from the project root"; darum relative Pfade
// `.cursor/hooks/...`, wie in den Beispielen der Doku.

export const CURSOR_HOOK_DIR = '.cursor/hooks';
const CURSOR_HOOKS_DATEI = '.cursor/hooks.json';
export const CURSOR_SKRIPT = 'cachly-ambient-cursor.mjs';

/** Zeitlimit je Ereignis in Sekunden (Feld `timeout` in hooks.json). */
export const CURSOR_TIMEOUTS: Record<CursorEreignis, number> = {
  sessionStart: 30,
  beforeSubmitPrompt: 10,
  postToolUse: 5,
};

/**
 * Das kleine Skript vor dem Buendel, fuer jeden Editor mit eigenem Format:
 * Instanz dieses Projekts (nie ein Schluessel, GROW-015), dann das Kennzeichen
 * des Editors, dann das Buendel daneben im selben Prozess.
 */
function buildEditorHook(editor: string, flag: string, ereignisse: readonly string[], opts: AmbientHookOptions): string {
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${editor} ${AMBIENT_HOOK_VERSION}`,
    `// Einblendung fuer ${editor}: ${ereignisse.join(', ')}.`,
    `// Blockiert nie: jeder Fehler endet mit Exit 0. Ruft das Buendel daneben`,
    `// (${HOOK_BUENDEL}) in diesem Prozess.`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${jsString(opts.instanceId)}';`,
    `process.argv.push('${flag}');`,
    `try {`,
    `  await import('./${HOOK_BUENDEL}');`,
    `} catch {`,
    `  process.exit(0);`,
    `}`,
  ].join('\n');
}

/** Das kleine Skript vor dem Buendel: Instanz dieses Projekts, dann `--cursor`. */
export function buildCursorHook(opts: AmbientHookOptions): string {
  return buildEditorHook('Cursor', CURSOR_FLAG, ['sessionStart', 'beforeSubmitPrompt', 'postToolUse'], opts);
}

export interface CursorHookEintrag {
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
export interface CursorHooksDatei {
  version?: number;
  hooks?: Record<string, CursorHookEintrag[]>;
  [k: string]: unknown;
}

/** Die cachly-Eintraege fuer .cursor/hooks.json. */
export function buildCursorHooks(): Record<CursorEreignis, CursorHookEintrag[]> {
  const eintrag = (e: CursorEreignis): CursorHookEintrag[] => [
    { command: `node ${CURSOR_HOOK_DIR}/${CURSOR_SKRIPT} ${e}`, timeout: CURSOR_TIMEOUTS[e] },
  ];
  return {
    sessionStart: eintrag('sessionStart'),
    beforeSubmitPrompt: eintrag('beforeSubmitPrompt'),
    postToolUse: eintrag('postToolUse'),
  };
}

/**
 * Fuegt die cachly-Eintraege in eine vorhandene hooks.json ein. Fremde
 * Eintraege und Ereignisse bleiben, alte cachly-Eintraege werden ersetzt
 * (nie doppelt). `version` bleibt, fehlt sie, kommt 1 (Pflichtfeld laut Doku).
 * Rein — getestet.
 */
export function mergeCursorHooks(existing: CursorHooksDatei): { datei: CursorHooksDatei; changed: boolean } {
  return mergeFlach(existing, buildCursorHooks());
}

/**
 * Zusammenfuehren fuer Dateien mit flachen Listen je Ereignis und `version`
 * (Cursor, Copilot). Fremde Eintraege und Ereignisse bleiben, alte
 * cachly-Eintraege werden ersetzt (nie doppelt). `version` bleibt; fehlt sie,
 * kommt 1 (Pflichtfeld in beiden Formaten).
 */
function mergeFlach<T extends { version?: number; hooks?: Record<string, unknown[]>; [k: string]: unknown }>(
  existing: T,
  unsere: Record<string, unknown[]>,
): { datei: T; changed: boolean } {
  const hooks: Record<string, unknown[]> = { ...(existing.hooks ?? {}) };
  for (const [e, eintraege] of Object.entries(unsere)) {
    const fremd = (Array.isArray(hooks[e]) ? hooks[e] : []).filter((h) => !istCachlyEintrag(h));
    hooks[e] = [...fremd, ...eintraege];
  }
  const datei = { ...existing, version: typeof existing.version === 'number' ? existing.version : 1, hooks } as T;
  return { datei, changed: JSON.stringify(datei) !== JSON.stringify(existing) };
}

/** Eine Matcher-Gruppe wie bei Claude Code, Codex und Gemini: `{ matcher?, hooks: [...] }`. */
export interface HookGruppe {
  matcher?: string;
  hooks?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Zusammenfuehren fuer Dateien mit Matcher-Gruppen (Codex, Gemini). Aus jeder
 * Gruppe fallen nur die cachly-Eintraege; eine Gruppe, die dadurch leer wird,
 * faellt ganz. Fremde Eintraege bleiben auch in gemischten Gruppen stehen.
 * Alle anderen Felder der Datei (bei Gemini die ganzen Einstellungen) bleiben.
 */
function mergeGruppen<T extends { hooks?: Record<string, unknown>; [k: string]: unknown }>(
  existing: T,
  unsere: Record<string, HookGruppe[]>,
): { datei: T; changed: boolean } {
  const hooks: Record<string, unknown> = { ...(existing.hooks ?? {}) };
  for (const [e, gruppen] of Object.entries(unsere)) {
    const fremd = (Array.isArray(hooks[e]) ? (hooks[e] as unknown[]) : []).flatMap((g) => {
      const liste = (g as HookGruppe | null)?.hooks;
      if (!Array.isArray(liste)) return [g];
      const rest = liste.filter((h) => !istCachlyEintrag(h));
      if (rest.length === liste.length) return [g];
      return rest.length ? [{ ...(g as HookGruppe), hooks: rest }] : [];
    });
    hooks[e] = [...fremd, ...gruppen];
  }
  const datei = { ...existing, hooks } as T;
  return { datei, changed: JSON.stringify(datei) !== JSON.stringify(existing) };
}

/** Was setup/autopilot/init je Editor geschrieben hat. */
export interface EditorInstallResult {
  scriptPath: string;
  bundlePath: string;
  /** Die Konfigurationsdatei des Editors (hooks.json, settings.json …). */
  hooksPath: string;
  scripts: 'written' | 'upgraded' | 'unchanged';
  /** 'skipped': die Datei war kein JSON-Objekt — sie bleibt unangetastet, der Hook ist nicht verdrahtet. */
  hooks: 'written' | 'merged' | 'unchanged' | 'skipped';
}
export type CursorInstallResult = EditorInstallResult;

interface HookDateien {
  projectDir: string;
  /** Ordner fuer Skript und Buendel, relativ zum Projekt. */
  hookDir: string;
  skriptName: string;
  /** Inhalt des kleinen Skripts (buildEditorHook). */
  skript: string;
  /** Konfigurationsdatei des Editors, relativ zum Projekt. */
  configDatei: string;
  /** Fuehrt die cachly-Eintraege ein; bekommt den absoluten Pfad des Skripts. */
  merge: (vorhanden: Record<string, unknown>, scriptPath: string) => { datei: unknown; changed: boolean };
}

/**
 * Der eine Installer fuer Editoren mit eigenem Format: Buendel und Skript
 * schreiben (nur wenn noetig), die Konfiguration zusammenfuehren. Eine
 * Konfiguration, die kein JSON-Objekt ist oder deren `hooks` kein Objekt ist,
 * bleibt unangetastet. Wirft nur bei Dateifehlern.
 */
async function installiereHookDateien(d: HookDateien): Promise<EditorInstallResult> {
  const hookDir = resolve(d.projectDir, d.hookDir);
  await mkdir(hookDir, { recursive: true });

  const bundleSource = hookBuendelQuelle();
  if (!bundleSource) throw new Error(`cachly hook bundle ${HOOK_BUENDEL} missing from the package`);
  const bundle = readFileSync(bundleSource, 'utf-8');
  const bundlePath = resolve(hookDir, HOOK_BUENDEL);
  const scriptPath = resolve(hookDir, d.skriptName);
  const script = d.skript + '\n';

  const readIf = async (p: string): Promise<string> => {
    try { return await readFile(p, 'utf-8'); } catch { return ''; }
  };
  const altSkript = await readIf(scriptPath);
  const allCurrent = altSkript === script && (await readIf(bundlePath)) === bundle;
  const scripts: EditorInstallResult['scripts'] = allCurrent ? 'unchanged' : altSkript ? 'upgraded' : 'written';
  if (scripts !== 'unchanged') {
    // Buendel zuerst: ein laufendes Skript darf nie ein halbes vorfinden.
    await writeFile(bundlePath, bundle, 'utf-8');
    await writeFile(scriptPath, script, 'utf-8');
    await chmod(scriptPath, 0o755).catch(() => {});
  }

  const hooksPath = resolve(d.projectDir, d.configDatei);
  const roh = existsSync(hooksPath) ? await readIf(hooksPath) : null;
  let vorhanden: Record<string, unknown> = {};
  if (roh !== null && roh.trim()) {
    try {
      const p = JSON.parse(roh) as unknown;
      if (!istObjekt(p)) throw new Error('kein Objekt');
      if (p.hooks !== undefined && !istObjekt(p.hooks)) throw new Error('hooks ist kein Objekt');
      vorhanden = p;
    } catch {
      // Eine kaputte Datei des Nutzers wird nicht ueberschrieben.
      return { scriptPath, bundlePath, hooksPath, scripts, hooks: 'skipped' };
    }
  }
  const { datei, changed } = d.merge(vorhanden, scriptPath);
  let hooks: EditorInstallResult['hooks'];
  if (roh === null || !roh.trim()) hooks = 'written';
  else if (!changed) hooks = 'unchanged';
  else hooks = 'merged';
  if (hooks !== 'unchanged') {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(datei, null, 2) + '\n', 'utf-8');
  }

  return { scriptPath, bundlePath, hooksPath, scripts, hooks };
}

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Installiert/erneuert den Cursor-Hook in `projectDir`. Wirft nur bei Dateifehlern. */
export async function installCursorHooks(projectDir: string, instanceId: string): Promise<CursorInstallResult> {
  return installiereHookDateien({
    projectDir,
    hookDir: CURSOR_HOOK_DIR,
    skriptName: CURSOR_SKRIPT,
    skript: buildCursorHook({ instanceId }),
    configDatei: CURSOR_HOOKS_DATEI,
    merge: (vorhanden) => mergeCursorHooks(vorhanden as CursorHooksDatei),
  });
}

// ── VS Code mit GitHub Copilot ───────────────────────────────────────────────
//
// Warum (11.10.2026): siehe copilot-hook.ts. Was setup/autopilot/init schreibt:
//   • .github/hooks/cachly-ambient-einblendung.mjs  das Buendel
//   • .github/hooks/cachly-ambient-copilot.mjs      traegt die Instanz, ruft das Buendel mit --copilot
//   • .github/hooks/cachly-ambient.json             drei Eintraege im Copilot-Format
// Copilot-Format (`version: 1`, camelCase, `timeoutSec`), weil es das einzige
// ist, das VS Code Local UND Copilot CLI laut Doku lesen; VS Code bildet
// `command` und `timeoutSec` selbst ab (vscode hookSchema.ts
// normalizeHookCommand). `cwd: "."` ist die Wurzel des Repos — so steht es im
// Beispiel der Copilot-CLI-Anleitung; ohne `cwd` nimmt VS Code dieselbe Wurzel.

export const COPILOT_HOOK_DIR = '.github/hooks';
export const COPILOT_HOOKS_DATEI = '.github/hooks/cachly-ambient.json';
export const COPILOT_SKRIPT = 'cachly-ambient-copilot.mjs';

/** Zeitlimit je Ereignis in Sekunden (`timeoutSec`; Vorgabe beider Laufzeiten: 30). */
export const COPILOT_TIMEOUTS: Record<CopilotEreignis, number> = {
  sessionStart: 30,
  userPromptSubmitted: 10,
  postToolUse: 5,
};

export interface CopilotHookEintrag {
  type?: string;
  command?: string;
  cwd?: string;
  timeoutSec?: number;
  [k: string]: unknown;
}
export interface CopilotHooksDatei {
  version?: number;
  hooks?: Record<string, CopilotHookEintrag[]>;
  [k: string]: unknown;
}

/** Das kleine Skript fuer .github/hooks/: Instanz dieses Projekts, dann `--copilot`. */
export function buildCopilotHook(opts: AmbientHookOptions): string {
  return buildEditorHook('VS Code / Copilot', COPILOT_FLAG, COPILOT_HOOK_EVENTS, opts);
}

/** Die cachly-Eintraege fuer .github/hooks/cachly-ambient.json. */
export function buildCopilotHooks(): Record<CopilotEreignis, CopilotHookEintrag[]> {
  const eintrag = (e: CopilotEreignis): CopilotHookEintrag[] => [{
    type: 'command',
    command: `node ${COPILOT_HOOK_DIR}/${COPILOT_SKRIPT} ${e}`,
    cwd: '.',
    timeoutSec: COPILOT_TIMEOUTS[e],
  }];
  return {
    sessionStart: eintrag('sessionStart'),
    userPromptSubmitted: eintrag('userPromptSubmitted'),
    postToolUse: eintrag('postToolUse'),
  };
}

export function mergeCopilotHooks(existing: CopilotHooksDatei): { datei: CopilotHooksDatei; changed: boolean } {
  return mergeFlach(existing, buildCopilotHooks());
}

/** Installiert/erneuert den VS-Code-/Copilot-Hook in `projectDir`. Wirft nur bei Dateifehlern. */
export async function installCopilotHooks(projectDir: string, instanceId: string): Promise<EditorInstallResult> {
  return installiereHookDateien({
    projectDir,
    hookDir: COPILOT_HOOK_DIR,
    skriptName: COPILOT_SKRIPT,
    skript: buildCopilotHook({ instanceId }),
    configDatei: COPILOT_HOOKS_DATEI,
    merge: (vorhanden) => mergeCopilotHooks(vorhanden as CopilotHooksDatei),
  });
}

// ── OpenAI Codex CLI ─────────────────────────────────────────────────────────
//
// Warum (11.10.2026): siehe codex-hook.ts. Was setup/autopilot/init schreibt:
//   • .codex/hooks/cachly-ambient-einblendung.mjs  das Buendel
//   • .codex/hooks/cachly-ambient-codex.mjs        traegt die Instanz, ruft das Buendel mit --codex
//   • .codex/hooks.json                            zwei Gruppen, fremde bleiben stehen
// Der Befehl nennt das Skript mit ABSOLUTEM Pfad, wie die Claude-Hooks: Codex
// fuehrt Befehle "with the session cwd as their working directory" aus und
// "may be started from a subdirectory". Der Vorschlag der Doku
// (`$(git rev-parse --show-toplevel)`) laeuft unter Windows nicht — Codex ruft
// dort `cmd.exe /C` (codex-rs/hooks/src/engine/command_runner.rs).
// Projekt-Hooks laedt Codex nur, wenn der Nutzer dem Ordner `.codex/` traut,
// und jeden neuen Hook erst nach Pruefung in `/hooks`.

export const CODEX_HOOK_DIR = '.codex/hooks';
export const CODEX_HOOKS_DATEI = '.codex/hooks.json';
export const CODEX_SKRIPT = 'cachly-ambient-codex.mjs';

/** Zeitlimit je Ereignis in Sekunden (`timeout`; Codex-Vorgabe 600). */
export const CODEX_TIMEOUTS: Record<CodexEreignis, number> = {
  SessionStart: 30,
  UserPromptSubmit: 10,
};

export interface CodexHooksDatei {
  hooks?: Record<string, HookGruppe[]>;
  [k: string]: unknown;
}

/** Das kleine Skript fuer .codex/hooks/: Instanz dieses Projekts, dann `--codex`. */
export function buildCodexHook(opts: AmbientHookOptions): string {
  return buildEditorHook('Codex', CODEX_FLAG, CODEX_HOOK_EVENTS, opts);
}

/** Die cachly-Gruppen fuer .codex/hooks.json; `skriptPfad` ist absolut. */
export function buildCodexHooks(skriptPfad: string): Record<CodexEreignis, HookGruppe[]> {
  const gruppe = (e: CodexEreignis): HookGruppe[] => [{
    hooks: [{ type: 'command', command: `node "${skriptPfad}" ${e}`, timeout: CODEX_TIMEOUTS[e] }],
  }];
  return { SessionStart: gruppe('SessionStart'), UserPromptSubmit: gruppe('UserPromptSubmit') };
}

export function mergeCodexHooks(existing: CodexHooksDatei, skriptPfad: string): { datei: CodexHooksDatei; changed: boolean } {
  return mergeGruppen(existing, buildCodexHooks(skriptPfad));
}

/** Installiert/erneuert den Codex-Hook in `projectDir`. Wirft nur bei Dateifehlern. */
export async function installCodexHooks(projectDir: string, instanceId: string): Promise<EditorInstallResult> {
  return installiereHookDateien({
    projectDir,
    hookDir: CODEX_HOOK_DIR,
    skriptName: CODEX_SKRIPT,
    skript: buildCodexHook({ instanceId }),
    configDatei: CODEX_HOOKS_DATEI,
    merge: (vorhanden, scriptPath) => mergeCodexHooks(vorhanden as CodexHooksDatei, scriptPath),
  });
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────
//
// Warum (11.10.2026): siehe gemini-hook.ts. Was setup/autopilot/init schreibt:
//   • .gemini/hooks/cachly-ambient-einblendung.mjs  das Buendel
//   • .gemini/hooks/cachly-ambient-gemini.mjs       traegt die Instanz, ruft das Buendel mit --gemini
//   • .gemini/settings.json                         `hooks` zusammengefuehrt, alle anderen Einstellungen bleiben
// Relative Pfade wie in den Beispielen der Doku (`node .gemini/hooks/…`):
// Gemini startet Hooks mit `cwd` = Projektwurzel (hookRunner.ts, `cwd: input.cwd`).
// Gemini prueft Projekt-Hooks per Fingerabdruck und warnt vor jedem neuen.

export const GEMINI_HOOK_DIR = '.gemini/hooks';
export const GEMINI_SETTINGS_DATEI = '.gemini/settings.json';
export const GEMINI_SKRIPT = 'cachly-ambient-gemini.mjs';

/** Zeitlimit je Ereignis in MILLISEKUNDEN (`timeout` bei Gemini; Vorgabe 60000). */
export const GEMINI_TIMEOUTS_MS: Record<GeminiEreignis, number> = {
  SessionStart: 30_000,
  BeforeAgent: 10_000,
};

/** Namen fuer `/hooks disable <name>` und die Liste `hooksConfig.disabled`. */
const GEMINI_NAMEN: Record<GeminiEreignis, string> = {
  SessionStart: 'cachly-briefing',
  BeforeAgent: 'cachly-recall',
};

export interface GeminiSettingsDatei {
  hooks?: Record<string, HookGruppe[]>;
  [k: string]: unknown;
}

/** Das kleine Skript fuer .gemini/hooks/: Instanz dieses Projekts, dann `--gemini`. */
export function buildGeminiHook(opts: AmbientHookOptions): string {
  return buildEditorHook('Gemini CLI', GEMINI_FLAG, GEMINI_HOOK_EVENTS, opts);
}

/** Die cachly-Gruppen fuer .gemini/settings.json. */
export function buildGeminiHooks(): Record<GeminiEreignis, HookGruppe[]> {
  const gruppe = (e: GeminiEreignis): HookGruppe[] => [{
    hooks: [{
      name: GEMINI_NAMEN[e],
      type: 'command',
      command: `node ${GEMINI_HOOK_DIR}/${GEMINI_SKRIPT} ${e}`,
      timeout: GEMINI_TIMEOUTS_MS[e],
    }],
  }];
  return { SessionStart: gruppe('SessionStart'), BeforeAgent: gruppe('BeforeAgent') };
}

export function mergeGeminiHooks(existing: GeminiSettingsDatei): { datei: GeminiSettingsDatei; changed: boolean } {
  return mergeGruppen(existing, buildGeminiHooks());
}

/** Installiert/erneuert den Gemini-Hook in `projectDir`. Wirft nur bei Dateifehlern. */
export async function installGeminiHooks(projectDir: string, instanceId: string): Promise<EditorInstallResult> {
  return installiereHookDateien({
    projectDir,
    hookDir: GEMINI_HOOK_DIR,
    skriptName: GEMINI_SKRIPT,
    skript: buildGeminiHook({ instanceId }),
    configDatei: GEMINI_SETTINGS_DATEI,
    merge: (vorhanden) => mergeGeminiHooks(vorhanden as GeminiSettingsDatei),
  });
}

// ── Claude-Code-Plugin ───────────────────────────────────────────────────────
//
// Warum (11.10.2026): Das Plugin brachte nur den MCP-Server mit. Die
// Einblendung vor jedem Prompt, das Sitzungs-Briefing und der Schreibbeleg
// kamen allein ueber `init`/`setup`/`autopilot` (installAmbientHooks). Wer
// cachly ueber den Marktplatz installierte, bekam das staerkste Merkmal nie.
//
// Jetzt liegen unter sdk/mcp/hooks/ (der Spiegel cachly-mcp nimmt sie mit;
// dort ist es die Plugin-Wurzel) zwei erzeugte Dateien:
//   • hooks.json — von hier (buildPluginHooksJson),
//   • das Hook-Buendel HOOK_BUENDEL — esbuild aus src/ambient-hook-start.ts.
// `npm run plugin-hooks:write` schreibt beide, der Waechter
// src/__tests__/plugin-hooks.test.ts vergleicht sie byteweise mit der Quelle.
//
// Das Plugin ruft das Buendel direkt: `node "<buendel>" <Ereignis> --plugin`.
// `--plugin` heisst: Schluessel und Instanz zur Laufzeit suchen, und
// zuruecktreten, wenn das Projekt dieselben Hooks schon hat (hook-zugang.ts).

/**
 * Events the plugin ships. PreToolUse stays a project-install extra: one more
 * hook run before every single edit for every plugin user.
 */
export const PLUGIN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;

/** Directory under the plugin root (= sdk/mcp) that holds hooks.json and the bundle. */
export const PLUGIN_HOOK_DIR = 'hooks';

/**
 * The plugin's `hooks/hooks.json`, which Claude Code loads from that default
 * location. Same shape and timeouts as the project install; the command runs
 * the bundle directly with the event and `--plugin`.
 */
export function buildPluginHooksJson(): string {
  const buendel = '${CLAUDE_PLUGIN_ROOT}/' + `${PLUGIN_HOOK_DIR}/${HOOK_BUENDEL}`;
  const hooks = buildAmbientSettingsHooks(
    { sessionStart: buendel, userPromptSubmit: buendel, stop: buendel },
    (event) => `${event} --plugin`,
  );
  return JSON.stringify({ hooks }, null, 2) + '\n';
}

