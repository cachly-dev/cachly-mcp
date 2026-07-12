import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkNodeVersion,
  checkCredential,
  checkApiReachable,
  checkAuthAccepted,
  checkInstance,
  inspectAmbientHooks,
  checkHooks,
  checkLedger,
  renderDoctorReport,
  doctorExitCode,
  type DoctorCheck,
} from '../doctor.js';
import { AMBIENT_HOOK_VERSION } from '../ambient-hooks.js';

const okFetch = (status = 200) => (async () => ({ ok: status < 400, status })) as never;
const deadFetch = (async () => {
  throw new Error('ECONNREFUSED');
}) as never;

describe('runtime + credential checks', () => {
  it('accepts a current node, rejects an ancient one with a hint', () => {
    expect(checkNodeVersion('v20.11.0').status).toBe('ok');
    const old = checkNodeVersion('v16.20.0');
    expect(old.status).toBe('fail');
    expect(old.hint).toContain('Node 18+');
  });

  it('flags a missing credential as fail with the autopilot hint', () => {
    const c = checkCredential('');
    expect(c.status).toBe('fail');
    expect(c.hint).toContain('autopilot');
  });

  it('recognises cky_ keys and JWTs; warns on garbage', () => {
    expect(checkCredential('cky_live_abc').status).toBe('ok');
    expect(checkCredential('aaa.bbb.ccc').status).toBe('ok');
    expect(checkCredential('not-a-key').status).toBe('warn');
  });
});

describe('API + auth checks', () => {
  it('ok when /health answers 200, fail when unreachable', async () => {
    expect((await checkApiReachable('https://api.x', okFetch())).status).toBe('ok');
    expect((await checkApiReachable('https://api.x', deadFetch)).status).toBe('fail');
  });

  it('fail with rotate hint on 401, ok on 200, skip without credential', async () => {
    expect((await checkAuthAccepted('https://api.x', 'cky_a', okFetch())).status).toBe('ok');
    const rejected = await checkAuthAccepted('https://api.x', 'cky_a', okFetch(401));
    expect(rejected.status).toBe('fail');
    expect(rejected.hint).toContain('expired or revoked');
    expect((await checkAuthAccepted('https://api.x', '', okFetch())).status).toBe('fail');
  });
});

describe('instance check', () => {
  it('ok on a UUID, warn on empty or junk', () => {
    expect(checkInstance('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0').status).toBe('ok');
    expect(checkInstance(undefined).status).toBe('warn');
    expect(checkInstance('my-brain').status).toBe('warn');
  });
});

describe('hook inspection (real filesystem)', () => {
  const writeSettings = (dir: string, command: string) => {
    mkdirSync(join(dir, '.claude/hooks'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
          PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command }] }],
          Stop: [{ hooks: [{ type: 'command', command }] }],
        },
      }),
    );
  };

  it('reports not-installed for a bare project (warn + init hint)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const c = checkHooks(inspectAmbientHooks(dir));
    expect(c.status).toBe('warn');
    expect(c.hint).toContain('init');
  });

  it('all green for a current v3 install (portable $CLAUDE_PROJECT_DIR command)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const script = join(dir, '.claude/hooks/cachly-ambient-session-start.mjs');
    writeSettings(dir, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-session-start.mjs"`);
    writeFileSync(script, `// cachly Ambient Recall — SessionStart ${AMBIENT_HOOK_VERSION}\n`);
    const c = checkHooks(inspectAmbientHooks(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain(AMBIENT_HOOK_VERSION);
  });

  it('fail when settings wire a script that does not exist on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    writeSettings(dir, `node "${join(dir, '.claude/hooks/cachly-ambient-session-start.mjs')}"`);
    const c = checkHooks(inspectAmbientHooks(dir));
    expect(c.status).toBe('fail');
    expect(c.hint).toContain('init');
  });

  it('warn on a stale v2 shell install (Windows-dead) with upgrade hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const script = join(dir, '.claude/hooks/cachly-ambient-session-start.sh');
    writeSettings(dir, script); // v2 wired the bare script path
    writeFileSync(script, '#!/bin/sh\n# cachly Ambient Recall — SessionStart v2\n');
    const c = checkHooks(inspectAmbientHooks(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('older version');
  });

  it('survives corrupt settings.json (reports not installed, never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude/settings.json'), '{not json');
    expect(checkHooks(inspectAmbientHooks(dir)).status).toBe('warn');
  });
});

describe('ledger check + report rendering', () => {
  it('empty ledger is ok; net-negative window warns about backoff', () => {
    expect(checkLedger([], '/x/ledger.jsonl').status).toBe('ok');
    const negative = Array.from({ length: 10 }, () => ({ injected: 100, prevented: 0 }));
    const c = checkLedger(negative, '/x/ledger.jsonl');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('backoff');
  });

  it('renders hints only for non-ok checks and summarises fails', () => {
    const checks: DoctorCheck[] = [
      { name: 'Node.js', status: 'ok', detail: 'v20' },
      { name: 'Credential', status: 'fail', detail: 'missing', hint: 'run autopilot' },
      { name: 'Hooks', status: 'warn', detail: 'stale', hint: 'run init' },
    ];
    const report = renderDoctorReport(checks);
    expect(report).toContain('✅ Node.js');
    expect(report).toContain('❌ Credential');
    expect(report).toContain('↳ run autopilot');
    expect(report).toContain('1 problem to fix, 1 warning');
    expect(doctorExitCode(checks)).toBe(1);
  });

  it('exit code stays 0 on warnings only (CI-safe)', () => {
    expect(doctorExitCode([{ name: 'Hooks', status: 'warn', detail: 'x' }])).toBe(0);
    expect(doctorExitCode([{ name: 'Hooks', status: 'ok', detail: 'x' }])).toBe(0);
  });
});
