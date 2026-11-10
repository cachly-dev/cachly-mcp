/**
 * Zeitgrenzen fuer Tests, die ein Hook-Buendel als eigenen Node-Prozess starten.
 *
 * Unter CI-Last dauert schon der Start des Buendels mehrere Sekunden. Feste
 * Grenzen fielen dadurch durch, ohne dass ein Hook gewartet haette. Befund
 * 10.11.2026 auf node-4 bei Last 74 auf 12 Kernen, je gegen fest 5000 ms:
 * cursor-hook beforeSubmitPrompt 5564 ms, erster-prompt SessionStart 5158 ms.
 *
 * Darum misst ein Test zuerst einen Leerlauf desselben Buendels (ohne
 * Schluessel, ohne Arbeit, ohne Anfrage) und erlaubt die eigentliche Arbeit
 * obendrauf. Der Boden haelt die alte feste Grenze auf ruhigen Rechnern.
 * Ein echtes Warten (Netz-Frist, Abruf-Limit 8 s, Hook-Frist 30 s) liegt
 * weiter ueber der Grenze, solange `arbeitMs` darunter bleibt.
 */
export function grenzeNachLeerlauf(leerMs: number, arbeitMs: number, bodenMs: number): number {
  return Math.max(bodenMs, leerMs + arbeitMs);
}
