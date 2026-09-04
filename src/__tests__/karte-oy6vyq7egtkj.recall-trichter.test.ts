/**
 * Karte oy6vyq7egtkj — der Recall-Trichter: WORAN scheiterte der Abruf.
 *
 * Vier vermeidbare Klassen (nicht gesucht / Nominierung / Ranking /
 * Anwendung) plus der dritte Ausgang 'ohne-vorwissen' — er gehoert
 * GEZAEHLT, nicht in "nicht gesucht" versteckt, sonst laeuft das
 * Investment in die Irre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { klassifiziereFehlschlag, suchProtokollSchluessel, trichterSchluessel } from '../recall-trichter.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const JETZT = Date.parse('2026-08-31T12:00:00Z');
const VOR = (min: number) => new Date(JETZT - min * 60_000).toISOString();

const VORHANDEN = [{ topic: 'deploy:cache-npm', what_worked: 'Der plugh-Cache liegt an elf Stellen und wird zentral geleert.' }];

describe('klassifiziereFehlschlag — die reine Zuordnung', () => {
  it('ohne-vorwissen: es gab nichts zu finden', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'Cache kaputt', [], [], JETZT))
      .toBe('ohne-vorwissen');
  });

  it('GEGENPROBE: die EIGENE frische Lektion zaehlt nicht als Vorwissen', () => {
    expect(klassifiziereFehlschlag(
      'deploy:cache-npm', 'Cache kaputt',
      [], [{ topic: 'deploy:cache-npm', what_worked: 'Cache zentral leeren.' }], JETZT,
    )).toBe('ohne-vorwissen');
  });

  it('nicht-gesucht: Lektion existierte, keine passende Suche im Fenster', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'plugh-Cache an elf Stellen kaputt', [
      { ts: VOR(10), frage: 'wie konfiguriere ich xyzzy-monitoring', geliefert: [] },
    ], VORHANDEN, JETZT)).toBe('nicht-gesucht');
  });

  it('GEGENPROBE: eine passende Suche VOR dem Fenster ist kein Suchen', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'plugh-Cache an elf Stellen kaputt', [
      { ts: VOR(25 * 60), frage: 'deploy cache npm leeren', geliefert: [] },
    ], VORHANDEN, JETZT)).toBe('nicht-gesucht');
  });

  it('nominierung: passend gesucht, NICHTS geliefert', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'plugh-Cache an elf Stellen kaputt', [
      { ts: VOR(10), frage: 'deploy cache npm leeren', geliefert: [] },
    ], VORHANDEN, JETZT)).toBe('nominierung');
  });

  it('ranking: geliefert wurde etwas — aber nicht die passende Lektion', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'plugh-Cache an elf Stellen kaputt', [
      { ts: VOR(10), frage: 'deploy cache npm leeren', geliefert: ['monitoring:loki-rotation'] },
    ], VORHANDEN, JETZT)).toBe('ranking');
  });

  it('anwendung: die passende Lektion WAR in der Lieferung', () => {
    expect(klassifiziereFehlschlag('deploy:cache-npm-defekt', 'plugh-Cache an elf Stellen kaputt', [
      { ts: VOR(10), frage: 'deploy cache npm leeren', geliefert: ['deploy:cache-npm'] },
    ], VORHANDEN, JETZT)).toBe('anwendung');
  });
});

describe('im Schreib- und Lesepfad', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => { redis = new MockRedis(); });

  it('smart_recall protokolliert auch das SCHWEIGEN', async () => {
    await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'voellig unbekanntes xyzzy-thema',
    }, getConn, noopApiFetch);
    const zeilen = await redis.lrange(suchProtokollSchluessel('i1'), 0, -1);
    expect(zeilen.length).toBe(1);
    const s = JSON.parse(zeilen[0]);
    expect(s.frage).toContain('xyzzy');
    expect(s.geliefert).toEqual([]);
  });

  it('ein Fehlschlag mit Vorwissen, aber ohne Suche, zaehlt als nicht-gesucht', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm', outcome: 'success',
      what_worked: 'Der plugh-Cache liegt an elf Stellen und wird zentral geleert.',
    }, getConn, noopApiFetch);

    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm-defekt', outcome: 'failure',
      what_worked: 'Nichts hat funktioniert.',
      what_failed: 'Der plugh-Cache war an elf Stellen kaputt und wurde nicht geleert.',
    }, getConn, noopApiFetch);

    const z = await redis.hgetall(trichterSchluessel('i1'));
    expect(z['nicht-gesucht']).toBe('1');
  });

  it('GEGENPROBE: ein ERFOLG wird nicht klassifiziert — der Trichter zaehlt nur Fehlschlaege', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm', outcome: 'success',
      what_worked: 'Der plugh-Cache wird zentral geleert.',
    }, getConn, noopApiFetch);
    const z = await redis.hgetall(trichterSchluessel('i1'));
    expect(Object.keys(z)).toHaveLength(0);
  });

  it('brain_metrics zeigt die Verteilung mit der groessten vermeidbaren Klasse', async () => {
    await redis.hincrby(trichterSchluessel('i1'), 'ranking', 7);
    await redis.hincrby(trichterSchluessel('i1'), 'nicht-gesucht', 2);
    await redis.hincrby(trichterSchluessel('i1'), 'ohne-vorwissen', 90);
    const out = String(await handleBrainTool('brain_metrics', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('Recall-Trichter');
    expect(out).toContain('99');
    // 'ohne-vorwissen' ist die groesste Klasse, aber NICHT vermeidbar —
    // als Investitions-Ziel muss Ranking (7) genannt sein.
    expect(out).toMatch(/groesste vermeidbare Klasse ist \*\*Ranking/);
  });
});
