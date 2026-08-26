/**
 * ABNAHME zur Karte hcg8neyut0kd — Embed-Client wiederholt voruebergehende
 * Fehler, statt Lektionen dauerhaft ohne Vektor zu lassen.
 *
 * Beleg 26.08.2026 (LoCoMo-Smoke ueber den Produktpfad): EIN "fetch failed"
 * mitten im Lauf, und die Lektion stand ohne Volltext-Vektor im Bestand —
 * unsichtbar fuer den Bedeutungsabgleich, ohne zweiten Versuch. Eine Suche
 * fiel im selben Lauf still auf Woerter zurueck.
 *
 * Politik (wiederholungMs, rein und hier festgenagelt):
 *  - Netzfehler (fetch failed, ECONNRESET, ...) werden wiederholt.
 *  - 429/5xx werden wiederholt; 429 wartet den Retry-After-Wunsch ab —
 *    aber nur der geduldige Schreibpfad ('lang') sitzt ein Rate-Fenster ab.
 *  - Timeouts werden NICHT wiederholt (der Suchpfad darf nie haengen).
 *  - Klientenfehler (400/401/403) werden NIE wiederholt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CACHLY_EMBED_PROVIDER = 'cachly';
process.env.CACHLY_JWT ||= 'test-jwt';
const { computeEmbedding, wiederholungMs, istVoruebergehend } = await import('../embeddings.js');

const netzfehler = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const statusfehler = (status: number, retryAfterSek: number | null = null) =>
  Object.assign(new Error(`Cachly embed API error ${status}: x`), { status, retryAfterSek });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('istVoruebergehend — die Fehlerklassen', () => {
  it('Netzfehler und 429/5xx sind voruebergehend', () => {
    expect(istVoruebergehend(netzfehler())).toBe(true);
    expect(istVoruebergehend(statusfehler(429))).toBe(true);
    expect(istVoruebergehend(statusfehler(503))).toBe(true);
  });
  it('KONTROLLE: Timeout, Klientenfehler und Konfig-Fehler sind es NICHT', () => {
    expect(istVoruebergehend(timeout())).toBe(false);
    expect(istVoruebergehend(statusfehler(400))).toBe(false);
    expect(istVoruebergehend(statusfehler(401))).toBe(false);
    expect(istVoruebergehend(new Error('CACHLY_JWT not set.'))).toBe(false);
  });
});

describe('wiederholungMs — die Politik als Tabelle', () => {
  it('kurz: Netzfehler bekommen schnelle Anlaeufe, dann Schluss', () => {
    expect(wiederholungMs(netzfehler(), 1, 'kurz')).toBe(250);
    expect(wiederholungMs(netzfehler(), 2, 'kurz')).toBe(500);
    expect(wiederholungMs(netzfehler(), 3, 'kurz')).toBe(null); // 3 Versuche = Ende
  });
  it('lang: exponentiell bis 8 s, vier Versuche', () => {
    expect(wiederholungMs(netzfehler(), 1, 'lang')).toBe(1_000);
    expect(wiederholungMs(netzfehler(), 3, 'lang')).toBe(4_000);
    expect(wiederholungMs(netzfehler(), 4, 'lang')).toBe(null);
  });
  it('429 mit Retry-After: lang sitzt das Fenster ab (gedeckelt 61 s)', () => {
    expect(wiederholungMs(statusfehler(429, 45), 1, 'lang')).toBe(45_000);
    expect(wiederholungMs(statusfehler(429, 300), 1, 'lang')).toBe(61_000);
  });
  it('KONTROLLE: kurz sitzt KEIN Rate-Fenster ab — ueber 2 s heisst aufgeben', () => {
    expect(wiederholungMs(statusfehler(429, 45), 1, 'kurz')).toBe(null);
    expect(wiederholungMs(statusfehler(429, 1), 1, 'kurz')).toBe(1_000);
  });
  it('KONTROLLE: Timeout und 400 werden nie wiederholt, auch nicht lang', () => {
    expect(wiederholungMs(timeout(), 1, 'lang')).toBe(null);
    expect(wiederholungMs(statusfehler(400), 1, 'lang')).toBe(null);
  });
});

describe('computeEmbedding — der Wrapper am gestubbten fetch', () => {
  const echteFetch = globalThis.fetch;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { globalThis.fetch = echteFetch; });

  const ok = () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => '', json: async () => ({ embedding: [0.1, 0.2], dimensions: 2 }),
  }) as unknown as Response;

  it('ein einzelner Netz-Blip kostet keinen Vektor mehr', async () => {
    let rufe = 0;
    globalThis.fetch = (async () => {
      rufe++;
      if (rufe === 1) throw netzfehler();
      return ok();
    }) as typeof fetch;
    const v = await computeEmbedding('hallo');
    expect(v).toEqual([0.1, 0.2]);
    expect(rufe).toBe(2);
  });

  it('429 mit Retry-After 0 wird sofort wiederholt (lang)', async () => {
    let rufe = 0;
    globalThis.fetch = (async () => {
      rufe++;
      if (rufe === 1) return {
        ok: false, status: 429,
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '0' : null) },
        text: async () => '{"error":"embedding rate limit exceeded"}',
      } as unknown as Response;
      return ok();
    }) as typeof fetch;
    const v = await computeEmbedding('hallo', { geduld: 'lang' });
    expect(v).toEqual([0.1, 0.2]);
    expect(rufe).toBe(2);
  });

  it('KONTROLLE: ein 401 wird NICHT wiederholt — genau ein Ruf, Fehler fliegt', async () => {
    let rufe = 0;
    globalThis.fetch = (async () => {
      rufe++;
      return {
        ok: false, status: 401,
        headers: { get: () => null },
        text: async () => 'unauthorized',
      } as unknown as Response;
    }) as typeof fetch;
    await expect(computeEmbedding('hallo')).rejects.toThrow('401');
    expect(rufe).toBe(1);
  });

  it('KONTROLLE: dauerhafter Netzausfall endet nach den kurzen Versuchen', async () => {
    let rufe = 0;
    globalThis.fetch = (async () => { rufe++; throw netzfehler(); }) as typeof fetch;
    await expect(computeEmbedding('hallo')).rejects.toThrow('fetch failed');
    expect(rufe).toBe(3);
  });
});
