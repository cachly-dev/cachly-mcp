/**
 * Wie viele Treffer zeigt `smart_recall` — und wie viele haelt es zurueck?
 *
 * Eigenes Modul, weil hier ein Versprechen eingeloest wird, das vorher nur im
 * Kommentar stand. Der Kommentar am Teaser-Gate sagte seit jeher:
 *
 *   "the magic moment is sacred ... never an access wall: the #1 result is
 *    always returned"
 *
 * Der Code sagte `visibleCount = gateActive ? 0 : 8` — also NULL Treffer,
 * sobald ein Frei-Konto sein Monatskontingent ueberschritten hat. Der Nutzer
 * las die Ueberschrift "Results (23 — hybrid)", darunter keine einzige Zeile
 * und dann eine Kaufaufforderung. Das sieht nicht aus wie eine Rechnung,
 * sondern wie ein kaputtes Werkzeug — besonders bei Ambient Recall, das bei
 * jedem Prompt feuert und das Kontingent in Tagen aufbraucht.
 *
 * Fehlerklasse: eine Zusage an zwei Orten gepflegt (Kommentar und Zweig).
 * Deshalb ist die Regel jetzt eine Funktion mit Tests, nicht ein Satz Prosa.
 */

/** Der eine Treffer, den auch ein ueberzogenes Frei-Konto immer sieht. */
export const TIEFE_UEBER_LIMIT = 1;
/** Volle Tiefe bei einer einzelnen Frage. */
export const TIEFE_VOLL = 8;
/** Volle Tiefe, wenn die Frage in Unterfragen zerfaellt (mehr Themen, mehr Platz). */
export const TIEFE_VOLL_MEHRTHEMIG = 12;

export interface RecallTiefeEingabe {
  /** Frei-Konto ueber seinem Monatskontingent? */
  ueberLimit: boolean;
  /** Wie viele Treffer stehen ueberhaupt zur Verfuegung. */
  gesamt: number;
  /** Tiefe ohne Limit — TIEFE_VOLL oder TIEFE_VOLL_MEHRTHEMIG. */
  volleTiefe?: number;
}

export interface RecallTiefe {
  /** So viele Treffer werden ausgegeben. */
  sichtbar: number;
  /** So viele bleiben hinter dem Kontingent — 0, solange niemand ueber dem Limit ist. */
  zurueckgehalten: number;
}

/**
 * Nie eine Mauer, immer eine Bremse: ueber dem Limit bleibt genau der beste
 * Treffer sichtbar, der Rest wird gezaehlt und benannt.
 *
 * Bei null Treffern gibt es nichts zu zeigen und nichts zurueckzuhalten — ein
 * leeres Ergebnis darf nie als "hinter der Bezahlschranke" erscheinen, sonst
 * verkauft die Meldung etwas, das gar nicht existiert.
 */
export function recallTiefe({ ueberLimit, gesamt, volleTiefe = TIEFE_VOLL }: RecallTiefeEingabe): RecallTiefe {
  const vorhanden = Number.isFinite(gesamt) && gesamt > 0 ? Math.floor(gesamt) : 0;
  if (vorhanden === 0) return { sichtbar: 0, zurueckgehalten: 0 };

  const obergrenze = ueberLimit ? TIEFE_UEBER_LIMIT : Math.max(0, Math.floor(volleTiefe));
  const sichtbar = Math.min(vorhanden, obergrenze);
  return { sichtbar, zurueckgehalten: ueberLimit ? vorhanden - sichtbar : 0 };
}
