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
