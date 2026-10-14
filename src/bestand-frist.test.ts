import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  BESTAND_TTL_JUNG_MS, BESTAND_TTL_KLEIN_MS, BESTAND_TTL_MS, JUNG_FENSTER_MS, KLEIN_LEKTIONEN, bestandFrist,
  bestandPfad, holeBestand, schreibeVorabBestand, type EinblendConfig,
} from './einblendung.js';

/*
 * Befund 12.10.2026 (Probe an einer frischen Installation): Der Hook legte
 * seinen Lektionsbestand zehn Minuten auf der Platte ab. Der erste Treffer
 * speicherte 9 von spaeter 21 Lektionen — der Start-Import braucht 25 s bis
 * 200 s. Frisch holte nur SessionStart. Ein junges Brain zeigte dem Nutzer
 * also bis zu zehn Minuten einen veralteten Bestand.
 */

const MIN = 60_000;

describe('bestandFrist: wie lange ein Bestand als frisch gilt', () => {
  it('Brain im Aufbau (erster Bestand juenger als 5 min): 10 s, der Prompt holt neu', () => {
    expect(bestandFrist(0, 0)).toEqual({ ttlMs: BESTAND_TTL_JUNG_MS, sofort: true });
    expect(bestandFrist(9, 25_000)).toEqual({ ttlMs: BESTAND_TTL_JUNG_MS, sofort: true });
    // Auch ein grosses Brain ist im Aufbau, wenn sein Bestand eben erst entstand.
    expect(bestandFrist(700, MIN)).toEqual({ ttlMs: BESTAND_TTL_JUNG_MS, sofort: true });
    expect(BESTAND_TTL_JUNG_MS).toBe(10_000);
  });

  it('nach 5 min und unter 50 Lektionen: kleines Brain, 60 s, Auffrischen im Nebenlauf', () => {
    expect(bestandFrist(21, JUNG_FENSTER_MS)).toEqual({ ttlMs: BESTAND_TTL_KLEIN_MS, sofort: false });
    expect(bestandFrist(KLEIN_LEKTIONEN - 1, 60 * MIN)).toEqual({ ttlMs: BESTAND_TTL_KLEIN_MS, sofort: false });
  });

  it('gewachsenes Brain (50 und mehr, aelter als 5 min): unveraendert 10 min', () => {
    expect(bestandFrist(KLEIN_LEKTIONEN, JUNG_FENSTER_MS)).toEqual({ ttlMs: BESTAND_TTL_MS, sofort: false });
    expect(bestandFrist(760, 24 * 60 * MIN)).toEqual({ ttlMs: BESTAND_TTL_MS, sofort: false });
    expect(BESTAND_TTL_MS).toBe(10 * MIN);
  });
});

describe('holeBestand: ein junges Brain sieht seine neuen Lektionen', () => {
  let cfg: EinblendConfig;
  let abrufe: number;
  let serverLektionen: Array<{ topic: string; what_worked: string }>;
  const lektionen = (n: number) => Array.from({ length: n }, (_, i) => ({ topic: `fix:thema-${i}`, what_worked: `Behebung ${i}` }));
  const holen = (async () => {
    abrufe++;
    return { ok: true, json: async () => ({ lessons: serverLektionen.map((l) => JSON.stringify(l)) }) };
  }) as unknown as typeof fetch;

  /** Schreibt einen Bestand mit vorgegebenem Alter, so wie ihn ein frueherer Hook-Lauf hinterlassen haette. */
  const lege = (n: number, { alterMs, seitMs }: { alterMs: number; seitMs: number }) => {
    const jetzt = Date.now();
    writeFileSync(bestandPfad(cfg.instanceId), JSON.stringify({ at: jetzt - alterMs, seit: jetzt - seitMs, lessons: lektionen(n) }));
  };

  beforeEach(() => {
    cfg = { apiUrl: 'https://api.test', jwt: 'cky_test', instanceId: `inst-frist-${Math.random().toString(36).slice(2, 10)}` };
    abrufe = 0;
    serverLektionen = lektionen(21);
  });
  afterEach(() => rmSync(bestandPfad(cfg.instanceId), { force: true }));

  it('9 Lektionen auf der Platte, 20 s alt, Brain 40 s alt: der Prompt holt die 21 vom Server', async () => {
    lege(9, { alterMs: 20_000, seitMs: 40_000 });
    const r = await holeBestand(cfg, { fetchFn: holen });

    expect(r.quelle).toBe('server');
    expect(r.lessons.length).toBe(21);
    expect(abrufe).toBe(1);
    // Die Platte hat jetzt den neuen Stand, und `seit` bleibt stehen.
    const datei = JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8'));
    expect(datei.lessons.length).toBe(21);
    expect(Date.now() - datei.seit).toBeGreaterThanOrEqual(39_000);
  });

  it('innerhalb von 10 s: kein Abruf, Platte (0 ms)', async () => {
    lege(9, { alterMs: 5_000, seitMs: 40_000 });
    const r = await holeBestand(cfg, { fetchFn: holen });
    expect(r.quelle).toBe('platte');
    expect(r.lessons.length).toBe(9);
    expect(abrufe).toBe(0);
  });

  it('Server nicht erreichbar: der alte Stand bleibt, der Prompt scheitert nicht', async () => {
    lege(9, { alterMs: 30_000, seitMs: 60_000 });
    const kaputt = (async () => { abrufe++; throw new Error('Netz weg'); }) as unknown as typeof fetch;
    const r = await holeBestand(cfg, { fetchFn: kaputt });
    expect(r.quelle).toBe('platte-alt');
    expect(r.lessons.length).toBe(9);
  });

  it('Server haengt: der Prompt wartet nicht laenger als 2 s', async () => {
    lege(9, { alterMs: 30_000, seitMs: 60_000 });
    const haengt = ((_u: string, init?: RequestInit) => new Promise((_ok, nein) => {
      init?.signal?.addEventListener('abort', () => nein(new Error('abgebrochen')));
    })) as unknown as typeof fetch;
    const start = Date.now();
    const r = await holeBestand(cfg, { fetchFn: haengt });
    expect(r.quelle).toBe('platte-alt');
    expect(Date.now() - start).toBeLessThan(3500);
  }, 10_000);

  it('gewachsenes Brain (700 Lektionen, 1 h alt) bleibt bei 10 min: 5 min alter Bestand wird NICHT neu geholt', async () => {
    lege(700, { alterMs: 5 * MIN, seitMs: 60 * MIN });
    const r = await holeBestand(cfg, { fetchFn: holen });
    expect(r.quelle).toBe('platte');
    expect(abrufe).toBe(0);
  });

  it('kleines Brain (21 Lektionen, 1 h alt), Bestand 2 min alt: alter Stand sofort, Auffrischen im Nebenlauf — kein Warten', async () => {
    lege(21, { alterMs: 2 * MIN, seitMs: 60 * MIN });
    const r = await holeBestand(cfg, { fetchFn: holen });
    expect(r.quelle).toBe('platte-alt');
    expect(r.lessons.length).toBe(21);
    expect(abrufe).toBe(0);
  });

  it('alte Datei ohne `seit` (vor dem 12.10.): gilt als im Aufbau nur, wenn auch `at` jung ist', async () => {
    writeFileSync(bestandPfad(cfg.instanceId), JSON.stringify({ at: Date.now() - 20 * MIN, lessons: lektionen(30) }));
    const r = await holeBestand(cfg, { fetchFn: holen });
    // Alt: kein Aufbau, kleines Brain, 20 min > 60 s -> alter Stand, kein Warten.
    expect(r.quelle).toBe('platte-alt');
    expect(abrufe).toBe(0);
  });

  it('SessionStart (force) holt immer und behaelt `seit` des ersten Bestands', async () => {
    lege(9, { alterMs: 1000, seitMs: 4 * MIN });
    await holeBestand(cfg, { fetchFn: holen, force: true });
    const datei = JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8'));
    expect(datei.lessons.length).toBe(21);
    expect(Date.now() - datei.seit).toBeGreaterThanOrEqual(4 * MIN - 1000);
  });

  it('der erste Bestand einer Instanz setzt `seit` auf jetzt', async () => {
    expect(existsSync(bestandPfad(cfg.instanceId))).toBe(false);
    await holeBestand(cfg, { fetchFn: holen });
    const datei = JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8'));
    expect(Date.now() - datei.seit).toBeLessThan(5000);
    expect(datei.at).toBe(datei.seit);
  });

  /*
   * 14.10.2026: /export einer startenden oder schlafenden Instanz antwortet 200
   * mit leerer Liste und `note` (export_handler.go). Das ist kein leeres Brain.
   * Bis dahin ueberschrieb SessionStart (force) damit jeden Bestand auf der
   * Platte, auch den Vorab-Bestand des Start-Imports.
   */
  const startet = (async () => {
    abrufe++;
    return { ok: true, json: async () => ({ lessons: [], note: 'instance is not running — nothing could be read' }) };
  }) as unknown as typeof fetch;

  it('Instanz laeuft nicht (leer + note): der Bestand auf der Platte bleibt', async () => {
    lege(9, { alterMs: 1000, seitMs: 1000 });
    const r = await holeBestand(cfg, { fetchFn: startet, force: true });
    expect(r.quelle).toBe('platte-alt');
    expect(r.lessons.length).toBe(9);
    expect(JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8')).lessons.length).toBe(9);
  });

  it('ein laufendes, leeres Brain (leer, OHNE note) ist leer — wie bisher', async () => {
    lege(9, { alterMs: 1000, seitMs: 1000 });
    serverLektionen = [];
    const r = await holeBestand(cfg, { fetchFn: holen, force: true });
    expect(r.quelle).toBe('server');
    expect(r.lessons).toEqual([]);
  });

  it('Vorab-Bestand: nur auf eine Platte ohne Lektionen, nie ueber einen Bestand vom Server', () => {
    expect(schreibeVorabBestand(cfg.instanceId, lektionen(3))).toBe(true);
    expect(JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8')).lessons.length).toBe(3);
    lege(9, { alterMs: 1000, seitMs: 1000 });
    expect(schreibeVorabBestand(cfg.instanceId, lektionen(3))).toBe(false);
    expect(JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8')).lessons.length).toBe(9);
    lege(0, { alterMs: 1000, seitMs: 1000 });
    expect(schreibeVorabBestand(cfg.instanceId, lektionen(3))).toBe(true);
  });
});

/*
 * Befund 14.10.2026 (Live-Probe mit 0.10.196): Ein Prompt bei 12 s holte den
 * Stand des Servers mitten im Start-Import, 13 von 30 Lektionen, und ersetzte
 * damit den vollen Vorab-Bestand. Bis der Nebenlauf fertig war, fehlten dem
 * Nutzer 17 Lektionen.
 */
describe('holeBestand: ein halber Import verdraengt den Vorab-Bestand nicht', () => {
  let cfg: EinblendConfig;
  let serverLektionen: Array<{ topic: string; what_worked: string }>;
  const lektionen = (n: number) => Array.from({ length: n }, (_, i) => ({ topic: `fix:thema-${i}`, what_worked: `Behebung ${i}` }));
  const holen = (async () => ({ ok: true, json: async () => ({ lessons: serverLektionen.map((l) => JSON.stringify(l)) }) })) as unknown as typeof fetch;
  const datei = () => JSON.parse(readFileSync(bestandPfad(cfg.instanceId), 'utf8'));
  /** Laesst den Bestand auf der Platte altern, ohne ihn sonst zu aendern. */
  const altere = ({ alterMs, seitMs }: { alterMs: number; seitMs: number }) => {
    const jetzt = Date.now();
    writeFileSync(bestandPfad(cfg.instanceId), JSON.stringify({ ...datei(), at: jetzt - alterMs, seit: jetzt - seitMs }));
  };

  beforeEach(() => {
    cfg = { apiUrl: 'https://api.test', jwt: 'cky_test', instanceId: `inst-vorab-${Math.random().toString(36).slice(2, 10)}` };
    expect(schreibeVorabBestand(cfg.instanceId, lektionen(30))).toBe(true);
    serverLektionen = lektionen(13);
  });
  afterEach(() => rmSync(bestandPfad(cfg.instanceId), { force: true }));

  it('Prompt bei 12 s, Server hat 13 von 30: der Nutzer sieht alle 30', async () => {
    altere({ alterMs: 12_000, seitMs: 12_000 });
    const r = await holeBestand(cfg, { fetchFn: holen });

    expect(r.quelle).toBe('server');
    expect(r.lessons.length).toBe(30);
    expect(datei().lessons.length).toBe(30);
    // Der Vorab-Bestand bleibt, bis der Import fertig ist.
    expect(datei().vorab.length).toBe(30);
  });

  it('auch SessionStart (force) mitten im Import behaelt die fehlenden Themen', async () => {
    altere({ alterMs: 3_000, seitMs: 3_000 });
    const r = await holeBestand(cfg, { fetchFn: holen, force: true });
    expect(r.lessons.length).toBe(30);
  });

  it('die Lektion vom Server geht vor die gleichnamige vorab gebaute', async () => {
    serverLektionen = [{ topic: 'fix:thema-0', what_worked: 'vom Server' }];
    altere({ alterMs: 12_000, seitMs: 12_000 });
    const r = await holeBestand(cfg, { fetchFn: holen });
    expect(r.lessons.length).toBe(30);
    expect(r.lessons.filter((l) => l.topic === 'fix:thema-0')).toEqual([{ topic: 'fix:thema-0', what_worked: 'vom Server' }]);
    expect(r.lessons[0]).toEqual({ topic: 'fix:thema-0', what_worked: 'vom Server' });
  });

  it('Abschluss des Imports: der Server-Stand gilt allein, der Vorab-Bestand ist weg', async () => {
    serverLektionen = lektionen(29); // eine Lektion nahm die API nicht an
    const r = await holeBestand(cfg, { fetchFn: holen, force: true, vorabSchliessen: true });
    expect(r.lessons.length).toBe(29);
    expect(datei().vorab).toBeUndefined();

    // Danach ergaenzt nichts mehr: ein spaeterer Stand vom Server gilt, wie er ist.
    serverLektionen = lektionen(5);
    altere({ alterMs: 12_000, seitMs: 12_000 });
    expect((await holeBestand(cfg, { fetchFn: holen })).lessons.length).toBe(5);
  });

  it('wird der Import nie fertig, endet der Vorab-Bestand nach dem jungen Fenster', async () => {
    altere({ alterMs: 30_000, seitMs: JUNG_FENSTER_MS + 1000 });
    const r = await holeBestand(cfg, { fetchFn: holen, force: true });
    expect(r.lessons.length).toBe(13);
    expect(datei().vorab).toBeUndefined();
  });

  it('Instanz laeuft noch nicht (leer + note): der Vorab-Bestand bleibt ganz', async () => {
    const startet = (async () => ({ ok: true, json: async () => ({ lessons: [], note: 'instance is not running' }) })) as unknown as typeof fetch;
    altere({ alterMs: 12_000, seitMs: 12_000 });
    const r = await holeBestand(cfg, { fetchFn: startet });
    expect(r.quelle).toBe('platte-alt');
    expect(r.lessons.length).toBe(30);
    expect(datei().vorab.length).toBe(30);
  });
});
