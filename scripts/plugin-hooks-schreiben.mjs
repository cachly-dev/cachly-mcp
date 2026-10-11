#!/usr/bin/env node
/**
 * Schreibt die Hook-Dateien nach sdk/mcp/hooks/:
 *
 *   hooks/cachly-ambient-einblendung.mjs   das Hook-Buendel (esbuild, eine Datei)
 *   hooks/hooks.json                       die Hooks des Claude-Code-Plugins
 *
 * ── Warum ein Buendel (11.10.2026) ──────────────────────────────────────────
 *
 * Bis heute startete jeder Hook `npx @cachly-dev/mcp-server@latest
 * ambient-recall`. Gemessen: 7,7 s je Prompt warm, 17,1 s kalt, bei einer
 * Grenze von 10 s. Das Buendel ist eine Datei ohne node_modules; das Plugin
 * ruft es direkt mit `node`, die Projekt-Hooks (installAmbientHooks) kopieren
 * es nach .claude/hooks/ und laden es dort.
 *
 * Eine Quelle, ein Erzeugnis, ein Waechter — wie bei
 * scripts/einblendung-kern-buendeln.mjs:
 *   Quelle:   src/ambient-hook-start.ts (und was es importiert),
 *             src/ambient-hooks.ts (buildPluginHooksJson)
 *   Waechter: src/__tests__/plugin-hooks.test.ts
 *
 * Der Spiegel cachly-dev/cachly-mcp nimmt sdk/mcp/hooks/ mit; dort liegt es
 * an der Plugin-Wurzel, wo Claude Code `hooks/hooks.json` von selbst laedt.
 * Ins npm-Paket kommt das Buendel ueber `files` in package.json.
 *
 * Aufruf (aus sdk/mcp):
 *   npm run plugin-hooks:write              schreibt die Dateien
 *   npm run plugin-hooks:write -- --pruefen meldet Abweichung, schreibt nicht
 */

import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginHooksJson, HOOK_BUENDEL, PLUGIN_HOOK_DIR } from '../src/ambient-hooks.ts';

const WURZEL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EINSTIEG = join(WURZEL, 'src', 'ambient-hook-start.ts');

const KOPF = `#!/usr/bin/env node
// ERZEUGT — NICHT VON HAND AENDERN.
// cachly Hook-Buendel: Einblendung, Sitzungs-Briefing, Schreibbeleg. Ohne npx, ohne node_modules.
// Quelle: sdk/mcp/src/ambient-hook-start.ts. Erzeugen: cd sdk/mcp && npm run plugin-hooks:write
// Aufruf: node cachly-ambient-einblendung.mjs <SessionStart|UserPromptSubmit|PreToolUse|Stop> [--plugin]`;

/** Das Buendel als Text. */
export async function erzeugeBuendel() {
  const ergebnis = await build({
    entryPoints: [EINSTIEG],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // Verkleinert wie das npm-Paket (scripts/paket-schliessen.mjs): weniger
    // Bytes zu lesen bei jedem Start, und die Gewichte der Rangfolge liegen
    // nicht in Lesefassung im Paket.
    minify: true,
    legalComments: 'none',
    banner: { js: KOPF },
    write: false,
  });
  // Zeilenenden festnageln: sonst meldet der Waechter auf Windows eine Abweichung, die keine ist.
  return ergebnis.outputFiles[0].text.replace(/\r\n/g, '\n');
}

/** Alle Dateien unter hooks/, nach Pfad relativ zu sdk/mcp. */
export async function erzeugeDateien() {
  return {
    [`${PLUGIN_HOOK_DIR}/${HOOK_BUENDEL}`]: await erzeugeBuendel(),
    [`${PLUGIN_HOOK_DIR}/hooks.json`]: buildPluginHooksJson(),
  };
}

async function main() {
  const soll = await erzeugeDateien();
  const ordner = join(WURZEL, PLUGIN_HOOK_DIR);
  const vorhanden = existsSync(ordner) ? readdirSync(ordner).map((n) => `${PLUGIN_HOOK_DIR}/${n}`) : [];
  const ueberzaehlig = vorhanden.filter((p) => !(p in soll));
  const abweichend = Object.entries(soll)
    .filter(([pfad, inhalt]) => {
      const ziel = join(WURZEL, pfad);
      return !existsSync(ziel) || readFileSync(ziel, 'utf8') !== inhalt;
    })
    .map(([pfad]) => pfad);

  if (process.argv.includes('--pruefen')) {
    if (abweichend.length === 0 && ueberzaehlig.length === 0) {
      process.stdout.write(`${PLUGIN_HOOK_DIR}/ ist auf Stand (${Object.keys(soll).length} Dateien).\n`);
      process.exit(0);
    }
    process.stderr.write(
      `ABWEICHUNG in sdk/mcp/${PLUGIN_HOOK_DIR}/ gegenueber der Quelle:\n`
      + abweichend.map((p) => `  veraltet oder fehlt: ${p}\n`).join('')
      + ueberzaehlig.map((p) => `  nicht erzeugt:       ${p}\n`).join('')
      + '  Beheben: cd sdk/mcp && npm run plugin-hooks:write\n',
    );
    process.exit(1);
  }

  mkdirSync(ordner, { recursive: true });
  for (const [pfad, inhalt] of Object.entries(soll)) writeFileSync(join(WURZEL, pfad), inhalt, 'utf8');
  const buendel = soll[`${PLUGIN_HOOK_DIR}/${HOOK_BUENDEL}`];
  process.stdout.write(
    `${PLUGIN_HOOK_DIR}/: ${abweichend.length} geschrieben, ${Object.keys(soll).length - abweichend.length} unveraendert.`
    + ` Buendel: ${(Buffer.byteLength(buendel) / 1024).toFixed(0)} KB.\n`,
  );
  // Nicht loeschen, nur melden: eine fremde Datei dort ist eine Frage, keine Muellabfuhr.
  if (ueberzaehlig.length) {
    process.stderr.write(`Nicht aus der Quelle erzeugt (der Waechter schlaegt an): ${ueberzaehlig.join(', ')}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(2); });
}
