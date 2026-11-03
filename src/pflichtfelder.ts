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

/** Hat smart_recall eine Frage bekommen? */
export function hatFrage(query: unknown): boolean {
  return gefuellt(query);
}
