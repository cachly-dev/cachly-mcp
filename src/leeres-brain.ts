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
//
// ── session_start und die anderen fruehen Lesewerkzeuge (11.10.2026) ────────
//
// Der Normalfall ist nicht smart_recall zuerst, sondern session_start: so
// steht es in CLAUDE.md und im Sitzungs-Briefing. Dieselbe Probe von aussen
// mit 0.10.179, session_start als erster Aufruf: Werkzeugaufruf 16,0 s.
//
//   Sofort-Test (Brain anlegen)            0,6 s
//   Warten, bis die Instanz laeuft         9,7 s
//   session_start selbst                   1,1 s
//   Erst-Import danach (index.ts)          4,3 s  (brain_from_git scheitert am
//                                                  Ordner ohne Git, dann der
//                                                  Startvorrat mit 16 Lektionen)
//
// Der zweite Aufruf (recall_best_solution) brauchte noch einmal 1,1 s, davon
// 0,8 s fuer ein automatisches zweites session_start.
//
// Jetzt fragt jedes Lesewerkzeug, das beim Start typischerweise zuerst kommt,
// hier nach (startetNochLeer) und antwortet sofort, solange das neue Brain
// startet. Schreibwerkzeuge warten weiter auf die Instanz — es geht nichts
// verloren. Was session_start schreibt (Sitzungsbeginn, Serie, gesehene
// Fassung), schreibt die Verbindung nach, sobald sie steht.
//
// Nachgemessen mit derselben Probe: session_start 0,56 s statt 16,0 s,
// recall_best_solution danach 0,19 s statt 1,1 s. Die Wartezeit ist nicht
// weg, sie liegt jetzt beim ersten SCHREIBENDEN Aufruf (learn_from_attempts
// direkt danach: 8,9 s) — dort, wo sie hingehoert.
//
// Der Erst-Import in index.ts (brain_from_git synchron, bei leerem Ergebnis
// der Startvorrat) laeuft fuer ein solches Brain nicht mehr. Beides macht
// startwissen.ts im Hintergrund: im Git-Repo die Geschichte, im Ordner ohne
// Git den Startvorrat (16 Lektionen) — einmal je Instanz, nur in ein leeres
// Brain. Das Briefing sagt, was davon gerade kommt.

import { STARTWISSEN_COMMITS, STARTVORRAT_LEKTIONEN, startwissenAusgang } from './startwissen.js';
import { abstentionSatz, beurteileTreffer } from './abstention.js';

/** Der gemeinsame Satzanfang aller Sofort-Antworten eines neuen Brains. */
export const NEUES_BRAIN = 'This Brain is brand new';

/** Was ueber ein von diesem Prozess angelegtes Brain bekannt ist. */
export interface NeuesBrain {
  /** Startet im Hintergrund der Import aus der Git-Geschichte (startwissen.ts)? */
  lerntAusGit: boolean;
  /** Laedt es in einem Ordner ohne Git stattdessen den Startvorrat (startwissen.ts)? */
  laedtStartvorrat: boolean;
  /** Lief die Instanz beim letzten Blick schon? Dann gibt es nichts mehr abzukuerzen. */
  laeuft: boolean;
}

const _neu = new Map<string, NeuesBrain>();

/**
 * Merkt sich: diese Instanz hat DIESER Prozess eben angelegt (Sofort-Test oder
 * Anmeldung ohne vorhandene Instanz). Nur dann ist sicher, dass sie leer ist,
 * solange sie noch startet.
 */
export function merkeNeuesBrain(instanzId: string, lerntAusGit: boolean, laedtStartvorrat = false): void {
  if (!instanzId) return;
  _neu.set(instanzId, { lerntAusGit, laedtStartvorrat, laeuft: false });
}

/** Was ein neues Brain gerade im Hintergrund bekommt — fuer die Saetze unten. */
export interface StartLage {
  /** Der Import aus der Git-Geschichte kommt gleich oder laeuft. */
  lerntAusGit: boolean;
  /** Ohne Git kommt stattdessen der Startvorrat. */
  startvorrat?: boolean;
}

/** Die StartLage eines Brains; beides false, sobald das Startwissen ausgegangen ist. */
export function startLage(instanzId: string): StartLage {
  const lerntAusGit = lerntNochAusGit(instanzId);
  return { lerntAusGit, startvorrat: lerntAusGit && Boolean(_neu.get(instanzId)?.laedtStartvorrat) };
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

/** Fragt die API nach dem Stand einer Instanz (apiFetch aus index.ts). */
export type StandAbfrage = (pfad: string) => Promise<{ status?: string } | null | undefined>;

/**
 * Hat DIESER Prozess das Brain eben angelegt, und startet es noch? Dann ist es
 * leer, und ein Lesewerkzeug darf sofort antworten.
 *
 * Kostet nur bei einem neuen Brain etwas: einen Blick auf den Stand (40 bis
 * 150 ms). Meldet die API etwas anderes als `provisioning` — `running`, einen
 * Fehler, gar nichts —, merkt sich die Liste das. Danach nimmt jeder Aufruf
 * den vollen Weg, ohne diesen Blick. Im Zweifel also immer der volle Weg.
 */
export async function startetNochLeer(instanzId: string, apiFetch: StandAbfrage): Promise<boolean> {
  const neu = _neu.get(instanzId);
  if (!neu || neu.laeuft) return false;
  const stand = await apiFetch(`/api/v1/instances/${instanzId}`).catch(() => null);
  if (stand?.status === 'provisioning') return true;
  neu.laeuft = true;
  return false;
}

/**
 * Sah der letzte Blick dieses neue Brain noch startend? Dann war die Antwort
 * eben eine Sofort-Antwort. index.ts zaehlt ein solches session_start nicht
 * als Abruf: es hat nichts geliefert.
 */
export function startetLautLetztemBlick(instanzId: string): boolean {
  const neu = _neu.get(instanzId);
  return Boolean(neu && !neu.laeuft);
}

/**
 * Der Satz zum Startwissen, wenn es gleich kommt oder laeuft. Ob der Ordner
 * ein Git-Repo ist, entscheidet startwissen.ts erst NACH der ersten Antwort —
 * deshalb nennt der Satz beide Faelle.
 */
function startSatz(lage: StartLage): string[] {
  if (!lage.lerntAusGit) return [];
  const anfang = `If the project folder is a git repository, the Brain now learns from its last ${STARTWISSEN_COMMITS} commits `
    + 'in the background';
  const ohneGit = lage.startvorrat
    ? `; if it is not, the Brain is loading ${STARTVORRAT_LEKTIONEN} starter lessons (common engineering fixes) instead`
    : '';
  return [`${anfang}${ohneGit}. A short notice comes with the next answer once that is done; from then on `
    + '`smart_recall` finds them.'];
}

const ERSTE_LEKTION = 'The first own lesson comes from `learn_from_attempts` after a fix or a discovery.';

/**
 * Die Sofort-Antwort eines Lesewerkzeugs auf einem neuen Brain, das noch
 * startet. `kopf` ist die erste Zeile, die das Werkzeug auch im vollen Weg
 * bei leerem Ergebnis gibt — Leser und Messlaeufe erkennen sie wieder.
 */
export function neuesBrainAntwort(kopf: string, lage: StartLage): string {
  return [
    kopf,
    '',
    `📭 **${NEUES_BRAIN} and still empty** — it was created a moment ago and is starting up on the server `
      + 'right now. Nothing is stored in it yet.',
    ...startSatz(lage),
    ERSTE_LEKTION,
  ].join('\n');
}

/**
 * Fuer die Lesewerkzeuge, die beim Start zuerst kommen: die Sofort-Antwort,
 * wenn das Brain neu ist und noch startet. Sonst null — dann nimmt das
 * Werkzeug seinen vollen Weg, unveraendert.
 */
export async function sofortAntwortNeuesBrain(
  instanzId: string,
  apiFetch: StandAbfrage,
  kopf: string,
): Promise<string | null> {
  if (!(await startetNochLeer(instanzId, apiFetch))) return null;
  return neuesBrainAntwort(kopf, startLage(instanzId));
}

/**
 * Das Briefing von session_start auf einem neuen Brain, das noch startet.
 *
 * Es sagt, was ist: das Brain ist neu und leer, es startet gerade, und wenn
 * das Projekt ein Git-Repo ist, lernt es gleich aus dessen Geschichte. Dazu,
 * wie man mit cachly arbeitet — die drei Aufrufe, die das Brain fuellen.
 *
 * Der Satz "Welcome! Your AI Brain is live." fehlt mit Absicht: er waere
 * nicht wahr, und index.ts startet an ihm den Import aus Git synchron — der
 * wartete auf die Instanz und hielte die Antwort an. Den Import macht hier
 * startwissen.ts im Hintergrund.
 */
export function neuesBrainBriefing(lage: StartLage & { instanzId: string; provider?: string }): string {
  const zeilen = [`🧠 **Session Briefing**${lage.provider ? ` · ${lage.provider}` : ''}`, ''];
  zeilen.push(
    `🆕 **${NEUES_BRAIN}** — it was created a moment ago and is starting up on the server right now. `
      + 'It has no lessons and no stored context yet, so there is nothing to brief you on.',
    '',
  );
  const satz = startSatz(lage);
  if (satz.length) zeilen.push(`📚 ${satz[0]}`, '');
  zeilen.push(
    '**How to work with cachly:**',
    '  • Before a task → `smart_recall(query="what you are about to do")`',
    '  • After a fix or a discovery → `learn_from_attempts(topic="area:keyword", outcome="success", what_worked="...")`',
    '  • At the end of the session → `session_end(summary="what you did")`',
    '',
    'Writes wait until the Brain runs (a few seconds) — nothing gets lost.',
    '',
  );
  // Laedt der Startvorrat ohnehin (Ordner ohne Git), ist das Angebot doppelt.
  if (!lage.startvorrat) {
    zeilen.push(
      `🌱 **Want answers right now?** Seed ${STARTVORRAT_LEKTIONEN} universal engineering lessons so your first `
        + '`smart_recall` returns a hit:',
      `   \`brain_seed_starter(instance_id="${lage.instanzId}")\` — they never override your own lessons.`,
      '',
    );
  }
  zeilen.push('📊 **Brain:** 0 lessons · 0 context entries');
  return zeilen.join('\n');
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
export function leeresBrainAntwort(query: string, lage: StartLage & { startet: boolean }): string {
  const zeilen = [`🧠 **Smart Recall** for: _"${query}"_\n`, abstentionSatz(beurteileTreffer([]))];
  zeilen.push(lage.startet
    ? `📭 **${NEUES_BRAIN} and still empty** — it has no lessons yet, so there is nothing to recall `
      + 'for this question. It is starting up on the server right now.'
    : '📭 **This Brain is still empty** — it has no lessons and no stored context yet, so there is nothing '
      + 'to recall for this question.');
  zeilen.push(...startSatz(lage), ERSTE_LEKTION);
  return zeilen.join('\n');
}
