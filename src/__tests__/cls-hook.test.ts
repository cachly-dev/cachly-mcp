/**
 * CLS post-commit hook builder — robustness regression tests.
 *
 * The v1 hook interpolated the commit message into a `node -e "... '$MSG' ..."`
 * JS string, so any apostrophe broke the script and the hook silently ingested
 * nothing. These tests lock in the v2 contract: commit data flows through env
 * vars (never JS source) and the payload reaches the CLI via execFileSync.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClsPostCommitHook, installClsPostCommitHook, CLS_HOOK_VERSION } from '../cls-hook.js';

describe('buildClsPostCommitHook', () => {
  it('embeds the instance id and version marker', () => {
    const hook = buildClsPostCommitHook('inst-123');
    expect(hook).toContain('export CACHLY_BRAIN_INSTANCE_ID="inst-123"');
    expect(hook).toContain(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`);
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('embeds NO API key (v3): .git/hooks/post-commit lies inside the project folder', () => {
    expect(CLS_HOOK_VERSION).toBe('v3');
    expect(buildClsPostCommitHook('i')).not.toContain('CACHLY_JWT');
    // a caller still passing a key (older code, other tools) must not get it written
    expect(buildClsPostCommitHook('i', 'cky_live_abc')).not.toContain('cky_live_abc');
    expect(buildClsPostCommitHook('i', 'cky_live_abc')).not.toContain('CACHLY_JWT');
  });

  it('passes commit data via env vars, never interpolated into JS source', () => {
    const hook = buildClsPostCommitHook('i');
    // The node program must read from process.env, not from a "'$MSG'" literal.
    expect(hook).toContain('process.env.CLS_MSG');
    expect(hook).toContain('process.env.CLS_SHA');
    expect(hook).not.toContain("'$MSG'");
    expect(hook).not.toContain("'$SHA'");
    expect(hook).not.toContain("'$FILES'");
  });

  it('invokes the CLI via execFileSync (no shell re-parsing of the payload)', () => {
    const hook = buildClsPostCommitHook('i');
    expect(hook).toContain('execFileSync');
    expect(hook).toContain("'cls-ingest'");
    expect(hook).not.toContain('execSync'); // shell-based exec is the unsafe path
  });

  it('does not mangle the message with tr (no apostrophe-breaking transform)', () => {
    const hook = buildClsPostCommitHook('i');
    // v1 did `tr '"' "'"` which corrupted messages — must be gone.
    expect(hook).not.toContain(`tr '"'`);
  });
});

describe('installClsPostCommitHook (v3: kein Schluessel im Projekt)', () => {
  const ordner: string[] = [];
  afterEach(() => { for (const o of ordner.splice(0)) rmSync(o, { recursive: true, force: true }); });
  const projekt = () => {
    const p = mkdtempSync(join(tmpdir(), 'cachly-cls-'));
    ordner.push(p);
    mkdirSync(join(p, '.git', 'hooks'), { recursive: true });
    return p;
  };
  const V2_MIT_SCHLUESSEL = [
    '#!/bin/sh',
    '# cachly CLS — Continuous Learning Stream v2',
    'export CACHLY_BRAIN_INSTANCE_ID="i"',
    'export CACHLY_JWT="cky_live_geheim"',
    'exit 0',
    '',
  ].join('\n');

  it('legt den Hook ohne Schluessel an, auch wenn der Aufrufer einen uebergibt', async () => {
    const p = projekt();
    expect(await installClsPostCommitHook(p, 'i', 'cky_live_geheim')).toBe('written');
    const hook = readFileSync(join(p, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).not.toContain('cky_live_geheim');
    expect(hook).not.toContain('CACHLY_JWT');
  });

  it('ersetzt einen alten v2-Block MIT Schluessel beim naechsten init/setup', async () => {
    const p = projekt();
    writeFileSync(join(p, '.git', 'hooks', 'post-commit'), V2_MIT_SCHLUESSEL);
    expect(await installClsPostCommitHook(p, 'i')).toBe('upgraded');
    const hook = readFileSync(join(p, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).not.toContain('cky_live_geheim');
    expect(hook).toContain('Continuous Learning Stream v3');
  });
});
