/**
 * Wächter für den zusammengesetzten Sortierer.
 *
 * Geprüft wird nicht "sortiert er gut" — das misst der Bench gegen den echten
 * Bestand (kreuzweise: 51 % gegen 40 %). Hier stehen die Zusagen, deren Bruch
 * sonst still bliebe.
 */

import { describe, it, expect } from 'vitest';
import {
  inhaltsWoerter, grobStamm, Seltenheit, spreizeImTopf, reichereAn,
  bewerteTopf, naeheOderLuecke, GEWICHTE, type Bewertbar,
} from './rangfolge.js';

describe('Wörter und Stämme', () => {
  it('vereinheitlicht Umlaute und lässt Kurzwörter weg', () => {
    const w = inhaltsWoerter('Die Abhängigkeit läuft nicht');
    expect(w.has('abhaengigkeit')).toBe(true);
    expect(w.has('laeuft')).toBe(true);
    expect(w.has('die')).toBe(false); // zu kurz
  });

  it('verschmilzt NICHTS — das ist gemessen, nicht vergessen', () => {
    // Drei Varianten durchgemessen: ohne Stammbildung 50 % auf Platz 1, mit
    // Kuerzung auf 6 oder 8 Zeichen je 47 %. Der Wert dieser Suche steckt in
    // seltenen Fachwoertern, und jede Verschmelzung verwischt sie —
    // `container` und `contains` wuerden dasselbe Wort.
    expect(grobStamm('fail2ban')).toBe('fail2ban');
    expect(grobStamm('container')).not.toBe(grobStamm('contains'));
    expect(grobStamm('abhaengigkeiten')).toBe('abhaengigkeiten');
  });
});

describe('Seltenheit', () => {
  const texte = [
    'deploy haengt beim bauen fail2ban',
    'deploy laeuft durch',
    'deploy und wieder deploy',
    'ganz etwas anderes ueber datenbanken',
  ];
  const s = new Seltenheit(texte);

  it('bewertet ein seltenes Wort höher als ein häufiges', () => {
    // Das ist der ganze Punkt: "fail2ban" steht in einem von vier Texten,
    // "deploy" in dreien. Ohne diese Gewichtung waeren beide gleich viel wert.
    expect(s.wert('fail2ban')).toBeGreaterThan(s.wert('deploy') * 1.5);
  });

  it('zählt fehlende seltene Wörter GEGEN den Text', () => {
    // Der Nenner ist die Summe ueber alle Fragewoerter. Ein Text, dem das
    // seltene Wort fehlt, faellt damit zurueck — fehlende Belege zaehlen mit.
    const frage = inhaltsWoerter('deploy fail2ban');
    const mitBeiden = s.deckung(frage, new Set(['deploy', 'fail2ban']));
    const nurHaeufiges = s.deckung(frage, new Set(['deploy']));
    expect(mitBeiden).toBeGreaterThan(nurHaeufiges);
    expect(nurHaeufiges).toBeLessThan(0.5);
  });

  it('gibt 0 zurück, wenn die Frage keine brauchbaren Wörter hat', () => {
    expect(s.deckung(new Set(), new Set(['x']))).toBe(0);
  });
});

describe('Spreizen im Topf', () => {
  it('macht aus einem schmalen Band eine ganze Skala', () => {
    // Der Grund fuer den ganzen Schritt: ueber den Bestand liegen die
    // Aehnlichkeiten zwischen 0,42 und 0,61. Im Topf sollen daraus 0 bis 1
    // werden, damit ein Unterschied von 0,02 sichtbar wird.
    const aus = spreizeImTopf([0.42, 0.52, 0.61]);
    expect(aus[0]).toBeCloseTo(0, 5);
    expect(aus[2]).toBeCloseTo(1, 5);
    expect(aus[1]).toBeGreaterThan(0.4);
  });

  it('behandelt Lücken neutral, nicht als schlechtesten Wert', () => {
    // ── Umgedreht am 23.08.2026 (Karte azmqezaxx2kx) ──────────────────────
    //
    // Hier stand vorher `expect(aus[1]).toBe(0)` mit der Begruendung: "Ein
    // fehlender Vektor darf nicht als mittelmaessig durchgehen — sonst
    // schlaegt 'keine Angabe' eine echte, schlechte Bewertung."
    //
    // Der Einwand beschreibt einen echten Effekt und zieht den falschen
    // Schluss. Eine gemessene schlechte Zahl ist ein Beleg GEGEN eine
    // Lektion; eine Luecke ist gar kein Beleg. Wer beides gleich behandelt,
    // tut so, als wuesste er etwas, das er nicht weiss.
    //
    // Was die Null gekostet hat, gemessen: 108 von 507 Lektionen ohne
    // Fehlertext wurden systematisch nach unten gedrueckt. Die Tueren sahen
    // dadurch netto negativ aus und wurden ausgebaut — die falsche
    // Schlussfolgerung aus einer richtigen Messung.
    //
    // Am Messstand nach der Umstellung: Platz 1 von 40,0 auf 41,0 Prozent,
    // Findequote@3 unveraendert 55,0, Top 10 von 72,0 auf 71,0.
    const aus = spreizeImTopf([0.5, -2, 0.9]);
    // Die Luecke landet auf dem Mittelwert der gueltigen: (0 + 1) / 2.
    expect(aus[1]).toBeCloseTo(0.5, 5);
    // Kein Auftrieb, kein Abzug: sie schlaegt den schlechteren und
    // unterliegt dem besseren.
    expect(aus[1]).toBeGreaterThan(aus[0]);
    expect(aus[1]).toBeLessThan(aus[2]);
  });

  it('GEGENPROBE: eine Lücke gewinnt nicht gegen ein starkes Feld', () => {
    // Sonst waere "unbekannt" eine Auszeichnung. Bei drei guten und einem
    // fehlenden Wert liegt die Luecke in der Mitte des Feldes, nicht oben.
    const aus = spreizeImTopf([0.80, 0.85, 0.90, -2]);
    expect(aus[3]).toBeGreaterThan(0);
    expect(aus[3]).toBeLessThan(1);
    expect(aus[3]).toBeLessThan(aus[2]);
  });

  it('ohne einen einzigen gültigen Wert bleibt das Merkmal wirkungslos', () => {
    // Alle gleich heisst: die Sortierung faellt auf die uebrigen Merkmale
    // zurueck, statt falsch zu werden.
    const aus = spreizeImTopf([-2, -2, -2]);
    expect(new Set(aus).size).toBe(1);
  });

  it('gibt bei lauter gleichen Werten überall dasselbe zurück', () => {
    expect(spreizeImTopf([0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('Rückkopplung', () => {
  it('zieht die Frage in Richtung der besten Treffer, ohne sie aufzugeben', () => {
    const frage = [1, 0, 0];
    const treffer = [[0, 1, 0]];
    const neu = reichereAn(frage, treffer, 0.25);
    expect(neu[0]).toBeCloseTo(0.75, 5);
    expect(neu[1]).toBeCloseTo(0.25, 5);
    // Die Frage bleibt die Hauptsache — sonst sucht man nach den ersten
    // Treffern statt nach der Frage.
    expect(neu[0]).toBeGreaterThan(neu[1] * 2);
  });

  it('lässt die Frage unverändert, wenn es keine Treffer gibt', () => {
    const frage = [1, 2, 3];
    expect(reichereAn(frage, [])).toEqual(frage);
  });

  it('überspringt Treffer mit falscher Länge statt zu rechnen', () => {
    // Ein Modellwechsel aendert die Vektorlaenge. Ohne diese Pruefung wuerde
    // hier still Unsinn gemischt.
    const frage = [1, 0];
    expect(reichereAn(frage, [[0, 1, 0]], 0.5)).toEqual([0.5, 0]);
  });
});

describe('Topf bewerten', () => {
  const leer = (): Bewertbar => ({
    naeheText: -2, naeheThema: -2, naeheRueckkopplung: -2, seltenheitsDeckung: 0,
  });

  it('die insgesamt passendste Lektion gewinnt', () => {
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.50, naeheThema: 0.30, naeheRueckkopplung: 0.50, seltenheitsDeckung: 0.1 },
      { ...leer(), naeheText: 0.55, naeheThema: 0.60, naeheRueckkopplung: 0.58, seltenheitsDeckung: 0.8 },
    ];
    const p = bewerteTopf(topf);
    expect(p[1]).toBeGreaterThan(p[0]);
  });

  it('seltene Wörter können eine knapp bessere Nähe überstimmen', () => {
    // Der gemessene Kern: die Seltenheits-Deckung bekam beim Einstellen das
    // hoechste Gewicht (1,0 bis 1,6). Sie MUSS eine knappe Naehe drehen
    // koennen, sonst waere das Gewicht wirkungslos.
    //
    // Der Topf hat hier fuenf Eintraege, nicht zwei — siehe den Fall darunter.
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.50, naeheThema: 0.44, naeheRueckkopplung: 0.50, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.60, naeheThema: 0.50, naeheRueckkopplung: 0.60, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.58, naeheThema: 0.48, naeheRueckkopplung: 0.58, seltenheitsDeckung: 0.9 },
      { ...leer(), naeheText: 0.55, naeheThema: 0.46, naeheRueckkopplung: 0.55, seltenheitsDeckung: 0.1 },
      { ...leer(), naeheText: 0.62, naeheThema: 0.52, naeheRueckkopplung: 0.62, seltenheitsDeckung: 0.0 },
    ];
    const p = bewerteTopf(topf);
    const sieger = p.indexOf(Math.max(...p));
    expect(sieger).toBe(2);
  });

  it('bei ZWEI Kandidaten spreizt die Normierung jeden Unterschied maximal', () => {
    // Eine Eigenschaft, die man kennen muss, statt sie zu entdecken: die
    // Spreizung setzt den besten Wert auf 1 und den schlechtesten auf 0 — egal
    // wie klein der Abstand wirklich war. Bei zwei Kandidaten wird aus 0,60
    // gegen 0,58 damit 1 gegen 0.
    //
    // Im Betrieb ist der Topf rund vierzig Eintraege gross, dort faellt das
    // nicht ins Gewicht. Bei sehr kleinen Toepfen entscheidet die Naehe
    // praktisch allein.
    // ── Zweimal geaendert, jetzt gemessen (24.08.2026) ──────────────────
    //
    // Am 23.08. stand hier `expect(p[1]).toBeGreaterThan(p[0])`, weil die
    // Anpassung `rueckkopplung` auf 0,15 gesenkt hatte — damit lag auf den
    // gespreizten Merkmalen nur noch 1,15 gegen 1,3 auf der Seltenheit, und
    // der Zweikampf kippte zur Deckung.
    //
    // Am 24.08. wurde diese Senkung ZURUECKGENOMMEN: einzeln nachgemessen
    // traegt sie nichts (eigener Satz +0,4/0,0/+0,1 Punkte, fremder Satz
    // +0,1/-0,3/-0,3). Damit steht die Naehe wieder bei 1 + 0 + 0,3 = 1,3 —
    // exakt gleichauf mit der Seltenheit.
    //
    // Die Eigenschaft, die hier geprueft wird, ist unveraendert: aus 0,60
    // gegen 0,58 macht die Spreizung 1 gegen 0. Bei GLEICHEM Gewicht
    // entscheidet dann, wer im gespreizten Feld weiter vorn liegt.
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.60, naeheThema: 0.50, naeheRueckkopplung: 0.60, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.58, naeheThema: 0.48, naeheRueckkopplung: 0.58, seltenheitsDeckung: 0.9 },
    ];
    const p = bewerteTopf(topf);
    // Die Spreizung selbst: der Bessere bekommt 1, der Schlechtere 0.
    const nurNaehe = bewerteTopf(topf, { text: 1, thema: 0, rueckkopplung: 0, seltenheit: 0 } as typeof GEWICHTE);
    expect(nurNaehe[0]).toBeCloseTo(1, 5);
    expect(nurNaehe[1]).toBeCloseTo(0, 5);
    // 1,3 gegen 1,3 x 0,9 = 1,17 — die volle Naehe gewinnt knapp.
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it('nach der Anpassung schlaegt volle Seltenheits-Deckung volle Naehe', () => {
    // ── Eine Eigenschaft, die man wissen muss (23.08.2026) ──────────────
    //
    // Hier stand vorher "eine DEUTLICH bessere Naehe bleibt trotzdem vorn",
    // mit ZWEI Kandidaten (0,75 gegen 0,40) — als angebliche Gegenprobe zum
    // Fall darueber (0,60 gegen 0,58). Nach der Spreizung rechnen beide aber
    // GENAU DASSELBE: 1 gegen 0. Die Gegenprobe hat nie geprueft, was sie
    // behauptete.
    //
    // Und die Anpassung auf 6000 Fragen hat das Verhaeltnis gedreht. Rechnen
    // wir die Obergrenzen aus:
    //
    //   hoechstmoegliche Naehe      text 1 + thema 0 + rueckkopplung 0,15
    //                               = 1,15
    //   hoechstmoegliche Deckung    seltenheit 1,3 x 1,0
    //                               = 1,30
    //
    // Eine Lektion, die JEDES seltene Fragewort enthaelt, schlaegt damit eine
    // Lektion mit der besten Vektor-Naehe. Das ist kein Versehen, sondern das
    // Ergebnis der Anpassung — und es traegt: Findequote@3 auf dem
    // zurueckgehaltenen Satz von 64,0 auf 66,7 Prozent.
    //
    // Wer die Gewichte aendert und diesen Fall kippen sieht, hat den
    // Sortierer grundlegend umgestellt und muss das begruenden.
    const naeheGewinnt = GEWICHTE.text + GEWICHTE.thema + GEWICHTE.rueckkopplung;
    const deckungGewinnt = GEWICHTE.seltenheit;
    // Seit dem 24.08.2026 sind beide Obergrenzen GLEICH: 1 + 0 + 0,3 gegen
    // 1,3. Das ist kein Zufall, aber auch keine Absicht — es ist das
    // Ergebnis zweier unabhaengiger Messungen. Wer eine der beiden Seiten
    // aendert, verschiebt das Gleichgewicht und muss es begruenden.
    expect(deckungGewinnt).toBeCloseTo(naeheGewinnt, 5);

    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.75, naeheThema: 0.70, naeheRueckkopplung: 0.75, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.40, naeheThema: 0.35, naeheRueckkopplung: 0.40, seltenheitsDeckung: 1.0 },
      { ...leer(), naeheText: 0.38, naeheThema: 0.33, naeheRueckkopplung: 0.38, seltenheitsDeckung: 0.1 },
    ];
    const p = bewerteTopf(topf);
    expect(p[1]).toBeGreaterThan(p[0]);
  });

  it('bei GLEICHER Deckung entscheidet weiterhin die Naehe', () => {
    // Die echte Gegenprobe: nimmt man der Seltenheit ihren Vorsprung, muss
    // der Sortierer wieder nach Bedeutung ordnen. Sonst waere er eine
    // Wortsuche mit Vektor-Beiwerk.
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.75, naeheThema: 0.70, naeheRueckkopplung: 0.75, seltenheitsDeckung: 0.5 },
      { ...leer(), naeheText: 0.40, naeheThema: 0.35, naeheRueckkopplung: 0.40, seltenheitsDeckung: 0.5 },
      { ...leer(), naeheText: 0.38, naeheThema: 0.33, naeheRueckkopplung: 0.38, seltenheitsDeckung: 0.5 },
    ];
    const p = bewerteTopf(topf);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
  });

  it('kommt mit fehlenden Vektoren zurecht', () => {
    const topf: Bewertbar[] = [
      { ...leer(), seltenheitsDeckung: 0.7 },
      { ...leer(), naeheText: 0.6, naeheThema: 0.6, naeheRueckkopplung: 0.6, seltenheitsDeckung: 0.1 },
    ];
    expect(() => bewerteTopf(topf)).not.toThrow();
    expect(bewerteTopf(topf)).toHaveLength(2);
  });

  it('die Gewichte sind angepasst, nicht geraten', () => {
    // ── Was diese Probe seit dem 23.08.2026 haelt ───────────────────────
    //
    // Vorher stand hier `GEWICHTE.thema > 0`. Das war keine Regel, sondern
    // ein Glaubenssatz aus der Zeit, als die Zahlen von Hand abgetastet
    // wurden. Die Anpassung auf 2997 Einstellfragen hat ihn widerlegt:
    // thema will auf NULL, und der Gewinn haelt auf 3003 zurueckgehaltenen
    // Fragen (@3 von 64,0 auf 66,7 Prozent).
    //
    // Die Probe haelt jetzt die REGEL: text ist die Bezugsgroesse und bleibt
    // 1 (die Skala ist frei, nur die Verhaeltnisse zaehlen), kein Gewicht
    // ist negativ, und mindestens zwei Merkmale tragen wirklich. Ein
    // Sortierer, der nur noch EIN Merkmal benutzt, ist keine Zusammensetzung
    // mehr — dann muesste man ihn anders bauen und anders begruenden.
    expect(GEWICHTE.text).toBe(1);
    for (const [name, w] of Object.entries(GEWICHTE)) {
      expect(w, `${name} ist negativ`).toBeGreaterThanOrEqual(0);
    }
    const tragende = Object.values(GEWICHTE).filter((w) => w > 0).length;
    expect(tragende, 'nur noch ein Merkmal traegt — das waere kein zusammengesetzter Sortierer mehr')
      .toBeGreaterThanOrEqual(2);
  });
});

describe('Lücken', () => {
  it('meldet fehlende Vektoren als -2 statt als 0', () => {
    // 0 waere eine AUSSAGE ("gar nicht aehnlich"), -2 ist "nicht gemessen".
    // Die Unterscheidung ist der Unterschied zwischen einem Befund und einer
    // Luecke.
    expect(naeheOderLuecke(null, [1, 0])).toBe(-2);
    expect(naeheOderLuecke([1, 0], null)).toBe(-2);
    expect(naeheOderLuecke([1, 0], [])).toBe(-2);
    expect(naeheOderLuecke([1, 0], [1, 0])).toBeCloseTo(1, 5);
  });
});
