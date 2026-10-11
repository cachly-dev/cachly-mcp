/**
 * Die Ausgabe von smart_recall folgt der Hausordnung (`kwGemischt`).
 *
 * Anlass (11.10.2026): die Ausgabe sortierte die Hausordnung noch einmal
 * nach dem normierten Wortwert. Eine Lektion, die nur der
 * Bedeutungsabgleich fand (Wortwert 0), stand in der Hausordnung auf
 * Platz 1 und in der Ausgabe hinten. Gemessen an 3.003 Fragen: siehe
 * src/bench/ausgabe-reihenfolge-messen.ts und src/ausgabe-ordnung.ts.
 *
 * Die Hausordnung wird am Liefer-Journal abgelesen — es schreibt die
 * obersten drei aus `kwGemischt`, ohne Umweg ueber die Ausgabe.
 *
 * GEGENPROBE: auf dem Stand vor dieser Aenderung ist die erste Probe rot —
 * der reine Sinn-Treffer stand in der Ausgabe auf Platz 3.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

const DIM = 16;
function einheit(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

const FRAGE = 'Warum stockt der Import nach dem Update der Bibliothek';

vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return {
    ...echt,
    hasEmbedProvider: () => true,
    EMBED_PROVIDER: 'cachly',
    // Die Frage zeigt in Richtung 0 — genau dorthin, wo der Sinn-Treffer liegt.
    // Das Zweitmodell gibt es in dieser Probe nicht.
    computeEmbedding: vi.fn(async (_t: string, opts?: { modell?: string }) => {
      if (opts?.modell) throw new Error('kein Zweitmodell in dieser Probe');
      return einheit(0);
    }),
  };
});

import { handleBrainTool } from '../handlers/brain.js';
import { packe, VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { lieferJournalSchluessel } from '../etiketten.js';
import { ordneNachHausordnung, rangWerte } from '../ausgabe-ordnung.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

/** Der Sinn-Treffer: kein einziges Wort der Frage, Bedeutung genau getroffen. */
const SINN = 'abhaengigkeit:versionssprung-veraendert-einlesen';
/** Zwei Worttreffer: je ein Wort der Frage, Bedeutung daneben. */
const WORT_A = 'import:csv-trennzeichen';
const WORT_B = 'update:paketliste-sperren';

const LEKTIONEN: Array<{ topic: string; what_worked: string; richtung: number }> = [
  {
    topic: SINN,
    what_worked: 'Ein Versionssprung einer Abhaengigkeit veraendert das Einlesen. Version festnageln, Pruefsumme vergleichen.',
    richtung: 0,
  },
  { topic: WORT_A, what_worked: 'Import liest Semikolon als Trennzeichen. Komma-Dateien vorher umwandeln.', richtung: 1 },
  { topic: WORT_B, what_worked: 'Update immer mit gesperrter Paketliste fahren, Sperrdatei einchecken.', richtung: 2 },
];

describe('smart_recall: die Ausgabe folgt der Hausordnung', () => {
  const redis = new MockRedis();
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async <T>(): Promise<T> => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as T;
  let ausgabe = '';

  beforeAll(async () => {
    for (const l of LEKTIONEN) {
      await redis.set(`cachly:lesson:best:${l.topic}`, JSON.stringify({
        topic: l.topic, outcome: 'success', what_worked: l.what_worked, ts: '2026-10-01T00:00:00Z',
      }));
      await redis.set(`${VEKTOR_PRAEFIX}${l.topic}`, packe(einheit(l.richtung)));
      await redis.set(`${NAME_VEKTOR_PRAEFIX}${l.topic}`, packe(einheit(l.richtung)));
    }
    ausgabe = String(await handleBrainTool('smart_recall', { instance_id: 'h1', query: FRAGE }, getConn, noopApiFetch));
  });

  it('der reine Sinn-Treffer steht in Hausordnung UND Ausgabe oben, die Reihenfolge ist dieselbe', async () => {
    const zeile = (await redis.lrange(lieferJournalSchluessel('h1'), 0, 0))[0];
    expect(zeile, 'das Liefer-Journal muss die Hausordnung festhalten').toBeTruthy();
    const hausordnung = (JSON.parse(zeile) as { themen: string[] }).themen;
    // Vorbedingung: die Hausordnung setzt den Sinn-Treffer auf Platz 1.
    expect(hausordnung[0]).toBe(SINN);

    const gezeigt = [...ausgabe.matchAll(/\*\*💡 (.+?)\*\*/g)].map((m) => m[1].trim());
    expect(gezeigt.slice(0, hausordnung.length)).toEqual(hausordnung);
  });

  it('der Sinn-Treffer hat wirklich keinen Wortwert (sonst prueft die Probe nichts)', () => {
    const zeile = ausgabe.split('\n').find((z) => z.includes(`💡 ${SINN}`)) ?? '';
    expect(zeile).toContain('BM25: 0.00');
  });
});

describe('ordneNachHausordnung / rangWerte', () => {
  it('Hauseintraege behalten ihre Reihenfolge, auch wenn ihre Werte nicht fallen', () => {
    const rang = new Map([['a', 0], ['b', 1], ['c', 2]]);
    const raus = ordneNachHausordnung(
      [{ key: 'c', hybridScore: 0.9 }, { key: 'b', hybridScore: 0.1 }, { key: 'a', hybridScore: 0.5 }],
      rang,
    );
    expect(raus.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('ein Zusatztreffer reiht sich nach seinem Wert ein, ohne die Hausordnung zu stoeren', () => {
    const rang = new Map([['a', 0], ['b', 1], ['c', 2]]);
    const raus = ordneNachHausordnung(
      [
        { key: 'a', hybridScore: 1 }, { key: 'b', hybridScore: 0.6 }, { key: 'c', hybridScore: 0.2 },
        { key: 'x', hybridScore: 0.4 }, { key: 'y', hybridScore: 0.6 },
      ],
      rang,
    );
    // y ist gleich gut wie b: bei Gleichstand steht der Hauseintrag vorn.
    expect(raus.map((r) => r.key)).toEqual(['a', 'b', 'y', 'x', 'c']);
  });

  it('rangWerte: Platz k bekommt den k-groessten Wert', () => {
    expect(rangWerte([0.2, 1, 0, 0.5])).toEqual([1, 0.5, 0.2, 0]);
    expect(rangWerte([])).toEqual([]);
  });
});
