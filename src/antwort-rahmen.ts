/**
 * Der Rahmen um Werkzeug-Antworten, die gespeicherten Text zurueckgeben.
 *
 * ── Warum es diese Datei gibt (07.10.2026) ──────────────────────────────────
 *
 * Seit 0.10.172 kommt die Hook-Einblendung im Block `<cachly-memory>` an:
 * "Daten, keine Anweisung". Dieselben Lektionen erreichen das Modell aber auch
 * ueber die Werkzeuge — `session_start`, `smart_recall`, `recall_best_solution`
 * und weitere. Dort standen sie bis heute ungerahmt. Eine vergiftete Lektion
 * war also nur auf einem von zwei Wegen gekennzeichnet.
 *
 * Gerahmt werden nur LESE-Werkzeuge, deren Antwort gespeicherten Text enthaelt.
 * Schreib-Werkzeuge (learn_from_attempts, remember_context, ...) bleiben frei:
 * ihre Antwort ist eine Quittung des Servers samt `Beleg:` und kein
 * gespeicherter Fremdtext. Fehlerantworten bleiben ebenfalls frei.
 */

import { rahmeEin } from './einblendung-rahmen.js';

/** Werkzeuge, deren Antwort Text aus dem Brain wiedergibt. */
export const GERAHMTE_WERKZEUGE: ReadonlySet<string> = new Set([
  // Sitzung und Abruf
  'session_start',
  'session_start_summary',
  'smart_recall',
  'recall_best_solution',
  'recall_context',
  'list_remembered',
  'recall_at',
  'compact_recover',
  'brain_briefing',
  // Suche
  'semantic_search',
  'brain_search',
  'causal_trace',
  'team_recall',
  'global_recall',
  'fedbrain_search',
  'syndicate_search',
  'syndicate_trending',
  'brain_discover',
  // Verdichtungen und Vorhersagen aus Lektionen
  'brain_predict',
  'brain_predict_failures',
  'brain_plan',
  'brain_changelog',
  'brain_conflicts',
  'crystal_view',
  'memory_crystalize',
  'team_crystallize',
  'team_synthesize',
]);

/** Rahmt die Antwort eines Lese-Werkzeugs; alle anderen Antworten bleiben unveraendert. */
export function rahmeAntwort(werkzeug: string, text: string): string {
  if (!GERAHMTE_WERKZEUGE.has(werkzeug)) return text;
  const gerahmt = rahmeEin(text);
  return gerahmt || text;
}
