import { describe, expect, it } from 'vitest';
import { abstentionSatz, beurteileTreffer } from '../abstention.js';
import {
  CKG_BELEG_SCHWELLE,
  SINN_BELEG_SCHWELLE,
  WORT_BELEG_SCHWELLE,
} from '../rangfolge-stellschrauben.js';

/**
 * ABNAHME Karte bninni0fimfy — "nicht im Bestand" ist eine Antwort.
 *
 * Die Gegenproben sind hier die eigentliche Arbeit: eine Zurueckhaltung, die
 * zu oft greift, ist schlimmer als gar keine. Sie nimmt dann Treffer weg, die
 * geholfen haetten, und niemand merkt es — der Nutzer sieht ja nur, dass
 * nichts da war.
 *
 * Zwei Proben halten die beiden Fehlversuche vom 27.08.2026 fest, damit sie
 * niemand zurueckdreht: "ein Treffer allein" (die Rangzahl haette immer
 * geschwiegen) und "die lange Frage" (der Anteil haette den richtigen Treffer
 * verworfen).
 */
describe('beurteileTreffer — wann geschwiegen wird', () => {
  it('eine leere Liste ist ein Schweigen', () => {
    const u = beurteileTreffer([]);
    expect(u.schweigen).toBe(true);
    expect(u.besteWortBelege).toBe(0);
    expect(u.besteNaehe).toBe(0);
    expect(u.geprueft).toBe(0);
  });

  it('ist KEIN Treffer belegt, wird geschwiegen', () => {
    const u = beurteileTreffer([
      { wortBelege: 0.5, semScore: 0.1, ckgScore: 0.2 },
      { wortBelege: 0, semScore: 0.2 },
      { wortBelege: 0 },
    ]);
    expect(u.schweigen).toBe(true);
  });

  it('GEGENPROBE: EIN belegter Treffer genuegt — dann wird die ganze Liste geliefert', () => {
    // Der wichtigste Fall. Die Zurueckhaltung filtert NICHT die schwachen
    // heraus; sie entscheidet nur, ob die Liste als Ganzes etwas taugt.
    expect(beurteileTreffer([{ wortBelege: 2 }, { wortBelege: 0 }, { wortBelege: 0 }]).schweigen).toBe(false);
    expect(beurteileTreffer([{ wortBelege: 0 }, { wortBelege: 0 }, { wortBelege: 2 }]).schweigen).toBe(false);
  });

  it('GEGENPROBE Fehlversuch 1: EIN Treffer allein wird beurteilt wie in jeder Liste', () => {
    // Der erste Entwurf urteilte ueber `hybridScore`. Der ist min-max normiert:
    // bei genau einem Treffer ist max === min, die Zahl also immer 0. Jeder
    // Ein-Treffer-Abruf haette geschwiegen, auch der perfekte.
    expect(beurteileTreffer([{ wortBelege: 1 }]).schweigen).toBe(false);
    expect(beurteileTreffer([{ wortBelege: 3 }]).schweigen).toBe(false);
  });

  it('GEGENPROBE Fehlversuch 2: die lange Frage wird nicht bestraft', () => {
    // Der zweite Entwurf urteilte ueber den ANTEIL der getroffenen Woerter.
    // "xyzzy api key" auf eine Lektion mit dem seltenen "xyzzy" waere ein
    // Drittel gewesen — verworfen, obwohl der Treffer genau richtig war.
    // Eine Anzahl kennt diesen Effekt nicht: ein Wort bleibt ein Wort,
    // gleich wie viele daneben standen.
    expect(beurteileTreffer([{ wortBelege: 1 }]).schweigen).toBe(false);
  });

  it('GEGENPROBE: genau AUF der Schwelle wird geliefert, nicht geschwiegen', () => {
    // Im Zweifel fuer den Treffer.
    expect(beurteileTreffer([{ wortBelege: WORT_BELEG_SCHWELLE }]).schweigen).toBe(false);
    expect(beurteileTreffer([{ semScore: SINN_BELEG_SCHWELLE }]).schweigen).toBe(false);
    expect(beurteileTreffer([{ ckgScore: CKG_BELEG_SCHWELLE }]).schweigen).toBe(false);
  });

  it('ein einzelner unscharfer Treffer belegt nicht, zwei belegen', () => {
    // Tippfehler-Toleranz zaehlt 0,5 je Wort (search.ts).
    expect(beurteileTreffer([{ wortBelege: 0.5 }]).schweigen).toBe(true);
    expect(beurteileTreffer([{ wortBelege: 1 }]).schweigen).toBe(false);
  });

  it('Bedeutungsnaehe belegt auch OHNE ein gemeinsames Wort', () => {
    // "wie halte ich den Speicher klein" und "Redis maxmemory-policy setzen"
    // teilen kein Wort. Die Lektion ist trotzdem die richtige.
    expect(beurteileTreffer([{ wortBelege: 0, semScore: 0.8 }]).schweigen).toBe(false);
  });

  it('eine Ursache-Wirkung-Kante belegt ebenfalls allein', () => {
    expect(beurteileTreffer([{ ckgScore: 0.9 }]).schweigen).toBe(false);
    expect(beurteileTreffer([{ ckgScore: 0.2 }]).schweigen).toBe(true);
  });

  it('die besten Werte werden IMMER gemeldet, auch beim Schweigen', () => {
    // Ein Urteil ohne die gelesenen Werte ist nicht nachpruefbar.
    const u = beurteileTreffer([
      { wortBelege: 0.5, semScore: 0.1 },
      { wortBelege: 0, semScore: 0.25 },
    ]);
    expect(u.schweigen).toBe(true);
    expect(u.besteWortBelege).toBeCloseTo(0.5);
    expect(u.besteNaehe).toBeCloseTo(0.25);
    expect(u.geprueft).toBe(2);
  });

  it('GEGENPROBE: kaputte Zahlen kippen das Urteil nicht ins Liefern', () => {
    // `NaN >= schwelle` ist FALSCH, `Infinity >= schwelle` ist WAHR — ohne das
    // Aussortieren haette eine einzige kaputte Rechnung jede Zurueckhaltung
    // ausgehebelt.
    expect(beurteileTreffer([{ wortBelege: NaN }, { wortBelege: 0.5 }]).schweigen).toBe(true);
    expect(beurteileTreffer([{ wortBelege: Number.POSITIVE_INFINITY }]).schweigen).toBe(true);
    expect(beurteileTreffer([{ wortBelege: Number.POSITIVE_INFINITY }, { wortBelege: 1 }]).schweigen).toBe(false);
    // Fehlende Felder sind kein Beleg, aber auch kein Absturz.
    expect(beurteileTreffer([{}, {}]).schweigen).toBe(true);
  });

  it('eigene Schwellen lassen sich uebergeben — der Messstand baut nichts nach', () => {
    expect(beurteileTreffer([{ wortBelege: 1 }], { woerter: 2 }).schweigen).toBe(true);
    expect(beurteileTreffer([{ wortBelege: 0.5 }], { woerter: 0.5 }).schweigen).toBe(false);
    expect(beurteileTreffer([{ semScore: 0.3 }], { naehe: 0.2 }).schweigen).toBe(false);
    expect(beurteileTreffer([{ ckgScore: 0.3 }], { kante: 0.2 }).schweigen).toBe(false);
  });
});

describe('abstentionSatz — das Nein traegt seine Zahlen', () => {
  it('nennt beide gelesenen Werte, die Anzahl und beide Schwellen', () => {
    const satz = abstentionSatz(beurteileTreffer([{ wortBelege: 0.5, semScore: 0.11 }]));
    expect(satz).toContain('0.5');
    expect(satz).toContain('0.11');
    expect(satz).toContain('1 geprüften');
    expect(satz).toContain(`nötig: ${WORT_BELEG_SCHWELLE}`);
    expect(satz).toContain(SINN_BELEG_SCHWELLE.toFixed(2));
  });

  it('der leere Bestand bekommt einen eigenen, kuerzeren Satz', () => {
    const satz = abstentionSatz(beurteileTreffer([]));
    expect(satz).toContain('noch keine Lektion');
    // Keine Schwellen-Arithmetik, wo es nichts zu vergleichen gab.
    expect(satz).not.toContain('nötig');
  });

  it('GEGENPROBE: der Satz behauptet nie, der Bestand sei leer, wenn es Treffer GAB', () => {
    const satz = abstentionSatz(beurteileTreffer([{ wortBelege: 0.5 }]));
    expect(satz).not.toContain('noch keine Lektion');
    expect(satz).toContain('geprüften');
  });

  it('nennt einen Weg weiter, statt nur abzulehnen', () => {
    expect(abstentionSatz(beurteileTreffer([{ wortBelege: 0.5 }]))).toContain('recall_best_solution');
  });
});
