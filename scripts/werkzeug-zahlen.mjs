/**
 * Die zwei wahren Werkzeugzahlen — und das Muster, das falsche findet.
 *
 * ── Warum es zwei Zahlen gibt (12.10.2026) ──────────────────────────────────
 *
 * Der Server kennt 124 Werkzeuge (TOOLS in src/tools.ts). Ein Editor sieht
 * davon beim Start aber nur 27 Eintraege: 26 Kernwerkzeuge und den Verteiler
 * `cachly_tool` (src/werkzeug-auswahl.ts). Die uebrigen 98 laufen ueber den
 * Verteiler, aufrufbar bleibt alles.
 *
 * Beide Saetze sind wahr. "124 Werkzeuge" allein las sich auf der Seite wie
 * ein Katalog, den kein Editor je zeigt; "27 Werkzeuge" allein verschweigt
 * 98. Deshalb kennt der Waechter beide Zahlen und laesst jede durch, die aus
 * dem Code stammt. Jede andere Zahl neben "tools" ist ein Fund.
 *
 * Gezaehlt wird hier, nicht getippt: die 124 liest tool-catalog.mjs aus
 * tools.ts, die 27 liest `zaehleKatalogEintraege` aus KERNWERKZEUGE. Eine
 * Probe (src/__tests__/werkzeugzahl-eine-quelle.test.ts) haelt die gelesene
 * Zahl gegen das, was der Server zur Laufzeit wirklich auflistet.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Pfad der Datei, in der die Kernliste und der Verteiler stehen. */
export const AUSWAHL_DATEI = resolve(here, '..', 'src', 'werkzeug-auswahl.ts');

/**
 * Zaehlt die Eintraege, die ein Editor standardmaessig sieht:
 * die Namen in KERNWERKZEUGE plus den Verteiler.
 *
 * Kommentare werden vorher entfernt. In der Liste stehen Erklaerungen mit
 * Anfuehrungszeichen, und ein Zaehler, der sie mitzaehlt, liefert zu viel.
 * Findet die Funktion keinen einzigen Namen, wirft sie: null gelesene Namen
 * sehen von aussen aus wie "alles in Ordnung".
 *
 * @param {string} [quelle] Text von werkzeug-auswahl.ts (Vorgabe: die Datei)
 * @returns {number}
 */
export function zaehleKatalogEintraege(quelle = readFileSync(AUSWAHL_DATEI, 'utf8')) {
  const start = quelle.indexOf('export const KERNWERKZEUGE');
  if (start < 0) throw new Error('KERNWERKZEUGE steht nicht in werkzeug-auswahl.ts');
  const ende = quelle.indexOf('];', start);
  if (ende < 0) throw new Error('Das Ende von KERNWERKZEUGE wurde nicht gefunden');

  const block = quelle
    .slice(start, ende)
    .split('\n')
    .map((zeile) => zeile.replace(/\/\/.*$/, ''))
    .join('\n');
  const namen = block.match(/'[a-z_]+'/g) ?? [];
  if (namen.length === 0) throw new Error('In KERNWERKZEUGE wurde kein Name gelesen');
  if (!/export const VERTEILER\s*=\s*'cachly_tool'/.test(quelle)) {
    throw new Error('VERTEILER steht nicht mehr als cachly_tool in werkzeug-auswahl.ts');
  }
  return namen.length + 1; // + Verteiler
}

/**
 * Die Zahl neben "tools" in all ihren Schreibweisen.
 *
 * Eine Liste ALTER Zahlen waere von Hand gepflegt und damit selbst eine zweite
 * Wahrheit. Genau daran ist die Pruefung am 14.08.2026 gescheitert: 126 stand
 * nicht in der Liste, und deshalb trug sdk/mcp/README.md an zwei Stellen "126"
 * weiter, waehrend das Produkt 122 Werkzeuge hatte — sichtbar fuer jeden, der
 * das Paket auf npm aufmachte. Die Pruefung war gruen. Zwei Luecken zugleich:
 * die Liste kannte 126 nicht, UND die Schreibweisen "126_MCP_tools" (Badge-URL)
 * und "(126 total)" (Ueberschrift) trafen ohnehin keinen der Ausdruecke.
 *
 * Deshalb dreht die Pruefung die Frage um. Sie sucht nicht bekannte falsche
 * Zahlen, sondern JEDE Zahl, die neben "tools" oder "total" steht, und laesst
 * nur die durch, die aus dem Code stammt.
 */
export const ZAHL_BEI_WERKZEUGEN = [
  // "126 MCP tools", "126 tools", "126_MCP_tools" (Badge-URL, Unterstriche)
  /\b(\d{2,4})[\s_-]+(?:MCP[\s_-]+)?tools?\b/gi,
  // "126-tool MCP server"
  /\b(\d{2,4})-tool\s+MCP\s+server\b/gi,
  // "MCP Tools (126 total)" und "MCP Tools (126 total, 27 in the default catalogue)"
  /\btools?\s*\((\d{2,4})\s+total\b/gi,
  // "126 native MCP tools", "126 AI Brain tools"
  /\b(\d{2,4})[\s_-]+(?:(?:native|AI|Brain)[\s_-]+)+(?:MCP[\s_-]+)?tools?\b/gi,
  // "124-Tool", "124 MCP-Tools", "124 Werkzeuge" (deutsche Texte)
  /\b(\d{2,4})[\s-]+(?:MCP-)?(?:Tools?|Werkzeuge?)\b/g,
  // "Tool-count aligned to 140", "tool count: 140"
  /\btool[- ]count\b[^|\n\d]{0,25}(\d{2,4})\b/gi,
];

/**
 * Findet Zahlen neben "tools", die keine der erlaubten sind.
 *
 * @param {string} text
 * @param {number | Iterable<number>} erlaubt die wahren Zahlen (124 und 27)
 * @returns {string[]} die Fundstellen, ohne Doppelte
 */
export function falscheWerkzeugZahlen(text, erlaubt) {
  const wahr = new Set(typeof erlaubt === 'number' ? [erlaubt] : erlaubt);
  const treffer = [];
  for (const muster of ZAHL_BEI_WERKZEUGEN) {
    muster.lastIndex = 0;
    let m;
    while ((m = muster.exec(text)) !== null) {
      if (!wahr.has(Number(m[1]))) treffer.push(m[0].trim());
    }
  }
  return [...new Set(treffer)];
}
