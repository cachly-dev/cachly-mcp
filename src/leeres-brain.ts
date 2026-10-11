// Leeres Brain — die erste Antwort wartet nicht auf Arbeit, die nichts finden kann.
//
// ── Warum es das gibt (11.10.2026) ──────────────────────────────────────────
//
// Probe von aussen mit 0.10.176: frischer Start ohne Schluessel, ein
// smart_recall. Die Antwort kam nach 18,5 s und lautete "Nichts Passendes im
// Bestand". Nachgemessen mit 0.10.177 (CACHLY_ZEITMESSUNG=1), Werkzeugaufruf
// 10,4 s:
//
//   Sofort-Test (Brain anlegen)            0,3 s
//   Warten, bis die Instanz laeuft         9,2 s  (Takt 3 s, zwei Schleifen)
//   Zugangsdaten + Valkey verbinden        0,3 s
//   smart_recall selbst                    0,5 s  (davon Einbettung der Frage
//                                                  und Sinn-Dienst 0,27 s)
//
// Ein Brain, das dieser Prozess gerade angelegt hat und das noch startet, kann
// nichts enthalten: geschrieben wird erst, wenn die Instanz laeuft. Darauf zu
// warten, um dann "nichts gefunden" zu sagen, kostete ~9 s fuer eine Antwort,
// die vorher feststand (im Pruefaufruf danach lief die Instanz erst nach 12 s).
// Ebenso ein laufendes Brain ohne einen einzigen Eintrag: Einbettung, Leser,
// Sinn-Dienst und Kantenscan koennen dort nichts finden — die Einbettung kann
// bei kaltem Dienst aber Sekunden kosten.
//
// Nachgemessen mit derselben Probe nach dieser Aenderung: Werkzeugaufruf
// 0,98 s (Sofort-Test 0,71 s, ein Blick auf den Stand der Instanz 0,22 s).
//
// Hier steht deshalb (1) welche Instanzen dieser Prozess NEU angelegt hat und
// (2) der Text, den smart_recall dann sofort gibt. Er sagt, was ist: das Brain
// ist leer, und wenn das Projekt ein Git-Repo ist, lernt es gleich aus dessen
// Geschichte (startwissen.ts) — die naechste Antwort danach traegt den Hinweis.

import { STARTWISSEN_COMMITS, startwissenAusgang } from './startwissen.js';
import { abstentionSatz, beurteileTreffer } from './abstention.js';

/** Was ueber ein von diesem Prozess angelegtes Brain bekannt ist. */
export interface NeuesBrain {
  /** Startet im Hintergrund der Import aus der Git-Geschichte (startwissen.ts)? */
  lerntAusGit: boolean;
  /** Lief die Instanz beim letzten Blick schon? Dann gibt es nichts mehr abzukuerzen. */
  laeuft: boolean;
}

const _neu = new Map<string, NeuesBrain>();

/**
 * Merkt sich: diese Instanz hat DIESER Prozess eben angelegt (Sofort-Test oder
 * Anmeldung ohne vorhandene Instanz). Nur dann ist sicher, dass sie leer ist,
 * solange sie noch startet.
 */
export function merkeNeuesBrain(instanzId: string, lerntAusGit: boolean): void {
  if (!instanzId) return;
  _neu.set(instanzId, { lerntAusGit, laeuft: false });
}

/** Das Wissen ueber ein neues Brain, oder undefined fuer jedes andere. */
export function neuesBrain(instanzId: string): NeuesBrain | undefined {
  return _neu.get(instanzId);
}

/**
 * Lernt dieses Brain gleich oder gerade aus der Git-Geschichte? Nur fuer ein
 * neues Brain, und nur solange der Import nicht ausgegangen ist — ein Ordner
 * ohne Repo soll den Satz danach nicht mehr lesen.
 */
export function lerntNochAusGit(instanzId: string): boolean {
  return Boolean(_neu.get(instanzId)?.lerntAusGit) && startwissenAusgang(instanzId) === undefined;
}

/** Nur fuer Tests. */
export function _neueBrainsZuruecksetzen(): void {
  _neu.clear();
}

/**
 * Die Antwort von smart_recall, wenn es nichts zu finden GIBT.
 *
 * Die erste Zeile ist derselbe Satz, den der volle Weg bei leerer Trefferliste
 * gibt (abstention.ts) — Messlaeufe und Tests zaehlen "schweigen" an ihm.
 *
 * Beide Fassungen enthalten "no lessons": daran erkennt index.ts (srHit), dass
 * dieser Abruf NICHTS geliefert hat. Ohne den Satzteil zaehlte ein leeres
 * Brain im Trichter als Treffer (Test in __tests__/leeres-brain.test.ts).
 *
 * @param lage.startet      die Instanz laeuft noch nicht (frisch angelegt)
 * @param lage.lerntAusGit  der Import aus der Git-Geschichte kommt gleich oder laeuft
 */
export function leeresBrainAntwort(query: string, lage: { startet: boolean; lerntAusGit: boolean }): string {
  const zeilen = [`🧠 **Smart Recall** for: _"${query}"_\n`, abstentionSatz(beurteileTreffer([]))];
  zeilen.push(lage.startet
    ? '📭 **This Brain is brand new and still empty** — it has no lessons yet, so there is nothing to recall '
      + 'for this question. It is starting up on the server right now.'
    : '📭 **This Brain is still empty** — it has no lessons and no stored context yet, so there is nothing '
      + 'to recall for this question.');
  if (lage.lerntAusGit) {
    zeilen.push(
      `If the project folder is a git repository, the Brain now learns from its last ${STARTWISSEN_COMMITS} commits `
        + 'in the background. A short notice comes with the next answer once that is done; from then on '
        + '`smart_recall` finds them.',
    );
  }
  zeilen.push('The first own lesson comes from `learn_from_attempts` after a fix or a discovery.');
  return zeilen.join('\n');
}
