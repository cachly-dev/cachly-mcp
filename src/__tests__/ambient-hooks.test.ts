import { describe, it, expect } from 'vitest';
import {
  buildSessionStartHook,
  buildUserPromptSubmitHook,
  buildAmbientSettingsHooks,
  mergeAmbientSettings,
  AMBIENT_HOOK_VERSION,
  AMBIENT_CLI_SUBCOMMAND,
} from '../ambient-hooks.js';

const opts = { instanceId: 'inst-123' };

describe('hook script builders', () => {
  it('start with a shebang and a versioned marker', () => {
    for (const s of [buildSessionStartHook(opts), buildUserPromptSubmitHook(opts)]) {
      expect(s.startsWith('#!/bin/sh')).toBe(true);
      expect(s).toContain(`cachly Ambient Recall`);
      expect(s).toContain(AMBIENT_HOOK_VERSION);
    }
  });

  it('embed the instance id and the correct event', () => {
    expect(buildSessionStartHook(opts)).toContain('CACHLY_BRAIN_INSTANCE_ID="inst-123"');
    expect(buildSessionStartHook(opts)).toContain('CACHLY_HOOK_EVENT="SessionStart"');
    expect(buildUserPromptSubmitHook(opts)).toContain('CACHLY_HOOK_EVENT="UserPromptSubmit"');
  });

  it('embed the JWT only when provided', () => {
    expect(buildSessionStartHook(opts)).not.toContain('CACHLY_JWT');
    expect(buildSessionStartHook({ ...opts, apiKey: 'cky_abc' })).toContain('CACHLY_JWT="cky_abc"');
  });

  it('pipe the payload to the CLI and always exit 0 (graceful)', () => {
    const s = buildUserPromptSubmitHook(opts);
    expect(s).toContain(`cat | npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`);
    expect(s).toContain('|| true');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('never splices untrusted prompt text into the script (payload only via stdin)', () => {
    // The generator takes no prompt input at all — the prompt only ever arrives
    // at runtime on stdin, so a malicious prompt cannot break the script.
    const s = buildUserPromptSubmitHook(opts);
    expect(s.split('\n').some((l) => l.startsWith('cat | '))).toBe(true);
  });

  it('honour a resolved local CLI command (latency for per-prompt hook)', () => {
    const s = buildUserPromptSubmitHook({ ...opts, cliCommand: '/usr/local/bin/cachly-ambient' });
    expect(s).toContain('cat | /usr/local/bin/cachly-ambient 2>/dev/null || true');
    expect(s).not.toContain('npx');
  });
});

describe('settings fragment', () => {
  it('wires both hooks in the Claude Code hooks shape', () => {
    const frag = buildAmbientSettingsHooks({
      sessionStart: '/h/session.sh',
      userPromptSubmit: '/h/prompt.sh',
    });
    expect(frag.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: '/h/session.sh' });
    expect(frag.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: '/h/prompt.sh' });
  });
});

const paths = { sessionStart: '/h/s.sh', userPromptSubmit: '/h/p.sh' };

describe('mergeAmbientSettings', () => {
  it('adds both hooks to empty settings', () => {
    const { settings, changed } = mergeAmbientSettings({}, paths);
    expect(changed).toBe(true);
    expect(settings.hooks!.SessionStart[0].hooks![0].command).toBe('/h/s.sh');
    expect(settings.hooks!.UserPromptSubmit[0].hooks![0].command).toBe('/h/p.sh');
  });

  it('is idempotent — re-merging the same paths does not change or duplicate', () => {
    const first = mergeAmbientSettings({}, paths).settings;
    const { settings, changed } = mergeAmbientSettings(first, paths);
    expect(changed).toBe(false);
    expect(settings.hooks!.SessionStart).toHaveLength(1);
    expect(settings.hooks!.UserPromptSubmit).toHaveLength(1);
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
    expect(settings.hooks!.SessionStart.some((g) => g.hooks!.some((h) => h.command === '/h/s.sh'))).toBe(true);
  });

  it('does not duplicate when our command is already present among foreign entries', () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/foreign.sh' }] },
          { hooks: [{ type: 'command', command: '/h/p.sh' }] },
        ],
      },
    };
    const { settings, changed } = mergeAmbientSettings(existing, paths);
    // SessionStart is newly added (changed), but UserPromptSubmit already has ours → not duplicated
    expect(changed).toBe(true);
    expect(settings.hooks!.UserPromptSubmit).toHaveLength(2);
  });
});
