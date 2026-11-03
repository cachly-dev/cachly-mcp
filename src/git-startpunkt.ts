import { createHash } from 'node:crypto';

/**
 * Wo sich brain_from_git den zuletzt gelesenen Commit eines Ordners merkt.
 *
 * ── Warum es diese Datei gibt (03.11.2026) ──────────────────────────────────
 *
 * Bis 0.10.225 hiess der Schluessel `base64(pfad).slice(0, 32)`. 32
 * Base64-Zeichen sind 24 Bytes — es zaehlten also nur die ersten 24 Zeichen
 * des Pfads. Alle Projekte unter `C:\Users\<name>\Documents\` oder
 * `/Users/<name>/projects/` teilten sich damit EINEN Schluessel.
 *
 * Gemessen beim Durchlauf der Einrichtung in einem frischen Testprojekt: Das
 * zweite Projekt bekam den Commit des ersten als Startpunkt.
 * `git log <fremder-commit>..HEAD` scheiterte mit "Invalid revision range",
 * brain_from_git gab nur den Fehler zurueck, und `setup` meldete
 * "✓ 0 lessons extracted from git history". Ab dem zweiten Projekt lernte das
 * Brain also nie aus der Git-Geschichte, und niemand sah es.
 *
 * Jetzt: ein Pruefwert ueber den GANZEN Pfad. Der alte Schluessel wird nur
 * noch gelesen, damit bestehende Ordner nicht von vorn beginnen. Ob sein
 * Commit wirklich in diesem Ordner liegt, prueft der Aufrufer
 * (`git cat-file -e`) — ein fremder Commit fuehrt zum vollen Lauf.
 */
export function startpunktSchluessel(repoDir: string): string {
  return `cachly:brain_from_git:last_sha:${createHash('sha256').update(repoDir).digest('hex').slice(0, 32)}`;
}

/** Der Schluessel bis 0.10.225 — nur noch gelesen, nie geschrieben. */
export function alterStartpunktSchluessel(repoDir: string): string {
  return `cachly:brain_from_git:last_sha:${Buffer.from(repoDir).toString('base64').slice(0, 32)}`;
}
