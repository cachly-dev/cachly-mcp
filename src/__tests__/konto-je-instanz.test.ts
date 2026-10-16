import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerEntry } from '../ambient-ledger.js';

/**
 * Das Netto-Konto zaehlt je Instanz (GROW-017, 16.10.2026).
 *
 * ~/.cachly/ambient-ledger.jsonl ist eine Datei je Rechner. Bis 0.10.206 trug ein
 * Eintrag keine Instanz, `ambient-stats` mischte alle Projekte zu einer Zahl.
 *
 * Gegenprobe: in ambient-hook.ts `instanz: cfg.instanceId` aus dem Eintrag
 * nehmen -> der Hook-Fall wird rot; in serializeEntry das instanz-Feld weglassen
 * -> der Rundweg wird rot.
 */

const geschrieben: LedgerEntry[] = [];
vi.mock('../ambient-ledger.js', async (original) => {
  const echt = await original<typeof import('../ambient-ledger.js')>();
  return {
    ...echt,
    appendLedgerEntry: async (e: LedgerEntry) => { geschrieben.push(e); },
    reportLedgerEntry: () => Promise.resolve(),
  };
});

const { parseLedger, serializeEntry, teileNachInstanz } = await import('../ambient-ledger.js');
const { hookAntwort } = await import('../ambient-hook.js');
const { hookUmfeld } = await import('../hook-zugang.js');

const e = (instanz?: string, injected = 10): LedgerEntry => ({ ts: '2026-10-16T12:00:00.000Z', event: 'UserPromptSubmit', injected, prevented: 0, ...(instanz ? { instanz } : {}) });

describe('Ledger-Eintrag traegt die Instanz', () => {
  it('Rundweg: instanz bleibt erhalten, eine alte Zeile ohne instanz bleibt ohne', () => {
    const text = serializeEntry(e('inst-a')) + '\n' + '{"ts":"2026-10-01T00:00:00Z","event":"credit","injected":0,"prevented":5}\n';
    const [neu, alt] = parseLedger(text);
    expect(neu.instanz).toBe('inst-a');
    expect(alt.instanz).toBeUndefined();
  });

  it('teileNachInstanz: eigene Eintraege, alte ohne Instanz, Zahl der anderen Instanzen', () => {
    const t = teileNachInstanz([e('inst-a', 1), e('inst-b', 2), e(undefined, 3), e('inst-a', 4), e('inst-c', 5)], 'inst-a');
    expect(t.eigene.map((x) => x.injected)).toEqual([1, 4]);
    expect(t.ohneInstanz).toBe(1);
    expect(t.andereInstanzen).toBe(2);
  });

  it('ohne bekannte Instanz zaehlt alles', () => {
    const alle = [e('inst-a'), e(undefined)];
    expect(teileNachInstanz(alle, undefined)).toEqual({ eigene: alle, ohneInstanz: 0, andereInstanzen: 0 });
  });
});

describe('Hook schreibt die Instanz in den Eintrag', () => {
  beforeEach(() => { geschrieben.length = 0; });

  it('UserPromptSubmit mit Einblendung: Eintrag mit der Instanz des Projekts', async () => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-konto-heim-'));
    const projekt = mkdtempSync(join(tmpdir(), 'cachly-konto-projekt-'));
    await hookAntwort({
      args: ['UserPromptSubmit'],
      raw: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: projekt, prompt: 'wie deploye ich die api' }),
      umfeld: hookUmfeld({ HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt, CACHLY_JWT: 'cky_test_x', CACHLY_BRAIN_INSTANCE_ID: 'inst-projekt-a' }),
      apiUrl: 'http://127.0.0.1:9',
      fetchFn: (async () => { throw new Error('kein Netz'); }) as unknown as typeof fetch,
      einblenden: async (_raw, opts) => { opts.onInject?.(42, 'UserPromptSubmit'); return 'eingeblendet'; },
    });
    expect(geschrieben).toHaveLength(1);
    expect(geschrieben[0]).toMatchObject({ injected: 42, instanz: 'inst-projekt-a' });
  });
});
