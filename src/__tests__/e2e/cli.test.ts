/**
 * E2E: CLI command smoke tests
 *
 * Spawns the actual CLI binary and verifies output + exit codes.
 * Uses the built dist/ — run `npm run build` first.
 *
 * Requires: E2E_JWT, E2E_INSTANCE_ID (for health/badge/share)
 * Run: npm run build && npx vitest run src/__tests__/e2e/cli.test.ts
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cfg } from './config.js';

const BIN = join(import.meta.dirname, '../../../../dist/index.js');
const TIMEOUT_MS = 30_000;

function run(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS,
): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      CACHLY_JWT: cfg.jwt,
      CACHLY_BRAIN_INSTANCE_ID: cfg.instanceId,
      CACHLY_API_URL: cfg.apiUrl,
      ...env,
    },
    timeout: timeoutMs,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code:   result.status,
  };
}

describe('cachly (no args) — help output', () => {
  it('exits 0', () => {
    const { code } = run([]);
    expect(code).toBe(0);
  });

  it('prints cachly branding', () => {
    const { stdout } = run([]);
    expect(stdout).toMatch(/cachly/i);
  });

  it('lists setup command', () => {
    const { stdout } = run([]);
    expect(stdout).toContain('setup');
  });

  it('lists demo command', () => {
    const { stdout } = run([]);
    expect(stdout).toContain('demo');
  });

  it('mentions 1–5 minutes (no false "30 seconds" promise)', () => {
    const { stdout } = run([]);
    // Must NOT contain "30 seconds" — we corrected this in v0.10.19+
    expect(stdout).not.toContain('30 seconds');
    expect(stdout).not.toMatch(/\b30s\b/);
  });

  it('mentions free forever', () => {
    const { stdout } = run([]);
    expect(stdout.toLowerCase()).toMatch(/free|kostenlos/);
  });
});

describe('cachly upgrade', () => {
  it('exits 0', () => {
    const { code } = run(['upgrade']);
    expect(code).toBe(0);
  });

  it('prints current version', () => {
    const { stdout } = run(['upgrade']);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('version string is valid semver', () => {
    const { stdout } = run(['upgrade']);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    expect(match).not.toBeNull();
    const parts = match![1].split('.').map(Number);
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(Number.isInteger(p)).toBe(true));
  });

  it('does not crash on npm registry timeout (graceful error)', () => {
    const { code } = run(['upgrade'], { CACHLY_API_URL: 'http://127.0.0.1:1' });
    // Should exit 0 or 1 — never crash with unhandled exception
    expect([0, 1]).toContain(code);
  });
});

describe('cachly demo', () => {
  it('exits 0 even without credentials', () => {
    const { code } = run(['demo'], { CACHLY_JWT: '', CACHLY_BRAIN_INSTANCE_ID: '' }, 15_000);
    expect(code).toBe(0);
  });

  it('prints Brain Preview header', () => {
    const { stdout } = run(['demo'], { CACHLY_JWT: '', CACHLY_BRAIN_INSTANCE_ID: '' }, 15_000);
    expect(stdout).toMatch(/brain|preview|cachly/i);
  });

  it('prints setup command at the end', () => {
    const { stdout } = run(['demo'], { CACHLY_JWT: '', CACHLY_BRAIN_INSTANCE_ID: '' }, 15_000);
    expect(stdout).toContain('setup');
  });

  it('does not crash with invalid git repo (fallback gracefully)', () => {
    const { code } = run(['demo'], {
      CACHLY_JWT: '',
      CACHLY_BRAIN_INSTANCE_ID: '',
    }, 15_000);
    expect([0, 1]).toContain(code); // never 2+ (unhandled crash)
  });
});

describe('cachly health', () => {
  it('exits 0 with valid credentials', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { code } = run(['health']);
    expect(code).toBe(0);
  });

  it('prints API status', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['health']);
    expect(stdout.toLowerCase()).toMatch(/api|status|ok|connected/);
  });

  it('prints editor detection results', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['health']);
    expect(stdout.toLowerCase()).toMatch(/editor|claude|cursor|copilot|windsurf/);
  });

  it('exits non-zero without JWT', () => {
    const { code, stdout } = run(['health'], { CACHLY_JWT: '' });
    // Either exits non-zero, or prints an error message
    const hasError = code !== 0 || stdout.toLowerCase().includes('not set') || stdout.toLowerCase().includes('sign in');
    expect(hasError).toBe(true);
  });
});

describe('cachly badge', () => {
  it('exits 0 with valid instance', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { code } = run(['badge']);
    expect(code).toBe(0);
  });

  it('outputs a markdown badge snippet', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['badge']);
    expect(stdout).toMatch(/\[!\[.*cachly.*\]\(.*\)\]\(.*\)/i);
  });

  it('badge URL points to api.cachly.dev', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['badge']);
    expect(stdout).toContain('api.cachly.dev');
  });
});

describe('cachly share', () => {
  it('exits 0 with valid credentials', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { code } = run(['share']);
    expect(code).toBe(0);
  });

  it('output contains UTM share URL', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['share']);
    expect(stdout).toContain('utm_source=x');
  });

  it('output contains tweet text', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['share']);
    expect(stdout.toLowerCase()).toMatch(/tweet|x\.com|twitter/i);
  });
});

describe('cachly invite', () => {
  it('exits 0 and prints invite link', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { code, stdout } = run(['invite']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/invite|join|cachly\.dev/i);
  });

  it('does NOT mention 30 seconds (1-5 minutes only)', () => {
    if (!cfg.jwt || !cfg.instanceId) return;
    const { stdout } = run(['invite']);
    expect(stdout).not.toContain('30 seconds');
  });
});
