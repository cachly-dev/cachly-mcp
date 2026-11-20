import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lern-Rueckfrage am Zugende (lern-rueckfrage.ts, Stop-Zweig in ambient-hook.ts).
 *
 * Gegenprobe: in lernRueckfrage die Bedingung `e.stopHookAktiv` entfernen ->
 * "stop_hook_active" wird rot; die Marken-Pruefung entfernen -> "zweimal innerhalb
 * von 20 Minuten" wird rot.
 */

vi.mock('../ambient-ledger.js', async (original) => {
  const echt = await original<typeof import('../ambient-ledger.js')>();
  return { ...echt, appendLedgerEntry: async () => {}, reportLedgerEntry: () => Promise.resolve() };
});

const { hookAntwort } = await import('../ambient-hook.js');
const { hookUmfeld } = await import('../hook-zugang.js');
const { lernRueckfrage, werteProtokollAus } = await import('../lern-rueckfrage.js');

const INSTANZ = '11111111-2222-3333-4444-555555555555';

const tu = (name: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t_${Math.random()}`, name, input }] } });
const mensch = (t: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
const bearbeiten = (n: number) => Array.from({ length: n }, () => tu('Edit', { file_path: 'a.ts' }));

function protokoll(zeilen: string[]): string {
  const pfad = join(mkdtempSync(join(tmpdir(), 'cachly-lern-proto-')), 'p.jsonl');
  writeFileSync(pfad, zeilen.join('\n'));
  return pfad;
}

interface Opt {
  zeilen: string[];
  env?: Record<string, string>;
  stopAktiv?: boolean;
  heim?: string;
  sitzung?: string;
  fremd?: boolean;
  ohneSchluessel?: boolean;
  letzteAntwort?: string;
}

async function stop(o: Opt) {
  const heim = o.heim ?? mkdtempSync(join(tmpdir(), 'cachly-lern-heim-'));
  const projekt = mkdtempSync(join(tmpdir(), 'cachly-lern-projekt-'));
  const aufrufe: Array<{ url: string; body: string }> = [];
  const antwort = await hookAntwort({
    args: ['Stop', '--plugin'],
    raw: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: o.sitzung ?? 'sitzung-1',
      transcript_path: protokoll(o.zeilen),
      stop_hook_active: o.stopAktiv === true,
      last_assistant_message: o.letzteAntwort ?? 'ok',
      ...(o.fremd ? { timestamp: '2026-11-20T10:00:00Z' } : {}),
    }),
    umfeld: hookUmfeld({
      HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt,
      ...(o.ohneSchluessel ? {} : { CACHLY_JWT: 'cky_test_x', CACHLY_BRAIN_INSTANCE_ID: INSTANZ }),
      ...(o.env ?? {}),
    }),
    apiUrl: 'http://127.0.0.1:9',
    fetchFn: (async (url: string, init?: { body?: string }) => {
      aufrufe.push({ url: String(url), body: String(init?.body ?? '') });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch,
  });
  const events = aufrufe.filter((c) => c.url.endsWith('/telemetry/mcp')).map((c) => JSON.parse(c.body).event as string);
  return { antwort, aufrufe, events, heim };
}

describe('Lern-Rueckfrage am Zugende', () => {
  it('Arbeit ohne Lernaufruf: block mit Aufforderung, Ereignis auto_learn_asked, Schluessel nur im Kopf', async () => {
    const r = await stop({ zeilen: [mensch('baue es'), ...bearbeiten(3)] });
    const j = JSON.parse(r.antwort) as { decision: string; reason: string };
    expect(j.decision).toBe('block');
    expect(j.reason).toContain('learn_from_attempts');
    expect(r.events).toEqual(['auto_learn_asked']);
    expect(r.aufrufe.every((c) => !c.body.includes('cky_test_x'))).toBe(true);
  });

  it('ein git commit zaehlt als echte Arbeit, ein Testlauf ebenso', async () => {
    expect(JSON.parse((await stop({ zeilen: [mensch('x'), tu('Bash', { command: 'git commit -m a' })] })).antwort).decision).toBe('block');
    expect(JSON.parse((await stop({ zeilen: [mensch('x'), tu('Bash', { command: 'npx vitest run' })] })).antwort).decision).toBe('block');
  });

  it('zu wenig Arbeit (2 Aenderungen, nur lesen): keine Frage', async () => {
    expect((await stop({ zeilen: [mensch('x'), ...bearbeiten(2), tu('Read'), tu('Bash', { command: 'ls' })] })).antwort).toBe('');
  });

  it('Lernaufruf lief (beliebiges MCP-Praefix): keine Frage', async () => {
    for (const name of ['mcp__plugin_cachly-brain_cachly__learn_from_attempts', 'mcp__cachly__team_learn', 'auto_learn_session']) {
      const r = await stop({ zeilen: [mensch('x'), ...bearbeiten(4), tu(name)] });
      expect(r.antwort, name).toBe('');
      expect(r.events).toEqual([]);
    }
  });

  it('Arbeit NACH dem Lernaufruf zaehlt neu', async () => {
    const z = [mensch('x'), ...bearbeiten(4), tu('mcp__cachly__learn_from_attempts'), ...bearbeiten(2)];
    expect(werteProtokollAus(z).schreibaufrufe).toBe(2);
    expect((await stop({ zeilen: z })).antwort).toBe('');
    expect(JSON.parse((await stop({ zeilen: [...z, ...bearbeiten(1)] })).antwort).decision).toBe('block');
  });

  it('stop_hook_active: nie zweimal hintereinander blocken', async () => {
    expect((await stop({ zeilen: [mensch('x'), ...bearbeiten(5)], stopAktiv: true })).antwort).toBe('');
  });

  it('CACHLY_AUTO_LERNEN=aus schaltet ab', async () => {
    expect((await stop({ zeilen: [mensch('x'), ...bearbeiten(5)], env: { CACHLY_AUTO_LERNEN: 'aus' } })).antwort).toBe('');
  });

  it('zweimal innerhalb von 20 Minuten: nur die erste Rueckfrage; andere Sitzung wird gefragt', async () => {
    const zeilen = [mensch('x'), ...bearbeiten(3)];
    const heim = mkdtempSync(join(tmpdir(), 'cachly-lern-heim-'));
    expect(JSON.parse((await stop({ zeilen, heim })).antwort).decision).toBe('block');
    expect((await stop({ zeilen: [...zeilen, ...bearbeiten(5)], heim })).antwort).toBe('');
    expect(JSON.parse((await stop({ zeilen, heim, sitzung: 'andere' })).antwort).decision).toBe('block');
  });

  it('nach 20 Minuten wieder, aber nur mit neuer Arbeit', async () => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-lern-heim-'));
    const zeilen = [mensch('x'), ...bearbeiten(3)];
    const t0 = 1_000_000_000_000;
    const eingabe = { sessionId: 's', stopHookAktiv: false, heim, env: {} };
    expect(lernRueckfrage({ ...eingabe, zeilen, jetzt: t0 })).not.toBeNull();
    expect(lernRueckfrage({ ...eingabe, zeilen, jetzt: t0 + 21 * 60_000 })).toBeNull(); // keine neue Arbeit
    expect(lernRueckfrage({ ...eingabe, zeilen: [...zeilen, ...bearbeiten(3)], jetzt: t0 + 21 * 60_000 })).not.toBeNull();
  });

  it('ohne Schluessel: keine Frage und keine Marke', async () => {
    const r = await stop({ zeilen: [mensch('x'), ...bearbeiten(5)], ohneSchluessel: true });
    expect(r.antwort).toBe('');
    expect(existsSync(join(r.heim, '.cachly', 'auto-lernen'))).toBe(false);
  });

  it('fremde Laufzeit (VS Code / Copilot): keine Frage', async () => {
    expect((await stop({ zeilen: [mensch('x'), ...bearbeiten(5)], fremd: true })).antwort).toBe('');
  });

  it('Rueckfall: ohne Rueckfrage speichert die Wortsuche und meldet auto_learn_saved', async () => {
    const r = await stop({
      zeilen: [mensch('x'), ...bearbeiten(1)],
      letzteAntwort: 'Der Fehler war ein falscher Port in der Konfiguration; ich habe ihn behoben und der Test ist jetzt gruen, weil die Variable gesetzt wurde.',
    });
    expect(r.antwort).toBe('');
    expect(r.aufrufe.some((c) => c.url.endsWith('/learn'))).toBe(true);
    expect(r.events).toEqual(['auto_learn_saved']);
  });

  it('keine doppelte Speicherung: Rueckfrage gestellt, die Wortsuche schweigt', async () => {
    const r = await stop({
      zeilen: [mensch('x'), ...bearbeiten(3)],
      letzteAntwort: 'Der Fehler war ein falscher Port in der Konfiguration; ich habe ihn behoben und der Test ist jetzt gruen, weil die Variable gesetzt wurde.',
    });
    expect(JSON.parse(r.antwort).decision).toBe('block');
    expect(r.aufrufe.some((c) => c.url.endsWith('/learn'))).toBe(false);
  });

  it('keine doppelte Speicherung: Lernaufruf im Zug, die Wortsuche schweigt', async () => {
    const r = await stop({
      zeilen: [mensch('x'), ...bearbeiten(3), tu('mcp__cachly__learn_from_attempts')],
      letzteAntwort: 'Der Fehler war ein falscher Port in der Konfiguration; ich habe ihn behoben und der Test ist jetzt gruen, weil die Variable gesetzt wurde.',
    });
    expect(r.antwort).toBe('');
    expect(r.aufrufe.some((c) => c.url.endsWith('/learn'))).toBe(false);
  });

  it('CACHLY_NO_TELEMETRY=1: Frage ja, Ereignis nein', async () => {
    const r = await stop({ zeilen: [mensch('x'), ...bearbeiten(3)], env: { CACHLY_NO_TELEMETRY: '1' } });
    expect(JSON.parse(r.antwort).decision).toBe('block');
    expect(r.events).toEqual([]);
  });
});
