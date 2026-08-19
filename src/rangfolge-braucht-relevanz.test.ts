/**
 * Die Rangfolge muss der Relevanz gehorchen. Alles andere ist Stichentscheid.
 *
 * ── Warum es diesen Wächter gibt ─────────────────────────────────────────────
 *
 * Am 19.08.2026 wurde die Suche zum ersten Mal gegen den echten Bestand
 * gemessen: 498 Lektionen, 20 in Alltagssprache gestellte Fragen. Ergebnis
 * 2 von 20 auf Platz 1, Median-Platz 101 von 498. Der Prüfstand mit 17
 * Lektionen meldete zur selben Zeit 92,3 Prozent.
 *
 * Zwei Ursachen, beide durch Abschalten einzeln belegt:
 *
 *   1. FRISCHE. Der Bonus lag im Bereich [0.5, 1.5]. Eine ganz frische Lektion
 *      bekam das Dreifache einer alten — unabhängig davon, wie gut sie passt.
 *      Allein das kostete 4 von 20 richtigen ersten Plätzen.
 *
 *   2. STAUCHUNG. Die Nachsortierung rechnete `score^0.3` und gewichtete
 *      Qualitätsmerkmale mit 60 Prozent. Aus einem zehnfachen Relevanz-
 *      vorsprung wurde ein doppelter. Auf echten Daten kostete das die Hälfte
 *      der richtigen ersten Plätze (15 statt 30 Prozent).
 *
 * ── Warum ein eigener Wächter und nicht das Bench-Gate ───────────────────────
 *
 * Weil das Gate diese Klasse nicht finden KANN. Beide Fehler treten erst ab
 * einigen hundert Datensätzen auf. Bei 17 Lektionen ist der richtige Treffer so
 * eindeutig, dass er auch gestaucht und ohne Frischebonus gewinnt — es gibt nur
 * 16 Mitbewerber, und ein seltenes Wort wiegt rund zehnmal so schwer wie ein
 * häufiges. Erst wenn genug Datensätze mit ähnlichem Textwert dastehen,
 * entscheidet ein konstanter Faktor die Rangfolge.
 *
 * Ein Fehler, der erst ab einer gewissen Menge auftritt, ist auf einem kleinen
 * Prüfstand nicht schwer zu finden. Er ist unsichtbar.
 *
 * Deshalb prüft dieser Wächter nicht Kennzahlen, sondern die zwei Mechanismen
 * direkt — mit Zahlen, die auch bei drei Datensätzen greifen.
 */

import { describe, it, expect } from 'vitest';
import { recencyBoost } from './search.js';
import { rerankByQuality } from './rerank.js';
import type { KeywordMatch } from './search.js';

const treffer = (key: string, score: number, lektion: Record<string, unknown>): KeywordMatch => ({
  key: `cachly:lesson:best:${key}`,
  content: JSON.stringify(lektion),
  score,
  matchedWords: [],
});

describe('Frische ist Stichentscheid, nicht Treiber', () => {
  it('bewegt die Rangfolge um höchstens ein Zehntel', () => {
    const frisch = recencyBoost(Date.now());
    const uralt = recencyBoost(Date.now() - 365 * 24 * 60 * 60 * 1000);

    // Der alte Bereich war [0.5, 1.5] — Verhältnis 3,0. Damit schlug jede
    // frische Lektion jede ältere, die weniger als dreimal so gut passte.
    expect(frisch / uralt).toBeLessThan(1.12);
  });

  it('kann einen erkennbaren Relevanzunterschied nicht umdrehen', () => {
    // Die eigentliche Zusage, als Rechnung: eine Lektion, die um ein Fünftel
    // besser passt, muss auch dann vorn bleiben, wenn sie ein Jahr alt ist und
    // die Mitbewerberin von heute stammt.
    const besserAberAlt = 1.2 * recencyBoost(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const schlechterAberNeu = 1.0 * recencyBoost(Date.now());

    expect(besserAberAlt).toBeGreaterThan(schlechterAberNeu);
  });

  it('entscheidet aber sehr wohl bei Gleichstand', () => {
    // Ohne diesen Fall wäre der richtige Schritt gewesen, Frische ganz zu
    // streichen. Sie bleibt, weil Lektionen einander korrigieren: bei
    // gleichwertigem Text soll die neuere Fassung gewinnen, sonst steht die
    // widerlegte alte für immer vorn.
    const gleich = 1.0;
    expect(gleich * recencyBoost(Date.now()))
      .toBeGreaterThan(gleich * recencyBoost(Date.now() - 60 * 24 * 60 * 60 * 1000));
  });
});

describe('Die Nachsortierung staucht die Relevanz nicht', () => {
  const gut = { topic: 'a', outcome: 'success', what_worked: 'x', confidence: 0.3, recall_count: 0 };
  const glaenzend = {
    topic: 'b', outcome: 'success', what_worked: 'x', confidence: 1,
    recall_count: 50, severity: 'critical', review_level: 'senior', endorsements: 5,
  };

  it('lässt die passendere Lektion vorn, auch wenn die andere alle Orden trägt', () => {
    // Genau der Fall, der auf echten Daten die Hälfte der Treffer kostete:
    // Relevanz 40 gegen 10 ist ein vierfacher Vorsprung. Mit `score^0.3` wurde
    // daraus 1,5-fach — und das reichten die Qualitätsmerkmale mühelos auf.
    const [erster] = rerankByQuality([
      treffer('schlecht-passend-aber-glaenzend', 10, glaenzend),
      treffer('gut-passend', 40, gut),
    ]);
    expect(erster.key).toContain('gut-passend');
  });

  it('lässt Qualität bei ähnlicher Relevanz noch entscheiden', () => {
    // Der Gegenbeweis zum Fall darüber: die Nachsortierung ist entschärft,
    // nicht abgeschaltet. Bei fast gleichem Textwert darf die geprüfte,
    // mehrfach bestätigte Lektion vorn stehen.
    const [erster] = rerankByQuality([
      treffer('roh', 100, gut),
      treffer('geprueft', 98, glaenzend),
    ]);
    expect(erster.key).toContain('geprueft');
  });

  it('hält den Abstand zwischen zwei Relevanzwerten proportional', () => {
    // Die Klasse, nicht der Einzelfall: wer wieder eine Wurzel oder einen
    // Logarithmus einbaut, fällt hier auf — auch mit anderen Zahlen als oben.
    const ohneOrden = (score: number) =>
      rerankByQuality([treffer('x', score, gut)])[0].finalScore;

    const zehnfach = ohneOrden(100) / ohneOrden(10);
    expect(zehnfach).toBeGreaterThan(9);
  });
});
