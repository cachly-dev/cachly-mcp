/**
 * Die Sitzungs-Automatik: was ein Werkzeugaufruf mit der automatischen Sitzung tut.
 *
 * Der Server startet beim ersten Werkzeugaufruf eines Prozesses selbst ein
 * session_start, damit niemand es von Hand aufrufen muss. Bis zum 11.11.2026
 * zaehlte dabei ein AUSDRUECKLICH aufgerufenes session_start nicht mit. Genau
 * das tun aber die meisten Agenten als Erstes, weil die Anweisung es verlangt.
 * Die Folge: Der erste smart_recall danach loeste ein zweites, unsichtbares
 * session_start aus und wartete darauf. Gemessen an einem Brain mit 1.257
 * Lektionen: rund 6 s, fuer ein Briefing, das niemand zu sehen bekommt.
 *
 * Seitdem gilt ein ausdruecklicher Start als Start. Der Aufruf selbst laeuft
 * unveraendert; nur das zweite Mal faellt weg.
 */

/** Werkzeuge, die die Sitzung selbst verwalten — sie loesen keine Automatik aus. */
export const SITZUNGS_WERKZEUGE: ReadonlySet<string> = new Set([
  'session_start', 'session_start_summary', 'session_end', 'auto_learn_session',
]);

export type AutoSitzungsSchritt =
  /** Automatisch ein session_start ausfuehren und darauf warten. */
  | 'starten'
  /** Ein anderer Aufruf startet gerade — auf ihn warten. */
  | 'abwarten'
  /** Dieser Aufruf IST das session_start: als gestartet merken, kein zweites. */
  | 'als-gestartet-merken'
  | 'nichts';

export function autoSitzungsSchritt(
  name: string,
  zustand: { gestartet: boolean; startetGerade: boolean; instanz: string },
): AutoSitzungsSchritt {
  const frei = !zustand.gestartet && !zustand.startetGerade;
  if (frei && zustand.instanz && name === 'session_start') return 'als-gestartet-merken';
  if (frei && zustand.instanz && !SITZUNGS_WERKZEUGE.has(name)) return 'starten';
  if (zustand.startetGerade) return 'abwarten';
  return 'nichts';
}
