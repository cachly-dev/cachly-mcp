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
  /** Mittlere Zahl VERSCHIEDENER Wortstaemme je Text — fuer die Laengenkorrektur. */
  private mittlereWortzahl = 1;

  /** Lesend fuer Messwerkzeuge, die die Laengenkorrektur zurueckrechnen. */
  get mittlereStammzahl(): number { return this.mittlereWortzahl; }

  /**
   * Optionale Gewichtskurve ueber df — NUR fuer Messwerkzeuge (Naturworkshop
   * K3, Zipf-Mandelbrot). Ohne Angabe gilt die ausgelieferte IDF-Kurve;
   * kein Produktpfad setzt diesen Parameter.
   */
  private kurve: ((df: number, anzahl: number) => number) | null = null;

  /** @param texte je ein Text pro Datensatz */
  constructor(texte: string[], kurve?: (df: number, anzahl: number) => number) {
    this.kurve = kurve ?? null;
    this.anzahl = texte.length;
    let stammSumme = 0;
    for (const t of texte) {
      const staemme = new Set<string>();
      for (const w of inhaltsWoerter(t)) {
        const s = grobStamm(w);
        staemme.add(s);
        this.df.set(s, (this.df.get(s) ?? 0) + 1);
      }
      stammSumme += staemme.size;
    }
    this.mittlereWortzahl = texte.length > 0 ? Math.max(1, stammSumme / texte.length) : 1;
  }

  wert(wort: string): number {
    const df = this.df.get(grobStamm(wort)) ?? 0;
    if (this.kurve) return this.kurve(df, this.anzahl);
    return Math.log((this.anzahl + 1) / (df + 1));
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
    const roh = gesamt > 0 ? getroffen / gesamt : 0;
    if (roh === 0) return 0;
    /*
     * ── Die Laengenkorrektur (30.08.2026, Karte evpcpv1oreo4) ─────────────
     *
     * Ein langer Text deckt seltene Fragewoerter ZUFAELLIG ab: bei den
     * Seltenheits-Verlusten war der falsche Sieger im Median 663 Zeichen
     * lang, die richtige Antwort 306 (Kontrollgruppe text-Verluste: 421
     * gegen 444 — kein Effekt; verlust-zerlegen.ts). Die BM25-Normierung
     * teilt durch den Laengenfaktor; kurze Texte duerfen dadurch ueber 1
     * liegen — spreizeImTopf normiert ohnehin je Topf.
     *
     * Auf A gewaehlt, auf B EINMAL bestaetigt: P@1 +1,0, @3 +0,8.
     * Wert und Messregel: SELTENHEIT_LAENGE_B (Stellschrauben-Datei).
     */
    const faktor = 1 - SELTENHEIT_LAENGE_B
      + (SELTENHEIT_LAENGE_B * textWoerter.size) / this.mittlereWortzahl;
    return faktor > 0 ? roh / faktor : roh;
  }

  /**
   * Der beste Zeuge: die hoechste Seltenheit unter den GETEILTEN Woertern.
   *
   * ── Warum ein Maximum neben dem Anteil (Naturworkshop 3, 24.08.2026) ──────
   *
   * `deckung` ist ein Anteil. Ein entscheidender Token wie
   * `_sync_to_local_dir_if_changed` — geteilt zwischen Frage und richtiger
   * Antwort, im Bestand fast einmalig — wird darin von vierzig
   * gleichgueltigen Fragewoertern weggemittelt. Ein Maximum kann nicht
   * weggemittelt werden: ein geteilter, fast einmaliger Token hat genau EINE
   * Erklaerung (Hennigs Synapomorphie — ein abgeleitetes Merkmal schlaegt
   * hundert geteilte urspruengliche).
   *
   * Gemessen auf 2001 Fragen aus sechs NIE gesehenen Projekten, Gewicht nur
   * auf den vier anderen eingestellt: Findequote@3 42,0 → 44,1 % (+70/−27,
   * p<0,0001). Gegenproben: Gewinn in fuenf von sechs Projekten (groesster
   * Anteil 44 %); dasselbe Merkmal je Frage PERMUTIERT verliert 54 Faelle —
   * der Inhalt traegt, nicht der freie Parameter. Mehr Gewicht auf `deckung`
   * stattdessen: −0,6. Messstand:
   * .agent/_naturworkshop/laeufe/2026-08-24-verfahren-suche-3/
   *
   * Die Formel ist auf 0..1 normiert (log(N+1) im Nenner), ueber DIESELBE
   * df-Tabelle wie `wert` — bewusst keine zweite Zaehlung. Baugleichheit mit
   * der rohen Messfassung ist belegt: 44,2 gegen 44,1 auf Satz B, eine
   * einzige Frage antwortet anders (variante-stamm-df.mjs im Laufordner).
   *
   * 0 heisst: kein geteiltes Wort. Das ist ein ECHTER Wert, kein Ausfall —
   * er nimmt an der Topf-Spreizung teil.
   */
  besterZeuge(frageWoerter: Set<string>, textWoerter: Set<string>): number {
    let best = 0;
    const nenner = Math.log(this.anzahl + 1);
    if (nenner <= 0) return 0;
    for (const w of frageWoerter) {
      if (!textWoerter.has(grobStamm(w))) continue;
      const g = this.wert(w) / nenner;
      if (g > best) best = g;
    }
    return best;
  }
}

/**
 * Auf 0 bis 1 spreizen — innerhalb des Topfes, nicht über den Bestand.
 *
 * ══ Was eine Lücke bedeutet (Karte azmqezaxx2kx, 23.08.2026) ═══════════════
 *
 * Bis heute bekam ein fehlender Wert (−2) eine **Null**, also den
 * schlechtesten Platz im Bereich [0,1]. Wer das Merkmal hatte, konnte damit
 * nur gewinnen; wer es nicht hatte, nur verlieren.
 *
 * Das ist kein Fehler EINES Merkmals. Es trifft jedes Merkmal, das nicht alle
 * Lektionen haben — und das sind alle außer den Volltext-Vektoren.
 *
 * ── Was es gekostet hat, in Zahlen ────────────────────────────────────────
 *
 * Bei den Fehlertext-Türen hatten 108 von 507 Lektionen keinen Eintrag. Sie
 * wurden systematisch nach unten gedrückt, unabhängig von der Passung.
 * Gemessene Folge: die Türen sahen netto negativ aus (−2 auf Platz 1) und
 * wurden ausgebaut. Mit einer Schwelle davor sind sie **+2 auf Platz 1 und
 * +2 auf @3** — der Ausbau war die falsche Schlussfolgerung aus einer
 * richtigen Messung. Bei der Resonanz dasselbe Bild: 64 von 499 Lektionen.
 *
 * ── Der Einwand, der hier vorher stand, und warum er nicht trägt ──────────
 *
 * Die alte Probe begründete die Null so: *"Ein fehlender Vektor darf nicht
 * als mittelmäßig durchgehen — sonst schlägt 'keine Angabe' eine echte,
 * schlechte Bewertung."*
 *
 * Der Einwand beschreibt einen echten Effekt, zieht aber den falschen
 * Schluss. **Eine gemessene schlechte Zahl ist ein Beleg GEGEN eine Lektion.
 * Eine Lücke ist gar kein Beleg.** Wer beides gleich behandelt, tut so, als
 * wüsste er etwas, das er nicht weiß — und bestraft dabei genau die
 * Lektionen, über die das Merkmal nichts sagen kann.
 *
 * Die Lücke landet deshalb auf dem **Mittelwert der gültigen Werte**: kein
 * Auftrieb, kein Abzug. Wer besser ist als der Durchschnitt, gewinnt gegen
 * sie; wer schlechter ist, verliert gegen sie. Genau das heißt "unbekannt".
 *
 * ── Warum das mehr ist als eine Feinheit ─────────────────────────────────
 *
 * In `handlers/brain.ts` steht heute ein `EINGANG_SCHWELLE`, der −2 erzeugt,
 * bevor diese Funktion es falsch verrechnet. Das wirkt, ist aber eine
 * Umgehung an der Aufrufstelle: **jedes künftige Merkmal braucht dieselbe
 * Umgehung, und wer sie vergisst, baut den Fehler neu.**
 */
export function spreizeImTopf(werte: number[]): number[] {
  const gueltig = werte.filter((x) => Number.isFinite(x) && x > -2);
  if (gueltig.length === 0) return werte.map(() => 0);
  let min = Infinity; let max = -Infinity;
  for (const x of gueltig) { if (x < min) min = x; if (x > max) max = x; }
  if (max === min) return werte.map(() => 0.5);

  // −1 markiert vorläufig die Lücken: der Wertebereich der gültigen ist [0,1],
  // ein negativer Wert kann dort nicht entstehen und ist damit eindeutig.
  const gespreizt = werte.map((x) =>
    Number.isFinite(x) && x > -2 ? (x - min) / (max - min) : -1);
  let summe = 0;
  for (const x of gespreizt) if (x >= 0) summe += x;
  const mittel = summe / gueltig.length;
  return gespreizt.map((x) => (x >= 0 ? x : mittel));
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
/**
 * ══ Angepasst am 23.08.2026, zum ersten Mal ════════════════════════════════
 *
 * Diese vier Zahlen waren bis heute von Hand abgetastet — jede einzeln, auf
 * 100 Fragen. Sie waren das beste Wissen von jemandem, nicht das Ergebnis von
 * Fällen.
 *
 * Seit dem 22.08.2026 liegen zwei überschneidungsfreie Sätze bereit: 2997
 * Fragen zum Einstellen, 3003 zum Abnehmen, beide über vier Achsen
 * geschichtet. Sie sind nie benutzt worden.
 *
 * Angepasst wurde per Koordinatensuche auf dem EINSTELLsatz
 * (`bench/gewichte-anpassen.ts`, 63 Bewertungen), abgenommen genau einmal auf
 * dem Prüfsatz:
 *
 *                  Prüfsatz vorher   Prüfsatz nachher
 *     Platz 1           48,8 %            51,8 %
 *     Findequote@3      64,0 %            66,7 %
 *     Top 10            76,6 %            77,9 %
 *
 * Der Gewinn überträgt sich also auf Fragen, die beim Einstellen nie gesehen
 * wurden. Die Nachbarschaft trägt: eine Änderung um ±0,1 auf jeder Achse
 * kostet höchstens 0,5 Punkte — das Ergebnis steht nicht auf einer
 * Messerschneide.
 *
 * ── Der überraschende Teil ────────────────────────────────────────────────
 *
 * `thema` will auf NULL. Die Ähnlichkeit zum Themennamen trägt auf diesem
 * Bestand nichts bei; sie kostet sogar. Das Merkmal bleibt im Code — es wird
 * nur nicht mehr gewichtet.
 *
 * ── Die Einschränkung, die dazugehört ────────────────────────────────────
 *
 * Angepasst wurde auf EINEM Bestand: unseren 499 Lektionen. Dass `thema` hier
 * nichts trägt, heißt nicht, dass es bei einer Kundin mit anderen Themennamen
 * nichts trägt. Die richtige Antwort darauf sind Gewichte JE INSTANZ, gespeist
 * aus der Wirkungsspur (`wirkungsspur.ts`) — bis dahin ist das hier der beste
 * gemessene Stand, nicht der endgültige.
 */
export const GEWICHTE = {
  /** Nähe zum ganzen Text. Der Grundstock, deshalb 1 — die Skala ist frei. */
  text: 1,
  /**
   * Nähe zum Themennamen. Angepasst von 0,6 auf 0. Auf 2997 Einstellfragen
   * gemessen: jeder Wert über 0 kostet Findequote@3.
   */
  thema: 0,
  /**
   * Angereicherte Frage gegen den ganzen Text. Unverändert 0,3.
   *
   * Die Anpassung vom 23.08.2026 hatte 0,15 vorgeschlagen. Am 24.08. einzeln
   * nachgemessen — und wieder zurückgenommen, weil sie nichts trägt:
   *
   *              Platz 1        @3           Top 10
   *   eigener    +0,4 (p 0,045) 0,0 (p 0,82) +0,1 (p 0,58)
   *   fremder    +0,1 (p 1,00)  −0,3 (p 0,45) −0,3 (p 0,37)
   *
   * Auf 1195 fremden Paaren ist sie sogar leicht negativ. Eine Änderung, die
   * man nicht belegen kann, wird nicht ausgeliefert — auch dann nicht, wenn
   * sie aus einer Anpassung stammt, deren übrige Teile tragen.
   */
  rueckkopplung: 0.3,
  /** Anteil der seltenen Fragewörter im Text. Unverändert — 1,3 hält. */
  seltenheit: 1.3,
  /**
   * Der beste Zeuge — das MAXIMUM der Wort-Seltenheit statt des Anteils.
   *
   * Naturworkshop 3 (24.08.2026), auf A eingestellt (0,2/0,5/0,8/1,2/1,8/2,5
   * abgetastet, 0,5 bestes), EINMAL auf sechs nie gesehenen Projekten
   * gemessen: @3 42,0 → 44,1 % (p<0,0001), Gewinn in fünf von sechs
   * Projekten, Zufallskontrolle −54 Fälle. Begründung und Messstand am
   * `Seltenheit.besterZeuge`-Kommentar.
   */
  zeuge: 0.5,
} as const;

/**
 * ══ Der dritte Ausgang: Ablehnen bei knappem Sieg ═════════════════════════
 *
 * Fellegi und Sunter (1969): drei Ausgänge, nicht zwei — und der mittlere
 * ist ein Ergebnis, kein Fehler. Bis zum 30.08.2026 antwortete die Suche
 * IMMER, auch wenn Platz 1 und Platz 2 punktgleich waren. Ein knapper Sieg
 * ist aber ein Ratespiel, kein Befund.
 *
 * ── Die Schwelle ist gemessen, nicht gesetzt ──────────────────────────────
 *
 * Auf den Merkmals-Auszügen der Fremd-Fragen (bewerteTopf mit den
 * Auslieferungs-GEWICHTEN, Vertrauenssignal = Punktabstand Platz 1 zu 2):
 *
 *   Einstellhälfte A (1999 Fragen): P@1 ohne Ablehnen 42,7 %.
 *     Schwelle 0,05 → Deckung 79,5 %, P@1 unter den Beantworteten 50,1 %,
 *     abgelehnt 353 falsche gegen 56 richtige Antworten (6,3:1).
 *
 *   Prüfhälfte B (2001 Fragen, genau EIN Bestätigungslauf): P@1 32,1 %.
 *     Schwelle 0,05 → Deckung 76,7 %, P@1 38,8 %,
 *     abgelehnt 420 falsche gegen 47 richtige (8,9:1).
 *
 * Der Gewinn hält auf Fragen, die die Schwelle nie gesehen hat. Werkzeug:
 * `src/bench/dritter-ausgang-messen.ts` — wer die Schwelle ändern will,
 * misst dort nach, wählt auf A und bestätigt auf B genau einmal.
 *
 * ── Was Ablehnen hier heißt ───────────────────────────────────────────────
 *
 * NICHT Schweigen. Die Treffer werden weiter gezeigt — aber mit dem
 * ehrlichen Satz davor, dass der Bestand hier nichts klar Bestes hat.
 * Wer die Liste trotzdem lesen will, kann das; wer ihr blind vertraut
 * hätte, wird gewarnt. Erst der gelesene Wert, dann das Urteil.
 */
import { ABLEHN_ABSTAND, SELTENHEIT_LAENGE_B } from './rangfolge-stellschrauben.js';
export { ABLEHN_ABSTAND };

/**
 * Der Satz zum knappen Sieg — oder null, wenn der Sieg deutlich ist.
 *
 * Als reine Funktion herausgelöst, damit die Probe sie ohne den ganzen
 * Recall-Apparat prüfen kann.
 */
export function knapperSiegSatz(abstand: number | null): string | null {
  if (abstand === null || abstand >= ABLEHN_ABSTAND) return null;
  return (
    '⚖️ **Kein klarer Bester** — Platz 1 liegt nur '
    + abstand.toFixed(2)
    + ` Punkte vor Platz 2 (Schwelle ${ABLEHN_ABSTAND}). Bei so knappem Abstand ist die Reihenfolge `
    + 'ein Ratespiel: gemessen treffen solche Antworten 6- bis 9-mal häufiger daneben als sonst. '
    + 'Die Treffer unten sind das Nächstliegende, kein Befund.'
  );
}


export interface Bewertbar {
  /** Kosinus zur Sicht über den ganzen Text, oder -2 wenn kein Vektor da ist. */
  naeheText: number;
  /** Kosinus zur Sicht über den Themennamen. */
  naeheThema: number;
  /** Kosinus der angereicherten Frage zum ganzen Text. */
  naeheRueckkopplung: number;
  /** Anteil der seltenen Fragewörter, die im Text vorkommen. */
  seltenheitsDeckung: number;
  /**
   * Seltenheit des seltensten GETEILTEN Wortes (`Seltenheit.besterZeuge`).
   *
   * Optional, damit ältere Aufrufer weiterlaufen: fehlt der Wert überall,
   * spreizt der Topf lauter Gleiche und das Merkmal ändert keine Rangfolge.
   */
  besterZeuge?: number;
}

/**
 * Punktzahl je Kandidat. Höher ist besser.
 *
 * Erwartet den GANZEN Topf auf einmal, weil die Normierung ihn braucht — eine
 * Punktzahl für einen einzelnen Kandidaten gibt es nicht und kann es nicht
 * geben.
 *
 * ── WARUM `seltenheitsDeckung` NICHT gespreizt wird (gemessen 22.08.2026) ───
 *
 * Drei Merkmale laufen durch `spreizeImTopf`, das vierte nicht — und
 * ausgerechnet das vierte hat mit 1,3 das höchste Gewicht. Das sieht nach
 * einem Versehen aus. Es ist keines.
 *
 * Im zweiten Naturworkshop hat eine Rolle genau diese Unstimmigkeit gefunden
 * und daraus einen Kandidaten gebaut. Gemessen auf dem eingefrorenen Prüfsatz
 * (100 ungesehene Fragen), Platz 1 / @3:
 *
 *   Auslieferstand, roh          39,0 / 58,0   <- hier
 *   dieselbe Zahl, gespreizt     38,0 / 56,0
 *   Topf-Seltenheit zusätzlich   33,0 / 53,0
 *   Topf-Seltenheit statt global 37,0 / 53,0
 *   KONTROLLE Zufallstexte       32,0 / 50,0
 *
 * Spreizen KOSTET zwei Punkte @3 und einen auf Platz 1. Der Grund: Der Wert
 * ist durch seine Bauart schon auf 0..1 (`getroffen / gesamt` in
 * `Seltenheit.deckung`) und trägt eine ABSOLUTE Aussage — "diese Lektion deckt
 * 80 Prozent der seltenen Fragewörter ab". `spreizeImTopf` wirft genau diese
 * Absolutheit weg: es zieht den kleinsten Wert im Topf auf 0 und den größten
 * auf 1, egal wie nah die beiden beieinanderliegen. Aus einem Unterschied von
 * 0,02 zwischen zwei fast gleichen Kandidaten wird so der volle Abstand. Bei
 * den Kosinus-Merkmalen ist das erwünscht — die liegen alle eng beieinander
 * und tragen keine absolute Bedeutung. Hier macht es aus Rauschen ein Signal.
 *
 * Der Eingriff hat nachweislich stattgefunden: in 709 Fällen unterschieden
 * sich globale und Topf-Seltenheit um mehr als 0,05.
 *
 * Wer diese Zeile "aufräumen" will, misst vorher mit
 * `src/bench/topfseltenheit-messen.ts` gegen. Das ist billiger als der Punkt,
 * den es kostet.
 */
export function bewerteTopf(topf: Bewertbar[], gewichte = GEWICHTE): number[] {
  const t = spreizeImTopf(topf.map((k) => k.naeheText));
  const th = spreizeImTopf(topf.map((k) => k.naeheThema));
  const r = spreizeImTopf(topf.map((k) => k.naeheRueckkopplung));
  /*
   * Der beste Zeuge wird GESPREIZT, nicht roh — so wurde er gemessen
   * (messung-bester-zeuge.mjs: LAM * spreizeImTopf(zeuge)). 0 ist ein
   * echter Wert (kein geteiltes Wort), kein Ausfall. Fehlt das Feld bei
   * allen (alte Aufrufer), sind alle gleich und nichts verschiebt sich.
   *
   * `?? 0` auch am Gewicht: Vergleichswerkzeuge bauen eigene
   * Gewichts-Objekte aus Zeichenketten; ein fehlender Eintrag darf die
   * Punktzahl nicht zu NaN machen.
   */
  const z = spreizeImTopf(topf.map((k) => k.besterZeuge ?? 0));
  const zg = gewichte.zeuge ?? 0;
  return topf.map((k, i) =>
    gewichte.text * t[i]
    + gewichte.thema * th[i]
    + gewichte.rueckkopplung * r[i]
    // ABSICHTLICH roh — siehe die Messung im Kommentar oben.
    + gewichte.seltenheit * k.seltenheitsDeckung
    + zg * z[i]);
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
