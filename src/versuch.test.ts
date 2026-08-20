/**
 * Wächter für die Versuchs-Messtechnik (dev.to "rules-before-the-run").
 *
 * Geprüft wird die Messtechnik selbst — nicht der Versuch, der ist noch nicht
 * gestartet. Jede Gegenprobe hier beweist, dass ein Signal auch wirklich das
 * misst, was es zu messen behauptet — nicht nur, dass es irgendetwas liefert.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import {
  VERSUCH_ENV, VERSUCH_SALZ_ENV, OHNE_SALZ,
  versuchStart, neueKennung, zuteilung, type Zuteilung,
  istZulassungsfaehig, zulassungsGrund, ZULASSUNGS_SCHWELLE,
  KANARIEN_MARKIERUNG, markiereDatensatz, kanarienUeberlebt, entferneMarkierung,
  hashFrage, turnSchluessel, schreibeTurnProtokoll,
  themaVon, wendeZuteilungAn, schliesseVersuchAb,
  type VersuchTreffer, type VersuchProtokollTeil,
} from './versuch.js';
import { setzeAussetzerZurueck } from './aussetzer.js';
import { handleBrainTool } from './handlers/brain.js';

// ── Umgebung sauber halten ───────────────────────────────────────────────────
// Jeder Test bekommt eine leere Umgebung fuer die zwei Versuchs-Variablen und
// eine leere Meldeliste — sonst faerbt ein Test in den naechsten ab.
const ALT_VERSUCH = process.env[VERSUCH_ENV];
const ALT_SALZ = process.env[VERSUCH_SALZ_ENV];

beforeEach(() => {
  delete process.env[VERSUCH_ENV];
  delete process.env[VERSUCH_SALZ_ENV];
  setzeAussetzerZurueck();
});

afterEach(() => {
  if (ALT_VERSUCH === undefined) delete process.env[VERSUCH_ENV]; else process.env[VERSUCH_ENV] = ALT_VERSUCH;
  if (ALT_SALZ === undefined) delete process.env[VERSUCH_SALZ_ENV]; else process.env[VERSUCH_SALZ_ENV] = ALT_SALZ;
  setzeAussetzerZurueck();
});

// ── Der Schalter ─────────────────────────────────────────────────────────────

describe('versuchStart — der Schalter', () => {
  it('ist ohne die Variable "aus": gibt null zurueck', () => {
    expect(versuchStart()).toBeNull();
  });

  it('ist bei CACHLY_VERSUCH="aus" ausdruecklich "aus"', () => {
    process.env[VERSUCH_ENV] = 'aus';
    process.env[VERSUCH_SALZ_ENV] = 'irgendein-salz';
    expect(versuchStart()).toBeNull();
  });

  it('gibt das Salz zurueck, wenn "an" UND Salz gesetzt sind', () => {
    process.env[VERSUCH_ENV] = 'an';
    process.env[VERSUCH_SALZ_ENV] = 'mein-salz';
    expect(versuchStart()).toBe('mein-salz');
  });

  it('verhaelt sich bei fehlendem Salz wie "aus" UND meldet es', () => {
    process.env[VERSUCH_ENV] = 'an';
    // VERSUCH_SALZ_ENV bleibt unbesetzt.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(versuchStart()).toBeNull();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(OHNE_SALZ);
    stderr.mockRestore();
  });

  it('meldet das fehlende Salz nur EINMAL je Prozess', () => {
    process.env[VERSUCH_ENV] = 'an';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    versuchStart();
    versuchStart();
    versuchStart();
    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });
});

// ── Turn-Kennung ─────────────────────────────────────────────────────────────

describe('neueKennung', () => {
  it('ist stabil in einer Zeile lesbar (keine Zeilenumbrueche, keine Leerzeichen)', () => {
    const k = neueKennung();
    expect(k).not.toContain('\n');
    expect(k).not.toContain(' ');
    expect(k.length).toBeGreaterThan(10);
  });

  it('erzeugt bei zwei Aufrufen zwei verschiedene Kennungen', () => {
    const a = neueKennung();
    const b = neueKennung();
    expect(a).not.toBe(b);
  });
});

// ── Zuteilung ────────────────────────────────────────────────────────────────

describe('zuteilung', () => {
  it('ist bei gleicher Kennung und gleichem Salz IMMER dieselbe', () => {
    const k = 'turn-abc-123';
    const s = 'salz-x';
    const erste = zuteilung(k, s);
    expect(zuteilung(k, s)).toBe(erste);
    expect(zuteilung(k, s)).toBe(erste);
  });

  it('liegt bei rund 1000 erfundenen Kennungen zwischen 45 und 55 Prozent HOLD', () => {
    const salz = 'bench-salz';
    let hold = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (zuteilung(`kennung-${i}`, salz) === 'HOLD') hold++;
    }
    const anteil = (hold / N) * 100;
    expect(anteil).toBeGreaterThanOrEqual(45);
    expect(anteil).toBeLessThanOrEqual(55);
  });

  it('GEGENPROBE: ein anderes Salz ergibt eine andere Zuteilung', () => {
    // Sonst waere das Salz wirkungslos — mindestens EINE der 300 Kennungen
    // muss unter den beiden Salzen unterschiedlich ausfallen.
    let unterschiedlich = 0;
    for (let i = 0; i < 300; i++) {
      const k = `probe-${i}`;
      if (zuteilung(k, 'salz-a') !== zuteilung(k, 'salz-b')) unterschiedlich++;
    }
    expect(unterschiedlich).toBeGreaterThan(0);
  });

  it('liefert nur HOLD oder DELIVER', () => {
    const erlaubte: Zuteilung[] = ['HOLD', 'DELIVER'];
    for (let i = 0; i < 50; i++) {
      expect(erlaubte).toContain(zuteilung(`x${i}`, 'salz'));
    }
  });
});

// ── Zulassung ────────────────────────────────────────────────────────────────

describe('Zulassung', () => {
  it('ist ohne Treffer ueber der Schwelle NICHT zulassungsfaehig', () => {
    expect(istZulassungsfaehig(0)).toBe(false);
    expect(istZulassungsfaehig(-1)).toBe(false);
    expect(zulassungsGrund(0)).toBeDefined();
    expect(zulassungsGrund(0)).toContain(String(ZULASSUNGS_SCHWELLE));
  });

  it('ist MIT einem Treffer ueber der Schwelle zulassungsfaehig', () => {
    expect(istZulassungsfaehig(0.42)).toBe(true);
    expect(zulassungsGrund(0.42)).toBeUndefined();
  });
});

// ── Kanarienvogel ────────────────────────────────────────────────────────────

describe('Kanarienvogel', () => {
  it('ueberlebt im vollstaendigen Text', () => {
    const langerText = 'Vorspann. '.repeat(20) + 'Die gesuchte Adresse ist 10.8.0.7 am Ende.';
    const markiert = langerText + KANARIEN_MARKIERUNG;
    const antwort = `Ergebnis:\n${markiert}\nEnde der Antwort.`;
    expect(kanarienUeberlebt(antwort)).toBe(true);
  });

  it('GEGENPROBE — die wichtigste: fehlt im abgeschnittenen Text (nachgebauter Anlass: Schnitt bei 100 Zeichen)', () => {
    const langerText = 'Vorspann. '.repeat(20) + 'Die gesuchte Adresse ist 10.8.0.7 am Ende.';
    const markiert = langerText + KANARIEN_MARKIERUNG;
    const vollstaendigeAntwort = `Ergebnis:\n${markiert}\nEnde der Antwort.`;
    // Nachbau des Anlasses vom 16.08.: eine Anzeige, die stumpf bei 100
    // Zeichen abschneidet. Die Markierung sass am Ende — genau dort, wo
    // dieser Schnitt sie erwischt.
    const abgeschnitten = vollstaendigeAntwort.slice(0, 100);
    expect(abgeschnitten.length).toBe(100);
    expect(kanarienUeberlebt(abgeschnitten)).toBe(false);
  });

  it('markiert eine Lektion im what_worked-Feld, JSON bleibt gueltig', () => {
    const lektion = JSON.stringify({ topic: 'x:y', outcome: 'success', what_worked: 'kurzer Text' });
    const markiert = markiereDatensatz(lektion);
    const geparst = JSON.parse(markiert) as { what_worked: string; topic: string };
    expect(geparst.topic).toBe('x:y'); // andere Felder unangetastet
    expect(geparst.what_worked.endsWith(KANARIEN_MARKIERUNG)).toBe(true);
    expect(kanarienUeberlebt(markiert)).toBe(true);
  });

  it('haengt bei Nicht-JSON-Inhalt (z. B. Kontext-Eintraege) roh ans Ende an', () => {
    const roh = 'ein einfacher Kontext-Text, kein JSON';
    const markiert = markiereDatensatz(roh);
    expect(markiert).toBe(roh + KANARIEN_MARKIERUNG);
  });

  it('entferneMarkierung macht den Text wieder byte-identisch zum Original', () => {
    const original = 'Text ohne jede Markierung.';
    const markiert = original + KANARIEN_MARKIERUNG + ' und mehr';
    const bereinigt = entferneMarkierung(markiert);
    expect(bereinigt).toBe(original + ' und mehr');
    expect(bereinigt).not.toContain(KANARIEN_MARKIERUNG);
  });

  it('die Markierung ist unsichtbar: keine sichtbaren Zeichen, keine normalen Leerzeichen', () => {
    // \s trifft in JS kein U+200B — das ist die Eigenschaft, auf die sich
    // markiereDatensatz verlaesst (siehe Dateikopf von versuch.ts).
    expect(/\s/.test(KANARIEN_MARKIERUNG)).toBe(false);
    expect(KANARIEN_MARKIERUNG.trim()).toBe(KANARIEN_MARKIERUNG);
  });
});

// ── Frage-Hash ───────────────────────────────────────────────────────────────

describe('hashFrage', () => {
  it('speichert nie die Frage selbst — nur einen Hash fester Laenge', () => {
    const frage = 'wie verbindet man sich wirklich mit node-4?';
    const h = hashFrage(frage);
    expect(h).not.toContain(frage);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ist fuer dieselbe Frage stabil', () => {
    expect(hashFrage('immer dieselbe Frage')).toBe(hashFrage('immer dieselbe Frage'));
  });
});

// ── wendeZuteilungAn (reine Funktion) ────────────────────────────────────────

describe('wendeZuteilungAn', () => {
  const treffer: VersuchTreffer[] = [
    { key: 'cachly:lesson:best:a:eins', content: JSON.stringify({ what_worked: 'loesung eins' }), punktzahl: 0.9 },
    { key: 'cachly:lesson:best:b:zwei', content: JSON.stringify({ what_worked: 'loesung zwei' }), punktzahl: 0.5 },
  ];

  it('entfernt bei HOLD den besten Treffer, die uebrigen bleiben', () => {
    // Kennung/Salz-Kombination, die deterministisch HOLD ergibt.
    let kennung = '';
    for (let i = 0; i < 1000; i++) {
      const probe = `hold-suche-${i}`;
      if (zuteilung(probe, 'fixes-salz') === 'HOLD') { kennung = probe; break; }
    }
    expect(kennung).not.toBe('');
    const ergebnis = wendeZuteilungAn(treffer, kennung, 'fixes-salz', 0.9);
    expect(ergebnis.zuteilung).toBe('HOLD');
    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.key).toBe('cachly:lesson:best:b:zwei');
    expect(ergebnis.weggelassenesThema).toBe('a:eins');
    expect(ergebnis.markierungGesetzt).toBe(false);
  });

  it('markiert bei DELIVER den besten Treffer, entfernt nichts', () => {
    let kennung = '';
    for (let i = 0; i < 1000; i++) {
      const probe = `deliver-suche-${i}`;
      if (zuteilung(probe, 'fixes-salz') === 'DELIVER') { kennung = probe; break; }
    }
    expect(kennung).not.toBe('');
    const ergebnis = wendeZuteilungAn(treffer, kennung, 'fixes-salz', 0.9);
    expect(ergebnis.zuteilung).toBe('DELIVER');
    expect(ergebnis.treffer).toHaveLength(2);
    expect(ergebnis.markierungGesetzt).toBe(true);
    expect(kanarienUeberlebt(ergebnis.treffer[0]!.content)).toBe(true);
    expect(ergebnis.weggelassenesThema).toBeUndefined();
  });

  it('tut bei fehlender Zulassung nichts, egal was die Zuteilung sagt', () => {
    const ergebnis = wendeZuteilungAn(treffer, 'irgendeine-kennung', 'irgendein-salz', 0);
    expect(ergebnis.zulassungsfaehig).toBe(false);
    expect(ergebnis.treffer).toHaveLength(2);
    expect(ergebnis.markierungGesetzt).toBe(false);
    expect(ergebnis.weggelassenesThema).toBeUndefined();
  });

  it('kommt mit einer leeren Trefferliste klar', () => {
    const ergebnis = wendeZuteilungAn([], 'k', 's', 0);
    expect(ergebnis.treffer).toEqual([]);
    expect(ergebnis.markierungGesetzt).toBe(false);
  });
});

// ── themaVon ─────────────────────────────────────────────────────────────────

describe('themaVon', () => {
  it('entfernt das Lektions-Praefix', () => {
    expect(themaVon('cachly:lesson:best:deploy:x')).toBe('deploy:x');
  });
  it('laesst fremde Schluessel unangetastet', () => {
    expect(themaVon('cachly:ctx:irgendwas')).toBe('cachly:ctx:irgendwas');
  });
});

// ── Turn-Protokoll nach Redis ────────────────────────────────────────────────

class FakeRedis {
  store = new Map<string, string>();
  ttl = new Map<string, number>();
  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    const exIdx = args.indexOf('EX');
    if (exIdx >= 0) this.ttl.set(key, Number(args[exIdx + 1]));
    return 'OK';
  }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
}

describe('schreibeTurnProtokoll', () => {
  it('schreibt unter cachly:versuch:turn:<kennung> mit 90 Tagen TTL', async () => {
    const redis = new FakeRedis();
    await schreibeTurnProtokoll(redis as unknown as Redis, 'k-1', {
      ts: '2026-08-20T00:00:00.000Z', frageHash: 'x'.repeat(64), hoechstePunktzahl: 0.5,
      themen: ['a:b'], zulassungsfaehig: true, zuteilung: 'DELIVER', kanarienBestanden: true,
    });
    expect(redis.store.get(turnSchluessel('k-1'))).toBeDefined();
    expect(redis.ttl.get(turnSchluessel('k-1'))).toBe(90 * 24 * 60 * 60);
    const gespeichert = JSON.parse(redis.store.get(turnSchluessel('k-1'))!) as { frageHash: string };
    expect(gespeichert.frageHash).toBe('x'.repeat(64));
  });

  it('wirft NICHT, wenn Redis scheitert — eine gescheiterte Suche waere schlimmer', async () => {
    const kaputterRedis = { set: async () => { throw new Error('redis ist weg'); } };
    await expect(
      schreibeTurnProtokoll(kaputterRedis as unknown as Redis, 'k-2', {
        ts: 't', frageHash: 'h', hoechstePunktzahl: 0, themen: [],
        zulassungsfaehig: false, zuteilung: 'HOLD', kanarienBestanden: false,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── schliesseVersuchAb ───────────────────────────────────────────────────────

describe('schliesseVersuchAb', () => {
  const basisTeil: VersuchProtokollTeil = {
    frage: 'irgendeine frage', hoechstePunktzahl: 0.7, themen: ['a:b'],
    zulassungsfaehig: true, zuteilung: 'DELIVER', markierungGesetzt: true,
  };

  it('meldet Kanarienvogel bestanden, wenn die Markierung ueberlebt hat, und entfernt sie', async () => {
    const redis = new FakeRedis();
    const antwortMitMarkierung = `Text vor der Markierung${KANARIEN_MARKIERUNG}Text danach`;
    const ergebnis = schliesseVersuchAb(redis as unknown as Redis, 'k-3', basisTeil, antwortMitMarkierung);
    expect(ergebnis).not.toContain(KANARIEN_MARKIERUNG);
    expect(ergebnis).toBe('Text vor der MarkierungText danach');
    // Die Redis-Schreibung ist fire-and-forget — kurz nachschauen reicht.
    await new Promise((r) => setTimeout(r, 0));
    const gespeichert = JSON.parse(redis.store.get(turnSchluessel('k-3'))!) as { kanarienBestanden: boolean };
    expect(gespeichert.kanarienBestanden).toBe(true);
  });

  it('meldet Kanarienvogel NICHT bestanden, wenn die Markierung fehlt', async () => {
    const redis = new FakeRedis();
    const abgeschnitteneAntwort = 'Text ohne die Markierung, wurde gekuerzt';
    schliesseVersuchAb(redis as unknown as Redis, 'k-4', basisTeil, abgeschnitteneAntwort);
    await new Promise((r) => setTimeout(r, 0));
    const gespeichert = JSON.parse(redis.store.get(turnSchluessel('k-4'))!) as { kanarienBestanden: boolean };
    expect(gespeichert.kanarienBestanden).toBe(false);
  });

  it('prueft den Kanarienvogel gar nicht erst, wenn keine Markierung gesetzt wurde (HOLD)', async () => {
    const redis = new FakeRedis();
    const teilOhneMarkierung: VersuchProtokollTeil = { ...basisTeil, markierungGesetzt: false, zuteilung: 'HOLD' };
    schliesseVersuchAb(redis as unknown as Redis, 'k-5', teilOhneMarkierung, 'irgendein Text');
    await new Promise((r) => setTimeout(r, 0));
    const gespeichert = JSON.parse(redis.store.get(turnSchluessel('k-5'))!) as { kanarienBestanden: boolean };
    expect(gespeichert.kanarienBestanden).toBe(false);
  });
});

// ── Integration: der Schalter im echten Recall-Pfad ─────────────────────────
//
// Alles oben testet versuch.ts fuer sich. Diese Gruppe beweist die eigentliche
// Zusage: mit CACHLY_VERSUCH="aus" (bzw. gar nicht gesetzt) liefert
// smart_recall Zeichen fuer Zeichen dieselbe Antwort wie vorher — der
// Anschluss in handlers/brain.ts aendert im "aus"-Fall nichts.

/** Winziger In-Memory-Redis — deckt nur ab, was smart_recall wirklich braucht. */
class MockRedis {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> { this.store.set(key, value); return 'OK'; }
  async incr(key: string): Promise<number> {
    const n = parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(n));
    return n;
  }
  async incrbyfloat(key: string, inc: number): Promise<string> {
    const n = parseFloat(this.store.get(key) ?? '0') + inc;
    this.store.set(key, String(n));
    return String(n);
  }
  async sadd(_key: string, ..._m: string[]): Promise<number> { return 1; }
  async smembers(_key: string): Promise<string[]> { return []; }
  async mget(...keys: string[]): Promise<(string | null)[]> { return keys.map((k) => this.store.get(k) ?? null); }
  async rpush(_key: string, ..._v: string[]): Promise<number> { return 1; }
  async ltrim(): Promise<'OK'> { return 'OK'; }
  async expire(): Promise<number> { return 1; }
  async del(...keys: string[]): Promise<number> { let c = 0; for (const k of keys) if (this.store.delete(k)) c++; return c; }
  async exists(key: string): Promise<number> { return this.store.has(key) ? 1 : 0; }
  pipeline() {
    const commands: string[] = [];
    const store = this.store;
    return {
      get(key: string) { commands.push(key); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        return commands.map((k) => [null, store.get(k) ?? null]);
      },
    };
  }
  scanStream(opts: { match: string }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter((k) => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }
}

async function seedLektion(redis: MockRedis, topic: string, whatWorked: string): Promise<void> {
  const ts = new Date().toISOString();
  await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
    topic, outcome: 'success', what_worked: whatWorked, severity: 'minor',
    recall_count: 3, ts, verified_at: ts, confidence: 1.0, tags: [],
  }));
}

const noopApiFetch = (async () => null) as unknown as Parameters<typeof handleBrainTool>[3];

describe('Integration: Schalter aus -> smart_recall unveraendert', () => {
  it('liefert bei CACHLY_VERSUCH unbesetzt exakt dieselbe Antwort wie bei explizit "aus"', async () => {
    const redisA = new MockRedis();
    await seedLektion(redisA, 'deploy:zeitfenster', 'ein kurzer Loesungstext fuer den Deploy-Zeitfenster-Fehler');
    delete process.env[VERSUCH_ENV];
    const antwortOhneSchalter = await handleBrainTool(
      'smart_recall', { instance_id: 'i1', query: 'zeitfenster deploy' },
      async () => redisA as unknown as Redis, noopApiFetch,
    );

    const redisB = new MockRedis();
    await seedLektion(redisB, 'deploy:zeitfenster', 'ein kurzer Loesungstext fuer den Deploy-Zeitfenster-Fehler');
    process.env[VERSUCH_ENV] = 'aus';
    const antwortMitAus = await handleBrainTool(
      'smart_recall', { instance_id: 'i1', query: 'zeitfenster deploy' },
      async () => redisB as unknown as Redis, noopApiFetch,
    );

    expect(antwortMitAus).toBe(antwortOhneSchalter);
  });

  it('schreibt bei "aus" keinen Turn-Eintrag nach Redis', async () => {
    const redis = new MockRedis();
    await seedLektion(redis, 'ci:cache', 'restore keys vor dem Build');
    process.env[VERSUCH_ENV] = 'aus';
    await handleBrainTool(
      'smart_recall', { instance_id: 'i1', query: 'ci cache' },
      async () => redis as unknown as Redis, noopApiFetch,
    );
    const turnKeys = [...(redis as unknown as { store: Map<string, string> }).store.keys()]
      .filter((k) => k.startsWith('cachly:versuch:turn:'));
    expect(turnKeys).toEqual([]);
  });
});
