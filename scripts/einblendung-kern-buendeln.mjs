#!/usr/bin/env node
/**
 * Buendelt src/einblendung.ts (Einblendung + Sortierkern) nach tools/ambient-recall/einblendung-kern.gen.mjs.
 *
 * ── Warum eine erzeugte Datei und kein zweiter Code ─────────────────────────
 *
 * Der Hook (tools/ambient-recall/) ist bewusst abhaengigkeitsfrei: reines Node,
 * kein Bauschritt, kein node_modules. Die Sortierung, die er braucht, steht
 * aber in TypeScript im SDK — und sie darf es nur EINMAL geben. Am 20.08.2026
 * hat genau diese Doppelung Geld gekostet: der Messstand sortierte mit
 * `bewerteTopf`, der ausgelieferte Pfad mit `mischeRangfolgen`, und wochenlang
 * beschrieben unsere Zahlen eine Maschine, die es nicht gab.
 *
 * Also: eine Quelle (einblendung.ts samt einblendung-kern.ts), ein Erzeugnis (.gen.mjs, eingecheckt),
 * und ein Waechter, der beide vergleicht (src/__tests__/einblendung-kern-abgleich.test.ts).
 *
 * Aufruf:
 *   node scripts/einblendung-kern-buendeln.mjs           schreibt die Datei
 *   node scripts/einblendung-kern-buendeln.mjs --pruefen  meldet Abweichung, schreibt nicht
 *
 * Rueckgabe bei --pruefen: 0 = gleich, 1 = Abweichung (Text auf stderr).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const QUELLE = resolve(HIER, '..', 'src', 'einblendung.ts');
// tools/ liegt im Repo-Wurzelverzeichnis, nicht unter sdk/mcp.
const ZIEL = resolve(HIER, '..', '..', '..', 'tools', 'ambient-recall', 'einblendung-kern.gen.mjs');

const KOPF = `// ERZEUGT — NICHT VON HAND AENDERN.
//
// Quelle: sdk/mcp/src/einblendung.ts (und was sie importiert).
// Erzeugen: cd sdk/mcp && node scripts/einblendung-kern-buendeln.mjs
// Waechter: sdk/mcp/src/__tests__/einblendung-kern-abgleich.test.ts
//
// Diese Datei ist eingecheckt, damit der Hook ohne Bauschritt und ohne
// node_modules laeuft. Wer die Sortierung aendert, aendert die TypeScript-
// Quelle und erzeugt neu — sonst schlaegt der Waechter zu.
`;

export async function erzeuge() {
  const ergebnis = await build({
    entryPoints: [QUELLE],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    // Nicht minifizieren: die Datei liegt im Repo und soll lesbar bleiben,
    // damit ein Unterschied im Waechter als Unterschied erkennbar ist.
    minify: false,
    legalComments: 'none',
    write: false,
  });
  const js = ergebnis.outputFiles[0].text;
  // Zeilenenden festnageln: auf Windows schreibt sonst der eine LF und der
  // naechste CRLF, und der Waechter meldet eine Abweichung, die keine ist.
  return KOPF + js.replace(/\r\n/g, '\n');
}

async function main() {
  const pruefen = process.argv.includes('--pruefen');
  const neu = await erzeuge();
  const alt = existsSync(ZIEL) ? readFileSync(ZIEL, 'utf8').replace(/\r\n/g, '\n') : null;

  if (pruefen) {
    if (alt === neu) {
      process.stdout.write('einblendung-kern.gen.mjs ist auf Stand.\n');
      process.exit(0);
    }
    process.stderr.write(
      'ABWEICHUNG: tools/ambient-recall/einblendung-kern.gen.mjs passt nicht zu '
      + 'sdk/mcp/src/einblendung.ts.\n'
      + `  ${alt === null ? 'Die Datei fehlt.' : `alt ${alt.length} Zeichen, neu ${neu.length} Zeichen.`}\n`
      + '  Beheben: cd sdk/mcp && node scripts/einblendung-kern-buendeln.mjs\n',
    );
    process.exit(1);
  }

  writeFileSync(ZIEL, neu, 'utf8');
  const geaendert = alt !== neu;
  process.stdout.write(
    `${geaendert ? 'geschrieben' : 'unveraendert'}: ${join('tools', 'ambient-recall', 'einblendung-kern.gen.mjs')}`
    + ` (${neu.length} Zeichen)\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(2); });
}
