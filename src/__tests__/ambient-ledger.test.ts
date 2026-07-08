import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serializeEntry,
  parseLedger,
  appendLedgerEntry,
  readLedger,
  type LedgerEntry,
} from '../ambient-ledger.js';
import { netBalance, shouldBackoff } from '../ambient-recall.js';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  ts: '2026-07-08T18:00:00.000Z',
  event: 'UserPromptSubmit',
  injected: 120,
  prevented: 0,
  ...over,
});

describe('serialize / parse round-trip', () => {
  it('round-trips entries through JSONL', () => {
    const text = [serializeEntry(entry()), serializeEntry(entry({ event: 'credit', injected: 0, prevented: 4800, note: 'avoided wrong deploy path' }))].join('\n');
    const parsed = parseLedger(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].injected).toBe(120);
    expect(parsed[1].prevented).toBe(4800);
    expect(parsed[1].note).toBe('avoided wrong deploy path');
  });

  it('skips corrupt lines instead of throwing', () => {
    const text = `${serializeEntry(entry())}\nnot json at all\n{"injected":"NaN-ish"}\n42\n${serializeEntry(entry({ injected: 7 }))}`;
    const parsed = parseLedger(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].injected).toBe(7);
  });

  it('clamps negatives and rounds fractions on write', () => {
    const line = serializeEntry(entry({ injected: -5.7, prevented: 3.4 }));
    const [e] = parseLedger(line);
    expect(e.injected).toBe(0);
    expect(e.prevented).toBe(3);
  });
});

describe('file append / read (never throws)', () => {
  it('creates the directory, appends, and reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cachly-ledger-'));
    const path = join(dir, 'nested', 'ledger.jsonl');
    await appendLedgerEntry(entry(), path);
    await appendLedgerEntry(entry({ event: 'credit', injected: 0, prevented: 900 }), path);
    const entries = await readLedger(path);
    expect(entries).toHaveLength(2);
    expect(netBalance(entries).net).toBe(900 - 120);
  });

  it('returns [] for a missing file', async () => {
    expect(await readLedger('/definitely/not/here.jsonl')).toEqual([]);
  });

  it('rotates an oversized ledger down to a bounded tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cachly-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    // Pre-fill well past the 256KB cap with valid lines (~90 bytes each).
    const line = serializeEntry(entry({ note: 'x'.repeat(60) }));
    await writeFile(path, (line + '\n').repeat(4000), 'utf-8');
    await appendLedgerEntry(entry({ injected: 1 }), path);
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(400);
    // the fresh entry survives rotation (it is the newest line)
    expect(parseLedger(text).some((e) => e.injected === 1)).toBe(true);
  });
});

describe('ledger + auto-backoff integration', () => {
  it('a consistently net-negative window trips shouldBackoff; credits release it', () => {
    const red = Array.from({ length: 10 }, () => entry({ injected: 200, prevented: 0 }));
    expect(shouldBackoff(red)).toBe(true);
    const credited = [...red, entry({ event: 'credit', injected: 0, prevented: 5000 })];
    expect(shouldBackoff(credited)).toBe(false);
  });
});
