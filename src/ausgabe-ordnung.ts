/**
 * ══ Die Ausgabe folgt der Hausordnung ════════════════════════════════════
 *
 * `smart_recall` baut seine Reihenfolge an EINER Stelle: Topf, bewerteTopf,
 * Fehlertext-Tuer, Zweitmodell, Leser (handlers/brain.ts, `kwGemischt`). Das
 * ist die Hausordnung, und nur sie ist gemessen.
 *
 * Bis zum 11.10.2026 wurde sie fuer die Ausgabe noch einmal sortiert — nach
 * dem normierten Wortwert (BM25). Eine Lektion, die nur der
 * Bedeutungsabgleich fand, hat den Wortwert 0 und landete damit hinten,
 * auch wenn die Hausordnung sie auf Platz 1 setzte. Liefer-Journal und
 * Gedaechtniszellen lasen dagegen die Hausordnung: ein Aufruf, zwei
 * Reihenfolgen. Kein Bench sah das, weil jeder Bench `bewerteTopf` direkt
 * ruft. Gemessen wird es seitdem mit src/bench/ausgabe-reihenfolge-messen.ts.
 *
 * Diese Datei haelt die zwei reinen Regeln, mit denen die Ausgabe die
 * Hausordnung uebernimmt. Sie sortieren nichts selbst — sie uebernehmen.
 */

/**
 * Die Werte, die die Hauseintraege in der Ausgabe tragen.
 *
 * Platz k bekommt den k-groessten der bisherigen Werte. Die ZAHLEN je Platz
 * bleiben damit dieselben wie vorher: der Spitzenwert, der Abstand Platz 1
 * zu Platz 5 (brain_doctor, "Rank spread"), die Zulassung im Versuch. Nur
 * WER auf Platz k steht, entscheidet jetzt die Hausordnung.
 *
 * Die Werte fallen mit dem Platz. Zusatztreffer (siehe unten) reihen sich
 * deshalb an derselben Stelle ein wie bisher.
 */
export function rangWerte(werte: readonly number[]): number[] {
  return [...werte].sort((a, b) => b - a);
}

/**
 * Hauseintraege in Hausordnung, Zusatztreffer nach ihrem Wert dazwischen.
 *
 * `hausRang` ist der Platz in der Hausordnung je Schluessel. Ein Eintrag ohne
 * Platz ist ein Zusatztreffer: er kam nur ueber den Sinn-Dienst der API oder
 * ueber eine Kante im Wissensgraphen dazu. Zusatztreffer werden nach
 * `hybridScore` absteigend eingereiht; bei Gleichstand steht der
 * Hauseintrag vorn.
 *
 * Die Reihenfolge der Hauseintraege untereinander aendert sich dabei NIE —
 * auch dann nicht, wenn eine spaetere Stufe (Kante, Datei-Kontext) ihren
 * Wert veraendert hat. Der Wert entscheidet nur noch, wo ein Zusatztreffer
 * zwischen ihnen steht.
 */
export function ordneNachHausordnung<T extends { key: string; hybridScore: number }>(
  eintraege: readonly T[],
  hausRang: ReadonlyMap<string, number>,
): T[] {
  const haus = eintraege
    .filter((e) => hausRang.has(e.key))
    .sort((a, b) => (hausRang.get(a.key) ?? 0) - (hausRang.get(b.key) ?? 0));
  const zusatz = eintraege
    .filter((e) => !hausRang.has(e.key))
    .sort((a, b) => b.hybridScore - a.hybridScore);
  const aus: T[] = [];
  let h = 0;
  let z = 0;
  while (h < haus.length || z < zusatz.length) {
    const zusatzZuerst = z < zusatz.length
      && (h >= haus.length || zusatz[z].hybridScore > haus[h].hybridScore);
    if (zusatzZuerst) aus.push(zusatz[z++]);
    else aus.push(haus[h++]);
  }
  return aus;
}
