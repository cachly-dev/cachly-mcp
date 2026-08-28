import { describe, expect, it } from 'vitest';
import { normalisiereZeit, zaehleZeitangaben } from '../zeit-normalisieren.js';

/**
 * ABNAHME zur Karte 2bfm7dyvjmeh — relative Zeitangaben werden beim
 * SCHREIBEN aufgeloest, damit sie beim Lesen nicht geraten werden muessen.
 *
 * Belegt in BEFUND-lauf-2.md: derselbe Mechanismus hob die Kategorie
 * "Temporal" im Holdout von 23,1 auf 57,7 Prozent.
 *
 * Zu jeder Regel eine Gegenprobe — ein Normalisierer, der alles anfasst,
 * ist schlimmer als keiner.
 */
const JETZT = new Date(2026, 7, 27, 14, 30); // 27.08.2026, lokal

describe('normalisiereZeit — die eindeutigen Angaben', () => {
  it('gestern, heute, vorgestern bekommen ihr Datum', () => {
    expect(normalisiereZeit('Der Deploy fiel gestern um.', JETZT)).toBe('Der Deploy fiel gestern (2026-08-26) um.');
    expect(normalisiereZeit('heute gemessen', JETZT)).toBe('heute (2026-08-27) gemessen');
    expect(normalisiereZeit('vorgestern gebaut', JETZT)).toBe('vorgestern (2026-08-25) gebaut');
  });

  it('Spannen: vor N Tagen, Wochen, Monaten', () => {
    expect(normalisiereZeit('vor 3 Tagen', JETZT)).toBe('vor 3 Tagen (2026-08-24)');
    expect(normalisiereZeit('vor 2 Wochen', JETZT)).toBe('vor 2 Wochen (2026-08-13)');
    expect(normalisiereZeit('vor 1 Monaten', JETZT)).toBe('vor 1 Monaten (2026-07-27)');
    expect(normalisiereZeit('letzte Woche', JETZT)).toBe('letzte Woche (2026-08-20)');
  });

  it('Englisch ebenso — der Bestand ist zweisprachig', () => {
    expect(normalisiereZeit('shipped yesterday', JETZT)).toBe('shipped yesterday (2026-08-26)');
    expect(normalisiereZeit('3 days ago', JETZT)).toBe('3 days ago (2026-08-24)');
    expect(normalisiereZeit('last week', JETZT)).toBe('last week (2026-08-20)');
  });

  it('mehrere Angaben in einem Satz, alle richtig gesetzt', () => {
    expect(normalisiereZeit('gestern rot, heute gruen', JETZT)).toBe(
      'gestern (2026-08-26) rot, heute (2026-08-27) gruen',
    );
  });

  it('Monatswechsel und Jahreswechsel rechnen korrekt', () => {
    const neujahr = new Date(2027, 0, 1, 9, 0); // 01.01.2027
    expect(normalisiereZeit('gestern', neujahr)).toBe('gestern (2026-12-31)');
    expect(normalisiereZeit('vor 1 Monaten', neujahr)).toBe('vor 1 Monaten (2026-12-01)');
  });
});

describe('GEGENPROBEN — was NICHT angefasst werden darf', () => {
  it('der Originaltext bleibt Wort fuer Wort erhalten (ergaenzen, nie ersetzen)', () => {
    const roh = 'Der Deploy fiel gestern um.';
    const neu = normalisiereZeit(roh, JETZT);
    expect(neu).toContain('gestern');
    expect(neu.replace(/ \(\d{4}-\d{2}-\d{2}\)/g, '')).toBe(roh);
  });

  it('zweimal angewendet aendert sich nichts mehr (idempotent)', () => {
    const einmal = normalisiereZeit('gestern und vor 3 Tagen', JETZT);
    expect(normalisiereZeit(einmal, JETZT)).toBe(einmal);
  });

  it('Mehrdeutiges bleibt stehen: "am Montag" wird NICHT geraten', () => {
    // Vergangen oder kuenftig? Eine falsche Zahl ist schlimmer als keine.
    const roh = 'Wir sprechen am Montag darueber.';
    expect(normalisiereZeit(roh, JETZT)).toBe(roh);
  });

  it('Code in Backticks bleibt unangetastet', () => {
    const roh = 'Der Befehl `git log --since=yesterday` half.';
    expect(normalisiereZeit(roh, JETZT)).toBe(roh);
  });

  it('Code-Bloecke bleiben unangetastet', () => {
    const roh = 'So:\n```sh\ndate -d yesterday\n```\nund gestern lief es.';
    const neu = normalisiereZeit(roh, JETZT);
    expect(neu).toContain('date -d yesterday\n');
    expect(neu).toContain('gestern (2026-08-26)');
    expect(neu.match(/\(\d{4}-\d{2}-\d{2}\)/g)).toHaveLength(1);
  });

  it('Woerter, die ein Muster ENTHALTEN, loesen nicht aus', () => {
    // "Morgenpuls" enthaelt "morgen", "Heutigen" enthaelt "heute" — die
    // Wortgrenze entscheidet, sonst wird jeder zweite Satz zerschossen.
    const roh = 'Der Morgenpuls und die heutigen Zahlen.';
    expect(normalisiereZeit(roh, JETZT)).toBe(roh);
  });

  it('leerer Text und Text ohne Zeitangabe bleiben, wie sie sind', () => {
    expect(normalisiereZeit('', JETZT)).toBe('');
    expect(normalisiereZeit('Nichts Zeitliches hier.', JETZT)).toBe('Nichts Zeitliches hier.');
  });

  it('das laengere Muster gewinnt: "letzte Woche" wird nicht zweimal aufgeloest', () => {
    const neu = normalisiereZeit('letzte Woche gemessen', JETZT);
    expect(neu.match(/\(\d{4}-\d{2}-\d{2}\)/g)).toHaveLength(1);
  });
});

describe('zaehleZeitangaben — was die Rueckmeldung nennen darf', () => {
  it('zaehlt nur die NEU aufgeloesten', () => {
    expect(zaehleZeitangaben('gestern und heute', JETZT)).toBe(2);
    expect(zaehleZeitangaben('nichts hier', JETZT)).toBe(0);
    // Schon aufgeloest: keine neue Angabe mehr.
    expect(zaehleZeitangaben('gestern (2026-08-26)', JETZT)).toBe(0);
  });
});

/*
── Zitat schlägt Auflösung (28.08.2026) ────────────────────────────────────

Die Karte 2bfm7dyvjmeh liess die Frage ausdrücklich offen: bleibt „gestern"
in einem wörtlichen Zitat unangetastet? Code war geschützt, Zitate nicht.

Sie fällt so aus: fremder Text bleibt fremder Text. Wer in einem Zitat etwas
ergänzt, fälscht es — und danach kann niemand mehr unterscheiden, was zitiert
war und was wir dazugeschrieben haben.
*/
describe("Woertliche Zitate bleiben unangetastet", () => {
  const BEZUG = new Date(Date.UTC(2026, 7, 28))

  it("in geraden Anfuehrungszeichen", () => {
    const roh = 'Er schrieb: "gestern lief es noch"'
    expect(normalisiereZeit(roh, BEZUG)).toBe(roh)
  })

  it("in deutschen Anfuehrungszeichen", () => {
    const roh = "Er schrieb: „gestern lief es noch“"
    expect(normalisiereZeit(roh, BEZUG)).toBe(roh)
  })

  it("in Guillemets", () => {
    const roh = "Er schrieb: «gestern lief es noch»"
    expect(normalisiereZeit(roh, BEZUG)).toBe(roh)
  })

  it("aber DANEBEN wird ergaenzt", () => {
    // Sonst waere die Regel eine Ausrede: ein einziges Anfuehrungszeichen
    // irgendwo im Text wuerde die ganze Aufloesung abschalten.
    const neu = normalisiereZeit('gestern sagte er: "es lief"', BEZUG)
    expect(neu).toContain("gestern (")
    expect(neu).toContain('"es lief"')
  })

  it("GEGENPROBE: ohne die Anfuehrungszeichen WIRD ergaenzt", () => {
    // Ohne diese Zeile bewiese die Zitat-Regel nichts: ein Muster, das
    // "gestern" gar nicht mehr findet, laesst Zitate auch in Ruhe.
    const imZitat = 'Er schrieb: "gestern lief es noch"'
    const ohneZitat = imZitat.replace(/"/g, "")
    expect(normalisiereZeit(imZitat, BEZUG), "im Zitat: unveraendert").toBe(imZitat)
    expect(normalisiereZeit(ohneZitat, BEZUG), "ohne Zitat: ergaenzt").not.toBe(ohneZitat)
  })

  it("Code bleibt weiterhin geschuetzt", () => {
    const roh = "Der Schalter `--since gestern` half nicht"
    expect(normalisiereZeit(roh, BEZUG)).toBe(roh)
  })
})
