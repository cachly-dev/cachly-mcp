import { describe, it, expect } from 'vitest';
import { safeJsonParse, leseOderNull, darfHeraus } from './utils.js';

/*
── Die vierte grün-blinde Fehlerform ────────────────────────────────────────

Benannt von Vinh Nguyen unter dem 204er-Artikel am 25.08.2026: ein Wächter
LIEST ABWESENHEIT und meldet einen Wert.

    const ld = safeJsonParse<{ visibility?: string }>(raw, {});
    if (ld.visibility === 'private') continue;     // undefined !== 'private'

Bei beschädigtem JSON gibt safeJsonParse das Ersatzobjekt zurück. Der
Vergleich schlägt fehl, die Lektion gilt als nicht privat — und geht heraus.

Das Gemeine daran: für diese Klasse gibt es keinen Known-Bad-Eingang. „Kein
visibility-Feld" und „Feld nicht lesbar" sind von innen dieselbe Beobachtung.
Testbar wird sie erst, wenn PRÄSENZ getrennt vom WERT geprüft wird — genau
das ist der Unterschied zwischen safeJsonParse und leseOderNull.
*/

describe('Absence-Reader: unlesbar ist keine Aussage', () => {
  it('DER FEHLER, festgenagelt: safeJsonParse macht aus kaputt "nicht privat"', () => {
    // Diese Zeile beschreibt den alten Zustand. Sie steht hier, damit
    // niemand ihn versehentlich wiederherstellt und für harmlos hält.
    const kaputt = '{"topic":"x","visibility":"priv';
    const alt = safeJsonParse<{ visibility?: string }>(kaputt, {});
    expect(alt.visibility).toBeUndefined();
    expect(alt.visibility === 'private', 'genau hier ging die Lektion heraus').toBe(false);
  });

  it('leseOderNull sagt "nicht lesbar" statt ein leeres Objekt zu liefern', () => {
    expect(leseOderNull('{"a":1')).toBeNull();
    expect(leseOderNull('')).toBeNull();
    expect(leseOderNull(null)).toBeNull();
    expect(leseOderNull(undefined)).toBeNull();
  });

  it('ein JSON-Skalar ist kein Datensatz', () => {
    // JSON.parse("3") gelingt. Jeder Feldzugriff darauf gibt undefined —
    // und wir wären wieder genau dort, wo wir nicht sein wollen.
    expect(leseOderNull('3')).toBeNull();
    expect(leseOderNull('"text"')).toBeNull();
    expect(leseOderNull('null')).toBeNull();
    expect(leseOderNull('true')).toBeNull();
  });

  it('eine Liste ist auch kein Datensatz', () => {
    expect(leseOderNull('[]')).toBeNull();
    expect(leseOderNull('[{"visibility":"private"}]')).toBeNull();
  });

  it('ein gueltiger Datensatz kommt durch', () => {
    expect(leseOderNull<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  describe('darfHeraus schliesst im Zweifel', () => {
    it('unlesbar heisst NEIN', () => {
      expect(darfHeraus(null)).toBe(false);
      expect(darfHeraus(leseOderNull('{"visibility":"priv'))).toBe(false);
    });

    it('privat heisst NEIN', () => {
      expect(darfHeraus({ visibility: 'private' })).toBe(false);
    });

    it('alles andere heisst ja', () => {
      expect(darfHeraus({ visibility: 'team' })).toBe(true);
      expect(darfHeraus({ visibility: 'public' })).toBe(true);
      // Ein Datensatz OHNE Feld ist lesbar und nicht privat — das ist eine
      // echte Aussage, keine Abwesenheit. Der Unterschied ist der Punkt.
      expect(darfHeraus({})).toBe(true);
    });

    it('GEGENPROBE: der alte Weg haette die kaputte Lektion durchgelassen', () => {
      const kaputt = '{"visibility":"priv';
      const alterWeg = safeJsonParse<{ visibility?: string }>(kaputt, {}).visibility !== 'private';
      const neuerWeg = darfHeraus(leseOderNull<{ visibility?: string }>(kaputt));
      expect(alterWeg, 'alter Weg: durchgelassen').toBe(true);
      expect(neuerWeg, 'neuer Weg: gesperrt').toBe(false);
      expect(alterWeg).not.toBe(neuerWeg);
    });
  });
});

/*
── Warum das ein TYPWÄCHTER ist und nicht nur eine Funktion ────────────────

`darfHeraus` ist als `lektion is T` deklariert. Damit weiss der Compiler nach

    if (!darfHeraus(ld)) continue;

dass `ld` nicht mehr null sein kann — und verweigert vorher jeden Feldzugriff.
Die Prüfung ist also nicht bloss empfohlen, sie ist erzwungen: wer sie
weglässt, bekommt einen Typfehler statt eines Lecks.
*/
describe('Der Compiler erzwingt die Pruefung', () => {
  it('nach darfHeraus ist der Datensatz nicht mehr null', () => {
    const ld = leseOderNull<{ visibility?: string; service?: string }>('{"service":"x"}');
    if (!darfHeraus(ld)) throw new Error('sollte durchkommen');
    // Ohne den Typwächter wäre die nächste Zeile ein Compile-Fehler.
    expect(ld.service).toBe('x');
  });
});

/*
── Dieselbe Klasse, andere Richtung ────────────────────────────────────────

Beim Ersetzt-Banner ist die sichere Antwort das Gegenteil: ein Nachfolger,
den wir nicht lesen können, muss als PRIVAT gelten. Sonst nennt der Banner
Name und Thema einer Lektion, deren Datensatz nur beschädigt ist — und
liefert die Abruf-Anleitung gleich mit.

Die Regel ist beide Male dieselbe: im Zweifel schliessen. Was „schliessen"
bedeutet, hängt an der Richtung.
*/
describe('Ersetzt-Banner: unlesbarer Nachfolger gilt als privat', () => {
  const istPrivat = (roh: string | null) =>
    roh ? !darfHeraus(leseOderNull<{ visibility?: string }>(roh)) : false

  it('kaputter Datensatz gilt als privat', () => {
    expect(istPrivat('{"visibility":"tea')).toBe(true)
  })

  it('privater Nachfolger gilt als privat', () => {
    expect(istPrivat('{"visibility":"private"}')).toBe(true)
  })

  it('team-sichtbarer Nachfolger darf genannt werden', () => {
    expect(istPrivat('{"visibility":"team","topic":"x"}')).toBe(false)
  })

  it('gar kein Nachfolger ist kein Banner', () => {
    expect(istPrivat(null)).toBe(false)
  })
})
