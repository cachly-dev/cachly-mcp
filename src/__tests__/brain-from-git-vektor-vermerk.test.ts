/**
 * brain_from_git schreibt Lektionen ohne Vektor — deshalb MUSS jede neu
 * geschriebene Lektion in den Vermerk VEKTOR_NACHTRAG, damit
 * heileVektorNachtrag (brain.ts) Erst- und Zweitvektor nachrechnet.
 *
 * Anlass (12.10.2026): Inventur der Vektorwege. brain_from_git hatte weder
 * Einbettung noch Vermerk; seine Lektionen blieben fuer die Bedeutungssuche
 * unsichtbar und drueckten die Zweitvektor-Deckung unter 80 %, wo das
 * Rangfolge-Merkmal 6 abschaltet.
 *
 * Quelltext-Test statt Lauf: der Fall schreibt Dutzende Redis-Befehle (CKG,
 * Personen, Dateien); eine Attrappe dafuer waere groesser als der Fehler.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VEKTOR_NACHTRAG } from '../bedeutung.js';

const quelle = readFileSync(resolve(__dirname, '..', 'handlers', 'fedbrain.ts'), 'utf8');

describe('brain_from_git vermerkt neue Lektionen fuer den Vektor-Nachtrag', () => {
  it('der Block, der eine neue Lektion schreibt, setzt auch den Vermerk', () => {
    const fall = quelle.slice(quelle.indexOf("case 'brain_from_git'"));
    expect(fall.length).toBeGreaterThan(0);
    const neu = fall.slice(fall.indexOf('if (!existing)'), fall.indexOf('cachly:lessons:brain_from_git:all'));
    expect(neu).toContain('cachly:lesson:best:');
    expect(neu).toMatch(/sadd\(VEKTOR_NACHTRAG,\s*topic\)/);
  });

  it('der Vermerk ist derselbe Schluessel, den heileVektorNachtrag liest', () => {
    expect(VEKTOR_NACHTRAG).toBe('cachly:vek:nachtrag');
    expect(quelle).toMatch(/import \{ VEKTOR_NACHTRAG \} from '\.\.\/bedeutung\.js'/);
  });
});
