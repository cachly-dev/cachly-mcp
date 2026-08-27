/**
 * Zieht die Versionsnummer aus package.json in alle Manifeste nach.
 *
 * ── Der Vorfall ─────────────────────────────────────────────────────────────
 *
 * Am 20.08.2026 wurde die Nummer von 0.10.124 auf 0.10.125 gehoben. Der Merge
 * lief durch, alle Pruefungen waren gruen — und die Veroeffentlichung fiel
 * danach zweimal hintereinander um:
 *
 *   Version drift — package.json=0.10.125 but server.json=0.10.124
 *   Version drift — package.json=0.10.125 but server.json.packages[0]=0.10.124
 *   Version drift — package.json=0.10.125 but glama.json=0.10.124
 *   Version drift — package.json=0.10.125 but smithery.yaml=0.10.124
 *
 * Die Nummer stand an FUENF Stellen. Ein Sprung traf eine davon.
 *
 * Wirkung: die neue Fassung liegt nicht auf npm. Wer den Server installiert,
 * bekommt weiter den alten Stand — genau der Zustand, gegen den die ganze
 * Reihe #422 bis #425 angetreten ist. Der Waechter hat richtig Nein gesagt;
 * gemerkt hat es nur niemand, weil die Veroeffentlichung NACH dem Merge
 * laeuft und keinen PR mehr rot faerbt.
 *
 * ── Warum Nachziehen und nicht Ableiten ─────────────────────────────────────
 *
 * Am liebsten haette man die vier Manifeste die Nummer aus package.json lesen
 * lassen. Das geht nicht: server.json liest die MCP-Registry, glama.json liest
 * Glama, smithery.yaml liest Smithery — alle drei fremd, alle drei erwarten
 * eine feste Zahl in der Datei.
 *
 * Also bleibt Nachziehen. Der Unterschied zu "beide sorgfaeltig pflegen" ist,
 * dass es EIN Handgriff ist und automatisch am npm-Haken `version` haengt:
 * `npm version patch` erledigt es, ohne dass jemand die fuenf Stellen kennen
 * muss.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const MCP = join(HIER, '..');

/** Wo die Nummer ueberall steht. Kommt eine Stelle dazu, kommt sie HIER dazu. */
export const STELLEN = [
  'server.json',
  'glama.json',
  'smithery.yaml',
  // Das Claude-Code-Plugin (28.08.2026). Es wird mit sdk/mcp nach
  // cachly-dev/cachly-mcp gespiegelt und ist dort das erste, was ein
  // Fremder sieht. Seine Nummer IST die des Servers — eine eigene waere
  // eine weitere Stelle, die von Hand steigen muesste.
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];

/**
 * Ersetzt die Nummer in einem JSON-Text, ohne ihn neu zu formatieren.
 *
 * Bewusst kein `JSON.parse` + `JSON.stringify`: das wuerde Einrueckung und
 * Schluesselreihenfolge nach eigenem Gutduenken neu schreiben und jeden
 * Unterschied unlesbar machen. Gesucht wird genau das Feld "version".
 */
export function ersetzeInJson(text, neu) {
  return text.replace(/("version"\s*:\s*)"[^"]*"/g, `$1"${neu}"`);
}

/** Dasselbe fuer YAML: eine Zeile, die mit `version:` beginnt. */
export function ersetzeInYaml(text, neu) {
  return text.replace(/^(version:\s*).*$/m, `$1${neu}`);
}

/** Wie viele Stellen traegt diese Datei? Fuer die Meldung, und als Probe. */
export function zaehleStellen(text, datei) {
  const treffer = datei.endsWith('.yaml')
    ? text.match(/^version:\s*\S+/m)
    : text.match(/"version"\s*:\s*"[^"]*"/g);
  return treffer ? treffer.length : 0;
}

export function ziehNach(text, datei, neu) {
  return datei.endsWith('.yaml') ? ersetzeInYaml(text, neu) : ersetzeInJson(text, neu);
}

const direktGestartet = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (direktGestartet) {
  const neu = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8')).version;
  let geaendert = 0;

  for (const datei of STELLEN) {
    const pfad = join(MCP, datei);
    const alt = readFileSync(pfad, 'utf8');
    const stellen = zaehleStellen(alt, datei);

    // Eine Datei ohne Versionsfeld ist entweder umbenannt oder umgebaut
    // worden. Still darueber hinwegzugehen waere derselbe Fehler noch einmal:
    // die Veroeffentlichung faellt dann spaeter und ohne Zusammenhang.
    if (stellen === 0) {
      console.error(`nummer-nachziehen: ${datei} hat kein Versionsfeld — Abbruch.`);
      process.exit(1);
    }

    const text = ziehNach(alt, datei, neu);
    if (text !== alt) {
      // Zeilenenden bleiben LF: dieses Repo erzwingt sie ueber .gitattributes,
      // und geschriebene Dateien haben sich hier schon einmal still auf CRLF
      // gedreht.
      writeFileSync(pfad, text, { encoding: 'utf8' });
      geaendert++;
      console.log(`  ${datei}: ${stellen} Stelle(n) auf ${neu}`);
    }
  }

  console.log(geaendert === 0
    ? `nummer-nachziehen: alle Manifeste stehen bereits auf ${neu}.`
    : `nummer-nachziehen: ${geaendert} Datei(en) auf ${neu} gezogen.`);
}
