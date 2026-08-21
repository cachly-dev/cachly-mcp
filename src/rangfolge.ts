/**
 * Der zusammengesetzte Sortierer.
 *
 * ── Was hier drinsteckt, und was NICHT ──────────────────────────────────────
 *
 * Am 19.08.2026 wurden an 499 echten Lektionen mit 100 Fragen ein Dutzend
 * Verfahren durchgemessen. Die meisten haben nichts gebracht. Sie stehen hier,
 * damit sie niemand ein zweites Mal baut:
 *
 *   Symptom-Sicht (what_failed als eigener Vektor)   17 % statt 40 % — das Feld
 *     beschreibt bei uns nicht das Symptom, sondern was vergeblich versucht wurde
 *   Schwerpunkt abziehen                             41 % — im Rauschen
 *   Hauptrichtungen entfernen (1, 3, 6 Stueck)       37–41 % — im Rauschen
 *   Nabenabzug (CSLS-artig)                          41 % — im Rauschen
 *   Text in Stuecke schneiden                        nicht gebaut: gemessen deckt
 *     das beste Stueck genauso viel ab wie der ganze Text (Verhaeltnis 1,00),
 *     und es liegt bei 86 von 96 Fragen ohnehin am Anfang
 *
 * Was BLEIBT, sind vier Bestandteile — kreuzweise geprueft, also auf der einen
 * Haelfte der Fragen eingestellt und auf der anderen gemessen, in beide
 * Richtungen:
 *
 *                        P@1     MRR
 *   nur Bedeutung        40 %   51,3 %
 *   zusammengesetzt      51 %   57,0 %
 *
 * ── Die vier Bestandteile ───────────────────────────────────────────────────
 *
 * 1. NAEHE ZUM GANZEN TEXT (Sicht A). Der Grundstock.
 *
 * 2. NAEHE ZUM THEMENNAMEN (Sicht C). Der Name ist kurz wie eine Frage — der
 *    Vergleich ist damit symmetrisch, waehrend eine 60-Zeichen-Frage gegen
 *    1376 Zeichen Text es nicht ist. Allein liefert diese Sicht nur 26 %, im
 *    Verbund traegt sie verlaesslich (Gewicht 0,6 in beiden Richtungen).
 *
 * 3. RUECKKOPPLUNG. Die ersten drei Treffer sind meistens ungefaehr richtig.
 *    Ihre Vektoren werden zu einem Viertel unter die Frage gemischt, dann wird
 *    erneut verglichen. Kostet nichts — keine neue Einbettung, nur eine
 *    Mittelung vorhandener Zahlen.
 *
 * 4. SELTENHEITS-UEBERLAPPUNG. Welcher Anteil der SELTENEN Fragewoerter kommt
 *    im Text vor. Ohne Laengennormierung, ohne unscharfe Treffer, ohne
 *    Bigramme.
 *
 *    Das ist der unbequeme Befund: dieses eine Verhaeltnis bekam beim Einstellen
 *    das Gewicht 1,0 bis 1,6 — unser ausgefeiltes BM25 mit Laengennormierung,
 *    Bigramm-Naehe, unscharfen Treffern und Frischebonus bekam NULL. Nicht weil
 *    Woerter nichts taugen, sondern weil das ganze Beiwerk beim Sortieren
 *    daneben misst.
 *
 * ── Warum innerhalb des Topfes normiert wird ────────────────────────────────
 *
 * Ueber den ganzen Bestand liegen alle Aehnlichkeiten zwischen 0,42 und 0,61 —
 * ein sehr schmales Band, weil alle Vektoren eine gemeinsame Grundrichtung
 * teilen (gemessen: 69,8 Prozent). Unter fuenfzig Kandidaten spreizt eine
 * Normierung auf 0 bis 1 genau die Unterschiede auf, um die es geht. Das ist
 * dasselbe Ziel wie beim Schwerpunkt-Abziehen — nur dort, wo es wirkt.
 */

import { kosinus } from './bedeutung.js';

/** Wörter eines Textes, umlautfrei, ohne Kurzwörter. */
export function inhaltsWoerter(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Es gibt hier KEINE Stammbildung — und das ist gemessen, nicht vergessen.
 *
 * Naheliegend wäre, `Abhaengigkeiten` und `Abhaengigkeit` auf einen Nenner zu
 * bringen. Drei Varianten wurden am 19.08.2026 an 499 Lektionen mit 100 Fragen
 * kreuzweise durchgemessen:
 *
 *   ohne Stammbildung          P@1 50 %   MRR 56,4 %
 *   erste 6 Zeichen            P@1 47 %   MRR 54,7 %
 *   erste 8 Zeichen            P@1 47 %   MRR 54,7 %
 *
 * Jede Form von Kürzen kostet drei Punkte. Der Grund liegt daran, was diese
 * Suche trägt: seltene Fachwörter. `fail2ban`, `stampede`, `timestamptz`,
 * `keycloak` entscheiden eine Frage praktisch allein — und jede Verschmelzung
 * verwischt genau sie. `container` und `contains` werden zu demselben Wort,
 * und aus zwei seltenen wird ein häufiges.
 *
 * Beugung einzufangen lohnt sich also nur, wo die häufigen Wörter zählen. Hier
 * zählen die seltenen.
 *
 * (Die Wortform-Behandlung in deutsch.ts bleibt davon unberührt — sie wirkt im
 * Wortabgleich, der die Vorauswahl macht, nicht in dieser Bewertung.)
 */
export function grobStamm(w: string): string {
  return w;
}

/**
 * Die Seltenheit jedes Wortes im Bestand — einmal berechnet, oft benutzt.
 *
 * Trifft eine Frage das Wort "nicht", sagt das nichts. Trifft sie "fail2ban",
 * ist die Sache praktisch entschieden. Ohne diese Gewichtung sind beide gleich
 * viel wert.
 */
export class Seltenheit {
  private df = new Map<string, number>();
  private anzahl = 0;

  /** @param texte je ein Text pro Datensatz */
  constructor(texte: string[]) {
    this.anzahl = texte.length;
    for (const t of texte) {
      for (const w of inhaltsWoerter(t)) this.df.set(grobStamm(w), (this.df.get(grobStamm(w)) ?? 0) + 1);
    }
  }

  wert(wort: string): number {
    return Math.log((this.anzahl + 1) / ((this.df.get(grobStamm(wort)) ?? 0) + 1));
  }

  /**
   * Welcher Anteil der seltenen Fragewörter kommt im Text vor.
   *
   * Der Nenner ist die Summe über ALLE Fragewörter — ein fehlendes seltenes
   * Wort zieht damit den Wert herunter. Fehlende Belege zählen also mit, nicht
   * nur vorhandene.
   */
  deckung(frageWoerter: Set<string>, textWoerter: Set<string>): number {
    let gesamt = 0;
    let getroffen = 0;
    for (const w of frageWoerter) {
      const g = this.wert(w);
      gesamt += g;
      if (textWoerter.has(grobStamm(w))) getroffen += g;
    }
    return gesamt > 0 ? getroffen / gesamt : 0;
  }
}

/** Auf 0 bis 1 spreizen — innerhalb des Topfes, nicht über den Bestand. */
export function spreizeImTopf(werte: number[]): number[] {
  const gueltig = werte.filter((x) => Number.isFinite(x) && x > -2);
  if (gueltig.length === 0) return werte.map(() => 0);
  let min = Infinity; let max = -Infinity;
  for (const x of gueltig) { if (x < min) min = x; if (x > max) max = x; }
  if (max === min) return werte.map(() => 0.5);
  return werte.map((x) => (x > -2 ? (x - min) / (max - min) : 0));
}

/**
 * Die Frage mit ihren besten Treffern anreichern.
 *
 * Die Frage benutzt Alltagsworte, die Lektionen Fachworte. Die ersten Treffer
 * schlagen diese Brücke: ihre Vektoren zeigen dorthin, wo die Antwort liegt.
 *
 * Das Risiko ist bekannt und begrenzt: sind die ersten Treffer falsch, zieht
 * die Anreicherung in die falsche Richtung. Deshalb bleibt die ursprüngliche
 * Frage mit drei Vierteln stehen — gemessen war das besser als jede stärkere
 * Beimischung.
 */
export function reichereAn(frage: number[], besteTreffer: number[][], anteil = 0.25): number[] {
  if (besteTreffer.length === 0) return frage;
  const d = frage.length;
  const m = new Array<number>(d).fill(0);
  for (const v of besteTreffer) {
    if (v.length !== d) continue;
    for (let i = 0; i < d; i++) m[i] += v[i] / besteTreffer.length;
  }
  return frage.map((x, i) => (1 - anteil) * x + anteil * m[i]);
}

/**
 * Die Gewichte.
 *
 * Kreuzweise ermittelt: auf der einen Hälfte der Fragen eingestellt, auf der
 * anderen gemessen, in beide Richtungen. Die drei Werte hier waren in BEIDEN
 * Richtungen stabil. Zwei weitere Merkmale — Überlappung mit dem Themennamen
 * und Qualitätsmerkmale — schwankten zwischen den Richtungen und sind deshalb
 * NICHT dabei: was nur in einer Hälfte hilft, ist eine Eigenschaft dieser
 * Hälfte, keine des Verfahrens.
 */
export const GEWICHTE = {
  /** Nähe zum ganzen Text. Der Grundstock, deshalb 1. */
  text: 1,
  /** Nähe zum Themennamen. In beiden Richtungen 0,6. */
  thema: 0.6,
  /** Angereicherte Frage gegen den ganzen Text. In beiden Richtungen 0,3. */
  rueckkopplung: 0.3,
  /** Anteil der seltenen Fragewörter im Text. 1,0 bis 1,6 — Mitte genommen. */
  seltenheit: 1.3,
} as const;

export interface Bewertbar {
  /** Kosinus zur Sicht über den ganzen Text, oder -2 wenn kein Vektor da ist. */
  naeheText: number;
  /** Kosinus zur Sicht über den Themennamen. */
  naeheThema: number;
  /** Kosinus der angereicherten Frage zum ganzen Text. */
  naeheRueckkopplung: number;
  /** Anteil der seltenen Fragewörter, die im Text vorkommen. */
  seltenheitsDeckung: number;
}

/**
 * Punktzahl je Kandidat. Höher ist besser.
 *
 * Erwartet den GANZEN Topf auf einmal, weil die Normierung ihn braucht — eine
 * Punktzahl für einen einzelnen Kandidaten gibt es nicht und kann es nicht
 * geben.
 */
export function bewerteTopf(topf: Bewertbar[], gewichte = GEWICHTE): number[] {
  const t = spreizeImTopf(topf.map((k) => k.naeheText));
  const th = spreizeImTopf(topf.map((k) => k.naeheThema));
  const r = spreizeImTopf(topf.map((k) => k.naeheRueckkopplung));
  return topf.map((k, i) =>
    gewichte.text * t[i]
    + gewichte.thema * th[i]
    + gewichte.rueckkopplung * r[i]
    + gewichte.seltenheit * k.seltenheitsDeckung);
}

/**
 * Punktzahl je Kandidat — STRENGE Fassung: Merkmale multiplizieren statt addieren.
 *
 * ── Das Vorbild ─────────────────────────────────────────────────────────────
 *
 * Kinetisches Korrekturlesen (Hopfield 1974, T-Zell-Rezeptoren): Biochemie
 * erreicht Fehlerraten weit unter dem, was ein einzelner Bindungsschritt
 * hergibt, indem sie Kandidaten durch eine KETTE von Pruefschritten schickt.
 * Bei jedem Schritt kann der Kandidat abfallen; die Trennschaerfe der Schritte
 * MULTIPLIZIERT sich, statt sich zu mitteln.
 *
 * ── Der Unterschied zur Addition ────────────────────────────────────────────
 *
 * In der Summe (bewerteTopf) kann ein Kandidat totale Schwaeche in einem
 * Merkmal mit Staerke in einem anderen voll ausgleichen. Im Produkt nicht:
 * eine Null in einem Merkmal drueckt die Gesamtnote, egal wie gut der Rest
 * ist. Das Produkt verlangt STIMMIGKEIT ueber alle Merkmale — die Summe
 * verlangt nur Masse.
 *
 * `basis` stellt die Strenge ein: grosse Basis naehert sich der Summe an,
 * kleine Basis macht eine Null toedlich. Rechnerisch ist das eine gewichtete
 * Summe im Logarithmus — der Unterschied zur Addition ist die begrenzte
 * Ausgleichbarkeit, nicht die Buchhaltung.
 *
 * Ergebnis der Messung vom 21.08.2026 steht in src/bench/fusion-vergleich.ts.
 */
export function bewerteTopfStreng(topf: Bewertbar[], gewichte = GEWICHTE, basis = 0.3): number[] {
  const t = spreizeImTopf(topf.map((k) => k.naeheText));
  const th = spreizeImTopf(topf.map((k) => k.naeheThema));
  const r = spreizeImTopf(topf.map((k) => k.naeheRueckkopplung));
  return topf.map((k, i) =>
    gewichte.text * Math.log(basis + t[i])
    + gewichte.thema * Math.log(basis + th[i])
    + gewichte.rueckkopplung * Math.log(basis + r[i])
    + gewichte.seltenheit * Math.log(basis + k.seltenheitsDeckung));
}

/** Bequemlichkeit: Kosinus mit Lücken-Behandlung. */
export function naeheOderLuecke(frage: number[] | null, vektor: number[] | null | undefined): number {
  return frage && vektor && vektor.length > 0 ? kosinus(frage, vektor) : -2;
}
