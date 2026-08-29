import { describe, expect, it } from 'vitest';
import {
  FALSCHE_LEKTIONEN,
  IRRTUMS_FRAGEN,
  irrtumAufEins,
  irrtumsquote,
} from '../bench/irrtumsquote';
import { BENCH_LESSONS } from '../bench/fixtures';

/**
 * Proben für die Irrtumsquote (Karte 591wz6oijnr8).
 *
 * Der Prüfsatz aus absichtlich falschen Lektionen ist ein Werkzeug, das nur
 * taugt, wenn es selbst geprüft ist. Diese Datei hält vor allem fest, was an
 * ihm leicht kaputtgeht: eine falsche Lektion, die niemand findet, beweist
 * nichts.
 */

describe('Der Satz falscher Lektionen', () => {
  it('hat zwanzig Eintraege, wie die Karte verlangt', () => {
    expect(FALSCHE_LEKTIONEN.length).toBe(20);
  });

  it('jede ist als falsch markiert UND begruendet', () => {
    /*
     * Ohne Begründung wäre „falsch" eine Behauptung. Wer den Satz später
     * anzweifelt, muss nachlesen können, warum ein Eintrag drinsteht.
     */
    for (const l of FALSCHE_LEKTIONEN) {
      expect(l.wahr).toBe(false);
      expect((l.warumFalsch ?? '').length).toBeGreaterThan(20);
    }
  });

  /*
   * Der wichtigste Fall: die falschen müssen GUT FINDBAR sein. Eine falsche
   * Lektion mit niedriger Zuversicht und null Abrufen landet nie oben — und
   * dann misst der ganze Satz nichts.
   */
  it('sie sind gut findbar gebaut, sonst misst der Satz nichts', () => {
    for (const l of FALSCHE_LEKTIONEN) {
      expect(l.confidence ?? 0).toBeGreaterThanOrEqual(0.8);
      expect(l.recall_count ?? 0).toBeGreaterThanOrEqual(8);
      expect(l.outcome).toBe('success');
    }
  });

  it('sie kollidieren nicht mit den echten Themen', () => {
    // Ein doppelter Themenname wuerde die echte Lektion ueberschreiben und
    // die Messung still verfaelschen.
    const echt = new Set(BENCH_LESSONS.map((l) => l.topic));
    for (const l of FALSCHE_LEKTIONEN) expect(echt.has(l.topic)).toBe(false);
  });

  it('zu jeder Frage gibt es eine passende falsche Lektion', () => {
    // Sonst ist die Frage keine Probe, sondern nur eine Wiederholung des
    // eingefrorenen Bench.
    for (const q of IRRTUMS_FRAGEN) {
      const woerter = q.query.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const passt = FALSCHE_LEKTIONEN.some((l) => {
        const text = `${l.what_worked ?? ''} ${l.context ?? ''}`.toLowerCase();
        return woerter.filter((w) => text.includes(w)).length >= 3;
      });
      expect(passt, `keine falsche Lektion passt zu "${q.query}"`).toBe(true);
    }
  });

  it('die Gold-Antworten sind NUR echte Lektionen', () => {
    const falsch = new Set(FALSCHE_LEKTIONEN.map((l) => l.topic));
    for (const q of IRRTUMS_FRAGEN) {
      for (const r of q.relevant) expect(falsch.has(r)).toBe(false);
    }
  });
});

describe('Die Quote selbst', () => {
  const falsch = new Set(['a-falsch', 'b-falsch']);

  it('erkennt einen Irrtum auf Platz 1', () => {
    expect(irrtumAufEins(['a-falsch', 'echt'], falsch)).toBe(true);
  });

  it('Platz 2 zaehlt NICHT', () => {
    // Die Zahl heisst @1 und misst @1. Wer Platz 2 mitzaehlt, misst etwas
    // anderes und nennt es gleich.
    expect(irrtumAufEins(['echt', 'a-falsch'], falsch)).toBe(false);
  });

  it('eine leere Rangliste ist kein Irrtum', () => {
    expect(irrtumAufEins([], falsch)).toBe(false);
  });

  it('rechnet die Quote', () => {
    const q = irrtumsquote([['a-falsch'], ['echt'], ['b-falsch'], ['echt']], falsch);
    expect(q.treffer).toBe(2);
    expect(q.gesamt).toBe(4);
    expect(q.quote).toBe(0.5);
  });

  it('ohne Ranglisten ist die Quote 0 und nicht NaN', () => {
    // Eine Division durch null wuerde als NaN durchgehen und in jedem
    // Vergleich still falsch antworten.
    const q = irrtumsquote([], falsch);
    expect(q.quote).toBe(0);
    expect(Number.isNaN(q.quote)).toBe(false);
  });
});
