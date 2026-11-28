/**
 * Konto-Bereich (Stufe 4): Notizen, Sitzung, Wirkung und Spuren eines
 * Mitglieds liegen unter `<privater Raum>k:`. Wortgleich mit
 * api/internal/raeume (schluessel.go). Ohne Konto-Bereich aendert sich
 * kein Schluessel.
 */

import { zugangVon } from './rolle.js';

/** Die acht Anfaenge der Konto-Familien (Klasse K). */
export const KONTO_FAMILIEN: readonly string[] = [
  'cachly:ctx:',
  'cachly:session:',
  'cachly:wirkung:',
  'cachly:letzter-recall:',
  'cachly:liefer:',
  'cachly:agents:',
  'cachly:stats:suchprotokoll:',
  'cachly:stats:reuse_pairs:',
];

/** true, wenn der Schluessel mit einem Anfang aus KONTO_FAMILIEN beginnt. */
export function istKontoSchluessel(schluessel: string): boolean {
  return KONTO_FAMILIEN.some((f) => schluessel.startsWith(f));
}

/** Der Konto-Bereich zu einem privaten Raum. */
export function kontoBereich(privat: string): string {
  return `${privat}k:`;
}

/** Der Konto-Bereich dieser Verbindung; undefined = am alten Ort. */
export function kontoBereichVon(redis: unknown): string | undefined {
  return zugangVon(redis)?.raeume?.konto;
}

/** Der Schluessel dieser Verbindung: im Konto-Bereich, sonst unveraendert. */
export function kontoSchluessel(redis: unknown, schluessel: string): string {
  const bereich = kontoBereichVon(redis);
  if (!bereich || !istKontoSchluessel(schluessel)) return schluessel;
  return bereich + schluessel.slice('cachly:'.length);
}

/** Umkehrung von kontoSchluessel, fuer Namen aus SCAN. */
export function alterSchluessel(redis: unknown, schluessel: string): string {
  const bereich = kontoBereichVon(redis);
  if (!bereich || !schluessel.startsWith(bereich)) return schluessel;
  const alt = `cachly:${schluessel.slice(bereich.length)}`;
  return istKontoSchluessel(alt) ? alt : schluessel;
}
