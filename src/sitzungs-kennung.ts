/**
 * Die Kennung DIESER Sitzung, damit zwei Sitzungen auf demselben Brain sich
 * nicht gegenseitig die Startzeit und das Entscheidungsprotokoll nehmen.
 *
 * Vorher gab es die Startmarke nur einmal je Brain (`cachly:session:current`).
 * Zwei Fenster auf demselben Brain: das zweite session_start ueberschrieb die
 * Startzeit des ersten, das erste session_end rechnete seine Dauer dann ab dem
 * Start des zweiten und loeschte die Marke. Das Entscheidungsprotokoll
 * (`cachly:session:decision-log`) nahm das erste session_end ganz mit, also
 * auch die Lektionen der Nachbarsitzung (Beleg 27.11.2026, PR #1239: dort nur
 * der Abbruch behoben, die Dauer blieb offen).
 *
 * Eine Sitzung = ein MCP-Prozess. Claude Code, Cursor und VS Code starten den
 * Server je Fenster ueber stdio, darum reicht eine Kennung je Prozess. Im
 * HTTP-Betrieb (Claude.ai-Connector) teilen sich alle Anfragen eines Prozesses
 * die Kennung; dort bleibt es beim alten Verhalten je Brain, weil das
 * Protokoll ohne Sitzungskennung laeuft (sessionIdGenerator: undefined).
 */

import { randomUUID } from 'node:crypto';

let kennung: string = randomUUID();

/** Die Kennung der laufenden Sitzung (eine je Prozess). */
export function sitzungsKennung(): string {
  return kennung;
}

/** Nur fuer Tests: zwei Sitzungen in einem Prozess nachstellen. */
export function setzeSitzungsKennung(neu: string): void {
  kennung = neu;
}

/**
 * Die Startmarke einer Sitzung. Traegt nur die Startzeit, keinen Fokus: so
 * steht in ihr kein Thema, das der Raum-Umzug der API (api/internal/raeume,
 * spurFamilien) als Spur einer privaten Lektion bereinigen muesste.
 */
export function startmarkenSchluessel(k: string = kennung): string {
  return `cachly:session:start:${k}`;
}

/**
 * Gehoert ein Eintrag (Startmarke oder Protokollzeile) dieser Sitzung?
 * Ohne Kennung stammt er von einer Fassung vor 0.10.286: dann wie bisher ja,
 * sonst verlore eine Sitzung, die waehrend des Wechsels laeuft, ihre Daten.
 */
export function gehoertDieserSitzung(eintragsKennung: unknown, k: string = kennung): boolean {
  return typeof eintragsKennung !== 'string' || eintragsKennung === '' || eintragsKennung === k;
}
