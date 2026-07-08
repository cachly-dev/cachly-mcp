// Ambient Recall (Phase 4 Ausbau) — the net-token ledger.
//
// Roadmap §6.2: the whole feature is only honest if injected tokens (cost, paid
// now) are weighed against prevented tokens (a wrong path a lesson averted).
// This module persists per-turn records as JSONL (~/.cachly/ambient-ledger.jsonl)
// so `ambient-stats` can show the NET number — even when it is negative — and
// the CLI can auto-backoff (§6.3 guardrail 3) when the recent window is net-red.
//
// Prevented-credit in v1 is agent-reported: the injected context carries a tiny
// footer inviting the agent to run `ambient-credit <tokens>` when a recalled
// lesson actually changed its path. Self-reported ≠ perfect, but it is the only
// client-side signal that exists before the server-side dashboard (v2) — and it
// is what makes auto-backoff meaningful instead of permanently red.
//
// Everything here is best-effort: a broken ledger must never break a hook.

import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TurnRecord } from './ambient-recall.js';

export interface LedgerEntry extends TurnRecord {
  /** ISO timestamp of the turn. */
  ts: string;
  /** Hook event (SessionStart/UserPromptSubmit/PreToolUse) or 'credit'. */
  event: string;
  /** Optional free-text note (e.g. what the credit was for). */
  note?: string;
}

/** Default ledger location; overridable for tests via explicit path args. */
export function defaultLedgerPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return resolve(home, '.cachly', 'ambient-ledger.jsonl');
}

/** One JSONL line for an entry. Pure. */
export function serializeEntry(e: LedgerEntry): string {
  return JSON.stringify({
    ts: e.ts,
    event: e.event,
    injected: Math.max(0, Math.round(e.injected)),
    prevented: Math.max(0, Math.round(e.prevented)),
    ...(e.note ? { note: e.note.slice(0, 200) } : {}),
  });
}

/** Parse ledger text into entries, silently skipping corrupt lines. Pure. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as Partial<LedgerEntry>;
      if (typeof e !== 'object' || e === null) continue;
      const injected = Number(e.injected);
      const prevented = Number(e.prevented);
      if (!Number.isFinite(injected) || !Number.isFinite(prevented)) continue;
      out.push({
        ts: typeof e.ts === 'string' ? e.ts : '',
        event: typeof e.event === 'string' ? e.event : 'unknown',
        injected: Math.max(0, injected),
        prevented: Math.max(0, prevented),
        ...(typeof e.note === 'string' ? { note: e.note } : {}),
      });
    } catch {
      // corrupt line (partial write, manual edit) → skip, never throw
    }
  }
  return out;
}

// Rotation keeps the ledger bounded: hooks run on every prompt, and an
// unbounded append-only file would eventually slow every turn down.
const MAX_LEDGER_BYTES = 256 * 1024;
const KEEP_LINES_ON_ROTATE = 400;

/** Append an entry; auto-creates the directory, auto-rotates. Never throws. */
export async function appendLedgerEntry(entry: LedgerEntry, path = defaultLedgerPath()): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, serializeEntry(entry) + '\n', 'utf-8');

    const text = await readFile(path, 'utf-8');
    if (Buffer.byteLength(text, 'utf-8') > MAX_LEDGER_BYTES) {
      const lines = text.split('\n').filter(Boolean);
      const kept = lines.slice(-KEEP_LINES_ON_ROTATE).join('\n') + '\n';
      // Write-then-rename so a crash mid-rotation never truncates to nothing.
      const tmp = path + '.tmp';
      await writeFile(tmp, kept, 'utf-8');
      await rename(tmp, path);
    }
  } catch {
    // Ledger is telemetry — never let it break a hook or a commit.
  }
}

/** Read all entries; missing/corrupt file → []. Never throws. */
export async function readLedger(path = defaultLedgerPath()): Promise<LedgerEntry[]> {
  try {
    return parseLedger(await readFile(path, 'utf-8'));
  } catch {
    return [];
  }
}
