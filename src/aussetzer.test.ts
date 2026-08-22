import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meldeEinmal, schonGemeldet, gemeldeteGruende, setzeAussetzerZurueck, OHNE_VEKTOREN, OHNE_DIENST, meldeUndVermerke, leseVermerke, SINNPFAD_ABBRUCH, VERSUCH_LEER, AUSSETZER_VORSATZ, AUSSETZER_TTL_SEKUNDEN, fehlerText, OHNE_SCHREIBVEKTOR } from './aussetzer.js';

/**
 * ABNAHME zur Karte g7bqqy8r7z0t — "Der Bedeutungsabgleich lief in Produktion
 * nie". Der Recall-Pfad stieg stumm aus. Diese Tests halten fest, dass er das
 * nicht mehr tut, und dass die Meldung nicht selbst zur Plage wird.
 */

describe('meldeEinmal', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setzeAussetzerZurueck();
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    setzeAussetzerZurueck();
  });

  it('meldet beim ersten Mal', () => {
    expect(meldeEinmal(OHNE_VEKTOREN, '0 von 506 Lektionen haben eine Einbettung')).toBe(true);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('meldet beim zweiten Mal NICHT mehr', () => {
    // Der Recall-Pfad laeuft bei jeder Anfrage. Eine Zeile je Anfrage waere
    // nach einer Stunde ein Protokoll, das niemand mehr liest — und das ist
    // wieder Stille.
    meldeEinmal(OHNE_VEKTOREN, 'erste');
    expect(meldeEinmal(OHNE_VEKTOREN, 'zweite')).toBe(false);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('haelt verschiedene Gruende auseinander', () => {
    meldeEinmal(OHNE_VEKTOREN, 'keine Vektoren');
    expect(meldeEinmal(OHNE_DIENST, 'kein Dienst')).toBe(true);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(gemeldeteGruende()).toEqual([OHNE_VEKTOREN, OHNE_DIENST]);
  });

  it('schreibt nach stderr, NICHT nach stdout', () => {
    // Ueber stdout laeuft das MCP-Protokoll. Eine Zeile Text dort ist kein
    // Hinweis, sondern ein Verbindungsabbruch.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    meldeEinmal(OHNE_VEKTOREN, 'irgendwas');
    expect(stdout, 'die Meldung ging nach stdout und wuerde das Protokoll zerstoeren').not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('die Meldung nennt Grund UND Auswirkung', () => {
    meldeEinmal(OHNE_VEKTOREN, '0 von 506 Lektionen haben eine Einbettung — nur Wortabgleich');
    const zeile = String(stderr.mock.calls[0]?.[0] ?? '');
    expect(zeile).toContain(OHNE_VEKTOREN);
    expect(zeile).toContain('506');
    expect(zeile).toContain('Wortabgleich');
  });
});

describe('schonGemeldet', () => {
  beforeEach(() => setzeAussetzerZurueck());
  afterEach(() => setzeAussetzerZurueck());

  it('ist am Anfang fuer jeden Grund falsch', () => {
    expect(schonGemeldet(OHNE_VEKTOREN)).toBe(false);
  });

  it('GEGENPROBE: ohne Meldung bleibt es falsch, mit Meldung wird es wahr', () => {
    // Ohne diese Gegenprobe waere ein gruener Lauf kein Beweis — schonGemeldet
    // koennte auch einfach immer dasselbe antworten.
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(schonGemeldet(OHNE_DIENST)).toBe(false);
    meldeEinmal(OHNE_DIENST, 'kein Einbettungsdienst eingerichtet');
    expect(schonGemeldet(OHNE_DIENST)).toBe(true);
    expect(schonGemeldet(OHNE_VEKTOREN), 'ein fremder Grund wurde mitgesetzt').toBe(false);
    stille.mockRestore();
  });
});

describe('setzeAussetzerZurueck', () => {
  it('macht die Merkliste wieder leer', () => {
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    meldeEinmal('probe', 'x');
    setzeAussetzerZurueck();
    expect(gemeldeteGruende()).toEqual([]);
    expect(meldeEinmal('probe', 'x'), 'nach dem Zuruecksetzen wurde nicht neu gemeldet').toBe(true);
    stille.mockRestore();
    setzeAussetzerZurueck();
  });
});

// ── Der Vermerk, der einen Neustart ueberlebt ───────────────────────────────
//
// Anlass: Karte opupbt3l9wcq. meldeEinmal merkt sich den Grund im
// Arbeitsspeicher — nach jedem Deploy ist die Meldung weg, und eine
// Fehlkonfiguration konnte wochenlang bestehen.

/** Kleiner Speicher, der sich wie die benutzten Redis-Befehle verhaelt. */
function speicherAttrappe(kaputtAb?: string) {
  const daten = new Map<string, Record<string, string>>();
  return {
    daten,
    ttl: new Map<string, number>(),
    async hincrby(key: string, field: string, inc: number) {
      if (kaputtAb === 'hincrby') throw new Error('Speicher weg');
      const h = daten.get(key) ?? {};
      h[field] = String((Number(h[field]) || 0) + inc);
      daten.set(key, h);
      return Number(h[field]);
    },
    async hset(key: string, values: Record<string, string>) {
      const h = daten.get(key) ?? {};
      Object.assign(h, values);
      daten.set(key, h);
      return 'OK';
    },
    async expire(key: string, seconds: number) {
      this.ttl.set(key, seconds);
      return 1;
    },
    async keys(pattern: string) {
      if (kaputtAb === 'keys') throw new Error('Speicher weg');
      const vorsatz = pattern.replace(/\*$/, '');
      return [...daten.keys()].filter((k) => k.startsWith(vorsatz));
    },
    async hgetall(key: string) {
      return daten.get(key) ?? {};
    },
  };
}

describe('meldeUndVermerke', () => {
  it('schreibt Zaehler, Zeitpunkt und Text — und setzt eine Lebensdauer', async () => {
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    setzeAussetzerZurueck();
    const s = speicherAttrappe();

    await meldeUndVermerke(s, SINNPFAD_ABBRUCH, 'der Bedeutungspfad brach ab');
    await meldeUndVermerke(s, SINNPFAD_ABBRUCH, 'nochmal');

    const eintrag = s.daten.get(`${AUSSETZER_VORSATZ}${SINNPFAD_ABBRUCH}`)!;
    expect(eintrag.anzahl, 'zwei Aussetzer, aber nur einer gezaehlt').toBe('2');
    expect(eintrag.text).toBe('nochmal');
    expect(eintrag.zuletzt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.ttl.get(`${AUSSETZER_VORSATZ}${SINNPFAD_ABBRUCH}`)).toBe(AUSSETZER_TTL_SEKUNDEN);
    stille.mockRestore();
    setzeAussetzerZurueck();
  });

  it('KONTROLLE: ein kaputter Speicher bricht die Anfrage NICHT ab', async () => {
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    setzeAussetzerZurueck();
    // Wer eine Suche abbricht, weil er den Ausfall nicht aufschreiben konnte,
    // hat aus einer Verschlechterung einen Ausfall gemacht.
    await expect(meldeUndVermerke(speicherAttrappe('hincrby'), SINNPFAD_ABBRUCH, 'x'))
      .resolves.toBe(true);
    // Aber der Rueckfall ist nicht still: er meldet sich unter eigenem Grund.
    expect(gemeldeteGruende()).toContain(`${SINNPFAD_ABBRUCH}-vermerk`);
    stille.mockRestore();
    setzeAussetzerZurueck();
  });

  it('ohne Speicher bleibt es bei der Meldung, ohne zu werfen', async () => {
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    setzeAussetzerZurueck();
    await expect(meldeUndVermerke(null, VERSUCH_LEER, 'x')).resolves.toBe(true);
    stille.mockRestore();
    setzeAussetzerZurueck();
  });
});

describe('leseVermerke', () => {
  it('liefert die Vermerke, der haeufigste zuerst', async () => {
    const stille = vi.spyOn(console, 'error').mockImplementation(() => {});
    setzeAussetzerZurueck();
    const s = speicherAttrappe();
    await meldeUndVermerke(s, VERSUCH_LEER, 'a');
    await meldeUndVermerke(s, SINNPFAD_ABBRUCH, 'b');
    await meldeUndVermerke(s, SINNPFAD_ABBRUCH, 'b');

    const v = await leseVermerke(s);
    expect(v!.map((x) => x.grund)).toEqual([SINNPFAD_ABBRUCH, VERSUCH_LEER]);
    expect(v![0].anzahl).toBe(2);
    stille.mockRestore();
    setzeAussetzerZurueck();
  });

  it('KONTROLLE: nicht messbar ist NICHT dasselbe wie nichts gefunden', async () => {
    // Genau dieser Unterschied fehlte an allen Stellen, aus denen dieses
    // Modul entstanden ist. null heisst "konnte nicht nachsehen", [] heisst
    // "nachgesehen, nichts da".
    expect(await leseVermerke(speicherAttrappe('keys')), 'Lesefehler wurde als "nichts da" gemeldet').toBe(null);
    expect(await leseVermerke(null)).toBe(null);
    expect(await leseVermerke(speicherAttrappe())).toEqual([]);
  });
});

/*
 * fehlerText — der Grund, den die drei leeren catch-Bloecke in
 * handlers/brain.ts bis zum 22.08.2026 weggeworfen haben.
 *
 * Die Probe deckt genau die Faelle ab, an denen ein blosses String(e)
 * scheitert. Sie ist keine Formsache: der Wachhund meldete zwei Tage lang
 * "Bedeutungsabgleich AUS", und die Ursache war nirgends aufgeschrieben.
 */
describe('fehlerText — macht aus jedem geworfenen Wert einen lesbaren Grund', () => {
  it('nimmt die Botschaft eines Error', () => {
    expect(fehlerText(new Error('fetch failed'))).toBe('fetch failed');
  });

  it('faellt bei einem Error OHNE Botschaft auf den Namen zurueck', () => {
    const e = new TypeError('');
    expect(fehlerText(e)).toBe('TypeError');
  });

  it('nimmt einen geworfenen Text unveraendert', () => {
    expect(fehlerText('429 Too Many Requests')).toBe('429 Too Many Requests');
  });

  it('benennt undefined und null, statt "undefined" zu schreiben', () => {
    // throw undefined kommt vor. "undefined" im Protokoll sieht aus wie ein
    // Fehler im Melder selbst.
    expect(fehlerText(undefined)).toContain('kein Grund mitgegeben');
    expect(fehlerText(null)).toContain('kein Grund mitgegeben');
  });

  it('macht aus einem leeren Objekt KEIN "[object Object]"', () => {
    // Genau der Fall, der die Ursachensuche wertlos macht.
    const t = fehlerText({});
    expect(t).not.toContain('[object Object]');
    expect(t).toContain('ohne Inhalt');
  });

  it('nimmt den Inhalt eines Objekts, wenn eines da ist', () => {
    expect(fehlerText({ status: 401, error: 'invalid token' })).toContain('invalid token');
  });

  it('kuerzt auf 200 Zeichen — eine Protokollzeile, keine HTML-Seite', () => {
    expect(fehlerText(new Error('x'.repeat(5000))).length).toBe(200);
    expect(fehlerText('y'.repeat(5000)).length).toBe(200);
  });

  it('wirft NIE selbst, auch nicht bei einem Ringschluss', () => {
    // Ein Melder, der beim Melden abstuerzt, verschluckt den Fehler erst recht.
    const ring: Record<string, unknown> = {};
    ring.selbst = ring;
    expect(() => fehlerText(ring)).not.toThrow();
    expect(fehlerText(ring)).toContain('nicht darstellbar');
  });

  it('der neue Grund ist ein eigener — nicht in die Suchgruende gemischt', () => {
    // Schreiben und Suchen sind zwei verschiedene Ausfaelle. Unter einem
    // Namen gefuehrt, sieht niemand, welcher von beiden vorliegt.
    expect(OHNE_SCHREIBVEKTOR).not.toBe(OHNE_VEKTOREN);
    expect(OHNE_SCHREIBVEKTOR).not.toBe(OHNE_DIENST);
    expect(OHNE_SCHREIBVEKTOR).not.toBe(SINNPFAD_ABBRUCH);
  });
});
