// Editor / host detection for telemetry attribution.
//
// The evening funnel report showed `unknown: 345` vs `claude: 96` / `vscode: 25`
// — the largest bucket was unattributed. The old detector only checked four
// env vars (CURSOR_TRACE_ID, WINDSURF_SESSION_ID, GITHUB_COPILOT_WORKSPACE,
// CLAUDE_CODE_ENTRYPOINT), so every other host — VS Code running the server as
// a native MCP stdio child, JetBrains, Zed, plain terminals — fell through to
// "unknown". This widens detection to the stable signals each host actually
// sets, ordered most-specific first, and stays a pure function of the env so it
// is exhaustively unit-testable.

export type Editor =
  | 'claude'
  | 'cursor'
  | 'windsurf'
  | 'copilot'
  | 'vscode'
  | 'jetbrains'
  | 'zed'
  | 'unknown';

type Env = Record<string, string | undefined>;

/**
 * Best-effort host detection. Order matters: forks of VS Code (Cursor,
 * Windsurf) also set TERM_PROGRAM=vscode, so their fork-specific signals are
 * checked BEFORE the generic vscode fallback.
 */
export function detectEditor(env: Env = process.env): Editor {
  const has = (k: string) => typeof env[k] === 'string' && env[k] !== '';

  // ── Claude Code ─────────────────────────────────────────────────────────
  // CLAUDE_CODE_ENTRYPOINT is the long-standing signal; CLAUDECODE=1 is set by
  // newer builds. Either identifies the Claude Code host.
  if (has('CLAUDE_CODE_ENTRYPOINT') || env.CLAUDECODE === '1') return 'claude';

  // ── VS Code forks (must precede the generic vscode check) ────────────────
  if (has('CURSOR_TRACE_ID') || env.TERM_PROGRAM === 'cursor') return 'cursor';
  if (has('WINDSURF_SESSION_ID') || env.TERM_PROGRAM === 'windsurf') return 'windsurf';

  // ── GitHub Copilot (agent workspace) ─────────────────────────────────────
  if (has('GITHUB_COPILOT_WORKSPACE') || has('COPILOT_AGENT_ID')) return 'copilot';

  // ── Zed ──────────────────────────────────────────────────────────────────
  if (env.TERM_PROGRAM === 'zed' || has('ZED_TERM')) return 'zed';

  // ── JetBrains (IntelliJ/PyCharm/GoLand/… integrated terminal) ────────────
  if (
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
    has('__INTELLIJ_COMMAND_HISTFILE__') ||
    has('IDEA_INITIAL_DIRECTORY')
  ) {
    return 'jetbrains';
  }

  // ── VS Code (generic — after the forks above) ────────────────────────────
  // TERM_PROGRAM=vscode covers the integrated terminal; the macOS bundle id
  // and VSCODE_* handshake vars cover the native MCP stdio child (no terminal).
  if (
    env.TERM_PROGRAM === 'vscode' ||
    has('VSCODE_PID') ||
    has('VSCODE_CWD') ||
    has('VSCODE_IPC_HOOK') ||
    has('VSCODE_IPC_HOOK_CLI') ||
    has('VSCODE_GIT_IPC_HANDLE') ||
    isVSCodeBundle(env.__CFBundleIdentifier)
  ) {
    return 'vscode';
  }

  return 'unknown';
}

/** macOS sets __CFBundleIdentifier to the launching app's bundle id. */
function isVSCodeBundle(bundle: string | undefined): boolean {
  if (!bundle) return false;
  return (
    bundle === 'com.microsoft.VSCode' ||
    bundle === 'com.microsoft.VSCodeInsiders' ||
    bundle === 'com.visualstudio.code.oss' ||
    bundle.startsWith('com.microsoft.VSCode')
  );
}
