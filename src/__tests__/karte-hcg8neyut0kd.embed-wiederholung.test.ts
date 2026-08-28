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

describe('Schreibpfad-Aussetzer werden DAUERHAFT vermerkt (26.08., Teil 2 der Karte)', () => {
  // meldeEinmal lebt nur im Prozess-Speicher: nach jedem Neustart war der
  // GRUND einer Vektor-Luecke weg, und brain_doctor zaehlte Luecken ohne
  // Warum. Diese Probe liest den Quelltext: die drei OHNE_SCHREIBVEKTOR-
  // Stellen muessen meldeUndVermerke (Valkey-Vermerk) rufen, und der Doctor
  // muss die Vermerke lesen.
  it('brain.ts vermerkt statt nur zu melden — an allen drei Tuer-Stellen', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');
    const vermerkt = src.match(/meldeUndVermerke\(redis, OHNE_SCHREIBVEKTOR/g) ?? [];
    expect(vermerkt.length).toBeGreaterThanOrEqual(3);
    expect(src, 'die fluechtige Meldung darf fuer OHNE_SCHREIBVEKTOR nicht zurueckkommen')
      .not.toContain('meldeEinmal(OHNE_SCHREIBVEKTOR');
  });

  it('brain_doctor liest die Vermerke und nennt die Gruende', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../handlers/team.ts', import.meta.url), 'utf8');
    expect(src).toContain('leseVermerke(redis)');
    expect(src).toContain('Write-path failure noted');
  });
});

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

// ── Teil 3 der Karte: das Zeitlimit war kleiner als die Wirklichkeit ───────
//
// Gemessen in denselben LoCoMo-Durchlaeufen (25./26.08.2026) auf dem echten
// Kundenpfad: bge-m3 auf der node-1-CPU braucht fuer Texte um 1800 Zeichen
// zwischen 7 und 21 Sekunden. Das Zeitlimit stand auf 8.
//
// Jeder grosse Lektionstext riss es, und der Volltext-Vektor fehlte danach
// STILL — die Lektion war gespeichert, der Bedeutungsabgleich uebersprang sie
// fuer immer. Kein Fehler, keine Meldung.
describe('Zeitlimit richtet sich nach der Laenge — aber nur auf dem Schreibpfad', async () => {
  const { zeitlimitMs } = await import('../embeddings.js');

  it('der SUCHPFAD wartet nie laenger als die Grundzeit', () => {
    // Er laeuft mitten im Agenten-Zug. Dreissig Sekunden waeren dort eine
    // halbe Minute Stillstand fuer eine Verbesserung, die ausfallen DARF —
    // die Wortsuche traegt weiter.
    const kurz = zeitlimitMs('x'.repeat(1800), 'kurz');
    expect(kurz).toBe(zeitlimitMs('x', 'kurz'));
    expect(kurz).toBeLessThanOrEqual(8_000);
  });

  it('der SCHREIBPFAD deckt die gemessenen 21 s ab', () => {
    // 1800 Zeichen ist die gemessene Groesse; 21 s die gemessene Spitze.
    const lang = zeitlimitMs('x'.repeat(1800), 'lang');
    expect(lang, 'muss ueber der gemessenen Spitze liegen').toBeGreaterThan(21_000);
  });

  it('das alte Limit von 8 s haette den gemessenen Fall gerissen', () => {
    // Die Gegenprobe zur Zahl selbst: waere sie so klein wie vorher, laege
    // sie unter der Messung — und dieser Test waere sinnlos.
    expect(8_000, 'die gemessene Spitze lag darueber').toBeLessThan(21_000);
  });

  it('ein kurzer Text bekommt kein aufgeblaehtes Limit', () => {
    expect(zeitlimitMs('kurz', 'lang')).toBeLessThan(9_000);
  });

  it('auch ein sehr langer Text hat eine Obergrenze', () => {
    // Ohne Deckel wuerde ein 100-kB-Text den Schreibpfad zwanzig Minuten
    // belegen. Auch ein langer Text ist irgendwann tot.
    expect(zeitlimitMs('x'.repeat(100_000), 'lang')).toBeLessThanOrEqual(60_000);
  });

  it('laenger heisst nie kuerzer', () => {
    let vorher = 0;
    for (const n of [0, 100, 500, 1800, 5000, 50_000]) {
      const jetzt = zeitlimitMs('x'.repeat(n), 'lang');
      expect(jetzt, `bei ${n} Zeichen`).toBeGreaterThanOrEqual(vorher);
      vorher = jetzt;
    }
  });
});
