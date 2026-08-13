import { describe, it, expect } from 'vitest';
import {
  buildSessionStartHook,
  buildUserPromptSubmitHook,
  buildPreToolUseHook,
  buildStopHook,
  buildAmbientSettingsHooks,
  mergeAmbientSettings,
  AMBIENT_HOOK_VERSION,
  AMBIENT_CLI_SUBCOMMAND,
  PRE_TOOL_USE_MATCHER,
} from '../ambient-hooks.js';

const opts = { instanceId: 'inst-123' };

describe('hook script builders (v3 — cross-platform Node scripts)', () => {
  it('start with a node shebang and a versioned marker', () => {
    for (const s of [
      buildSessionStartHook(opts),
      buildUserPromptSubmitHook(opts),
      buildPreToolUseHook(opts),
      buildStopHook(opts),
    ]) {
      expect(s.startsWith('#!/usr/bin/env node')).toBe(true);
      expect(s).toContain(`cachly Ambient Recall`);
      expect(s).toContain(AMBIENT_HOOK_VERSION);
    }
  });

  it('embed the instance id and the correct event as env assignments', () => {
    expect(buildSessionStartHook(opts)).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'inst-123';");
    expect(buildSessionStartHook(opts)).toContain("process.env.CACHLY_HOOK_EVENT = 'SessionStart';");
    expect(buildUserPromptSubmitHook(opts)).toContain("process.env.CACHLY_HOOK_EVENT = 'UserPromptSubmit';");
    expect(buildPreToolUseHook(opts)).toContain("process.env.CACHLY_HOOK_EVENT = 'PreToolUse';");
    expect(buildStopHook(opts)).toContain("process.env.CACHLY_HOOK_EVENT = 'Stop';");
  });

  it('never embeds the caller-supplied key as a literal (GROW-015) — resolved at run time instead', () => {
    const withoutKey = buildSessionStartHook(opts);
    const withKey = buildSessionStartHook({ ...opts, apiKey: 'cky_abc' });
    expect(withoutKey).not.toContain('cky_abc');
    expect(withKey).not.toContain('cky_abc');
    expect(withKey).toContain('CACHLY_API_KEY');
  });

  it('spawn the CLI with inherited stdin/stdout and always exit 0 (graceful)', () => {
    const s = buildUserPromptSubmitHook(opts);
    expect(s).toContain(`npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`);
    // stdin (hook payload) and stdout (hookSpecificOutput) pass through; stderr dropped.
    expect(s).toContain("stdio: ['inherit', 'inherit', 'ignore']");
    // shell:true resolves npx/npx.cmd on Windows too.
    expect(s).toContain('shell: true');
    expect(s).toContain("child.on('error', () => process.exit(0));");
    expect(s).toContain("child.on('close', () => process.exit(0));");
  });

  it('never splices untrusted prompt text into the script (payload only via stdin)', () => {
    // The generator takes no prompt input at all — the prompt only ever arrives
    // at runtime on stdin, so a malicious prompt cannot break the script.
    const s = buildUserPromptSubmitHook(opts);
    expect(s).not.toContain('prompt_text');
    expect(s).toContain("stdio: ['inherit'");
  });

  it('escapes quotes/backslashes in embedded values (no JS injection)', () => {
    const s = buildSessionStartHook({ instanceId: "in'st\\1" });
    expect(s).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'in\\'st\\\\1';");
  });

  it('honour a resolved local CLI command (latency for per-prompt hook)', () => {
    const s = buildUserPromptSubmitHook({ ...opts, cliCommand: '/usr/local/bin/cachly-ambient' });
    expect(s).toContain("spawn('/usr/local/bin/cachly-ambient'");
    expect(s).not.toContain('npx');
  });
});

const paths = {
  sessionStart: '/h/s.mjs',
  userPromptSubmit: '/h/p.mjs',
  preToolUse: '/h/t.mjs',
  stop: '/h/x.mjs',
};

describe('settings fragment', () => {
  it('wires all four hooks as `node "<script>"` commands with timeouts', () => {
    const frag = buildAmbientSettingsHooks(paths);
    expect(frag.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: 'node "/h/s.mjs"', timeout: 30 });
    expect(frag.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: 'node "/h/p.mjs"', timeout: 10 });
    expect(frag.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'node "/h/t.mjs"', timeout: 10 });
    expect(frag.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'node "/h/x.mjs"', timeout: 60 });
  });

  it('scopes PreToolUse to file-mutating tools via matcher; others unmatched', () => {
    const frag = buildAmbientSettingsHooks(paths);
    expect(frag.PreToolUse[0].matcher).toBe(PRE_TOOL_USE_MATCHER);
    expect(frag.SessionStart[0].matcher).toBeUndefined();
    expect(frag.Stop[0].matcher).toBeUndefined();
  });

  it('omits Ausbau events when their paths are not given (v1 compatibility)', () => {
    const frag = buildAmbientSettingsHooks({ sessionStart: '/h/s.mjs', userPromptSubmit: '/h/p.mjs' });
    expect(frag.PreToolUse).toBeUndefined();
    expect(frag.Stop).toBeUndefined();
  });
});

describe('mergeAmbientSettings', () => {
  it('adds all four hooks to empty settings', () => {
    const { settings, changed } = mergeAmbientSettings({}, paths);
    expect(changed).toBe(true);
    expect(settings.hooks!.SessionStart[0].hooks![0].command).toBe('node "/h/s.mjs"');
    expect(settings.hooks!.UserPromptSubmit[0].hooks![0].command).toBe('node "/h/p.mjs"');
    expect(settings.hooks!.PreToolUse[0].matcher).toBe(PRE_TOOL_USE_MATCHER);
    expect(settings.hooks!.Stop[0].hooks![0].command).toBe('node "/h/x.mjs"');
  });

  it('is idempotent — re-merging the same paths does not change or duplicate', () => {
    const first = mergeAmbientSettings({}, paths).settings;
    const { settings, changed } = mergeAmbientSettings(first, paths);
    expect(changed).toBe(false);
    expect(settings.hooks!.SessionStart).toHaveLength(1);
    expect(settings.hooks!.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks!.PreToolUse).toHaveLength(1);
    expect(settings.hooks!.Stop).toHaveLength(1);
  });

  it('preserves foreign hooks and unrelated settings', () => {
    const existing = {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/other/thing.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: '/keep.sh' }] }],
      },
    };
    const { settings, changed } = mergeAmbientSettings(existing, paths);
    expect(changed).toBe(true);
    expect(settings.model).toBe('opus');
    expect(settings.hooks!.PostToolUse).toEqual(existing.hooks.PostToolUse);
    // foreign SessionStart entry kept, ours appended
    expect(settings.hooks!.SessionStart).toHaveLength(2);
    expect(settings.hooks!.SessionStart.some((g) => g.hooks!.some((h) => h.command === '/other/thing.sh'))).toBe(true);
    expect(settings.hooks!.SessionStart.some((g) => g.hooks!.some((h) => h.command === 'node "/h/s.mjs"'))).toBe(true);
  });

  it('upgrades v1/v2 SHELL-script installs in place: stale ambient entries are replaced', () => {
    // v1/v2 installs wired bare .sh paths (no `node` prefix; v1 had no timeout).
    const v2 = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/old/proj/.claude/hooks/cachly-ambient-session-start.sh' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/foreign.sh' }] },
          { hooks: [{ type: 'command', command: '/old/proj/.claude/hooks/cachly-ambient-prompt-submit.sh', timeout: 10 }] },
        ],
      },
    };
    const { settings, changed } = mergeAmbientSettings(v2, paths);
    expect(changed).toBe(true);
    // old ambient entries gone, exactly one current ambient entry per event, foreign kept
    expect(settings.hooks!.SessionStart).toHaveLength(1);
    expect(settings.hooks!.SessionStart[0].hooks![0].command).toBe('node "/h/s.mjs"');
    expect(settings.hooks!.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks!.UserPromptSubmit.some((g) => g.hooks!.some((h) => h.command === '/foreign.sh'))).toBe(true);
    expect(
      settings.hooks!.UserPromptSubmit.some((g) => g.hooks!.some((h) => h.command?.includes('/old/proj/'))),
    ).toBe(false);
  });
});

describe('portable settings commands (dogfood/committed hooks)', () => {
  it('uses $CLAUDE_PROJECT_DIR paths and stays upgrade-safe vs absolute installs', () => {
    const portable = {
      sessionStart: '$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-session-start.mjs',
      userPromptSubmit: '$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-prompt-submit.mjs',
      preToolUse: '$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-pre-tool.mjs',
      stop: '$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-stop.mjs',
    };
    // A prior ABSOLUTE v2 shell install is replaced (marker match), not duplicated.
    const absolute = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/home/x/.claude/hooks/cachly-ambient-session-start.sh' }] },
        ],
      },
    };
    const { settings, changed } = mergeAmbientSettings(absolute, portable);
    expect(changed).toBe(true);
    expect(settings.hooks!.SessionStart).toHaveLength(1);
    // The env var sits INSIDE the node command's double quotes so the shell
    // expands it at hook time: node "$CLAUDE_PROJECT_DIR/.claude/...".
    expect(settings.hooks!.SessionStart[0].hooks![0].command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-session-start.mjs"',
    );
    // Re-merge is a no-op.
    expect(mergeAmbientSettings(settings, portable).changed).toBe(false);
  });
});
