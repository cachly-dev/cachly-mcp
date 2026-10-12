/**
 * Gueltigkeit nach Version (Abhakliste 4.5) — durch den Handler und die Einblendung.
 *
 * Der Fall: "next@<15" steht an einer Lektion, das Projekt hat next 15.2.0.
 * Die Lektion bleibt auffindbar, steht aber hinter den passenden Treffern und
 * traegt den Hinweis "gilt fuer next@<15, hier 15.2.0". Lektionen OHNE
 * gilt_fuer aendern sich nicht — und lesen auch keine Datei.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';
import { selectRelevant, promptKontext, renderLesson, selectRelevantMitLeser } from '../einblendung.js';
import { ablageDatei, leereVersionsSpeicher } from '../gueltigkeit-version.js';

describe('gilt_fuer — Schreiben, Abruf, Einblendung', () => {
  let redis: MockRedis;
  let projekt: string;
  const vorher: Record<string, string | undefined> = {};
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);
  const suche = async (query: string, extra: Record<string, unknown> = {}) =>
    String(await handleBrainTool('smart_recall', { instance_id: 'i1', query, ...extra }, getConn, noopApiFetch));
  const einzeln = async (topic: string) =>
    String(await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic }, getConn, noopApiFetch));
  const gespeichert = async (topic: string) =>
    JSON.parse((await redis.get(`cachly:lesson:best:${topic}`))!) as Record<string, unknown>;
  const schreibePackageJson = (ordner: string, next: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(ordner, { recursive: true });
    writeFileSync(join(ordner, 'package.json'), JSON.stringify({ dependencies: { next, ...extra } }));
  };
  const stelleProjektAuf = (ordner: string) => { process.env.CACHLY_WORKSPACE = ordner; leereVersionsSpeicher(); };
  // Hat jemand die Manifeste dieses Projekts gelesen? Dann liegt seine Ablage auf der Platte.
  const gelesen = () => existsSync(ablageDatei(projekt));

  beforeEach(() => {
    redis = new MockRedis();
    projekt = mkdtempSync(join(tmpdir(), 'gf-proj-'));
    for (const k of ['CACHLY_WORKSPACE', 'CLAUDE_PROJECT_DIR']) { vorher[k] = process.env[k]; delete process.env[k]; }
    leereVersionsSpeicher();
  });
  afterEach(() => {
    for (const k of ['CACHLY_WORKSPACE', 'CLAUDE_PROJECT_DIR']) {
      if (vorher[k] === undefined) delete process.env[k]; else process.env[k] = vorher[k];
    }
    rmSync(projekt, { recursive: true, force: true });
  });

  // Die alte Fassung trifft die Frage besser (mehr Frageworte), die neue ist die richtige fuer next 15.
  const lerneBeide = async () => {
    await lerne('next:router-cache-alt',
      'plugh Router-Cache: besuchte Seiten bleiben bei der Navigation im Cache, der plugh Cache haelt dreissig Sekunden.',
      { gilt_fuer: ['next@<15'] });
    await lerne('next:router-cache-neu',
      'plugh Router-Cache: seit next 15 werden Seiten bei der Navigation nicht mehr gecacht.',
      { gilt_fuer: ['next@>=15'] });
  };
  // Die Treffer tragen das Etikett "💡 <thema>"; die Hinweise darueber nennen das Thema in Backticks.
  const reihenfolge = (antwort: string) => {
    const a = antwort.indexOf('💡 next:router-cache-alt');
    const n = antwort.indexOf('💡 next:router-cache-neu');
    return { a, n, altZuerst: a >= 0 && n >= 0 && a < n };
  };

  // ── Schreiben ─────────────────────────────────────────────────────────────

  it('gilt_fuer wird gespeichert (nur Lesbares) und in der Rueckmeldung genannt', async () => {
    const antwort = String(await lerne('deploy:x', 'plugh Text.', {
      gilt_fuer: ['next@<15', 'unlesbar', 'react@>=18 <19', 'react@>=18 <19', 'go@kaputt'],
    }));
    expect((await gespeichert('deploy:x')).gilt_fuer).toEqual(['next@<15', 'react@>=18 <19']);
    expect(antwort).toContain('next@<15');
    // Unlesbares wird benannt und NICHT gespeichert — die Lektion selbst wird trotzdem gespeichert
    expect(antwort).toContain('gilt_fuer nicht gespeichert');
    expect(antwort).toContain('unlesbar');
    expect(antwort).toContain('go@kaputt');
    expect((await gespeichert('deploy:x')).what_worked).toBe('plugh Text.');
  });

  it('ohne gilt_fuer: kein Feld in der Lektion, keine Zeile in der Rueckmeldung', async () => {
    const antwort = String(await lerne('deploy:y', 'plugh Text.'));
    expect(await gespeichert('deploy:y')).not.toHaveProperty('gilt_fuer');
    expect(antwort).not.toContain('Gilt fuer');
    expect(antwort).not.toContain('gilt_fuer');
  });

  it('nur Unlesbares: die Lektion wird gespeichert, ohne Feld, mit Warnung', async () => {
    const antwort = String(await lerne('deploy:z', 'plugh Text.', { gilt_fuer: ['kaputt'] }));
    expect(await gespeichert('deploy:z')).not.toHaveProperty('gilt_fuer');
    expect(antwort).toContain('gilt_fuer nicht gespeichert');
  });

  it('Update ohne gilt_fuer behaelt den Bereich; [] loescht ihn; ein neuer ersetzt ihn', async () => {
    await lerne('deploy:u', 'plugh erste Fassung.', { gilt_fuer: ['next@<15'] });
    const u1 = String(await lerne('deploy:u', 'plugh zweite Fassung.', { grund: 'Text praezisiert' }));
    expect((await gespeichert('deploy:u')).gilt_fuer).toEqual(['next@<15']);
    expect(u1).toContain('aus der Vorfassung uebernommen');
    await lerne('deploy:u', 'plugh dritte Fassung.', { grund: 'gilt jetzt ab 15', gilt_fuer: ['next@>=15'] });
    expect((await gespeichert('deploy:u')).gilt_fuer).toEqual(['next@>=15']);
    await lerne('deploy:u', 'plugh vierte Fassung.', { grund: 'gilt fuer alle', gilt_fuer: [] });
    expect(await gespeichert('deploy:u')).not.toHaveProperty('gilt_fuer');
  });

  // ── smart_recall ──────────────────────────────────────────────────────────

  it('GEGENPROBE zur Basis: ohne Projektversion steht die besser passende alte Fassung vorn', async () => {
    await lerneBeide();
    stelleProjektAuf(projekt); // Ordner ohne Manifest: Versionen unbekannt
    const antwort = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    expect(reihenfolge(antwort).altZuerst).toBe(true);
    expect(antwort).not.toContain('passt nicht zu den Versionen');
  });

  it('next 15: die alte Fassung steht HINTER der neuen und traegt den Hinweis — bleibt aber im Abruf', async () => {
    await lerneBeide();
    schreibePackageJson(projekt, '^15.2.0');
    stelleProjektAuf(projekt);
    const antwort = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    const r = reihenfolge(antwort);
    expect(r.a, 'die alte Fassung darf nicht verschwinden').toBeGreaterThanOrEqual(0);
    expect(r.n).toBeGreaterThanOrEqual(0);
    expect(r.altZuerst).toBe(false);
    expect(antwort).toContain('`next:router-cache-alt` gilt fuer next@<15, hier ab 15.2.0 laut package.json');
    expect(antwort).toContain('passt nicht zu den Versionen dieses Projekts');
    expect(gelesen(), 'Gegenstueck zum Test ohne gilt_fuer: hier WIRD gelesen').toBe(true);
    // Die passende Fassung bekommt keinen Hinweis
    expect(antwort).not.toContain('`next:router-cache-neu` gilt fuer');
  });

  it('next 14: die alte Fassung bleibt vorn und ohne Hinweis — der Hinweis trifft die FUER 15 geschriebene', async () => {
    await lerneBeide();
    schreibePackageJson(projekt, '^14.2.3');
    stelleProjektAuf(projekt);
    const antwort = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    expect(reihenfolge(antwort).altZuerst).toBe(true);
    expect(antwort).toContain('`next:router-cache-neu` gilt fuer next@>=15, hier ab 14.2.3 laut package.json');
    expect(antwort).not.toContain('`next:router-cache-alt` gilt fuer');
  });

  it('die genaue Version aus node_modules gewinnt gegen die deklarierte Grenze', async () => {
    await lerneBeide();
    schreibePackageJson(projekt, '^15.2.0');
    mkdirSync(join(projekt, 'node_modules', 'next'), { recursive: true });
    writeFileSync(join(projekt, 'node_modules', 'next', 'package.json'), JSON.stringify({ name: 'next', version: '15.3.1' }));
    stelleProjektAuf(projekt);
    const antwort = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    expect(antwort).toContain('gilt fuer next@<15, hier 15.3.1');
  });

  it('Monorepo: die Kontextdatei bestimmt das Paket (apps/web hat next 14, die Wurzel next 15)', async () => {
    await lerneBeide();
    schreibePackageJson(projekt, '^15.2.0');
    schreibePackageJson(join(projekt, 'apps', 'web'), '^14.1.0');
    stelleProjektAuf(projekt);
    const ohneDatei = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    expect(reihenfolge(ohneDatei).altZuerst).toBe(false);
    const mitDatei = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache', {
      context_files: ['apps/web/src/seiten/start.tsx'],
    });
    expect(reihenfolge(mitDatei).altZuerst).toBe(true);
    expect(mitDatei).not.toContain('`next:router-cache-alt` gilt fuer');
    expect(mitDatei).toContain('`next:router-cache-neu` gilt fuer next@>=15, hier ab 14.1.0');
  });

  it('KEIN gilt_fuer im Bestand: die Antwort bleibt unmarkiert und es wird keine Ablage angelegt', async () => {
    await lerne('next:cache-a', 'plugh Router-Cache haelt dreissig Sekunden.');
    await lerne('next:cache-b', 'plugh Router-Cache wird nicht mehr gecacht.');
    schreibePackageJson(projekt, '^15.2.0');
    stelleProjektAuf(projekt);
    expect(gelesen()).toBe(false);
    const antwort = await suche('plugh Router-Cache dreissig Sekunden');
    expect(antwort).toContain('next:cache-a');
    expect(antwort).not.toContain('passt nicht zu den Versionen');
    expect(antwort).not.toContain('gilt fuer');
    // Nichts gelesen, nichts geschrieben: die Ablage haette hier entstehen muessen, wenn gelesen worden waere
    expect(gelesen()).toBe(false);
  });

  it('unbekannte Version (Paket steht nicht im Projekt): keine Aenderung', async () => {
    await lerneBeide();
    schreibePackageJson(projekt, '^15.2.0');
    // Das Projekt kennt "next" nicht — stattdessen nur ein anderes Paket
    writeFileSync(join(projekt, 'package.json'), JSON.stringify({ dependencies: { express: '^4.19.0' } }));
    stelleProjektAuf(projekt);
    const antwort = await suche('plugh Router-Cache Navigation dreissig Sekunden Cache');
    expect(reihenfolge(antwort).altZuerst).toBe(true);
    expect(antwort).not.toContain('passt nicht zu den Versionen');
  });

  // ── recall_best_solution ──────────────────────────────────────────────────

  it('einzeln abgerufen: laute Zeile bei Abweichung, ruhige bei Treffer, Hinweis bei Unbekannt', async () => {
    await lerne('next:cache-alt', 'plugh Cache bleibt.', { gilt_fuer: ['next@<15'] });

    schreibePackageJson(projekt, '^15.2.0');
    stelleProjektAuf(projekt);
    const falsch = await einzeln('next:cache-alt');
    expect(falsch).toContain('GILT NICHT FUER DIESEN STAND');
    expect(falsch).toContain('gilt fuer next@<15, hier ab 15.2.0 laut package.json');
    expect(falsch).toContain('plugh Cache bleibt.'); // bleibt lesbar

    schreibePackageJson(projekt, '^14.2.3');
    stelleProjektAuf(projekt);
    const richtig = await einzeln('next:cache-alt');
    expect(richtig).not.toContain('GILT NICHT FUER DIESEN STAND');
    expect(richtig).toContain('passt zu diesem Projekt');

    stelleProjektAuf(mkdtempSync(join(tmpdir(), 'gf-leer-')));
    const unbekannt = await einzeln('next:cache-alt');
    expect(unbekannt).not.toContain('GILT NICHT FUER DIESEN STAND');
    expect(unbekannt).toContain('nicht bekannt');
  });

  it('einzeln abgerufen ohne gilt_fuer: keine Versionszeile', async () => {
    await lerne('next:cache-plain', 'plugh Cache bleibt.');
    schreibePackageJson(projekt, '^15.2.0');
    stelleProjektAuf(projekt);
    const antwort = await einzeln('next:cache-plain');
    expect(antwort).not.toContain('Gilt fuer');
    expect(antwort).not.toContain('GILT NICHT');
  });

  // ── Einblendung (Hook) ────────────────────────────────────────────────────

  describe('Einblendung', () => {
    const lektionen = [
      {
        topic: 'next:router-cache-alt', outcome: 'success', severity: 'major', recall_count: 0,
        what_worked: 'plugh Router-Cache: besuchte Seiten bleiben bei der Navigation im Cache, der plugh Cache haelt dreissig Sekunden.',
        gilt_fuer: ['next@<15'],
      },
      {
        topic: 'next:router-cache-neu', outcome: 'success', severity: 'major', recall_count: 0,
        what_worked: 'plugh Router-Cache: seit next 15 werden Seiten bei der Navigation nicht mehr gecacht.',
        gilt_fuer: ['next@>=15'],
      },
      // Fuellmaterial, damit die Wortsuche einen Bestand hat
      ...Array.from({ length: 6 }, (_, i) => ({
        topic: `fuell:${i}`, outcome: 'success', severity: 'minor', recall_count: 0,
        what_worked: `Etwas ganz anderes ${i}: Datenbank-Migration mit Prisma und Postgres.`,
      })),
    ];
    const frage = 'plugh Router-Cache Navigation dreissig Sekunden Cache';

    it('ohne Projektversion: alte Fassung vorn, keine Markierung (Basis)', () => {
      process.env.CLAUDE_PROJECT_DIR = projekt; // Ordner ohne Manifest
      leereVersionsSpeicher();
      const a = selectRelevant(frage, lektionen);
      expect(a.lessons.map((l) => l.topic)[0]).toBe('next:router-cache-alt');
      expect(promptKontext(a)).not.toContain('gilt fuer');
    });

    it('next 15 im Projekt: die neue Fassung rueckt vor, die alte steht hinten MIT Hinweis in der Zeile', () => {
      schreibePackageJson(projekt, '^15.2.0');
      process.env.CLAUDE_PROJECT_DIR = projekt;
      leereVersionsSpeicher();
      const a = selectRelevant(frage, lektionen);
      const themen = a.lessons.map((l) => l.topic);
      expect(themen[0]).toBe('next:router-cache-neu');
      expect(themen).toContain('next:router-cache-alt'); // nicht versteckt
      const text = promptKontext(a);
      expect(text).toContain('next:router-cache-alt [gilt fuer next@<15, hier ab 15.2.0 laut package.json]:');
      expect(text).not.toContain('next:router-cache-neu [');
    });

    it('der Hinweis steht nur an der Kopie: der Bestand selbst bleibt unveraendert', () => {
      schreibePackageJson(projekt, '^15.2.0');
      process.env.CLAUDE_PROJECT_DIR = projekt;
      leereVersionsSpeicher();
      selectRelevant(frage, lektionen);
      expect(lektionen[0]).not.toHaveProperty('versionshinweis');
      expect(renderLesson(lektionen[0])).not.toContain('[gilt fuer');
    });

    it('KEIN gilt_fuer unter den Lektionen: dasselbe Ergebnis wie ohne Projekt und keine Ablage', () => {
      const ohne = lektionen.map(({ gilt_fuer: _g, ...rest }) => rest);
      schreibePackageJson(projekt, '^15.2.0');
      process.env.CLAUDE_PROJECT_DIR = projekt;
      leereVersionsSpeicher();
      expect(gelesen()).toBe(false);
      const a = selectRelevant(frage, ohne);
      delete process.env.CLAUDE_PROJECT_DIR;
      const b = selectRelevant(frage, ohne);
      expect(a).toEqual(b);
      expect(promptKontext(a)).not.toContain('gilt fuer');
      expect(gelesen()).toBe(false);
    });

    it('auch der Weg mit Leser (ohne Netz: Rueckfall auf die lokale Ordnung) stuft herab', async () => {
      schreibePackageJson(projekt, '^15.2.0');
      process.env.CLAUDE_PROJECT_DIR = projekt;
      leereVersionsSpeicher();
      const a = await selectRelevantMitLeser(frage, lektionen, { apiUrl: 'http://127.0.0.1:9', jwt: '', instanceId: '' }, { tiefe: 0 });
      expect(a.lessons.map((l) => l.topic)[0]).toBe('next:router-cache-neu');
      expect(promptKontext(a)).toContain('[gilt fuer next@<15, hier ab 15.2.0 laut package.json]');
    });
  });
});
