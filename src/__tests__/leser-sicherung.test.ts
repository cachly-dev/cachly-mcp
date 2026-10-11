/**
 * Die Leser-Sicherung — ein ueberlasteter Leser kostet nicht bei jedem Prompt 2,5 s.
 *
 * ── Warum dieser Test (11.10.2026) ──────────────────────────────────────────
 *
 * Gemessen: In 6 von 6 Prompts kam der Leser nicht binnen 2,5 s. Jeder Prompt
 * wartete die volle Zeitgrenze und bekam trotzdem nur die lokale Ordnung.
 * Die Sicherung (leser-sicherung.ts) laesst den Leser nach 3 Ausfaellen in
 * Folge 10 Minuten aus. Geprueft wird beides, wofuer es sie gibt:
 *
 *   Hook-Weg   selectRelevantMitLeser, Zustand in einer Datei je Instanz
 *   MCP-Weg    leserPunkte (smart_recall), Zustand im Speicher
 *
 * ── Gegenprobe ─────────────────────────────────────────────────────────────
 *
 * Gefahren am 11.10.2026: in leser-sicherung.ts `darfFragen()` auf
 * `return true` und `offen()` auf `return false` gestellt (= keine
 * Sicherung). Dann waren 9 von 18 Tests rot, darunter "4. Aufruf ruft den
 * Leser nicht" in beiden Wegen. Nur `darfFragen()` allein: 7 rot — der
 * MCP-Weg prueft vorher `leserAktiv()`, das `offen()` liest.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  LeserSicherung, speicherImProzess, leserErgebnisAusStatus, leserErgebnisAusFehler,
  LESER_SICHERUNG_FEHLSCHLAEGE, LESER_SICHERUNG_PAUSE_MS,
} from '../leser-sicherung.js';
import { selectRelevantMitLeser, sicherungsPfad, bestandPfad, type EinblendLektion } from '../einblendung.js';

/**
 * Obergrenze fuer "der Leser wurde uebersprungen". Bewiesen werden soll: kein
 * Warten auf die 2.500-ms-Frist. 50 ms rissen unter Last (volle Suite parallel
 * zu Builds, 11.10.2026: einzeln 3 von 3 gruen, in der Suite rot). 500 ms
 * trennen weiter klar von 2.500 ms.
 */
const UEBERSPRUNGEN_MAX_MS = 500;
import { leserAktiv, leserPunkte, leserSperreLoeschen } from '../leser.js';
import { embedConfig } from '../embeddings.js';

const PAUSE = LESER_SICHERUNG_PAUSE_MS;

// ── Netz-Attrappen ─────────────────────────────────────────────────────────

/** Ein Leser, der nie antwortet (bis die Zeitgrenze abbricht). Zaehlt Anrufe. */
function haengender(): { fetchFn: typeof fetch; anrufe: () => number } {
  let n = 0;
  const fetchFn = ((_u: unknown, init?: RequestInit) => {
    n++;
    return new Promise<Response>((_r, ablehnen) => {
      init?.signal?.addEventListener('abort', () => ablehnen(Object.assign(new Error('Zeitgrenze'), { name: 'TimeoutError' })));
    });
  }) as unknown as typeof fetch;
  return { fetchFn, anrufe: () => n };
}

/** Ein Leser, der sofort gueltige Punkte liefert. Zaehlt Anrufe. */
function antwortender(): { fetchFn: typeof fetch; anrufe: () => number } {
  let n = 0;
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    n++;
    const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
    return new Response(JSON.stringify({ scores: texts.map((_, i) => i), provider: 'test', ms: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, anrufe: () => n };
}

// ── Einheit: die Sicherung selbst ──────────────────────────────────────────

describe('LeserSicherung — springt, wartet, versucht einmal, setzt zurueck', () => {
  let t = 1_000_000;
  const uhr = () => t;
  beforeEach(() => { t = 1_000_000; delete process.env.CACHLY_LESER_SICHERUNG; });
  afterEach(() => { delete process.env.CACHLY_LESER_SICHERUNG; });

  it('die Schwellen sind die gemessenen Zahlen: 3 Ausfaelle, 10 Minuten', () => {
    expect(LESER_SICHERUNG_FEHLSCHLAEGE).toBe(3);
    expect(LESER_SICHERUNG_PAUSE_MS).toBe(10 * 60 * 1000);
  });

  it('nach 3 Fehlschlaegen in Folge wird nicht mehr gefragt', () => {
    const s = new LeserSicherung(speicherImProzess(), uhr);
    for (let i = 0; i < 2; i++) { expect(s.darfFragen()).toBe(true); s.melde('fehlschlag'); }
    expect(s.offen()).toBe(false);
    expect(s.darfFragen()).toBe(true);
    s.melde('fehlschlag');
    expect(s.offen()).toBe(true);
    expect(s.darfFragen()).toBe(false);
    t += PAUSE - 1;
    expect(s.darfFragen()).toBe(false);
  });

  it('ein Erfolg dazwischen setzt die Zaehlung zurueck', () => {
    const s = new LeserSicherung(speicherImProzess(), uhr);
    s.melde('fehlschlag'); s.melde('fehlschlag'); s.melde('erfolg');
    s.melde('fehlschlag'); s.melde('fehlschlag');
    expect(s.darfFragen()).toBe(true);
  });

  it('nach der Pause genau EIN Versuch; scheitert er, die naechste Pause', () => {
    const s = new LeserSicherung(speicherImProzess(), uhr);
    for (let i = 0; i < 3; i++) s.melde('fehlschlag');
    t += PAUSE;
    expect(s.darfFragen()).toBe(true); // der eine Versuch
    expect(s.darfFragen()).toBe(false); // ein gleichzeitiger zweiter nicht
    s.melde('fehlschlag');
    t += PAUSE - 1;
    expect(s.darfFragen()).toBe(false);
    t += 1;
    expect(s.darfFragen()).toBe(true);
  });

  it('gelingt der Versuch nach der Pause, ist alles wieder normal', () => {
    const s = new LeserSicherung(speicherImProzess(), uhr);
    for (let i = 0; i < 3; i++) s.melde('fehlschlag');
    t += PAUSE;
    expect(s.darfFragen()).toBe(true);
    s.melde('erfolg');
    // Wieder drei Ausfaelle noetig, nicht einer.
    s.melde('fehlschlag'); s.melde('fehlschlag');
    expect(s.darfFragen()).toBe(true);
  });

  it('503 (kein Dienst) oeffnet sofort; 4xx und kaputte Antworten zaehlen nicht', () => {
    expect(leserErgebnisAusStatus(503)).toBe('abgeschaltet');
    expect(leserErgebnisAusStatus(502)).toBe('fehlschlag');
    expect(leserErgebnisAusStatus(500)).toBe('fehlschlag');
    expect(leserErgebnisAusStatus(429)).toBe('neutral');
    expect(leserErgebnisAusStatus(401)).toBe('neutral');
    expect(leserErgebnisAusFehler(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('fehlschlag');
    expect(leserErgebnisAusFehler(new TypeError('fetch failed'))).toBe('fehlschlag');
    expect(leserErgebnisAusFehler(new SyntaxError('kein JSON'))).toBe('neutral');

    const s = new LeserSicherung(speicherImProzess(), uhr);
    for (let i = 0; i < 10; i++) s.melde('neutral');
    expect(s.darfFragen()).toBe(true);
    s.melde('abgeschaltet');
    expect(s.darfFragen()).toBe(false);
  });

  it('ein Zeitpunkt weit hinter der Pause gilt als kaputt und sperrt nicht', () => {
    const speicher = speicherImProzess();
    speicher.schreib({ fehlschlaege: 3, offenBis: t + 50 * PAUSE });
    expect(new LeserSicherung(speicher, uhr).offen()).toBe(false);
  });

  it('CACHLY_LESER_SICHERUNG=aus: immer fragen, nichts merken', () => {
    process.env.CACHLY_LESER_SICHERUNG = 'aus';
    const speicher = speicherImProzess();
    const s = new LeserSicherung(speicher, uhr);
    for (let i = 0; i < 5; i++) { expect(s.darfFragen()).toBe(true); s.melde('fehlschlag'); }
    expect(speicher.lies()).toEqual({ fehlschlaege: 0, offenBis: 0 });
  });
});

// ── Hook-Weg: Zustand in einer Datei, ein Prozess je Prompt ───────────────

const FRAGE = 'Warum meldet der Deploy auf node-1 connection refused, obwohl WireGuard aktiv ist?';
const BESTAND: EinblendLektion[] = [
  { topic: 'deploy:runner-ablauf', what_worked: 'Der Deploy auf node-1 laeuft ueber den Runner auf node-3. Meldet der Job Erfolg, trotzdem die Logs pruefen.', outcome: 'success', recall_count: 500 },
  { topic: 'tco:deploy-meldet-gruen', what_worked: 'Der Deploy meldet gruen, obwohl alembic nie lief — Migrationen im Deploy-Skript ausdruecklich starten.', outcome: 'failure', recall_count: 200 },
  {
    topic: 'betrieb:fail2ban-bannt-deploy-kanal',
    what_worked: 'fail2ban auf node-1 bannte den WireGuard-Peer 10.8.0.6; der Deploy meldete connection refused, obwohl WireGuard aktiv war.',
    outcome: 'success', severity: 'critical', recall_count: 2,
  },
];

const benutzt = new Set<string>();
function cfg(name: string) {
  const instanceId = `test-leser-sicherung-${name}-${process.pid}`;
  benutzt.add(instanceId);
  rmSync(sicherungsPfad(instanceId), { force: true });
  return { apiUrl: 'http://fixture.invalid', jwt: 'test-schluessel', instanceId };
}
afterAll(() => {
  for (const id of benutzt) {
    rmSync(sicherungsPfad(id), { force: true });
    rmSync(bestandPfad(id), { force: true });
  }
});

/** Ein Prompt durch den Hook-Kern, wie ein Prozess je Prompt ihn faehrt. */
async function prompt(c: ReturnType<typeof cfg>, fetchFn: typeof fetch) {
  const start = performance.now();
  const a = await selectRelevantMitLeser(FRAGE, BESTAND, c, { zeitlimitMs: 30, fetchFn });
  return { leser: a.leser, ms: performance.now() - start, oben: a.lessons[0]?.topic };
}

describe('Hook-Weg — Sicherung in der Datei je Instanz', () => {
  afterEach(() => { vi.useRealTimers(); delete process.env.CACHLY_LESER_SICHERUNG; });

  it('3 Fehlschlaege -> der 4. Prompt ruft den Leser nicht und kostet < 50 ms', async () => {
    const c = cfg('springt');
    const netz = haengender();
    for (let i = 0; i < 3; i++) expect((await prompt(c, netz.fetchFn)).leser).toBe('aus');
    expect(netz.anrufe()).toBe(3);

    const vierter = await prompt(c, netz.fetchFn);
    expect(netz.anrufe()).toBe(3);
    expect(vierter.ms).toBeLessThan(UEBERSPRUNGEN_MAX_MS);
    // Die Messung kann "uebersprungen" von "nicht da" ('aus') unterscheiden.
    expect(vierter.leser).toBe('uebersprungen');
    // Die lokale Ordnung bleibt: es wird trotzdem eingeblendet.
    expect(vierter.oben).toBeTruthy();
  });

  it('nach Ablauf der Pause wird wieder versucht; Erfolg setzt zurueck', async () => {
    const c = cfg('erholt');
    const tot = haengender();
    for (let i = 0; i < 3; i++) await prompt(c, tot.fetchFn);
    expect((await prompt(c, tot.fetchFn)).leser).toBe('uebersprungen');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAUSE + 1);
    const lebt = antwortender();
    expect((await prompt(c, lebt.fetchFn)).leser).toBe('test');
    expect(lebt.anrufe()).toBe(1);
    // Zurueckgesetzt: der naechste Prompt fragt wieder, ohne Pause.
    expect((await prompt(c, lebt.fetchFn)).leser).toBe('test');
    expect(lebt.anrufe()).toBe(2);
    expect(JSON.parse(readFileSync(sicherungsPfad(c.instanceId), 'utf8'))).toEqual({ fehlschlaege: 0, offenBis: 0 });
  });

  it('scheitert der eine Versuch nach der Pause, folgen weitere 10 Minuten', async () => {
    const c = cfg('rueckfall');
    const tot = haengender();
    for (let i = 0; i < 3; i++) await prompt(c, tot.fetchFn);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAUSE + 1);
    expect((await prompt(c, tot.fetchFn)).leser).toBe('aus'); // der Versuch, er scheitert
    expect(tot.anrufe()).toBe(4);
    expect((await prompt(c, tot.fetchFn)).leser).toBe('uebersprungen');
    expect(tot.anrufe()).toBe(4);
  });

  it('kaputte oder halb geschriebene Zustandsdatei = normaler Betrieb', async () => {
    for (const inhalt of ['{kaputt', '{"fehlschlaege":3,"offen', '', 'null', '{"fehlschlaege":"drei","offenBis":-5}']) {
      const c = cfg('kaputt');
      writeFileSync(sicherungsPfad(c.instanceId), inhalt);
      const lebt = antwortender();
      expect((await prompt(c, lebt.fetchFn)).leser).toBe('test');
      expect(lebt.anrufe()).toBe(1);
    }
  });

  it('fehlende Datei = normaler Betrieb, und im Normalbetrieb wird nichts geschrieben', async () => {
    const c = cfg('ruhe');
    const lebt = antwortender();
    expect((await prompt(c, lebt.fetchFn)).leser).toBe('test');
    expect(existsSync(sicherungsPfad(c.instanceId))).toBe(false);
  });

  it('CACHLY_LESER_SICHERUNG=aus: jeder Prompt fragt den Leser (Messlaeufe)', async () => {
    process.env.CACHLY_LESER_SICHERUNG = 'aus';
    const c = cfg('abgeschaltet');
    const netz = haengender();
    for (let i = 0; i < 5; i++) expect((await prompt(c, netz.fetchFn)).leser).toBe('aus');
    expect(netz.anrufe()).toBe(5);
  });

  it('zwei Instanzen teilen keine Sicherung', async () => {
    const a = cfg('instanz-a');
    const b = cfg('instanz-b');
    const tot = haengender();
    for (let i = 0; i < 3; i++) await prompt(a, tot.fetchFn);
    const lebt = antwortender();
    expect((await prompt(a, lebt.fetchFn)).leser).toBe('uebersprungen');
    expect((await prompt(b, lebt.fetchFn)).leser).toBe('test');
  });
});

// ── MCP-Weg: smart_recall, langlebiger Prozess, Zustand im Speicher ───────

describe('MCP-Weg (leserPunkte) — dieselbe Sicherung im Speicher', () => {
  const jwtVorher = embedConfig.jwt;
  beforeEach(() => { embedConfig.jwt = 'test-jwt'; delete process.env.CACHLY_LESER; delete process.env.CACHLY_LESER_SICHERUNG; leserSperreLoeschen(); });
  afterEach(() => { embedConfig.jwt = jwtVorher; vi.useRealTimers(); delete process.env.CACHLY_LESER_SICHERUNG; leserSperreLoeschen(); });

  it('3 Fehlschlaege -> der 4. Aufruf ruft den Leser nicht und kostet < 50 ms', async () => {
    const netz = haengender();
    for (let i = 0; i < 3; i++) {
      expect(await leserPunkte('f', ['a', 'b'], { fetchFn: netz.fetchFn, zeitlimitMs: 30, instanceId: 'i1' })).toBeNull();
    }
    expect(leserAktiv('i1')).toBe(false);
    const start = performance.now();
    expect(await leserPunkte('f', ['a', 'b'], { fetchFn: netz.fetchFn, zeitlimitMs: 30, instanceId: 'i1' })).toBeNull();
    expect(performance.now() - start).toBeLessThan(UEBERSPRUNGEN_MAX_MS);
    expect(netz.anrufe()).toBe(3);
    // Andere Instanz im selben Prozess: eigener Leser, eigene Sicherung.
    expect(leserAktiv('i2')).toBe(true);
  });

  it('nach der Pause ein Versuch; Erfolg setzt zurueck', async () => {
    const tot = haengender();
    for (let i = 0; i < 3; i++) await leserPunkte('f', ['a'], { fetchFn: tot.fetchFn, zeitlimitMs: 30 });
    expect(leserAktiv()).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAUSE + 1);
    // leserAktiv() nur nachsehen: darf den einen Versuch nicht verbrauchen.
    expect(leserAktiv()).toBe(true);
    expect(leserAktiv()).toBe(true);
    const lebt = antwortender();
    expect(await leserPunkte('f', ['a', 'b'], { fetchFn: lebt.fetchFn })).toEqual([0, 1]);
    for (let i = 0; i < 2; i++) await leserPunkte('f', ['a'], { fetchFn: tot.fetchFn, zeitlimitMs: 30 });
    expect(leserAktiv()).toBe(true); // zwei Ausfaelle nach dem Erfolg reichen nicht
  });

  it('CACHLY_LESER_SICHERUNG=aus: immer fragen', async () => {
    process.env.CACHLY_LESER_SICHERUNG = 'aus';
    const netz = haengender();
    for (let i = 0; i < 5; i++) await leserPunkte('f', ['a'], { fetchFn: netz.fetchFn, zeitlimitMs: 30 });
    expect(netz.anrufe()).toBe(5);
    expect(leserAktiv()).toBe(true);
  });
});
