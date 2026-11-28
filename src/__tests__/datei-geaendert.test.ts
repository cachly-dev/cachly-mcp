/**
 * Eine Lektion meldet, wenn ihre Dateien seit dem Schreiben geaendert wurden.
 *
 * Anlass: Golem, 28.11.2026. Eine Notiz sagt "fuehrende Nullen entfernen",
 * der Code behaelt sie inzwischen. Bis hierher bekam die KI die alte Notiz
 * als normalen Treffer.
 *
 * Die Tests bauen ein echtes Git-Repo mit festen Commit-Daten. Gemessen wird
 * die Ausgabe von recall_best_solution und smart_recall, nicht nur das Modul.
 *
 * GEGENPROBE: Datei unveraendert, Lektion nach der Aenderung geprueft,
 * Schalter aus, kein Repo, Pfad ausserhalb — jeweils KEINE Warnung.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import {
  aenderungenSeitLektionen, aenderungsHinweis, aenderungsHinweise, alsRepoPfad, leereAenderungsAblage, saeuberePfad,
  zerlegeStatus, type GitAufruf,
} from '../datei-geaendert.js';
import { MockRedis } from './redis-mock.js';

const LEKTION_TS = '2026-11-01T10:00:00.000Z';
const VOR = '2026-10-20T10:00:00+00:00';
const NACH = '2026-11-20T10:00:00+00:00';

let repo: string;
let ohneRepo: string;

function git(args: string[], datum?: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(datum ? { GIT_AUTHOR_DATE: datum, GIT_COMMITTER_DATE: datum } : {}) },
  });
}

function commit(datei: string, inhalt: string, betreff: string, datum: string): void {
  writeFileSync(join(repo, datei), inhalt);
  git(['add', '--', datei]);
  git(['commit', '-q', '-m', betreff], datum);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'datei-geaendert-'));
  ohneRepo = mkdtempSync(join(tmpdir(), 'datei-geaendert-ohne-'));
  git(['init', '-q']);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'paket'));
  commit('src/artikelnummer.js', 'export const n = (s) => s.replace(/^0+/, "");\n', 'Artikelnummern ohne fuehrende Nullen', VOR);
  commit('src/ruhig.js', 'export const x = 1;\n', 'ruhige Datei', VOR);
  commit('src/weg.js', 'export const w = 1;\n', 'bald geloescht', VOR);
  commit('paket/teil.js', 'export const t = 1;\n', 'Teil im Unterordner', VOR);
  commit('src/artikelnummer.js', 'export const n = (s) => s.trim();\n', 'Partner unterscheidet 17 und 0017: Nullen bleiben', NACH);
  unlinkSync(join(repo, 'src/weg.js'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'weg.js entfernt'], NACH);
  commit('paket/teil.js', 'export const t = 2;\n', 'Teil geaendert', NACH);
  // Zeitzonen: 11:30 +02:00 ist 09:30 UTC (VOR der Lektion um 10:00 UTC),
  // 11:30 -02:00 ist 13:30 UTC (DANACH). Ein Textvergleich der Uhrzeit wuerde beide gleich werten.
  commit('src/zeitzone.js', 'export const z = 1;\n', 'Zone vorher', '2026-11-01T11:30:00+02:00');
  commit('src/zeitzone.js', 'export const z = 2;\n', 'Zone nachher', '2026-11-01T11:30:00-02:00');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(ohneRepo, { recursive: true, force: true });
});

beforeEach(() => leereAenderungsAblage());

const env = (extra: Record<string, string> = {}) => ({ ...process.env, CACHLY_AENDERUNGS_HINWEIS: '', ...extra });
type L = Parameters<typeof aenderungsHinweis>[0];
const eine = async (l: L, o: Parameters<typeof aenderungsHinweis>[1]) => (await aenderungenSeitLektionen([l], o))[0];

describe('aenderungenSeitLektion: das Modul', () => {
  it('meldet den Commit nach der Lektion mit Betreff', async () => {
    const a = await eine({ ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] }, { ordner: repo, env: env() });
    expect(a?.commits).toBe(1);
    expect(a?.letzter?.betreff).toBe('Partner unterscheidet 17 und 0017: Nullen bleiben');
    expect(a?.letzter?.datum.slice(0, 10)).toBe('2026-11-20');
    const zeile = await aenderungsHinweis({ ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] }, { ordner: repo, env: env() });
    expect(zeile).toContain('FILES OF THIS LESSON CHANGED AFTER IT WAS WRITTEN');
    expect(zeile).toContain('(2026-11-01)');
    expect(zeile).toContain('1 commit since then');
    expect(zeile).toContain('"Partner unterscheidet 17 und 0017: Nullen bleiben"');
    expect(zeile).toContain('the code wins');
  });

  it('GEGENPROBE: unveraenderte Datei gibt keine Warnung', async () => {
    expect(await aenderungsHinweis({ ts: LEKTION_TS, file_paths: ['src/ruhig.js'] }, { ordner: repo, env: env() })).toBe('');
  });

  it('GEGENPROBE: nach der Aenderung geprueft (verified_at) gibt keine Warnung', async () => {
    const l = { ts: LEKTION_TS, verified_at: '2026-11-25T00:00:00.000Z', file_paths: ['src/artikelnummer.js'] };
    expect(await aenderungsHinweis(l, { ordner: repo, env: env() })).toBe('');
  });

  it('GEGENPROBE: Schalter aus gibt keine Warnung', async () => {
    const l = { ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] };
    expect(await aenderungsHinweis(l, { ordner: repo, env: env({ CACHLY_AENDERUNGS_HINWEIS: 'aus' }) })).toBe('');
  });

  it('GEGENPROBE: Ordner ohne Git, Lektion ohne Pfade oder ohne Datum gibt keine Warnung', async () => {
    expect(await aenderungsHinweis({ ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] }, { ordner: ohneRepo, env: env() })).toBe('');
    expect(await aenderungsHinweis({ ts: LEKTION_TS }, { ordner: repo, env: env() })).toBe('');
    expect(await aenderungsHinweis({ file_paths: ['src/artikelnummer.js'] }, { ordner: repo, env: env() })).toBe('');
  });

  it('GEGENPROBE: Pfad ausserhalb des Repos gibt keine Warnung und keinen Fehler', async () => {
    expect(await aenderungsHinweis({ ts: LEKTION_TS, file_paths: [join(ohneRepo, 'x.js')] }, { ordner: repo, env: env() })).toBe('');
  });

  it('Zeitzonen: nur der Commit, der in UTC nach der Lektion liegt, zaehlt', async () => {
    const a = await eine({ ts: LEKTION_TS, file_paths: ['src/zeitzone.js'] }, { ordner: repo, env: env() });
    expect(a?.commits).toBe(1);
    expect(a?.letzter?.betreff).toBe('Zone nachher');
  });

  it('eine seither geloeschte Datei zaehlt als Aenderung', async () => {
    const a = await eine({ ts: LEKTION_TS, file_paths: ['src/weg.js'] }, { ordner: repo, env: env() });
    expect(a?.letzter?.betreff).toBe('weg.js entfernt');
  });

  it('nicht eingecheckte Aenderungen werden genannt', async () => {
    writeFileSync(join(repo, 'src/ruhig.js'), 'export const x = 2;\n');
    try {
      const zeile = await aenderungsHinweis({ ts: LEKTION_TS, file_paths: ['src/ruhig.js'] }, { ordner: repo, env: env() });
      expect(zeile).toContain('uncommitted changes in `src/ruhig.js`');
      expect(zeile).not.toContain('commit since then');
    } finally {
      git(['checkout', '--', 'src/ruhig.js']);
    }
  });

  it('Pfade relativ zum Unterordner und zur Wurzel, mit Zeilenangabe und Backslash', async () => {
    const unter = join(repo, 'paket');
    for (const p of ['teil.js', 'paket/teil.js', 'paket\\teil.js:12', 'paket/teil.js#L3', join(repo, 'paket', 'teil.js')]) {
      leereAenderungsAblage();
      const a = await eine({ ts: LEKTION_TS, file_paths: [p] }, { ordner: unter, env: env() });
      expect(a?.letzter?.betreff, p).toBe('Teil geaendert');
    }
  });

  it('acht Lektionen kosten zwei Git-Aufrufe, nicht sechzehn', async () => {
    const aufrufe: string[] = [];
    const zaehlendesGit: GitAufruf = (ordner, args) => new Promise((ok, fehler) => {
      aufrufe.push(args[0]);
      execFile('git', [...args], { cwd: ordner, encoding: 'utf-8' }, (e, out) => (e ? fehler(e) : ok(String(out))));
    });
    const lektionen = [
      ...Array.from({ length: 4 }, () => ({ ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] })),
      ...Array.from({ length: 4 }, () => ({ ts: LEKTION_TS, file_paths: ['src/ruhig.js'] })),
    ];
    const zeilen = await aenderungsHinweise(lektionen, { ordner: repo, env: env(), git: zaehlendesGit });
    expect(zeilen.filter(Boolean).length).toBe(4);
    expect(zeilen.slice(4).every((z) => z === '')).toBe(true);
    expect(aufrufe.filter((a) => a === 'log').length).toBe(1);
    expect(aufrufe.filter((a) => a === 'status').length).toBe(1);
  });

  it('jede Lektion zaehlt ab ihrem eigenen Datum, auch im gemeinsamen Durchlauf', async () => {
    const [alt, neu] = await aenderungenSeitLektionen([
      { ts: LEKTION_TS, file_paths: ['src/artikelnummer.js'] },
      { ts: '2026-11-21T00:00:00.000Z', file_paths: ['src/artikelnummer.js'] },
    ], { ordner: repo, env: env() });
    expect(alt?.commits).toBe(1);
    expect(neu).toBeNull();
  });

  it('git status: Umbenennung nennt den neuen Pfad', () => {
    expect(zerlegeStatus([' M src/a.js', 'R  src/alt.js -> src/neu.js', '?? x.js', ''].join('\n')))
      .toEqual(['src/a.js', 'src/neu.js', 'x.js']);
  });

  it('saeuberePfad nimmt Zeilenangaben ab', async () => {
    expect(saeuberePfad('sdk/mcp/src/handlers/brain.ts ~5527')).toBe('sdk/mcp/src/handlers/brain.ts');
    expect(saeuberePfad('a\\b.ts:42')).toBe('a/b.ts');
    expect(saeuberePfad('a/b.ts#L10-L20')).toBe('a/b.ts');
    expect(alsRepoPfad('../aussen.js', '/r/x', '/r/x')).toBeNull();
  });
});

describe('Abruf zeigt die Warnung vor dem Inhalt', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const vorher = process.env.CACHLY_WORKSPACE;
  const lektion = (topic: string, datei: string) => JSON.stringify({
    topic, outcome: 'success', ts: LEKTION_TS, severity: 'major',
    what_worked: 'ARTIKELNUMMERN VOR DEM VERGLEICH VON FUEHRENDEN NULLEN BEFREIEN (0017 -> 17).',
    file_paths: [datei],
  });

  beforeEach(() => {
    redis = new MockRedis();
    process.env.CACHLY_WORKSPACE = repo;
    process.env.CACHLY_AENDERUNGS_HINWEIS = '';
  });
  afterAll(() => {
    if (vorher === undefined) delete process.env.CACHLY_WORKSPACE; else process.env.CACHLY_WORKSPACE = vorher;
    delete process.env.CACHLY_AENDERUNGS_HINWEIS;
  });

  it('recall_best_solution: Warnung steht vor "What worked"', async () => {
    await redis.set('cachly:lesson:best:artikel:nullen', lektion('artikel:nullen', 'src/artikelnummer.js'));
    const out = String(await handleBrainTool('recall_best_solution', { instance_id: 'x', topic: 'artikel:nullen' }, getConn, noopApiFetch));
    const warnung = out.indexOf('FILES OF THIS LESSON CHANGED AFTER IT WAS WRITTEN');
    expect(warnung).toBeGreaterThan(-1);
    expect(warnung).toBeLessThan(out.indexOf('**What worked:**'));
    expect(out).toContain('Partner unterscheidet 17 und 0017');
  });

  it('GEGENPROBE recall_best_solution: ruhige Datei ohne Warnung', async () => {
    await redis.set('cachly:lesson:best:artikel:ruhig', lektion('artikel:ruhig', 'src/ruhig.js'));
    const out = String(await handleBrainTool('recall_best_solution', { instance_id: 'x', topic: 'artikel:ruhig' }, getConn, noopApiFetch));
    expect(out).toContain('**What worked:**');
    expect(out).not.toContain('FILES OF THIS LESSON CHANGED');
  });

  it('smart_recall: Warnung am Treffer, ruhige Lektion ohne', async () => {
    await redis.set('cachly:lesson:best:artikel:nullen', lektion('artikel:nullen', 'src/artikelnummer.js'));
    await redis.set('cachly:lesson:best:artikel:ruhig', JSON.stringify({
      topic: 'artikel:ruhig', outcome: 'success', ts: LEKTION_TS,
      what_worked: 'RUHIGE DATEI BLEIBT WIE SIE IST.', file_paths: ['src/ruhig.js'],
    }));
    const out = String(await handleBrainTool('smart_recall', { instance_id: 'x', query: 'artikelnummern fuehrende nullen vergleich' }, getConn, noopApiFetch));
    expect(out).toContain('artikel:nullen');
    expect(out.match(/FILES OF THIS LESSON CHANGED AFTER IT WAS WRITTEN/g)?.length).toBe(1);
  });
});
