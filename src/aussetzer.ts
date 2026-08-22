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
 * Aus einem geworfenen Wert einen lesbaren Grund machen.
 *
 * JavaScript laesst zu, dass ALLES geworfen wird — ein Error, ein String, ein
 * undefined. `String(e)` auf einem leeren Objekt ergibt "[object Object]", und
 * das ist als Ursachenangabe wertlos.
 *
 * Gekuerzt auf 200 Zeichen: der Grund gehoert in EINE Protokollzeile. Manche
 * Anbieter antworten mit einer ganzen HTML-Seite, und ein Protokoll, das
 * niemand mehr liest, ist wieder Stille.
 */
export function fehlerText(e: unknown): string {
  if (e instanceof Error) return (e.message || e.name || 'Error').slice(0, 200);
  if (typeof e === 'string') return e.slice(0, 200) || 'leerer Text geworfen';
  if (e === undefined) return 'undefined geworfen (kein Grund mitgegeben)';
  if (e === null) return 'null geworfen (kein Grund mitgegeben)';
  try {
    const j = JSON.stringify(e);
    return j && j !== '{}' ? j.slice(0, 200) : `${typeof e} ohne Inhalt geworfen`;
  } catch {
    return `${typeof e} geworfen, nicht darstellbar`;
  }
}

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

/**
 * Der Auffang-catch am Ende des Bedeutungspfads.
 *
 * Eigener Grund, weil er etwas anderes bedeutet als die drei darueber: die
 * sind BENANNTE Ausstiege ("kein Dienst", "keine Vektoren", "Frage nicht
 * einbettbar") — hier ist etwas Unerwartetes passiert. Wer beides unter einem
 * Namen fuehrt, sieht nicht, dass er einen Fehler hat statt einer Luecke.
 */
export const SINNPFAD_ABBRUCH = 'bedeutung-abbruch';

/**
 * Die Einbettung BEIM SCHREIBEN einer Lektion ist fehlgeschlagen.
 *
 * ── Warum dieser Grund am 22.08.2026 dazukam ────────────────────────────────
 *
 * Alle Gruende darueber betreffen das SUCHEN. Das Schreiben hatte keinen: in
 * handlers/brain.ts standen drei leere `catch { }` um die drei Einbettungen
 * (Volltext, Themenname, Eingaenge). Sie sind mit Absicht fehlertolerant —
 * eine Lektion muss auch ohne Netz gespeichert werden koennen — aber sie
 * warfen den GRUND weg.
 *
 * Gemessen am 22.08.2026 ueber den Admin-Endpunkt: von 50 gezogenen Instanzen
 * hatten drei Lektionen (10, 2 und 46) und NULL Vektoren. Warum, konnte
 * niemand sagen — kein Protokoll, keine Zahl, nichts. Der Wachhund meldete
 * seit zwei Tagen "Bedeutungsabgleich AUS", ohne dass eine Ursache
 * feststellbar war.
 *
 * Die Fehlerklasse ist bekannt: "Stille wird als gruen gebucht". Der
 * Unterschied hier ist, dass nicht einmal der Ausfall still war, sondern nur
 * sein Grund. Ein Alarm ohne Ursache ist ein Alarm, den man abschaltet.
 *
 * Die Lektion wird weiterhin gespeichert. Es aendert sich NUR, dass der Grund
 * einmal je Prozess im Protokoll steht.
 */
export const OHNE_SCHREIBVEKTOR = 'einbettung-beim-schreiben';

/** Der Versuch ist eingeschaltet, laeuft aber ohne Wirkung (siehe versuch.ts). */
export const VERSUCH_LEER = 'versuch-laeuft-leer';

// ── Der Vermerk, der einen Neustart ueberlebt ───────────────────────────────
//
// meldeEinmal schreibt nach stderr und merkt sich den Grund im
// Arbeitsspeicher. Beides ist nach einem Neustart weg — bei jedem Deploy,
// jedem Absturz, jeder Skalierung. Gemessen am 20.08.2026 (Karte
// opupbt3l9wcq): eine Fehlkonfiguration konnte so WOCHENLANG bestehen, ohne
// dass jemand sie sah, weil "keine Daten" und "noch nicht genug Daten" von
// aussen gleich aussehen.
//
// Deshalb zusaetzlich ein Vermerk in Valkey: Zaehler, letzter Zeitpunkt,
// letzter Text. `brain_doctor` liest ihn, also braucht niemand ein Protokoll
// zu durchsuchen.
//
// Die Lebensdauer wird bei JEDEM Vermerk erneuert. Damit heisst "vorhanden"
// immer "in den letzten 30 Tagen passiert" — ein Aussetzer von vor einem
// halben Jahr steht nicht mehr im Weg, und ein laufender verschwindet nie.

/** Schluessel-Vorsatz der Vermerke. */
export const AUSSETZER_VORSATZ = 'cachly:aussetzer:';

/** 30 Tage. Wird bei jedem Vermerk erneuert. */
export const AUSSETZER_TTL_SEKUNDEN = 30 * 24 * 60 * 60;

/** Was ein Vermerk enthaelt. */
export interface Aussetzervermerk {
  grund: string;
  anzahl: number;
  zuletzt: string;
  text: string;
}

/** So viel wie ein Vermerk braucht, ohne den Speicher zu belasten. */
interface VermerkSpeicher {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
}

/**
 * Meldet den Aussetzer (einmal je Prozess) UND vermerkt ihn dauerhaft.
 *
 * Der Vermerk darf die Anfrage NIE zum Scheitern bringen: wer eine Suche
 * abbricht, weil er den Ausfall nicht aufschreiben konnte, hat aus einer
 * Verschlechterung einen Ausfall gemacht. Scheitert das Schreiben, bleibt es
 * bei der stderr-Zeile — gemeldet ueber meldeEinmal, damit auch dieser
 * Rueckfall nicht still ist.
 *
 * @returns true, wenn die stderr-Meldung wirklich hinausging
 */
export async function meldeUndVermerke(
  redis: VermerkSpeicher | null | undefined,
  grund: string,
  text: string,
): Promise<boolean> {
  const gemeldetJetzt = meldeEinmal(grund, text);
  if (!redis) return gemeldetJetzt;
  try {
    const key = `${AUSSETZER_VORSATZ}${grund}`;
    await redis.hincrby(key, 'anzahl', 1);
    await redis.hset(key, { zuletzt: new Date().toISOString(), text: text.slice(0, 500) });
    await redis.expire(key, AUSSETZER_TTL_SEKUNDEN);
  } catch (e) {
    meldeEinmal(`${grund}-vermerk`,
      `der Aussetzer liess sich nicht vermerken (${e instanceof Error ? e.message : String(e)}) `
      + '— er steht nur in diesem Protokoll und ist nach einem Neustart weg');
  }
  return gemeldetJetzt;
}

/**
 * Alle Vermerke der letzten 30 Tage, der haeufigste zuerst.
 *
 * Fuer `brain_doctor`. Ein Fehler beim Lesen liefert eine leere Liste — aber
 * NICHT still: der Aufrufer bekommt `null` und kann "nicht gemessen" von
 * "nichts gefunden" unterscheiden. Genau dieser Unterschied fehlte an allen
 * Stellen, aus denen diese Datei entstanden ist.
 */
export async function leseVermerke(
  redis: VermerkSpeicher | null | undefined,
): Promise<Aussetzervermerk[] | null> {
  if (!redis) return null;
  try {
    const keys = await redis.keys(`${AUSSETZER_VORSATZ}*`);
    const vermerke: Aussetzervermerk[] = [];
    for (const key of keys) {
      const h = await redis.hgetall(key);
      if (!h || !h.anzahl) continue;
      vermerke.push({
        grund: key.slice(AUSSETZER_VORSATZ.length),
        anzahl: Number(h.anzahl) || 0,
        zuletzt: h.zuletzt ?? '',
        text: h.text ?? '',
      });
    }
    vermerke.sort((a, b) => b.anzahl - a.anzahl || a.grund.localeCompare(b.grund));
    return vermerke;
  } catch {
    return null;
  }
}
