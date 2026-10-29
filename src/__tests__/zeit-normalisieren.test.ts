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

  it('Spannen: Tage bekommen den Tag, Wochen den Bezugstag, Monate den Monat', () => {
    expect(normalisiereZeit('vor 3 Tagen', JETZT)).toBe('vor 3 Tagen (2026-08-24)');
    expect(normalisiereZeit('vor 2 Wochen', JETZT)).toBe('vor 2 Wochen (2 Wochen vor dem 2026-08-27)');
    expect(normalisiereZeit('vor einer Woche', JETZT)).toBe('vor einer Woche (eine Woche vor dem 2026-08-27)');
    expect(normalisiereZeit('vor 1 Monaten', JETZT)).toBe('vor 1 Monaten (2026-07)');
    expect(normalisiereZeit('letzte Woche', JETZT)).toBe('letzte Woche (die Woche vor dem 2026-08-27)');
    expect(normalisiereZeit('letzten Monat', JETZT)).toBe('letzten Monat (2026-07)');
    expect(normalisiereZeit('letztes Wochenende', JETZT)).toBe('letztes Wochenende (das Wochenende vor dem 2026-08-27)');
  });

  it('Englisch ebenso — der Bestand ist zweisprachig', () => {
    expect(normalisiereZeit('shipped yesterday', JETZT)).toBe('shipped yesterday (2026-08-26)');
    expect(normalisiereZeit('3 days ago', JETZT)).toBe('3 days ago (2026-08-24)');
    expect(normalisiereZeit('last week', JETZT)).toBe('last week (the week before 2026-08-27)');
    expect(normalisiereZeit('last weekend', JETZT)).toBe('last weekend (the weekend before 2026-08-27)');
    expect(normalisiereZeit('2 weeks ago', JETZT)).toBe('2 weeks ago (2 weeks before 2026-08-27)');
    expect(normalisiereZeit('1 week ago', JETZT)).toBe('1 week ago (1 week before 2026-08-27)');
    expect(normalisiereZeit('last month', JETZT)).toBe('last month (2026-07)');
    expect(normalisiereZeit('3 months ago', JETZT)).toBe('3 months ago (2026-05)');
  });

  it('die LoCoMo-Faelle: "last week" in der Sitzung vom 9. Juni 2023', () => {
    // Musterantwort in LoCoMo: "The week before 9 June 2023". Bis 29.10.2026
    // stand hier "(2023-06-02)", die Antwort nannte den 2. Juni als Tag.
    const sitzung = new Date(2023, 5, 9, 13, 0);
    expect(normalisiereZeit('I met my mentors last week', sitzung)).toBe(
      'I met my mentors last week (the week before 2023-06-09)',
    );
    expect(normalisiereZeit('We went camping last weekend.', new Date(2023, 6, 17, 10, 0))).toBe(
      'We went camping last weekend (the weekend before 2023-07-17).',
    );
  });

  it('mehrere Angaben in einem Satz, alle richtig gesetzt', () => {
    expect(normalisiereZeit('gestern rot, heute gruen', JETZT)).toBe(
      'gestern (2026-08-26) rot, heute (2026-08-27) gruen',
    );
  });

  it('Monatswechsel und Jahreswechsel rechnen korrekt', () => {
    const neujahr = new Date(2027, 0, 1, 9, 0); // 01.01.2027
    expect(normalisiereZeit('gestern', neujahr)).toBe('gestern (2026-12-31)');
    expect(normalisiereZeit('vor 1 Monaten', neujahr)).toBe('vor 1 Monaten (2026-12)');
    expect(normalisiereZeit('last week', neujahr)).toBe('last week (the week before 2027-01-01)');
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
    expect(neu.match(/\(/g)).toHaveLength(1);
    expect(normalisiereZeit('last weekend', JETZT).match(/\(/g)).toHaveLength(1);
  });

  it('idempotent auch fuer Spannen', () => {
    const einmal = normalisiereZeit('last week, 2 weeks ago, last month und letztes Wochenende', JETZT);
    expect(normalisiereZeit(einmal, JETZT)).toBe(einmal);
  });

  it('alte Lektionen mit Tagesdatum hinter "last week" werden nicht ein zweites Mal ergaenzt', () => {
    const alt = 'deployed last week (2026-08-20) and last month (2026-07-27)';
    expect(normalisiereZeit(alt, JETZT)).toBe(alt);
  });
});

/*
── Wochentage (28.10.2026) ──────────────────────────────────────────────────

"last Friday" blieb bis heute offen. Im neutralen OmniMemEval-Aufbau rechnete
gpt-4.1-mini daraus oft den Freitag der Vorwoche; die Zeitfragen lagen bei
75,1 %, mit aufgeloestem Wochentag (und Sitzungsdatum vorn) bei 81,9 %.
Gerechnet wird wie in den LoCoMo-Loesungen: "The Friday before 22 October 2023".
*/
describe('Wochentage: der letzte VOR dem Bezugstag', () => {
  // JETZT = Do 27.08.2026
  it('letzten Freitag, last Tuesday — 1 bis 6 Tage zurueck', () => {
    expect(normalisiereZeit('letzten Freitag gemessen', JETZT)).toBe('letzten Freitag (2026-08-21) gemessen');
    expect(normalisiereZeit('vergangenen Montag', JETZT)).toBe('vergangenen Montag (2026-08-24)');
    expect(normalisiereZeit('shipped last Tuesday', JETZT)).toBe('shipped last Tuesday (2026-08-25)');
  });

  it('derselbe Wochentag wie heute heisst: vor einer Woche', () => {
    expect(normalisiereZeit('last Thursday', JETZT)).toBe('last Thursday (2026-08-20)');
  });

  it('die LoCoMo-Faelle: Sonntag 22.10.2023, "last Friday" ist der 20.10.', () => {
    const sitzung = new Date(2023, 9, 22, 14, 0);
    expect(normalisiereZeit('I passed the interviews last Friday!', sitzung)).toBe(
      'I passed the interviews last Friday (2023-10-20)!',
    );
    // Do 20.07.2023: "last Tues." ist Dienstag, der 18.07. — die Klammer vor den Punkt.
    expect(normalisiereZeit('joined a group last Tues. Great', new Date(2023, 6, 20, 14, 0))).toBe(
      'joined a group last Tues (2023-07-18). Great',
    );
  });

  it('Gross- und Kleinschreibung der vollen Namen egal, Kurzformen gross', () => {
    expect(normalisiereZeit('Last Sunday we met', JETZT)).toBe('Last Sunday (2026-08-23) we met');
    expect(normalisiereZeit('last Fri and last Thurs', JETZT)).toBe('last Fri (2026-08-21) and last Thurs (2026-08-20)');
  });

  it('GEGENPROBE: klein geschriebene Kurzformen sind keine Wochentage', () => {
    for (const roh of ['I last sat down with her.', 'the last sun of summer', 'we last wed in May']) {
      expect(normalisiereZeit(roh, JETZT)).toBe(roh);
    }
  });

  it('GEGENPROBE: Wiederkehrendes bleibt stehen', () => {
    for (const roh of ['am letzten Freitag im Monat ist Abnahme', 'the review is on the last Friday of the month', 'last Monday in March']) {
      expect(normalisiereZeit(roh, JETZT)).toBe(roh);
    }
  });

  it('GEGENPROBE: ohne "letzten"/"last" bleibt der Wochentag offen', () => {
    for (const roh of ['am Freitag gemessen', 'on Friday we ship', 'naechsten Montag']) {
      expect(normalisiereZeit(roh, JETZT)).toBe(roh);
    }
  });

  it('idempotent auch fuer Wochentage', () => {
    const einmal = normalisiereZeit('last Tues. and letzten Sonntag', JETZT);
    expect(normalisiereZeit(einmal, JETZT)).toBe(einmal);
    expect(einmal.match(/\(\d{4}-\d{2}-\d{2}\)/g)).toHaveLength(2);
  });
});

describe('zaehleZeitangaben — was die Rueckmeldung nennen darf', () => {
  it('zaehlt nur die NEU aufgeloesten', () => {
    expect(zaehleZeitangaben('gestern und heute', JETZT)).toBe(2);
    expect(zaehleZeitangaben('nichts hier', JETZT)).toBe(0);
    // Schon aufgeloest: keine neue Angabe mehr.
    expect(zaehleZeitangaben('gestern (2026-08-26)', JETZT)).toBe(0);
  });

  it('zaehlt Spannen und Monate mit', () => {
    expect(zaehleZeitangaben('last week and last month', JETZT)).toBe(2);
    expect(zaehleZeitangaben('last week (the week before 2026-08-27)', JETZT)).toBe(0);
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
