// Entscheidungs-Gedaechtnis — "du hast dich bewusst GEGEN X entschieden".
//
// ── Warum (WOW #2, Karte a3d59bbfcf52) ─────────────────────────────────────
//
// Fuenf aehnliche Lektionen sind Erinnerung. "Du hast dich am 12.08. bewusst
// GEGEN GraphQL entschieden — Grund war die zweite Wahrheit an 123
// Werkzeugen. Willst du das wirklich aufweichen?" ist ein Kollege, der dabei
// war. Der Unterschied ist kein neues Feld im Werkzeug (der Katalog steht
// 12 Bytes unter seinem Deckel), sondern eine ABGELEITETE Tatsache beim
// Schreiben — dieselbe Bauform wie die Zeitdatierung (#522) und die
// Zaehl-Untergrenzen (#550): ableiten, wo der Text es hergibt, nie raten.
//
// ── Absichtlich eng (die Schule des Ersetzungs-Vorschlags) ─────────────────
//
// Erkannt wird nur, was sich WOERTLICH als Entscheidung ausweist
// ("entschieden gegen X, weil Y", "bewusst gegen X", "decided against X").
// Ein "gegen 18 Uhr" oder ein "dagegen hilft nur neu starten" darf NIE zur
// Entscheidung werden — eine falsche Entscheidungs-Zeile im Recall wuerde
// kuenftige Arbeit mit erfundener Autoritaet blockieren. Lieber zehn echte
// Entscheidungen verpassen als eine erfinden.

export interface Entscheidung {
  gegen: string;
  grund: string | null;
}

const MUSTER: RegExp[] = [
  // "entschieden gegen X[, weil|da|— Grund: Y]" / "bewusst gegen X entschieden ..."
  /(?:bewusst|ausdruecklich|explizit)?\s*(?:haben wir uns|wir haben uns|ich habe mich|hat sich)?\s*entschieden gegen\s+([^,.;—\n]{3,80})(?:\s*[,—]\s*(?:weil|da|grund:?)\s+([^.;\n]{3,200}))?/i,
  /(?:bewusst|ausdruecklich|explizit)\s+gegen\s+([^,.;—\n]{3,80}?)\s+entschieden(?:\s*[,—]\s*(?:weil|da|grund:?)\s+([^.;\n]{3,200}))?/i,
  // Erst die Form MIT Grund (sonst frisst der gierige Gegenstand das
  // "because ..." bis zur Laengengrenze mit), dann die ohne.
  /decided against\s+(.{3,80}?)\s+because\s+([^.;\n]{3,200})/i,
  /decided against\s+([^,.;\n]{3,80})/i,
];

/**
 * Die eine erkannte Entscheidung — oder null. Bei mehreren Treffern gewinnt
 * der erste; eine Lektion traegt EINE Entscheidung, keine Liste (wer zwei
 * getroffen hat, schreibt zwei Lektionen).
 */
export function leiteEntscheidungAb(text: string): Entscheidung | null {
  for (const m of MUSTER) {
    const t = m.exec(text);
    if (!t) continue;
    const gegen = t[1].trim().replace(/\s+/g, ' ');
    // "gegen 18 Uhr", "gegen Mittag": Zeitangaben sind keine Entscheidungen.
    if (/^\d|^(mittag|abend|morgen|ende|anfang)\b/i.test(gegen)) continue;
    return { gegen, grund: t[2] ? t[2].trim().replace(/\s+/g, ' ') : null };
  }
  return null;
}

/** Die Zeile, die der Recall zeigt — an EINEM Ort, fuer beide Ansichten. */
export function entscheidungsZeile(e: Entscheidung): string {
  return `⚖️ **Bewusst entschieden GEGEN ${e.gegen}**${e.grund ? ` — Grund: ${e.grund}` : ''}. Nicht ohne NEUEN Grund aufweichen.`;
}
