/**
 * Der CLI-Dump ueberlebt das stdin-Ende.
 *
 * Beleg 31.08.2026: Der stdin-Ende-Abgang aus Karte xm54lkjujmyi (#561)
 * exitete WAEHREND `tool-specs` seinen Katalog auf stdout flushte — die
 * CLI-Befehle laufen mit stdin=EOF, und der Modulfluss erreicht den
 * Serve-Zweig parallel zum Dump. Ergebnis: abgeschnittenes JSON, der
 * Drift-Guard fiel auf main fuer JEDEN PR ("Expected property name or
 * '}' at position 291823").
 *
 * Dieses Tor rendert den Dump als echten Kindprozess (wie
 * tool-spec-snapshots.mjs) und verlangt parsebares JSON.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const paketWurzel = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('tool-specs als Kindprozess mit stdin=EOF', () => {
  it('liefert VOLLSTAENDIGES JSON — kein Abgang mitten im Flush', () => {
    const roh = execFileSync(
      process.execPath,
      ['--import', 'tsx', join('src', 'index.ts'), 'tool-specs', '--format=openapi'],
      { cwd: paketWurzel, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 },
    );
    const geparst = JSON.parse(roh) as Record<string, unknown>;
    expect(Object.keys(geparst).length).toBeGreaterThan(0);
    // Ein abgeschnittener Dump ist deutlich kleiner — die Flaeche sichert,
    // dass nicht ein leeres-aber-gueltiges Objekt durchrutscht.
    expect(roh.length).toBeGreaterThan(100_000);
  }, 180_000);
});
