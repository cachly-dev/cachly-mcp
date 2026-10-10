import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitArt, extractDomain, istRueckbau, zaehleLektionen } from '../commit-art.js';

/**
 * Die Einteilung, mit der brain_from_git Lektionen anlegt und `demo` sie
 * ankuendigt. Dieselben Faelle prueft web/lib/__tests__/repo-roentgen-gleich-mcp.test.ts
 * gegen die Abschrift der Webseite — beide lesen commit-art-faelle.json.
 */
const faelle = (
  JSON.parse(readFileSync(resolve(__dirname, 'commit-art-faelle.json'), 'utf8')) as {
    faelle: { betreff: string; art: string }[];
  }
).faelle;

describe('commitArt — gemeinsame Faelle', () => {
  it('hat genug Faelle, um die Reihenfolge der Regeln zu sehen', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(20);
  });
  for (const f of faelle) {
    it(`${f.betreff} -> ${f.art}`, () => {
      expect(commitArt(f.betreff)).toBe(f.art);
    });
  }
});

describe('Zaehlung wie brain_from_git', () => {
  it('gleiches Thema zaehlt einmal, leere Betreffzeilen gar nicht', () => {
    expect(
      zaehleLektionen(['fix: login loop again', 'fix: login loop again', '', 'feat: export csv']),
    ).toBe(2);
  });
  it('Thema = die ersten drei Woerter mit mehr als drei Zeichen', () => {
    expect(extractDomain('fix(auth): token refresh loop')).toBe('auth-token-refresh');
    expect(extractDomain('a b c')).toBe('general');
  });
});

describe('Rueckbau', () => {
  it('erkennt git-revert-Betreffzeilen', () => {
    expect(istRueckbau('Revert "feat: add dark mode"')).toBe(true);
    expect(istRueckbau('revert: undo cache change')).toBe(true);
    expect(istRueckbau('fix: do not revert on error')).toBe(false);
  });
});
