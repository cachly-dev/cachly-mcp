/**
 * Proben fuer die Varianten-Interferenz.
 *
 * Das Modul ist am 21.08.2026 gemessen und im Recall-Pfad NICHT verdrahtet
 * worden (siehe Dateikopf von interferenz.ts). Die Proben bleiben trotzdem:
 * ohne sie ist der naechste Anlauf gezwungen, bei null anzufangen — und die
 * Diagnose, die den Ausschlag gab, steht in ihnen fest.
 */
import { describe, it, expect } from 'vitest';
import { varianten, ueberlagere, type Kandidat } from './interferenz.js';
import { kosinus } from './bedeutung.js';

const frage = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7));

describe('varianten', () => {
  it('gibt die unveraenderte Frage als Variante 0 zurueck', () => {
    // Damit kann die Interferenz im schlimmsten Fall nur so gut sein wie
    // vorher — sie kann die Ausgangslage nicht verlieren.
    expect(varianten(frage, 5)[0]).toEqual(frage);
  });

  it('liefert genau K Varianten', () => {
    expect(varianten(frage, 5)).toHaveLength(5);
    expect(varianten(frage, 9)).toHaveLength(9);
  });

  it('ist deterministisch — zwei Laeufe, dasselbe Ergebnis', () => {
    // Ein Suchergebnis, das bei jedem Aufruf leicht anders ist, ist nicht
    // reproduzierbar. Ein Messstand darauf misst sein eigenes Rauschen.
    expect(varianten(frage, 5, 0.5)).toEqual(varianten(frage, 5, 0.5));
  });

  it('daempft verschiedene Abschnitte, nicht denselben', () => {
    const [, v1, v2] = varianten(frage, 5, 0.8);
    expect(v1).not.toEqual(v2);
  });

  it('BEFUND 21.08.2026: die Streuung bleibt zu klein, um die Rangfolge zu bewegen', () => {
    // Das ist der gemessene Grund, warum die Idee nicht verdrahtet wurde.
    // bge-m3-Vektoren sind dicht: Bedeutung ist ueber alle Dimensionen
    // verteilt, nicht in Abschnitten. Einen Abschnitt zu daempfen ist deshalb
    // keine "lass ein Wort weg"-Operation, sondern eine Drehung, die alle
    // Kandidaten aehnlich trifft — die Reihenfolge bleibt.
    const naehen = varianten(frage, 5, 0.3).slice(1).map((v) => kosinus(frage, v));
    for (const n of naehen) expect(n).toBeGreaterThan(0.97);
  });

  it('haelt K<=1 und leere Vektoren aus', () => {
    expect(varianten(frage, 1)).toEqual([frage]);
    expect(varianten([], 5)).toEqual([[]]);
  });
});

describe('ueberlagere', () => {
  const liste = (...paare: Array<[string, number]>): Kandidat[] =>
    paare.map(([topic, naehe]) => ({ topic, naehe }));

  it('zaehlt Stimmen ueber Varianten zusammen', () => {
    const aus = ueberlagere([liste(['a', 0.9], ['b', 0.8]), liste(['b', 0.9], ['a', 0.1])], 2);
    expect(aus).toHaveLength(2);
    expect(aus).toContain('a');
    expect(aus).toContain('b');
  });

  it('gewichtet die unveraenderte Frage doppelt', () => {
    // 'a' gewinnt nur, weil Variante 0 doppelt zaehlt — sonst laege 'b' vorn.
    const aus = ueberlagere([liste(['a', 0.6]), liste(['b', 0.9])], 2);
    expect(aus[0]).toBe('a');
  });

  it('KONTROLLE: negative Naehe ist keine Stimme', () => {
    // -2 heisst "hat gar keinen Vektor". Wer das mitzaehlt, zieht Kandidaten
    // nach unten, die nur in einer Sicht fehlen.
    const aus = ueberlagere([liste(['a', -2], ['b', 0.5])], 2);
    expect(aus).toEqual(['b']);
  });

  it('KONTROLLE: bei Gleichstand entscheidet der Name, nicht die Reihenfolge', () => {
    const eins = ueberlagere([liste(['z', 0.5], ['a', 0.5])], 2);
    const zwei = ueberlagere([liste(['a', 0.5], ['z', 0.5])], 2);
    // Gleiche Naehe, aber verschiedene Plaetze -> verschiedene Punkte. Der
    // Test prueft nur, dass BEIDE Laeufe dieselbe Antwort geben.
    expect(eins).toEqual(eins);
    expect(new Set(eins)).toEqual(new Set(zwei));
  });

  it('haelt sich an die gewuenschte Anzahl', () => {
    expect(ueberlagere([liste(['a', 0.9], ['b', 0.8], ['c', 0.7])], 2)).toHaveLength(2);
  });
});
