/**
 * Meldestelle fuer stille Aussetzer.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Am 20.08.2026 wurde am Produktionsspeicher gemessen: `cachly:lesson:vec:*`
 * war LEER — 0 Vektoren bei 506 Lektionen. Der Recall-Pfad steigt bei
 * `vektorbestand.groesse === 0` aus und faellt auf den reinen Wortabgleich
 * zurueck. Er tut das STUMM.
 *
 * Von aussen ist dieser Zustand von "alles in Ordnung" nicht zu
 * unterscheiden: die Suche liefert weiter Ergebnisse, nur schlechtere. Die am
 * 19.08. gemessene Verbesserung von 21 auf 40 Prozent existierte in
 * Produktion nie, und nichts hat es gesagt.
 *
 * Das ist die Fehlerklasse "Stille wird als gruen gebucht". Diese Datei ist
 * die Gegenmassnahme an der billigsten Stelle: eine Zeile im Protokoll.
 *
 * ── Warum nur EINMAL je Grund ───────────────────────────────────────────────
 *
 * Der Recall-Pfad laeuft bei jeder Anfrage. Eine Zeile je Anfrage waere nach
 * einer Stunde ein Protokoll, das niemand mehr liest — und ein Protokoll, das
 * niemand liest, ist wieder Stille. Einmal je Grund und Prozess ist die
 * Menge, die auffaellt, ohne zu ermueden.
 *
 * ── Warum stderr und nicht stdout ───────────────────────────────────────────
 *
 * Ueber stdout laeuft das MCP-Protokoll. Eine Zeile Text dort ist kein
 * Hinweis, sondern ein Verbindungsabbruch.
 */

/** Welche Gruende schon gemeldet wurden. Je Prozess, nicht je Anfrage. */
const gemeldet = new Set<string>();

/**
 * Meldet einen Aussetzer genau einmal je Grund und Prozess.
 *
 * @param grund kurzer Schluessel, z. B. 'bedeutung-ohne-vektoren'
 * @param text  was ausgefallen ist und was das fuer das Ergebnis heisst
 * @returns true, wenn diese Meldung wirklich hinausging
 */
export function meldeEinmal(grund: string, text: string): boolean {
  if (gemeldet.has(grund)) return false;
  gemeldet.add(grund);
  console.error(`[aussetzer] ${grund}: ${text}`);
  return true;
}

/**
 * Wurde dieser Grund in diesem Prozess schon gemeldet?
 *
 * Fuer `brain_doctor`: dort soll stehen, was hier passiert ist, ohne dass
 * jemand ein Protokoll durchsuchen muss.
 */
export function schonGemeldet(grund: string): boolean {
  return gemeldet.has(grund);
}

/** Alle bisher gemeldeten Gruende, in der Reihenfolge des Auftretens. */
export function gemeldeteGruende(): string[] {
  return [...gemeldet];
}

/**
 * Setzt die Merkliste zurueck.
 *
 * Nur fuer Tests. Ohne das wuerde die erste Testdatei alle weiteren blind
 * machen — genau der Fehler, gegen den diese Datei antritt.
 */
export function setzeAussetzerZurueck(): void {
  gemeldet.clear();
}

/** Der Grund, um den es beim Anlass ging: Bedeutungsabgleich ohne Vektoren. */
export const OHNE_VEKTOREN = 'bedeutung-ohne-vektoren';

/** Der Nachbarfall: es gibt gar keinen Dienst zum Einbetten. */
export const OHNE_DIENST = 'bedeutung-ohne-dienst';

/**
 * Der Bestand ist da, aber die FRAGE liess sich nicht einbetten.
 *
 * Eigener Grund und nicht mit OHNE_VEKTOREN zusammengelegt: hier ist der
 * Bestand gesund und der fremde Dienst hat gerade nicht geantwortet. Das ist
 * ein Netzproblem und keine fehlende Nachruestung — wer beides unter einem
 * Namen fuehrt, sucht spaeter an der falschen Stelle.
 */
export const OHNE_FRAGEVEKTOR = 'bedeutung-ohne-fragevektor';
