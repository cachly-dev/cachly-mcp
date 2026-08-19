/**
 * Deutsch für die Suche: Umlaute, Wortformen, zusammengesetzte Wörter.
 *
 * ── Warum es dieses Modul gibt ───────────────────────────────────────────────
 *
 * Gemessen am 19.08.2026 an 498 echten Lektionen mit 20 Fragen in Alltags-
 * deutsch: 2 Treffer. Sechs Fragen teilten mit der richtigen Antwort NICHT EIN
 * EINZIGES Wort. Die Aufteilung nach Ursachen (src/bench/wortschatz-oder-
 * menge.ts) zeigte: schon bei 20 Lektionen und null Ablenkern scheitern 14 von
 * 20. Es ist also der Wortschatz, nicht die Menge.
 *
 * Die Suche hatte deutsche Stoppwörter und 35 deutsche Wortpaare. Was fehlte,
 * waren drei Dinge — und alle drei sind an echten Fragen belegt:
 *
 *   1. UMLAUTE. Die Wortliste stand mit echten Umlauten (`lösung`,
 *      `überwachung`), Lektionen und Fragen schreiben oft `ae/oe/ue`. Damit
 *      fand `ueberwachung` den Eintrag `überwachung` nie. Zwei Schreibweisen
 *      desselben Wortes, und die Suche hielt sie für verschieden.
 *
 *   2. WORTFORM. `abhaengigkeiten` gegen `abhaengigkeit`, `prozesse` gegen
 *      `prozess`. Für sieben Sprachen gab es einen Stemmer, für Deutsch nicht.
 *
 *   3. ZUSAMMENGESETZTE WÖRTER. Das ist die deutsche Besonderheit und war die
 *      größte Lücke. `Arbeitsspeicher` enthält `speicher`, und `speicher` steht
 *      längst in der Wortliste — nur kam niemand dort an. Genauso
 *      `Zugriffsprotokoll` → `protokoll` → `log`, `Browsertests` → `test`.
 *
 * ── Die Entscheidung, die dieses Modul klein hält ────────────────────────────
 *
 * Für die Zerlegung braucht es ein Wörterbuch der Grundwörter. Es wäre nahe-
 * liegend, dafür eine zweite Liste zu pflegen. Genau das ist die Fehlerklasse,
 * die uns in diesem Haus am häufigsten trifft: eine Wahrheit an zwei Orten.
 *
 * Deshalb: die Wortliste IST das Wörterbuch. Wer ein Wortpaar einträgt, macht
 * es damit automatisch als Grundwort für zusammengesetzte Wörter verfügbar.
 * Eine Liste, zwei Wirkungen.
 */

/**
 * Schreibt Umlaute aus. Aus `ä` wird `ae`, aus `ß` wird `ss`.
 *
 * Beide Schreibweisen werden auf DIESELBE Form gebracht — nicht die eine in die
 * andere übersetzt. Nur so ist `Lösung` dasselbe Wort wie `Loesung`, egal in
 * welcher Richtung jemand tippt.
 */
export function ohneUmlaute(wort: string): string {
  return wort
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'ae').replace(/Ö/g, 'oe').replace(/Ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/**
 * Endungen, die im Deutschen Fall und Zahl anzeigen — von der längsten zur
 * kürzesten, damit `-ungen` vor `-en` greift.
 *
 * Die Liste ist absichtlich kurz. Ein zu gieriger Stemmer verschmilzt Wörter,
 * die nichts miteinander zu tun haben, und das ist schlimmer als eine Endung
 * zu viel: falsche Treffer verdrängen richtige, fehlende Treffer nicht.
 */
const ENDUNGEN = ['ungen', 'nisse', 'erne', 'ern', 'end', 'est', 'en', 'er', 'es', 'em', 'et', 'e', 'n', 's'];

/** Ab hier hört das Stammen auf — kürzere Reste sind meist keine Wörter mehr. */
const MINDESTLAENGE = 4;

/**
 * Deutsche Wortform auf einen gemeinsamen Stamm bringen.
 *
 * Absichtlich zurückhaltend: eine Endung, nicht mehrere hintereinander. Bei
 * `Abhaengigkeiten` reicht `-en`, und `Abhaengigkeit` ist genau die Form, die
 * in den Lektionen steht.
 */
export function deutscherStamm(wort: string): string {
  const w = ohneUmlaute(wort.toLowerCase());
  if (w.length < MINDESTLAENGE + 1) return w;
  for (const endung of ENDUNGEN) {
    if (w.endsWith(endung) && w.length - endung.length >= MINDESTLAENGE) {
      return w.slice(0, -endung.length);
    }
  }
  return w;
}

/**
 * Die Rückumlautung: `eintraeg` → `eintrag`, `laeuft` → `lauft`.
 *
 * Das Deutsche verändert im Plural und in gebeugten Formen den Stammvokal
 * (Eintrag → Einträge). Ohne diesen Schritt bleiben Einzahl und Mehrzahl zwei
 * verschiedene Wörter.
 *
 * Nur die letzte Umlautstelle wird zurückgenommen. `Ueberpruefung` soll nicht
 * zu `Uberprufung` werden — das Wort beginnt mit einem echten `ü`, das kein
 * Umlaut einer Mehrzahl ist.
 */
export function ohneRueckumlaut(stamm: string): string | null {
  const stelle = Math.max(stamm.lastIndexOf('ae'), stamm.lastIndexOf('oe'), stamm.lastIndexOf('ue'));
  if (stelle <= 0) return null; // <= 0: am Wortanfang steht ein echter Umlaut
  const paar = stamm.slice(stelle, stelle + 2);
  const einzeln = paar === 'ae' ? 'a' : paar === 'oe' ? 'o' : 'u';
  const neu = stamm.slice(0, stelle) + einzeln + stamm.slice(stelle + 2);
  return neu === stamm ? null : neu;
}

/**
 * Zerlegt ein zusammengesetztes Wort in seine Bestandteile.
 *
 * `Arbeitsspeicher` → `speicher` (und `arbeit`)
 * `Zugriffsprotokoll` → `protokoll` (und `zugriff`)
 * `Browsertests` → `test` (und `browser`)
 *
 * Wie es arbeitet: Das Grundwort steht im Deutschen HINTEN. Also wird von
 * hinten nach einem bekannten Wort gesucht. Der Rest davor wird ebenfalls
 * zurückgegeben, wenn er lang genug ist — er trägt oft die eigentliche
 * Bedeutung (`Arbeit` in `Arbeitsspeicher`).
 *
 * Das `s` in `Arbeits|speicher` ist eine Fuge und gehört zu keinem der beiden
 * Teile. Es wird abgeschnitten.
 *
 * @param bekannt Grundwörter, gegen die geprüft wird. Das ist die Wortliste der
 *                Suche selbst — kein zweites Wörterbuch, das veralten kann.
 */
export function zerlegeKompositum(wort: string, bekannt: Set<string>): string[] {
  const w = ohneUmlaute(wort.toLowerCase());
  // Unter 10 Zeichen lohnt es nicht: `dienst` oder `fehler` sind schon Grund-
  // wörter, und kurze Wörter zu zerlegen erzeugt vor allem Unsinn.
  if (w.length < 10) return [];

  // Von hinten, längstes Grundwort zuerst — `zeitueberschreitung` soll nicht
  // bei `zeit` stehenbleiben.
  for (let schnitt = 4; schnitt <= w.length - 4; schnitt++) {
    const hinten = w.slice(schnitt);
    if (hinten.length < 4 || !bekannt.has(hinten)) continue;

    const teile = [hinten];
    let vorne = w.slice(0, schnitt);
    if (vorne.endsWith('s') || vorne.endsWith('n')) vorne = vorne.slice(0, -1); // Fugenlaut
    if (vorne.length >= 4) teile.push(vorne);
    return teile;
  }
  return [];
}

/**
 * Deutsche Fachwörter, die in unseren Lektionen und Fragen vorkommen.
 *
 * ── Woher diese Liste kommt ──────────────────────────────────────────────────
 *
 * Nicht aus dem Kopf. Jeder Eintrag stammt aus der Messung vom 19.08.2026: es
 * sind die Wörter, die in echten Fragen standen und in der richtigen Antwort
 * keinen Anschluss fanden (src/bench/wo-bricht-die-frage.ts nennt sie).
 *
 * Deshalb ist die Liste kurz und wird es bleiben. Sie wächst aus Messungen,
 * nicht aus Vermutungen — wer etwas einträgt, soll die Frage nennen können, die
 * ohne den Eintrag danebengeht.
 */
export const DEUTSCHE_FACHWOERTER: ReadonlyArray<readonly [string, string[]]> = [
  // Speicher und Platte
  ['cache', ['cache', 'zwischenspeicher']],
  ['zwischenspeicher', ['cache']],
  ['arbeitsspeicher', ['memory', 'ram']],
  ['platte', ['disk', 'storage']],
  ['festplatte', ['disk', 'storage']],
  ['plattenplatz', ['disk', 'space']],

  // Datenbank
  ['spalte', ['column']],
  ['tabelle', ['table']],
  ['zeile', ['row']],
  ['abfrage', ['query']],
  ['zeilenschutz', ['rls', 'row-level-security']],
  ['mandant', ['tenant']],
  ['mandanten', ['tenant', 'tenants']],
  ['wanderung', ['migration']],

  // Laufzeit und Fehler
  ['prozess', ['process']],
  ['zeitueberschreitung', ['timeout']],
  ['ausfall', ['outage', 'down']],
  ['abgewiesen', ['refused', 'rejected']],
  ['abgelehnt', ['refused', 'rejected']],
  ['verweigert', ['denied', 'refused']],
  ['haengt', ['hang', 'hangs', 'stuck']],
  ['haengen', ['hang', 'stuck']],
  ['abhaengigkeit', ['dependency']],
  ['abhaengigkeiten', ['dependency', 'dependencies']],
  ['zugriff', ['access']],
  ['freigeschaltet', ['allowlist', 'permission', 'access']],
  ['freigabe', ['permission', 'access', 'approval']],

  // Bauen und Ausliefern
  ['ausrollen', ['deploy', 'deployment']],
  ['ausgerollt', ['deploy', 'deployed']],
  ['abnahme', ['acceptance', 'review']],
  ['quelldatei', ['source', 'file']],
  ['datei', ['file']],
  ['dateien', ['file', 'files']],
  ['ordner', ['directory', 'folder']],
  ['pfad', ['path']],
  ['endung', ['extension', 'suffix']],
  ['schluessel', ['key', 'token', 'secret']],
  ['geheimnis', ['secret']],

  // Prüfen
  ['test', ['test']],
  ['tests', ['test', 'tests']],
  ['browsertest', ['e2e', 'playwright', 'test']],
  ['browsertests', ['e2e', 'playwright', 'test']],
  ['pruefung', ['check', 'test', 'validation']],
  ['gegenprobe', ['counter-check', 'verification']],
  ['rauchtest', ['smoke', 'smoketest']],

  // Netz
  ['tunnel', ['tunnel', 'vpn', 'wireguard']],
  ['anfrage', ['request']],
  ['anfragen', ['request', 'requests']],
  ['antwort', ['response']],
  ['erreichbar', ['reachable', 'available']],
  ['abgesichert', ['secured', 'protected']],

  // Betrieb
  ['sicherung', ['backup']],
  ['sicherungen', ['backup', 'backups']],
  ['naechtlich', ['nightly']],
  ['naechtliche', ['nightly']],
  ['aufraeumen', ['cleanup', 'prune']],
  ['neustart', ['restart', 'reboot']],
  ['angehalten', ['stopped', 'halted']],
  ['ueberwachung', ['monitor', 'monitoring']],
  ['warnung', ['warning', 'alert']],
  ['alarm', ['alert']],
];
