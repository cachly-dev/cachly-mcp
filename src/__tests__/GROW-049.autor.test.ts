import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COAUTHOR_PREF_KEY,
  autorHinweis,
  coautorAus,
  ermittleAutor,
  mitCoautor,
  normalisiere,
  nurMensch,
  type GitLeser,
} from '../autor.js';

/**
 * ABNAHME GROW-049 — der Autor wird hergeleitet, nicht erwartet.
 *
 * GEMESSEN 19.08.2026: 195 von 493 Lektionen ohne Autor, zwei Fuenftel.
 *
 * Heinrich dazu: "das mit dem Autor war doch eher ein Fehler von uns bzw. wie
 * cachly die Anweisungen fuer das Brain geschrieben hat, denn der Autor steht
 * doch in den Git-Zugangsdaten." Genau so ist es — der Code holte den Namen
 * sogar schon, aber an einer anderen Stelle und nie fuer die Lektion.
 *
 * Abnahme:
 *   1. Ohne uebergebenen Autor kommt der Name aus git.
 *   2. Ein uebergebener Name gewinnt immer.
 *   3. Anonym bleiben geht ausdruecklich — und nur ausdruecklich.
 *   4. Der Mitautor ist standardmaessig AUS.
 *   5. Kein erfundener Name: ohne jede Quelle bleibt das Feld leer.
 */

const gitMit = (werte: Record<string, string>): GitLeser => (k) => werte[k] ?? '';
const gitLeer: GitLeser = () => '';
const roh = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('GROW-049 - Abnahme 1: der Name kommt aus git', () => {
  it('nimmt git config user.name', () => {
    const h = ermittleAutor({ git: gitMit({ 'user.name': 'Heinrich Neb' }) });
    expect(h).toEqual({ autor: 'heinrich', quelle: 'git-name' });
  });

  it('faellt auf die Mail-Adresse zurueck, wenn kein Name gesetzt ist', () => {
    const h = ermittleAutor({ git: gitMit({ 'user.email': 'marc@kanzlei.de' }) });
    expect(h).toEqual({ autor: 'marc', quelle: 'git-mail' });
  });

  it('nimmt CACHLY_AUTHOR vor git - fuer die CI', () => {
    const h = ermittleAutor({ umgebung: 'buildbot', git: gitMit({ 'user.name': 'Heinrich' }) });
    expect(h).toEqual({ autor: 'buildbot', quelle: 'umgebung' });
  });
});

describe('GROW-049 - Abnahme 2: ein uebergebener Name gewinnt', () => {
  it('schlaegt Umgebung und git', () => {
    const h = ermittleAutor({
      uebergeben: 'Marc',
      umgebung: 'buildbot',
      git: gitMit({ 'user.name': 'Heinrich' }),
    });
    expect(h).toEqual({ autor: 'marc', quelle: 'uebergeben' });
  });
});

describe('GROW-049 - Abnahme 3: anonym nur ausdruecklich', () => {
  it('ein Bindestrich bedeutet ohne Namen, ohne Nachfrage bei git', () => {
    let gefragt = 0;
    const git: GitLeser = () => { gefragt++; return 'Heinrich'; };
    const h = ermittleAutor({ uebergeben: '-', git });
    expect(h).toEqual({ autor: '', quelle: 'anonym' });
    expect(gefragt, 'anonym darf git gar nicht erst fragen').toBe(0);
  });

  it('und bekommt keine Belehrung', () => {
    expect(autorHinweis({ autor: '', quelle: 'anonym' })).toBeNull();
  });

  /**
   * GEGENPROBE - der wichtigste Fall dieser Abnahme.
   *
   * Wenn WEGLASSEN weiterhin wie ein Bindestrich wirkte, waere nichts
   * gewonnen: genau so sind die 195 autorlosen Lektionen entstanden. Das Feld
   * einfach nicht zu senden MUSS jetzt einen Namen ergeben.
   */
  it('Gegenprobe: WEGLASSEN ist nicht dasselbe wie anonym', () => {
    const weggelassen = ermittleAutor({ git: gitMit({ 'user.name': 'Heinrich' }) });
    const ausdruecklich = ermittleAutor({ uebergeben: '-', git: gitMit({ 'user.name': 'Heinrich' }) });
    expect(weggelassen.autor).toBe('heinrich');
    expect(ausdruecklich.autor).toBe('');
    expect(weggelassen.autor).not.toBe(ausdruecklich.autor);
  });
});

describe('GROW-049 - Abnahme 4: der Mitautor ist aus', () => {
  it('ohne Einstellung kein Mitautor', () => {
    expect(coautorAus(null)).toBe('');
    expect(coautorAus(undefined)).toBe('');
    expect(coautorAus('')).toBe('');
  });

  it('ausdrueckliches Abschalten wird verstanden', () => {
    for (const w of ['off', 'false', '0', 'none', '  OFF  ']) {
      expect(coautorAus(w), w).toBe('');
    }
  });

  it('eingeschaltet steht der Mensch VORN', () => {
    expect(mitCoautor('heinrich', coautorAus('claude'))).toBe('heinrich+claude');
    expect(nurMensch('heinrich+claude')).toBe('heinrich');
  });

  it('ohne Menschen kein Eintrag - ein Mitautor allein ist kein Autor', () => {
    expect(mitCoautor('', 'claude')).toBe('');
  });

  it('derselbe Name doppelt ergibt keinen Doppeleintrag', () => {
    expect(mitCoautor('claude', 'claude')).toBe('claude');
  });

  it('die Einstellung heisst ueberall gleich', () => {
    expect(COAUTHOR_PREF_KEY).toBe('coauthor');
    expect(roh('../handlers/brain.ts')).toContain('COAUTHOR_PREF_KEY');
  });
});

describe('GROW-049 - Abnahme 5: kein erfundener Name', () => {
  it('ohne jede Quelle bleibt das Feld leer', () => {
    const h = ermittleAutor({ git: gitLeer });
    expect(h).toEqual({ autor: '', quelle: 'unbekannt' });
  });

  it('und sagt dem Aufrufer, was ihm dadurch entgeht', () => {
    const t = autorHinweis({ autor: '', quelle: 'unbekannt' });
    expect(t).toBeTruthy();
    expect(t).toContain('git config user.name');
    expect(t).toContain('brain_who_knows');
  });

  it('Namen werden vergleichbar gemacht, sonst sind es zwei Menschen', () => {
    expect(normalisiere('Heinrich Neb')).toBe('heinrich');
    expect(normalisiere('  HEINRICH  ')).toBe('heinrich');
    expect(normalisiere('Jean-Luc')).toBe('jean-luc');
    expect(normalisiere('  ')).toBe('');
  });

  it('Gegenprobe: die Normalisierung darf nicht alles gleichmachen', () => {
    expect(normalisiere('marc')).not.toBe(normalisiere('heinrich'));
  });

  it('ein leerer git-Leser wirft nicht', () => {
    expect(() => ermittleAutor({ git: () => '' })).not.toThrow();
  });
});

describe('GROW-049 - der Handler benutzt es wirklich', () => {
  const code = roh('../handlers/brain.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((z) => !z.trimStart().startsWith('//')).join('\n');

  it('leitet den Autor her, bevor irgendetwas ihn benutzt', () => {
    // Der AUFRUF, nicht der Import oben in der Datei. Der erste Wurf dieses
    // Tests verglich gegen die Import-Zeile (Position 383) und war deshalb
    // rot, obwohl der Code stimmte - ein Waechter, der Importe fuer
    // Verwendungen haelt.
    const her = code.indexOf('const herkunft = ermittleAutor(');
    const graph = code.indexOf('ckgUpsertPersonNode(redis,');
    expect(her, 'die Herleitung muss im Handler stehen').toBeGreaterThan(0);
    expect(graph, 'der Kausalgraph-Aufruf muss im Handler stehen').toBeGreaterThan(0);
    expect(graph, 'der Kausalgraph darf den Autor erst NACH der Herleitung benutzen').toBeGreaterThan(her);
  });

  it('speichert den hergeleiteten Namen in der Lektion selbst', () => {
    expect(code).toContain('author: autorFeld');
  });

  it('der Kausalgraph bekommt nur den Menschen, nicht den Mitautor', () => {
    expect(code).toContain('nurMensch(autorFeld)');
  });
});
