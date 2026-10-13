import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/*
 * Waechter: Jeder Test, der das Hook-Buendel als Kindprozess startet, schaltet
 * das Lernen aus (CACHLY_LERNEN=0).
 *
 * Warum (13.10.2026): vitest.config.ts setzt CACHLY_LERNEN=0 nur fuer den
 * Testprozess. Tests, die dem Kind eine frisch gebaute Umgebung geben (um kein
 * echtes CACHLY_JWT durchzureichen), erben ihn nicht. Dann entscheidet das
 * Lernen (src/lernen.ts) per Hash aus Instanz, Sitzung und Prompt — bei
 * zufaelliger Instanz faellt der Prompt in 5,2 % der Laeufe in die
 * Kontrollgruppe und die Ausgabe bleibt leer. So wurden
 * verdacht-nicht-einblenden.test.ts und erster-prompt.test.ts jeder 20. Lauf
 * rot (beide entstanden parallel zu #769 und kannten den Schalter nicht).
 */

const SRC = resolve(__dirname, '..');
const BUENDEL_HINWEIS = /HOOK_BUENDEL|BUENDEL\b|cachly-ambient-einblendung/;
const KINDPROZESS = /\bspawn(Sync)?\(|\bexecFile(Sync)?\(/;

function testDateien(ordner: string): string[] {
  const aus: string[] = [];
  for (const e of readdirSync(ordner, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(ordner, e.name);
    if (e.isDirectory()) aus.push(...testDateien(p));
    else if (e.name.endsWith('.test.ts')) aus.push(p);
  }
  return aus;
}

describe('Hook-Buendel als Kindprozess: Lernen aus', () => {
  const betroffen = testDateien(SRC).filter((f) => {
    const t = readFileSync(f, 'utf8');
    return BUENDEL_HINWEIS.test(t) && KINDPROZESS.test(t);
  });

  it('findet die Tests, die das Buendel starten (sonst prueft er nichts)', () => {
    // Stand 13.10.: cursor-hook, editor-hooks, erster-prompt, plugin-hooks, verdacht-nicht-einblenden.
    expect(betroffen.length).toBeGreaterThanOrEqual(5);
  });

  it('jeder davon setzt CACHLY_LERNEN', () => {
    const ohne = betroffen
      .filter((f) => !readFileSync(f, 'utf8').includes('CACHLY_LERNEN'))
      .map((f) => relative(SRC, f));
    expect(ohne, 'diesen Tests fehlt CACHLY_LERNEN: "0" in der Umgebung des Kindprozesses').toEqual([]);
  });
});
