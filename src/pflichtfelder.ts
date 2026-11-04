/**
 * Pflichtfelder der Schreibwerkzeuge — geprueft, bevor irgendetwas geschrieben wird.
 *
 * Anlass (Schwarm 03.11.2026, nachgestellt gegen 0.10.225): learn_from_attempts
 * ohne what_worked speicherte die Lektion "What worked: undefined", und ein
 * leeres Thema landete als Lektion `` — der zweite leere Aufruf hiess dann
 * "already exists" (ki-08), und `export` verlor sie (cli-8).
 */

function gefuellt(x: unknown): boolean {
  return typeof x === 'string' && x.trim() !== '';
}

/**
 * Was einem learn_from_attempts-Aufruf fehlt, als Satzteile fuer die Ablehnung.
 * Leer = alles da. Ein Fehlschlag darf ohne what_worked kommen, wenn
 * what_failed sagt, was schiefging — so speichern Tests und echte Aufrufer
 * Fehlschlaege seit jeher.
 */
export function fehlendeLernfelder(args: Record<string, unknown>): string[] {
  const fehlt: string[] = [];
  if (!gefuellt(args.topic)) fehlt.push('`topic` (e.g. "deploy:docker-build-slow")');
  if (!gefuellt(args.what_worked) && !gefuellt(args.what_failed)) {
    fehlt.push('`what_worked` (the fix) or, for a failure, `what_failed`');
  }
  return fehlt;
}

/**
 * `outcome` muss success, failure oder partial sein (ki-08, 04.11.2026).
 * "banana" wurde bis 0.10.227 gespeichert und als Fehlschlag angezeigt.
 * Fehlt das Feld ganz, leitet der Aufrufer es nicht ab: das haengt am Text.
 * Rueckgabe: der Ablehnungssatz oder null.
 */
export function ungueltigerAusgang(args: Record<string, unknown>): string | null {
  const o = args.outcome;
  if (o === 'success' || o === 'failure' || o === 'partial') return null;
  // Fehlt `outcome`, wurde bis 0.10.228 eine Lektion mit Ausgang `undefined`
  // gespeichert und als "(undefined)" angezeigt (Pruefer-Hinweis Runde 2,
  // 04.11.2026). Das Schema verlangt das Feld ohnehin.
  if (o === undefined || o === null || o === '') {
    return '⚠️ learn_from_attempts needs `outcome`: "success", "failure" or "partial". Nothing was stored.';
  }
  return `⚠️ learn_from_attempts: \`outcome\` must be "success", "failure" or "partial" (got ${JSON.stringify(String(o)).slice(0, 40)}). Nothing was stored.`;
}

/** Hat smart_recall eine Frage bekommen? */
export function hatFrage(query: unknown): boolean {
  return gefuellt(query);
}

/** Laenger muss eine Suchfrage nicht sein: die Fehlermeldung steht vorne. */
export const ANFRAGE_MAX_ZEICHEN = 2000;

/**
 * Kappt eine Suchfrage. Eine eingefuegte Logdatei (60.000 Zeichen) ging bis
 * 0.10.227 ungekuerzt in die Antwort (60 KB) und in die Einbettung, die ab
 * 32.000 Zeichen mit HTTP 400 abbricht — dann lief die Suche nur ueber Woerter
 * (ki-07, 04.11.2026). Kein String: leerer String.
 */
export function kappeAnfrage(q: unknown): string {
  if (typeof q !== 'string') return '';
  return q.length > ANFRAGE_MAX_ZEICHEN ? q.slice(0, ANFRAGE_MAX_ZEICHEN) : q;
}

/**
 * Trifft die beste Loesung die Frage wirklich? `score` = Zahl der Frage-Woerter
 * im Text der Lektion, `tokens` = alle Frage-Woerter (ki-06, 04.11.2026).
 * Ein einziges gemeinsames Wort bei mehreren Frage-Woertern ist Zufall.
 */
export function trefferIstStark(score: number, tokens: readonly string[]): boolean {
  const verschieden = new Set(tokens).size;
  if (verschieden <= 1) return score >= 1;
  return score >= 2 && (score >= 3 || score * 2 >= verschieden);
}

/**
 * Pflichtfelder laut Schema pruefen, bevor ein Handler laeuft (ki-03,
 * 04.11.2026). Ohne das endeten fehlende Felder als "Cannot read properties of
 * undefined (reading 'toLowerCase')"; session_end speicherte sogar "undefined"
 * als Zusammenfassung. Fehlt nichts: null. `instance_id` zaehlt nicht — den
 * setzt der Server selbst.
 */
export function fehlendePflichtfelder(
  werkzeug: string,
  schema: { properties?: Record<string, { type?: string }>; required?: readonly string[] } | undefined,
  args: Record<string, unknown>,
): string | null {
  const noetig = (schema?.required ?? []).filter((f) => f !== 'instance_id');
  const probleme: string[] = [];
  for (const f of noetig) {
    const v = args[f];
    const art = schema?.properties?.[f]?.type;
    if (v === undefined || v === null) probleme.push(`\`${f}\` is missing`);
    else if (art === 'string' && typeof v !== 'string') probleme.push(`\`${f}\` must be text`);
    else if (art === 'array' && !Array.isArray(v)) probleme.push(`\`${f}\` must be a list`);
  }
  if (probleme.length === 0) return null;
  return `⚠️ ${werkzeug}: ${probleme.join(', ')}. Nothing was done. Call cachly_tool(tool="${werkzeug}", describe=true) to see the fields.`;
}
