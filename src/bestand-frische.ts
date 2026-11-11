/**
 * Wann wartet eine Suche auf einen frisch geladenen Bestand?
 *
 * Die Bestaende im Arbeitsspeicher (Woerter, Vektoren, Namen, Eingaenge,
 * Seltenheit) gelten 60 s. Bis zum 11.11.2026 wartete jede Suche nach Ablauf
 * dieser Minute, bis ALLES neu geladen war. Ueber ein entferntes Netz waren das
 * bei rund 1.250 Lektionen 77 bis 142 s je Aufruf — und weil Aufrufe in einer
 * Sitzung meist mehr als eine Minute auseinanderliegen, zahlte fast jeder
 * Aufruf diesen Preis.
 *
 * Seitdem gilt im Produkt: Ein abgelaufener, aber vorhandener Bestand
 * antwortet sofort, und das Nachladen laeuft im Hintergrund. Der Bestand ist
 * dadurch hoechstens um ein Nachladen aelter als vorher. Eigene Schreibvorgaenge
 * entwerten den Wortbestand weiter sofort (`wortindexEntwerten`); darauf wird
 * immer gewartet, damit eine gerade gelernte Lektion unmittelbar findbar ist.
 *
 * Im Messmodus (`CACHLY_RECALL_NUR_LESEN=1`) wartet jede Suche wie bisher.
 * Sonst haenge das Ergebnis davon ab, ob ein Nachladen im Hintergrund schon
 * fertig ist — dieselbe Frage gaebe je nach Zeitpunkt andere Treffer.
 */
export function wartetAufFrischenBestand(): boolean {
  return process.env.CACHLY_RECALL_NUR_LESEN === '1';
}
