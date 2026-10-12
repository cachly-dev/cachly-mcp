/**
 * Adressen, die der Server im Browser des Nutzers oeffnet.
 *
 * Unter Windows laeuft das ueber `cmd /c start "" <adresse>`, und `cmd` ist eine
 * Shell: ein `&` in der Adresse beendet dort den Befehl und startet den
 * naechsten. Ausserdem startet `start` auch Programme und Dateien, nicht nur
 * Webseiten (`start "" calc.exe`). Zwei Regeln halten das heraus:
 *
 *   1. Nur `http:` und `https:` werden geoeffnet. Alles andere (Dateipfade,
 *      `file:`, Programmnamen) wird abgelehnt, bevor ein Prozess startet.
 *   2. Fuer `cmd` bekommen seine Sonderzeichen ein `^` davor.
 *
 * Auf macOS und Linux gibt es keine Shell; dort reicht Regel 1.
 */

/** Die normalisierte Adresse, wenn es eine http(s)-Adresse ist, sonst `null`. */
export function browserAdresse(roh: unknown): string | null {
  if (typeof roh !== 'string') return null;
  try {
    const u = new URL(roh);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Sonderzeichen von `cmd` (`& | < > ^`) mit `^` entwerten. */
export function fuerCmd(adresse: string): string {
  return adresse.replace(/[&|<>^]/g, '^$&');
}
