import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Leeres Brain beim Sitzungsstart (17.11.2026).
 *
 * Aktivierungsprobe in fuenf frischen Brains: Mit dem Plugin blieb das Briefing
 * leer, solange das Brain keine Lektion hatte, und die Git-Historie las nur der
 * MCP-Server ein (beim ersten Start 14 bis 64 s). Der SessionStart-Hook stoesst
 * den Start-Import jetzt selbst an, wenn sein Briefing leer ist.
 *
 * Gegenprobe: in ambient-hook.ts die Bedingung `!out` entfernen -> "Briefing mit
 * Inhalt" wird rot; den ganzen Block entfernen -> "leeres Briefing" wird rot.
 */

vi.mock('../ambient-ledger.js', async (original) => {
  const echt = await original<typeof import('../ambient-ledger.js')>();
  return { ...echt, appendLedgerEntry: async () => {}, reportLedgerEntry: () => Promise.resolve() };
});

const { hookAntwort } = await import('../ambient-hook.js');
const { hookUmfeld } = await import('../hook-zugang.js');
const { STARTWISSEN_IMPORT } = await import('../startwissen-hook.js');

type Start = { cfg: { instanceId: string; jwt: string }; befehl: string[]; zweck?: string };

function lauf(opts: { ereignis: string; briefing: string; env?: Record<string, string>; selbst?: string | null }) {
  const heim = mkdtempSync(join(tmpdir(), 'cachly-leer-heim-'));
  const projekt = mkdtempSync(join(tmpdir(), 'cachly-leer-projekt-'));
  const starts: Start[] = [];
  const antwort = hookAntwort({
    args: [opts.ereignis, '--plugin'],
    raw: JSON.stringify({ hook_event_name: opts.ereignis, session_id: 's', cwd: projekt, prompt: 'fix the failing test', source: 'startup' }),
    umfeld: hookUmfeld({
      HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt,
      CACHLY_JWT: 'cky_test_x', CACHLY_BRAIN_INSTANCE_ID: '11111111-2222-3333-4444-555555555555',
      ...(opts.env ?? {}),
    }),
    apiUrl: 'http://127.0.0.1:9',
    ...(opts.selbst === null ? {} : { selbst: opts.selbst ?? '/plugin/hooks/cachly-ambient-einblendung.mjs' }),
    fetchFn: (async () => { throw new Error('kein Netz'); }) as unknown as typeof fetch,
    einblenden: async () => opts.briefing,
    nebenlauf: (cfg, befehl, o) => { starts.push({ cfg, befehl, zweck: o?.zweck }); return true; },
  });
  return { antwort, starts, projekt };
}

describe('SessionStart mit leerem Brain startet den Start-Import', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leeres Briefing: genau ein Nebenlauf mit Import-Befehl, Projekt und Instanz; die Antwort bleibt leer', async () => {
    const { antwort, starts, projekt } = lauf({ ereignis: 'SessionStart', briefing: '' });
    expect(await antwort).toBe('');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.befehl).toEqual(['/plugin/hooks/cachly-ambient-einblendung.mjs', STARTWISSEN_IMPORT, projekt]);
    expect(starts[0]!.zweck).toBe(STARTWISSEN_IMPORT);
    expect(starts[0]!.cfg.instanceId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('Briefing mit Inhalt: kein Nebenlauf — ein Brain mit Lektionen braucht keinen Import', async () => {
    const { antwort, starts } = lauf({ ereignis: 'SessionStart', briefing: '{"hookSpecificOutput":{"additionalContext":"x"}}' });
    expect(await antwort).not.toBe('');
    expect(starts).toHaveLength(0);
  });

  it('nur beim Sitzungsstart: ein leerer UserPromptSubmit startet nichts', async () => {
    const { starts, antwort } = lauf({ ereignis: 'UserPromptSubmit', briefing: '' });
    await antwort;
    expect(starts).toHaveLength(0);
  });

  it('CACHLY_STARTWISSEN=0 schaltet es ab', async () => {
    const { starts, antwort } = lauf({ ereignis: 'SessionStart', briefing: '', env: { CACHLY_STARTWISSEN: '0' } });
    await antwort;
    expect(starts).toHaveLength(0);
  });

  it('ohne eigenes Skript (selbst) gibt es nichts zu starten', async () => {
    const { starts, antwort } = lauf({ ereignis: 'SessionStart', briefing: '', selbst: null });
    await antwort;
    expect(starts).toHaveLength(0);
  });
});
