#!/usr/bin/env node
// Erzeugt den Bauabdruck: Version, Commit und Baudatum des laufenden Servers.
//
// Warum es das braucht: am 20.08.2026 trugen zwei verschiedene Server-Staende
// dieselbe Versionsnummer 0.10.124 — der installierte dist/ hatte den Code aus
// instances.ts nicht, obwohl package.json dasselbe sagte. Von aussen war das
// nicht zu unterscheiden. Der Bauabdruck macht den Commit sichtbar, nicht nur
// die Versionsnummer — damit laesst sich ein alter Stand von einem aktuellen
// unterscheiden.
//
// Schreibt die Datei zweimal: einmal neben src/ (fuer `tsx src/index.ts` im
// Dev-Betrieb) und einmal neben dist/src/ (fuer den kompilierten, ausgelieferten
// Server). src/bauabdruck.ts liest jeweils aus dem eigenen Verzeichnis.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const paketRoot = resolve(here, '..');
const DATEINAME = 'bauabdruck-daten.generiert.json';

/**
 * Liest den kurzen Commit-Hash. Faellt auf "unbekannt" zurueck, wenn kein
 * .git da ist — z. B. beim Bauen aus einem Tarball ohne Git-Verlauf. Bricht
 * NIE ab, ein fehlender Commit ist kein Grund, den Build zu stoppen.
 */
export function ermittleCommit(cwd = paketRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

/** Liest die Version aus package.json — die eine Quelle, die es schon gibt. */
export function ermittleVersion(cwd = paketRoot) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  return pkg.version;
}

/** Baut die Nutzdaten des Bauabdrucks. Reine Funktion, darum einzeln pruefbar. */
export function baueDaten(cwd = paketRoot, jetzt = new Date()) {
  return {
    version: ermittleVersion(cwd),
    commit: ermittleCommit(cwd),
    gebautAm: jetzt.toISOString(),
  };
}

function schreibeDatei(pfad, daten) {
  mkdirSync(dirname(pfad), { recursive: true });
  // Absichtlich reines "\n": das Repo erzwingt LF per .gitattributes, und
  // JSON.stringify plus ein manuell anghaengtes "\n" schreibt nie ein "\r".
  writeFileSync(pfad, JSON.stringify(daten, null, 2) + '\n', { encoding: 'utf-8' });
}

function schreibeBeide(daten) {
  const srcPfad = join(paketRoot, 'src', DATEINAME);
  schreibeDatei(srcPfad, daten);
  const distSrcVerzeichnis = join(paketRoot, 'dist', 'src');
  if (existsSync(join(paketRoot, 'dist'))) {
    schreibeDatei(join(distSrcVerzeichnis, DATEINAME), daten);
  }
  return srcPfad;
}

// Nur ausfuehren, wenn direkt als Skript gestartet — nicht beim Import in Tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const daten = baueDaten();
  const srcPfad = schreibeBeide(daten);
  console.log(`Bauabdruck geschrieben (${srcPfad}): v${daten.version} · ${daten.commit} · ${daten.gebautAm}`);
}
