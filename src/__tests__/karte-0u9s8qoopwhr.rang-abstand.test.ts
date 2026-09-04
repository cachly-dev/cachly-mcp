/**
 * Karte 0u9s8qoopwhr — Rang-Abstand als Kennzahl: wenn Rang 1 und Rang 5
 * gleich scoren, rankt nichts mehr.
 *
 * Anlass (Mudassir Khan, dev.to 02.09.2026): mit wachsendem Bestand ruecken
 * die Punktzahlen zusammen; nichts wird rot, die Antworten werden schlechter.
 *
 * GEGENPROBE: ohne Abrufe meldet der Doctor "not measured yet", nie eine Zahl.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool } from '../handlers/team.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte 0u9s8qoopwhr — Rang-Abstand', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('GEGENPROBE: ohne Abrufe steht "not measured yet"', async () => {
    const out = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('Rank spread');
    expect(out).toContain('not measured yet');
  });

  it('nach einem Abruf mit mehreren Treffern steht ein Mittelwert im Doctor', async () => {
    for (let i = 1; i <= 6; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: 'i1', topic: `deploy:dienst-${i}`, outcome: 'success',
        what_worked: `Dienst ${i} lauscht auf Port 80${i}0 und braucht das Deploy-Token.`,
      }, getConn, noopApiFetch);
    }
    await handleBrainTool('smart_recall', { instance_id: 'i1', query: 'deploy dienst port token' }, getConn, noopApiFetch);
    await new Promise((r) => setTimeout(r, 30));

    const roh = await redis.lrange('cachly:recall:spread', 0, -1);
    expect(roh.length).toBe(1);
    const eintrag = JSON.parse(roh[0]) as { spread: number; n: number };
    expect(eintrag.n).toBeGreaterThanOrEqual(2);
    expect(eintrag.spread).toBeGreaterThanOrEqual(0);

    const out = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toMatch(/Rank spread:\*\* mean \d\.\d{3} over 1 recall/);
  });
});
