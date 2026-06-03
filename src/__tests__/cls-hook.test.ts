/**
 * CLS post-commit hook builder — robustness regression tests.
 *
 * The v1 hook interpolated the commit message into a `node -e "... '$MSG' ..."`
 * JS string, so any apostrophe broke the script and the hook silently ingested
 * nothing. These tests lock in the v2 contract: commit data flows through env
 * vars (never JS source) and the payload reaches the CLI via execFileSync.
 */

import { describe, it, expect } from 'vitest';
import { buildClsPostCommitHook, CLS_HOOK_VERSION } from '../cls-hook.js';

describe('buildClsPostCommitHook', () => {
  it('embeds the instance id and version marker', () => {
    const hook = buildClsPostCommitHook('inst-123');
    expect(hook).toContain('export CACHLY_BRAIN_INSTANCE_ID="inst-123"');
    expect(hook).toContain(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`);
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('embeds the API key only when provided', () => {
    expect(buildClsPostCommitHook('i', 'cky_live_abc')).toContain('export CACHLY_JWT="cky_live_abc"');
    expect(buildClsPostCommitHook('i')).not.toContain('CACHLY_JWT');
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
