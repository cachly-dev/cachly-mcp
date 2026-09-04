/**
 * "Nicht im Bestand" ist eine Antwort (Karte bninni0fimfy).
 *
 * ── Warum ein Gedaechtnis Nein sagen koennen muss ───────────────────────────
 *
 * Ein Abruf liefert IMMER etwas: die Rangfolge sortiert, und was oben liegt,
 * wird gezeigt — auch wenn der beste Treffer mit der Frage nichts zu tun hat.
 * Fuer den Leser sieht ein schwacher Treffer genauso aus wie ein starker; die
 * Zahl daneben liest niemand.
 *
 * Gemessen am 13.08.2026 im eigenen Bestand: 21 Prozent der automatisch
 * eingeblendeten Lektionen passten nicht zur Aufgabe. Das ist kein Rangfolge-
 * Problem — auf leere Fragen gibt es keine richtige Reihenfolge.
 *
 * Ein System, das nicht "weiss ich nicht" sagen kann, faellt mit voller
 * Zuversicht um. Es gibt dann keinen Unterschied mehr zwischen "ich habe etwas
 * gefunden" und "ich habe etwas ausgegeben".
 *
 * ── Die Zahl, die es NICHT sein durfte (27.08.2026, teuer gelernt) ──────────
 *
 * Der erste Entwurf urteilte ueber `hybridScore` — die Zahl, die im Abruf
 * neben jedem Treffer steht. Zwei bestehende Proben fielen sofort rot aus, und
 * sie hatten recht:
 *
 *     const bm25Range = (Math.max(...) - bm25Min) || 1;
 *     const bm25Norm  = (s) => (s - bm25Min) / bm25Range;
 *
 * Das ist eine min-max-Normierung. Sie sagt, WO ein Treffer in seiner eigenen
 * Liste steht — nicht, ob er taugt. Zwei Folgen, beide toedlich fuer eine
 * Zurueckhaltung:
 *
 *   - Bei GENAU EINEM Treffer ist max === min, also `bm25Norm(s) = 0`.
 *     Jeder Ein-Treffer-Abruf haette geschwiegen. Auch der perfekte:
 *     "plugh timeout" auf "Der plugh-Timeout liegt am Netz" ergibt 0.
 *   - Der beste Treffer bekommt IMMER 1.0. Zehn voellig unpassende Lektionen
 *     haetten die Zurueckhaltung nie ausgeloest — also genau dort versagt, wo
 *     sie gebraucht wird.
 *
 * Die Lehre steht hier, damit sie niemand zurueckdreht: eine relative Zahl
 * kann keine absolute Frage beantworten. "Ist das gut genug?" braucht einen
 * Massstab ausserhalb der Liste.
 *
 * ── Der zweite Fehlversuch: der Anteil (derselbe Tag) ───────────────────────
 *
 * Danach urteilte der Entwurf ueber den ANTEIL der getroffenen Fragewoerter.
 * Wieder fiel eine bestehende Probe rot aus, wieder zu Recht: "xyzzy api key"
 * traf eine Lektion, die das seltene "xyzzy" exakt enthielt — ein Drittel, und
 * damit unter jeder brauchbaren Schwelle. Der Treffer war genau richtig.
 *
 * Ein Anteil bestraft die lange Frage. Wer mehr tippt, bekommt strengere
 * Massstaebe, obwohl er dem System MEHR gegeben hat.
 *
 * ── Der Massstab, der es geworden ist ───────────────────────────────────────
 *
 * Drei absolute Belege, alle unabhaengig von Listenlaenge UND Fragelaenge:
 *
 *   wortBelege — wie viele der GETIPPTEN Woerter wirklich im Treffer stehen
 *                (aus search.ts, dort wo die Wortzerlegung lebt). Eine ANZAHL,
 *                kein Anteil: exakt zaehlt 1, unscharf zaehlt 0,5.
 *   semScore   — die Bedeutungsnaehe als Kosinus, 0 bis 1, von Haus aus absolut.
 *   ckgScore   — die Zuversicht einer Ursache-Wirkung-Kante, ebenfalls 0 bis 1.
 *
 * Ein Treffer gilt als belegt, wenn EINER davon reicht. Geschwiegen wird nur,
 * wenn KEIN einziger Treffer belegt ist.
 *
 * ── Die Regel, bewusst vorsichtig ───────────────────────────────────────────
 *
 * Zurueckhaltung darf niemals einen Treffer fressen, der geholfen haette.
 * Deshalb greift sie nur, wenn ALLE Treffer unbelegt sind — nicht "die
 * schwachen wegfiltern". Entweder die Liste taugt, oder sie taugt nicht.
 *
 * Reines Modul: Belege hinein, Urteil heraus. Die Schwellen sind
 * Stellschrauben und stehen bei den anderen in rangfolge-stellschrauben.ts.
 */
import {
  CKG_BELEG_SCHWELLE,
  SINN_BELEG_SCHWELLE,
  WORT_BELEG_SCHWELLE,
} from './rangfolge-stellschrauben.js';

/** Was von EINEM Treffer zaehlt, wenn gefragt wird: taugt der ueberhaupt? */
export type TrefferBeleg = {
  /** Wie viele getippte Woerter wirklich im Treffer stehen (exakt 1, unscharf 0,5). */
  wortBelege?: number;
  /** Bedeutungsnaehe als Kosinus (0..1), falls der Abgleich gelaufen ist. */
  semScore?: number;
  /**
   * Zuversicht der Ursache-Wirkung-Kante (0..1), falls der Treffer ueber den
   * Wissensgraphen kam. Auch das ist ein Beleg: der Durchlauf startet nur an
   * Knoten, deren Name ein getipptes Fragewort enthaelt.
   */
  ckgScore?: number;
};

export type AbstentionUrteil = {
  /** Wahr = die Antwort lautet "nichts Passendes im Bestand". */
  schweigen: boolean;
  /** Der beste erreichte Wortbeleg — gehoert IMMER in die Ausgabe. */
  besteWortBelege: number;
  /** Die beste erreichte Bedeutungsnaehe — ebenfalls immer. */
  besteNaehe: number;
  /** Wie viele Treffer es ueberhaupt gab, bevor entschieden wurde. */
  geprueft: number;
  /**
   * Wie viele Treffer die Beleg-Schwelle EINZELN passiert haben (eligible_seen,
   * Karte kdnqoilo1fs7). "3 von 12 belegt" sagt dem Leser, wie duenn die
   * Population ist — der Unterschied zwischen "gezeigt" und "belegt".
   */
  belegte: number;
};

export type AbstentionSchwellen = {
  woerter?: number;
  naehe?: number;
  kante?: number;
};

const zahl = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Taugt diese Trefferliste, oder ist "nichts Passendes" die ehrlichere
 * Antwort?
 *
 * Die Schwellen sind Argumente und keine fest eingebauten Werte, damit der
 * Messstand dieselbe Funktion mit anderen Werten abtasten kann, ohne sie
 * nachzubauen (die Fehlerklasse "Messstand und Auslieferstand sind zwei
 * Systeme", 20.08.2026).
 */
/**
 * Hat DIESER Treffer die Beleg-Schwelle passiert?
 *
 * EINE Schwellen-Wahrheit fuer Urteil UND Anzeige: der Ausgabepfad
 * (brain.ts) fragt je Treffer hier nach, statt die Regel zu kopieren —
 * zwei Kopien derselben Schwelle laufen auseinander, und dann zaehlt die
 * Population-Zeile andere Treffer als das Urteil.
 */
export function istBelegt(t: TrefferBeleg, schwellen: AbstentionSchwellen = {}): boolean {
  return (
    zahl(t.wortBelege) >= (schwellen.woerter ?? WORT_BELEG_SCHWELLE) ||
    zahl(t.semScore) >= (schwellen.naehe ?? SINN_BELEG_SCHWELLE) ||
    zahl(t.ckgScore) >= (schwellen.kante ?? CKG_BELEG_SCHWELLE)
  );
}

export function beurteileTreffer(
  treffer: readonly TrefferBeleg[],
  schwellen: AbstentionSchwellen = {},
): AbstentionUrteil {
  let besteWortBelege = 0;
  let besteNaehe = 0;
  let belegt = false;
  let belegte = 0;

  for (const t of treffer) {
    const w = zahl(t.wortBelege);
    const s = zahl(t.semScore);
    if (w > besteWortBelege) besteWortBelege = w;
    if (s > besteNaehe) besteNaehe = s;
    // EIN Beleg genuegt — und er genuegt fuer die GANZE Liste.
    if (istBelegt(t, schwellen)) {
      belegt = true;
      belegte++;
    }
  }

  return {
    // Eine leere Liste war schon immer ein Schweigen — sie faellt hier
    // ausdruecklich mit hinein, damit der Aufrufer EINEN Zweig hat.
    schweigen: treffer.length === 0 || !belegt,
    besteWortBelege,
    besteNaehe,
    geprueft: treffer.length,
    belegte,
  };
}

/**
 * Der Satz, den der Nutzer sieht — mit den ZAHLEN darin.
 *
 * Ein "nichts gefunden" ohne Werte ist ein Urteil ohne Beleg: niemand kann
 * pruefen, ob die Schwelle zu hoch steht oder der Bestand wirklich leer ist.
 * (Dieselbe Regel wie bei den Waechtern: erst den gelesenen Wert melden, dann
 * das Urteil.)
 */
export function abstentionSatz(
  urteil: AbstentionUrteil,
  schwellen: AbstentionSchwellen = {},
): string {
  if (urteil.geprueft === 0) {
    return '🔍 **Nichts Passendes im Bestand** — zu dieser Frage gibt es noch keine Lektion.';
  }
  const woerterSchwelle = schwellen.woerter ?? WORT_BELEG_SCHWELLE;
  const naeheSchwelle = schwellen.naehe ?? SINN_BELEG_SCHWELLE;

  return [
    '🔍 **Nichts Passendes im Bestand.**',
    '',
    // Der benannte Zaehl-Grund zuerst (Karte 4ssv2t1qqlu6): "N betrachtet,
    // keiner belegt" ist ein strukturiertes Signal, kein weiches Nein. Danach
    // die gelesenen Werte, damit das Urteil nachpruefbar bleibt.
    `${urteil.geprueft} Treffer betrachtet, keiner belegt — der beste enthielt ${urteil.besteWortBelege} der gesuchten Wörter (nötig: ${woerterSchwelle}), ` +
      `höchste Bedeutungsnähe ${urteil.besteNaehe.toFixed(2)} (nötig: ${naeheSchwelle.toFixed(2)}).`,
    'Sie werden bewusst NICHT gezeigt: ein schwacher Treffer sieht wie ein starker aus, und der Unterschied entscheidet.',
    '',
    '_Wenn die Antwort trotzdem im Bestand liegen sollte, hilft eine Frage mit anderen Worten — oder `recall_best_solution(topic="…")`, wenn das Thema bekannt ist._',
  ].join('\n');
}

/**
 * Ab wann das Alter der belegten Treffer genannt wird.
 *
 * Folgt der Zuversichts-Uhr der Lektionen: nach 5 Tagen ohne Bestaetigung
 * faellt die Zuversicht (0.7), nach 10 weiter (0.5). Juenger als 5 Tage ist
 * "bestaetigt genug" — dann schweigt der Zusatz, statt Rauschen zu erzeugen.
 */
export const ALTER_NENNEN_AB_TAGEN = 5;

/**
 * Karte 4z5vk0zdnm00: das Alter gehoert in die ANZEIGE, nie ins Ranking.
 *
 * "is this still true?" ist neben "belegt" ein eigener Grund — die
 * Population-Zeile kann sagen, wie lange die belegten Treffer unbestaetigt
 * sind. NUR Anzeige: ein Verfall im Ranking hat schon einmal alle
 * Bench-Floors gerissen (cachly-recall-decay-regresses-bench).
 *
 * Gibt einen fertigen Satz zurueck — oder null, wenn es nichts zu sagen
 * gibt (keine Alter bekannt, oder der juengste belegte ist frisch genug).
 */
export function alterssatzFuerBelegte(tage: readonly number[]): string | null {
  const gueltig = tage.filter((t) => Number.isFinite(t) && t >= 0);
  if (gueltig.length === 0) return null;
  const juengster = Math.min(...gueltig);
  const aeltester = Math.max(...gueltig);
  // Der JUENGSTE entscheidet: ein einziger frisch bestaetigter Treffer
  // beantwortet "is this still true?" — dann braucht es keinen Zusatz.
  if (juengster < ALTER_NENNEN_AB_TAGEN) return null;
  if (gueltig.length === 1) return `Der belegte Treffer ist ${aeltester} Tage unbestätigt.`;
  if (juengster === aeltester) return `Die belegten Treffer sind ${aeltester} Tage unbestätigt.`;
  return `Die belegten Treffer sind seit ${juengster}–${aeltester} Tagen unbestätigt.`;
}
