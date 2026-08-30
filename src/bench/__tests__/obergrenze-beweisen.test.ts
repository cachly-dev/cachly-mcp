/**
 * Proben für den Dominanz-Beweis (Karte g0si2vjfhdob).
 *
 * Die Schranke steht und fällt mit der Dominanz-Definition: >= überall,
 * > mindestens einmal. Ein Fehler hier macht aus der Obergrenze eine
 * beliebige Zahl — deshalb die Randfälle einzeln.
 */
import { describe, it, expect } from 'vitest';
import { dominiert, wenigsteDominatoren } from '../obergrenze-beweisen.js';

const k = (t: string, werte: [number, number, number, number, number]) => ({
  t, nT: werte[0], nTh: werte[1], nR: werte[2], sD: werte[3], bE: werte[4],
});

describe('Dominanz', () => {
  it('ueberall >= und einmal > dominiert', () => {
    expect(dominiert(k('a', [2, 1, 1, 1, 1]), k('b', [1, 1, 1, 1, 1]))).toBe(true);
  });

  it('GLEICHSTAND dominiert nicht — sonst schloesse jede Kopie jede andere aus', () => {
    expect(dominiert(k('a', [1, 1, 1, 1, 1]), k('b', [1, 1, 1, 1, 1]))).toBe(false);
  });

  it('ein einziges schwaecheres Merkmal bricht die Dominanz', () => {
    // Genau deshalb ist die Schranke eine OBERGRENZE: fuer diesen Fall
    // gibt es eine Gewichtung, unter der b vor a liegt (alles auf nT).
    expect(dominiert(k('a', [1, 9, 9, 9, 9]), k('b', [2, 0, 0, 0, 0]))).toBe(false);
  });
});

describe('Wenigste Dominatoren je Frage', () => {
  it('zaehlt gegen die BESTE richtige Antwort, nicht die schlechteste', () => {
    const z = {
      query: 'q',
      relevant: ['gut', 'schlecht'],
      topf: [
        k('gut', [3, 3, 3, 3, 3]),
        k('schlecht', [0, 0, 0, 0, 0]),
        k('stoerer', [1, 1, 1, 1, 1]),
      ],
    };
    // 'schlecht' hat zwei Dominatoren, 'gut' keinen — es zaehlt 'gut'.
    expect(wenigsteDominatoren(z)).toBe(0);
  });

  it('richtige Antwort nicht im Topf: null — keine Gewichtung hilft', () => {
    const z = { query: 'q', relevant: ['fehlt'], topf: [k('x', [1, 1, 1, 1, 1])] };
    expect(wenigsteDominatoren(z)).toBeNull();
  });

  it('der Fall, der die Top-3-Schranke traegt: genau drei Dominatoren', () => {
    const z = {
      query: 'q',
      relevant: ['r'],
      topf: [
        k('r', [1, 1, 1, 1, 1]),
        k('d1', [2, 2, 2, 2, 2]),
        k('d2', [3, 3, 3, 3, 3]),
        k('d3', [2, 1, 1, 1, 1]),
      ],
    };
    // Drei Dominatoren: unter JEDER Gewichtung stehen alle drei davor —
    // Top 3 ist fuer diese Frage bewiesen unerreichbar.
    expect(wenigsteDominatoren(z)).toBe(3);
  });
});
