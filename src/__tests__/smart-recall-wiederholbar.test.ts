/**
 * Wiederholungstest fuer smart_recall (10.11.2026).
 *
 * Frage: Liefert smart_recall bei GLEICHER Frage auf GLEICHEM Bestand die
 * GLEICHEN Treffer in der GLEICHEN Reihenfolge? Die Abhakliste nannte rund
 * 8 % nicht wiederholbare Antworten; ohne Wiederholbarkeit ist jede
 * Bench-Zahl zweifelhaft.
 *
 * Aufbau: 40 Lektionen, davon viele mit gleichem Text unter verschiedenen
 * Themen (gleiche Punktzahl). 50 feste Fragen, jede zweimal, im Messmodus
 * CACHLY_RECALL_NUR_LESEN=1. Verglichen wird die Trefferliste (Themen UND
 * Reihenfolge). Zwischen den beiden Durchgaengen wird die Lesereihenfolge des
 * Speichers gedreht, wie sie ein echter Redis-SCAN nach Umbau oder Neustart
 * liefern kann.
 *
 * Gewollter Zufall im Produktmodus (ohne Messmodus): keiner in diesem Pfad.
 * Das Lernen (Erkundung) ist in Tests mit CACHLY_LERNEN=0 ausgeschaltet.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { wortindexEntwerten } from '../search.js';
import { MockRedis } from './redis-mock.js';

// 100 Abrufe je Test; auf einem ausgelasteten CI-Lauf reichen 20 s nicht (gemessen: Zeitueberschreitung).
const ZEITGRENZE = 180_000;

const noopApiFetch = (async () => null) as unknown as Parameters<typeof handleBrainTool>[3];

const AREAS = ['deploy', 'cache', 'login', 'backup', 'queue'];
const SYMPTOMS = [
  'Zeitueberschreitung beim Verbinden mit der Datenbank',
  'Speicher voll auf dem Server',
  'Zertifikat abgelaufen',
  'Port bereits belegt',
  'Token wurde abgelehnt',
  'Container startet immer wieder neu',
  'Migration bricht ab',
  'Warteschlange waechst ohne Ende',
];

function lektionen(): Array<{ topic: string; text: string; outcome: 'success' | 'failure' }> {
  const out: Array<{ topic: string; text: string; outcome: 'success' | 'failure' }> = [];
  for (let i = 0; i < 40; i++) {
    const area = AREAS[i % AREAS.length];
    const sym = SYMPTOMS[i % SYMPTOMS.length];
    // Je zwei Lektionen mit demselben Text unter verschiedenen Themen: gleiche Punktzahl.
    const text = `${area}: ${sym}. Loesung Nummer ${Math.floor(i / 2)}.`;
    out.push({ topic: `${area}:fall-${i}`, text, outcome: i % 7 === 0 ? 'failure' : 'success' });
  }
  return out;
}

function fragen(): string[] {
  const q: string[] = [];
  for (let i = 0; i < 50; i++) {
    q.push(`${AREAS[i % AREAS.length]} ${SYMPTOMS[(i * 3) % SYMPTOMS.length]}`);
  }
  return q;
}

function themen(antwort: string): string[] {
  return [...antwort.matchAll(/`?([a-z]+:fall-\d+)`?/g)].map((m) => m[1]);
}

class UmgekehrtRedis extends MockRedis {
  umkehren = false;
  scanStream(opts: { match: string; count?: number }) {
    const em = super.scanStream(opts);
    if (!this.umkehren) return em;
    const orig = em.emit.bind(em);
    em.emit = ((ev: string, ...a: unknown[]) =>
      orig(ev, ...(ev === 'data' && Array.isArray(a[0]) ? [[...(a[0] as string[])].reverse()] : a))) as typeof em.emit;
    return em;
  }
}

describe.each([
  [false, 'gleicher Zeitstempel'],
  [true, 'gestreute Zeitstempel, Uhr zwischen den Durchgaengen 40 Tage weiter'],
])('smart_recall: gleiche Frage, gleiche Treffer (Messmodus, %#)', (streuen, _name) => {
  const redis = new UmgekehrtRedis();
  const getConn = async () => redis as unknown as Redis;
  const alt = process.env.CACHLY_RECALL_NUR_LESEN;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 10) });
    process.env.CACHLY_RECALL_NUR_LESEN = '1';
    for (const l of lektionen()) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: 'w1', topic: l.topic, outcome: l.outcome,
        what_worked: l.text, what_failed: l.outcome === 'failure' ? 'falsch geraten' : undefined,
      }, getConn, noopApiFetch);
    }
    // Wie bei einem Stapel-Import (Bench-Bestand): alle Lektionen mit demselben
    // Zeitstempel. Dann trennt nur noch die Lesereihenfolge gleiche Punktzahlen.
    for (const l of lektionen()) {
      const k = `cachly:lesson:best:${l.topic}`;
      const o = JSON.parse((await redis.get(k))!) as Record<string, unknown>;
      // Im zweiten Test streuen die Zeitstempel ueber 40 Tage (je Lektion ein Tag).
      const tag = streuen ? Number(l.topic.split('fall-')[1]) : 0;
      const zeit = new Date(Date.UTC(2026, 9, 1) + tag * 86_400_000).toISOString();
      o.ts = zeit;
      o.verified_at = zeit;
      await redis.set(k, JSON.stringify(o));
    }
    wortindexEntwerten();
  }, ZEITGRENZE);
  afterAll(() => {
    vi.useRealTimers();
    if (alt === undefined) delete process.env.CACHLY_RECALL_NUR_LESEN; else process.env.CACHLY_RECALL_NUR_LESEN = alt;
  });

  async function durchgang(): Promise<string[][]> {
    const res: string[][] = [];
    for (const f of fragen()) {
      res.push(themen(String(await handleBrainTool('smart_recall', { instance_id: 'w1', query: f }, getConn, noopApiFetch))));
    }
    return res;
  }

  /** Die Uhr laeuft zwischen den Durchgaengen weiter (nur im Test mit gestreuten Zeitstempeln). */
  function uhrWeiter(): void {
    if (streuen) vi.setSystemTime(Date.now() + 40 * 86_400_000);
  }

  it(`${_name}: 50 Fragen, je zweimal, gleiche Lesereihenfolge: alle 50 gleich`, async () => {
    const a = await durchgang();
    wortindexEntwerten();
    uhrWeiter();
    const b = await durchgang();
    const gleich = a.filter((x, i) => JSON.stringify(x) === JSON.stringify(b[i])).length;
    console.log(`WIEDERHOLBAR [${_name}] (gleiche Reihenfolge): ${gleich} von 50`);
    expect(a.every((x) => x.length > 0)).toBe(true);
    expect(gleich).toBe(50);
  }, ZEITGRENZE);

  it(`${_name}: 50 Fragen, je zweimal, Lesereihenfolge des Speichers gedreht: alle 50 gleich`, async () => {
    redis.umkehren = false;
    const a = await durchgang();
    // Der Wortbestand steht eine Minute im Zwischenspeicher; danach (oder nach
    // einem Neustart) wird er in der Lesereihenfolge des Speichers neu gebaut.
    wortindexEntwerten();
    uhrWeiter();
    redis.umkehren = true;
    const b = await durchgang();
    redis.umkehren = false;
    const gleich = a.filter((x, i) => JSON.stringify(x) === JSON.stringify(b[i])).length;
    console.log(`WIEDERHOLBAR [${_name}] (gedrehte Reihenfolge): ${gleich} von 50`);
    expect(gleich).toBe(50);
  }, ZEITGRENZE);
});
