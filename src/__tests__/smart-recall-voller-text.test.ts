/**
 * smart_recall zeigt den vollen Text einer Lektion, und die Kopfzeile nennt
 * die Bedeutungssuche, wenn sie gelaufen ist.
 *
 * Anlass (21.10.2026, LoCoMo Lauf 5, bench/locomo/BEFUND-lauf-5.md): die
 * Ausgabe kappte jede Lektion nach 400 Zeichen. 83 % der gezeigten Treffer
 * waren gekuerzt; derselbe Abruf mit vollem Text beantwortete 84,1 statt
 * 75,4 % der Fragen. Im selben Lauf hiessen alle 1.529 Abrufe "keyword",
 * obwohl 1.002 davon Treffer zeigten, die nur ueber Vektoren erreichbar sind.
 *
 * GEGENPROBE: auf dem Stand davor (fcad8a3a) sind "die Tatsache bei Zeichen
 * 1.200 kommt an" und "die Kopfzeile nennt die Bedeutungssuche" rot.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const DIM = 16;
function einheit(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

let mitDienst = true;

vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return {
    ...echt,
    hasEmbedProvider: () => mitDienst,
    EMBED_PROVIDER: 'cachly',
    computeEmbedding: vi.fn(async (_t: string, opts?: { modell?: string }) => {
      if (opts?.modell) throw new Error('kein Zweitmodell in dieser Probe');
      return einheit(0);
    }),
  };
});

import { handleBrainTool, RECALL_VOLLTEXT_ZEICHEN, RECALL_ROH_ZEICHEN } from '../handlers/brain.js';
import { packe, VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const FRAGE = 'Wie heisst der Schalter fuer den Einleseweg';
const TATSACHE = 'SCHALTER EINLESEWEG_ZWEI=an';

/** Mittellange Lektion: die entscheidende Tatsache steht bei Zeichen ~1.200. */
const MITTEL = 'einlesen:schalter-weit-hinten';
const MITTEL_TEXT = `${'Vorgeschichte zum Einlesen und warum es lange hakte. '.repeat(23)}${TATSACHE}. Danach lief es.`;

/** Ueberlange Lektion: muss gekappt werden, sichtbar. */
const RIESE = 'einlesen:riesige-lektion';
const RIESE_TEXT = `${'Sehr langer Bericht ueber den Einleseweg. '.repeat(150)}ENDE-DES-RIESEN`;

describe('smart_recall: voller Text und ehrliche Kopfzeile', () => {
  const redis = new MockRedis();
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async <T>(): Promise<T> => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as T;
  const abruf = async () => String(await handleBrainTool('smart_recall', { instance_id: 'v1', query: FRAGE }, getConn, noopApiFetch));

  beforeAll(async () => {
    for (const [topic, what_worked, richtung] of [[MITTEL, MITTEL_TEXT, 0], [RIESE, RIESE_TEXT, 1]] as const) {
      await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
        topic, outcome: 'success', what_worked, ts: '2026-10-01T00:00:00Z',
      }));
      await redis.set(`${VEKTOR_PRAEFIX}${topic}`, packe(einheit(richtung)));
      await redis.set(`${NAME_VEKTOR_PRAEFIX}${topic}`, packe(einheit(richtung)));
    }
  });

  afterEach(() => {
    mitDienst = true;
    delete process.env.CACHLY_RECALL_COMPACT;
  });

  it('Vorbedingung: die Tatsache steht hinter der alten Grenze und vor der neuen', () => {
    const stelle = MITTEL_TEXT.indexOf(TATSACHE);
    expect(stelle).toBeGreaterThan(1000);
    expect(stelle + TATSACHE.length).toBeLessThan(RECALL_VOLLTEXT_ZEICHEN);
    expect(RIESE_TEXT.length).toBeGreaterThan(RECALL_VOLLTEXT_ZEICHEN * 2);
  });

  it('die Tatsache bei Zeichen 1.200 kommt an', async () => {
    expect(await abruf()).toContain(TATSACHE);
  });

  it('eine ueberlange Lektion endet sichtbar gekappt, nicht still', async () => {
    const ausgabe = await abruf();
    expect(ausgabe).not.toContain('ENDE-DES-RIESEN');
    const zeile = ausgabe.split('\n').find((z) => z.startsWith('> Sehr langer Bericht')) ?? '';
    expect(zeile).toMatch(/…$/);
    expect(zeile.length).toBeLessThanOrEqual(RECALL_VOLLTEXT_ZEICHEN + 4);
  });

  it('der Kompakt-Modus bleibt bei der kurzen Vorschau', async () => {
    process.env.CACHLY_RECALL_COMPACT = '1';
    const ausgabe = await abruf();
    expect(ausgabe).not.toContain(TATSACHE);
    const zeile = ausgabe.split('\n').find((z) => z.startsWith('> Vorgeschichte')) ?? '';
    expect(zeile.length).toBeLessThanOrEqual(RECALL_ROH_ZEICHEN + 4);
  });

  it('die Kopfzeile nennt die Bedeutungssuche, wenn der Sinnpfad lief', async () => {
    const kopf = (await abruf()).split('\n').find((z) => z.startsWith('### 🔍 Results')) ?? '';
    expect(kopf).toContain('semantic');
  });

  it('ohne Einbettungsdienst bleibt die Kopfzeile bei "keyword"', async () => {
    mitDienst = false;
    const kopf = (await abruf()).split('\n').find((z) => z.startsWith('### 🔍 Results')) ?? '';
    expect(kopf).toMatch(/— keyword\)/);
  });
});
