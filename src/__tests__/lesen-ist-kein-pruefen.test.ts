/**
 * Lesen ist kein Prüfen.
 *
 * Bis zum 04.09.2026 setzte jeder Abruf `verified_at` auf jetzt und
 * `confidence` auf 1,0. Ein Feld namens "geprüft" wurde damit von einer
 * Handlung gesetzt, die nichts nachprüft.
 *
 * Gemessen am eigenen Bestand (735 Lektionen): 471 (64,1 %) trugen ein
 * `verified_at` nach dem Schreibdatum — ihre Frische kam vom Lesen. 120 davon
 * wären nach Alter überholt gewesen und standen auf grün. Das Medianalter des
 * Bestands sah 14 statt 21 Tage alt aus.
 *
 * Die Vertrauensampel im Briefing hängt an genau diesem Feld. Sie sagte
 * "kannst du glauben", weil jemand hingeschaut hatte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Lesen ist kein Pruefen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  const stand = async (topic: string) =>
    JSON.parse((await redis.get(`cachly:lesson:best:${topic}`))!) as {
      verified_at?: string; last_recalled_at?: string; recall_count?: number; ts?: string;
    };

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('recall_best_solution ruehrt verified_at nicht an, zaehlt aber den Abruf', async () => {
    await lerne('deploy:pfad', 'Der Deploy laeuft ueber node-3.');
    const vorher = await stand('deploy:pfad');

    await new Promise((r) => setTimeout(r, 20));
    await handleBrainTool('recall_best_solution',
      { instance_id: 'i1', topic: 'deploy:pfad' }, getConn, noopApiFetch);

    const nachher = await stand('deploy:pfad');
    expect(nachher.verified_at).toBe(vorher.verified_at);
    expect(nachher.recall_count).toBe(1);
    expect(nachher.last_recalled_at).toBeDefined();
    expect(nachher.last_recalled_at).not.toBe(vorher.verified_at);
  });

  it('smart_recall ruehrt verified_at ebenfalls nicht an', async () => {
    await lerne('cache:stampede', 'Einzelflug verhindert die Herde beim Ablauf.');
    const vorher = await stand('cache:stampede');

    await new Promise((r) => setTimeout(r, 20));
    await handleBrainTool('smart_recall',
      { instance_id: 'i1', query: 'stampede Herde Ablauf' }, getConn, noopApiFetch);

    const nachher = await stand('cache:stampede');
    expect(nachher.verified_at).toBe(vorher.verified_at);
  });

  it('GEGENPROBE: ein neues Schreiben setzt verified_at sehr wohl', async () => {
    await lerne('port:dienst', 'Der Dienst laeuft auf 3001.');
    const vorher = await stand('port:dienst');

    await new Promise((r) => setTimeout(r, 20));
    await lerne('port:dienst', 'Der Dienst laeuft auf 3201.', {
      grund: 'Port war falsch abgeschrieben',
    });

    const nachher = await stand('port:dienst');
    expect(nachher.verified_at).toBeDefined();
    expect(nachher.verified_at).not.toBe(vorher.verified_at);
  });

  it('GEGENPROBE: ohne verified_at rechnet die Alterung mit dem Schreibdatum', async () => {
    await lerne('alt:eintrag', 'Text.');
    const l = await stand('alt:eintrag');
    // Beide Felder existieren und zeigen auf denselben Zeitpunkt, solange
    // niemand die Lektion nachgeprueft hat. Faellt verified_at weg, greift
    // calculateConfidence auf ts zurueck — nie auf den Abrufzeitpunkt.
    expect(l.ts).toBeDefined();
    expect(l.verified_at).toBe(l.ts);
  });
});

/*
 * Die Texte muessen dasselbe sagen wie der Code.
 *
 * Bis 0.10.269 stand in der Beschreibung von `recall_best_solution` noch
 * "Recalling a lesson resets its confidence clock to 1.0", und `brain_doctor`
 * riet bei veralteten Lektionen: "Re-verify with recall_best_solution". Beides
 * war seit 0.10.165 falsch. Ein Agent, der dem Rat folgt, ruft ab, glaubt die
 * Lektion damit geprueft zu haben, und die Ampel bleibt trotzdem rot.
 */
import { TOOLS } from '../tools.js';
import { handleTeamTool } from '../handlers/team.js';

describe('Texte sagen dasselbe wie der Code', () => {
  it('die Beschreibung von recall_best_solution verspricht keine Frische durch Abruf', () => {
    const d = TOOLS.find((t) => t.name === 'recall_best_solution')!.description;
    expect(d).not.toMatch(/recalling a lesson resets/i);
    expect(d).not.toMatch(/marks as recently verified/i);
    expect(d).toContain('lesson_verified');
  });

  it('brain_doctor nennt bei veralteten Lektionen lesson_verified, nicht den Abruf', async () => {
    const redis = new MockRedis();
    const getConn = async () => redis as unknown as Redis;
    const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:alt', outcome: 'success', what_worked: 'Der Deploy laeuft ueber den Runner auf Port 8080.',
    }, getConn, noopApiFetch);
    const schluessel = 'cachly:lesson:best:deploy:alt';
    const l = JSON.parse((await redis.get(schluessel))!) as Record<string, unknown>;
    const alt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await redis.set(schluessel, JSON.stringify({ ...l, ts: alt, verified_at: alt }));

    const out = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('STALE');
    expect(out).toContain('`lesson_verified`');
    expect(out).not.toMatch(/recall_best_solution`? to reset/);
  });

  it('GEGENPROBE: 7 Tage alt ist "aging", nicht STALE (gleiche Grenzen wie das Abzeichen)', async () => {
    const redis = new MockRedis();
    const getConn = async () => redis as unknown as Redis;
    const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:mittel', outcome: 'success', what_worked: 'Der Deploy laeuft ueber den Runner auf Port 8080.',
    }, getConn, noopApiFetch);
    const schluessel = 'cachly:lesson:best:deploy:mittel';
    const l = JSON.parse((await redis.get(schluessel))!) as Record<string, unknown>;
    const mittel = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await redis.set(schluessel, JSON.stringify({ ...l, ts: mittel, verified_at: mittel }));

    const out = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('aging');
    expect(out).not.toContain('STALE');
  });

  it('GEGENPROBE: ohne veraltete Lektion steht kein Hinweis zum Nachpruefen', async () => {
    const redis = new MockRedis();
    const getConn = async () => redis as unknown as Redis;
    const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:neu', outcome: 'success', what_worked: 'Der Deploy laeuft ueber den Runner auf Port 8080.',
    }, getConn, noopApiFetch);
    const out = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).not.toContain('STALE');
    expect(out).not.toContain('Re-run each check');
  });
});
