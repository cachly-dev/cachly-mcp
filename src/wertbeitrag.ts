/**
 * Wertbeitrag — was ein einzelner Abruf zur Zeitersparnis beiträgt.
 *
 * ─── DER ANLASS ────────────────────────────────────────────────────────────
 *
 * Am 17.08.2026 zeigte das Panel eines Brains mit 475 Lektionen eine
 * Zeitersparnis von 54 Tagen und einen Gegenwert von 97.237,50 €. Nachgerechnet
 * stammte praktisch die ganze Zahl aus dem STARTER-KORPUS: `docker:layer-cache`
 * stand bei 973 Abrufen, `cache:stampede` bei 971, dahinter neun weitere
 * Starter-Lektionen mit je rund 208. Die echten, projektbezogenen Lektionen
 * standen bei zwei bis fünf.
 *
 * Der Starter-Korpus ist genau das, wofür er gedacht ist: ein Startvorrat, der
 * dafür sorgt, dass die erste Frage an ein leeres Brain nicht ins Leere geht.
 * Er ist eingekauftes Allgemeinwissen — Docker-Cache, JWT-Uhrzeitversatz,
 * N+1-Abfragen. Er ist NICHT das, was jemand über sein Projekt gelernt hat.
 *
 * Ihn in die Wertschätzung einzurechnen macht die Zahl doppelt falsch:
 *   - Sie wächst, ohne dass jemand etwas gelernt hat.
 *   - Sie wächst am schnellsten in Brains, die am wenigsten eigenes Wissen
 *     haben — dort gibt es ja nichts anderes zu treffen.
 *
 * Eine Kennzahl, die dann am besten aussieht, wenn das Produkt am wenigsten
 * leistet, ist schlimmer als gar keine.
 *
 * ─── WARUM KEINE NAMENSLISTE ───────────────────────────────────────────────
 *
 * Naheliegend wäre gewesen, die sechs auffälligen Themen hart auszuschliessen.
 * Das wäre ein Wächter, der auf den Anlass genagelt ist: Beim nächsten
 * Starter-Korpus mit anderen Namen wäre er blind. Die Starter-Lektionen tragen
 * seit ihrer Einführung `source: 'starter'` im Datensatz — genau dafür. Diese
 * Datei benutzt die Markierung, nicht die Namen.
 */

/** fmtStunden macht aus Minuten eine lesbare Angabe ("21 h", "3 d 4 h"). */
export function fmtStunden(minuten: number): string {
  const gesamt = Math.max(0, Math.round(minuten));
  if (gesamt < 60) return `${gesamt} min`;
  const stunden = Math.floor(gesamt / 60);
  if (stunden < 24) return `${stunden} h`;
  const tage = Math.floor(stunden / 24);
  const rest = stunden % 24;
  return rest > 0 ? `${tage} d ${rest} h` : `${tage} d`;
}

/** Eine Lektion, soweit sie für die Bewertung gebraucht wird. */
export interface BewertbareLektion {
  severity?: string;
  source?: string;
  [k: string]: unknown;
}

/**
 * Stammt die Lektion aus dem mitgelieferten Startvorrat?
 *
 * Solche Lektionen dürfen abgerufen werden und sind nützlich — sie zählen nur
 * nicht als etwas, das dieser Mensch oder dieses Team gelernt hat.
 */
export function istStarterLektion(lesson: BewertbareLektion | null | undefined): boolean {
  return lesson?.source === 'starter';
}

/**
 * Minuten, die ein Abruf dieser Lektion einspart — 0 für den Startvorrat.
 *
 * Die Staffel (30 / 60 / 240) ist unverändert; sie stand vorher an drei
 * Stellen im Code und steht jetzt hier. `basis` erlaubt der abweichenden
 * Staffel von causal_trace (60 / 120 / 240) ihren eigenen Grundwert, ohne dass
 * die Starter-Regel ein zweites Mal geschrieben werden muss.
 */
export function ersparteMinuten(
  lesson: BewertbareLektion | null | undefined,
  basis: 'recall' | 'trace' = 'recall',
): number {
  if (!lesson || istStarterLektion(lesson)) return 0;

  const sev = lesson.severity;
  if (sev === 'critical') return 240;
  if (sev === 'major') return basis === 'trace' ? 120 : 60;
  return basis === 'trace' ? 60 : 30;
}
