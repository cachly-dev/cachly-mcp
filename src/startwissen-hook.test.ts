import { afterEach, describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { STARTER_CORPUS } from './starter-corpus.js';
import {
  LERN_PARALLEL, LERN_VERSUCHE, alsBestand, gitAnfragen, hookImportFuerAuftrag, importiereStartwissen,
  type HookImportUmfeld,
} from './startwissen-hook.js';
import { leseCommits } from './git-lektionen.js';
import { bestandPfad } from './einblendung.js';

const ID = '11111111-2222-3333-4444-555555555555';
afterEach(() => rmSync(bestandPfad(ID), { force: true }));

/*
 * Der Start-Import im Nebenlauf des SessionStart-Hooks (14.10.2026): liest
 * `git log` selbst und schickt je Thema eine Lektion ueber POST /learn. Hier
 * ohne Prozess und ohne Netz — die Gegenstelle ist eine Funktion. Den Weg als
 * echten Prozess pruefen __tests__/erster-prompt.test.ts.
 */

const KOPF = (sha: string, betreff: string, autor = 'Ada') => `COMMIT|||${sha}|||${betreff}|||2026-10-14|||${autor}`;
const LOG = [
  KOPF('a'.repeat(40), 'Fix deploy connection refused: fail2ban banned the deploy channel'),
  'infra/jail.local',
  '',
  KOPF('b'.repeat(40), 'Fix deploy connection refused again after reboot'),
  KOPF('c'.repeat(40), 'Add invoice export'),
  'web/export.ts',
].join('\n');

interface Gegenstelle {
  holen: typeof fetch;
  gelernt: Array<Record<string, unknown>>;
  aufrufe: string[];
}

/**
 * export: Antworten nacheinander (die letzte bleibt). learn: Status nacheinander je Thema (sonst 200).
 */
function gegenstelle(exportAntworten: Array<{ status: number; body?: unknown }>, lernStatus: Record<string, number[]> = {}): Gegenstelle {
  const g: Gegenstelle = { gelernt: [], aufrufe: [], holen: undefined as unknown as typeof fetch };
  let exportNr = 0;
  g.holen = (async (url: string | URL, init?: RequestInit) => {
    const pfad = new URL(String(url)).pathname;
    g.aufrufe.push(`${init?.method ?? 'GET'} ${pfad}`);
    if (pfad.endsWith('/export')) {
      const a = exportAntworten[Math.min(exportNr++, exportAntworten.length - 1)]!;
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
    }
    if (pfad.endsWith('/learn')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const folge = lernStatus[String(body.topic)] ?? [];
      const status = folge.length ? folge.shift()! : 200;
      if (status === 200) g.gelernt.push(body);
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return g;
}

const LEER = { status: 200, body: { lessons: [] } };

function umfeld(g: Gegenstelle, ueber: Partial<HookImportUmfeld> = {}): HookImportUmfeld {
  return {
    cfg: { apiUrl: 'http://api.test', jwt: 'cky_trial_x', instanceId: ID },
    projekt: '/home/ada/projekt',
    env: { HOME: '/home/ada' },
    fetchFn: g.holen,
    gitWurzel: async () => '/home/ada/projekt',
    gitLog: () => LOG,
    schlafen: async () => {},
    ...ueber,
  };
}

describe('gitAnfragen: dieselben Regeln wie brain_from_git', () => {
  it('je Thema eine Anfrage, die neueste gewinnt, als Import gekennzeichnet', () => {
    const a = gitAnfragen(leseCommits(LOG));
    expect(a.map((x) => x.topic)).toEqual(['fix:deploy-connection-refused', 'feat:invoice-export']);
    expect(a[0]).toMatchObject({
      outcome: 'success',
      what_worked: 'Fix deploy connection refused: fail2ban banned the deploy channel',
      context: 'git:aaaaaaaa by Ada on 2026-10-14',
      commands: ['git show aaaaaaaa'],
      file_paths: ['infra/jail.local'],
      source: 'brain_from_git',
      author: 'Ada',
    });
    expect(a[0]!.tags).toEqual(['brain_from_git', 'fix', 'git-history']);
  });

  it('ein Geheimnis im Betreff verlaesst den Rechner nicht', () => {
    const log = KOPF('d'.repeat(40), 'Fix auth: rotate key ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const [a] = gitAnfragen(leseCommits(log));
    expect(a!.what_worked).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('importiereStartwissen', () => {
  it('Git-Repo, leeres Brain: je Thema ein /learn, danach frischer Bestand', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g));
    expect(e).toEqual({ art: 'git', lektionen: 2, gesendet: 2 });
    expect(g.gelernt.map((l) => l.topic).sort()).toEqual(['feat:invoice-export', 'fix:deploy-connection-refused']);
    // Erst nachsehen (leer?), dann lernen, dann den Bestand neu holen.
    expect(g.aufrufe[0]).toMatch(/GET .*\/export$/);
    expect(g.aufrufe.at(-1)).toMatch(/GET .*\/export$/);
    expect(hookImportFuerAuftrag(e)).toEqual({ art: 'git', lektionen: 2 });
  });

  it('Vorab-Bestand: die Lektionen liegen auf der Platte, bevor die Instanz laeuft', async () => {
    let beimErstenLernen: number | null = null;
    const g = gegenstelle([{ status: 200, body: { lessons: [], note: 'instance is not running' } }, LEER]);
    const innen = g.holen;
    const holen = (async (url: string | URL, init?: RequestInit) => {
      if (beimErstenLernen === null && String(url).endsWith('/learn')) {
        beimErstenLernen = JSON.parse(readFileSync(bestandPfad(ID), 'utf8')).lessons.length;
      }
      return innen(url, init);
    }) as typeof fetch;
    await importiereStartwissen(umfeld(g, { fetchFn: holen }));
    expect(beimErstenLernen).toBe(2);
  });

  it('alsBestand: die Form von /export, mit dem Vertrauen der API', () => {
    const [git] = alsBestand(gitAnfragen(leseCommits(LOG)), new Date('2026-10-14T00:00:00Z'));
    expect(git).toMatchObject({ topic: 'fix:deploy-connection-refused', confidence: 0.55, recall_count: 0, ts: '2026-10-14T00:00:00.000Z' });
    const [vorrat] = alsBestand([{ ...gitAnfragen(leseCommits(LOG))[0]!, source: 'starter', severity: undefined }]);
    expect(vorrat).toMatchObject({ confidence: 0.9, severity: 'major' });
  });

  it('startende Instanz (200 mit note) und 503: wartet, bis sie laeuft', async () => {
    const g = gegenstelle([
      { status: 200, body: { lessons: [], note: 'instance is not running — nothing could be read' } },
      { status: 503 },
      LEER,
    ]);
    const e = await importiereStartwissen(umfeld(g));
    expect(e).toMatchObject({ art: 'git', gesendet: 2 });
    expect(g.aufrufe.filter((a) => a.endsWith('/export')).length).toBe(4); // 3 x warten + 1 x Bestand
  });

  it('Instanz kommt nie: nicht-bereit, nichts gesendet, der Server importiert selbst', async () => {
    let uhr = 0;
    const g = gegenstelle([{ status: 200, body: { lessons: [], note: 'not running' } }]);
    const e = await importiereStartwissen(umfeld(g, { jetzt: () => uhr, schlafen: async (ms) => { uhr += ms; }, bereitFristMs: 5000 }));
    expect(e.art).toBe('nicht-bereit');
    expect(g.gelernt).toEqual([]);
    expect(hookImportFuerAuftrag(e)).toBeUndefined();
  });

  it('Brain hat schon Lektionen: nichts senden', async () => {
    const g = gegenstelle([{ status: 200, body: { lessons: ['{"topic":"x"}'] } }]);
    expect((await importiereStartwissen(umfeld(g))).art).toBe('hat-lektionen');
    expect(g.aufrufe.some((a) => a.startsWith('POST'))).toBe(false);
    // Auf der Platte liegt dann der Stand des Brains, nicht der vorab gebaute.
    const datei = JSON.parse(readFileSync(bestandPfad(ID), 'utf8'));
    expect(datei.lessons).toEqual([{ topic: 'x' }]);
    expect(datei.vorab).toBeUndefined();
  });

  /*
   * 14.10.2026: Bis der Import fertig ist, ergaenzt der Vorab-Bestand jeden
   * halben Stand vom Server (einblendung.ts schreibeBestand). Danach muss er
   * enden, sonst zeigt die Einblendung Lektionen, die die API abgelehnt hat.
   */
  it('nach dem Import gilt der Stand des Servers allein: der Vorab-Bestand endet', async () => {
    const eine = { status: 200, body: { lessons: [JSON.stringify({ topic: 'fix:deploy-connection-refused', what_worked: 'x' })] } };
    const g = gegenstelle([LEER, eine], { 'feat:invoice-export': [400] });
    expect(await importiereStartwissen(umfeld(g))).toMatchObject({ gesendet: 1 });
    const datei = JSON.parse(readFileSync(bestandPfad(ID), 'utf8'));
    expect(datei.lessons.map((l: { topic: string }) => l.topic)).toEqual(['fix:deploy-connection-refused']);
    expect(datei.vorab).toBeUndefined();
  });

  it('Instanz kommt nie: der Vorab-Bestand bleibt, der Server importiert dieselben Themen selbst', async () => {
    let uhr = 0;
    const g = gegenstelle([{ status: 200, body: { lessons: [], note: 'not running' } }]);
    await importiereStartwissen(umfeld(g, { jetzt: () => uhr, schlafen: async (ms) => { uhr += ms; }, bereitFristMs: 5000 }));
    expect(JSON.parse(readFileSync(bestandPfad(ID), 'utf8')).vorab.length).toBe(2);
  });

  it('409 (Instanz startet noch) wird wiederholt, 400 nicht', async () => {
    const g = gegenstelle([LEER], {
      'fix:deploy-connection-refused': [409, 200],
      'feat:invoice-export': [400],
    });
    const e = await importiereStartwissen(umfeld(g));
    expect(e).toEqual({ art: 'git', lektionen: 2, gesendet: 1 });
    expect(g.aufrufe.filter((a) => a.startsWith('POST')).length).toBe(3);
  });

  it('hoechstens LERN_VERSUCHE je Lektion', async () => {
    const g = gegenstelle([LEER], { 'feat:invoice-export': Array(10).fill(503) });
    await importiereStartwissen(umfeld(g));
    const posts = g.aufrufe.filter((a) => a.startsWith('POST')).length;
    expect(posts).toBe(1 + LERN_VERSUCHE);
  });

  it(`hoechstens ${LERN_PARALLEL} Anfragen gleichzeitig`, async () => {
    const log = Array.from({ length: 12 }, (_, i) => KOPF(String(i).padStart(40, '0'), `Fix thema${i} kaputt`)).join('\n');
    let aktiv = 0;
    let hoechstens = 0;
    const g = gegenstelle([LEER]);
    const innen = g.holen;
    const holen = (async (url: string | URL, init?: RequestInit) => {
      aktiv++;
      hoechstens = Math.max(hoechstens, aktiv);
      await new Promise((r) => setTimeout(r, 2));
      try { return await innen(url, init); } finally { aktiv--; }
    }) as typeof fetch;
    const e = await importiereStartwissen(umfeld(g, { fetchFn: holen, gitLog: () => log }));
    expect(e).toMatchObject({ gesendet: 12 });
    expect(hoechstens).toBeLessThanOrEqual(LERN_PARALLEL);
  });

  it('kein Git: der Startvorrat, als starter gekennzeichnet', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g, { gitWurzel: async () => '' }));
    expect(e).toEqual({ art: 'startvorrat', lektionen: STARTER_CORPUS.length, gesendet: STARTER_CORPUS.length });
    expect(new Set(g.gelernt.map((l) => l.source))).toEqual(new Set(['starter']));
  });

  it('kein Git und CACHLY_STARTVORRAT=false: nichts', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g, { gitWurzel: async () => '', env: { CACHLY_STARTVORRAT: 'false' } }));
    expect(e.art).toBe('kein-repo');
    expect(g.aufrufe).toEqual([]);
  });

  it('Plugin-Ordner ist kein Projekt des Nutzers', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g, { env: { HOME: '/home/ada', CLAUDE_PLUGIN_ROOT: '/home/ada/projekt' } }));
    expect(e).toMatchObject({ art: 'ausgeschlossen', grund: 'plugin-ordner' });
    expect(g.aufrufe).toEqual([]);
  });

  it('CACHLY_STARTWISSEN=false: aus, kein Auftrag', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g, { env: { CACHLY_STARTWISSEN: 'false' } }));
    expect(e.art).toBe('aus');
    expect(g.aufrufe).toEqual([]);
  });

  it('Repo ohne Commit (git log scheitert): nichts zu lernen, der Server versucht es selbst', async () => {
    const g = gegenstelle([LEER]);
    const e = await importiereStartwissen(umfeld(g, { gitLog: () => { throw new Error('does not have any commits yet'); } }));
    expect(e).toEqual({ art: 'git', lektionen: 0, gesendet: 0 });
    expect(hookImportFuerAuftrag(e)).toBeUndefined();
    expect(g.aufrufe).toEqual([]);
  });
});
