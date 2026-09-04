/**
 * Relative Zeitangaben werden am Datum der TATSACHE verankert (gilt_ab),
 * nicht am Schreibzeitpunkt — sonst wird importierte Historie falsch datiert.
 *
 * Gemessen 03.09.2026 (LoCoMo-Import): "yesterday" in einem Gespraech vom
 * 8. Mai 2023 wurde auf den Vortag des Einlesens datiert.
 *
 * GEGENPROBE: ohne gilt_ab bleibt der Schreibzeitpunkt der Bezug.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Zeitbezug gilt_ab', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  beforeEach(() => { redis = new MockRedis(); });

  it('mit gilt_ab: "yesterday" wird auf den Vortag des Tatsachen-Datums datiert', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'locomo:c0:s1', outcome: 'success',
      what_worked: 'Caroline: I went to a LGBTQ support group yesterday and it was powerful.',
      gilt_ab: '2023-05-08',
    }, getConn, noopApiFetch);
    const l = JSON.parse((await redis.get('cachly:lesson:best:locomo:c0:s1'))!) as { what_worked: string };
    expect(l.what_worked).toContain('yesterday (2023-05-07)');
  });

  it('GEGENPROBE: ohne gilt_ab bleibt der Schreibzeitpunkt der Bezug', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:heute', outcome: 'success',
      what_worked: 'Der Port wurde gestern umgestellt.',
    }, getConn, noopApiFetch);
    const l = JSON.parse((await redis.get('cachly:lesson:best:deploy:heute'))!) as { what_worked: string };
    const gestern = new Date(Date.now() - 86400000);
    const iso = `${gestern.getFullYear()}-${String(gestern.getMonth() + 1).padStart(2, '0')}-${String(gestern.getDate()).padStart(2, '0')}`;
    expect(l.what_worked).toContain(`gestern (${iso})`);
  });
});
