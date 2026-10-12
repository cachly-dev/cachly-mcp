/**
 * Die Marke, die der Tuersteher beim Speichern an eine verdaechtige Lektion haengt.
 *
 * Eigene, winzige Datei, damit der abhaengigkeitsfreie Hook (tools/ambient-recall,
 * hooks/cachly-ambient-einblendung.mjs) die Marke lesen kann, ohne die Regeln des
 * Tuerstehers (tuersteher.ts) mitzubuendeln. Die Regeln brauchen nur Schreiber
 * und ausdrueckliche Abrufe; der Hook braucht nur die Frage "markiert oder nicht".
 *
 * Gegenstueck in Go: tuersteher.VerdachtTag (api/internal/tuersteher).
 */

export const VERDACHT_TAG = 'tuersteher:verdacht';

/**
 * Traegt die Lektion die Marke aus einem frueheren Speichern?
 *
 * Eine markierte Lektion wird nicht von selbst eingeblendet (Hook, Briefing) und
 * nicht an andere weitergegeben. Ausdruecklich abrufen laesst sie sich weiter,
 * mit Warnzeile (schreibtor.ts: markierungsWarnung).
 */
export function istMarkiert(lektion: { tags?: unknown } | null | undefined): boolean {
  return Array.isArray(lektion?.tags) && (lektion.tags as unknown[]).includes(VERDACHT_TAG);
}
