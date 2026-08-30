import { describe, expect, it } from 'vitest';
import { qualitaetsSpanne } from '../bench/rangfolge-zerlegen';

/**
 * Proben für die Zerlegung der Rangfolge (Karte herwg1j3je29).
 *
 * Die Spanne ist die einzige Zahl, die dieses Werkzeug selbst rechnet — und
 * sie entscheidet die Aussage: liegt der Rohabstand darüber, ist jede
 * Änderung an den Qualitätsgewichten folgenlos.
 */

describe('Qualitätsspanne', () => {
  it('bei Gewicht 0 gibt es keine Spanne', () => {
    // Ohne Gewicht kann die Qualität nichts bewegen — das Verhältnis ist 1.
    expect(qualitaetsSpanne(0, 0.5, 1.8).verhaeltnis).toBeCloseTo(1, 10);
  });

  it('bei Gewicht 1 ist die Spanne das volle Boost-Verhaeltnis', () => {
    expect(qualitaetsSpanne(1, 0.5, 1.8).verhaeltnis).toBeCloseTo(1.8 / 0.5, 10);
  });

  /*
   * Der Wert, der im Produkt steht. Er ist die Messlatte für jeden Rohabstand
   * — und der gemessene Abstand am 30.08.2026 lag mit 2,32x und 7,27x darüber.
   */
  it('beim ausgelieferten Gewicht 0,6 liegt sie bei rund 2,1', () => {
    const s = qualitaetsSpanne(0.6, 0.5, 1.8);
    expect(s.min).toBeCloseTo(0.7, 10);
    expect(s.max).toBeCloseTo(1.48, 10);
    expect(s.verhaeltnis).toBeGreaterThan(2.0);
    expect(s.verhaeltnis).toBeLessThan(2.2);
  });

  it('mehr Gewicht spannt weiter', () => {
    // Die Richtung muss stimmen, sonst misst die Zahl das Gegenteil.
    expect(qualitaetsSpanne(0.9, 0.5, 1.8).verhaeltnis)
      .toBeGreaterThan(qualitaetsSpanne(0.3, 0.5, 1.8).verhaeltnis);
  });

  it('GEGENPROBE: ein Rohabstand von 7,3x liegt ausserhalb', () => {
    /*
     * Der gemessene Fall: die richtige Lektion lag bei roh 9,29, die Spitze
     * bei 67,49. Keine Einstellung der Gewichte im erlaubten Bereich holt das
     * auf — und genau das muss die Zahl aussagen können.
     */
    expect(7.27).toBeGreaterThan(qualitaetsSpanne(0.6, 0.5, 1.8).verhaeltnis);
  });
});
