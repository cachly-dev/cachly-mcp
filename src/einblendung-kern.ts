/**
 * Der Kern der Einblendung — EINE Sortierung fuer Hook und Messstand.
 *
 * ── Warum es diese Datei gibt (06.09.2026) ──────────────────────────────────
 *
 * Bis heute sortierte die automatische Einblendung dreimal, jedes Mal anders:
 *
 *   1. Die Go-API (`recallMatchScore`) zaehlt rohe Worttreffer und waehlt 50 aus.
 *   2. Dieselbe API kuerzt `what_worked` auf 120 Zeichen (`truncate`, TopLesson)
 *      und schickt `what_failed` und `context` gar nicht mit.
 *   3. Der Hook (`tools/ambient-recall/lib.mjs`) sortiert diese 120-Zeichen-Reste
 *      NOCH EINMAL mit einer rohen Wortzaehlung.
 *
 * Gemessen am 06.09.2026: `what_worked` ist im Bench-Korpus im Mittel 927
 * Zeichen lang. Der Hook sah davon 13 Prozent und von den beiden anderen
 * Feldern nichts. Die Erweiterung des Suchtextes aus PR #660 (+4,5 Punkte auf
 * Platz 1) wirkte damit nur in der Vorauswahl, nie in der Endsortierung.
 *
 * ── Was diese Datei aendert ─────────────────────────────────────────────────
 *
 * Der Hook haelt den vollen Bestand lokal vor (`/export`, ungekuerzt) und
 * sortiert ihn hier — mit denselben Bausteinen wie `smart_recall`: der
 * Wortsuche aus `search.ts` und der Seltenheitsrechnung aus `rangfolge.ts`.
 * Keine zweite Umsetzung: `tools/ambient-recall/` bekommt diese Datei als
 * gebuendelte `.mjs` (siehe `scripts/einblendung-kern-buendeln.mjs`), ein
 * Waechter prueft den Abgleich.
 *
 * ── Was die Vektoren wirklich tragen ────────────────────────────────────────
 *
 * Der Hook feuert bei jedem Prompt und darf deshalb nicht einbetten — ihm
 * fehlen drei der fuenf Merkmale von `bewerteTopf`. Wie teuer das ist, war
 * bis zum 06.09.2026 falsch aufgeschrieben. Die Uebergabe jenes Tages nannte
 * 45 % Platz 1 fuer den "Wortpfad allein", gemessen mit `--sinnpool 0`. Der
 * Schalter nimmt den Vektoren aber nur die NOMINIERUNG, nicht die SORTIERUNG.
 * Derselbe Messstand, dieselben 3003 Fragen, dieselbe Vorauswahl:
 *
 *   --sinnpool 0 (Vektoren sortieren mit)      Platz 1 45 %   @3 60 %
 *   Vektorgewichte auf 0 (wirklich nur Worte)  Platz 1 28 %   @3 43 %
 *
 * Die Vektoren tragen 17 Punkte. Der Hook muss ohne sie auskommen, und
 * deshalb sortiert er hier ANDERS als `smart_recall` — mit denselben
 * Bausteinen, aber eigenen, eigens gemessenen Gewichten
 * (EINBLENDUNG_DECKUNG / EINBLENDUNG_ZEUGE in rangfolge-stellschrauben.ts).
 */

import { Seltenheit, inhaltsWoerter, grobStamm, spreizeImTopf } from './rangfolge.js';
import { lektionsText } from './seltenheitsbestand.js';
import { bestandAusDokumenten, keywordSearchMitBestand, type Wortbestand } from './search.js';
import { SINN_TOPF, EINBLENDUNG_DECKUNG, EINBLENDUNG_ZEUGE } from './rangfolge-stellschrauben.js';

/**
 * Wie viele Kandidaten die Wortsuche nominiert, bevor sortiert wird.
 *
 * 75, wie `SINN_TOPF`. Das Produkt gibt seinem Wortkanal 25 Plaetze
 * (handlers/brain.ts, keywordSearch(..., 25)); fuer die Einblendung ist die
 * Zahl gemessen gleichgueltig — 800 Pruefsatzfragen, Arm C:
 *
 *   Topf 10    Platz 1 35,1 %   @3 50,5 %   @10 63,5 %
 *   Topf 25            36,3 %      51,0 %       65,5 %
 *   Topf 75            36,5 %      51,1 %       66,4 %
 *
 * Der Wert bleibt bei 75, weil er die Kandidatenliste fuer die Fehlersuche
 * laenger macht, ohne etwas zu kosten. Wer ihn aendert, misst mit
 * `bench/einblendung-messen.ts --topf <n>` nach.
 */
export const WORT_TOPF = SINN_TOPF;

/**
 * Welche Felder die Wortsuche indiziert.
 *
 * ── Warum eine Liste und nicht die ganze Lektion ────────────────────────────
 *
 * In `search.ts` steht ausdruecklich: indiziert wird der ROHE Inhalt, keine
 * Feldauswahl — mit Messung dagegen. Diese Liste widerspricht dem nicht, sie
 * stellt einen Messfehler ab.
 *
 * Gemessen wurde die Einblendung gegen `korpus-gross.json`. Dessen Lektionen
 * tragen genau diese neun Felder. Der echte Bestand tragt achtzehn, darunter
 * `audit_trail` — bei 759 von 760 Lektionen vorhanden und ein Drittel aller
 * Zeichen (1,63 MB gegen 1,09 MB). Wer den ganzen Datensatz indiziert, laesst
 * den Hook etwas anderes durchsuchen, als der Messstand gemessen hat: Namen,
 * Zeitstempel und Pruefspur aus dem Verlauf treten als Wettbewerber auf.
 *
 * Die Liste ist also die Bruecke zwischen Messstand und Auslieferstand, nicht
 * eine Sparmassnahme. Wer sie erweitert, misst vorher mit
 * `src/bench/einblendung-messen.ts` nach — mit einem Korpus, der die neuen
 * Felder ueberhaupt enthaelt.
 */
export const INDEX_FELDER = [
  'topic', 'outcome', 'what_worked', 'what_failed',
  'severity', 'confidence', 'recall_count', 'ts', 'endorsements',
] as const;

/**
 * Eine Lektion, so wie sie aus `/export` kommt: der gespeicherte Rohwert.
 * Absichtlich offen — der Export reicht Felder durch, die dieses struct nicht
 * kennt, und die duerfen nicht verloren gehen.
 */
export interface EinblendLektion {
  topic?: string;
  what_worked?: string;
  what_failed?: string;
  outcome?: string;
  severity?: string;
  recall_count?: number;
  tags?: string[];
  [feld: string]: unknown;
}

export interface Bewertet<L> {
  lektion: L;
  /** Punktzahl der Sortierung. Nur INNERHALB eines Aufrufs vergleichbar. */
  punkte: number;
  /**
   * Wie viele verschiedene Frageworte im Text der Lektion vorkommen — das
   * TOR, nicht die Sortierung. Siehe `zaehleBelege`.
   */
  belege: number;
}

// ── Das Tor: Wortueberlappung ────────────────────────────────────────────────
//
// Diese Liste und die Endungen darunter standen bis zum 06.09.2026 in
// tools/ambient-recall/lib.mjs. Sie sind hierher gezogen, damit es sie einmal
// gibt. Sie spiegeln `recallStopwords` und `stemRecallToken` in
// api/internal/handler/instance_handler.go — wer eine Liste aendert, aendert
// beide.
const STOPPWOERTER = new Set(
  ('the a an and or but for to of in on at is are be do does did we you i it this that with without '
   + 'how what why when where can could would should please just get set use using make made need bitte '
   + 'und oder der die das ein eine für mit ohne wie was warum kann soll noch mal auch von den dem ist '
   // NICHT dabei: gibt/geht — als trennbare Verben tragen sie Inhalt
   // ("gibt … zurueck" = returns); "gibt" streichen kostete die
   // Fragefeld-Lektion messbar ihren Top-3-Platz.
   + 'weil wenn dann doch aber alle jede jeder jedes immer wieder wird werden wurde muss beim sehr nicht').split(/\s+/),
);

/** Beugungsendungen, laengste zuerst — Zwilling von `recallStemSuffixes` in Go. */
const STAMM_ENDUNGEN = [
  'ierungen', 'ierung', 'ieren', 'iert',
  'ungen', 'ung', 'heit', 'keit', 'lich', 'isch',
  'ing', 'ed', 'en', 'er', 'es', 'e', 'n', 's',
];

/**
 * Eine Beugungsendung abschneiden, solange vier Zeichen stehen bleiben.
 * Der Stamm ist immer ein PRAEFIX des Wortes — ein Teilzeichenketten-Vergleich
 * mit dem Stamm kann deshalb nur Treffer hinzufuegen, nie welche verlieren.
 */
export function stammKuerzen(w: string): string {
  for (const endung of STAMM_ENDUNGEN) {
    if (w.length - endung.length >= 4 && w.endsWith(endung)) return w.slice(0, -endung.length);
  }
  return w;
}

/** Die Inhaltswoerter einer Frage fuer das Tor: entdoppelt, gestammt, ohne Stoppwoerter. */
export function torWoerter(text: string): string[] {
  return [...new Set(
    String(text).toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPPWOERTER.has(w))
      // Nach dem Stammen NOCHMAL pruefen: "einen" wird zu "eine", und ein
      // Funktionswort-Stamm trifft als Teilzeichenkette den halben Bestand.
      .map(stammKuerzen)
      .filter((w) => !STOPPWOERTER.has(w)),
  )];
}

/**
 * Wie viele verschiedene Frageworte im Text vorkommen — das TOR.
 *
 * Bewusst getrennt von der Sortierung. Das Tor beantwortet "ist ueberhaupt
 * etwas da"; `sortiere` beantwortet "was davon zuerst". Ein Prompt wie
 * "danke" soll nichts einblenden, egal wie der Topf sortiert ist.
 *
 * `heuhaufen` muss bereits kleingeschrieben sein.
 */
export function zaehleBelege(tokens: string[], heuhaufen: string): number {
  let n = 0;
  for (const t of tokens) if (heuhaufen.includes(t)) n++;
  return n;
}

/**
 * Der vorgehaltene Bestand: Wortmengen und Seltenheitstabelle, einmal gebaut.
 *
 * Der Aufbau kostet einen Durchgang durch alle Lektionstexte; die einzelne
 * Frage danach kostet nur Mengenvergleiche. Genau deshalb haelt der Hook den
 * Bestand vor, statt je Prompt zu fragen.
 */
export class Einblendbestand<L extends EinblendLektion> {
  private readonly texte: string[];

  private readonly wortmengen: Set<string>[];

  private readonly heuhaufen: string[];

  private readonly statistik: Seltenheit;

  /** Der BM25-Bestand der Wortsuche — dieselbe Vorauswahl wie im Produkt. */
  private readonly wortbestand: Wortbestand | null;

  /** Redis-Schluessel -> Platz im Bestand, damit die Wortsuche zurueckfindet. */
  private readonly platzVonSchluessel = new Map<string, number>();

  /** Wie viele Kandidaten die Wortsuche nominiert. Vorgabe WORT_TOPF; der Messstand darf abweichen. */
  private readonly topf: number;

  constructor(private readonly lektionen: L[], { topf = WORT_TOPF }: { topf?: number } = {}) {
    this.topf = topf;
    // Derselbe Text wie im Messstand und in `Seltenheitsbestand`:
    // topic + what_worked + what_failed. `context` fehlt hier ABSICHTLICH,
    // weil `lektionsText` es nicht kennt — die Go-Vorauswahl durchsucht es
    // seit PR #660, dieser Pfad noch nicht. Sobald ein Pruefsatz mit
    // context-Feldern existiert, gehoert die Zahl dazu und dann das Feld.
    this.texte = lektionen.map((l) => lektionsText(l as Record<string, unknown>));
    this.wortmengen = this.texte.map(
      (t) => new Set([...inhaltsWoerter(t)].map(grobStamm)),
    );
    this.heuhaufen = this.texte.map((t) => t.toLowerCase());
    this.statistik = new Seltenheit(this.texte);

    // Schluessel und Inhalt genau wie in Valkey: `cachly:lesson:best:<topic>`
    // und der gespeicherte Rohwert. Die Wortsuche indiziert den ROHEN Inhalt,
    // nicht eine Feldauswahl — die Begruendung samt Messung steht an
    // `bestandAusDokumenten` in search.ts.
    const paare = lektionen.map((l, i) => {
      const key = `cachly:lesson:best:${String(l.topic ?? i)}`;
      this.platzVonSchluessel.set(key, i);
      const schlank: Record<string, unknown> = {};
      for (const feld of INDEX_FELDER) if (l[feld] !== undefined) schlank[feld] = l[feld];
      return { key, content: JSON.stringify(schlank) };
    });
    this.wortbestand = bestandAusDokumenten(paare);
  }

  get groesse(): number { return this.lektionen.length; }

  /**
   * Die Kandidaten fuer eine Frage, nach Punkten absteigend.
   *
   * ── Zwei Stufen ─────────────────────────────────────────────────────────
   *
   * 1. Die Wortsuche (`keywordSearchMitBestand`, BM25 mit deutschen
   *    Wortformen, Bigrammen und Frischebonus) nominiert WORT_TOPF Kandidaten
   *    UND liefert ihre Punktzahl gleich mit.
   * 2. Diese Punktzahl ist der Grundstock. Zwei Wort-Merkmale aus
   *    `Seltenheit` kommen gewichtet dazu (EINBLENDUNG_DECKUNG,
   *    EINBLENDUNG_ZEUGE — beide gemessen, Begruendung dort).
   *
   * ── Warum hier nicht `bewerteTopf` steht ────────────────────────────────
   *
   * Das war der erste Entwurf, und die Messung hat ihn verworfen. Ohne
   * Vektoren fallen drei der fuenf Merkmale von `bewerteTopf` aus, und die
   * beiden verbleibenden sind SCHWAECHER als die blosse Wortsuche — sie
   * wurden als Ergaenzung zu den Vektoren gewichtet, nicht als Sortierung
   * fuer sich. Auf 800 Fragen, Topf 75, Platz 1 / @3:
   *
   *   bewerteTopf ohne Vektoren     25,8 %  44,3 %
   *   nur die Wortsuche             32,8 %  48,8 %
   *   diese Verdrahtung             36,5 %  49,3 %
   *
   * ── Und warum eine Vorauswahl ueberhaupt ────────────────────────────────
   *
   * Ein frueherer Entwurf bewertete den GANZEN Bestand ohne Vorauswahl. Er
   * liegt bei 18,0 % Platz 1. Ursache ist die Laengenkorrektur in
   * `Seltenheit.deckung` (SELTENHEIT_LAENGE_B): sie teilt durch die
   * Textlaenge und hebt damit kurze Lektionen. Auf 75 vorgefilterten
   * Kandidaten ist das gemessen richtig; auf 499 ungefilterten spuelt sie
   * kurze Texte nach vorne, die nur zufaellig ein seltenes Wort teilen.
   */
  sortiere(frage: string): Bewertet<L>[] {
    if (!this.wortbestand) return [];
    const nominiert = keywordSearchMitBestand(this.wortbestand, frage, this.topf);
    const plaetze: number[] = [];
    const bm25: number[] = [];
    for (const m of nominiert) {
      const i = this.platzVonSchluessel.get(m.key);
      if (i !== undefined) { plaetze.push(i); bm25.push(m.score); }
    }
    if (plaetze.length === 0) return [];

    const frageWoerter = inhaltsWoerter(frage);
    const tokens = torWoerter(frage);

    // Gespreizt wie in `bewerteTopf`: die BM25-Punkte und der beste Zeuge
    // tragen keine absolute Aussage, ihr Abstand INNERHALB des Topfes schon.
    // Die Deckung geht ROH ein — sie ist von Bauart auf 0..1 und sagt "diese
    // Lektion deckt 80 Prozent der seltenen Fragewoerter ab". Spreizen wuerfe
    // genau diese Absolutheit weg; die Messung dazu steht an `bewerteTopf`.
    const b = spreizeImTopf(bm25);
    const z = spreizeImTopf(plaetze.map(
      (i) => this.statistik.besterZeuge(frageWoerter, this.wortmengen[i]),
    ));

    return plaetze
      .map((i, k) => ({
        lektion: this.lektionen[i],
        punkte: b[k]
          + EINBLENDUNG_DECKUNG * this.statistik.deckung(frageWoerter, this.wortmengen[i])
          + EINBLENDUNG_ZEUGE * z[k],
        belege: zaehleBelege(tokens, this.heuhaufen[i]),
      }))
      // Gleichstand geht an die haeufiger abgerufene Lektion — dieselbe
      // Nachrangregel wie in der Go-API und im alten Hook.
      .sort((a, b2) => b2.punkte - a.punkte
        || Number(b2.lektion.recall_count ?? 0) - Number(a.lektion.recall_count ?? 0));
  }
}
