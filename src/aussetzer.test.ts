import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  meldeEinmal, schonGemeldet, gemeldeteGruende, setzeAussetzerZurueck,
  OHNE_VEKTOREN, OHNE_DIENST,
} from './aussetzer.js';

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
