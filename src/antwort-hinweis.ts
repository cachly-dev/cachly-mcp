/**
 * Eine Zeile am Fuss der Abrufantwort, die das NACHERZAEHLEN abstellt.
 *
 * ── Der Befund, der sie noetig macht (04.09.2026, Lauf 008d2) ─────────────
 *
 * Gemessen an 480 Bench-Sitzungen:
 *
 *   Arm      Zuege  Werkzeugtext  Ausgabe-Token
 *   bare      9,97      6.459 Z.          3.474
 *   cachly   12,22     19.008 Z.          7.756
 *
 * Ein Modell mit Gedaechtnis schreibt SELBST 2,2-mal so viel — und jedes
 * selbst geschriebene Wort wird in jedem folgenden Zug erneut als Eingabe
 * bezahlt. Das ist mehr, als die Abrufantwort selbst ausmacht (2.610 Token).
 *
 * Dieselbe Aufgabe, beide Antworten:
 *
 *   bare, 237 Zeichen:
 *     "Done. The entry for 2026-08-22 has been appended to metrics.log …"
 *
 *   cachly, 727 Zeichen:
 *     "… All 7 pre-existing lines are byte-for-byte untouched — git diff
 *      shows exactly 1 insertion(+), 0 deletions, confirming the prior
 *      content is an unmodified prefix (APPEND-ONLY RULE FROM MEMORY
 *      HONORED). Line endings remain LF … Final newline is present …"
 *
 * Das Modell legt Rechenschaft darueber ab, dass es die erinnerte Regel
 * befolgt hat. Fuer einen Menschen am Bildschirm ist das womoeglich wertvoll.
 * Fuer eine Sitzung ohne Menschen ist es reiner Preis.
 *
 * ── Warum ein eigener Schalter, und warum AUS ─────────────────────────────
 *
 * Ein Hebel je Lauf. Waere die Zeile fest eingebaut, aenderte der naechste
 * Bench-Lauf zwei Dinge gleichzeitig — genau der Griff, der den ersten
 * 008-Anlauf gekostet hat (`probelauf-008d-present-VERWORFEN-drei-variablen`).
 *
 * Und sie bleibt aus, bis gemessen ist, was sie kostet. Der Verdacht steht in
 * der Vorregistrierung: wer nicht mehr nacherzaehlt, prueft vielleicht auch
 * nicht mehr nach. Die Zeile verbietet ausdruecklich das eine und nicht das
 * andere — ob das Modell den Unterschied macht, ist die offene Frage.
 *
 * Belege: `.agent/cachly/VORREGISTRIERUNG-009-preis-je-zelle.md`, Arm E.
 */

/** Umgebungsschalter. Fehlt er oder steht er anders, gibt es die Zeile nicht. */
export const KURZFASSEN_SCHALTER = 'CACHLY_RECALL_KURZFASSEN';

/**
 * Die Zeile selbst.
 *
 * Sie trennt zwei Dinge, die leicht zusammenfallen: ANWENDEN und PRUEFEN
 * bleiben ausdruecklich erlaubt, nur das Berichten darueber nicht. Ohne diese
 * Trennung waere die Zeile ein Auftrag, schlampiger zu arbeiten.
 */
export const KURZFASSEN_ZEILE =
  '↩︎ Apply these lessons and verify your work exactly as you normally would. '
  + 'Do not list them in your answer, and do not report that you followed them — '
  + 'the reader wants the result, not a compliance note.';

/**
 * Gibt die Zeile zurueck, wenn der Schalter steht — sonst `null`.
 *
 * `null` und nicht der leere String: der Aufrufer soll entscheiden muessen,
 * ob er etwas anhaengt. Ein leerer String rutscht sonst als Leerzeile durch.
 */
export function kurzfassenHinweis(
  umgebung: NodeJS.ProcessEnv = process.env,
): string | null {
  return umgebung[KURZFASSEN_SCHALTER] === '1' ? KURZFASSEN_ZEILE : null;
}
