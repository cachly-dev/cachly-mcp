// Abnahme GROW-013 — der Aha-Moment der ersten Minute.
//
// Warum es diesen Test gibt: der First-Contact-Beweis ("Proof — your first
// recall already works") wird in handlers/fedbrain.ts fuer den TOOL-Pfad
// gebaut — aber der CLI-Pfad, den ein MENSCH in Minute 1 durchlaeuft
// (autopilot/setup), zog aus dem Ergebnis nur match(/(\d+) lesson/) und
// verwarf den Beweis (Befund 12.08.2026, index.ts:3419-3426). Im Seed-Fall
// (leeres git -> Starter-Korpus) lief gar kein Recall. Unverzichtbar wird
// ein Gedaechtnis erst, wenn man es EINMAL hat arbeiten sehen.
//
// Der Test friert drei Zusagen ein:
//   1. Eine reine Funktion findet den Beweis-Block im brain_from_git-Ergebnis
//      — oder gibt ehrlich null zurueck (nie einen erfundenen Beweis drucken).
//   2. Der Seed-Fall rendert seinen Beweis aus einem ECHTEN Recall-Treffer.
//   3. Beide CLI-Startfaelle sind verdrahtet (Nahtstellen-Beweis am Quelltext
//      — Bauform GROW-002/GROW-011: beide Teile einzeln korrekt ist nicht
//      genug, die Naht muss stehen).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractFirstRecallProof,
  renderFirstRecallProof,
} from '../first-recall-proof.js';

const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('GROW-013: der Beweis-Recall erreicht den Menschen', () => {
  it('findet den Beweis-Block im brain_from_git-Ergebnis', () => {
    const bericht = [
      'Brain from Git',
      '  12 lessons extracted from 100 commits',
      '',
      'Proof — your first recall already works:',
      '  deploy:web — "nohup docker compose up -d --build" (learned 2026-08-01)',
      '',
      'Next: keep working. The brain learns ambient.',
    ].join('\n');
    const block = extractFirstRecallProof(bericht);
    expect(block).toBeTruthy();
    expect(block as string).toContain('first recall');
    expect(block as string).toContain('deploy:web');
  });

  it('gibt null zurueck, wenn kein Beweis im Text steckt — es wird nichts erfunden', () => {
    expect(extractFirstRecallProof('  3 lessons extracted')).toBeNull();
    expect(extractFirstRecallProof('')).toBeNull();
  });

  it('rendert den Seed-Beweis aus einem echten Treffer, mit Thema und Inhalt', () => {
    const text = renderFirstRecallProof(
      'docker:layer-cache',
      'Copy package manifests and install deps BEFORE copying the rest',
    );
    expect(text).toContain('docker:layer-cache');
    expect(text).toContain('install deps BEFORE');
    expect(text.toLowerCase()).toContain('first recall');
  });

  it('der CLI-Pfad verwirft den Bericht nicht mehr auf eine blosse Zahl', () => {
    expect(src).not.toMatch(/match\(\/\(\\d\+\) lesson\//);
  });

  it('beide Startfaelle sind verdrahtet: git-Import extrahiert, Seed-Fall rendert', () => {
    expect(src).toMatch(/extractFirstRecallProof\(/);
    expect(src).toMatch(/renderFirstRecallProof\(/);
  });
});
