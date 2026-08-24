#!/usr/bin/env node
/**
 * ══ Das veroeffentlichte Paket schliessen ══════════════════════════════════
 *
 * ── Der Anlass, gemessen am 24.08.2026 ────────────────────────────────────
 *
 * `npm pack --dry-run` zeigte: das Paket `@cachly-dev/mcp-server` liefert
 * 211 Dateien aus, darunter
 *
 *     dist/src/rangfolge.js       9,2 kB   lesbares JavaScript
 *     dist/src/rangfolge.js.map   4,2 kB   Quellkarte
 *     dist/src/rangfolge.d.ts     8,2 kB   vollstaendige Typen
 *
 * Das Repo ist privat, das Paket ist oeffentlich. Jeder konnte die Gewichte
 * der Rangfolge, die Spreizung und den Aufbau der Sortierung lesen — ohne
 * dass wir irgendetwas dafuer bekommen haetten.
 *
 * Das ist die einzige der drei Moeglichkeiten, die nur kostet:
 *
 *   bewusst offen    Beitraege, Vertrauen, Verbreitung — ein Gegenwert
 *   bewusst zu       kein Gegenwert, aber auch nichts verschenkt
 *   versehentlich    kein Gegenwert UND alles verschenkt      <- hier standen wir
 *
 * ── Warum verkleinern und nicht buendeln ─────────────────────────────────
 *
 * Buendeln waere gruendlicher, aber riskant: der Quelltext hat 57 dynamische
 * Importe, 42 davon allein in index.ts. Ein Buendler loest sie zur Bauzeit
 * auf, und ein einziger berechneter Pfad bricht dabei lautlos.
 *
 * Verkleinern JE DATEI laesst die Modulstruktur und alle Importe unveraendert
 * und macht den Inhalt trotzdem unlesbar. Gleiches Ziel, kein Risiko.
 *
 * ── Was ausdruecklich NICHT passiert ─────────────────────────────────────
 *
 * Kein Verschleiern von Namen ueber Modulgrenzen, kein toter Code, keine
 * Fallen. Wer das Paket auspackt, findet gueltiges, lauffaehiges JavaScript —
 * nur eben nicht mehr in Lesefassung. Es geht darum, nichts zu VERSCHENKEN,
 * nicht darum, jemanden auszusperren.
 *
 * Aufruf: node scripts/paket-schliessen.mjs   (laeuft im build nach tsc)
 */

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { transform } from 'esbuild';

const DIST = 'dist';

/** Alle Dateien unter dist, rekursiv. */
function alleDateien(ordner) {
  const aus = [];
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name);
    if (statSync(pfad).isDirectory()) aus.push(...alleDateien(pfad));
    else aus.push(pfad);
  }
  return aus;
}

const dateien = alleDateien(DIST);
let verkleinert = 0;
let vorher = 0;
let nachher = 0;
let geloescht = 0;

for (const pfad of dateien) {
  // Quellkarten und Typdateien haben im veroeffentlichten Paket nichts zu
  // suchen: die Karte fuehrt zurueck zum Aufbau, die Typen zeichnen die
  // ganze Schnittstelle nach. Niemand bindet diesen Server als Bibliothek
  // ein — er wird ueber `bin` gestartet.
  if (pfad.endsWith('.js.map') || pfad.endsWith('.d.ts') || pfad.endsWith('.d.ts.map')) {
    unlinkSync(pfad);
    geloescht++;
    continue;
  }
  if (extname(pfad) !== '.js') continue;

  const quelle = readFileSync(pfad, 'utf8');
  vorher += quelle.length;
  // eslint-disable-next-line no-await-in-loop
  const { code } = await transform(quelle, {
    minify: true,
    // Wichtig: das Format bleibt ESM und die Zielversion bleibt, wie tsc sie
    // erzeugt hat. Verkleinern soll nichts uebersetzen.
    format: 'esm',
    target: 'es2022',
    // Die Zeile `#!/usr/bin/env node` in index.js muss oben stehen bleiben,
    // sonst startet der Server nicht mehr ueber `npx`.
    banner: quelle.startsWith('#!') ? quelle.slice(0, quelle.indexOf('\n')) : undefined,
  });
  const ohneDoppel = quelle.startsWith('#!')
    ? code.replace(/^(#![^\n]*\n)#![^\n]*\n/, '$1')
    : code;
  writeFileSync(pfad, ohneDoppel, 'utf8');
  nachher += ohneDoppel.length;
  verkleinert++;
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(`[paket] ${verkleinert} Dateien verkleinert: ${kb(vorher)} → ${kb(nachher)}`
  + ` (${(100 - (nachher / vorher) * 100).toFixed(0)} % kleiner)`);
console.log(`[paket] ${geloescht} Quellkarten und Typdateien entfernt.`);

// Eine Sicherung gegen den Fall, dass jemand den Schritt aus dem Bau nimmt:
// bleibt eine einzige Quellkarte uebrig, ist das Paket wieder offen.
const rest = alleDateien(DIST).filter((p) => p.endsWith('.map') || p.endsWith('.d.ts'));
if (rest.length > 0) {
  console.error(`[paket] FEHLER: ${rest.length} Quellkarten/Typdateien uebrig — Paket waere offen.`);
  process.exit(1);
}
