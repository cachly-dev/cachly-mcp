import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { milestoneSent, markMilestoneSent } from '../funnel-milestones.js';

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'fm-')), 'funnel-milestones.json');

describe('funnel milestones (persistent once-per-machine guard)', () => {
  it('reports not-sent for a fresh machine, sent after marking', () => {
    const p = tmpPath();
    expect(milestoneSent('first_call_success', p)).toBe(false);
    markMilestoneSent('first_call_success', p);
    expect(milestoneSent('first_call_success', p)).toBe(true);
  });

  it('persists across "process restarts" (re-reads the file)', () => {
    const p = tmpPath();
    markMilestoneSent('first_call_success', p);
    // A brand-new call (simulating a fresh ambient-hook process) still sees it.
    expect(milestoneSent('first_call_success', p)).toBe(true);
  });

  it('is idempotent — re-marking does not duplicate or change the timestamp', () => {
    const p = tmpPath();
    markMilestoneSent('first_call_success', p);
    const first = readFileSync(p, 'utf-8');
    markMilestoneSent('first_call_success', p);
    expect(readFileSync(p, 'utf-8')).toBe(first);
  });

  it('tracks distinct milestones independently', () => {
    const p = tmpPath();
    markMilestoneSent('first_call_success', p);
    expect(milestoneSent('first_call_success', p)).toBe(true);
    expect(milestoneSent('device_flow_completed', p)).toBe(false);
  });

  it('treats a corrupt file as empty (self-heals on next mark)', () => {
    const p = tmpPath();
    writeFileSync(p, '{ not json');
    expect(milestoneSent('first_call_success', p)).toBe(false);
    markMilestoneSent('first_call_success', p);
    expect(milestoneSent('first_call_success', p)).toBe(true);
  });

  it('never throws on an unwritable path (best-effort)', () => {
    // A path whose parent is a file, not a dir → mkdir/write fail internally.
    const f = tmpPath();
    writeFileSync(f, '{}');
    const bad = join(f, 'child', 'milestones.json');
    expect(() => markMilestoneSent('x', bad)).not.toThrow();
    expect(milestoneSent('x', bad)).toBe(false);
  });
});
