/**
 * Gueltigkeit nach Version (Abhakliste 4.5) — die Bausteine.
 *
 * Geprueft wird in vier Schichten:
 *   1. der Bereichs-Parser (auch kaputte Eingaben: unlesbar heisst null, nie ein Wurf),
 *   2. die Angaben "paket@bereich" und was beim Schreiben davon uebrig bleibt,
 *   3. die Versionen des Projekts (Manifeste, Ablage, Zeitbudget),
 *   4. das Urteil und das Herabstufen (nur Lektionen MIT gilt_fuer, nichts wird entfernt).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  liesBereich, liesVersion, passtVersion, liesAngabe, pruefeGiltFuer, loeseGiltFuerAuf,
  leseProjektVersionen, leereVersionsSpeicher, findeProjektOrdner,
  beurteileGiltFuer, stufeNachVersion, GILT_FUER_MAX,
} from '../gueltigkeit-version.js';

// ── 1. Bereichs-Parser ──────────────────────────────────────────────────────

describe('passtVersion — Bereiche', () => {
  const faelle: Array<[string, string, boolean]> = [
    // Vergleiche, auch mit Teilangaben
    ['14.2.3', '<15', true],
    ['15.0.0', '<15', false],
    ['15.2.0', '<15', false],
    ['15.9.9', '<=15', true],
    ['16.0.0', '<=15', false],
    ['15.9.9', '>15', false],
    ['16.0.0', '>15', true],
    ['1.22.1', '>=1.22', true],
    ['1.21.9', '>=1.22', false],
    ['3.11.4', '>=3.11', true],
    // Mehrere Grenzen gelten zusammen
    ['18.3.1', '>=18 <19', true],
    ['19.0.0', '>=18 <19', false],
    ['17.9.9', '>=18 <19', false],
    ['1.2.3', '>= 1.2.0 < 2', true],
    // "oder"
    ['13.0.0', '<14 || >=16', true],
    ['15.0.0', '<14 || >=16', false],
    ['16.1.0', '<14 || >=16', true],
    // Caret, Tilde, Platzhalter
    ['18.2.0', '^18', true],
    ['19.0.0', '^18', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.9', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.0.0', '*', true],
    // Python-Schreibweisen
    ['0.100.5', '>=0.100,<1', true],
    ['1.0.0', '>=0.100,<1', false],
    ['1.4.9', '~=1.4.2', true],
    ['1.5.0', '~=1.4.2', false],
    ['1.9.0', '~=1.4', true],
    ['2.0.0', '~=1.4', false],
    ['0.109.2', '==0.109.2', true],
    ['0.109.3', '==0.109.2', false],
    // Strich-Bereich und Ausschluss
    ['2.3.4', '1.2.3 - 2.3.4', true],
    ['2.3.5', '1.2.3 - 2.3.4', false],
    ['2.9.0', '1.2 - 2', true],
    ['1.2.0', '!=1.2', false],
    ['1.3.0', '!=1.2', true],
    // Vorabkennungen und Zusaetze zaehlen nicht: 15.0.0-rc.1 verhaelt sich wie 15.0.0
    ['15.0.0-rc.1', '<15', false],
    ['v1.9.1', '<1.10', true],
    ['2.0.0.post1', '>=2', true],
    ['1.2.3rc1', '<1.2.3', false],
  ];
  it.each(faelle)('%s in "%s" -> %s', (version, bereich, erwartet) => {
    expect(passtVersion(version, bereich)).toBe(erwartet);
  });

  const kaputt: unknown[] = [
    '', '   ', 'latest', 'next', '>>15', '<>15', '>=', '^', '1..2', '1.x.y', '1 ||', '|| 1', 'a b c',
    '<15 <', 'x.y.z', 12, null, undefined, {}, ['<15'], '1'.repeat(200),
  ];
  it.each(kaputt.map((k) => [JSON.stringify(k)?.slice(0, 30) ?? String(k), k]))(
    'unlesbarer Bereich %s -> null, kein Wurf', (_n, bereich) => {
      expect(() => passtVersion('15.2.0', bereich)).not.toThrow();
      expect(passtVersion('15.2.0', bereich)).toBeNull();
      expect(liesBereich(bereich)).toBeNull();
    },
  );

  it('unlesbare Version -> null statt Ja oder Nein', () => {
    for (const v of ['', 'latest', 'workspace:*', null, undefined, 'x']) {
      expect(passtVersion(v, '<15')).toBeNull();
    }
    expect(liesVersion('v1.9')).toEqual([1, 9, 0]);
  });
});

// ── 2. Angaben ──────────────────────────────────────────────────────────────

describe('liesAngabe / pruefeGiltFuer', () => {
  it('liest paket@bereich mit und ohne Oekosystem-Praefix', () => {
    expect(liesAngabe('next@<15')).toEqual({ angabe: { text: 'next@<15', oekosystem: null, paket: 'next', bereichText: '<15' } });
    expect(liesAngabe('npm:next@<15')).toMatchObject({ angabe: { oekosystem: 'npm', paket: 'next' } });
    expect(liesAngabe('PyPI:FastAPI@<0.110')).toMatchObject({ angabe: { oekosystem: 'python', paket: 'FastAPI' } });
    expect(liesAngabe('python:fastapi@<0.110')).toMatchObject({ angabe: { oekosystem: 'python' } });
    expect(liesAngabe('go:github.com/gin-gonic/gin@<1.9')).toMatchObject({ angabe: { oekosystem: 'go', paket: 'github.com/gin-gonic/gin' } });
    // Gruppen-Pakete beginnen selbst mit "@"
    expect(liesAngabe('@types/react@^18')).toMatchObject({ angabe: { paket: '@types/react', bereichText: '^18' } });
    expect(liesAngabe('  react@>=18   <19 ')).toMatchObject({ angabe: { text: 'react@>=18 <19', bereichText: '>=18 <19' } });
  });

  it.each(['next', 'next@', '@<15', '@next', 'next@latest', 'ne xt@<15', '', '   ', 5, null, undefined, {}, 'npm:@<1'])(
    'kaputte Angabe %j -> Fehlertext, kein Wurf', (roh) => {
      expect(() => liesAngabe(roh)).not.toThrow();
      expect(liesAngabe(roh)).toHaveProperty('fehler');
    },
  );

  it('pruefeGiltFuer behaelt Lesbares, meldet Unlesbares, entfernt Doppelte', () => {
    const r = pruefeGiltFuer(['next@<15', 'next@<15', 'bogus', 'go@>=1.22', 'react@kaputt']);
    expect(r.angaben).toEqual(['next@<15', 'go@>=1.22']);
    expect(r.fehler).toHaveLength(2);
    expect(r.fehler[0]).toContain('bogus');
    expect(r.fehler[1]).toContain('react@kaputt');
  });

  it('eine einzelne Zeichenkette zaehlt als Liste mit einem Eintrag; nichts ist leer', () => {
    expect(pruefeGiltFuer('next@<15').angaben).toEqual(['next@<15']);
    expect(pruefeGiltFuer(undefined)).toEqual({ angaben: [], fehler: [] });
    expect(pruefeGiltFuer(null)).toEqual({ angaben: [], fehler: [] });
    expect(pruefeGiltFuer([])).toEqual({ angaben: [], fehler: [] });
  });

  it(`mehr als ${GILT_FUER_MAX} Angaben: die ueberzaehligen werden gemeldet, nicht gespeichert`, () => {
    const viele = Array.from({ length: GILT_FUER_MAX + 2 }, (_, i) => `pkg${i}@<${i + 1}`);
    const r = pruefeGiltFuer(viele);
    expect(r.angaben).toHaveLength(GILT_FUER_MAX);
    expect(r.fehler).toHaveLength(2);
  });

  it('Update ohne Feld uebernimmt den alten Bereich; [] loescht; neu ueberschreibt', () => {
    expect(loeseGiltFuerAuf(undefined, ['next@<15'])).toMatchObject({ angaben: ['next@<15'], uebernommen: true });
    expect(loeseGiltFuerAuf([], ['next@<15'])).toMatchObject({ angaben: [], uebernommen: false });
    expect(loeseGiltFuerAuf(['next@>=15'], ['next@<15'])).toMatchObject({ angaben: ['next@>=15'], uebernommen: false });
    expect(loeseGiltFuerAuf(undefined, 'kein array')).toMatchObject({ angaben: [], uebernommen: false });
  });
});

// ── 3. Die Versionen des Projekts ───────────────────────────────────────────

describe('leseProjektVersionen', () => {
  // Die Tests pruefen WAS gelesen wird, nicht wie schnell die Platte ist: eine stehende Uhr
  // laesst das Zeitbudget nie ablaufen (das tut allein der Budget-Test mit seiner eigenen Uhr).
  const stehendeUhr = { jetzt: () => 0 };
  let wurzel: string;
  let ablage: string;
  const neuerOrdner = (name: string): string => {
    const d = join(wurzel, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const schreibe = (d: string, datei: string, inhalt: string | object): void => {
    mkdirSync(join(d, datei, '..'), { recursive: true });
    writeFileSync(join(d, datei), typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
  };

  beforeEach(() => {
    wurzel = mkdtempSync(join(tmpdir(), 'gv-proj-'));
    ablage = mkdtempSync(join(tmpdir(), 'gv-ablage-'));
    leereVersionsSpeicher();
  });
  afterEach(() => {
    rmSync(wurzel, { recursive: true, force: true });
    rmSync(ablage, { recursive: true, force: true });
  });

  it('npm: package.json nennt die untere Grenze, das Lockfile die aufgeloeste Version, node_modules die installierte', () => {
    const d = neuerOrdner('npm');
    schreibe(d, 'package.json', {
      dependencies: { next: '^15.2.0', react: '18.3.1', 'workspace-dings': 'workspace:*' },
      devDependencies: { '@types/react': '~18.2.0' },
      peerDependencies: { vue: '^3.0.0' },
    });
    let l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'next')).toEqual({ version: '15.2.0', quelle: 'package.json', ab: true });
    expect(l.suche('npm', 'react')).toEqual({ version: '18.3.1', quelle: 'package.json' });
    expect(l.suche(null, '@types/react')).toMatchObject({ version: '18.2.0', ab: true });
    expect(l.suche(null, 'workspace-dings')).toBeNull();
    expect(l.suche(null, 'vue')).toBeNull(); // peerDependencies sind keine Installation
    expect(l.suche(null, 'gibt-es-nicht')).toBeNull();

    schreibe(d, 'package-lock.json', {
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/next': { version: '15.2.4' },
        'node_modules/next/node_modules/react': { version: '0.0.1' }, // verschachtelt: ignorieren
        'node_modules/@types/react': { version: '18.2.79' },
      },
    });
    leereVersionsSpeicher();
    l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'next')).toEqual({ version: '15.2.4', quelle: 'package-lock.json' });
    expect(l.suche(null, '@types/react')).toMatchObject({ version: '18.2.79', quelle: 'package-lock.json' });
    expect(l.suche(null, 'react')).toMatchObject({ version: '18.3.1', quelle: 'package.json' });

    schreibe(d, 'node_modules/next/package.json', { name: 'next', version: '15.3.1' });
    l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'next')).toEqual({ version: '15.3.1', quelle: 'node_modules' });
  });

  it('npm: Lockfile Version 1 (dependencies) wird gelesen', () => {
    const d = neuerOrdner('lock1');
    schreibe(d, 'package.json', { dependencies: { express: '^4.0.0' } });
    schreibe(d, 'package-lock.json', { lockfileVersion: 1, dependencies: { express: { version: '4.19.2' } } });
    expect(leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr }).suche(null, 'express'))
      .toEqual({ version: '4.19.2', quelle: 'package-lock.json' });
  });

  it('go: Sprachversion und require-Zeilen (Block und Einzelzeile, mit indirect-Kommentar)', () => {
    const d = neuerOrdner('go');
    schreibe(d, 'go.mod', [
      'module example.com/x', '', 'go 1.22.1', '', 'toolchain go1.22.3', '',
      'require github.com/redis/go-redis/v9 v9.5.1', '',
      'require (', '\tgithub.com/gin-gonic/gin v1.9.1', '\tgolang.org/x/sys v0.20.0 // indirect', ')', '',
      'replace example.com/y => ../y',
    ].join('\n'));
    const l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'go')).toEqual({ version: '1.22.1', quelle: 'go.mod', ab: true });
    expect(l.suche('go', 'github.com/gin-gonic/gin')).toEqual({ version: '1.9.1', quelle: 'go.mod' });
    expect(l.suche(null, 'golang.org/x/sys')).toMatchObject({ version: '0.20.0' });
    expect(l.suche(null, 'github.com/redis/go-redis/v9')).toMatchObject({ version: '9.5.1' });
    expect(l.suche('python', 'go')).toBeNull(); // Praefix begrenzt die Suche
  });

  it('python: requirements.txt (== genau, >= untere Grenze, Kommentare, -r, URLs, Marker)', () => {
    const d = neuerOrdner('req');
    schreibe(d, 'requirements.txt', [
      '# Kommentar', '-r andere.txt', '--index-url https://example.com', '',
      'fastapi==0.109.2', 'Django>=4.2,<5 ; python_version >= "3.9"', 'Pydantic_Core[extra]~=2.14',
      'git+https://github.com/x/y.git#egg=y', 'ohne-version', 'uvicorn @ https://example.com/u.whl',
    ].join('\n'));
    const l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'fastapi')).toEqual({ version: '0.109.2', quelle: 'requirements.txt' });
    expect(l.suche('python', 'django')).toEqual({ version: '4.2', quelle: 'requirements.txt', ab: true });
    expect(l.suche('python', 'Django')).toMatchObject({ version: '4.2' }); // Gross/Klein egal
    expect(l.suche(null, 'pydantic.core')).toMatchObject({ version: '2.14', ab: true }); // PEP-503-Name
    expect(l.suche(null, 'ohne-version')).toBeNull();
    expect(l.suche(null, 'uvicorn')).toBeNull();
  });

  it('python: pyproject.toml (PEP 621 mehrzeilig, requires-python, optional-dependencies, Poetry)', () => {
    const d = neuerOrdner('pyproj');
    schreibe(d, 'pyproject.toml', [
      '[project]', 'name = "x"', 'requires-python = ">=3.11"', 'dependencies = [',
      '  "fastapi>=0.100,<0.110",', "  'httpx==0.27.0',", ']', '',
      '[project.optional-dependencies]', 'dev = ["pytest>=8.0"]', '',
      '[tool.poetry.dependencies]', 'python = "^3.12"', 'sqlalchemy = "2.0.30"',
      'pydantic = { version = "^2.7", extras = ["email"] }', '',
      '[tool.poetry.group.dev.dependencies]', 'ruff = "^0.4.0"', '',
      '[tool.ruff]', 'line-length = 100',
    ].join('\n'));
    const l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'python')).toEqual({ version: '3.11', quelle: 'pyproject.toml', ab: true }); // PEP 621 zuerst
    expect(l.suche(null, 'fastapi')).toMatchObject({ version: '0.100', ab: true });
    expect(l.suche(null, 'httpx')).toEqual({ version: '0.27.0', quelle: 'pyproject.toml' });
    expect(l.suche(null, 'pytest')).toMatchObject({ version: '8.0', ab: true });
    expect(l.suche(null, 'sqlalchemy')).toEqual({ version: '2.0.30', quelle: 'pyproject.toml' });
    expect(l.suche(null, 'pydantic')).toMatchObject({ version: '2.7', ab: true });
    expect(l.suche(null, 'ruff')).toMatchObject({ version: '0.4.0', ab: true });
    expect(l.suche(null, 'line-length')).toBeNull();
  });

  it('kaputte oder fehlende Manifeste: unbekannt, kein Wurf', () => {
    const d = neuerOrdner('kaputt');
    schreibe(d, 'package.json', '{ das ist kein json');
    schreibe(d, 'package-lock.json', '[1,2,');
    schreibe(d, 'go.mod', '\u0000\u0001 garbage ((( )))');
    schreibe(d, 'pyproject.toml', '[[[ nonsense');
    let l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'next')).toBeNull();
    expect(l.unvollstaendig).toBe(false);
    l = leseProjektVersionen(join(wurzel, 'gibt-es-nicht'), { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, 'next')).toBeNull();
    expect(() => leseProjektVersionen('', { ablageOrdner: ablage, ...stehendeUhr }).suche(null, 'x')).not.toThrow();
  });

  it('Pfad-Tricks im Paketnamen lesen nichts ausserhalb von node_modules', () => {
    const d = neuerOrdner('pfad');
    schreibe(d, 'package.json', { dependencies: {} });
    schreibe(wurzel, 'geheim/package.json', { version: '9.9.9' });
    const l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
    expect(l.suche(null, '../../geheim')).toBeNull();
    expect(l.suche(null, 'a/../../../geheim')).toBeNull();
  });

  describe('Ablage und Zeitbudget', () => {
    it('erst gebaut, dann aus dem Speicher, nach Prozesswechsel von der Platte, nach Aenderung wieder gebaut', () => {
      const d = neuerOrdner('cache');
      schreibe(d, 'package.json', { dependencies: { next: '^15.2.0' } });
      expect(leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr }).herkunft).toBe('gebaut');
      expect(leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr }).herkunft).toBe('speicher');
      leereVersionsSpeicher(); // = der naechste Hook-Aufruf ist ein neuer Prozess
      const warm = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
      expect(warm.herkunft).toBe('platte');
      expect(warm.suche(null, 'next')).toMatchObject({ version: '15.2.0' });

      // Aenderung (andere Groesse): die Ablage gilt nicht mehr.
      schreibe(d, 'package.json', { dependencies: { next: '^14.1.0', react: '18.3.1' } });
      leereVersionsSpeicher();
      const neu = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
      expect(neu.herkunft).toBe('gebaut');
      expect(neu.suche(null, 'next')).toMatchObject({ version: '14.1.0' });
    });

    it('ablageOrdner null: nie von der Platte, nichts geschrieben', () => {
      const d = neuerOrdner('ohneplatte');
      schreibe(d, 'package.json', { dependencies: { next: '^15.2.0' } });
      leseProjektVersionen(d, { ablageOrdner: null });
      leereVersionsSpeicher();
      expect(leseProjektVersionen(d, { ablageOrdner: null }).herkunft).toBe('gebaut');
    });

    it('Zeitbudget: ist es aufgebraucht, bleibt der Rest unbekannt — und das ist kein Fehler', () => {
      const d = neuerOrdner('budget');
      schreibe(d, 'package.json', { dependencies: { next: '^15.2.0' } });
      schreibe(d, 'package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/next': { version: '15.2.4' } } });
      let t = 0;
      const l = leseProjektVersionen(d, { ablageOrdner: ablage, budgetMs: 25, jetzt: () => (t += 100) });
      expect(l.unvollstaendig).toBe(true);
      // package.json wurde noch gelesen, das Lockfile nicht mehr
      expect(l.suche(null, 'next')).toEqual({ version: '15.2.0', quelle: 'package.json', ab: true });
      // Mit Budget fuer alles: das Lockfile kommt dazu
      leereVersionsSpeicher();
      rmSync(ablage, { recursive: true, force: true });
      mkdirSync(ablage, { recursive: true });
      const voll = leseProjektVersionen(d, { ablageOrdner: ablage, budgetMs: 25, jetzt: () => 0 });
      expect(voll.unvollstaendig).toBe(false);
      expect(voll.suche(null, 'next')).toMatchObject({ version: '15.2.4' });
    });

    it('zu grosse Manifeste werden uebersprungen statt gelesen', () => {
      const d = neuerOrdner('gross');
      schreibe(d, 'package.json', { dependencies: { next: '^15.2.0' } });
      // Lockfile ueber der Grenze (3 MB): wird nicht geparst
      const polster = 'x'.repeat(3 * 1024 * 1024 + 10);
      schreibe(d, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '15.2.4' } }, polster }));
      expect(leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr }).suche(null, 'next'))
        .toEqual({ version: '15.2.0', quelle: 'package.json', ab: true });
    });

    it('warme Aufrufe sind billig: im Mittel unter 15 ms je Hook-Prozess (gemessen 1-3 ms; die Grenze ist grosszuegig, damit ein belasteter Runner nicht flackert)', () => {
      const d = neuerOrdner('zeit');
      const deps: Record<string, string> = {};
      const pakete: Record<string, { version: string }> = {};
      for (let i = 0; i < 1500; i++) { deps[`paket-${i}`] = `^${i % 20}.1.0`; pakete[`node_modules/paket-${i}`] = { version: `${i % 20}.1.4` }; }
      schreibe(d, 'package.json', { dependencies: deps });
      schreibe(d, 'package-lock.json', { lockfileVersion: 3, packages: pakete });
      leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr }); // kalt: baut und schreibt die Ablage
      const t0 = performance.now();
      const durchgaenge = 100;
      for (let i = 0; i < durchgaenge; i++) {
        leereVersionsSpeicher(); // jeder Durchgang wie ein neuer Hook-Prozess: stat + kleine JSON-Datei
        const l = leseProjektVersionen(d, { ablageOrdner: ablage, ...stehendeUhr });
        expect(l.herkunft).toBe('platte');
        l.suche(null, 'paket-7');
      }
      expect((performance.now() - t0) / durchgaenge).toBeLessThan(15);
    });
  });

  it('findeProjektOrdner: nur innerhalb der Obergrenze nach oben; ohne Grenze bleibt es beim Start', () => {
    const mono = neuerOrdner('mono');
    schreibe(mono, 'package.json', { dependencies: { next: '^15.0.0' } });
    schreibe(mono, 'apps/web/package.json', { dependencies: { next: '^14.0.0' } });
    mkdirSync(join(mono, 'apps/web/src/seiten'), { recursive: true });
    const tief = join(mono, 'apps/web/src/seiten');
    expect(findeProjektOrdner(tief, mono)).toBe(join(mono, 'apps/web'));
    expect(findeProjektOrdner(tief)).toBe(tief);
    expect(leseProjektVersionen(tief, { obergrenze: mono, ablageOrdner: ablage }).suche(null, 'next'))
      .toMatchObject({ version: '14.0.0' });
    // ohne Manifest bis zur Grenze: der Startordner, nichts Fremdes darueber
    const leer = neuerOrdner('leer/a/b');
    expect(findeProjektOrdner(leer, join(wurzel, 'leer'))).toBe(leer);
    expect(existsSync(leer)).toBe(true);
  });
});

// ── 4. Urteil und Herabstufen ───────────────────────────────────────────────

describe('beurteileGiltFuer / stufeNachVersion', () => {
  const leserMit = (stand: Record<string, { version: string; ab?: boolean; quelle?: string }>) => ({
    suche: (_o: unknown, paket: string) => {
      const s = stand[paket];
      return s ? { quelle: 'test', ...s } : null;
    },
  });

  it('passtNicht nennt Angabe UND die Version des Projekts', () => {
    const u = beurteileGiltFuer(['next@<15'], leserMit({ next: { version: '15.2.0' } }));
    expect(u).toMatchObject({ art: 'passtNicht', text: 'gilt fuer next@<15, hier 15.2.0' });
  });

  it('eine nur deklarierte Grenze wird als solche benannt', () => {
    const u = beurteileGiltFuer(['next@<15'], leserMit({ next: { version: '15.2.0', ab: true, quelle: 'package.json' } }));
    expect(u).toMatchObject({ art: 'passtNicht', text: 'gilt fuer next@<15, hier ab 15.2.0 laut package.json' });
  });

  it('mehrere Angaben gelten zusammen; nur die verletzten werden genannt', () => {
    const stand = leserMit({ next: { version: '15.2.0' }, react: { version: '18.3.1' } });
    expect(beurteileGiltFuer(['react@>=18 <19', 'next@<15'], stand))
      .toMatchObject({ art: 'passtNicht', abweichungen: [{ angabe: 'next@<15', hier: '15.2.0' }] });
    expect(beurteileGiltFuer(['react@>=18 <19', 'next@>=15'], stand)).toMatchObject({ art: 'passt' });
  });

  it('unbekannte Version, unlesbare Angabe, kein Eintrag: unbekannt (keine Aenderung)', () => {
    const stand = leserMit({ next: { version: '15.2.0' } });
    expect(beurteileGiltFuer(['react@<19'], stand)).toEqual({ art: 'unbekannt' });
    expect(beurteileGiltFuer(['kaputt', 'next@gibberish'], stand)).toEqual({ art: 'unbekannt' });
    expect(beurteileGiltFuer([], stand)).toEqual({ art: 'unbekannt' });
    expect(beurteileGiltFuer(undefined, stand)).toEqual({ art: 'unbekannt' });
    // eine unbekannte Angabe neben einer passenden: passt (kein Beleg dagegen)
    expect(beurteileGiltFuer(['react@<19', 'next@>=15'], stand)).toMatchObject({ art: 'passt' });
    // unbekannt neben verletzt: verletzt gewinnt
    expect(beurteileGiltFuer(['react@<19', 'next@<15'], stand)).toMatchObject({ art: 'passtNicht' });
  });

  type T = { name: string; gilt_fuer?: unknown };
  const opt = (leser: () => ReturnType<typeof leserMit>) => ({
    giltFuerVon: (t: T) => t.gilt_fuer,
    schluesselVon: (t: T) => t.name,
    leser,
  });

  it('Abweichler wandern hinter alle anderen; Reihenfolge untereinander bleibt, nichts faellt weg', () => {
    const treffer: T[] = [
      { name: 'a-alt', gilt_fuer: ['next@<15'] },
      { name: 'b-ohne' },
      { name: 'c-alt', gilt_fuer: ['next@<14'] },
      { name: 'd-passt', gilt_fuer: ['next@>=15'] },
      { name: 'e-unbekannt', gilt_fuer: ['unbekanntes-paket@<1'] },
    ];
    const r = stufeNachVersion(treffer, opt(() => leserMit({ next: { version: '15.2.0' } })));
    expect(r.treffer.map((t) => t.name)).toEqual(['b-ohne', 'd-passt', 'e-unbekannt', 'a-alt', 'c-alt']);
    expect([...r.hinweise.keys()]).toEqual(['a-alt', 'c-alt']);
    expect(r.hinweise.get('a-alt')).toBe('gilt fuer next@<15, hier 15.2.0');
    expect(r.treffer).toHaveLength(treffer.length);
  });

  it('passt alles: dieselbe Reihenfolge, keine Hinweise', () => {
    const treffer: T[] = [{ name: 'x', gilt_fuer: ['next@>=15'] }, { name: 'y' }];
    const r = stufeNachVersion(treffer, opt(() => leserMit({ next: { version: '15.2.0' } })));
    expect(r.treffer.map((t) => t.name)).toEqual(['x', 'y']);
    expect(r.hinweise.size).toBe(0);
  });

  it('passt NICHTS: Reihenfolge bleibt, die Hinweise sind trotzdem da', () => {
    const treffer: T[] = [{ name: 'x', gilt_fuer: ['next@<15'] }, { name: 'y', gilt_fuer: ['next@<14'] }];
    const r = stufeNachVersion(treffer, opt(() => leserMit({ next: { version: '15.2.0' } })));
    expect(r.treffer.map((t) => t.name)).toEqual(['x', 'y']);
    expect(r.hinweise.size).toBe(2);
  });

  it('KEIN gilt_fuer: der Leser wird nie angefasst (kein Dateizugriff im Hook)', () => {
    let aufrufe = 0;
    const treffer: T[] = [{ name: 'a' }, { name: 'b', gilt_fuer: [] }, { name: 'c', gilt_fuer: '' }, { name: 'd', gilt_fuer: undefined }];
    const r = stufeNachVersion(treffer, opt(() => { aufrufe++; return leserMit({}); }));
    expect(aufrufe).toBe(0);
    expect(r.treffer.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.hinweise.size).toBe(0);
  });

  it('der Leser wird hoechstens EINMAL geholt, auch bei vielen Lektionen mit gilt_fuer', () => {
    let aufrufe = 0;
    const treffer: T[] = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, gilt_fuer: ['next@<15'] }));
    stufeNachVersion(treffer, opt(() => { aufrufe++; return leserMit({ next: { version: '15.0.0' } }); }));
    expect(aufrufe).toBe(1);
  });

  it('wirft der Leser, bleibt alles wie vorher', () => {
    const treffer: T[] = [{ name: 'a', gilt_fuer: ['next@<15'] }, { name: 'b' }];
    const r = stufeNachVersion(treffer, opt(() => { throw new Error('Platte kaputt'); }));
    expect(r.treffer.map((t) => t.name)).toEqual(['a', 'b']);
    expect(r.hinweise.size).toBe(0);
  });
});
