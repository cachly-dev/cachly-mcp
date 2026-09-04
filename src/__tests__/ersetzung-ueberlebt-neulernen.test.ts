/**
 * Ersetzung muss Neu-Lernen ueberleben (aus dem dev.to-Faden mit Suraj,
 * 02.09.2026): "If re-learning the old topic resurrects it as fresh, the
 * edge was decoration."
 *
 * Der gefaehrdete Pfad: learn_from_attempts ueberschreibt
 * cachly:lesson:best:<topic> bei outcome=success komplett — traegt die neue
 * Fassung kein ersetzt_durch, ist die Verdraengung weg und die widerlegte
 * Antwort wird wieder ausgeliefert, als waere nie korrigiert worden.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Ersetzung ueberlebt das Neu-Lernen des alten Themas', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('learn(alt) NACH der Ersetzung: die Markierung bleibt, das Banner bleibt', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:port', outcome: 'success',
      what_worked: 'Der Dienst lauscht auf Port 5433.',
    }, getConn, noopApiFetch);

    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:port-neu', outcome: 'success',
      what_worked: 'Seit dem Umzug lauscht der Dienst auf Port 6543.',
      ersetzt: 'deploy:port',
    }, getConn, noopApiFetch);

    const markiert = JSON.parse((await redis.get('cachly:lesson:best:deploy:port'))!);
    expect(markiert.ersetzt_durch).toBe('deploy:port-neu');

    // Jemand lernt das ALTE Thema neu — ohne von der Ersetzung zu wissen.
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:port', outcome: 'success',
      what_worked: 'Der Dienst lauscht auf Port 5433 (heute nochmal geprueft).',
    }, getConn, noopApiFetch);

    const danach = JSON.parse((await redis.get('cachly:lesson:best:deploy:port'))!);
    expect(danach.ersetzt_durch, 'Neu-Lernen darf die Verdraengung nicht wegreissen').toBe('deploy:port-neu');

    const antwort = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:port',
    }, getConn, noopApiFetch));
    expect(antwort).toContain('deploy:port-neu');
  });

  it('GEGENPROBE: ein NIE ersetztes Thema bekommt durch Neu-Lernen keine Markierung', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:unabhaengig', outcome: 'success',
      what_worked: 'Erste Fassung.',
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:unabhaengig', outcome: 'success',
      what_worked: 'Zweite Fassung.',
    }, getConn, noopApiFetch);

    const gelesen = JSON.parse((await redis.get('cachly:lesson:best:deploy:unabhaengig'))!);
    expect(gelesen.ersetzt_durch).toBeUndefined();
  });
});
