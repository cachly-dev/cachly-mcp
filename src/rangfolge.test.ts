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

  it('behandelt Lücken als 0, nicht als Mitte', () => {
    // Ein fehlender Vektor darf nicht als mittelmaessig durchgehen — sonst
    // schlaegt "keine Angabe" eine echte, schlechte Bewertung.
    const aus = spreizeImTopf([0.5, -2, 0.9]);
    expect(aus[1]).toBe(0);
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
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.60, naeheThema: 0.50, naeheRueckkopplung: 0.60, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.58, naeheThema: 0.48, naeheRueckkopplung: 0.58, seltenheitsDeckung: 0.9 },
    ];
    const p = bewerteTopf(topf);
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it('eine DEUTLICH bessere Nähe bleibt trotzdem vorn', () => {
    // Die Gegenprobe zum Fall darueber. Ohne sie waere der Sortierer eine
    // Wortsuche mit Vektor-Beiwerk.
    const topf: Bewertbar[] = [
      { ...leer(), naeheText: 0.75, naeheThema: 0.70, naeheRueckkopplung: 0.75, seltenheitsDeckung: 0.0 },
      { ...leer(), naeheText: 0.40, naeheThema: 0.35, naeheRueckkopplung: 0.40, seltenheitsDeckung: 0.9 },
    ];
    const p = bewerteTopf(topf);
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it('kommt mit fehlenden Vektoren zurecht', () => {
    const topf: Bewertbar[] = [
      { ...leer(), seltenheitsDeckung: 0.7 },
      { ...leer(), naeheText: 0.6, naeheThema: 0.6, naeheRueckkopplung: 0.6, seltenheitsDeckung: 0.1 },
    ];
    expect(() => bewerteTopf(topf)).not.toThrow();
    expect(bewerteTopf(topf)).toHaveLength(2);
  });

  it('die Gewichte stehen fest und sind nicht zufällig gewählt', () => {
    // Sie stammen aus einer kreuzweisen Messung. Wer sie aendert, soll den
    // Bench neu fahren — dieser Fall macht die Aenderung wenigstens sichtbar.
    expect(GEWICHTE.text).toBe(1);
    expect(GEWICHTE.thema).toBeGreaterThan(0);
    expect(GEWICHTE.seltenheit).toBeGreaterThan(GEWICHTE.thema);
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
