/**
 * ══ Schablonentext aus geernteten Lektionen streichen ═════════════════════
 *
 * ── Der Befund (30.08.2026, Karte ee7pmtjujucs) ───────────────────────────
 *
 * Beim ersten Bau der Starterpakete fielen sie sofort auf: **150 von 2000
 * Lektionen (8 %) beginnen mit PR-Schablone statt mit Wissen.**
 *
 *   „Fixes: #4460 Pull Request Checklist Open your pull request against the
 *    master branch. All tests pass in available CI pipelines …"
 *
 * Das ist kein Wissen, das man einem Kunden ins Gedächtnis legt. Und es ist
 * schlimmer als nutzlos: der Text ist in TAUSENDEN Projekten fast identisch,
 * also trifft er jede Suche ein bisschen und keine richtig.
 *
 * ── Warum streichen und nicht verwerfen ───────────────────────────────────
 *
 * Ein PR-Text besteht oft aus Schablone PLUS echtem Inhalt. Wer die ganze
 * Lektion verwirft, wirft den Inhalt mit weg. Gestrichen wird deshalb
 * ZEILENWEISE, und was übrig bleibt, entscheidet über Behalten oder
 * Verwerfen.
 *
 * ── Die Kosten sind gemessen ──────────────────────────────────────────────
 *
 * Die Karte trägt sie im Titel: das Streichen der Vorlagen-Pfade kostete
 * 2,1 Punkte. Das ist der ehrliche Preis, und er steht hier, damit niemand
 * die Maßnahme für umsonst hält.
 *
 * Was sie einbringt, ist nicht in Punkten gemessen, sondern im Vertrauen:
 * eine Lektion, die mit „Pull Request Checklist" anfängt, macht das ganze
 * Paket unglaubwürdig — auch die 92 %, die gut sind.
 */

/**
 * Zeilen, die zu einer PR-Schablone gehören und kein Wissen tragen.
 *
 * Ausgeschrieben statt in einem Sammelmuster, damit man streiten kann. Wer
 * eine Zeile hinzufügt, sollte ein Beispiel danebenlegen können.
 */
const SCHABLONENZEILE = [
  /^\s*#{1,4}\s*(checklist|type of change|motivation|description|how has this been tested)/i,
  /pull request checklist/i,
  /open your pull request against/i,
  /all tests pass in available ci/i,
  /please read the contributing/i,
  /^\s*-?\s*\[[ x]\]\s/i,              // Ankreuzkästchen
  /^\s*signed-off-by:/i,
  /^\s*co-authored-by:/i,
  /i have read the (contributing|code of conduct)/i,
  /^\s*<!--[\s\S]*-->\s*$/,            // reiner HTML-Kommentar
  /^\s*(closes|fixes|resolves)\s*:?\s*#\d+\s*$/i, // nur der Verweis, sonst nichts
];

/**
 * Schablonenreste MITTEN im Text.
 *
 * ── Warum es diesen zweiten Durchgang gibt (30.08.2026) ───────────────────
 *
 * Der erste Durchgang arbeitet zeilenweise und drückte den Anteil von 8 %
 * auf 5 %. Die übrigen 97 Fälle standen nicht am Zeilenanfang: die Ernte
 * ebnet Zeilenumbrüche ein, und aus
 *
 *     ## Type of change
 *     Bug fix
 *     ## Description
 *     Fixed several bugs in …
 *
 * wird „Type of change Bug fix Description Fixed several bugs in …" — ein
 * einziger Fließtext, in dem kein Muster mehr am Zeilenanfang steht.
 *
 * Diese Muster greifen deshalb überall. Sie sind ENG gefasst und schneiden
 * jeweils genau so viel weg, wie zur Schablone gehört — ein zu breites
 * Muster würde echten Inhalt mitnehmen, und das wäre schlimmer als der Rest
 * Schablone.
 */
const SCHABLONE_INLINE: Array<[RegExp, string]> = [
  // Unterschriftszeilen samt Name und Adresse, bis zum nächsten Satzanfang.
  [/\b(Signed-off-by|Co-authored-by):\s*[^\n]{0,80}?<?[\w.+-]+@[\w.-]+>?/gi, ' '],
  // Zusammengefallene Vorlagen-Ueberschriften.
  [/\bType of change\b\s*(Bug fix|Feature|Breaking change|Documentation)?/gi, ' '],
  [/\bHow has this been tested\b\??/gi, ' '],
  [/\bPull Request Checklist\b/gi, ' '],
  [/\bOpen your pull request against[^.]{0,60}\.?/gi, ' '],
  [/\bAll tests pass in available CI pipelines\.?/gi, ' '],
  [/\bPlease read the CONTRIBUTING[^.]{0,40}\.?/gi, ' '],
];

/** Mindestens so viele Zeichen müssen übrig bleiben. */
export const MIN_REST = 60;

/**
 * Streicht Schablonenzeilen und gibt zurück, was übrig bleibt.
 *
 * Der zweite Rückgabewert ist die Zahl gestrichener Zeilen — ohne sie wäre
 * „gestrichen" eine Behauptung, und niemand könnte prüfen, ob zu viel
 * verschwand.
 */
export function streicheSchablone(text: string): { rest: string; gestrichen: number } {
  const zeilen = String(text ?? '').split(/\r?\n/);
  const behalten: string[] = [];
  let gestrichen = 0;
  for (const z of zeilen) {
    if (SCHABLONENZEILE.some((r) => r.test(z))) { gestrichen++; continue; }
    behalten.push(z);
  }

  // Zweiter Durchgang: Reste MITTEN im Text, wo die Ernte die Umbrueche
  // eingeebnet hat. Jeder Treffer zaehlt wie eine gestrichene Zeile.
  let rest = behalten.join('\n');
  for (const [muster, ersatz] of SCHABLONE_INLINE) {
    const vorher = rest;
    rest = rest.replace(muster, ersatz);
    if (rest !== vorher) gestrichen++;
  }

  return {
    rest: rest.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim(),
    gestrichen,
  };
}

/**
 * Taugt die Lektion nach dem Streichen noch?
 *
 * Gibt den Grund zurück, nicht nur ein Nein — erst der gelesene Wert, dann
 * das Urteil. Wer nur „verworfen" liest, kann die Regel nicht prüfen.
 */
export function nachDemStreichen(text: string): { rest: string } | { verworfen: string } {
  const { rest, gestrichen } = streicheSchablone(text);
  if (rest.length < MIN_REST) {
    return {
      verworfen: `nach ${gestrichen} gestrichenen Schablonenzeilen bleiben nur ${rest.length} Zeichen (mindestens ${MIN_REST})`,
    };
  }
  return { rest };
}
