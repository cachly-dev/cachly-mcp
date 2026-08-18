/**
 * Wer hat diese Lektion geschrieben — ich oder jemand anderes?
 *
 * `session_start_summary` nimmt seit jeher einen Parameter `author` entgegen
 * und beschreibt ihn in der Werkzeug-Spezifikation so:
 *
 *   "Your name or handle (optional). Same as session_start — used for team
 *    lesson filtering."
 *
 * Die Zusage wurde nie eingeloest. Der Handler holte den Wert aus den
 * Argumenten und benutzte ihn danach nirgends; eslint meldete ihn seit
 * Monaten als ungenutzte Variable. Wer den Parameter setzte, bekam exakt
 * dieselbe Ausgabe wie ohne ihn.
 *
 * Fehlerklasse: eine Zusage an zwei Orten — hier in der Spezifikation, dort
 * im Code — und nur einer wurde gepflegt. Dieselbe Form wie die Kommentarzeile
 * am Frei-Limit, die "the #1 result is always returned" versprach, waehrend
 * der Zweig darunter null lieferte.
 *
 * Reines Modul, weil die Entscheidung eine Rechnung ist: dieselbe Regel, die
 * `smart_recall` schon anwendet, an EINER Stelle statt zweimal abgeschrieben.
 */

/**
 * Das Abzeichen hinter einer Lektion — leer, wenn sie von mir selbst stammt
 * oder niemand als Autor eingetragen ist.
 *
 * Bewusst KEIN Abzeichen fuer die eigenen Lektionen: in einem Brain, das
 * ueberwiegend einer Person gehoert, stuende sonst hinter jeder Zeile derselbe
 * Name, und das Abzeichen verlöre genau die Aussage, für die es da ist.
 */
export function autorAbzeichen(lektionsAutor: string | null | undefined, anfragender: string | null | undefined): string {
  const autor = (lektionsAutor ?? '').trim();
  if (!autor) return '';
  const ich = (anfragender ?? '').trim();
  if (ich && autor === ich) return '';
  return ` · 👤 ${autor}`;
}

/**
 * Wie viele der gezeigten Lektionen von jemand anderem stammen.
 *
 * Das ist der Wert, den nur ein GETEILTES Gedaechtnis liefert — und deshalb
 * die Zahl, die es zu nennen lohnt. Ist sie null, wird auch nichts gesagt:
 * "0 von Teamkollegen" ist keine Nachricht, sondern Rauschen.
 */
export function fremdanteil(
  lektionen: readonly { author?: string | null }[],
  anfragender: string | null | undefined,
): number {
  const ich = (anfragender ?? '').trim();
  if (!ich) return 0;
  return lektionen.filter(l => {
    const autor = (l.author ?? '').trim();
    return autor.length > 0 && autor !== ich;
  }).length;
}
