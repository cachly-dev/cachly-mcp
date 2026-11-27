/**
 * ABNAHME Stufe 1 "Firmenregeln ab Tag 1" (eingefroren am 27.11.2026 vom Architekten).
 *
 * Nachfolger von messung-briefing-nach-join.test.ts. Die Messung druckte eine Tabelle
 * (Vorher: 0 von 12). Diese Datei PRUEFT: 12 von 12 auf jedem Weg, mit festem Deckel.
 *
 * Ziel-Ort im Produkt-Repo: sdk/mcp/src/__tests__/regeln-nach-join.test.ts
 * Vertrag, gegen den sie laeuft: BAUPLAN-stufe-1.md, Abschnitt "Vertraege".
 * Sie ist ROT, bis PR 1 (Golden-Datei) und PR 2 (firmenregeln.ts) gebaut sind.
 * NICHT AUSGEFUEHRT beim Schreiben: das Modul ../firmenregeln.js gibt es noch nicht.
 *
 * Wer baut, aendert diese Datei nicht. Passt der Vertrag nicht, geht die Frage zurueck
 * an den Architekten (Ausnahme: der relative Pfad GOLDEN, wenn die Datei woanders liegt).
 *
 * Wege:
 *   H   SessionStart-Hook: sitzungsKontext(bestand, regelStand)
 *   A   erste Werkzeugantwort des Prozesses: regelHinweisEinmal(...)
 *   E   session_start, erste Sitzung          E2  session_start, zweite Sitzung
 *   S   smart_recall: nur passende Regeln, hoechstens 3
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { handleBrainTool } from '../handlers/brain.js';
import { sitzungsKontext } from '../einblendung.js';
import {
  REGEL_BLOCK_DECKEL,
  holeRegeln,
  regelHinweisEinmal,
  merkeRegelLieferung,
  setzeRegelZustandZurueck,
  type RegelStand,
} from '../firmenregeln.js';

const HIER = dirname(fileURLToPath(import.meta.url));
// Eigene Testdaten dieses Pakets (kein Zugriff auf api/): die Antworten sind nach dem Vertrag
// `RegelAntwort` von Hand gebaut. Sie werden mit den Golden-Dateien der API abgeglichen.
const TESTDATA = resolve(HIER, 'fixtures');
const GOLDEN_12 = JSON.parse(readFileSync(join(TESTDATA, 'firmenregeln-antwort-12.json'), 'utf8'));
const GOLDEN_VOLL = JSON.parse(readFileSync(join(TESTDATA, 'firmenregeln-antwort-voll.json'), 'utf8'));
const FIXTURE = JSON.parse(readFileSync(join(TESTDATA, 'regeln-12.fixture.json'), 'utf8')) as {
  abfragen_mit_treffer: { query: string; erwartet: string }[];
  abfragen_ohne_treffer: string[];
};
const LEER = { rules: [], block: '', count: 0, hash: 'leer', updated_at: null };

const MARKEN = Array.from({ length: 12 }, (_, i) => `REGEL-${String(i + 1).padStart(2, '0')}`);
const gezaehlt = (text: string) => MARKEN.filter((m) => text.includes(m)).length;
const ETIKETT = '<cachly-company-rules';

type ApiFetch = Parameters<typeof handleBrainTool>[3];
function api(antwort: unknown | 'kein-netz' | '404'): ApiFetch {
  return (async (pfad: string) => {
    if (pfad.includes('syndication/stats')) return { total_lessons: 65, total_confirms: 321, added_last_7_days: 0 };
    if (/\/instances\/[^/]+\/rules$/.test(pfad)) {
      if (antwort === 'kein-netz') throw new Error('kein Netz im Test');
      if (antwort === '404') throw new Error('HTTP 404');
      return antwort;
    }
    throw new Error('kein Netz im Test');
  }) as unknown as ApiFetch;
}

const jetzt = Date.now();
const vorStunden = (h: number) => new Date(jetzt - h * 3_600_000).toISOString();
function zufall(seed: number) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

/** Derselbe Hintergrund wie in der Messung: B Lektionen von drei Autoren, bis 90 Tage alt. */
async function saeen(redis: MockRedis, hintergrund: number) {
  const rnd = zufall(42);
  const autoren = ['admin', 'bob', 'carol'];
  const bereiche = ['deploy', 'auth', 'db', 'ci', 'web', 'api', 'test', 'infra'];
  for (let i = 0; i < hintergrund; i++) {
    const ts = vorStunden(rnd() * 24 * 90);
    const topic = `${bereiche[i % bereiche.length]}:hintergrund-${i}`;
    await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
      topic, outcome: rnd() < 0.8 ? 'success' : 'failure', severity: 'minor',
      what_worked: `Loesung ${i} fuer ${topic}, lang genug fuer eine Vorschau.`,
      recall_count: Math.floor(rnd() * rnd() * 40), ts, verified_at: ts, confidence: 1,
      tags: [bereiche[i % bereiche.length]], author: autoren[i % autoren.length],
    }));
  }
}

async function bestand(redis: MockRedis) {
  const keys = [...(redis as unknown as { store: Map<string, unknown> }).store.keys()].filter((k) => k.startsWith('cachly:lesson:best:'));
  const roh = await Promise.all(keys.map((k) => redis.get(k)));
  return roh.filter(Boolean).map((r) => JSON.parse(String(r)));
}

async function lauf(hintergrund: number, apiFetch: ApiFetch) {
  const redis = new MockRedis();
  const getConn = async () => redis as unknown as Redis;
  await saeen(redis, hintergrund);
  const ordner = mkdtempSync(join(tmpdir(), 'neu-'));
  const stand: RegelStand = await holeRegeln('i1', apiFetch);
  const h = sitzungsKontext(await bestand(redis), stand);
  const a = regelHinweisEinmal('i1', stand, { cwd: ordner, prozessStart: Date.now() });
  const a2 = regelHinweisEinmal('i1', stand, { cwd: ordner, prozessStart: Date.now() });
  const start = (focus: string) => handleBrainTool('session_start', { instance_id: 'i1', author: 'neu', focus, workspace_path: ordner }, getConn, apiFetch);
  const e = String(await start('login seite bauen'));
  const e2 = String(await start('login seite bauen'));
  return { redis, getConn, stand, h, a, a2, e, e2 };
}

beforeEach(() => {
  // Jeder Test bekommt einen eigenen Ordner fuer den Plattenstand und die Liefer-Marke.
  process.env.CACHLY_REGELN_ORDNER = mkdtempSync(join(tmpdir(), 'regeln-'));
  setzeRegelZustandZurueck();
});

describe('ABNAHME: alle angehefteten Regeln in der ersten Sitzung nach join', () => {
  for (const hintergrund of [0, 50, 500]) {
    it(`B=${hintergrund}: 12 von 12 auf H, A, E und E2`, async () => {
      const r = await lauf(hintergrund, api(GOLDEN_12));
      expect(gezaehlt(r.h), 'H Hook').toBe(12);
      expect(gezaehlt(r.a), 'A erste Werkzeugantwort').toBe(12);
      expect(gezaehlt(r.e), 'E erste Sitzung').toBe(12);
      expect(gezaehlt(r.e2), 'E2 zweite Sitzung').toBe(12);
      // Die Regeln stehen VOR allem anderen.
      expect(r.h.indexOf(ETIKETT)).toBeGreaterThanOrEqual(0);
      expect(r.h.indexOf(ETIKETT)).toBeLessThan(r.h.indexOf('<cachly-memory') === -1 ? Infinity : r.h.indexOf('<cachly-memory'));
      // Einmal je Prozess: die zweite Werkzeugantwort traegt den Block nicht noch einmal.
      expect(r.a2).toBe('');
    }, 120_000);
  }

  it('Deckel: der Block bleibt bei 20 Regeln in voller Laenge unter REGEL_BLOCK_DECKEL', async () => {
    expect(REGEL_BLOCK_DECKEL).toBe(5000);
    expect(GOLDEN_VOLL.count).toBe(20);
    expect(String(GOLDEN_VOLL.block).length).toBeLessThanOrEqual(REGEL_BLOCK_DECKEL);
    const r = await lauf(50, api(GOLDEN_VOLL));
    for (const [weg, text] of [['H', r.h], ['A', r.a], ['E', r.e]] as const) {
      const von = text.indexOf(ETIKETT);
      const bis = text.indexOf('</cachly-company-rules>');
      expect(von, `${weg} hat den Block`).toBeGreaterThanOrEqual(0);
      expect(bis - von, `${weg} Blocklaenge`).toBeLessThanOrEqual(REGEL_BLOCK_DECKEL);
      for (const regel of GOLDEN_VOLL.rules as { title: string }[]) expect(text, `${weg} nennt ${regel.title}`).toContain(regel.title);
    }
  }, 120_000);

  it('Gegenprobe: ohne angeheftete Regeln steht nichts da, und der Hook-Text ist wie heute', async () => {
    const r = await lauf(50, api(LEER));
    expect(gezaehlt(r.h) + gezaehlt(r.a) + gezaehlt(r.e) + gezaehlt(r.e2)).toBe(0);
    expect(r.a).toBe('');
    expect(r.e).not.toContain(ETIKETT);
    expect(r.h).toBe(sitzungsKontext(await bestand(r.redis)));
  }, 120_000);

  it('Alte API ohne den Endpunkt (404): keine Regeln, kein Fehlertext', async () => {
    const r = await lauf(50, api('404'));
    expect(r.stand.count).toBe(0);
    expect(r.e).not.toContain('404');
    expect(r.e).not.toContain(ETIKETT);
  }, 120_000);

  it('Server nicht erreichbar: der Stand von der Platte traegt weiter 12 von 12', async () => {
    const erst = await holeRegeln('i1', api(GOLDEN_12));
    expect(erst.quelle).toBe('server');
    setzeRegelZustandZurueck(); // neuer Prozess: Speicher leer, Platte bleibt
    const r = await lauf(50, api('kein-netz'));
    expect(r.stand.quelle).toBe('platte');
    expect(gezaehlt(r.h)).toBe(12);
    expect(gezaehlt(r.e)).toBe(12);
  }, 120_000);

  it('Hat der Hook in dieser Sitzung schon geliefert, kommt der Block nicht doppelt', async () => {
    const stand = await holeRegeln('i1', api(GOLDEN_12));
    const ordner = mkdtempSync(join(tmpdir(), 'neu-'));
    const start = Date.now();
    merkeRegelLieferung('i1', stand.hash, ordner);
    expect(regelHinweisEinmal('i1', stand, { cwd: ordner, prozessStart: start })).toBe('');
    // Anderer Ordner, also andere Sitzung: im Zweifel liefern.
    setzeRegelZustandZurueck();
    const s2 = await holeRegeln('i1', api(GOLDEN_12));
    expect(gezaehlt(regelHinweisEinmal('i1', s2, { cwd: mkdtempSync(join(tmpdir(), 'neu-')), prozessStart: start }))).toBe(12);
  });

  it('S smart_recall: passende Regel kommt mit, hoechstens 3, sonst kein Block', async () => {
    let treffer = 0;
    for (const { query, erwartet } of FIXTURE.abfragen_mit_treffer) {
      const r = await lauf(50, api(GOLDEN_12));
      const s = String(await handleBrainTool('smart_recall', { instance_id: 'i1', query }, r.getConn, api(GOLDEN_12)));
      expect(gezaehlt(s), `"${query}" zeigt hoechstens 3 Regeln`).toBeLessThanOrEqual(3);
      if (s.includes(erwartet)) treffer++;
      setzeRegelZustandZurueck();
    }
    expect(treffer, 'passende Regel gefunden').toBeGreaterThanOrEqual(5);
    for (const query of FIXTURE.abfragen_ohne_treffer) {
      const r = await lauf(50, api(GOLDEN_12));
      const s = String(await handleBrainTool('smart_recall', { instance_id: 'i1', query }, r.getConn, api(GOLDEN_12)));
      expect(gezaehlt(s), `"${query}" zeigt keine Regel`).toBe(0);
      setzeRegelZustandZurueck();
    }
  }, 240_000);

  it('Verdrahtung: index.ts haengt den Block an die Werkzeugantwort und laedt beim Verbinden vor', () => {
    const quelle = readFileSync(resolve(HIER, '../index.ts'), 'utf8');
    expect(quelle).toMatch(/regelHinweisEinmal\(/);
    expect(quelle).toMatch(/holeRegeln\(/);
  });

  it('Der falsche Hinweis ist weg: kein Text empfiehlt mehr "pinned: true" ueber learn_from_attempts', () => {
    const brain = readFileSync(resolve(HIER, '../handlers/brain.ts'), 'utf8');
    expect(brain).not.toMatch(/pinned: true/);
    expect(brain).not.toMatch(/\.pinned\b/);
  });
});
